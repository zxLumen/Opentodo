import { EventEmitter } from 'node:events'
import os from 'node:os'
import { settings } from './settings'
import { store, type TodoFile } from './store'

export type SyncPhase = 'disabled' | 'idle' | 'syncing' | 'failed'

export interface SyncStatus {
  phase: SyncPhase
  configured: boolean
  lastSyncAt: string | null
  lastError: string | null
  serverURL: string
  deviceId: string
}

function normalizeURL(raw: string): string | null {
  let text = raw.trim()
  if (!text) return null
  if (!text.includes('://')) text = 'https://' + text
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

export class SyncService extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private inFlight = false
  private pendingAgain = false
  private lastSyncAt: string | null = null
  private lastError: string | null = null
  private phase: SyncPhase = 'disabled'

  start(): void {
    this.refreshPhase()
    store.on('changed', () => this.schedule(2))
    if (this.isConfigured()) void this.syncNow()
  }

  isConfigured(): boolean {
    const s = settings.get()
    return Boolean(s.syncURL && s.syncDeviceId && settings.getSyncToken())
  }

  status(): SyncStatus {
    return {
      phase: this.phase,
      configured: this.isConfigured(),
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      serverURL: settings.get().syncURL,
      deviceId: settings.get().syncDeviceId,
    }
  }

  private refreshPhase(): void {
    this.phase = this.isConfigured() ? 'idle' : 'disabled'
    this.emit('status', this.status())
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    if (patch.phase) this.phase = patch.phase
    if (patch.lastError !== undefined) this.lastError = patch.lastError
    if (patch.lastSyncAt !== undefined) this.lastSyncAt = patch.lastSyncAt
    this.emit('status', this.status())
  }

  schedule(seconds: number): void {
    if (!this.isConfigured()) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.syncNow()
    }, seconds * 1000)
  }

  async pair(serverURL: string, ownerToken: string): Promise<string | null> {
    const base = normalizeURL(serverURL)
    if (!base) return '服务器地址无效'
    const owner = ownerToken.trim()
    if (!owner) return '请填写站长口令'
    try {
      const res = await fetch(`${base}/api/devices/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ownerToken: owner, name: os.hostname() }),
        signal: AbortSignal.timeout(25_000),
      })
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) throw new Error(String(json.error || `配对失败 (${res.status})`))
      const deviceId = String(json.deviceId || '')
      const deviceToken = String(json.deviceToken || '')
      if (!deviceId || !deviceToken) throw new Error('服务器返回缺少设备令牌')
      settings.setSyncToken(deviceToken)
      settings.set({ syncURL: base, syncDeviceId: deviceId })
      this.lastError = null
      this.refreshPhase()
      void this.syncNow()
      return null
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.setStatus({ phase: 'failed', lastError: message })
      return message
    }
  }

  disconnect(): void {
    settings.clearSyncToken()
    settings.set({ syncDeviceId: '' })
    this.phase = 'disabled'
    this.lastSyncAt = null
    this.lastError = null
    this.emit('status', this.status())
  }

  async syncNow(): Promise<void> {
    if (!this.isConfigured()) return
    if (this.inFlight) {
      this.pendingAgain = true
      return
    }
    const s = settings.get()
    const base = normalizeURL(s.syncURL)
    if (!base) {
      this.setStatus({ phase: 'failed', lastError: '同步地址无效' })
      return
    }
    let local: TodoFile
    let raw: string
    try {
      raw = store.readRaw()
      local = store.read()
    } catch (err) {
      this.setStatus({ phase: 'failed', lastError: `本地数据无法读取：${String(err)}` })
      return
    }
    const snapshotSig = store.signature(local)
    this.inFlight = true
    this.setStatus({ phase: 'syncing', lastError: null })
    let retry = false
    try {
      const res = await fetch(`${base}/api/sync`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${settings.getSyncToken()}`,
        },
        body: JSON.stringify({ deviceId: s.syncDeviceId, state: local }),
        signal: AbortSignal.timeout(30_000),
      })
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new Error('设备令牌已失效，请在设置里重新配对')
        }
        throw new Error(String(json.error || `同步失败 (${res.status})`))
      }
      const remote = json.data as TodoFile | undefined
      if (remote && store.signature(remote) !== snapshotSig) {
        const wrote = store.writeRemoteIfUnchanged(snapshotSig, remote)
        if (!wrote) retry = true
      }
      this.lastSyncAt = new Date().toISOString()
      this.setStatus({ phase: 'idle', lastError: null, lastSyncAt: this.lastSyncAt })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.setStatus({ phase: 'failed', lastError: message })
    } finally {
      this.inFlight = false
      const shouldRetry = retry || this.pendingAgain
      this.pendingAgain = false
      if (shouldRetry) void this.syncNow()
    }
  }
}

export const sync = new SyncService()
