import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  shell,
} from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { chat } from './chat'
import { settings, applyLaunchAtLogin } from './settings'
import { store, type TodoFile } from './store'
import { sync } from './sync'
import { PanelWindow } from './windows/panel'
import { BallWindow } from './windows/ball'
import { SettingsWindow } from './windows/settings'
import { TrayController } from './tray'
import { appDataDir, chatHistoryFile, configDir, dataFile, logFile } from './paths'

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let panel: PanelWindow | null = null
let ball: BallWindow | null = null
let tray: TrayController | null = null
let settingsWin: SettingsWindow | null = null
let syncPoll: NodeJS.Timeout | null = null
let registeredHotkey = ''
const chatControllers = new Map<string, AbortController>()

function log(...args: unknown[]): void {
  try {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true })
    fs.appendFileSync(
      logFile(),
      `[${new Date().toISOString()}] ${args.map((a) => (a instanceof Error ? a.stack || a.message : String(a))).join(' ')}\n`,
    )
  } catch {
    /* ignore */
  }
}

function broadcastState(data: TodoFile): void {
  panel?.send('state:changed', data)
  settingsWin?.send('state:changed', data)
  ball?.win.webContents.send('state:changed', data)
}

function togglePanel(): void {
  panel?.toggle()
}

function registerHotkey(accel: string): void {
  try {
    globalShortcut.unregisterAll()
  } catch {
    /* ignore */
  }
  const target = accel || 'Control+Alt+T'
  let ok = false
  try {
    ok = globalShortcut.register(target, () => togglePanel())
  } catch (err) {
    log('register hotkey failed', err)
  }
  if (!ok && target !== 'Control+Shift+Alt+T') {
    try {
      ok = globalShortcut.register('Control+Shift+Alt+T', () => togglePanel())
      registeredHotkey = ok ? 'Control+Shift+Alt+T' : ''
    } catch (err) {
      log('fallback hotkey failed', err)
    }
  } else {
    registeredHotkey = ok ? target : ''
  }
  if (!ok) log('hotkey unavailable', target)
}

function startSyncPoll(): void {
  if (syncPoll) return
  syncPoll = setInterval(() => void sync.syncNow(), 45_000)
}

function stopSyncPoll(): void {
  if (syncPoll) clearInterval(syncPoll)
  syncPoll = null
}

function createTray(): void {
  tray = new TrayController({
    togglePanel,
    openSettings: () => openSettings(),
    syncNow: () => void sync.syncNow(),
    quit: () => {
      app.quit()
    },
  })
  tray.create()
}

function openSettings(): void {
  if (!settingsWin) settingsWin = new SettingsWindow()
  settingsWin.show()
  // Keep the floating ball above normal windows after focus changes.
  ball?.win.setAlwaysOnTop(true, 'screen-saver')
  ball?.win.moveTop()
}

function createPanel(): void {
  panel = new PanelWindow()
  panel.win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) log('panel console', level, message)
  })
  panel.win.webContents.on('render-process-gone', (_e, details) => log('panel gone', details))
  panel.win.on('show', () => {
    ball?.setPanelOpen(true)
    void sync.syncNow()
    startSyncPoll()
    panel?.position()
    log('panel shown', JSON.stringify(panel?.win.getBounds()))
  })
  panel.win.on('hide', () => {
    ball?.setPanelOpen(false)
    stopSyncPoll()
  })
  panel.win.on('closed', () => {
    panel = null
  })
}

function createBall(): void {
  ball = new BallWindow()
  ball.win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) log('ball console', level, message)
  })
  ball.win.webContents.on('render-process-gone', (_e, details) => log('ball gone', details))
  ball.setCallbacks(
    () => {
      if (ball) tray?.popupAt(ball.win)
    },
    () => {
      if (panel?.visible) panel.position()
    },
  )
  ball.win.webContents.send('settings:changed', settings.publicSettings())
  setTimeout(() => {
    log(
      'ball ready',
      JSON.stringify({ bounds: ball?.win.getBounds(), visible: ball?.win.isVisible() }),
    )
  }, 2000)
}

function readHistory(): Array<{ role: string; text: string }> {
  try {
    const raw = JSON.parse(fs.readFileSync(chatHistoryFile(), 'utf8'))
    if (Array.isArray(raw)) return raw.slice(-60)
  } catch {
    /* none */
  }
  return []
}

