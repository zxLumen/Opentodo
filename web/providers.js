// 模型 provider 预设 —— 融合两处现成清单:
//  · 博客(zxLumen-Blog/src/lib/chat/providers.ts):id / baseUrl / 两种协议(openai / ollama)
//  · 桌面 App(opencode 目录):模型用 `provider/model` 命名
//
// 直连方式:OpenAI 兼容走 `${baseUrl}/chat/completions` 与 `${baseUrl}/models`;
// ollama 走 `${baseUrl}/api/chat` 与 `${baseUrl}/api/tags`。

export const PROVIDERS = [
  { id: 'ollama', name: '本地 Ollama', protocol: 'ollama', baseUrl: 'http://localhost:11434' },
  { id: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'zhipuai', name: '智谱 GLM', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  {
    id: 'dashscope',
    name: '通义千问(百炼)',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  { id: 'moonshot', name: 'Moonshot / Kimi', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1' },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
  },
  { id: 'openrouter', name: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'opencode-z', name: 'OpenCode Go', protocol: 'openai', baseUrl: 'https://opencode.ai/zen/go/v1' },
  { id: 'custom', name: '自定义(OpenAI 兼容)', protocol: 'openai', baseUrl: '' },
]

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]))

export function getProvider(id) {
  return BY_ID.get(id)
}

export function protocolOf(id) {
  return getProvider(id)?.protocol ?? 'openai'
}

/** 预设的默认 baseUrl(custom 为空,由用户填) */
export function defaultBaseUrl(id) {
  const p = getProvider(id)
  if (!p || p.id === 'custom') return ''
  return p.baseUrl
}

/** 去掉末尾斜杠,方便拼 `/models` `/chat/completions` */
export function ensureUrl(base) {
  return String(base ?? '')
    .trim()
    .replace(/\/+$/, '')
}

/** OpenCode Go 需要额外的 `x-opencode-*` 头(与博客 llm.ts 的特判一致) */
export function isOpenCodeGo(provider, baseUrl) {
  return provider === 'opencode-z' || /opencode\.ai\/zen\/go/.test(baseUrl ?? '')
}
