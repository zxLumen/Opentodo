import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'

export const homeDir = os.homedir()

/** Canonical Opentodo data dir — shared with the opencode plugin / MCP. */
export function configDir(): string {
  return path.join(homeDir, '.config', 'opentodo')
}

export function dataFile(): string {
  return process.env.OPENTODO_FILE || path.join(configDir(), 'todos.json')
}

export function activeFile(): string {
  return path.join(configDir(), '.active')
}

/** The location the app's isolated-ish opencode serve runs in. */
export function opencodeLocation(): string {
  return path.join(configDir(), 'opencode')
}

export function pluginTarget(): string {
  return path.join(opencodeLocation(), '.opencode', 'plugins', 'opentodo', 'index.js')
}

export function locationConfigFile(): string {
  return path.join(opencodeLocation(), '.opencode', 'opencode.json')
}

export function appDataDir(): string {
  return path.join(app.getPath('appData'), 'Opentodo')
}

export function settingsFile(): string {
  return path.join(appDataDir(), 'settings.json')
}

export function chatHistoryFile(): string {
  return path.join(appDataDir(), 'chat-history.json')
}

export function logFile(): string {
  return path.join(appDataDir(), 'logs', 'main.log')
}

export function iconPng(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'icon.png')
  return path.join(app.getAppPath(), 'build', 'icon.png')
}

/** Bundled copy of plugin/opentodo.js. */export function pluginSource(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'plugin', 'opentodo.js')
  return path.join(app.getAppPath(), '..', 'plugin', 'opentodo.js')
}
