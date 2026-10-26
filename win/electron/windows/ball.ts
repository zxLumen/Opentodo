import { BrowserWindow, screen, type Display } from 'electron'
import path from 'node:path'
import { settings, type BallOrigin } from '../settings'
import { BallBounds } from './panel'

const DEV_URL = process.env.VITE_DEV_SERVER_URL

type Edge = 'left' | 'right'

/**
 * Always-visible floating ball, docked to the left or right edge of a display.
 * It never auto-hides/retracts: the user asked for a permanent edge presence.
 */
export class BallWindow {
  readonly win: BrowserWindow
  private edge: Edge = 'right'
  private checkTimer: NodeJS.Timeout | null = null
  private dragTimer: NodeJS.Timeout | null = null
  private dragStart = { x: 0, y: 0, winX: 0, winY: 0, moved: false }
  private dragging = false
  private displayId = screen.getPrimaryDisplay().id
  private onContext: (() => void) | null = null
  private onActiveChange: (() => void) | null = null

  constructor() {
    const size = this.windowSize()
    this.win = new BrowserWindow({
      width: size,
      height: size,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      title: 'Opentodo',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    })
    this.win.setAlwaysOnTop(true, 'screen-saver')
    this.win.setSkipTaskbar(true)

    if (DEV_URL) void this.win.loadURL(`${DEV_URL}/ball.html`)
    else void this.win.loadFile(path.join(__dirname, '..', 'dist', 'ball.html'))

    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.restorePosition()
    this.win.on('closed', () => this.stopTimers())
  }

  setCallbacks(onContext: () => void, onActiveChange: () => void): void {
    this.onContext = onContext
    this.onActiveChange = onActiveChange
  }

  private windowSize(): number {
    return Math.round(settings.get().ballDiameter) + 16
  }

  show(): void {
    this.win.showInactive()
    this.restorePosition()
    this.win.setAlwaysOnTop(true, 'screen-saver')
    this.win.moveTop()
  }

  hide(): void {
    this.win.hide()
  }

  private displayFor(): Display {
    return screen.getAllDisplays().find((d) => d.id === this.displayId) ?? screen.getPrimaryDisplay()
  }

  private restorePosition(): void {
    const displays = screen.getAllDisplays()
    const saved = settings.get().ballOrigin
    let origin: BallOrigin | null = null
    let savedDisplay: Display | null = null
    const primary = screen.getPrimaryDisplay()

    for (const d of displays) {
      if (saved[String(d.id)]) {
        savedDisplay = d
        origin = saved[String(d.id)]
        break
      }
    }

    if (origin && savedDisplay) {
      const area = savedDisplay.workArea
      const valid =
        origin.x >= area.x - 40 &&
        origin.x <= area.x + area.width &&
        origin.y >= area.y &&
        origin.y <= area.y + area.height
      if (valid) {
        this.displayId = savedDisplay.id
        this.win.setPosition(Math.round(origin.x), Math.round(origin.y), false)
        this.edge = origin.edge === 'left' ? 'left' : 'right'
      } else {
        origin = null
      }
    }

    if (!origin) {
      const area = primary.workArea
      const size = this.windowSize()
      this.displayId = primary.id
      this.win.setPosition(area.x + area.width - size, area.y + Math.round(area.height * 0.3), false)
      this.edge = 'right'
    }

    // Always finish fully visible and docked to an edge.
    this.snapToEdge()
    this.startTopmostWatcher()
  }

  private publishBounds(): void {
    BallBounds.current = { ...this.win.getBounds(), displayId: this.displayId }
    if (this.onActiveChange) this.onActiveChange()
  }

  private saveOrigin(): void {
    const b = this.win.getBounds()
    const saved = { ...settings.get().ballOrigin }
    saved[String(this.displayId)] = { x: b.x, y: b.y, edge: this.edge }
    settings.set({ ballOrigin: saved })
  }

  /** Dock to the nearest left/right edge of the nearest display. */
  private snapToEdge(): void {
    const b = this.win.getBounds()
    const matched = screen.getDisplayMatching(b)
    this.displayId = matched.id
    const area = this.displayFor().workArea
    const center = b.x + b.width / 2
    this.edge = center < area.x + area.width / 2 ? 'left' : 'right'
    const x = this.edge === 'left' ? area.x : area.x + area.width - b.width
    const y = Math.min(Math.max(b.y, area.y), area.y + area.height - b.height)
    this.win.setPosition(Math.round(x), Math.round(y), false)
    this.publishBounds()
    this.saveOrigin()
  }

  /** Keep the ball at the edge and fully inside the work area. */
  private keepDocked(): void {
    const b = this.win.getBounds()
    const area = this.displayFor().workArea
    const leftX = area.x
    const rightX = area.x + area.width - b.width
    const atEdge = Math.abs(b.x - leftX) <= 1 || Math.abs(b.x - rightX) <= 1
    const y = Math.min(Math.max(b.y, area.y), area.y + area.height - b.height)
    if (!atEdge) {
      this.snapToEdge()
    } else if (y !== b.y) {
      this.win.setPosition(b.x, y, false)
      this.publishBounds()
      this.saveOrigin()
    }
  }

  private startTopmostWatcher(): void {
    this.stopTopmostWatcher()
    this.checkTimer = setInterval(() => {
      if (!this.win.isVisible()) return
      if (this.dragging) return
      // Some always-on-top overlays can otherwise sit above a non-activating ball.
      this.win.setAlwaysOnTop(true, 'screen-saver')
      this.win.moveTop()
      this.keepDocked()
    }, 500)
  }

  private stopTopmostWatcher(): void {
    if (this.checkTimer) clearInterval(this.checkTimer)
    this.checkTimer = null
  }

  private stopTimers(): void {
    this.stopTopmostWatcher()
    if (this.dragTimer) clearInterval(this.dragTimer)
    this.dragTimer = null
  }

  startDrag(): void {
    if (this.dragging) return
    this.dragging = true
    const cursor = screen.getCursorScreenPoint()
    const b = this.win.getBounds()
    this.dragStart = { x: cursor.x, y: cursor.y, winX: b.x, winY: b.y, moved: false }
    this.dragTimer = setInterval(() => {
      const p = screen.getCursorScreenPoint()
      const dx = p.x - this.dragStart.x
      const dy = p.y - this.dragStart.y
      if (!this.dragStart.moved && Math.abs(dx) + Math.abs(dy) > 4) this.dragStart.moved = true
      this.win.setPosition(this.dragStart.winX + dx, this.dragStart.winY + dy, false)
      this.publishBounds()
    }, 16)
  }

  endDrag(): boolean {
    this.dragging = false
    if (this.dragTimer) clearInterval(this.dragTimer)
    this.dragTimer = null
    // Always re-dock to the nearest edge after a drag.
    this.snapToEdge()
    return this.dragStart.moved
  }

  click(): void {
    this.onActiveChange?.()
  }

  contextMenu(): void {
    this.onContext?.()
  }

  resize(): void {
    const size = this.windowSize()
    const b = this.win.getBounds()
    this.win.setBounds({ x: b.x, y: b.y, width: size, height: size }, false)
    this.snapToEdge()
  }

  /** Kept for compatibility with the panel show/hide hooks. */
  setPanelOpen(_open: boolean): void {
    // The ball is always visible now; nothing to reveal/retract.
  }
}
