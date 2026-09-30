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
//   GET  /api/state              → { data, owner }
//   POST /api/op   { op, ... }   → { data }
//   GET  /api/chat/state         → { config(掩码), providers, owner }
//   POST /api/chat/config|key|models → 仅站长
//   POST /api/chat               → SSE 流式对话(仅站长)

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { read, update, normalizeItem } from '../mcp/lib/store.js'
import { ops, runOp } from './ops.js'
import { chatState, listModels, saveSettings, setApiKey } from './settings.js'
import { runChat } from './chat.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8787)
const DIST = path.join(HERE, 'dist')
const DATA_DIR = path.join(HERE, 'data')
const VISITORS_DIR = path.join(DATA_DIR, 'visitors')
const OWNER_TOKEN_FILE = path.join(DATA_DIR, 'owner.token')

// 站长那份额:默认 web/data/todos.json;设 OPENTODO_FILE 指向桌面 App 那份即可两边同源。
const OWNER_FILE = process.env.OPENTODO_FILE || path.join(DATA_DIR, 'todos.json')
// 兜底:即便某处漏传 file,store.js 的 resolveFile() 也只会命中站长那份,**绝不会**误写到
// 桌面 App 的数据文件以外的第三方路径。
process.env.OPENTODO_FILE = OWNER_FILE
// 访客是否也能用 AI(走站长配的 provider/model/密钥)。默认**允许**;`OPENTODO_VISITOR_AI=0` 关闭。
const VISITOR_AI = process.env.OPENTODO_VISITOR_AI !== '0'

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
  // 站长:① 博客登录态(SSO,推荐)② 直接访问用的 owner token(兜底)
  const owner = (!!token && c.zx_todo_owner === token) || validBlogAdmin(req)
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
  return { owner, cid, viewing, file, setCookies }
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

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  return JSON.parse(text)
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

/** 生产:把 vite 的 dist/ 当静态站点发;找不到的路径回落到 index.html(SPA) */
function serveStatic(res, pathname) {
  if (!fs.existsSync(DIST)) {
    return send(res, 404, 'client 还没构建:先跑 `npm run build`(开发时用 `npm run dev`)')
  }
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const target = path.join(DIST, rel)
  const safe = target.startsWith(DIST) ? target : path.join(DIST, 'index.html')
  const file = fs.existsSync(safe) && fs.statSync(safe).isFile() ? safe : path.join(DIST, 'index.html')
  const ext = path.extname(file)
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
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

    if (pathname === '/api/health') return send(res, 200, { ok: true, owner: scope.owner })

    if (pathname === '/api/state' && req.method === 'GET') {
      return send(res, 200, { data: read(scope.file), owner: scope.owner, viewing: scope.viewing })
    }

    if (pathname === '/api/op' && req.method === 'POST') {
      const body = await readBody(req)
      const op = String(body.op ?? '')
      if (!ops[op]) return send(res, 400, { error: `未知 op:${op}` })
      const data = runOp(op, body, scope.file)
      return send(res, 200, { data })
    }

    /* ---------- 聊天设置(仅站长) ---------- */
    const ownerOnly = () => send(res, 403, { error: '仅站长可用' })

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

    /* ---------- 对话(SSE;站长必可用,访客默认放行;OPENTODO_VISITOR_AI=0 可关) ---------- */
    if (pathname === '/api/chat' && req.method === 'POST') {
      if (!scope.owner && !VISITOR_AI) return ownerOnly()
      return handleChat(req, res, scope)
    }

    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' })

    return serveStatic(res, pathname)
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
