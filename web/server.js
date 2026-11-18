// Opentodo Web 服务端。
//
// 数据层**原样复用** mcp/lib/store.js —— 同一份 JSON 契约、同一把 mkdir 文件锁、
// 同一条原子 rename,所以 Web 版和桌面 App / opencode 插件 / MCP 读写的是完全一样的
// 东西,天然共存。ops 表在 ops.js(HTTP 与聊天的工具循环共用)。
//
// 访客隔离(B 方案):
//   - 每个访客一个随机 cid(写 cookie `zx_todo_cid`),数据落在 data/visitors/<cid>.json;
//     彼此、以及和站长的数据**完全隔离**。
//   - 站长:访问 `/?owner=<token>`(token 存 data/owner.token,启动时会打印)拿一个 owner cookie;
//     之后读写的是 OPENTODO_FILE(那份额可指向桌面 App 的 todos.json,天然同步)。
//   - 聊天配置 / 密钥、以及 LLM 对话**仅站长可用**(访客 403;访客仍可用本地快速模式与手动 UI)。
//
// 接口:
//   GET  /api/state              → { data, owner }（?since=<revision> 可 304）
//   POST /api/op   { op, ... }   → { data }
//   POST /api/sync { deviceId, state } → 合并后的权威状态（Mac / iOS）
//   POST /api/devices/pair       → 设备令牌（Bearer）
//   GET  /api/chat/state         → { config(掩码), providers, owner }
//   POST /api/chat/config|key|models → 仅站长
//   POST /api/chat               → SSE 流式对话(仅站长)

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { read, update, normalizeItem } from '../mcp/lib/store.js'
import { mergeData, mergeChanged } from '../mcp/lib/merge.js'
import { ops, runOp } from './ops.js'
import { renderTodayPage } from './today.js'
import { chatState, listModels, saveSettings, setApiKey } from './settings.js'
import { runChat } from './chat.js'
import { readChat, writeChat } from './chatstore.js'
import { pairDevice, findDevice, listDevices, revokeDevice, safeEqual } from './devices.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8787)
const DIST = path.join(HERE, 'dist')
// 运行期数据目录(访客 / 站长 / 对话 / 配置)。容器里用 OPENTODO_DATA_DIR 指到挂载卷(如 /data),
// 否则默认 ./data —— 注意默认目录在容器可写层,重建即丢,生产务必指到卷上。
const DATA_DIR = process.env.OPENTODO_DATA_DIR || path.join(HERE, 'data')
const VISITORS_DIR = path.join(DATA_DIR, 'visitors')
const OWNER_TOKEN_FILE = path.join(DATA_DIR, 'owner.token')

// 站长那份额:默认 web/data/todos.json;设 OPENTODO_FILE 指向桌面 App 那份即可两边同源。
const OWNER_FILE = process.env.OPENTODO_FILE || path.join(DATA_DIR, 'todos.json')
// 兜底:即便某处漏传 file,store.js 的 resolveFile() 也只会命中站长那份,**绝不会**误写到
// 桌面 App 的数据文件以外的第三方路径。
process.env.OPENTODO_FILE = OWNER_FILE
// 访客是否也能用 AI(走站长配的 provider/model/密钥)。默认**允许**;`OPENTODO_VISITOR_AI=0` 关闭。
const VISITOR_AI = process.env.OPENTODO_VISITOR_AI !== '0'
// 同一设备 + 同一份完整 state 的去重窗口。0 = 关闭(退回旧行为)。
// 客户端若每 200ms 全量推一次,服务端只做第一次合并,其余直接复用上次响应:
// 不读文件、不拿锁、不写盘、不做 merge。
const SYNC_DEDUPE_MS = Math.max(0, Number(process.env.OPENTODO_SYNC_DEDUPE_MS ?? 5000) || 0)
const SYNC_CACHE_MAX = 128
const SYNC_CACHE_BYTES_MAX = 32 * 1024 * 1024
// 单设备持续 >2 rps 只记 warn(30s 窗口),**不返回 429、不吊销 token**:
// 固定间隔的笨客户端收到 429 往往会更激进地重试,反而放大风暴。
const SYNC_RPS_WARN = Math.max(0, Number(process.env.OPENTODO_SYNC_RPS_WARN ?? 2) || 0)
const SYNC_RPS_WINDOW_MS = Math.max(1000, Number(process.env.OPENTODO_SYNC_RPS_WINDOW_MS ?? 30000) || 30000)

