import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
// @ts-ignore - plain ESM shared with the web app / MCP
import { read, update, contentSignature } from '../../mcp/lib/store.js'
// @ts-ignore - plain ESM shared with the web app
import { runOp } from '../../web/ops.js'
import { activeFile, dataFile } from './paths'

export interface TodoFile {
  version: number
  revision: number
  updatedAt?: string | null
  items: Array<Record<string, unknown>>
  lists: string[]
  tombstones?: unknown[]
  listTombstones?: unknown[]
  listRenames?: unknown[]
  listsUpdatedAt?: string | null
}

class TodoStore extends EventEmitter {
  private watcher: fs.FSWatcher | null = null
  private debounce: NodeJS.Timeout | null = null
  private lastSignature = ''

  file(): string {
    return dataFile()
  }

  read(): TodoFile {
    const data = read(this.file()) as TodoFile
    this.lastSignature = contentSignature(data)
    return data
  }

  readRaw(): string {
    try {
      return fs.readFileSync(this.file(), 'utf8')
    } catch {
      return ''
    }
  }

  applyOp(name: string, args: Record<string, unknown> = {}): TodoFile {
    const result = runOp(name, args, this.file()) as TodoFile
    this.lastSignature = contentSignature(result)
    this.emit('changed', result)
    return result
  }

  /** Write a merged remote snapshot only if the local file did not change meanwhile. */
  writeRemoteIfUnchanged(snapshotSignature: string, remote: TodoFile): boolean {
    let wrote = false
    try {
      const result = update(
        (data: TodoFile) => {
          if (contentSignature(data) !== snapshotSignature) throw new Error('local-changed')
          Object.assign(data, remote)
          wrote = true
        },
        this.file(),
        { onlyIfChanged: true },
      ) as { data: TodoFile; changed: boolean }
      if (wrote && result.changed) {
        this.lastSignature = contentSignature(result.data)
        this.emit('changed', result.data)
      }
    } catch {
      return false
    }
    return wrote
  }

  signature(file: TodoFile = this.read()): string {
    return contentSignature(file)
  }

  writeActiveList(name: string | null): void {
    try {
      fs.mkdirSync(path.dirname(activeFile()), { recursive: true })
      const text = name && name.trim() ? `${name.trim()}\n` : ''
      fs.writeFileSync(activeFile(), text, 'utf8')
    } catch (err) {
      console.error('[opentodo] write .active failed', err)
    }
  }

  startWatching(): void {
    if (this.watcher) return
    const dir = path.dirname(this.file())
    const base = path.basename(this.file())
    try {
      fs.mkdirSync(dir, { recursive: true })
      this.watcher = fs.watch(dir, (event, filename) => {
        if (filename && filename.toString() !== base) return
        if (this.debounce) clearTimeout(this.debounce)
        this.debounce = setTimeout(() => {
          try {
            const data = this.read()
            const sig = contentSignature(data)
            if (sig === this.lastSignature) return
            this.lastSignature = sig
            this.emit('changed', data)
          } catch (err) {
            console.error('[opentodo] reload failed', err)
          }
        }, 180)
      })
    } catch (err) {
      console.error('[opentodo] watch failed', err)
    }
  }

  stopWatching(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    this.watcher?.close()
    this.watcher = null
  }
}

export const store = new TodoStore()
