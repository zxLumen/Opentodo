// 待办操作表:HTTP 的 /api/op 和聊天的工具循环共用同一套语义。
// 语义对齐桌面 App(TodoStore.swift)与插件(plugin/opentodo.js),保证多端一致。

import { update, newId, findItem, nextOrder, normalizeItem } from '../mcp/lib/store.js'

export const nowIso = () => new Date().toISOString()

/** 空/缺省一律归入默认项目「收件箱」 */
export function normList(value) {
  if (value === undefined || value === null || value === '') return '收件箱'
  const s = String(value).trim()
  return s === '' ? '收件箱' : s
}

function ensureList(d, name) {
  if (name && !d.lists.includes(name)) d.lists.push(name)
}

/**
 * 每个 op 在 update() 的锁里对 data 做一次读-改-写。
 */
export const ops = {
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

  // 批量:把某项目内「已完成且未归档」的全部移入归档(对齐桌面 archiveCompleted)
  archiveCompleted(d, { list }) {
    const target = normList(list)
    const now = nowIso()
    for (const it of d.items) {
      if (it.list === target && it.status === 'completed' && !it.archivedAt) {
        it.archivedAt = now
        it.updatedAt = now
      }
    }
  },

  // 批量:恢复某项目内全部归档(清 archivedAt,状态保持不变;对齐 restoreArchived)
  restoreArchived(d, { list }) {
    const target = normList(list)
    const now = nowIso()
    for (const it of d.items) {
      if (it.list === target && it.archivedAt) {
        it.archivedAt = null
        it.updatedAt = now
      }
    }
  },

  // 批量:清空归档(彻底删除;对齐 purgeArchived)。allLists=true 时清所有项目。
  purgeArchived(d, { list, allLists }) {
    d.items = d.items.filter((it) => {
      if (!it.archivedAt) return true
      return allLists ? false : it.list !== normList(list)
    })
  },

  // 整理(对齐桌面/插件的 opentodo_clear):
  //   scope='completed'(默认,安全):把该范围内已完成的移入归档,内容不丢;
  //   scope='archived':清空该范围的归档(不可恢复);
  //   scope='all':删除该范围内**未归档**的条目(归档保留)。
  //   list 省略/null → 作用于全部项目;否则只动该项目。
  clear(d, { scope = 'completed', list } = {}) {
    const now = nowIso()
    const target = list === undefined || list === null || list === '' ? undefined : normList(list)
    const inScope = (it) => target === undefined || it.list === target
    if (scope === 'completed') {
      for (const it of d.items) {
        if (it.status === 'completed' && !it.archivedAt && inScope(it)) {
          it.archivedAt = now
          it.updatedAt = now
        }
      }
      return
    }
    if (scope === 'archived') {
      d.items = d.items.filter((it) => !(it.archivedAt && inScope(it)))
      return
    }
    // 'all':范围内只保留归档
    d.items = d.items.filter((it) => (inScope(it) ? !!it.archivedAt : true))
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

  // 改分组 / 组内重排(对齐桌面 TodoStore.move(id,toProject:beforeId:)):
  //   把 id 的分组设为 toProject(空/"未分组" → null),并插到该组 beforeId 之前
  //   (beforeId 为空 → 放该组末尾);两组 order 都重排为 1..n。
  move(d, { id, toProject, beforeId }) {
    const moving = findItem(d, id)
    if (!moving) throw new Error(`没有 id=${id} 的条目`)
    const list = moving.list
    const oldProject = moving.project
    const targetProject =
      toProject == null || toProject === '' || toProject === '未分组' ? null : String(toProject)
    moving.project = targetProject
    moving.updatedAt = nowIso()

    const byOrder = (a, b) =>
      a.order !== b.order
        ? a.order - b.order
        : String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))
    const groupOf = (proj) => d.items.filter((it) => it.list === list && it.project === proj).sort(byOrder)

    // 目标组(把 moving 摘出来后再定位)
    const tg = groupOf(targetProject).filter((it) => it.id !== id)
    let at = beforeId ? tg.findIndex((it) => it.id === beforeId) : -1
    if (at < 0) at = tg.length
    tg.splice(at, 0, moving)
    tg.forEach((it, i) => {
      it.order = i + 1
    })

    // 旧组重排(跨组时)
    if (oldProject !== targetProject) {
      groupOf(oldProject)
        .filter((it) => it.id !== id)
        .forEach((it, i) => {
          it.order = i + 1
        })
    }
    return moving
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

/** 在锁里执行一个 op,返回新 data。`file` 由调用方按访客/站长决定。 */
export function runOp(name, args = {}, file) {
  const fn = ops[name]
  if (!fn) throw new Error(`未知 op:${name}`)
  const { data } = update((d) => fn(d, args), file)
  return data
}
