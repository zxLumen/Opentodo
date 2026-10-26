// 指针拖拽(鼠标 + 触屏通吃),两个独立的流程:
//  - useRowDrag:拖待办行 → 段内重排 / 拖到左栏项目上移动过去;
//  - useProjectDrag:拖项目行 → 项目重排。
//
// 关键:`pointermove/up/cancel` 三个 window 监听必须在**整个拖拽期间**一直是同一对函数。
// 早期版本把 finish/up/cancel 依赖里塞了每次渲染都新建的回调(onReorder 等),导致
// useEffect 的清理在**每次重渲染**时都把监听摘掉、且不再挂回 —— 于是拖拽刚越过阈值
// (第一次 setState 触发重渲染)就"冻住"。这里统一改成:回调存 ref、监听函数一律稳定。

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
  // 回调存 ref:handler 因此不必把 opts 放进依赖,才能保持身份稳定
  const o = useRef(opts)
  o.current = opts

  const rows = useRef(new Map<string, HTMLElement>())
  const projects = useRef(new Map<string, HTMLElement>())
  const drag = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [drop, setDrop] = useState<DropState>({ overRowId: null, before: false, overProject: null })
  const dropRef = useRef(drop)
  dropRef.current = drop

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

  const onMove = useCallback((e: PointerEvent) => {
    const d = drag.current
    if (!d) return
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < THRESHOLD) return
      d.moved = true
      setDragId(d.id)
    }
    e.preventDefault()
    // 先看是不是悬在左栏某个项目上;否则按所在行算落点
    for (const [name, el] of projects.current) {
      const r = el.getBoundingClientRect()
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        setDrop({ overRowId: null, before: false, overProject: name })
        return
      }
    }
    for (const [id, el] of rows.current) {
      if (id === d.id) continue
      const r = el.getBoundingClientRect()
      if (e.clientY >= r.top && e.clientY <= r.bottom) {
        setDrop({ overRowId: id, before: e.clientY < r.top + r.height / 2, overProject: null })
        return
      }
    }
    setDrop({ overRowId: null, before: false, overProject: null })
  }, [])

  const finish = useCallback(
    (commit: boolean) => {
      const d = drag.current
      const at = dropRef.current
      drag.current = null
      setDragId(null)
      setDrop({ overRowId: null, before: false, overProject: null })
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      if (!d || !d.moved || !commit) return
      if (at.overProject) o.current.onMoveToList(d.id, at.overProject)
      else if (at.overRowId) o.current.onReorder(d.id, at.overRowId, at.before)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [onMove],
  )

  const up = useCallback(() => finish(true), [finish])
  const cancel = useCallback(() => finish(false), [finish])

  const onPointerDown = useCallback(
    (id: string) => (e: ReactPointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      if ((e.target as HTMLElement).closest('button, input, textarea, a')) return
      drag.current = { id, x: e.clientX, y: e.clientY, moved: false }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', cancel)
    },
    [onMove, up, cancel],
  )

  // onMove/up/cancel 现在都是稳定引用 → 这个清理只在卸载时跑,不会中途摘监听
  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
    }
  }, [onMove, up, cancel])

  return { dragId, drop, registerRow, registerProject, onPointerDown }
}

/** 项目栏拖动排序(与待办拖拽是两套独立流程)。 */
export function useProjectDrag(opts: {
  onReorder: (name: string, overName: string, before: boolean) => void
}) {
  const o = useRef(opts)
  o.current = opts

  const drag = useRef<{ name: string; x: number; y: number; moved: boolean } | null>(null)
  const [dragName, setDragName] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ over: string | null; before: boolean }>({
    over: null,
    before: false,
  })
  const dropRef = useRef(drop)
  dropRef.current = drop

  // 落点直接查 DOM(项目行带 data-project),不依赖回调 ref 的 Map
  const onMove = useCallback((e: PointerEvent) => {
    const d = drag.current
    if (!d) return
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < THRESHOLD) return
      d.moved = true
      setDragName(d.name)
    }
    e.preventDefault()
    for (const el of document.querySelectorAll<HTMLElement>('.project[data-project]')) {
      const name = el.dataset.project ?? ''
      if (!name || name === d.name) continue
      const r = el.getBoundingClientRect()
      if (e.clientY >= r.top && e.clientY <= r.bottom) {
        setDrop({ over: name, before: e.clientY < r.top + r.height / 2 })
        return
      }
    }
    setDrop({ over: null, before: false })
  }, [])

  const finish = useCallback(
    (commit: boolean) => {
      const d = drag.current
      const at = dropRef.current
      drag.current = null
      setDragName(null)
      setDrop({ over: null, before: false })
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      if (!d || !d.moved || !commit) return
      if (at.over) o.current.onReorder(d.name, at.over, at.before)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [onMove],
  )

  const up = useCallback(() => finish(true), [finish])
  const cancel = useCallback(() => finish(false), [finish])

  const onPointerDown = useCallback(
    (name: string) => (e: ReactPointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      if ((e.target as HTMLElement).closest('button, input, a')) return
      drag.current = { name, x: e.clientX, y: e.clientY, moved: false }
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

  return { dragName, drop, onPointerDown }
}
