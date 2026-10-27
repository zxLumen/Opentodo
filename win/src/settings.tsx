import { useEffect, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './settings.css'

interface Provider {
  id: string
  name: string
}

interface ChatState {
  config: {
    provider: string
    model: string
    effort: string
    fastMode: boolean
    temperature: number
    maxTokens: number
  }
  providers: Provider[]
}

interface SyncStatus {
  phase: string
  configured: boolean
  lastSyncAt: string | null
  lastError: string | null
  serverURL: string
  deviceId: string
}

interface Pub {
  model: string
  variant: string
  fastMode: boolean
  temperature: number
  maxTokens: number
  port: number
  opencodeBin: string
  timeoutSeconds: number
  ballStyle: string
  ballDiameter: number
  launchAtLogin: boolean
  hotkey: string
  syncURL: string
  syncDeviceId: string
  pinned: boolean
  hasKeys?: string[]
  hasSyncToken?: boolean
  version?: string
  registeredHotkey?: string
  dataFile?: string
  configDir?: string
  appDataDir?: string
}

const BALL_STYLES = [
  ['gradientA', '渐变蓝'],
  ['glassB', '玻璃'],
  ['ringC', '光环'],
  ['darkD', '暗黑'],
  ['minimalE', '极简白'],
  ['rainbowF', '彩虹'],
]

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="section">
      <h2>{title}</h2>
      {children}
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="row">
      <span className="row-label">
        {label}
        {hint && <em>{hint}</em>}
      </span>
      <span className="row-control">{children}</span>
    </label>
  )
}

