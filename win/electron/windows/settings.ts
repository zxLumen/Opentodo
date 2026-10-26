import { BrowserWindow, shell } from 'electron'
import path from 'node:path'

const DEV_URL = process.env.VITE_DEV_SERVER_URL

export class SettingsWindow {
  win: BrowserWindow | null = null

  show(): void {
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore()
      this.win.show()
      this.win.moveTop()
      this.win.focus()
      return
    }
    this.win = new BrowserWindow({
      width: 920,
      height: 720,
      minWidth: 760,
      minHeight: 560,
      show: false,
      center: true,
      title: 'Opentodo 设置',
      backgroundColor: '#16181d',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    })
    this.win.setMenuBarVisibility(false)
    this.win.once('ready-to-show', () => {
      this.win?.show()
      this.win?.moveTop()
      this.win?.focus()
    })
    this.win.on('closed', () => {
      this.win = null
    })
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })
    if (DEV_URL) void this.win.loadURL(`${DEV_URL}/settings.html`)
    else void this.win.loadFile(path.join(__dirname, '..', 'dist', 'settings.html'))
  }

  send(channel: string, ...args: unknown[]): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, ...args)
  }

  close(): void {
    this.win?.close()
    this.win = null
  }
}
