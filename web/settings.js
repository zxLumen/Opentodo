// 聊天/模型配置与密钥的存取。
//   配置 → web/data/settings.json(非密钥,可入库前忽略)
//   密钥 → web/data/chat.key(chmod 600);env OPENTODO_CHAT_KEY 优先(适合容器/CI)
// 两者都在 .gitignore 里(见仓库根 web/data)。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultBaseUrl, ensureUrl, getProvider, protocolOf, PROVIDERS } from './providers.js'
import { effortMapFor, effortValues } from './effort.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 与 server.js 保持一致:容器里用 OPENTODO_DATA_DIR 指到挂载卷,否则默认 ./data。
// (否则设了 OPENTODO_DATA_DIR 时,配置/密钥会写进可写层而非卷,重建即丢。)
const DATA_DIR = process.env.OPENTODO_DATA_DIR || path.join(HERE, 'data')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
const KEY_FILE = path.join(DATA_DIR, 'chat.key')

const DEFAULTS = {
  /** provider 预设 id */
  provider: 'zx-gateway',
  /** 空 = 用预设的 baseUrl;custom 时用户自己填 */
  baseUrl: '',
  model: '',
  temperature: 0.7,
  maxTokens: 2048,
  /** 快速模式(本地处理明确指令);关掉则一律走模型 */
  fastMode: true,
  /** 思考强度(如 low/medium/high);'' = 默认,不下发。可选值取决于所选模型 */
  effort: '',
  /** 逃生口:目录里没有的模型,可用 "<provider>/<model>": ["low","high"] 手动补 */
  effortOverrides: {},
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

/** 某 provider+model 允许的思考强度档位(优先看 settings 里的 effortOverrides) */
export function allowedEfforts(s, model = s.model) {
  const key = `${s.provider}/${String(model ?? '')
    .trim()
    .toLowerCase()}`
  const ov = s.effortOverrides?.[key]
  if (Array.isArray(ov) && ov.length) return ov.map(String)
  return effortValues(s.provider, model)
}

/** 归一化 effort:非字符串→'';不被当前模型支持→'' */
function normalizeEffort(s) {
  const v = typeof s.effort === 'string' ? s.effort.trim() : ''
  return v && allowedEfforts(s).includes(v) ? v : ''
}

export function getSettings() {
  const raw = readJson(SETTINGS_FILE)
  const s = { ...DEFAULTS, ...raw }
  s.provider = getProvider(s.provider) ? s.provider : DEFAULTS.provider
  if (s.provider === 'zx-gateway' || !s.baseUrl) s.baseUrl = defaultBaseUrl(s.provider)
  s.fastMode = s.fastMode !== false
  if (!s.effortOverrides || typeof s.effortOverrides !== 'object') s.effortOverrides = {}
  s.effort = normalizeEffort(s)
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
  // 校验 effort:非法/换模型后已不适配的值一律清空
  next.effort = normalizeEffort(next)
  writeJson(SETTINGS_FILE, next)
  return next
}

/* ---------- 密钥 ---------- */

export function getApiKey() {
  const env = process.env.OPENTODO_CHAT_KEY
  if (env && env.trim()) return env.trim()
  let stored = ''
  try {
    stored = fs.readFileSync(KEY_FILE, 'utf8').trim()
  } catch {
    stored = ''
  }
  if (stored) return stored
  return (process.env.ZX_AI_APP_TOKEN || '').trim()
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
export function chatState(owner = false, visitorAi = false) {
  const s = getSettings()
  const key = getApiKey()
  return {
    owner: !!owner,
    visitorAi: !!visitorAi,
    config: {
      ...s,
      hasKey: !!key,
      apiKey: maskKey(key),
      envKey: !!process.env.OPENTODO_CHAT_KEY,
      /** 当前模型可选的思考强度档位(空 = 不支持,前端隐藏下拉) */
      effortValues: allowedEfforts(s),
    },
    /** 当前 provider 下「模型 → 档位」,供切模型时即时刷新下拉 */
    efforts: effortMapFor(s.provider),
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
    return {
      models: [...new Set(models)].sort(),
      efforts: {},
      provider: pid,
      baseUrl: url,
      protocol: proto,
    }
  }

  const res = await fetch(`${url}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`拉取失败 ${res.status}`)
  const models = extractOpenAiIds(await res.json())
  return { models, efforts: effortMapFor(pid), provider: pid, baseUrl: url, protocol: proto }
}
