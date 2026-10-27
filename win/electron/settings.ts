import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import { settingsFile } from './paths'

export interface BallOrigin {
  x: number
  y: number
  edge: 'left' | 'right' | null
}

export interface WinSettings {
  model: string
  variant: string
  fastMode: boolean
  temperature: number
  maxTokens: number
  port: number
  opencodeBin: string
  timeoutSeconds: number
  ballStyle: string
  ballDiameter: number
  launchAtLogin: boolean
  hotkey: string
  syncURL: string
  syncDeviceId: string
  sidebarCollapsed: boolean
  pinned: boolean
  ballOrigin: Record<string, BallOrigin>
  credentials: Record<string, string>
  syncToken: string
}

const DEFAULTS: WinSettings = {
  model: '',
  variant: '',
  fastMode: true,
  temperature: 0.7,
  maxTokens: 2048,
  port: 4096,
  opencodeBin: '',
  timeoutSeconds: 120,
  ballStyle: 'ringC',
  ballDiameter: 64,
  launchAtLogin: false,
  hotkey: 'Control+Alt+T',
  syncURL: '',
  syncDeviceId: '',
  sidebarCollapsed: false,
  pinned: false,
  ballOrigin: {},
  credentials: {},
  syncToken: '',
}

const PUBLIC_KEYS: (keyof WinSettings)[] = [
  'model',
  'variant',
  'fastMode',
  'temperature',
  'maxTokens',
  'port',
  'opencodeBin',
  'timeoutSeconds',
  'ballStyle',
  'ballDiameter',
  'launchAtLogin',
  'hotkey',
  'syncURL',
  'syncDeviceId',
  'sidebarCollapsed',
  'pinned',
  'ballOrigin',
]

class SettingsStore extends EventEmitter {
  private data: WinSettings = { ...DEFAULTS }
  private loaded = false
  private writeTimer: NodeJS.Timeout | null = null

  load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Partial<WinSettings>
      this.data = { ...DEFAULTS, ...raw }
      if (!this.data.ballOrigin || typeof this.data.ballOrigin !== 'object') this.data.ballOrigin = {}
      if (!this.data.credentials || typeof this.data.credentials !== 'object') this.data.credentials = {}
    } catch {
      this.data = { ...DEFAULTS }
    }
  }

  get(): Readonly<WinSettings> {
    this.load()
    return this.data
  }

  /** Public (non-secret) settings plus `hasKey` flags for the UI. */
  publicSettings(): Record<string, unknown> {
    this.load()
    const out: Record<string, unknown> = {}
    for (const key of PUBLIC_KEYS) out[key] = this.data[key]
    out.hasKeys = Object.keys(this.data.credentials)
    out.hasSyncToken = this.data.syncToken !== ''
    return out
  }

  set(patch: Partial<WinSettings>): void {
    this.load()
    for (const key of PUBLIC_KEYS) {
      if (key in patch) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(this.data as any)[key] = (patch as any)[key]
      }
    }
    this.scheduleWrite()
    this.emit('changed', this.publicSettings())
  }

  setCredential(providerID: string, key: string): void {
    this.load()
    if (!providerID) return
    const trimmed = key.trim()
    if (!trimmed) {
      delete this.data.credentials[providerID]
    } else {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('当前系统不可用安全存储（DPAPI），拒绝保存明文密钥')
      }
      this.data.credentials[providerID] = safeStorage.encryptString(trimmed).toString('base64')
    }
    this.scheduleWrite()
    this.emit('changed', this.publicSettings())
  }

  getCredential(providerID: string): string {
    this.load()
    const enc = this.data.credentials[providerID]
    if (!enc) return ''
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    } catch {
      return ''
    }
  }

  setSyncToken(token: string): void {
    this.load()
    if (!token) {
      this.data.syncToken = ''
    } else {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统不可用安全存储（DPAPI）')
      this.data.syncToken = safeStorage.encryptString(token).toString('base64')
    }
    this.scheduleWrite()
    this.emit('changed', this.publicSettings())
  }

  getSyncToken(): string {
    this.load()
    if (!this.data.syncToken) return ''
    try {
      return safeStorage.decryptString(Buffer.from(this.data.syncToken, 'base64'))
    } catch {
      return ''
    }
  }

  clearSyncToken(): void {
    this.data.syncToken = ''
    this.scheduleWrite()
    this.emit('changed', this.publicSettings())
  }

  private scheduleWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer)
    this.writeTimer = setTimeout(() => this.flush(), 200)
  }

  flush(): void {
    // A second instance exits before loading settings; never overwrite the real
    // settings file with defaults in that case.
    if (!this.loaded) return
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    try {
      const dir = path.dirname(settingsFile())
      fs.mkdirSync(dir, { recursive: true })
      const tmp = `${settingsFile()}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8')
      for (let i = 0; ; i++) {
        try {
          fs.renameSync(tmp, settingsFile())
          break
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(code || '') || i >= 10) throw err
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
        }
      }
    } catch (err) {
      console.error('[opentodo] write settings failed', err)
    }
  }
}

export const settings = new SettingsStore()

export function applyLaunchAtLogin(enabled: boolean): void {
  if (!app.isPackaged) return
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      name: 'com.opentodo.win',
    })
  } catch (err) {
    console.error('[opentodo] setLoginItemSettings failed', err)
  }
}
