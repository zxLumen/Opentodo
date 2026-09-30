// 聊天设置浮层:选 provider / baseUrl / 拉取并选模型 / 温度 / 快速模式 / API Key。

import { useState } from 'react'

export interface ChatConfig {
  provider: string
  baseUrl: string
  model: string
  temperature: number
  maxTokens: number
  fastMode: boolean
  hasKey: boolean
  apiKey: string
  envKey?: boolean
}
export interface ProviderPreset {
  id: string
  name: string
  protocol: 'openai' | 'ollama'
  baseUrl: string
}
export interface ChatState {
  owner: boolean
  visitorAi: boolean
  config: ChatConfig
  providers: ProviderPreset[]
}

export function SettingsPanel({
  initial,
  onClose,
  onChanged,
}: {
  initial: ChatState | null
  onClose: () => void
  onChanged: (s: ChatState) => void
}) {
  const [provider, setProvider] = useState(initial?.config.provider ?? 'deepseek')
  const [baseUrl, setBaseUrl] = useState(initial?.config.baseUrl ?? '')
  const [model, setModel] = useState(initial?.config.model ?? '')
  const [temperature, setTemperature] = useState(initial?.config.temperature ?? 0.7)
  const [maxTokens, setMaxTokens] = useState(initial?.config.maxTokens ?? 2048)
  const [fastMode, setFastMode] = useState(initial?.config.fastMode ?? true)
  const [keyInput, setKeyInput] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const providers = initial?.providers ?? []
  const savedKey = initial?.config.apiKey ?? ''
  const hasKey = initial?.config.hasKey
  const envKey = initial?.config.envKey

  const pickProvider = (id: string) => {
    setProvider(id)
    const p = providers.find((x) => x.id === id)
    setBaseUrl(id === 'custom' ? '' : p?.baseUrl ?? '')
  }

  const saveAll = async (extra: Record<string, unknown> = {}) => {
    setBusy(true)
    setMsg(null)
    try {
      if (keyInput.trim()) {
        const r = await fetch('/api/chat/key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: keyInput.trim() }),
        })
        if (!r.ok) throw new Error('保存密钥失败')
        setKeyInput('')
      }
      const res = await fetch('/api/chat/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, baseUrl, model, temperature, maxTokens, fastMode, ...extra }),
      })
      const s = (await res.json()) as ChatState
      onChanged(s)
      setMsg('已保存')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const fetchModels = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch('/api/chat/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, baseUrl }),
      })
      const j = (await res.json()) as { models?: string[]; error?: string }
      if (!res.ok) throw new Error(j.error || '拉取失败')
      setModels(j.models ?? [])
      setMsg(`拉到 ${j.models?.length ?? 0} 个模型`)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-mask" onClick={onClose}>
      <div className="settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <strong>聊天设置</strong>
          <button type="button" className="x" onClick={onClose} title="关闭">
            ✕
          </button>
        </div>

        <label className="field">
          <span>供应商</span>
          <select value={provider} onChange={(e) => pickProvider(e.target.value)}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Base URL</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" />
        </label>

        <label className="field">
          <span>模型</span>
          <div className="row-inline">
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="如 deepseek-chat" list="zx-models" />
            <button type="button" className="mini" disabled={busy} onClick={fetchModels}>
              {busy ? '…' : '拉取模型'}
            </button>
          </div>
          <datalist id="zx-models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>

        <label className="field">
          <span>API Key</span>
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder={envKey ? '由环境变量提供' : hasKey ? `已保存 ${savedKey}(留空不改)` : '粘贴密钥'}
            autoComplete="off"
          />
        </label>

        <div className="field row-inline">
          <label className="check">
            <input type="checkbox" checked={fastMode} onChange={(e) => setFastMode(e.target.checked)} />
            <span>快速模式(明确指令本地处理,不调模型)</span>
          </label>
        </div>

        <div className="row-inline">
          <label className="field half">
            <span>温度</span>
            <input
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
            />
          </label>
          <label className="field half">
            <span>maxTokens</span>
            <input
              type="number"
              min="256"
              step="256"
              value={maxTokens}
              onChange={(e) => setMaxTokens(Number(e.target.value))}
            />
          </label>
        </div>

        <div className="settings-foot">
          <span className="msg">{msg}</span>
          <button type="button" className="primary" disabled={busy} onClick={() => void saveAll()}>
            保存
          </button>
        </div>
        <div className="settings-hint">
          直连各家的 OpenAI 兼容接口。密钥存服务器 `web/data/chat.key`(env `OPENTODO_CHAT_KEY` 优先)。
        </div>
      </div>
    </div>
  )
}
