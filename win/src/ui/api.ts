// Windows desktop transport (IPC). Mirrors web/src/api.ts so the shared UI
// can run unchanged inside Electron.

import type { TodoFile } from './types'

export interface StateResp {
  data: TodoFile
  owner: boolean
  viewing: string | null
}

export async function fetchState(): Promise<StateResp> {
  return (await window.opentodo.state.get()) as StateResp
}

/** Apply one op; the main process runs web/ops.js against todos.json. */
export async function applyOp(
  op: string,
  args: Record<string, unknown> = {},
): Promise<TodoFile> {
  return (await window.opentodo.op(op, args)) as TodoFile
}

export interface StoredMessage {
  role: 'user' | 'assistant'
  text: string
}

export async function fetchChatHistory(): Promise<StoredMessage[]> {
  return (await window.opentodo.history.get()) as StoredMessage[]
}

export async function saveChatHistory(
  messages: StoredMessage[],
  _keepalive = false,
): Promise<void> {
  await window.opentodo.history.save(messages)
}
