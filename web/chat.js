// 聊天引擎:把「自然语言 → 待办增删改」接到任意 OpenAI 兼容 provider,并流式回传。
//
// 让模型改待办两条路:
//   1) 原生 tools(function calling)—— 优先。把 ops 映射成工具,模型返回 tool_calls,
//      服务端在锁里执行、回灌结果,循环到出最终文本。
//   2) 指令协议 —— 兜底(provider 不支持 tools 时)。system 约定:要改待办就单独一行
//      输出 `@@op {"op":"...", ...}`;服务端解析、执行、再回执。
//
// 流式:OpenAI 兼容按 SSE(`data: {...}`)解析,同时累积正文与 tool_calls;ollama 走
// `/api/chat` 的 ndjson(仅正文,tools 走指令协议)。

import { read } from '../mcp/lib/store.js'
import { runOp } from './ops.js'
import { getApiKey, getSettings } from './settings.js'
import { ensureUrl, isOpenCodeGo, protocolOf } from './providers.js'

const UA = 'opentodo-web/0.1 (+https://github.com/zxLumen/Opentodo)'
const MAX_ROUNDS = 6

/**
 * 工具定义(与 ops 对齐)。
 *
 * ⚠️ 参数命名:项目(todolist)叫 `list`,项目内的分组/分类叫 `group`(不叫 project)——
 * 中文里「项目」= list,若分组参数也叫 project,模型会把「当前项目」塞进分组里
 * (实测:list 落「收件箱」、分组变成项目名)。落库时再由 normalizeArgs 把 group→project。
 * 每个参数都写清 description,别让模型猜。
 */
const TOOL_DEFS = [
  {
    name: 'add',
    desc: '新增一条待办',
    params: {
      content: { type: 'string', description: '待办内容' },
      list: { type: 'string', description: '项目(todolist)名。省略=当前项目;只有用户明确说到别的项目时才传' },
      group: { type: 'string', description: '项目内的分组/分类名。可省略' },
      priority: { type: 'string', enum: ['high', 'medium', 'low'], description: '优先级,默认 medium' },
      status: { type: 'string', enum: ['pending', 'in_progress'], description: '默认 pending' },
    },
    required: ['content'],
  },
  {
    name: 'update',
    desc: '修改一条待办的内容/优先级/分组',
    params: {
      id: { type: 'string', description: '条目 id(取自当前项目列表)' },
      content: { type: 'string', description: '新内容' },
      group: { type: 'string', description: '新的分组/分类(null 或空 = 移出分组)' },
      priority: { type: 'string', enum: ['high', 'medium', 'low'], description: '新优先级' },
    },
    required: ['id'],
  },
  {
    name: 'setStatus',
    desc: '修改一条待办的状态',
    params: {
      id: { type: 'string' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
    },
    required: ['id', 'status'],
  },
  { name: 'toggle', desc: '勾选/取消完成一条待办', params: { id: { type: 'string' } }, required: ['id'] },
  {
    name: 'setArchived',
    desc: '归档(true)或恢复(false)一条待办',
    params: { id: { type: 'string' }, archived: { type: 'boolean' } },
    required: ['id', 'archived'],
  },
  { name: 'remove', desc: '彻底删除一条待办', params: { id: { type: 'string' } }, required: ['id'] },
  {
    name: 'move',
    desc: '修改一条待办的分组(不换项目)',
    params: { id: { type: 'string' }, toGroup: { type: 'string', description: '目标分组/分类' } },
    required: ['id', 'toGroup'],
  },
  {
    name: 'moveToList',
    desc: '把一条待办移到另一个项目',
    params: { id: { type: 'string' }, list: { type: 'string', description: '目标项目名' } },
    required: ['id', 'list'],
  },
  {
    name: 'addList',
    desc: '新建一个项目(独立的待办清单)。内容与一个尚不存在的项目强相关时,先建它,再用 list 把待办加进去',
    params: { name: { type: 'string', description: '项目名' } },
    required: ['name'],
  },
  {
    name: 'renameList',
    desc: '给项目改名(其下待办跟着走)。仅当用户明确要求给某个项目改名时用',
    params: {
      oldName: { type: 'string', description: '当前项目名' },
      newName: { type: 'string', description: '新项目名' },
    },
    required: ['oldName', 'newName'],
  },
  {
    name: 'deleteList',
    desc: '删除一个项目,连带其下所有待办(含归档),不可恢复。仅当用户明确要求删除某个项目时用',
    params: { name: { type: 'string', description: '要删除的项目名' } },
    required: ['name'],
  },
]

function openAiTools() {
  return TOOL_DEFS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.desc,
      parameters: { type: 'object', properties: t.params, required: t.required },
    },
  }))
}

