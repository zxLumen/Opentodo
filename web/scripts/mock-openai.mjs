// 本地 mock provider(仅供开发/验证,不参与生产):OpenAI 兼容 + SSE。
//   node scripts/mock-openai.mjs [port]   # 默认 8901
// 行为(按关键词):
//   - 带 tools + 文本含 "TOOL" → add 的 tool_call,**不传 list**(验证默认当前项目)+ group=工具组
//   - 带 tools + 文本含 "UPD"  → update 的 tool_call(从 system 里取第一个 id,验证 update 真的生效)
//   - 带 tools + 文本含 "CMD"  → 返回 400(逼客户端回落到指令协议)
//   - 不带 tools + "CMD"       → 正文输出 `@@op {"op":"add",...,"group":"指令组"}`
//   - 末条是 tool 结果          → 收尾文本「已加好。」
//   - 其余                      → 流式回「收到:<文本>」

import http from 'node:http'

const PORT = Number(process.argv[2] || 8901)
const MODEL = 'mock-model'

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
const chunk = (content) => ({ choices: [{ index: 0, delta: { content } }] })
const call = (id, name, args) => ({
  choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
})

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)

  if (url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }))
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    const msgs = body.messages ?? []
    const last = msgs[msgs.length - 1] ?? {}
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
    const text = String(lastUser?.content ?? '')
    const sys = String(msgs.find((m) => m.role === 'system')?.content ?? '')
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

    if (hasTools && text.includes('CMD')) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'tools are not supported by this model' } }))
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' })

    if (last.role === 'tool') {
      sse(res, chunk('已加好。'))
      sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      res.write('data: [DONE]\n\n')
      return res.end()
    }

    if (hasTools && text.includes('UPD')) {
      const id = (sys.match(/- \[.\] ([0-9a-f]{8})/) ?? [])[1] ?? 'deadbeef'
      sse(res, call('call_upd', 'update', { id, content: '（已被AI改过）' }))
      sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      res.write('data: [DONE]\n\n')
      return res.end()
    }

    if (hasTools && text.includes('TOOL')) {
      // 故意不传 list —— 应默认落到「当前项目」
      sse(res, call('call_mock_1', 'add', { content: '来自工具调用的待办', group: '工具组' }))
      sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      res.write('data: [DONE]\n\n')
      return res.end()
    }

    if (!hasTools && text.includes('CMD')) {
      sse(res, chunk('好的,我记一条。\n'))
      await sleep(30)
      sse(res, chunk('@@op {"op":"add","content":"来自指令协议的待办","group":"指令组"}'))
      sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      res.write('data: [DONE]\n\n')
      return res.end()
    }

    for (const piece of ['收到:', text]) {
      sse(res, chunk(piece))
      await sleep(30)
    }
    sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    res.write('data: [DONE]\n\n')
    return res.end()
  }

  res.writeHead(404)
  res.end('not found')
})

server.listen(PORT, () => console.log(`mock-openai  →  http://localhost:${PORT}/v1`))
