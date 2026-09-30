// 聊天/模型配置与密钥的存取。
//   配置 → web/data/settings.json(非密钥,可入库前忽略)
//   密钥 → web/data/chat.key(chmod 600);env OPENTODO_CHAT_KEY 优先(适合容器/CI)
// 两者都在 .gitignore 里(见仓库根 web/data)。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultBaseUrl, ensureUrl, getProvider, protocolOf, PROVIDERS } from './providers.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(HERE, 'data')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
const KEY_FILE = path.join(DATA_DIR, 'chat.key')

const DEFAULTS = {
  /** provider 预设 id */
  provider: 'deepseek',
  /** 空 = 用预设的 baseUrl;custom 时用户自己填 */
  baseUrl: '',
  model: '',
  temperature: 0.7,
  maxTokens: 2048,
  /** 快速模式(本地处理明确指令);关掉则一律走模型 */
  fastMode: true,
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n')
}

export function getSettings() {
  const raw = readJson(SETTINGS_FILE)
  const s = { ...DEFAULTS, ...raw }
  s.provider = getProvider(s.provider) ? s.provider : DEFAULTS.provider
  if (!s.baseUrl) s.baseUrl = defaultBaseUrl(s.provider)
  s.fastMode = s.fastMode !== false
  return s
}

export function saveSettings(patch = {}) {
  const cur = getSettings()
  const next = { ...cur, ...patch }
  next.provider = getProvider(next.provider) ? next.provider : DEFAULTS.provider
  // 未显式给 baseUrl(或给空)→ 跟随预设
  if (patch.baseUrl === undefined || patch.baseUrl === '') {
    next.baseUrl = defaultBaseUrl(next.provider)
  }
  writeJson(SETTINGS_FILE, next)
  return next
}

/* ---------- 密钥 ---------- */

export function getApiKey() {
  const env = process.env.OPENTODO_CHAT_KEY
  if (env && env.trim()) return env.trim()
  try {
    return fs.readFileSync(KEY_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}

export function setApiKey(key) {
  const k = String(key ?? '').trim()
  if (!k) {
    try {
      fs.unlinkSync(KEY_FILE)
    } catch {
      /* ignore */
    }
    return
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(KEY_FILE, k + '\n', { mode: 0o600 })
}

export function maskKey(key) {
  const k = String(key ?? '')
  if (!k) return ''
  return k.length <= 8 ? '••••' : `••••${k.slice(-4)}`
}

/** 给设置面板的状态:配置(掩码)+ 预设列表 + 是否站长 */
export function chatState(owner = false) {
  const s = getSettings()
  const key = getApiKey()
  return {
    owner: !!owner,
    config: {
      ...s,
      hasKey: !!key,
      apiKey: maskKey(key),
      envKey: !!process.env.OPENTODO_CHAT_KEY,
    },
    providers: PROVIDERS,
  }
}

/* ---------- 拉模型列表 ---------- */

function extractOpenAiIds(j) {
  if (!j || typeof j !== 'object') return []
  const arr = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : []
  return arr
    .map((m) => (typeof m === 'string' ? m : m?.id ?? m?.name ?? ''))
    .filter((x) => typeof x === 'string' && x)
    .sort((a, b) => a.localeCompare(b))
}

/** openai 兼容 → GET {base}/models(Bearer);ollama → GET {base}/api/tags */
export async function listModels({ provider, baseUrl } = {}) {
  const s = getSettings()
  const pid = provider || s.provider
  const proto = protocolOf(pid)
  const url = ensureUrl(baseUrl || (pid === s.provider ? s.baseUrl : defaultBaseUrl(pid)))
  if (!/^https?:\/\//.test(url)) throw new Error('未配置 baseUrl')
  const key = getApiKey()

  if (proto === 'ollama') {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw new Error(`拉取失败 ${res.status}`)
    const j = await res.json()
    const models = (j.models ?? []).map((m) => m.name).filter(Boolean)
    return { models: [...new Set(models)].sort(), provider: pid, baseUrl: url, protocol: proto }
  }

  const res = await fetch(`${url}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`拉取失败 ${res.status}`)
  const models = extractOpenAiIds(await res.json())
  return { models, provider: pid, baseUrl: url, protocol: proto }
}