function saveHistory(messages: unknown[]): void {
  try {
    const clean = (Array.isArray(messages) ? messages : [])
      .filter(
        (m): m is { role: string; text: string } =>
          !!m &&
          typeof m === 'object' &&
          ((m as { role?: unknown }).role === 'user' || (m as { role?: unknown }).role === 'assistant') &&
          typeof (m as { text?: unknown }).text === 'string',
      )
      .map((m) => ({ role: m.role, text: m.text.slice(0, 8000) }))
      .slice(-60)
    fs.mkdirSync(path.dirname(chatHistoryFile()), { recursive: true })
    fs.writeFileSync(chatHistoryFile(), JSON.stringify(clean, null, 2) + '\n', 'utf8')
  } catch (err) {
    log('save history failed', err)
  }
}

function registerIpc(): void {
  ipcMain.handle('state:get', () => {
    return { data: store.read(), owner: false, viewing: null }
  })
  ipcMain.handle('state:active', (_e, name: string | null) => {
    store.writeActiveList(name)
    return true
  })
  ipcMain.handle('op:apply', (_e, name: string, args: Record<string, unknown>) => {
    const data = store.applyOp(name, args)
    broadcastState(data)
    return data
  })

  ipcMain.handle('settings:get', () => ({
    ...settings.publicSettings(),
    version: app.getVersion(),
    registeredHotkey,
    dataFile: dataFile(),
    configDir: configDir(),
    appDataDir: appDataDir(),
  }))
  ipcMain.handle('settings:set', (_e, patch: Record<string, unknown>) => {
    const before = settings.get()
    settings.set(patch as never)
    const after = settings.get()
    if (typeof patch.launchAtLogin === 'boolean') applyLaunchAtLogin(patch.launchAtLogin)
    if (patch.hotkey && after.hotkey !== before.hotkey) registerHotkey(after.hotkey)
    if (patch.ballDiameter !== undefined && after.ballDiameter !== before.ballDiameter) ball?.resize()
    tray?.refresh()
    settingsWin?.send('settings:changed', settings.publicSettings())
    ball?.win.webContents.send('settings:changed', settings.publicSettings())
    return settings.publicSettings()
  })

  ipcMain.handle('chat:state', () => chat.chatState())
  ipcMain.handle('chat:config', async (_e, patch: Record<string, unknown>) => {
    chat.saveConfig(patch)
    const state = await chat.chatState()
    panel?.send('chat:changed', state)
    settingsWin?.send('chat:changed', state)
    return state
  })
  ipcMain.handle('chat:key', async (_e, providerID: string, key: string) => {
    chat.setKey(providerID, key)
    const state = await chat.chatState()
    panel?.send('chat:changed', state)
    settingsWin?.send('chat:changed', state)
    return state
  })
  ipcMain.handle('chat:models', (_e, providerID: string) => chat.modelsFor(providerID))

  ipcMain.handle('chat:start', async (event, payload: { requestId: string; messages: unknown[]; list: string }) => {
    const { requestId, messages, list } = payload || ({} as typeof payload)
    if (!requestId) return { ok: false }
    const arr = Array.isArray(messages) ? messages : []
    const lastUser = [...arr]
      .reverse()
      .find(
        (m): m is { role: string; content: string } =>
          !!m && typeof m === 'object' && (m as { role?: unknown }).role === 'user',
      )
    const text = typeof lastUser?.content === 'string' ? lastUser.content : ''
    if (!text.trim()) return { ok: false }

    const previous = chatControllers.get(requestId)
    previous?.abort()
    const controller = new AbortController()
    chatControllers.set(requestId, controller)
    const send = (data: Record<string, unknown>) => {
      if (!event.sender.isDestroyed()) event.sender.send('chat:event', { requestId, ...data })
    }
    void chat
      .send(text, list || '收件箱', (ev) => send(ev), controller.signal)
      .catch((err) => {
        if (controller.signal.aborted) return
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => {
        chatControllers.delete(requestId)
      })
    return { ok: true }
  })
  ipcMain.handle('chat:stop', async (_e, requestId: string) => {
    chatControllers.get(requestId)?.abort()
    chatControllers.delete(requestId)
    await chat.stop()
    return true
  })

  ipcMain.handle('history:get', () => readHistory())
  ipcMain.handle('history:save', (_e, messages: unknown[]) => {
    saveHistory(messages)
    return true
  })

  ipcMain.handle('sync:status', () => sync.status())
  ipcMain.handle('sync:pair', async (_e, url: string, token: string) => {
    const error = await sync.pair(url, token)
    return { error, status: sync.status() }
  })
  ipcMain.handle('sync:now', async () => {
    await sync.syncNow()
    return sync.status()
  })
  ipcMain.handle('sync:disconnect', () => {
    sync.disconnect()
    return sync.status()
  })

  ipcMain.handle('window:hide', () => {
    panel?.hide()
    return true
  })
  ipcMain.handle('window:toggle', () => {
    togglePanel()
    return true
  })
  ipcMain.handle('window:openSettings', () => {
    openSettings()
    return true
  })
  ipcMain.handle('window:quit', () => {
    app.quit()
    return true
  })
  ipcMain.handle('window:resizeStart', () => false)
  ipcMain.handle('window:resizeEnd', () => true)

  ipcMain.handle('ball:dragStart', () => {
    log('ball dragStart')
    ball?.startDrag()
    return true
  })
  ipcMain.handle('ball:dragEnd', () => {
    const moved = ball?.endDrag() ?? false
    log('ball dragEnd moved=', moved)
    return { moved }
  })
  ipcMain.handle('ball:click', () => {
    // Clicking the ball while the panel is open first blurs (and hides) the
    // panel; don't reopen it in that same click.
    if (!panel?.visible && panel?.recentlyHiddenByBlur()) return true
    togglePanel()
    return true
  })
  ipcMain.handle('ball:context', () => {
    if (ball) tray?.popupAt(ball.win)
    return true
  })
  ipcMain.handle('ball:setStyle', (_e, style: string, diameter: number) => {
    settings.set({ ballStyle: style, ballDiameter: diameter })
    ball?.resize()
    ball?.win.webContents.send('settings:changed', settings.publicSettings())
    return true
  })

  ipcMain.handle('shell:openDataDir', () => {
    void shell.openPath(path.dirname(dataFile()))
    return true
  })
  ipcMain.handle('shell:openConfigDir', () => {
    void shell.openPath(configDir())
    return true
  })
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return true
  })

  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('debug:windows', () => {
    const info = (w: BrowserWindow | null) =>
      w && !w.isDestroyed()
        ? {
            bounds: w.getBounds(),
            visible: w.isVisible(),
            focused: w.isFocused(),
            focusable: w.isFocusable(),
            enabled: w.isEnabled(),
            alwaysOnTop: w.isAlwaysOnTop(),
            handle: '0x' + w.getNativeWindowHandle().readBigUInt64LE(0).toString(16),
          }
        : null
    return {
      panel: info(panel?.win ?? null),
      ball: info(ball?.win ?? null),
      settings: info(settingsWin?.win ?? null),
      displays: screen.getAllDisplays().map((d) => ({
        id: d.id,
        bounds: d.bounds,
        workArea: d.workArea,
        scale: d.scaleFactor,
      })),
    }
  })
}

