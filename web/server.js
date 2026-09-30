// Opentodo Web 服务端。
//
// 数据层**原样复用** mcp/lib/store.js —— 同一份 JSON 契约、同一把 mkdir 文件锁、
// 同一条原子 rename 路径,所以 Web 版和桌面 App / opencode 插件 / MCP 读写的是
// 完全一样的东西,天然共存、不需要迁移脚本。
//
// 只是在它上面套了一层 HTTP:
//   GET  /api/state          → { data: TodoFile }   (items / lists / revision)
//   POST /api/op  { op, ... } → { data: TodoFile }   应用一个操作后返回新状态
//   GET  /api/health          → ok
// 生产环境顺带把 vite 构建出的 dist/ 当静态站点发了(开发时用 vite dev + 代理)。
//
// 数据文件:默认 web/data/todos.json;设 OPENTODO_FILE 就指向别的(比如桌面 App 那份),
// 这样就能和本机 App 共用同一份待办。
//
// 访问控制:本版**不做**鉴权 —— 待办是私密数据,正式对外时请交给反向代理
// (如 Caddy 子域 basic_auth)或后续的访客隔离方案,不要直接裸奔在公网。

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  read,
  update,
  newId,
  findItem,
  nextOrder,
  normalizeItem,
} from '../mcp/lib/store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8787)
const DIST = path.join(HERE, 'dist')

// 必须在任何 read/update 之前设好(store.js 的 resolveFile 是调用时才读 env 的)
process.env.OPENTODO_FILE ||= path.join(HERE, 'data', 'todos.json')

const nowIso = () => new Date().toISOString()

/** 空/缺省一律归入默认项目「收件箱」 */
function normList(value) {
  if (value === undefined || value === null || value === '') return '收件箱'
  const s = String(value).trim()
  return s === '' ? '收件箱' : s
}

function ensureList(d, name) {
  if (name && !d.lists.includes(name)) d.lists.push(name)
}

/**
 * 每个 op 在 update() 的锁里对 data 做一次读-改-写。
 * 语义对齐桌面 App(TodoStore.swift)与插件(plugin/opentodo.js),保证多端一致。
 */
