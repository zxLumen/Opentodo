'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { applyOp, fetchState } from './api'
import { CANCELLED_GROUP, INBOX, UNGROUPED, type Priority, type TodoFile, type TodoItem } from './types'
import { useProjectDrag, useRowDrag } from './useRowDrag'
import {
  IconChecklist,
  IconPlus,
  IconRefresh,
  IconPlay,
  IconX,
  IconPencil,
  IconArchive,
  IconRestore,
  IconTrash,
  IconFolder,
  IconCheck,
  IconMore,
} from './icons'

type Section = 'active' | 'in_progress' | 'done' | 'archive'

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'active', label: '待办' },
  { key: 'in_progress', label: '进行中' },
  { key: 'done', label: '已完成' },
  { key: 'archive', label: '归档' },
]

const inSection = (it: TodoItem, s: Section): boolean => {
  if (s === 'archive') return it.archivedAt != null
  if (it.archivedAt != null) return false
  if (s === 'active') return it.status === 'pending' || it.status === 'cancelled'
  if (s === 'in_progress') return it.status === 'in_progress'
  return it.status === 'completed'
}

const listName = (it: TodoItem) => it.list ?? INBOX
const projName = (it: TodoItem) => it.project ?? UNGROUPED

export default function App() {
  const [data, setData] = useState<TodoFile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [list, setList] = useState<string>(INBOX)
  const [section, setSection] = useState<Section>('active')
  const [adding, setAdding] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  /** 打开「⋯」菜单的项目名 */
  const [projectMenu, setProjectMenu] = useState<string | null>(null)
  /** 正在就地重命名的项目名 */
  const [renamingProject, setRenamingProject] = useState<string | null>(null)

  const alive = useRef(true)

  const load = useCallback(async () => {
    try {
      const d = await fetchState()
      if (alive.current) {
        setData(d)
        setError(null)
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void load()
    const t = setInterval(() => void load(), 4000)
    return () => {
      alive.current = false
      clearInterval(t)
    }
  }, [load])

  const run = useCallback(
    async (op: string, args: Record<string, unknown> = {}) => {
      setBusy(true)
      try {
        const d = await applyOp(op, args)
        setData(d)
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  // 项目列表为空时兜底收件箱;当前选中的项目若被删了,回到第一个
  const lists = useMemo(() => {
    const l = data?.lists?.length ? data.lists : [INBOX]
    return l
  }, [data])

  useEffect(() => {
    if (!lists.includes(list)) setList(lists[0] ?? INBOX)
  }, [lists, list])

  const items = data?.items ?? []

  const visible = useMemo(() => {
    const inList = items.filter((it) => listName(it) === list && inSection(it, section))
    return inList
  }, [items, list, section])

  // 分组:活动段把「已取消」单独拎到灰色一组;其余按 project 分组
  const groups = useMemo(() => {
    const out: { key: string; label: string; cancelled: boolean; items: TodoItem[] }[] = []
    const byProj = new Map<string, TodoItem[]>()
    const cancelled: TodoItem[] = []
    for (const it of visible) {
      if (section === 'active' && it.status === 'cancelled') {
        cancelled.push(it)
        continue
      }
      const p = projName(it)
      const arr = byProj.get(p)
      if (arr) arr.push(it)
      else byProj.set(p, [it])
    }
    for (const [p, its] of [...byProj.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push({ key: p, label: p, cancelled: false, items: [...its].sort((a, b) => a.order - b.order) })
    }
    if (cancelled.length) {
      out.push({ key: CANCELLED_GROUP, label: CANCELLED_GROUP, cancelled: true, items: cancelled })
    }
    return out
  }, [visible, section])

  const orderedIds = useMemo(
    () => groups.flatMap((g) => g.items.map((it) => it.id)),
    [groups],
  )

  const activeCount = useCallback(
    (name: string) =>
      items.filter(
        (it) =>
          listName(it) === name &&
          it.archivedAt == null &&
          (it.status === 'pending' || it.status === 'in_progress'),
      ).length,
    [items],
  )

  const addTodo = () => {
    const text = adding.trim()
    if (!text) return
    setAdding('')
    void run('add', {
      content: text,
      list,
      status: section === 'in_progress' ? 'in_progress' : 'pending',
    })
  }

  const onReorder = (dragId: string, overId: string, before: boolean) => {
    const ids = [...orderedIds]
    const from = ids.indexOf(dragId)
    const over = ids.indexOf(overId)
    if (from === -1 || over === -1 || dragId === overId) return
    ids.splice(from, 1)
    const target = ids.indexOf(overId)
    ids.splice(before ? target : target + 1, 0, dragId)
    void run('reorder', { orderedIds: ids })
  }

  const drag = useRowDrag({
    onReorder,
    onMoveToList: (dragId, to) => void run('moveToList', { id: dragId, list: to }),
  })

  // 项目重排:把拖动的项目插到目标项目的上/下方(before=null 表示放末尾)
  const onReorderProject = (name: string, overName: string, before: boolean) => {
    if (name === overName) return
    const rest = lists.filter((n) => n !== name)
    const i = rest.indexOf(overName)
    const beforeName = before ? overName : (rest[i + 1] ?? null)
    void run('moveList', { name, before: beforeName })
  }
  const projDrag = useProjectDrag({ onReorder: onReorderProject })

  const renameProject = (oldName: string, newName: string) => {
    setRenamingProject(null)
    const n = newName.trim()
    if (!n || n === oldName) return
    void run('renameList', { oldName, newName: n })
  }

  const deleteProject = (name: string) => {
    const n = items.filter((it) => listName(it) === name).length
    if (!window.confirm(`删除项目「${name}」?其下 ${n} 条待办将一并彻底删除,不可恢复。`)) return
    setProjectMenu(null)
    void run('deleteList', { name })
  }

  // 「⋯」菜单 / 批量动作 的开关
  useEffect(() => {
    if (!projectMenu) return
    const close = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('.p-menu-pop, .p-more')) return
      setProjectMenu(null)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [projectMenu])

  const total = visible.length

  return (
    <div className="panel">
      {!collapsed && (
        <aside className="sidebar">
          <div className="sidebar-head">
            <IconFolder /> 项目
          </div>
          <div className="projects">
            {lists.map((name) => {
              const n = activeCount(name)
              const reorderSide =
                projDrag.dragName && projDrag.drop.over === name
                  ? projDrag.drop.before
                    ? 'before'
                    : 'after'
                  : undefined
              const todoTarget = drag.drop.overProject === name
              return (
                <div
                  key={name}
                  ref={drag.registerProject(name)}
                  data-project={name}
                  className={`project${name === list ? ' is-active' : ''}`}
                  data-drop={reorderSide ?? (todoTarget ? 'target' : undefined)}
                  data-dragging={projDrag.dragName === name ? '' : undefined}
                  onPointerDown={projDrag.onPointerDown(name)}
                  onClick={() => setList(name)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setProjectMenu(name)
                  }}
                >
                  <IconFolder />
                  {renamingProject === name ? (
                    <InlineInput initial={name} onDone={(v) => renameProject(name, v ?? name)} />
                  ) : (
                    <>
                      <span className="p-name">{name}</span>
                      {n > 0 && <span className="p-count">{n}</span>}
                      <button
                        className="p-more"
                        type="button"
                        title="更多"
                        onClick={(e) => {
                          e.stopPropagation()
                          setProjectMenu((m) => (m === name ? null : name))
                        }}
                      >
                        <IconMore />
                      </button>
                    </>
                  )}
                  {projectMenu === name && (
                    <div className="p-menu-pop" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        onClick={() => {
                          setProjectMenu(null)
                          setRenamingProject(name)
                        }}
                      >
                        重命名
                      </button>
                      <button type="button" className="danger" onClick={() => deleteProject(name)}>
                        删除项目
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <button
            className="sidebar-add"
            onClick={() => {
              const name = window.prompt('新建项目名称')
              if (name && name.trim()) void run('addList', { name: name.trim() })
            }}
          >
            <IconPlus /> 新建项目
          </button>
        </aside>
      )}

      <div className="main">
        <header className="head">
          <button
            className="icon-btn"
            title={collapsed ? '显示项目栏' : '隐藏项目栏'}
            onClick={() => setCollapsed((c) => !c)}
          >
            <IconChecklist />
          </button>
          <span className="h-title">
            {list} <span className="h-sub">· {total} 待办</span>
          </span>
          <span className="spacer" />
          <button className="icon-btn" title="刷新" onClick={() => void load()}>
            <IconRefresh />
          </button>
        </header>

        <div className="toolbar">
          <div className="tabs">
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                className={`tab${section === s.key ? ' is-active' : ''}`}
                onClick={() => setSection(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="sec-actions">
            {section === 'active' && (
              <button
                type="button"
                className="sec-btn danger"
                disabled={busy || total === 0}
                onClick={() => deleteProject(list)}
              >
                删除项目
              </button>
            )}
            {section === 'done' && (
              <button
                type="button"
                className="sec-btn accent"
                disabled={busy || total === 0}
                onClick={() => void run('archiveCompleted', { list })}
              >
                移入归档
              </button>
            )}
            {section === 'archive' && (
              <>
                <button
                  type="button"
                  className="sec-btn accent"
                  disabled={busy || total === 0}
                  onClick={() => void run('restoreArchived', { list })}
                >
                  全部恢复
                </button>
                <button
                  type="button"
                  className="sec-btn danger"
                  disabled={busy || total === 0}
                  onClick={() => {
                    if (window.confirm(`清空「${list}」的归档?共 ${total} 条,不可恢复。`))
                      void run('purgeArchived', { list })
                  }}
                >
                  清空归档
                </button>
              </>
            )}
          </div>
        </div>

        {(section === 'active' || section === 'in_progress') && (
          <div className="addbar">
            <IconPlus />
            <input
              value={adding}
              placeholder={section === 'in_progress' ? '添加进行中…' : '添加待办…'}
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addTodo()
              }}
              disabled={busy}
            />
          </div>
        )}

        <div className="list">
          {total === 0 && <div className="empty">这里还没有条目</div>}
          {groups.map((g) => (
            <div key={g.key}>
              <div className={`group-label${g.cancelled ? ' is-cancelled' : ''}`}>{g.label}</div>
              {g.items.map((it) => (
                <Row
                  key={it.id}
                  item={it}
                  section={section}
                  editing={editingId === it.id}
                  dragging={drag.dragId === it.id}
                  drop={
                    drag.drop.overRowId === it.id ? (drag.drop.before ? 'before' : 'after') : undefined
                  }
                  registerRef={drag.registerRow(it.id)}
                  onPointerDown={drag.onPointerDown(it.id)}
                  onToggle={() => void run('toggle', { id: it.id })}
                  onStatus={(status) => void run('setStatus', { id: it.id, status })}
                  onArchive={(archived) => void run('setArchived', { id: it.id, archived })}
                  onRemove={() => void run('remove', { id: it.id })}
                  onEdit={() => setEditingId(it.id)}
                  onEditEnd={(content) => {
                    setEditingId(null)
                    if (content !== null && content.trim() && content !== it.content) {
                      void run('update', { id: it.id, patch: { content: content.trim() } })
                    }
                  }}
                />
              ))}
            </div>
          ))}
        </div>

        <footer className="foot">
          <span>rev {data?.revision ?? '—'}</span>
          {error && <span className="error">· {error}</span>}
        </footer>
      </div>
    </div>
  )
}

function Row(props: {
  item: TodoItem
  section: Section
  editing: boolean
  dragging: boolean
  drop?: 'before' | 'after'
  registerRef: (el: HTMLElement | null) => void
  onPointerDown: (e: React.PointerEvent) => void
  onToggle: () => void
  onStatus: (s: TodoItem['status']) => void
  onArchive: (archived: boolean) => void
  onRemove: () => void
  onEdit: () => void
  onEditEnd: (content: string | null) => void
}) {
  const { item, editing } = props
  return (
    <div
      className="row"
      ref={props.registerRef}
      data-status={item.status}
      data-dragging={props.dragging ? '' : undefined}
      data-drop={props.drop}
      onPointerDown={props.onPointerDown}
    >
      <button
        className="status"
        data-status={item.status}
        title={item.status === 'completed' ? '取消完成' : '标记完成'}
        onClick={props.onToggle}
      >
        <IconCheck />
      </button>

      {editing ? (
        <InlineEdit initial={item.content} onDone={props.onEditEnd} />
      ) : (
        <div className="content">{item.content}</div>
      )}

      {!editing && <span className={`prio ${item.priority}`} title={`优先级:${item.priority}`} />}

      {!editing && (
        <div className="actions">
          {item.status === 'pending' && (
            <button title="开始(进行中)" onClick={() => props.onStatus('in_progress')}>
              <IconPlay />
            </button>
          )}
          {item.status === 'in_progress' && (
            <button title="取消" onClick={() => props.onStatus('cancelled')}>
              <IconX />
            </button>
          )}
          {item.status === 'cancelled' && (
            <button title="重新打开" onClick={() => props.onStatus('pending')}>
              <IconRestore />
            </button>
          )}
          {item.status === 'completed' && (
            <button title="归档" onClick={() => props.onArchive(true)}>
              <IconArchive />
            </button>
          )}
          {item.archivedAt != null && (
            <button title="恢复" onClick={() => props.onArchive(false)}>
              <IconRestore />
            </button>
          )}
          <button title="编辑" onClick={props.onEdit}>
            <IconPencil />
          </button>
          <button
            title="彻底删除"
            onClick={() => {
              if (window.confirm(`彻底删除「${item.content}」?不可恢复。`)) props.onRemove()
            }}
          >
            <IconTrash />
          </button>
        </div>
      )}
    </div>
  )
}

function InlineEdit({ initial, onDone }: { initial: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [v])

  return (
    <div className="edit">
      <textarea
        ref={ref}
        value={v}
        rows={1}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => onDone(v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onDone(v)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onDone(null)
          }
        }}
      />
    </div>
  )
}

// 让 TS 知道 Priority 被用到(类型导出)
export type { Priority }

/** 单行就地输入(项目重命名用)。Enter/失焦保存,Esc 取消。 */
function InlineInput({ initial, onDone }: { initial: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.select()
  }, [])

  return (
    <input
      className="p-edit"
      ref={ref}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onDone(v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onDone(v)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onDone(null)
        }
      }}
    />
  )
}
