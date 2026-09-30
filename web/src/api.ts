// 与 server.js 的 HTTP 接口对接。只有一个 op 端点,和插件的工具集语义一致。

import type { TodoFile } from './types'

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  if (!res.ok) throw new Error(body?.error || `请求失败(${res.status})`)
  return body as T
}

export interface StateResp {
  data: TodoFile
  owner: boolean
  viewing: string | null
}

export async function fetchState(): Promise<StateResp> {
  const res = await fetch('/api/state', { cache: 'no-store' })
  return json<StateResp>(res)
}

/** 应用一个操作,返回新状态。op 名与 server.js 的 ops 表一致。 */
export async function applyOp(
  op: string,
  args: Record<string, unknown> = {},
): Promise<TodoFile> {
  const res = await fetch('/api/op', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, ...args }),
  })
  const { data } = await json<{ data: TodoFile }>(res)
  return data
}