const ops = {
  // 新增一条。list 缺省=收件箱;order 落在同一 (list, project) 组的末尾。
  add(d, { content, priority, project, list, status }) {
    const text = String(content ?? '').trim()
    if (!text) throw new Error('内容不能为空')
    const targetList = normList(list)
    const t = status === 'in_progress' ? 'in_progress' : 'pending'
    const item = normalizeItem({
      id: newId(),
      content: text,
      priority: priority ?? 'medium',
      project: project == null || project === '' ? null : String(project),
      list: targetList,
      status: t,
      order: nextOrder(d, project == null || project === '' ? null : String(project), targetList),
    })
    d.items.push(item)
    ensureList(d, item.list)
    return item
  },

  // 改内容 / 优先级 / 分组
  update(d, { id, patch = {} }) {
    const item = findItem(d, id)
    if (!item) throw new Error(`没有 id=${id} 的条目`)
    if (patch.content !== undefined) {
      const text = String(patch.content).trim()
      if (!text) throw new Error('内容不能为空')
      item.content = text
    }
    if (patch.priority !== undefined) item.priority = String(patch.priority)
    if (patch.project !== undefined) item.project = patch.project === '' ? null : patch.project
    item.updatedAt = nowIso()
    return item
  },

  // 切状态(pending / in_progress / completed / cancelled);completed 时盖 completedAt
  setStatus(d, { id, status }) {
    const item = findItem(d, id)
    if (!item) throw new Error(`没有 id=${id} 的条目`)
    item.status = status
    item.completedAt = status === 'completed' ? nowIso() : null
    item.updatedAt = nowIso()
    return item
  },

  // 勾选/取消勾选:completed ↔ pending
  toggle(d, { id }) {
    const item = findItem(d, id)
    if (!item) throw new Error(`没有 id=${id} 的条目`)
    const done = item.status === 'completed'
    item.status = done ? 'pending' : 'completed'
    item.completedAt = done ? null : nowIso()
    item.updatedAt = nowIso()
    return item
  },

  // 归档 / 恢复
  setArchived(d, { id, archived }) {
    const item = findItem(d, id)
    if (!item) throw new Error(`没有 id=${id} 的条目`)
    item.archivedAt = archived ? nowIso() : null
    item.updatedAt = nowIso()
    return item
  },

  // 彻底删除
  remove(d, { id }) {
    const idx = d.items.findIndex((it) => it.id === id)
    if (idx === -1) throw new Error(`没有 id=${id} 的条目`)
    d.items.splice(idx, 1)
  },

  // 重排:按给定 id 顺序写入 order(1..n);只碰传进来的这些,不动别的
  reorder(d, { orderedIds }) {
    if (!Array.isArray(orderedIds)) throw new Error('orderedIds 必须是数组')
    orderedIds.forEach((id, i) => {
      const item = findItem(d, id)
      if (item) {
        item.order = i + 1
        item.updatedAt = nowIso()
      }
    })
  },

  // 把条目移到另一个项目
  moveToList(d, { id, list }) {
    const item = findItem(d, id)
    if (!item) throw new Error(`没有 id=${id} 的条目`)
    item.list = normList(list)
    ensureList(d, item.list)
    item.updatedAt = nowIso()
    return item
  },

  // 调整项目顺序:把 name 插到 before 前面(before=null 放末尾)
  moveList(d, { name, before }) {
    const i = d.lists.indexOf(name)
    if (i === -1) throw new Error(`没有项目「${name}」`)
    d.lists.splice(i, 1)
    const j = before == null ? d.lists.length : d.lists.indexOf(before)
    d.lists.splice(j === -1 ? d.lists.length : j, 0, name)
  },

  addList(d, { name }) {
    const trimmed = String(name ?? '').trim()
    if (!trimmed) throw new Error('项目名不能为空')
    if (!d.lists.includes(trimmed)) d.lists.push(trimmed)
  },

  renameList(d, { oldName, newName }) {
    const oldN = String(oldName ?? '').trim()
    const newN = String(newName ?? '').trim()
    if (!oldN || !newN) throw new Error('项目名不能为空')
    if (oldN === newN) return
    if (!d.lists.includes(oldN)) throw new Error(`没有项目「${oldN}」`)
    if (d.lists.includes(newN)) throw new Error(`项目已存在:${newN}`)
    d.lists = d.lists.map((p) => (p === oldN ? newN : p))
    for (const it of d.items) if (it.list === oldN) it.list = newN
  },

  // 删除项目并连带其下所有条目(含归档),不可恢复
  deleteList(d, { name }) {
    const trimmed = String(name ?? '').trim()
    const idx = d.lists.indexOf(trimmed)
    if (idx === -1) throw new Error(`没有项目「${trimmed}」`)
    d.lists.splice(idx, 1)
    d.items = d.items.filter((it) => it.list !== trimmed)
  },
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
function serveStatic(req, res, pathname) {
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const { pathname } = url

  try {
    if (pathname === '/api/health') return send(res, 200, { ok: true, file: process.env.OPENTODO_FILE })

    if (pathname === '/api/state' && req.method === 'GET') {
      return send(res, 200, { data: read() })
    }

    if (pathname === '/api/op' && req.method === 'POST') {
      const body = await readBody(req)
      const op = String(body.op ?? '')
      const fn = ops[op]
      if (!fn) return send(res, 400, { error: `未知 op:${op}` })
      const { data } = update((d) => fn(d, body))
      return send(res, 200, { data })
    }

    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' })

    return serveStatic(req, res, pathname)
  } catch (err) {
    return send(res, 400, { error: err instanceof Error ? err.message : String(err) })
  }
})

server.listen(PORT, () => {
  console.log(`opentodo-web  →  http://localhost:${PORT}`)
  console.log(`data file     →  ${process.env.OPENTODO_FILE}`)
})
