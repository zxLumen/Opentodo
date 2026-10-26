import { BrowserWindow, screen, type Display } from 'electron'
import path from 'node:path'
import { settings, type BallOrigin } from '../settings'
import { BallBounds } from './panel'

const DEV_URL = process.env.VITE_DEV_SERVER_URL

type Edge = 'left' | 'right' | null

export class BallWindow {
  readonly win: BrowserWindow
  private edge: Edge = null
  private retracted = false
  private cursorOutSince = 0
  private checkTimer: NodeJS.Timeout | null = null
  private dragTimer: NodeJS.Timeout | null = null
  private dragStart = { x: 0, y: 0, winX: 0, winY: 0, moved: false }
  private dragging = false
  private revealedAt = Date.now()
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
        this.edge = origin.edge ?? null
      } else {
        origin = null
      }
    }
    if (!origin) {
      const area = primary.workArea
      const size = this.windowSize()
      this.displayId = primary.id
      this.win.setPosition(area.x + area.width - size - 8, area.y + Math.round(area.height * 0.3), false)
      this.edge = 'right'
    }
    this.clampToDisplay()
    this.retracted = false
    this.revealedAt = Date.now()
    this.publishBounds()
    this.startEdgeWatcher()
  }

  private clampToDisplay(): void {
    const b = this.win.getBounds()
    const area = this.displayFor().workArea
    const x = Math.min(Math.max(b.x, area.x - b.width + 12), area.x + area.width - 12)
    const y = Math.min(Math.max(b.y, area.y), area.y + area.height - b.height)
    if (x !== b.x || y !== b.y) this.win.setPosition(x, y, false)
    this.publishBounds()
  }

  private publishBounds(): void {
    BallBounds.current = { ...this.win.getBounds(), displayId: this.displayId }
    if (this.onActiveChange) this.onActiveChange()
  }

  private saveOrigin(revealed = true): void {
    if (this.retracted && !revealed) return
    const b = this.win.getBounds()
    const saved = { ...settings.get().ballOrigin }
    saved[String(this.displayId)] = { x: b.x, y: b.y, edge: this.edge }
    settings.set({ ballOrigin: saved })
  }

  private snapToEdge(): void {
    const b = this.win.getBounds()
    const matched = screen.getDisplayMatching(b)
    this.displayId = matched.id
    const area = this.displayFor().workArea
    const threshold = 70
    const leftDist = Math.abs(b.x - area.x)
    const rightDist = Math.abs(area.x + area.width - (b.x + b.width))
    if (leftDist <= threshold && leftDist <= rightDist) {
      this.edge = 'left'
      this.win.setPosition(area.x, b.y, false)
    } else if (rightDist <= threshold) {
      this.edge = 'right'
      this.win.setPosition(area.x + area.width - b.width, b.y, false)
    } else {
      this.edge = null
    }
    this.clampToDisplay()
    this.saveOrigin()
  }

  private reveal(): void {
    if (!this.retracted) return
    const b = this.win.getBounds()
    const area = this.displayFor().workArea
    if (this.edge === 'left') this.win.setPosition(area.x + 4, b.y, false)
    else if (this.edge === 'right') this.win.setPosition(area.x + area.width - b.width - 4, b.y, false)
    this.retracted = false
    this.revealedAt = Date.now()
    this.publishBounds()
  }

  private retract(): void {
    if (this.retracted || !this.edge) return
    if (settings.get().pinned) return
    const b = this.win.getBounds()
    const area = this.displayFor().workArea
    if (this.edge === 'left') this.win.setPosition(area.x - b.width + 10, b.y, false)
    else this.win.setPosition(area.x + area.width - 10, b.y, false)
    this.retracted = true
    this.publishBounds()
  }

  private hotZone(): { x: number; y: number; width: number; height: number } {
    const b = this.win.getBounds()
    if (!this.retracted) return { x: b.x, y: b.y, width: b.width, height: b.height }
    const area = this.displayFor().workArea
    if (this.edge === 'left') return { x: area.x, y: b.y, width: 16, height: b.height }
    if (this.edge === 'right') return { x: area.x + area.width - 16, y: b.y, width: 16, height: b.height }
    return { x: b.x, y: b.y, width: b.width, height: b.height }
  }

  private startEdgeWatcher(): void {
    this.stopEdgeWatcher()
    this.checkTimer = setInterval(() => {
      if (this.dragging) return
      // Re-assert topmost frequently: other always-on-top overlays (AI widgets,
      // game overlays) can otherwise sit above a non-activating ball.
      if (this.win.isVisible()) {
        this.win.setAlwaysOnTop(true, 'screen-saver')
        this.win.moveTop()
      }
      const panelOpen = this.isPanelOpen()
      if (panelOpen) {
        this.reveal()
        this.cursorOutSince = 0
        return
      }
      const p = screen.getCursorScreenPoint()
      const z = this.hotZone()
      const inside = p.x >= z.x && p.x <= z.x + z.width && p.y >= z.y && p.y <= z.y + z.height
      if (inside) {
        this.reveal()
        this.cursorOutSince = 0
      } else if (this.retracted) {
        // stay retracted
      } else if (this.edge) {
        if (!this.cursorOutSince) this.cursorOutSince = Date.now()
        if (Date.now() - this.cursorOutSince > 1500 && Date.now() - this.revealedAt > 5000) this.retract()
      }
    }, 350)
  }

  private stopEdgeWatcher(): void {
    if (this.checkTimer) clearInterval(this.checkTimer)
    this.checkTimer = null
  }

  private stopTimers(): void {
    this.stopEdgeWatcher()
    if (this.dragTimer) clearInterval(this.dragTimer)
    this.dragTimer = null
  }

  private isPanelOpen(): boolean {
    return PanelVisible.current
  }

  startDrag(): void {
    if (this.dragging) return
    this.dragging = true
    // Reveal first: if the ball is retracted, its window moves right before
    // the drag starts, so record the cursor/window origin after that move.
    this.reveal()
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
    this.snapToEdge()
    this.cursorOutSince = 0
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
    this.clampToDisplay()
    this.saveOrigin()
  }

  setPanelOpen(open: boolean): void {
    PanelVisible.current = open
    if (open) {
      this.reveal()
      this.cursorOutSince = 0
    }
  }
}

export class PanelVisible {
  static current = false
}