/**
 * 工具/指令里的参数 → op 参数。统一入口:
 *  - group→project、toGroup→toProject(数据契约里分组字段叫 project)
 *  - add 省略 list 时用当前项目(否则会落进「收件箱」—— 之前的 bug)
 *  - update 的工具参数是扁平的,op 要的是 { id, patch } —— 包一层(否则 patch 恒为 {} 静默失效)
 */
function normalizeArgs(name, raw, currentList) {
  const a = { ...raw }
  if (a.group !== undefined && a.project === undefined) {
    a.project = a.group
    delete a.group
  }
  if (a.toGroup !== undefined && a.toProject === undefined) {
    a.toProject = a.toGroup
    delete a.toGroup
  }
  if (name === 'add') {
    const l = typeof a.list === 'string' ? a.list.trim() : ''
    a.list = l || currentList
  }
  if (name === 'update') {
    const patch = {}
    if (a.content !== undefined) patch.content = a.content
    if (a.priority !== undefined) patch.priority = a.priority
    if (a.project !== undefined) patch.project = a.project
    delete a.content
    delete a.priority
    delete a.project
    return { ...a, patch }
  }
  return a
}

const OP_NAMES = TOOL_DEFS.map((t) => t.name).join(' / ')

function buildSystem(state, currentList, useProtocol) {
  const items = state.items.filter((it) => it.list === currentList && !it.archivedAt)
  const groups = [...new Set(items.map((it) => it.project).filter(Boolean))]
  const lines = items
    .filter((it) => it.status !== 'completed' && it.status !== 'cancelled')
    .map((it) => {
      const mark = it.status === 'in_progress' ? '~' : ' '
      const g = it.project ? ` [分组:${it.project}]` : ''
      return `- [${mark}] ${it.id}  (${it.priority})${g} ${it.content}`
    })
  const lines2 = [
    '你是 Opentodo 的助手,帮用户用自然语言管理他的待办(不是执行任务,而是记录/修改待办)。',
    `当前项目(list)=「${currentList}」。`,
    '术语:「项目」=一个独立的待办清单(字段 list);「分组」(字段 group)=项目内的分类。**别把项目名当成分组** —— 不要把「当前项目」的名字填进 group。',
    '用户的话多半是要**记录的新待办内容**;一条消息里有多项(编号/多行/分号)就拆成多条、去掉编号。只有明确出现「完成/删除/归档/改/列出/清空」这类动作词,才去改已有条目 —— 否则一律新增。',
    // 与桌面 render() 对齐:中性措辞「强相关就换项目」,不要求用户「明确提到项目」;
    // 也**不列全部项目** —— 列了会让模型把新领域退而求其次当成分组。
    '新增默认加到**当前项目**;只有内容与另一个项目**强相关**时才换项目:那个项目不存在,就先 addList 建它,再用 list 指过去(把条目移到新 list 也会自动注册项目)。',
    '每条新待办尽量给一个**简短分组**(优先复用下面的已有分组);语义上确实没有合适的,才留「未分组」。',
    groups.length
      ? `当前项目已用的分组(优先复用):${groups.map((g) => `「${g}」`).join(' ')}`
      : '当前项目还没有分组。',
    '新建项目用 addList;项目改名用 renameList;删除项目用 deleteList(会**连带删掉**其下所有待办、不可恢复;仅当用户明确要求删某个项目时才用)。',
    '当前项目与它的条目已经列在下面了,**不用**为了「看一眼」再调 list 工具。',
    '当前项目下未完成的条目(改/删/完成请用这里的 id):',
    items.length ? lines.join('\n') : '(空)',
  ]
  if (useProtocol) {
    lines2.push(
      '需要改动待办时,单独一行输出:`@@op {"op":"<名字>", ...}`(这一行不会显示给用户)。' +
        `可用 op:${OP_NAMES}。参数:add 需要 content、(可选)group=分组;renameList 要 oldName/newName;deleteList 要 name;update/toggle 等用 id。**别把项目名当 group。**不要在正文里夹这些行。`,
    )
  } else {
    lines2.push('需要改动待办时调用提供的工具。注意 list=项目、group=分组,别混。')
  }
  return lines2.join('\n')
}

