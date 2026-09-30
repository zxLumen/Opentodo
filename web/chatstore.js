// 对话记录存储:每个「数据域」(站长 / 每个访客 / 被查看的访客)一份 JSON,
// 落在 `<DATA_DIR>/chat/<key>.json`。
//
// 为什么单独存、不塞进 todos.json:数据层 mcp/lib/store.js 的 normalizeData() 只保留
// `{version,revision,updatedAt,items,lists}`,任何未知字段都会在下次写入时被丢掉 ——
// 对话放同一份文件里保不住。
//
// 只依赖 Node 内置模块(运行时零依赖);tmp + rename 原子写;每个数据域只保留最近
// MAX_MESSAGES 条、单条文本截断到 MAX_TEXT,避免文件无限增长。

import fs from 'node:fs'
import path from 'node:path'

/** 每个数据域最多保留的对话条数(旧消息滚掉) */
export const MAX_MESSAGES = 60
/** 单条消息文本上限 */
export const MAX_TEXT = 4000
const VALID_ROLE = new Set(['user', 'assistant'])

function chatFile(dataDir, key) {
  return path.join(dataDir, 'chat', `${key}.json`)
}

/**
 * 清洗消息:只保留 role ∈ {user,assistant} 的非空字符串文本(丢弃临时 system 提示),
 * 超长截断,只留最近 MAX_MESSAGES 条。前端传 text,兼容 content。
 */
export function sanitizeMessages(input) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const m of input) {
    if (!m || typeof m !== 'object') continue
    const role = m.role
    const text = typeof m.text === 'string' ? m.text : typeof m.content === 'string' ? m.content : ''
    if (!VALID_ROLE.has(role) || !text.trim()) continue
    out.push({ role, text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text })
  }
  return out.slice(-MAX_MESSAGES)
}

/** 读某数据域的对话;文件不存在 / 坏掉都返回空。 */
export function readChat(dataDir, key) {
  try {
    const raw = JSON.parse(fs.readFileSync(chatFile(dataDir, key), 'utf8'))
    return { messages: sanitizeMessages(raw?.messages) }
  } catch {
    return { messages: [] }
  }
}

/** 写某数据域的对话(原子写),返回清洗后的结果。 */
export function writeChat(dataDir, key, messages) {
  const clean = sanitizeMessages(messages)
  const file = chatFile(dataDir, key)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`
  const body = { messages: clean, updatedAt: new Date().toISOString() }
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
  return { messages: clean }
}
