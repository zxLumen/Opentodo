'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { applyOp, fetchChatHistory, fetchState, saveChatHistory } from './api'
import { CANCELLED_GROUP, INBOX, UNGROUPED, type Priority, type TodoFile, type TodoItem } from './types'
import { useProjectDrag, useRowDrag } from './useRowDrag'
import { fastIntent } from './intent'
import { SettingsPanel, type ChatState } from './Settings'
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
  /** 新增条目时的分组(空 = 未分组) */
  const [addGroup, setAddGroup] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  /** 打开「⋯」菜单的项目名 */
  const [projectMenu, setProjectMenu] = useState<string | null>(null)
  /** 正在就地重命名的项目名 */
  const [renamingProject, setRenamingProject] = useState<string | null>(null)
  /** 对话消息(快速模式本地处理;将来可接 LLM) */
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant' | 'system'; text: string }[]>(
    [],
  )
  const [chatInput, setChatInput] = useState('')
  const [chatHeight, setChatHeight] = useState(160)
  const chatListRef = useRef<HTMLDivElement>(null)
  const splitRef = useRef<{ y0: number; h0: number } | null>(null)
  /** 聊天设置(provider/模型/fastMode…) */
  const [chat, setChat] = useState<ChatState | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [chatBusy, setChatBusy] = useState(false)
  const streamAbort = useRef<AbortController | null>(null)
  /** 对话持久化:已载入完毕的数据域键(与当前域不一致时不回写,避免切域串写) */
  const loadedScopeRef = useRef<string | null>(null)
  /** 最近一次已保存 / 已载入的对话内容(序列化后比对,避免载入后立刻回写、重复写) */
  const lastSavedRef = useRef<string>('')
  /** 数据域:是否站长 / 正在查看哪个访客的 cid */
  const [scope, setScope] = useState<{ owner: boolean; viewing: string | null }>({
    owner: false,
    viewing: null,
  })
  const [visitors, setVisitors] = useState<
    { cid: string; count: number; active: number; updatedAt: string; sample: string }[]
  >([])
  const [visOpen, setVisOpen] = useState(false)

  const alive = useRef(true)
  /** 给 pagehide 兜底保存用的最新值(事件监听闭包会过期,统一走 ref) */
  const messagesRef = useRef(messages)
  const scopeRef = useRef(scope)
  const busyRef = useRef(false)
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])
  useEffect(() => {
    scopeRef.current = scope
  }, [scope])
  useEffect(() => {
    busyRef.current = chatBusy
  }, [chatBusy])

  const load = useCallback(async () => {
    try {
      const s = await fetchState()
      if (alive.current) {
        setData(s.data)
        setScope({ owner: s.owner, viewing: s.viewing })
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

  /* ---------- 站长:查看访客 ---------- */
  const loadVisitors = useCallback(async () => {
    try {
      const res = await fetch('/api/visitors')
      if (res.ok) {
        const j = (await res.json()) as { visitors?: typeof visitors }
        setVisitors(j.visitors ?? [])
      }
    } catch {
      /* ignore */
    }
  }, [])
  useEffect(() => {
    if (scope.owner) void loadVisitors()
  }, [scope.owner, loadVisitors])
  // 点外面关掉访客浮层
  useEffect(() => {
    if (!visOpen) return
    const close = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('.vis-pop, .vis-btn')) return
      setVisOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [visOpen])
  const viewVisitor = useCallback(
    async (cid: string | null) => {
      try {
        const res = await fetch('/api/visitors/view', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cid }),
        })
        if (res.ok) {
          const j = (await res.json()) as { data: typeof data; viewing: string | null }
          setData(j.data)
          setScope((s) => ({ ...s, viewing: j.viewing }))
          setVisOpen(false)
          void loadVisitors()
        }
      } catch {
        /* ignore */
      }
    },
    [loadVisitors],
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

  /** 当前项目下出现过的分组(给输入框做候选) */
  const groupsInList = useMemo(
    () =>
      [...new Set(items.filter((it) => listName(it) === list).map((it) => it.project))]
        .filter((p): p is string => !!p)
        .sort((a, b) => a.localeCompare(b)),
    [items, list],
  )

  const addTodo = () => {
    const text = adding.trim()
    if (!text) return
    setAdding('')
    void run('add', {
      content: text,
      list,
      project: addGroup.trim() || undefined,
      status: section === 'in_progress' ? 'in_progress' : 'pending',
    })
  }

  // 拖动落点:改分组 + 组内重排都用 move(对齐桌面 move(id,toProject,beforeId:))
  const onReorder = (dragId: string, overId: string, before: boolean) => {
    if (dragId === overId) return
    const over = items.find((i) => i.id === overId)
    if (!over) return
    let beforeId: string | null = overId
    if (!before) {
      // 落在 over 下半 → 插到 over 所属分组里、over 之后
      const grp = items
        .filter(
          (it) =>
            listName(it) === list && inSection(it, section) && projName(it) === projName(over),
        )
        .sort((a, b) => a.order - b.order)
      const i = grp.findIndex((it) => it.id === overId)
      beforeId = i >= 0 ? (grp[i + 1]?.id ?? null) : null
    }
    void run('move', { id: dragId, toProject: over.project, beforeId })
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

  // 对话区高度:读档 + 存档
  useEffect(() => {
    const h = Number(window.localStorage.getItem('zx.todo.chatHeight'))
    if (Number.isFinite(h) && h >= 64) setChatHeight(h)
  }, [])
  useEffect(() => {
    try {
      window.localStorage.setItem('zx.todo.chatHeight', String(chatHeight))
    } catch {
      /* ignore */
    }
  }, [chatHeight])
  // 新消息滚到底
  useEffect(() => {
    chatListRef.current?.scrollTo({ top: chatListRef.current.scrollHeight })
  }, [messages.length])

  /** 当前数据域(对话持久化用):owner | 被查看访客 cid | self(本人访客,服务端再按 cookie 细分) */
  const chatScope = scope.viewing || (scope.owner ? 'owner' : 'self')

  // 载入当前数据域的对话记录(挂载 + 切换数据域时)
  useEffect(() => {
    let aliveHere = true
    void (async () => {
      try {
        const msgs = await fetchChatHistory()
        if (!aliveHere) return
        lastSavedRef.current = JSON.stringify(msgs)
        setMessages(msgs)
      } catch {
        /* 拿不到就当空,不打扰 */
      } finally {
        if (aliveHere) loadedScopeRef.current = chatScope
      }
    })()
    return () => {
      aliveHere = false
    }
  }, [chatScope])

  // 保存对话(每轮结束、非流式、非「查看访客」时;防抖 + 内容去重,避免载入后回写)
  useEffect(() => {
    if (chatBusy || scope.viewing) return
    if (loadedScopeRef.current !== chatScope) return
    const toSave = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.text }))
    if (!toSave.length) return
    const payload = JSON.stringify(toSave)
    if (payload === lastSavedRef.current) return
    const t = setTimeout(() => {
      lastSavedRef.current = payload
      void saveChatHistory(toSave).catch(() => {})
    }, 500)
    return () => clearTimeout(t)
  }, [messages, chatBusy, scope.viewing, chatScope])

  // 关页 / 切走前再兜一次(keepalive)
  useEffect(() => {
    const onHide = () => {
      if (scopeRef.current.viewing || busyRef.current) return
      const toSave = messagesRef.current
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.text }))
      if (!toSave.length) return
      const payload = JSON.stringify(toSave)
      if (payload === lastSavedRef.current) return
      lastSavedRef.current = payload
      void saveChatHistory(toSave, true).catch(() => {})
    }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [])

  const loadChat = useCallback(async () => {
    try {
      const res = await fetch('/api/chat/state')
      if (res.ok) setChat((await res.json()) as ChatState)
    } catch {
      /* 忽略;设置面板里会再拉 */
    }
  }, [])
  useEffect(() => {
    void loadChat()
  }, [loadChat])

  const setLast = (text: string, role: 'assistant' | 'system' = 'assistant') =>
    setMessages((m) => {
      const c = m.slice()
      c[c.length - 1] = { role, text }
      return c
    })

  /** 流式调用后端 /api/chat(token 逐字) */
  const streamLLM = async (convo: { role: string; content: string }[]) => {
    setChatBusy(true)
    const ac = new AbortController()
    streamAbort.current = ac
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: convo, list }),
        signal: ac.signal,
      })
      if (!res.ok || !res.body) {
        const t = await res.text().catch(() => '')
        throw new Error(t.slice(0, 200) || `HTTP ${res.status}`)
      }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let acc = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          const s = line.trim()
          if (!s.startsWith('data:')) continue
          let j: { delta?: string; done?: boolean; text?: string; ops?: unknown[]; error?: string }
          try {
            j = JSON.parse(s.slice(5).trim())
          } catch {
            continue
          }
          if (j.delta) {
            acc += j.delta
            setLast(acc)
          } else if (j.done) {
            setLast(j.text || acc)
            if (j.ops?.length) void load()
          } else if (j.error) {
            setLast(`模型出错:${j.error}`, 'system')
          }
        }
      }
    } catch (e) {
      if (!ac.signal.aborted) setLast(`模型出错:${e instanceof Error ? e.message : String(e)}`, 'system')
    } finally {
      setChatBusy(false)
      streamAbort.current = null
    }
  }

  const sendChat = () => {
    const text = chatInput.trim()
    if (!text || chatBusy || scope.viewing) return
    setChatInput('')
    const convo = [...messages, { role: 'user' as const, text }]
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.text }))
    setMessages((m) => [...m, { role: 'user', text }, { role: 'assistant', text: '' }])
    // 快速模式:明确指令本地处理,不调模型
    if (chat?.config.fastMode ?? true) {
      const r = fastIntent(text, items, list)
      if (r) {
        for (const o of r.ops) void run(o.op, o.args)
        setLast(r.reply)
        return
      }
    }
    // 访客且未放行 AI:提示(默认放行,走站长配的模型)
    if (!chat?.owner && !chat?.visitorAi) {
      setLast(
        'AI 对话仅站长可用 —— 不过你仍可手动增删待办,或用「加一条 …」「完成 …」「列出待办」这类明确指令。',
        'system',
      )
      return
    }
    void streamLLM(convo)
  }

  const onSplitDown = (e: React.PointerEvent) => {
    splitRef.current = { y0: e.clientY, h0: chatHeight }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onSplitMove = (e: React.PointerEvent) => {
    const d = splitRef.current
    if (!d) return
    const h = Math.min(Math.max(d.h0 - (e.clientY - d.y0), 64), Math.max(120, window.innerHeight - 300))
    setChatHeight(h)
  }
  const onSplitUp = () => {
    splitRef.current = null
  }

  return (
    <>
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
          {scope.owner && (
            <div className="vis-wrap">
              <button
                className="icon-btn vis-btn"
                title="查看访客"
                onClick={() => setVisOpen((v) => !v)}
              >
                👥
              </button>
              {visOpen && (
                <div className="vis-pop">
                  <div className="vis-head">
                    <span>访客({visitors.length})</span>
                    {scope.viewing && (
                      <button className="vis-back" type="button" onClick={() => void viewVisitor(null)}>
                        返回我的
                      </button>
                    )}
                  </div>
                  {visitors.length === 0 && <div className="vis-empty">还没有访客数据</div>}
                  {visitors.map((v) => (
                    <button
                      key={v.cid}
                      type="button"
                      className={`vis-item${scope.viewing === v.cid ? ' is-active' : ''}`}
                      onClick={() => void viewVisitor(v.cid)}
                    >
                      <span className="vis-cid">{v.cid.slice(0, 8)}</span>
                      <span className="vis-sample">{v.sample || '(空)'}</span>
                      <span className="vis-count">
                        {v.active}/{v.count}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {chat?.owner && (
            <button className="icon-btn" title="聊天设置" onClick={() => setSettingsOpen(true)}>
              ⚙
            </button>
          )}
          <button className="icon-btn" title="刷新" onClick={() => void load()}>
            <IconRefresh />
          </button>
        </header>

        {scope.viewing && (
          <div className="vis-banner">
            正在查看访客 <b>{scope.viewing.slice(0, 8)}</b> 的待办
            <button type="button" onClick={() => void viewVisitor(null)}>
              返回我的
            </button>
          </div>
        )}

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
              className="add-main"
              value={adding}
              placeholder={section === 'in_progress' ? '添加进行中…' : '添加待办…'}
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addTodo()
              }}
              disabled={busy}
            />
            <input
              className="add-group"
              list="zx-groups"
              value={addGroup}
              placeholder="分组"
              title="分组(可选):已有分组可下拉选,也可直接输新名"
              onChange={(e) => setAddGroup(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addTodo()
              }}
              disabled={busy}
            />
            <datalist id="zx-groups">
              {groupsInList.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
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
                  groupOptions={groupsInList}
                  onSetGroup={(p) => void run('update', { id: it.id, patch: { project: p ?? '' } })}
                />
              ))}
            </div>
          ))}
        </div>

        <div
          className="splitter"
          title="拖动调整对话高度,双击复位"
          onPointerDown={onSplitDown}
          onPointerMove={onSplitMove}
          onPointerUp={onSplitUp}
          onPointerCancel={onSplitUp}
          onDoubleClick={() => setChatHeight(160)}
        />

        <div className="chat" style={{ height: chatHeight }}>
          <div className="chat-list" ref={chatListRef}>
            {messages.length === 0 && (
              <div className="chat-empty">
                {scope.viewing
                  ? '该访客暂无对话记录(查看访客时对话只读)。'
                  : '和 AI 说句话,帮你增删改待办。试试「加一条 写周报」。'}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`bubble ${m.role}`}>
                {m.text}
              </div>
            ))}
          </div>
          <div className="chat-input">
            <textarea
              value={chatInput}
              placeholder={scope.viewing ? '查看访客时对话只读' : '和 AI 说点什么…'}
              rows={1}
              disabled={!!scope.viewing}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  sendChat()
                }
              }}
            />
            {chatBusy ? (
              <button
                className="send stop"
                type="button"
                onClick={() => streamAbort.current?.abort()}
                title="停止"
              >
                ■
              </button>
            ) : (
              <button
                className="send"
                type="button"
                disabled={!!scope.viewing || !chatInput.trim()}
                onClick={sendChat}
                title="发送"
              >
                ➤
              </button>
            )}
          </div>
        </div>

        <footer className="foot">
          <span>rev {data?.revision ?? '—'}</span>
          {error && <span className="error">· {error}</span>}
        </footer>
      </div>
      </div>
      {settingsOpen && (
        <SettingsPanel initial={chat} onClose={() => setSettingsOpen(false)} onChanged={setChat} />
      )}
    </>
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
  groupOptions: string[]
  onSetGroup: (project: string | null) => void
}) {
  const { item, editing } = props
  const [gmenu, setGmenu] = useState(false)
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
          <button title="移动到分组" onClick={() => setGmenu((v) => !v)}>
            <IconFolder />
          </button>
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

      {gmenu && (
        <div className="row-menu" onClick={(e) => e.stopPropagation()}>
          <div className="row-menu-head">移动到分组</div>
          <button
            type="button"
            onClick={() => {
              setGmenu(false)
              props.onSetGroup(null)
            }}
          >
            未分组
          </button>
          {props.groupOptions.map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => {
                setGmenu(false)
                props.onSetGroup(g)
              }}
            >
              {g}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              const n = window.prompt('新分组名称')
              setGmenu(false)
              if (n && n.trim()) props.onSetGroup(n.trim())
            }}
          >
            ＋新建分组…
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