function safeParse(s) {
  try {
    return JSON.parse(s || '{}')
  } catch {
    return {}
  }
}

async function streamOpenAi({ base, provider, key, model, temperature, maxTokens, messages, useTools, onEvent, signal }) {
  const headers = { 'Content-Type': 'application/json' }
  if (key) headers.Authorization = `Bearer ${key}`
  if (isOpenCodeGo(provider, base)) {
    headers['x-opencode-session'] = `opentodo-${Date.now().toString(36)}`
    headers['User-Agent'] = UA
  }
  const body = { model, messages, stream: true, temperature, max_tokens: maxTokens }
  if (useTools) body.tools = openAiTools()

  const res = await fetch(`${ensureUrl(base)}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    const err = new Error(`模型接口 HTTP ${res.status}${t ? `: ${t.slice(0, 300)}` : ''}`)
    err.status = res.status
    throw err
  }

  const ct = res.headers.get('content-type') || ''
  let text = ''
  const calls = new Map()

  // 少数端点无视 stream,直接回整包 JSON
  if (ct.includes('application/json')) {
    const j = await res.json()
    const msg = j.choices?.[0]?.message ?? {}
    if (msg.content) {
      text = msg.content
      onEvent({ delta: text })
    }
    for (const tc of msg.tool_calls ?? []) {
      calls.set(tc.index ?? 0, { id: tc.id, name: tc.function?.name, args: tc.function?.arguments })
    }
  } else {
    if (!res.body) throw new Error('模型接口无响应体')
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const parts = buf.split('\n')
      buf = parts.pop() ?? ''
      for (const line of parts) {
        const s = line.trim()
        if (!s.startsWith('data:')) continue
        const data = s.slice(5).trim()
        if (data === '[DONE]') continue
        let j
        try {
          j = JSON.parse(data)
        } catch {
          continue
        }
        const d = j.choices?.[0]?.delta
        if (!d) continue
        if (typeof d.content === 'string' && d.content) {
          text += d.content
          onEvent({ delta: d.content })
        }
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const i = tc.index ?? 0
            const cur = calls.get(i) ?? { id: '', name: '', args: '' }
            if (tc.id) cur.id = tc.id
            if (tc.function?.name) cur.name += tc.function.name
            if (tc.function?.arguments) cur.args += tc.function.arguments
            calls.set(i, cur)
          }
        }
      }
    }
  }

  const toolCalls = [...calls.values()]
    .filter((c) => c.name)
    .map((c) => ({ id: c.id || `call_${Math.random().toString(36).slice(2, 8)}`, name: c.name, args: safeParse(c.args) }))
  return { text, toolCalls }
}

async function streamOllama({ base, model, temperature, maxTokens, messages, onEvent, signal }) {
  const res = await fetch(`${ensureUrl(base)}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, options: { temperature, num_predict: maxTokens } }),
    signal,
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`模型接口 HTTP ${res.status}${t ? `: ${t.slice(0, 300)}` : ''}`)
  }
  if (!res.body) throw new Error('模型接口无响应体')
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let text = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const line of parts) {
      const s = line.trim()
      if (!s) continue
      let j
      try {
        j = JSON.parse(s)
      } catch {
        continue
      }
      const d = j.message?.content
      if (d) {
        text += d
        onEvent({ delta: d })
      }
    }
  }
  return { text, toolCalls: [] }
}

