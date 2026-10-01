// 生成「按模型可选的思考强度」切片:`web/effort-options.json`。
//
// 数据源:models.dev 目录(opencode 会缓存到 ~/.cache/opencode/models.json)。
// 每个模型带 `reasoning_options`:
//   [{ "type":"effort","values":["low","medium","high"] }]  → 可选档位
//   [{ "type":"toggle" }]                                    → 只有开/关(本切片暂不含)
// web 直连各家 OpenAI 兼容接口,拿不到这种能力元数据,所以离线生成一份切片入库,
// runtime 只查表(见 web/effort.js),查不到就不显示、不下发。
//
// 用法:
//   node web/scripts/gen-effort-slice.mjs                 # 读本机 opencode 缓存
//   node web/scripts/gen-effort-slice.mjs --from-url https://models.dev/api.json
//   node web/scripts/gen-effort-slice.mjs --from /path/to/models.json --out web/effort-options.json

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 只收录与 web 预设(web/providers.js)相关的 provider;按优先级排列(同名模型先到先得)
const PRIORITY = [
  'opencode-go',
  'opencode',
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'zhipuai',
  'zai',
  'moonshotai',
  'moonshotai-cn',
  'siliconflow',
  'siliconflow-cn',
  'openrouter',
]
const INCLUDE = new Set(PRIORITY)

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--from-url') out.fromUrl = argv[++i]
    else if (a === '--from') out.from = argv[++i]
    else if (a === '--out') out.out = argv[++i]
  }
  return out
}

/** 取模型的 effort 档位(忽略 toggle/budget_tokens);没有就返回 null */
function effortValues(model) {
  const opts = model?.reasoning_options
  if (!Array.isArray(opts)) return null
  const eff = opts.find((o) => o && o.type === 'effort' && Array.isArray(o.values) && o.values.length)
  return eff ? eff.values.map(String) : null
}

async function loadCatalog({ fromUrl, from }) {
  if (fromUrl) {
    const res = await fetch(fromUrl, { signal: AbortSignal.timeout(30000) })
    if (!res.ok) throw new Error(`拉取目录失败 HTTP ${res.status}`)
    return { catalog: await res.json(), source: fromUrl }
  }
  const file =
    from || path.join(os.homedir(), '.cache', 'opencode', 'models.json')
  return { catalog: JSON.parse(fs.readFileSync(file, 'utf8')), source: file }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const repoWeb = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const outFile = path.resolve(args.out || path.join(repoWeb, 'effort-options.json'))

  const { catalog, source } = await loadCatalog(args)

  const byProvider = {}
  // 按优先级遍历,保证 byModel 先到先得
  for (const pk of PRIORITY) {
    const prov = catalog[pk]
    if (!prov || !prov.models) continue
    for (const [mid, m] of Object.entries(prov.models)) {
      const values = effortValues(m)
      if (!values) continue
      byProvider[`${pk}/${mid}`.toLowerCase()] = values
    }
  }

  const byModel = {}
  for (const pk of PRIORITY) {
    const prov = catalog[pk]
    if (!prov || !prov.models) continue
    for (const [mid, m] of Object.entries(prov.models)) {
      const values = effortValues(m)
      if (!values) continue
      const bare = mid.toLowerCase()
      const last = bare.split('/').pop()
      if (!byModel[bare]) byModel[bare] = values
      if (last && !byModel[last]) byModel[last] = values
    }
  }

  const sortObj = (o) =>
    Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]))
  const out = {
    _meta: {
      source,
      generatedAt: new Date().toISOString(),
      note: 'models.dev reasoning_options(type=effort)。toggle/budget_tokens 未收录。重新生成见 web/scripts/gen-effort-slice.mjs',
    },
    byProvider: sortObj(byProvider),
    byModel: sortObj(byModel),
  }

  fs.writeFileSync(outFile, JSON.stringify(out) + '\n')
  console.log(
    `wrote ${path.relative(process.cwd(), outFile)}: ${Object.keys(byProvider).length} provider models, ${Object.keys(byModel).length} bare ids`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