function App() {
  const [pub, setPub] = useState<Pub | null>(null)
  const [chatState, setChatState] = useState<ChatState | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [efforts, setEfforts] = useState<Record<string, string[]>>({})
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [ownerToken, setOwnerToken] = useState('')
  const [keyInput, setKeyInput] = useState('')
  const [keyProvider, setKeyProvider] = useState('')
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try {
      const [settings, chat, status] = await Promise.all([
        window.opentodo.settings.get() as unknown as Promise<Pub>,
        window.opentodo.chat.state() as unknown as Promise<ChatState>,
        window.opentodo.sync.status() as unknown as Promise<SyncStatus>,
      ])
      setPub(settings)
      setChatState(chat)
      setSyncStatus(status)
      setKeyProvider((p) => p || chat.config.provider)
      try {
        const m = (await window.opentodo.chat.models(chat.config.provider)) as {
          models: string[]
          efforts: Record<string, string[]>
        }
        setModels(m.models)
        setEfforts(m.efforts)
      } catch (err) {
        setModels([])
        setEfforts({})
        setMsg({
          text: `opencode 未就绪：${err instanceof Error ? err.message : String(err)}`,
          error: true,
        })
      }
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : String(err), error: true })
    }
  }

  useEffect(() => {
    void load()
    const offSettings = window.opentodo.settings.onChanged((value) =>
      setPub((p) => ({ ...(p ?? ({} as Pub)), ...(value as Pub) })),
    )
    const offSync = window.opentodo.sync.onStatus((value) => setSyncStatus(value as SyncStatus))
    return () => {
      offSettings()
      offSync()
    }
  }, [])

  const notify = (text: string, error = false) => {
    setMsg({ text, error })
    window.setTimeout(() => setMsg(null), 2600)
  }

  const saveSettings = async (patch: Record<string, unknown>) => {
    const next = (await window.opentodo.settings.set(patch)) as unknown as Pub
    setPub((p) => ({ ...(p ?? ({} as Pub)), ...next }))
  }

  const changeProvider = async (provider: string) => {
    if (!chatState) return
    setKeyProvider(provider)
    const m = (await window.opentodo.chat.models(provider)) as {
      models: string[]
      efforts: Record<string, string[]>
    }
    if (!m.models.length) {
      setMsg({ text: '该服务商没有可用模型', error: true })
      return
    }
    setModels(m.models)
    setEfforts(m.efforts)
    const model = m.models[0] || chatState.config.model
    const next = (await window.opentodo.chat.config({
      provider,
      model,
      effort: '',
      fastMode: chatState.config.fastMode,
    })) as ChatState
    setChatState(next)
    notify('已切换服务商')
  }

  const changeModel = async (model: string) => {
    if (!chatState) return
    const next = (await window.opentodo.chat.config({
      provider: chatState.config.provider,
      model,
      effort: '',
      fastMode: chatState.config.fastMode,
    })) as ChatState
    setChatState(next)
    const e = (await window.opentodo.chat.models(chatState.config.provider)) as {
      models: string[]
      efforts: Record<string, string[]>
    }
    setEfforts(e.efforts)
    notify('已切换模型')
  }

  const saveKey = async () => {
    if (!keyProvider) return
    setBusy(true)
    try {
      const next = (await window.opentodo.chat.key(keyProvider, keyInput.trim())) as ChatState
      setChatState(next)
      setKeyInput('')
      const s = (await window.opentodo.settings.get()) as unknown as Pub
      setPub(s)
      notify('密钥已保存（DPAPI 加密）')
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true)
    } finally {
      setBusy(false)
    }
  }

  const pair = async () => {
    if (!pub) return
    setBusy(true)
    try {
      const res = await window.opentodo.sync.pair(pub.syncURL, ownerToken)
      setSyncStatus(res.status as unknown as SyncStatus)
      if (res.error) notify(res.error, true)
      else {
        setOwnerToken('')
        const s = (await window.opentodo.settings.get()) as unknown as Pub
        setPub(s)
        notify('配对成功')
      }
    } finally {
      setBusy(false)
    }
  }

  if (!pub || !chatState) {
    return <div className="loading">加载中…</div>
  }

  const effortOptions = efforts[chatState.config.model.toLowerCase()] ?? []
  const configured = new Set(pub.hasKeys ?? [])

  return (
    <div className="page">
      <header className="head">
        <div>
          <h1>Opentodo 设置</h1>
          <p>Windows 版 · v{pub.version}</p>
        </div>
        <button className="ghost" onClick={() => void load()}>
          刷新
        </button>
      </header>

      {msg && <div className={`toast${msg.error ? ' error' : ''}`}>{msg.text}</div>}

      <Section title="对话模型">
        <Row label="服务商" hint="来自 opencode 的 provider 目录">
          <select value={chatState.config.provider} onChange={(e) => void changeProvider(e.target.value)}>
            {chatState.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Row>
        <Row label="模型">
          <select value={chatState.config.model} onChange={(e) => void changeModel(e.target.value)}>
            {(models.length ? models : [chatState.config.model]).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Row>
        <Row label="思考强度" hint="取决于模型，留空为默认">
          <select
            value={chatState.config.effort}
            onChange={(e) =>
              void window.opentodo.chat
                .config({
                  provider: chatState.config.provider,
                  model: chatState.config.model,
                  effort: e.target.value,
                  fastMode: chatState.config.fastMode,
                })
                .then((s) => setChatState(s as ChatState))
            }
          >
            <option value="">默认</option>
            {effortOptions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Row>
        <Row label="快速模式" hint="明确的「加一条/完成/删除/列出」本地处理，不调模型">
          <input
            type="checkbox"
            checked={chatState.config.fastMode}
            onChange={(e) =>
              void window.opentodo.chat
                .config({
                  provider: chatState.config.provider,
                  model: chatState.config.model,
                  effort: chatState.config.effort,
                  fastMode: e.target.checked,
                })
                .then((s) => setChatState(s as ChatState))
            }
          />
        </Row>
      </Section>

      <Section title="服务商密钥（可选）">
        <p className="note">
          密钥只写入本应用的隔离位置配置，用 Windows DPAPI 加密保存。opencode 已全局配置过的服务商可以留空。
        </p>
        <Row label="服务商">
          <select value={keyProvider} onChange={(e) => setKeyProvider(e.target.value)}>
            {chatState.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {configured.has(p.id) ? ' ✓' : ''}
              </option>
            ))}
          </select>
        </Row>
        <Row label="API Key">
          <input
            type="password"
            value={keyInput}
            placeholder={configured.has(keyProvider) ? '已保存，留空不修改' : 'sk-…'}
            onChange={(e) => setKeyInput(e.target.value)}
          />
        </Row>
        <div className="actions">
          <button className="primary" disabled={busy} onClick={() => void saveKey()}>
            保存密钥
          </button>
        </div>
      </Section>

      <Section title="opencode">
        <Row label="可执行文件" hint="留空自动查找">
          <input
            value={pub.opencodeBin}
            placeholder="C:\Users\...\opencode.exe"
            onChange={(e) => setPub({ ...pub, opencodeBin: e.target.value })}
            onBlur={() => void saveSettings({ opencodeBin: pub.opencodeBin })}
          />
        </Row>
        <Row label="端口">
          <input
            type="number"
            value={pub.port}
            onChange={(e) => setPub({ ...pub, port: Number(e.target.value) || 4096 })}
            onBlur={() => void saveSettings({ port: pub.port })}
          />
        </Row>
        <Row label="超时（秒）">
          <input
            type="number"
            value={pub.timeoutSeconds}
            onChange={(e) => setPub({ ...pub, timeoutSeconds: Number(e.target.value) || 120 })}
            onBlur={() => void saveSettings({ timeoutSeconds: pub.timeoutSeconds })}
          />
        </Row>
        <div className="actions">
          <button className="ghost" onClick={() => void window.opentodo.shell.openConfigDir()}>
            打开配置目录
          </button>
        </div>
      </Section>

      <Section title="悬浮球">
        <Row label="样式">
          <select
            value={pub.ballStyle}
            onChange={(e) => {
              setPub({ ...pub, ballStyle: e.target.value })
              void saveSettings({ ballStyle: e.target.value })
            }}
          >
            {BALL_STYLES.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </Row>
        <Row label="直径" hint={`${pub.ballDiameter}px`}>
          <input
            type="range"
            min={48}
            max={80}
            step={2}
            value={pub.ballDiameter}
            onChange={(e) => setPub({ ...pub, ballDiameter: Number(e.target.value) })}
            onMouseUp={() => void saveSettings({ ballDiameter: pub.ballDiameter })}
          />
        </Row>
        <Row label="全局快捷键" hint={pub.registeredHotkey ? `已注册：${pub.registeredHotkey}` : '未注册'}>
          <input
            value={pub.hotkey}
            onChange={(e) => setPub({ ...pub, hotkey: e.target.value })}
            onBlur={() => void saveSettings({ hotkey: pub.hotkey })}
          />
        </Row>
        <Row label="固定面板" hint="关闭后点击面板外部会自动收起">
          <input
            type="checkbox"
            checked={pub.pinned}
            onChange={(e) => {
              setPub({ ...pub, pinned: e.target.checked })
              void saveSettings({ pinned: e.target.checked })
            }}
          />
        </Row>
      </Section>

      <Section title="多端同步">
        <Row label="服务器地址" hint="例如 https://todo.example.com">
          <input
            value={pub.syncURL}
            placeholder="https://…"
            onChange={(e) => setPub({ ...pub, syncURL: e.target.value })}
            onBlur={() => void saveSettings({ syncURL: pub.syncURL })}
          />
        </Row>
        <Row label="站长口令" hint="首次配对用，配对后保存设备令牌">
          <input
            type="password"
            value={ownerToken}
            placeholder={pub.hasSyncToken ? '已配对，留空不修改' : ''}
            onChange={(e) => setOwnerToken(e.target.value)}
          />
        </Row>
        <div className="actions">
          <button className="primary" disabled={busy || !ownerToken.trim()} onClick={() => void pair()}>
            配对并同步
          </button>
          <button className="ghost" onClick={() => void window.opentodo.sync.now().then((s) => setSyncStatus(s as unknown as SyncStatus))}>
            立即同步
          </button>
          <button
            className="ghost danger"
            onClick={() =>
              void window.opentodo.sync.disconnect().then((s) => setSyncStatus(s as unknown as SyncStatus))
            }
          >
            断开
          </button>
        </div>
        <div className={`status phase-${syncStatus?.phase ?? 'disabled'}`}>
          状态：{syncStatus?.phase ?? 'disabled'}
          {syncStatus?.deviceId ? ` · 设备 ${syncStatus.deviceId.slice(0, 8)}` : ''}
          {syncStatus?.lastSyncAt ? ` · 上次 ${new Date(syncStatus.lastSyncAt).toLocaleString()}` : ''}
          {syncStatus?.lastError ? ` · ${syncStatus.lastError}` : ''}
        </div>
      </Section>

      <Section title="系统">
        <Row label="开机自启">
          <input
            type="checkbox"
            checked={pub.launchAtLogin}
            onChange={(e) => {
              setPub({ ...pub, launchAtLogin: e.target.checked })
              void saveSettings({ launchAtLogin: e.target.checked })
            }}
          />
        </Row>
        <Row label="数据文件">
          <code>{pub.dataFile}</code>
        </Row>
        <div className="actions">
          <button className="ghost" onClick={() => void window.opentodo.shell.openDataDir()}>
            打开数据目录
          </button>
          <button className="ghost danger" onClick={() => void window.opentodo.window.quit()}>
            退出 Opentodo
          </button>
        </div>
      </Section>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
