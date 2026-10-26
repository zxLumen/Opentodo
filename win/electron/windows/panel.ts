import { BrowserWindow, screen, shell } from 'electron'
import path from 'node:path'
import { settings } from '../settings'

const DEV_URL = process.env.VITE_DEV_SERVER_URL

export class PanelWindow {
  readonly win: BrowserWindow
  private suppressBlurUntil = 0
  private lastBlurHideAt = 0

  constructor() {
    this.win = new BrowserWindow({
      width: 480,
      height: 580,
      minWidth: 330,
      minHeight: 420,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: true,
      movable: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      roundedCorners: true,
      title: 'Opentodo',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        devTools: !process.env.OPENTODO_NO_DEVTOOLS,
      },
    })

    this.win.setMenuBarVisibility(false)
    this.win.setAlwaysOnTop(true, 'floating')
    this.win.setSkipTaskbar(true)

    if (DEV_URL) {
      void this.win.loadURL(`${DEV_URL}/panel.html`)
    } else {
      void this.win.loadFile(path.join(__dirname, '..', 'dist', 'panel.html'))
    }

    // Clicking outside closes the panel unless pinned.
    this.win.on('blur', () => {
      if (this.win.webContents.isDevToolsOpened()) return
      if (settings.get().pinned) return
      // Windows may deny foreground focus to a background app right after
      // show(); don't let that self-hide the panel.
      if (Date.now() < this.suppressBlurUntil) return
      if (this.win.isVisible()) {
        this.lastBlurHideAt = Date.now()
        this.hide()
      }
    })
    this.win.on('show', () => {
      this.suppressBlurUntil = Math.max(this.suppressBlurUntil, Date.now() + 300)
    })

    // Never navigate away from the local app.
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })
    this.win.webContents.on('will-navigate', (event, url) => {
      if (DEV_URL && url.startsWith(DEV_URL)) return
      event.preventDefault()
    })
  }

  get visible(): boolean {
    return this.win.isVisible()
  }

  show(): void {
    this.position()
    this.suppressBlurUntil = Date.now() + 900
    this.win.show()
    this.win.setAlwaysOnTop(true, 'floating')
    this.win.moveTop()
    this.win.focus()
  }

  hide(): void {
    this.win.hide()
  }

  /** True when the panel just hid itself because focus moved (e.g. ball click). */
  recentlyHiddenByBlur(): boolean {
    return Date.now() - this.lastBlurHideAt < 700
  }

  toggle(): void {
    if (this.win.isVisible()) this.hide()
    else this.show()
  }

  /** Position the panel next to the floating ball, clamped to its display. */
  position(): void {
    const panelBounds = this.win.getBounds()
    const ball = BallBounds.current
    const display = ball?.displayId
      ? screen.getAllDisplays().find((d) => d.id === ball.displayId) ?? screen.getDisplayMatching(ball)
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const area = display.workArea
    let x: number
    let y: number
    if (ball) {
      const onRightHalf = ball.x + ball.width / 2 > area.x + area.width / 2
      x = onRightHalf ? ball.x - panelBounds.width - 12 : ball.x + ball.width + 12
      y = ball.y + ball.height / 2 - panelBounds.height / 2
    } else {
      x = area.x + area.width - panelBounds.width - 24
      y = area.y + Math.round((area.height - panelBounds.height) / 2)
    }
    x = Math.min(Math.max(x, area.x + 8), area.x + area.width - panelBounds.width - 8)
    y = Math.min(Math.max(y, area.y + 8), area.y + area.height - panelBounds.height - 8)
    this.win.setPosition(Math.round(x), Math.round(y), false)
  }

  focus(): void {
    this.win.focus()
    this.win.webContents.focus()
  }

  send(channel: string, ...args: unknown[]): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, ...args)
  }
}

/** Shared with the ball window so the panel can anchor to it. */
export class BallBounds {
  static current:
    | { x: number; y: number; width: number; height: number; displayId?: number }
    | null = null
}
