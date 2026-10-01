// 「按模型可选的思考强度」查表。
//
// web 直连各家 OpenAI 兼容接口,拿不到「这个模型支持哪些思考强度」的元数据 ——
// 该信息在 models.dev 目录里(opencode 缓存于 ~/.cache/opencode/models.json),
// 由 web/scripts/gen-effort-slice.mjs 离线生成为 web/effort-options.json(入库)。
// 这里只做查表:命中才显示下拉、才在请求里下发;查不到一律不下发,避免给不支持的
// provider 塞字段导致 400。
//
// 切片结构:{ byProvider:{"<providerKey>/<model>":["low","high"]}, byModel:{"<model>":[...]} }
// providerKey 是 models.dev 的名字,web 预设 id 通过 PROVIDER_ALIASES 映射过去。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SLICE_FILE = path.join(HERE, 'effort-options.json')

/** web 预设 id(providers.js) → models.dev provider key(可多个,按顺序查) */
export const PROVIDER_ALIASES = {
  'opencode-z': ['opencode-go'],
  openai: ['openai'],
  deepseek: ['deepseek'],
  zhipuai: ['zhipuai', 'zai'],
  moonshot: ['moonshotai', 'moonshotai-cn'],
  siliconflow: ['siliconflow', 'siliconflow-cn'],
  openrouter: ['openrouter'],
}

/** 下发给 OpenAI 兼容接口的字段名(目前只支持 effort 型) */
export const EFFORT_FIELD = 'reasoning_effort'

let cached = null
function slice() {
  if (cached) return cached
  try {
    cached = JSON.parse(fs.readFileSync(SLICE_FILE, 'utf8'))
  } catch {
    cached = { byProvider: {}, byModel: {} }
  }
  cached.byProvider ||= {}
  cached.byModel ||= {}
  return cached
}

/** 该 (provider, model) 支持的思考强度档位;查不到返回 [] */
export function effortValues(provider, model) {
  const m = String(model ?? '')
    .trim()
    .toLowerCase()
  if (!m) return []
  const s = slice()
  for (const key of PROVIDER_ALIASES[provider] ?? []) {
    const v = s.byProvider[`${key}/${m}`]
    if (v) return v
  }
  // provider 无关兜底(自定义 baseUrl / 无别名的 provider):按模型名
  return s.byModel[m] ?? s.byModel[m.split('/').pop()] ?? []
}

/** 某 provider 下「模型 → 档位」映射(前端切模型时即时更新下拉用) */
export function effortMapFor(provider) {
  const s = slice()
  const out = {}
  for (const key of PROVIDER_ALIASES[provider] ?? []) {
    const prefix = `${key}/`
    for (const [k, v] of Object.entries(s.byProvider)) {
      if (!k.startsWith(prefix)) continue
      const mid = k.slice(prefix.length)
      if (!out[mid]) out[mid] = v
    }
  }
  return out
}
