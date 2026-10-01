import { useEffect, useState } from 'react'

/**
 * 嵌入会话状态约定(通用,见博客仓库 docs/APP-EMBED.md)。
 *
 * 把「本次会话的 UI 状态」写进 `sessionStorage`(键前缀 `zx-app-state:<appId>:`),
 * 整页刷新(含被博客 iframe 销毁重建)后**同步**恢复、无闪烁;独立打开也生效;
 * 关闭标签页即清空(不落库、不跨设备)。
 */
const PREFIX = 'zx-app-state:opentodo:'

export function readState<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(PREFIX + key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeState<T>(key: string, value: T): void {
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    /* 隐私模式 / 超限:忽略 */
  }
}

/** 像 useState 一样用,但值会随会话存进 sessionStorage 并在刷新后恢复。 */
export function useSessionState<T>(key: string, initial: T | (() => T)) {
  const [state, setState] = useState<T>(() =>
    readState(key, typeof initial === 'function' ? (initial as () => T)() : initial),
  )
  useEffect(() => {
    writeState(key, state)
  }, [key, state])
  return [state, setState] as const
}

/** 供高频场景使用:防抖写入,避免逐次 setItem。key 为空则不写。 */
export function useDebouncedSessionState<T>(key: string, value: T, delay = 400): void {
  useEffect(() => {
    if (!key) return
    const t = setTimeout(() => writeState(key, value), delay)
    return () => clearTimeout(t)
  }, [key, value, delay])
}