function ownerToken() {
  if (process.env.OPENTODO_OWNER_TOKEN) return process.env.OPENTODO_OWNER_TOKEN
  try {
    const t = fs.readFileSync(OWNER_TOKEN_FILE, 'utf8').trim()
    if (t) return t
  } catch {
    /* 还没有,生成 */
  }
  const t = crypto.randomBytes(16).toString('hex')
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(OWNER_TOKEN_FILE, t + '\n', { mode: 0o600 })
  return t
}

function parseCookies(req) {
  const out = {}
  const h = req.headers.cookie
  if (!h) return out
  for (const part of h.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

/** 博客的会话 cookie —— 与 zxLumen-Blog/src/lib/auth.ts 一致 */
const BLOG_ADMIN_COOKIE = 'zx_admin'
/** 站长「以访客身份查看」用的 cookie(值是某访客的 cid);仅站长可设 */
const VIEW_COOKIE = 'zx_todo_view'

/** 访客首次进来时自带一个「使用提示」项目(几条说明当待办条目) */
const WELCOME_LIST = '使用提示'
const WELCOME_TIPS = [
  '点底部输入框回车,就能快速加一条待办',
  '按住条目可拖动排序;拖到左侧项目名上可移动过去',
  '点条目行尾的文件夹图标,给它一个分组',
  '底部可以直接和 AI 说话,比如「加一条 下周一交周报」',
  '左侧「项目」是互相独立的清单,可新建 / 改名 / 删除',
]

/** 访客数据文件不存在时,写入「使用提示」项目 + 若干条目 */
function ensureVisitorSeed(file) {
  if (fs.existsSync(file)) return
  try {
    const now = new Date().toISOString()
    update((d) => {
      d.lists = [WELCOME_LIST]
      WELCOME_TIPS.forEach((content, i) => {
        d.items.push(
          normalizeItem({ content, list: WELCOME_LIST, order: i + 1, createdAt: now, updatedAt: now }),
        )
      })
    }, file)
  } catch {
    /* 建种子失败不影响主流程 */
  }
}

/** 列出所有访客数据文件(供站长查看) */
function listVisitors() {
  let names = []
  try {
    names = fs.readdirSync(VISITORS_DIR).filter((f) => /^[a-f0-9]{16}\.json$/.test(f))
  } catch {
    return []
  }
  const out = []
  for (const f of names) {
    const cid = f.slice(0, 16)
    try {
      const fp = path.join(VISITORS_DIR, f)
      const d = JSON.parse(fs.readFileSync(fp, 'utf8'))
      const items = Array.isArray(d.items) ? d.items : []
      const active = items.filter(
        (it) => !it.archivedAt && (it.status === 'pending' || it.status === 'in_progress'),
      )
      out.push({
        cid,
        count: items.length,
        active: active.length,
        updatedAt: d.updatedAt || new Date(fs.statSync(fp).mtimeMs).toISOString(),
        sample: (active[0] || items[0])?.content ?? '',
      })
    } catch {
      /* 坏文件跳过 */
    }
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return out
}

/**
 * 校验博客的 `zx_admin` 会话:`<exp>.<hmac_sha256(exp, SESSION_SECRET)>`(hex),
 * 与博客 `auth.ts` 同一套算法。登录博客即视为本应用的站长;登出即失效。
 * 未配 SESSION_SECRET(或没带 cookie)则不算。
 */
function validBlogAdmin(req) {
  const secret = process.env.SESSION_SECRET
  if (!secret) return false
  const v = parseCookies(req)[BLOG_ADMIN_COOKIE]
  if (!v) return false
  const i = v.indexOf('.')
  if (i < 1) return false
  const exp = Number(v.slice(0, i))
  const sig = v.slice(i + 1)
  if (!Number.isFinite(exp) || exp < Date.now() || !sig) return false
  const expected = crypto.createHmac('sha256', secret).update(String(exp)).digest('hex')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** 按 cookie 判定「站长 / 访客」,并给出该请求对应的数据文件 */
function resolveScope(req) {
  const c = parseCookies(req)
  const setCookies = []
  const token = ownerToken()
  // 设备令牌(配对后 Mac / iOS 用 Bearer,不再携带站长口令)
  let device = null
  const auth = String(req.headers.authorization || '')
  if (auth.startsWith('Bearer ')) {
    device = findDevice(DATA_DIR, auth.slice(7).trim())
  }
  // 站长:① 设备令牌 ② 博客登录态(SSO,推荐) ③ 直接访问用的 owner token(兜底)
  const owner = !!device || (!!token && c.zx_todo_owner === token) || validBlogAdmin(req)
  let cid = c.zx_todo_cid
  if (!/^[a-f0-9]{16}$/.test(cid || '')) {
    cid = crypto.randomBytes(8).toString('hex')
    setCookies.push(`zx_todo_cid=${cid}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`)
  }
  // 站长可「切到某个访客」查看/管理其数据:owner + zx_todo_view=<访客 cid>
  const view = c[VIEW_COOKIE]
  const viewing = owner && /^[a-f0-9]{16}$/.test(view || '') ? view : null
  const file =
    owner && !viewing ? OWNER_FILE : path.join(VISITORS_DIR, `${viewing || cid}.json`)
  // 访客首次访问:给一份「使用提示」种子
  if (!owner && !viewing) ensureVisitorSeed(file)
  return { owner, device, cid, viewing, file, setCookies }
}

/** 该请求对应的「数据域」键(对话文件按此命名):站长 `owner`;访客各自的 cid;站长查看时用被查看者的 cid */
function scopeKey(scope) {
  return scope.viewing || (scope.owner ? 'owner' : scope.cid)
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

async function readRawBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}

async function readBody(req) {
  const text = (await readRawBody(req)).toString('utf8')
  if (!text.trim()) return {}
  return JSON.parse(text)
}

/** 数据文件指纹:缓存命中前用它确认文件没被别的端点改过。 */
function fileStamp(file) {
  try {
    const st = fs.statSync(file)
    return { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, ino: st.ino }
  } catch {
    return null
  }
}

function sameStamp(a, b) {
  return !!a && !!b && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size && a.ino === b.ino
}

/** 响应 ETag:revision + 文件指纹。revision 变了或文件重写都会变。 */
function stateEtag(data, st) {
  const rev = Number(data?.revision) || 0
  return `"${rev.toString(16)}-${Math.round(st?.mtimeMs || 0).toString(16)}-${(st?.size || 0).toString(16)}-${(st?.ino || 0).toString(16)}"`
}

/** /api/sync 去重缓存:key = deviceId + 请求体 sha256。 */
const syncCache = new Map()
const syncInflight = new Map()
const syncDevices = new Map()
const syncStats = { total: 0, dedup: 0, merged: 0, writes: 0, rpsWarn: 0, lastSyncAt: null }
let syncCacheBytes = 0

/**
 * 记录单设备请求速率;持续超过阈值只 warn,不限流。
 * 用最近 SYNC_RPS_WINDOW_MS 的请求时间戳算真实 rps;窗口填满 90% 才判定,
 * 避免刚启动的 2~3 个请求被误报。
 */
function noteSyncRate(deviceId, now) {
  if (SYNC_RPS_WARN <= 0) return
  let d = syncDevices.get(deviceId)
  if (!d) {
    d = { hits: [], warnedAt: 0, since: now }
    syncDevices.set(deviceId, d)
  }
  d.hits.push(now)
  const cutoff = now - SYNC_RPS_WINDOW_MS
  let drop = 0
  while (drop < d.hits.length && d.hits[drop] < cutoff) drop += 1
  if (drop) d.hits.splice(0, drop)
  if (d.hits.length > 10000) d.hits.splice(0, d.hits.length - 10000)
  const elapsed = Math.min(SYNC_RPS_WINDOW_MS, now - d.since)
  if (elapsed < SYNC_RPS_WINDOW_MS * 0.9) return
  const rps = d.hits.length / (elapsed / 1000)
  if (rps <= SYNC_RPS_WARN) return
  if (now - d.warnedAt < SYNC_RPS_WINDOW_MS) return
  d.warnedAt = now
  syncStats.rpsWarn += 1
  console.warn(
    `[sync_rps_warn] device=${deviceId} rps=${rps.toFixed(2)} requests=${d.hits.length} window=${Math.round(elapsed / 1000)}s action=log_only`,
  )
}

function cacheDelete(key) {
  const v = syncCache.get(key)
  if (!v) return
  syncCacheBytes -= v.bytes
  syncCache.delete(key)
}

function cacheSet(key, hit) {
  const prev = syncCache.get(key)
  if (prev) syncCacheBytes -= prev.bytes
  hit.bytes = Buffer.byteLength(hit.body)
  syncCache.set(key, hit)
  syncCacheBytes += hit.bytes
}

function pruneSyncCache(now) {
  for (const [k, v] of syncCache) {
    if (now - v.at > Math.max(SYNC_DEDUPE_MS * 10, 60_000)) cacheDelete(k)
  }
  for (const [id, d] of syncDevices) {
    if (now - (d.hits[d.hits.length - 1] || 0) > SYNC_RPS_WINDOW_MS * 4) syncDevices.delete(id)
  }
  while (syncCache.size > SYNC_CACHE_MAX || syncCacheBytes > SYNC_CACHE_BYTES_MAX) {
    const oldest = syncCache.keys().next().value
    if (oldest === undefined) break
    cacheDelete(oldest)
  }
}

function syncPayload(res, hit, extra = {}) {
  const dedup = !!extra.dedup
  const body = dedup && hit.dedupBody ? hit.dedupBody : hit.body
  const changed = dedup ? false : hit.changed
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ETag: hit.etag,
    'X-Opentodo-Revision': String(hit.revision),
    'X-Opentodo-Changed': changed ? '1' : '0',
    'X-Opentodo-Dedup': dedup ? '1' : '0',
    'X-Opentodo-Writes': changed ? '1' : '0',
  })
  return res.end(body)
}

/** 追加一条 Set-Cookie(不覆盖已设的) */
function addCookie(res, cookie) {
  const cur = res.getHeader('Set-Cookie')
  const arr = Array.isArray(cur) ? cur : cur ? [cur] : []
  arr.push(cookie)
  res.setHeader('Set-Cookie', arr)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

/** 可压缩的文本类型(其余如图片/字体不压) */
const COMPRESSIBLE = /^(text\/|application\/(json|javascript)|image\/svg)/

/** 带 hash 的构建产物可长期强缓存;HTML 必须回源校验(否则拿到旧壳引旧资源) */
const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable'
const CACHE_HTML = 'no-cache'

/** 按 Accept-Encoding 选一种压缩(优先 brotli);不支持则 null */
function pickEncoding(req) {
  const ae = String(req.headers['accept-encoding'] ?? '')
  if (/\bbr\b/.test(ae)) return 'br'
  if (/\bgzip\b/.test(ae)) return 'gzip'
  return null
}

const brParams = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }
function compress(buf, enc) {
  return enc === 'br' ? zlib.brotliCompressSync(buf, brParams) : zlib.gzipSync(buf, { level: 6 })
}

/** 带 Content-Encoding 的响应。`cacheKey`(内容随文件 mtime+size 固定时才给)为空则不缓存 */
const compressCache = new Map() // `${cacheKey}:${enc}` -> Buffer
function sendBuffer(res, status, type, buf, enc, cacheKey) {
  const headers = { 'Content-Type': type }
  let body = buf
  if (enc && COMPRESSIBLE.test(type)) {
    if (cacheKey) {
      const key = `${cacheKey}:${enc}`
      let compressed = compressCache.get(key)
      if (!compressed) {
        if (compressCache.size > 500) compressCache.clear()
        compressed = compress(buf, enc)
        compressCache.set(key, compressed)
      }
      body = compressed
    } else {
      body = compress(buf, enc)
    }
    headers['Content-Encoding'] = enc
  }
  headers['Content-Length'] = body.length
  res.writeHead(status, headers)
  res.end(body)
}

let indexCache = null // { mtimeMs, size, raw }
function readIndexTemplate() {
  const p = path.join(DIST, 'index.html')
  const st = fs.statSync(p)
  if (!indexCache || indexCache.mtimeMs !== st.mtimeMs || indexCache.size !== st.size) {
    indexCache = { mtimeMs: st.mtimeMs, size: st.size, raw: fs.readFileSync(p, 'utf8') }
  }
  return indexCache.raw
}

/** 首屏 bootstrap:把首帧要用的数据内联进 HTML,省掉「JS 下载 → 再发 API」一个往返 */
function bootFor(scope) {
  const boot = { state: null, owner: !!scope.owner, viewing: scope.viewing ?? null, chat: null, history: { messages: [] } }
  try {
    boot.state = read(scope.file)
  } catch {
    /* ignore */
  }
  try {
    boot.chat = chatState(scope.owner, VISITOR_AI)
  } catch {
    /* ignore */
  }
  try {
    boot.history = readChat(DATA_DIR, scopeKey(scope))
  } catch {
    /* ignore */
  }
  return boot
}

function injectBoot(html, boot) {
  // 注意转义 `<`,避免数据里出现 </script> 截断脚本
  const json = JSON.stringify(boot).replace(/</g, '\\u003c')
  const tag = `<script>window.__BOOT__=${json}</script>`
  return html.includes('<head>') ? html.replace('<head>', `<head>${tag}`) : tag + html
}

/** 根路径 / SPA 回落:注入 boot,内容随数据变,用 ETag 走 304 */
function serveIndex(req, res, enc, scope) {
  const html = injectBoot(readIndexTemplate(), bootFor(scope))
  const etag = `"${crypto.createHash('sha1').update(html).digest('hex').slice(0, 20)}"`
  res.setHeader('Cache-Control', CACHE_HTML)
  res.setHeader('ETag', etag)
  res.setHeader('Vary', 'Accept-Encoding')
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304)
    return res.end()
  }
  // 内容随数据变,不缓存压缩结果(HTML 很小,每次现压可忽略)
  sendBuffer(res, 200, MIME['.html'], Buffer.from(html), enc, '')
}