app.on('second-instance', () => {
  // A second launch (Start menu / desktop shortcut) should bring back both
  // surfaces, even if the first instance was started with a stale --hidden flag.
  ball?.show()
  panel?.show()
})

app.whenReady().then(() => {
  if (!gotLock) return
  app.setAppUserModelId('com.opentodo.win')
  settings.load()
  log('starting', `data=${dataFile()}`, `argv=${process.argv.join(' ')}`)

  store.startWatching()
  store.on('changed', broadcastState)
  chat.prepare()
  sync.start()
  sync.on('status', (status) => {
    panel?.send('sync:status', status)
    settingsWin?.send('sync:status', status)
  })
  settings.on('changed', (pub) => {
    settingsWin?.send('settings:changed', pub)
    ball?.win.webContents.send('settings:changed', pub)
  })

  registerIpc()
  createBall()
  createPanel()
  createTray()
  registerHotkey(settings.get().hotkey)
  // Reconcile the Windows Run key with the saved preference. This also removes
  // stale entries left by older builds (which used --hidden).
  applyLaunchAtLogin(settings.get().launchAtLogin)

  // The ball is always shown now; ignore --hidden for backwards compatibility
  // with old autostart entries.
  if (process.argv.includes('--hidden')) {
    log('ignoring --hidden: floating ball is always visible')
  }
  ball?.show()
  log('startup visibility', `ballVisible=${ball?.win.isVisible()}`)
  if (process.env.OPENTODO_SHOW_PANEL === '1') {
    setTimeout(() => panel?.show(), 800)
  }

  app.on('activate', () => panel?.show())
})

app.on('window-all-closed', () => {
  // Tray app: keep running when every window is hidden/closed.
})

app.on('before-quit', () => {
  if (!gotLock) return
  stopSyncPoll()
  for (const c of chatControllers.values()) c.abort()
  chatControllers.clear()
  void chat.shutdown()
  store.stopWatching()
  settings.flush()
  globalShortcut.unregisterAll()
  tray?.destroy()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

process.on('uncaughtException', (err) => log('uncaughtException', err))
process.on('unhandledRejection', (err) => log('unhandledRejection', err))
