import { contextBridge, ipcRenderer } from 'electron'

type Listener<T> = (value: T) => void
function on<T>(channel: string, cb: Listener<T>): () => void {
  const handler = (_event: unknown, value: T) => cb(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  state: {
    get: () => ipcRenderer.invoke('state:get'),
    setActiveList: (name: string | null) => ipcRenderer.invoke('state:active', name),
    onChanged: (cb: Listener<unknown>) => on('state:changed', cb),
  },
  op: (name: string, args: Record<string, unknown> = {}) => ipcRenderer.invoke('op:apply', name, args),
  chat: {
    state: () => ipcRenderer.invoke('chat:state'),
    config: (patch: Record<string, unknown>) => ipcRenderer.invoke('chat:config', patch),
    key: (providerID: string, key: string) => ipcRenderer.invoke('chat:key', providerID, key),
    models: (providerID: string) => ipcRenderer.invoke('chat:models', providerID),
    start: (requestId: string, messages: unknown[], list: string) =>
      ipcRenderer.invoke('chat:start', { requestId, messages, list }),
    stop: (requestId: string) => ipcRenderer.invoke('chat:stop', requestId),
    onEvent: (cb: Listener<{ requestId: string }>) => on('chat:event', cb),
    onChanged: (cb: Listener<unknown>) => on('chat:changed', cb),
  },
  history: {
    get: () => ipcRenderer.invoke('history:get'),
    save: (messages: unknown[]) => ipcRenderer.invoke('history:save', messages),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch: Record<string, unknown>) => ipcRenderer.invoke('settings:set', patch),
    open: () => ipcRenderer.invoke('window:openSettings'),
    onChanged: (cb: Listener<unknown>) => on('settings:changed', cb),
  },
  sync: {
    status: () => ipcRenderer.invoke('sync:status'),
    pair: (url: string, token: string) => ipcRenderer.invoke('sync:pair', url, token),
    now: () => ipcRenderer.invoke('sync:now'),
    disconnect: () => ipcRenderer.invoke('sync:disconnect'),
    onStatus: (cb: Listener<unknown>) => on('sync:status', cb),
  },
  window: {
    hide: () => ipcRenderer.invoke('window:hide'),
    toggle: () => ipcRenderer.invoke('window:toggle'),
    openSettings: () => ipcRenderer.invoke('window:openSettings'),
    quit: () => ipcRenderer.invoke('window:quit'),
    resizeStart: (edge: string) => ipcRenderer.invoke('window:resizeStart', edge),
    resizeEnd: () => ipcRenderer.invoke('window:resizeEnd'),
  },
  ball: {
    dragStart: () => ipcRenderer.invoke('ball:dragStart'),
    dragEnd: () => ipcRenderer.invoke('ball:dragEnd'),
    click: () => ipcRenderer.invoke('ball:click'),
    context: () => ipcRenderer.invoke('ball:context'),
    setStyle: (style: string, diameter: number) => ipcRenderer.invoke('ball:setStyle', style, diameter),
    onChanged: (cb: Listener<unknown>) => {
      const offState = on('state:changed', cb)
      const offSettings = on('settings:changed', cb)
      return () => {
        offState()
        offSettings()
      }
    },
  },
  shell: {
    openDataDir: () => ipcRenderer.invoke('shell:openDataDir'),
    openConfigDir: () => ipcRenderer.invoke('shell:openConfigDir'),
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  },
  app: {
    version: () => ipcRenderer.invoke('app:version'),
    windows: () => ipcRenderer.invoke('debug:windows'),
  },
}

contextBridge.exposeInMainWorld('opentodo', api)
export type OpentodoApi = typeof api
