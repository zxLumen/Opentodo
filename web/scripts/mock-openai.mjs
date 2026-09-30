// 本地 mock provider(仅供开发/验证,不参与生产):OpenAI 兼容 + SSE。
//   node scripts/mock-openai.mjs [port]   # 默认 8901
// 行为:
//   - 末条 user 文本含 "TOOL" 且请求带 tools → 返回一个 add 的 tool_call
//   - 末条 user 文本含 "CMD"  且请求带 tools → 返回 400(逼客户端回落到指令协议)
//   - 末条 user 文本含 "CMD"  且不带 tools → 正文输出一行 `@@op {...}`(指令协议)
//   - 末条消息是 tool 结果 → 收尾文本「已加好。」
//   - 其余 → 流式回「收到:<文本>」

import http from 'node:http'

const PORT = Number(process.argv[2] || 8901)
const MODEL = 'mock-model'

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
const chunk = (content) => ({ choices: [{ index: 0, delta: { content } }] })

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
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0

    // 逼客户端从 tools 回落到指令协议
    if (hasTools && text.includes('CMD')) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'tools are not supported by this model' } }))
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' })
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

    // 工具执行后的收尾
    if (last.role === 'tool') {
      sse(res, chunk('已加好。'))
      sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      res.write('data: [DONE]\n\n')
      return res.end()
    }

    if (hasTools && text.includes('TOOL')) {
      sse(res, {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_mock_1',
                  type: 'function',
                  function: { name: 'add', arguments: JSON.stringify({ content: '来自工具调用的待办', list: '收件箱' }) },
                },
              ],
            },
          },
        ],
      })
      sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      res.write('data: [DONE]\n\n')
      return res.end()
    }

    if (!hasTools && text.includes('CMD')) {
      sse(res, chunk('好的,我记一条。\n'))
      await sleep(30)
      sse(res, chunk('@@op {"op":"add","content":"来自指令协议的待办","list":"收件箱"}'))
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