/**
 * 生产:把 vite 的 dist/ 当静态站点发。
 *   - `/assets/*`(带 hash)→ 强缓存 immutable;其余文件 no-cache。
 *   - 缺失的静态资源(带扩展名或 /assets/*)→ 真 404,绝不回落成 HTML(否则 MIME 错、白等)。
 *   - 无扩展名的未知路径 → 回落 index.html(SPA),并内联 __BOOT__。
 */
function serveStatic(req, res, pathname, scope) {
  if (!fs.existsSync(DIST)) {
    return send(res, 404, 'client 还没构建:先跑 `npm run build`(开发时用 `npm run dev`)')
  }

  const relRaw = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  let rel = relRaw
  try {
    rel = decodeURIComponent(relRaw)
  } catch {
    /* 保持原样 */
  }

  const abs = path.resolve(DIST, rel)
  const within = abs === DIST || abs.startsWith(DIST + path.sep)
  const isFile = within && fs.existsSync(abs) && fs.statSync(abs).isFile()
  const isHashedAsset = rel.startsWith('assets/')
  const hasExt = path.extname(rel) !== ''
  const enc = pickEncoding(req)

  // 只有「非 index.html 的真实文件」才走文件分支(带 hash 的产物强缓存)。
  // 根 / 与 SPA 回落、以及任何 index.html 都走注入分支。
  if (isFile && path.basename(abs) !== 'index.html') {
    const st = fs.statSync(abs)
    const etag = `"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`
    res.setHeader('Cache-Control', isHashedAsset ? CACHE_IMMUTABLE : CACHE_HTML)
    res.setHeader('ETag', etag)
    res.setHeader('Vary', 'Accept-Encoding')
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304)
      return res.end()
    }
    const type = MIME[path.extname(abs)] || 'application/octet-stream'
    sendBuffer(res, 200, type, fs.readFileSync(abs), enc, `${abs}:${st.mtimeMs}:${st.size}`)
    return
  }

  // 缺失的静态资源(带扩展名或 /assets/*)→ 真 404,绝不回落成 HTML
  if (!isFile && (isHashedAsset || hasExt)) return send(res, 404, 'not found')
  return serveIndex(req, res, enc, scope)
}