/** 指令协议:抽出 `@@op {...}` 行 */
function parseCommands(text) {
  const cmds = []
  const clean = text
    .split('\n')
    .filter((line) => {
      const m = line.match(/^\s*@@op\s+(\{.*\})\s*$/)
      if (!m) return true
      const obj = safeParse(m[1])
      if (obj && typeof obj.op === 'string') cmds.push(obj)
      return false
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { clean, cmds }
}

/**
 * 跑一轮对话。messages: [{role, content}](不含 system);onEvent 收 SSE 事件。
 * 返回 { text, ops }。
 */
export async function runChat({ messages, currentList, onEvent, signal }) {
  const settings = getSettings()
  const key = getApiKey()
  const proto = protocolOf(settings.provider)
  const base = ensureUrl(settings.baseUrl)
  if (!base) throw new Error('未配置 baseUrl(去设置里选供应商)')
  if (!settings.model) throw new Error('未配置模型(去设置里选)')
  const isLocal = /localhost|127\.0\.0\.1/.test(base) || settings.provider === 'ollama'
  if (!key && !isLocal) throw new Error('未配置 API Key(去设置里填)')

  const state = read()
  let useTools = proto === 'openai'
  let useProtocol = !useTools
  const convo = [{ role: 'system', content: buildSystem(state, currentList, useProtocol) }, ...messages]
  const applied = []

  const callOnce = () =>
    proto === 'openai'
      ? streamOpenAi({
          base,
          provider: settings.provider,
          key,
          model: settings.model,
          temperature: settings.temperature,
          maxTokens: settings.maxTokens,
          messages: convo,
          useTools,
          onEvent,
          signal,
        })
      : streamOllama({
          base,
          model: settings.model,
          temperature: settings.temperature,
          maxTokens: settings.maxTokens,
          messages: convo,
          onEvent,
          signal,
        })

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let res
    try {
      res = await callOnce()
    } catch (e) {
      // provider 不支持 tools(400/422)→ 退回指令协议再试一次
      if (useTools && (e.status === 400 || e.status === 422)) {
        useTools = false
        useProtocol = true
        convo[0] = { role: 'system', content: buildSystem(read(), currentList, true) }
        res = await callOnce()
      } else {
        throw e
      }
    }

    if (res.toolCalls.length) {
      convo.push({ role: 'assistant', content: res.text || null, tool_calls: res.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) })
      for (const tc of res.toolCalls) {
        let out
        try {
          const args = normalizeArgs(tc.name, tc.args, currentList)
          const data = runOp(tc.name, args)
          applied.push({ op: tc.name, args, revision: data.revision })
          out = 'ok'
        } catch (e) {
          out = `error: ${e instanceof Error ? e.message : String(e)}`
        }
        convo.push({ role: 'tool', tool_call_id: tc.id, content: out })
      }
      continue
    }

    // 指令协议:从正文里抽出 @@op 行并执行
    let text = res.text
    if (useProtocol) {
      const { clean, cmds } = parseCommands(res.text)
      text = clean
      for (const c of cmds) {
        const { op, ...args } = c
        try {
          const norm = normalizeArgs(op, args, currentList)
          const data = runOp(op, norm)
          applied.push({ op, args: norm, revision: data.revision })
        } catch (e) {
          text += `\n(操作失败:${e instanceof Error ? e.message : String(e)})`
        }
      }
    }
    return { text: text.trim() || (applied.length ? '已处理。' : ''), ops: applied }
  }
  return { text: '(达到工具调用上限,先到这儿)', ops: applied }
}
