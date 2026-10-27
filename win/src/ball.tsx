import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './ball.css'

interface TodoItem {
  status: string
  archivedAt: string | null
}

function counts(items: TodoItem[]) {
  const live = items.filter((it) => !it.archivedAt)
  const done = live.filter((it) => it.status === 'completed').length
  const active = live.filter((it) => it.status === 'pending' || it.status === 'in_progress').length
  return { done, active, total: live.length }
}

function Ball() {
  const [items, setItems] = useState<TodoItem[]>([])
  const [style, setStyle] = useState('ringC')
  const [diameter, setDiameter] = useState(64)
  const pointer = useRef({ id: -1, down: false })

  const load = async () => {
    try {
      const res = (await window.opentodo.state.get()) as { data?: { items?: TodoItem[] } }
      setItems(res.data?.items ?? [])
    } catch {
      /* ignore */
    }
  }

  const loadSettings = async () => {
    try {
      const s = await window.opentodo.settings.get()
      if (typeof s.ballStyle === 'string') setStyle(s.ballStyle)
      if (typeof s.ballDiameter === 'number') setDiameter(s.ballDiameter)
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    void load()
    void loadSettings()
    const off = window.opentodo.ball.onChanged((data) => {
      if (data && typeof data === 'object' && 'data' in data) {
        const d = (data as { data?: { items?: TodoItem[] } }).data
        setItems(d?.items ?? [])
      } else if (data && typeof data === 'object' && 'ballStyle' in data) {
        const s = data as { ballStyle?: string; ballDiameter?: number }
        if (s.ballStyle) setStyle(s.ballStyle)
        if (typeof s.ballDiameter === 'number') setDiameter(s.ballDiameter)
      }
    })
    const t = setInterval(() => void load(), 5000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [])

  const { done, active, total } = counts(items)
  const progress = total ? Math.min(1, done / total) : 0
  const size = Math.max(40, Math.min(96, diameter))
  const stroke = Math.max(4, Math.round(size * 0.09))
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r

  return (
    <div
      className={`ball ball-${style}`}
      style={{ width: size, height: size }}
      title={`Opentodo · ${active} 待办${total ? ` · ${done}/${total} 完成` : ''}`}
      onPointerDown={(e) => {
        pointer.current = { id: e.pointerId, down: true }
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        void window.opentodo.ball.dragStart()
      }}
      onPointerUp={(e) => {
        if (!pointer.current.down) return
        pointer.current.down = false
        void window.opentodo.ball.dragEnd().then((res) => {
          if (!res.moved) void window.opentodo.ball.click()
        })
      }}
      onPointerCancel={() => {
        pointer.current.down = false
        void window.opentodo.ball.dragEnd()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        void window.opentodo.ball.context()
      }}
    >
      <svg className="ball-ring" viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        <circle className="ball-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
        <circle
          className="ball-progress"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${c * progress} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="ball-label">
        <span className="ball-count">{active}</span>
        <span className="ball-sub">{done}/{total || 0}</span>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Ball />)
