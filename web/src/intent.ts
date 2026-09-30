// 快速模式:把明确、不含糊的指令在本地直接处理掉,不调模型。
// 移植自桌面 App 的 FastIntent.swift —— 指令集、前缀、歧义处理都保持一致。
//
// 设计成**纯函数**:只按当前数据算出「回执文案 + 要执行的操作」,真正的落库交给调用方
// (web 里是逐个 POST /api/op)。这样既好测,也不依赖任何模型。
// 含糊/找不到唯一条目时一律返回 null —— 交给上层决定(将来回落给 LLM)。

import { INBOX, type TodoItem } from './types'

export interface IntentOp {
  op: string
  args: Record<string, unknown>
}
export interface IntentResult {
  reply: string
  ops: IntentOp[]
}

const clean = (s: string) => s.trim().replace(/[。!！?？]+$/g, '')

/** 去掉指令前缀后残留的标点空白 */
const strip = (s: string) =>
  s
    .trim()
    .replace(/^[：:，,、。"'「」《》\s]+/, '')
    .replace(/[：:，,、。"'「」《》\s]+$/, '')
    .trim()

function capture(text: string, prefixes: string[]): string | null {
  for (const p of prefixes) if (text.startsWith(p)) return text.slice(p.length)
  return null
}

/** 内容包含查询且**唯一**命中才返回;否则 undefined(交给上层) */
function uniqueMatch(items: TodoItem[], query: string): TodoItem | null {
  const q = query.toLowerCase()
  const m = items.filter((it) => it.content.toLowerCase().includes(q))
  return m.length === 1 ? m[0] : null
}

const isDone = (it: TodoItem) => it.status === 'completed'
const isArchived = (it: TodoItem) => it.archivedAt != null

function listReply(items: TodoItem[]): string {
  const active = items
    .filter((it) => it.status === 'pending' || it.status === 'in_progress')
    .sort((a, b) => {
      const pa = a.project ?? ''
      const pb = b.project ?? ''
      if (pa !== pb) return pa.localeCompare(pb)
      return a.order - b.order
    })
  if (!active.length) return '当前没有未完成的待办。'
  const lines = [`未完成待办(${active.length}):`]
  for (const it of active) {
    const l = it.list ? `@${it.list} ` : ''
    const p = it.project ? ` [${it.project}]` : ''
    const mark = it.status === 'in_progress' ? '~' : ' '
    lines.push(`- [${mark}] ${l}${p} ${it.content}`)
  }
  return lines.join('\n')
}

export function fastIntent(
  text: string,
  items: TodoItem[],
  currentList: string = INBOX,
): IntentResult | null {
  const t = clean(text)

  if (
    ['列出待办', '看看待办', '有哪些待办', '待办列表', '列出所有待办', '看下待办', '查看待办', '我的待办'].includes(
      t,
    )
  ) {
    return { reply: listReply(items), ops: [] }
  }

  if (['清空已完成', '清除已完成', '删除已完成', '清理已完成'].includes(t)) {
    const before = items.filter((it) => isDone(it) && !isArchived(it)).length
    return {
      reply: `已把完成的待办移入归档(${before} 条),可在归档里恢复`,
      ops: [{ op: 'archiveCompleted', args: { list: currentList } }],
    }
  }

  if (['清空归档', '清空回收站', '清空垃圾箱'].includes(t)) {
    const before = items.filter(isArchived).length
    return {
      reply: `已清空归档(${before} 条,不可恢复)`,
      ops: [{ op: 'purgeArchived', args: { allLists: true } }],
    }
  }

  // 加一条 X
  let c = capture(t, [
    '加一条',
    '添加待办',
    '新增待办',
    '添加一条',
    '新增一条',
    '加个待办',
    '加一个待办',
    '添加',
    '新增',
  ])
  if (c !== null) {
    const content = strip(c)
    if (!content) return null
    return {
      reply: `已添加:${content}`,
      ops: [{ op: 'add', args: { content, list: currentList } }],
    }
  }

  // 完成 X
  c = capture(t, ['标记完成', '完成', '勾选', '搞定'])
  if (c !== null) {
    const q = strip(c)
    const item = q ? uniqueMatch(items, q) : null
    if (!item) return null
    if (isDone(item)) return { reply: `「${item.content}」已经是完成状态`, ops: [] }
    return { reply: `已完成:${item.content}`, ops: [{ op: 'toggle', args: { id: item.id } }] }
  }

  // 恢复 X
  c = capture(t, ['取消归档', '取消完成', '重新打开', '恢复', '还原'])
  if (c !== null) {
    const q = strip(c)
    const item = q ? uniqueMatch(items, q) : null
    if (!item) return null
    if (isArchived(item)) {
      return { reply: `已恢复归档:${item.content}`, ops: [{ op: 'setArchived', args: { id: item.id, archived: false } }] }
    }
    if (isDone(item)) {
      return { reply: `已恢复:${item.content}`, ops: [{ op: 'setStatus', args: { id: item.id, status: 'pending' } }] }
    }
    return { reply: `「${item.content}」本就没完成`, ops: [] }
  }

  // 归档 X
  c = capture(t, ['归档', '存档'])
  if (c !== null) {
    const q = strip(c)
    const item = q ? uniqueMatch(items, q) : null
    if (!item) return null
    if (isArchived(item)) return { reply: `「${item.content}」已经在归档里`, ops: [] }
    if (!isDone(item)) return { reply: `只有已完成的任务才能归档:「${item.content}」还挂着`, ops: [] }
    return { reply: `已归档:${item.content}`, ops: [{ op: 'setArchived', args: { id: item.id, archived: true } }] }
  }

  // 彻底删除 / 删除 X(我们这里都是永久删除)
  c = capture(t, ['彻底删除', '永久删除', '删除', '删掉', '移除', '去掉'])
  if (c !== null) {
    const q = strip(c)
    const item = q ? uniqueMatch(items, q) : null
    if (!item) return null
    return { reply: `已删除:${item.content}`, ops: [{ op: 'remove', args: { id: item.id } }] }
  }

  return null
}
