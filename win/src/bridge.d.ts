export {}

declare global {
  interface Window {
    opentodo: {
      state: {
        get(): Promise<unknown>
        setActiveList(name: string | null): Promise<boolean>
        onChanged(cb: (data: unknown) => void): () => void
      }
      op(name: string, args?: Record<string, unknown>): Promise<unknown>
      chat: {
        state(): Promise<unknown>
        config(patch: Record<string, unknown>): Promise<unknown>
        key(providerID: string, key: string): Promise<unknown>
        models(providerID: string): Promise<unknown>
        start(requestId: string, messages: unknown[], list: string): Promise<{ ok: boolean }>
        stop(requestId: string): Promise<boolean>
        onEvent(
          cb: (event: {
            requestId?: string
            type: 'delta' | 'done' | 'error'
            text?: string
            reset?: boolean
            message?: string
          }) => void,
        ): () => void
        onChanged(cb: (state: unknown) => void): () => void
      }
      history: {
        get(): Promise<unknown>
        save(messages: unknown[]): Promise<boolean>
      }
      settings: {
        get(): Promise<Record<string, unknown>>
        set(patch: Record<string, unknown>): Promise<Record<string, unknown>>
        open(): Promise<boolean>
        onChanged(cb: (data: unknown) => void): () => void
      }
      sync: {
        status(): Promise<Record<string, unknown>>
        pair(url: string, token: string): Promise<{ error: string | null; status: Record<string, unknown> }>
        now(): Promise<Record<string, unknown>>
        disconnect(): Promise<Record<string, unknown>>
        onStatus(cb: (status: unknown) => void): () => void
      }
      window: {
        hide(): Promise<boolean>
        toggle(): Promise<boolean>
        openSettings(): Promise<boolean>
        quit(): Promise<boolean>
        resizeStart(edge: string): Promise<boolean>
        resizeEnd(): Promise<boolean>
      }
      ball: {
        dragStart(): Promise<boolean>
        dragEnd(): Promise<{ moved: boolean }>
        click(): Promise<boolean>
        context(): Promise<boolean>
        setStyle(style: string, diameter: number): Promise<boolean>
        onChanged(cb: (data: unknown) => void): () => void
      }
      shell: {
        openDataDir(): Promise<boolean>
        openConfigDir(): Promise<boolean>
        openExternal(url: string): Promise<boolean>
      }
      app: {
        version(): Promise<string>
        windows(): Promise<unknown>
      }
    }
  }
}