/** SSE 流式对话(仅站长) */
async function handleChat(req, res, scope) {
  const body = await readBody(req)
  const messages = Array.isArray(body.messages)
    ? body.messages
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-20)
    : []
  const currentList = typeof body.list === 'string' && body.list ? body.list : '收件箱'

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const sendEvent = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`)
    } catch {
      /* 客户端断了 */
    }
  }

  const ac = new AbortController()
  req.on('close', () => ac.abort())

  try {
    const { text, ops: applied } = await runChat({
      messages,
      currentList,
      file: scope.file,
      onEvent: (e) => sendEvent(e),
      signal: ac.signal,
    })
    sendEvent({ done: true, text, ops: applied })
  } catch (err) {
    if (!ac.signal.aborted) {
      sendEvent({ error: err instanceof Error ? err.message : String(err) })
    }
  } finally {
    res.end()
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const { pathname } = url

  try {
    // `/?owner=<token>`:认领站长身份(种 owner cookie 后跳回)
    const ownerParam = url.searchParams.get('owner')
    if (ownerParam !== null) {
      if (ownerParam === ownerToken()) {
        res.setHeader(
          'Set-Cookie',
          `zx_todo_owner=${ownerParam}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`,
        )
        url.searchParams.delete('owner')
        res.writeHead(302, { Location: url.pathname + url.search })
        return res.end()
      }
      return send(res, 403, 'owner token 不对')
    }

    const scope = resolveScope(req)
    if (scope.setCookies.length) res.setHeader('Set-Cookie', scope.setCookies)
    const ownerOnly = () => send(res, 403, { error: '仅站长可用' })

    if (pathname === '/api/health') {
      return send(res, 200, {
        ok: true,
        owner: scope.owner,
        device: scope.device?.name ?? null,
        // 显式计数名:验收脚本直接读 sync_dedup。
        sync_dedup: syncStats.dedup,
        sync_total: syncStats.total,
        sync_merged: syncStats.merged,
        sync_writes: syncStats.writes,
        sync_rps_warn: syncStats.rpsWarn,
        sync: {
          ...syncStats,
          dedupePct: syncStats.total ? Math.round((syncStats.dedup / syncStats.total) * 1000) / 10 : 0,
          windowMs: SYNC_DEDUPE_MS,
          rpsWarnThreshold: SYNC_RPS_WARN,
          rpsWindowMs: SYNC_RPS_WINDOW_MS,
        },
      })
    }

    // 浏览器默认会探 /favicon.ico;给 204,避免 /today 出现一条 404 控制台错误。
    if (pathname === '/favicon.ico') {
      res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' })
      return res.end()
    }

    /* ---------- 今天办(内联 HTML,手机优先;与 /api/state 同一 scope 文件) ---------- */
    if ((pathname === '/today' || pathname === '/today/') && req.method === 'GET') {
      let data
      try {
        data = read(scope.file)
      } catch {
        data = { revision: 0, items: [] }
      }
      const html = renderTodayPage({ data, owner: scope.owner, now: new Date() })
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Vary', 'Accept-Encoding')
      return sendBuffer(res, 200, MIME['.html'], Buffer.from(html), pickEncoding(req), '')
    }

    if (pathname === '/api/state' && req.method === 'GET') {
      const data = read(scope.file)
      // 轻量轮询:revision 没变就 304,连 JSON 都不用传。
      const since = Number(url.searchParams.get('since'))
      if (Number.isFinite(since) && since > 0 && since === data.revision) {
        res.writeHead(304, { 'Cache-Control': 'no-store' })
        return res.end()
      }
      return send(res, 200, { data, owner: scope.owner, viewing: scope.viewing })
    }

    /* ---------- 多端同步(仅站长 / 设备令牌) ---------- */
    if (pathname === '/api/devices/pair' && req.method === 'POST') {
      const body = await readBody(req)
      const given = typeof body.ownerToken === 'string' ? body.ownerToken : ''
      if (!safeEqual(given, ownerToken())) return send(res, 403, { error: '站长口令不对' })
      const name = typeof body.name === 'string' ? body.name : '未命名设备'
      const device = pairDevice(DATA_DIR, name)
      return send(res, 200, { ...device, serverTime: new Date().toISOString() })
    }

    if (pathname === '/api/devices' && req.method === 'GET') {
      if (!scope.owner) return ownerOnly()
      return send(res, 200, { devices: listDevices(DATA_DIR) })
    }

    if (pathname === '/api/devices/revoke' && req.method === 'POST') {
      if (!scope.owner) return ownerOnly()
      const body = await readBody(req)
      const id = typeof body.id === 'string' ? body.id : ''
      if (!id) return send(res, 400, { error: '缺少设备 id' })
      if (scope.device?.id === id) return send(res, 400, { error: '不能撤销当前正在使用的设备' })
      const ok = revokeDevice(DATA_DIR, id)
      return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: '设备不存在' })
    }

    if (pathname === '/api/sync' && req.method === 'POST') {
      if (!scope.owner) return send(res, 403, { error: '仅站长可用' })
      if (scope.viewing) return send(res, 403, { error: '查看访客时不能同步' })

      // 先按原始字节做哈希:客户端每 200ms 发同一份 40KB state 时,
      // 后续请求命中缓存后不合并、不落盘,直接复用上一次的响应。
      const raw = await readRawBody(req)
      let body
      try {
        body = JSON.parse(raw.toString('utf8') || '{}')
      } catch {
        return send(res, 400, { error: '请求体必须是 JSON' })
      }
      const state = body?.state
      if (!state || typeof state !== 'object' || !Array.isArray(state.items)) {
        return send(res, 400, { error: 'state 必须是完整的 TodoFile' })
      }
      if (state.items.length > 20000) {
        return send(res, 413, { error: '待办数量超过上限' })
      }

      const deviceId = String(body.deviceId || scope.device?.id || 'unknown').slice(0, 80)
      const hash = crypto.createHash('sha256').update(raw).digest('hex')
      const key = `${deviceId}:${hash}`
      const now = Date.now()
      syncStats.total += 1
      syncStats.lastSyncAt = new Date(now).toISOString()
      noteSyncRate(deviceId, now)

      // 同一设备 + 同一 body,5s 内且 todos.json 没被别人改过 → 去重。
      // 不读文件、不拿锁、不 merge、不写盘,直接回上次响应。
      const cached = syncCache.get(key)
      if (
        SYNC_DEDUPE_MS > 0 &&
        cached &&
        now - cached.at < SYNC_DEDUPE_MS &&
        sameStamp(cached.stamp, fileStamp(scope.file))
      ) {
        syncStats.dedup += 1
        return syncPayload(res, cached, { dedup: true })
      }

      // 并发到达的同一份 body:等第一个请求合并完,直接复用结果。
      const pending = syncInflight.get(key)
      if (pending && now - pending.at < SYNC_DEDUPE_MS) {
        syncStats.dedup += 1
        return syncPayload(res, await pending.promise, { dedup: true })
      }

      syncStats.merged += 1
      const task = (async () => {
        const { data, changed } = update(
          (d) => {
            const merged = mergeData(d, state)
            if (mergeChanged(d, merged)) {
              d.items = merged.items
              d.lists = merged.lists
              d.tombstones = merged.tombstones
              d.listTombstones = merged.listTombstones
              d.listRenames = merged.listRenames
              d.listsUpdatedAt = merged.listsUpdatedAt
              d.version = 3
            }
            return merged
          },
          scope.file,
          { onlyIfChanged: true },
        )
        const st = fileStamp(scope.file)
        const payload = {
          data,
          revision: data.revision,
          changed,
          serverTime: new Date().toISOString(),
        }
        const hit = {
          at: Date.now(),
          stamp: st,
          revision: data.revision,
          etag: stateEtag(data, st),
          changed,
          body: JSON.stringify(payload),
          // 去重命中时同一份 state 已经合并过,changed 必须改回 false,
          // 否则客户端可能把「已确认」误读成「服务端又变了」而回写/重试。
          dedupBody: changed ? JSON.stringify({ ...payload, changed: false }) : null,
        }
        cacheSet(key, hit)
        if (changed) syncStats.writes += 1
        pruneSyncCache(Date.now())
        return hit
      })()
      syncInflight.set(key, { at: now, promise: task })
      let hit
      try {
        hit = await task
      } finally {
        syncInflight.delete(key)
      }
      return syncPayload(res, hit)
    }

    if (pathname === '/api/op' && req.method === 'POST') {
      const body = await readBody(req)
      const op = String(body.op ?? '')
      if (!ops[op]) return send(res, 400, { error: `未知 op:${op}` })
      const baseRevision = Number.isFinite(Number(body.baseRevision)) ? Number(body.baseRevision) : undefined
      try {
        const data = runOp(op, body, scope.file, { baseRevision })
        return send(res, 200, { data })
      } catch (err) {
        // 乐观并发冲突:把最新数据一并返回,客户端可直接用新 revision 重试一次。
        if (err?.code === 'REVISION_CONFLICT') {
          return send(res, 409, { error: 'revision 冲突', revision: err.revision, data: read(scope.file) })
        }
        throw err
      }
    }

    /* ---------- 聊天设置(仅站长) ---------- */

    /* ---------- 访客管理(仅站长) ---------- */
    if (pathname === '/api/visitors' && req.method === 'GET') {
      if (!scope.owner) return ownerOnly()
      return send(res, 200, { visitors: listVisitors(), viewing: scope.viewing })
    }
    if (pathname === '/api/visitors/view' && req.method === 'POST') {
      if (!scope.owner) return ownerOnly()
      const body = await readBody(req)
      const v = typeof body.cid === 'string' ? body.cid.trim() : ''
      if (v && !/^[a-f0-9]{16}$/.test(v)) return send(res, 400, { error: 'cid 非法' })
      addCookie(
        res,
        v
          ? `${VIEW_COOKIE}=${v}; Path=/; SameSite=Lax; HttpOnly`
          : `${VIEW_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`,
      )
      // 注意:用**新**的 cid 读文件,不能用本请求开头算出的 scope.file(那是切换前的)
      const file = v ? path.join(VISITORS_DIR, `${v}.json`) : OWNER_FILE
      return send(res, 200, { data: read(file), owner: true, viewing: v || null })
    }
    if (pathname === '/api/chat/state' && req.method === 'GET') {
      return send(res, 200, chatState(scope.owner, VISITOR_AI))
    }
    if (pathname === '/api/chat/config' && req.method === 'POST') {
      if (!scope.owner) return ownerOnly()
      const body = await readBody(req)
      saveSettings(body)
      return send(res, 200, chatState(true, VISITOR_AI))
    }
    if (pathname === '/api/chat/key' && req.method === 'POST') {
      if (!scope.owner) return ownerOnly()
      const body = await readBody(req)
      if (typeof body.key === 'string') setApiKey(body.key)
      return send(res, 200, chatState(true, VISITOR_AI))
    }
    if (pathname === '/api/chat/models' && req.method === 'POST') {
      if (!scope.owner) return ownerOnly()
      const body = await readBody(req)
      const r = await listModels({ provider: body.provider, baseUrl: body.baseUrl })
      return send(res, 200, r)
    }

    /* ---------- 对话记录(按数据域持久化;站长查看访客时只读) ---------- */
    if (pathname === '/api/chat/history') {
      if (req.method === 'GET') {
        return send(res, 200, readChat(DATA_DIR, scopeKey(scope)))
      }
      if (req.method === 'POST') {
        // 站长「以访客身份查看」时只读 —— 不改动被查看访客的对话
        if (scope.viewing) return send(res, 403, { error: '查看访客时对话只读' })
        const body = await readBody(req)
        return send(res, 200, writeChat(DATA_DIR, scopeKey(scope), body.messages))
      }
    }

    /* ---------- 对话(SSE;站长必可用,访客默认放行;OPENTODO_VISITOR_AI=0 可关) ---------- */
    if (pathname === '/api/chat' && req.method === 'POST') {
      if (!scope.owner && !VISITOR_AI) return ownerOnly()
      return handleChat(req, res, scope)
    }

    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' })

    return serveStatic(req, res, pathname, scope)
  } catch (err) {
    return send(res, 400, { error: err instanceof Error ? err.message : String(err) })
  }
})

server.listen(PORT, () => {
  console.log(`opentodo-web  →  http://localhost:${PORT}`)
  console.log(`owner file    →  ${OWNER_FILE}`)
  console.log(`visitor data  →  ${VISITORS_DIR}/<cid>.json`)
  console.log(`站长入口      →  http://localhost:${PORT}/?owner=${ownerToken()}`)
})
