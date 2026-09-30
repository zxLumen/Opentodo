// Opentodo Web 服务端。
//
// 数据层**原样复用** mcp/lib/store.js —— 同一份 JSON 契约、同一把 mkdir 文件锁、
// 同一条原子 rename,所以 Web 版和桌面 App / opencode 插件 / MCP 读写的是完全一样的
// 东西,天然共存。ops 表在 ops.js(HTTP 与聊天的工具循环共用)。
//
// 接口:
//   GET  /api/state              → { data: TodoFile }
//   POST /api/op   { op, ... }   → { data }
//   GET  /api/health             → ok
//   GET  /api/chat/state         → { config(掩码), providers }
//   POST /api/chat/config        → 保存 provider/baseUrl/model/温度/fastMode
//   POST /api/chat/key           → 保存 API Key(掩码返回)
//   POST /api/chat/models        → 拉取该 provider 的模型列表
//   POST /api/chat               → SSE 流式对话(未命中快速模式时)
// 生产环境顺带把 vite 构建出的 dist/ 当静态站点发。
//
// 数据文件:默认 web/data/todos.json;设 OPENTODO_FILE 指向别处(如桌面 App 那份)。
// 聊天配置/密钥:web/data/settings.json 与 web/data/chat.key(env OPENTODO_CHAT_KEY 优先)。

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { read } from '../mcp/lib/store.js'
import { ops, runOp } from './ops.js'
import { chatState, listModels, saveSettings, setApiKey } from './settings.js'
import { runChat } from './chat.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8787)
const DIST = path.join(HERE, 'dist')

// 必须在任何 read/update 之前设好(store.js 的 resolveFile 是调用时才读 env 的)
process.env.OPENTODO_FILE ||= path.join(HERE, 'data', 'todos.json')

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

/** SSE 流式对话 */
async function handleChat(req, res) {
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
    if (pathname === '/api/health') return send(res, 200, { ok: true, file: process.env.OPENTODO_FILE })

    if (pathname === '/api/state' && req.method === 'GET') {
      return send(res, 200, { data: read() })
    }

    if (pathname === '/api/op' && req.method === 'POST') {
      const body = await readBody(req)
      const op = String(body.op ?? '')
      if (!ops[op]) return send(res, 400, { error: `未知 op:${op}` })
      const data = runOp(op, body)
      return send(res, 200, { data })
    }

    /* ---------- 聊天设置 ---------- */
    if (pathname === '/api/chat/state' && req.method === 'GET') {
      return send(res, 200, chatState())
    }
    if (pathname === '/api/chat/config' && req.method === 'POST') {
      const body = await readBody(req)
      saveSettings(body)
      return send(res, 200, chatState())
    }
    if (pathname === '/api/chat/key' && req.method === 'POST') {
      const body = await readBody(req)
      if (typeof body.key === 'string') setApiKey(body.key)
      return send(res, 200, chatState())
    }
    if (pathname === '/api/chat/models' && req.method === 'POST') {
      const body = await readBody(req)
      const r = await listModels({ provider: body.provider, baseUrl: body.baseUrl })
      return send(res, 200, r)
    }

    /* ---------- 对话(SSE) ---------- */
    if (pathname === '/api/chat' && req.method === 'POST') {
      return handleChat(req, res)
    }

    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' })

    return serveStatic(res, pathname)
  } catch (err) {
    return send(res, 400, { error: err instanceof Error ? err.message : String(err) })
  }
})

server.listen(PORT, () => {
  console.log(`opentodo-web  →  http://localhost:${PORT}`)
  console.log(`data file     →  ${process.env.OPENTODO_FILE}`)
})
