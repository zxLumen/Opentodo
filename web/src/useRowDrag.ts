// 指针拖拽:既能重排列表内条目,也能把条目拖到左栏某个项目上。
// 用 Pointer Events(鼠标 + 触屏通吃),不用 HTML5 DnD(触屏不触发)。
// 这是从 zxLumen-Blog 的 useDragReorder 精简来的同款思路。

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

export interface DropState {
  overRowId: string | null
  before: boolean
  overProject: string | null
}

const THRESHOLD = 5

export function useRowDrag(opts: {
  onReorder: (dragId: string, overId: string, before: boolean) => void
  onMoveToList: (dragId: string, list: string) => void
}) {
  const { onReorder, onMoveToList } = opts
  const rows = useRef(new Map<string, HTMLElement>())
  const projects = useRef(new Map<string, HTMLElement>())
  const drag = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [drop, setDrop] = useState<DropState>({ overRowId: null, before: false, overProject: null })
  const dropRef = useRef(drop)
  dropRef.current = drop

  const setDropSafe = (d: DropState) => setDrop(d)

  const registerRow = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) rows.current.set(id, el)
      else rows.current.delete(id)
    },
    [],
  )
  const registerProject = useCallback(
    (name: string) => (el: HTMLElement | null) => {
      if (el) projects.current.set(name, el)
      else projects.current.delete(name)
    },
    [],
  )

  const hitTest = useCallback((x: number, y: number): DropState => {
    // 先看是不是悬在左栏某个项目上(拖到项目 = 移动过去)
    for (const [name, el] of projects.current) {
      const r = el.getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return { overRowId: null, before: false, overProject: name }
      }
    }
    for (const [id, el] of rows.current) {
      if (id === drag.current?.id) continue
      const r = el.getBoundingClientRect()
      if (y >= r.top && y <= r.bottom) {
        return { overRowId: id, before: y < r.top + r.height / 2, overProject: null }
      }
    }
    return { overRowId: null, before: false, overProject: null }
  }, [])

  const onMove = useCallback(
    (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < THRESHOLD) return
        d.moved = true
        setDragId(d.id)
      }
      e.preventDefault()
      setDropSafe(hitTest(e.clientX, e.clientY))
    },
    [hitTest],
  )

  const finish = useCallback(
    (commit: boolean) => {
      const d = drag.current
      const at = dropRef.current
      drag.current = null
      setDragId(null)
      setDropSafe({ overRowId: null, before: false, overProject: null })
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      if (!d || !d.moved || !commit) return
      if (at.overProject) onMoveToList(d.id, at.overProject)
      else if (at.overRowId) onReorder(d.id, at.overRowId, at.before)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [onMove, onMoveToList, onReorder],
  )

  const up = useCallback(() => finish(true), [finish])
  const cancel = useCallback(() => finish(false), [finish])

  const onPointerDown = useCallback(
    (id: string) => (e: ReactPointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      // 按钮/输入框上的按下不算拖拽(要能点、要能选字)
      if ((e.target as HTMLElement).closest('button, input, textarea, a')) return
      drag.current = { id, x: e.clientX, y: e.clientY, moved: false }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', cancel)
    },
    [onMove, up, cancel],
  )

  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
    }
  }, [onMove, up, cancel])

  return { dragId, drop, registerRow, registerProject, onPointerDown }
}
