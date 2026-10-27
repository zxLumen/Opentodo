import { Menu, Tray, nativeImage } from 'electron'
import { iconPng } from './paths'
import { settings, applyLaunchAtLogin } from './settings'

export interface TrayActions {
  togglePanel: () => void
  openSettings: () => void
  syncNow: () => void
  quit: () => void
}

export class TrayController {
  private tray: Tray | null = null
  private actions: TrayActions

  constructor(actions: TrayActions) {
    this.actions = actions
  }

  create(): void {
    let image = nativeImage.createFromPath(iconPng())
    if (image.isEmpty()) {
      image = nativeImage.createEmpty()
    } else {
      image = image.resize({ width: 16, height: 16, quality: 'best' })
    }
    this.tray = new Tray(image)
    this.tray.setToolTip('Opentodo')
    this.tray.setContextMenu(this.menu())
    this.tray.on('click', () => this.actions.togglePanel())
    this.tray.on('double-click', () => this.actions.openSettings())
  }

  menu(): Menu {
    const s = settings.get()
    return Menu.buildFromTemplate([
      {
        label: '显示 / 隐藏待办',
        accelerator: s.hotkey.replace('Control', 'Ctrl'),
        click: () => this.actions.togglePanel(),
      },
      { type: 'separator' },
      { label: '设置…', click: () => this.actions.openSettings() },
      { label: '立即同步', click: () => this.actions.syncNow() },
      { type: 'separator' },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: s.launchAtLogin,
        click: (item) => {
          settings.set({ launchAtLogin: item.checked })
          applyLaunchAtLogin(item.checked)
          this.refresh()
        },
      },
      { type: 'separator' },
      { label: `退出 Opentodo`, click: () => this.actions.quit() },
    ])
  }

  refresh(): void {
    this.tray?.setContextMenu(this.menu())
  }

  popupAt(_window?: Electron.BrowserWindow): void {
    this.tray?.popUpContextMenu(this.menu())
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }
}
