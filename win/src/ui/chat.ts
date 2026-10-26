import type { ChatState } from './Settings'

export interface ChatEvent {
  requestId?: string
  type: 'delta' | 'done' | 'error'
  text?: string
  reset?: boolean
  message?: string
}

export async function getChatState(): Promise<ChatState> {
  return (await window.opentodo.chat.state()) as ChatState
}

export async function saveChatKey(provider: string, key: string): Promise<ChatState> {
  return (await window.opentodo.chat.key(provider, key)) as ChatState
}

export async function saveChatConfig(patch: Record<string, unknown>): Promise<ChatState> {
  return (await window.opentodo.chat.config(patch)) as ChatState
}

export async function fetchChatModels(
  provider: string,
  _baseUrl: string,
): Promise<{ models: string[]; efforts: Record<string, string[]> }> {
  return (await window.opentodo.chat.models(provider)) as {
    models: string[]
    efforts: Record<string, string[]>
  }
}

/**
 * Start a streaming turn. Resolves when the turn ends (or on a handled error).
 * The main process owns the opencode session and emits delta/done/error events.
 */
export function streamChat(
  messages: Array<{ role: string; content: string }>,
  list: string,
  onEvent: (event: ChatEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const requestId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `req_${Date.now()}_${Math.random().toString(16).slice(2)}`

  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      off()
      signal.removeEventListener('abort', onAbort)
    }
    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const fail = (err: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err instanceof Error ? err : new Error(String(err)))
    }
    const off = window.opentodo.chat.onEvent((event) => {
      if (event.requestId !== requestId) return
      if (event.type === 'delta') {
        onEvent(event)
      } else if (event.type === 'done') {
        onEvent(event)
        finish()
      } else if (event.type === 'error') {
        onEvent(event)
        finish()
      }
    })
    const onAbort = () => {
      void window.opentodo.chat.stop(requestId)
      finish()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void window.opentodo.chat.start(requestId, messages, list).catch(fail)
  })
}
