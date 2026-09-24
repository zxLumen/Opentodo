import SwiftUI
import ServiceManagement
import Security

/// 服务商独立密钥的钥匙串存取（服务/账户模式，value 为 {key, baseURL} JSON）。
enum KeychainStore {
    struct Credential: Equatable {
        var key: String
        var baseURL: String
    }

    private static let service = "com.opentodo.provider-credential"

    static func load(providerID: String) -> Credential? {
        var query = baseQuery(providerID)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return Credential(
            key: obj["key"] as? String ?? "",
            baseURL: obj["baseURL"] as? String ?? ""
        )
    }

    /// 一次查询取回全部服务商凭据（单次授权），避免打开设置时逐条触发弹窗。
    static func loadAll() -> [String: Credential] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnData as String: true,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let items = result as? [[String: Any]] else { return [:] }
        var out: [String: Credential] = [:]
        for it in items {
            guard let account = it[kSecAttrAccount as String] as? String,
                  let data = it[kSecValueData as String] as? Data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                continue
            }
            out[account] = Credential(
                key: obj["key"] as? String ?? "",
                baseURL: obj["baseURL"] as? String ?? ""
            )
        }
        return out
    }

    static func save(providerID: String, credential: Credential) {
        guard !credential.key.isEmpty || !credential.baseURL.isEmpty else {
            delete(providerID: providerID)
            return
        }
        let payload = (try? JSONSerialization.data(
            withJSONObject: ["key": credential.key, "baseURL": credential.baseURL],
            options: [.sortedKeys]
        )) ?? Data()
        if load(providerID: providerID) != nil {
            SecItemUpdate(baseQuery(providerID) as CFDictionary,
                          [kSecValueData as String: payload] as CFDictionary)
        } else {
            var query = baseQuery(providerID)
            query[kSecValueData as String] = payload
            query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(query as CFDictionary, nil)
        }
    }

    static func delete(providerID: String) {
        SecItemDelete(baseQuery(providerID) as CFDictionary)
    }

    /// 生成 serve 用的 provider 覆写配置 JSON（只含非空字段，字面量写入避免 {env:} 内插问题）。
    static func buildOverlayData(credentials: [String: Credential]) -> Data {
        var providers: [String: Any] = [:]
        for (pid, cred) in credentials.sorted(by: { $0.key < $1.key }) {
            var opt: [String: String] = [:]
            if !cred.key.isEmpty { opt["apiKey"] = cred.key }
            if !cred.baseURL.isEmpty { opt["baseURL"] = cred.baseURL }
            if !opt.isEmpty { providers[pid] = ["options": opt] }
        }
        // The `opentodo` agent lives ONLY in this overlay (injected via
        // OPENCODE_CONFIG into the app's own `opencode serve`), so it never
        // shows up as a switchable mode in the user's normal opencode sessions.
        // Its tools come from the app-provisioned plugin (see ChatBackend).
        let agent: [String: Any] = [
            "opentodo": [
                "description": "Manage the user's personal Opentodo backlog only.",
                "mode": "primary",
                "temperature": 0.1,
                "steps": 4,
                "prompt":
                    "你是 Opentodo 待办助手。你只管理用户的个人待办，只能使用 opentodo_* 工具"
                    + "（opentodo_list / opentodo_add / opentodo_update / opentodo_restore / opentodo_remove / "
                    + "opentodo_clear / opentodo_create_project / opentodo_rename_project / opentodo_remove_project）。"
                    + "禁止执行 shell、读写文件、联网、提问。请求含糊时就做最合理的改动并简短说明。"
                    + "不要长篇推理，直接动手。用用户的语言回复，1-2 句即可，不要复述整个列表。",
                "permission": ["*": "deny", "opentodo_*": "allow"],
            ],
        ]
        let obj: [String: Any] = [
            "$schema": "https://opencode.ai/config.json",
            "provider": providers,
            "agent": agent,
        ]
        return (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .prettyPrinted])) ?? Data()
    }

    private static func baseQuery(_ providerID: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: providerID,
        ]
    }
}

/// 把手动输入解析为完整的 "provider/model" ID。
enum ModelID {
    static func resolve(_ raw: String, provider: String?) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        if trimmed.contains("/") { return trimmed }
        if let provider, !provider.isEmpty { return "\(provider)/\(trimmed)" }
        return trimmed
    }
}

struct ModelOption: Identifiable, Hashable {
    var id: String { "\(provider)/\(model)" }
    let provider: String
    let model: String
    let name: String
    let family: String
    let variants: [String]
    let inputCost: Double?
    let outputCost: Double?
}

struct ProviderInfo: Identifiable, Hashable {
    let id: String
    let displayName: String
    let source: String // "api" | "config" | ...
    let connected: Bool
    let models: [ModelOption]
}

@MainActor
final class AppSettings: ObservableObject {
    static let shared = AppSettings()
    private let d = UserDefaults.standard

    private enum Keys {
        static let model = "opentodo.model"
        static let variant = "opentodo.variant"
        static let lastModelByProvider = "opentodo.lastModelByProvider"
        static let fastMode = "opentodo.fastMode"
        static let port = "opentodo.port"
        static let bin = "opentodo.bin"
        static let timeout = "opentodo.timeout"
        static let ballStyle = "opentodo.ballStyle"
        static let ballDiameter = "opentodo.ballDiameter"
        static let launchAtLogin = "opentodo.launchAtLogin"
        static let credentialProviders = "opentodo.credentialProviders"
    }

    @Published var model: String { didSet { d.set(model, forKey: Keys.model) } }
    @Published var variant: String { didSet { d.set(variant, forKey: Keys.variant) } }
    @Published var fastMode: Bool { didSet { d.set(fastMode, forKey: Keys.fastMode) } }
    @Published var port: Int { didSet { d.set(port, forKey: Keys.port) } }
    @Published var opencodeBin: String { didSet { d.set(opencodeBin, forKey: Keys.bin) } }
    @Published var timeoutSeconds: Int { didSet { d.set(timeoutSeconds, forKey: Keys.timeout) } }
    @Published var ballStyle: BallStyle { didSet { d.set(ballStyle.rawValue, forKey: Keys.ballStyle) } }
    @Published var ballDiameter: Double { didSet { d.set(ballDiameter, forKey: Keys.ballDiameter) } }
    @Published var launchAtLogin: Bool { didSet { applyLaunchAtLogin() } }

    init() {
        model = d.string(forKey: Keys.model) ?? "zhipuai/glm-5.3-flash"
        variant = d.string(forKey: Keys.variant) ?? ""
        fastMode = d.object(forKey: Keys.fastMode) as? Bool ?? true
        port = d.object(forKey: Keys.port) as? Int ?? 4096
        opencodeBin = d.string(forKey: Keys.bin) ?? ""
        timeoutSeconds = d.object(forKey: Keys.timeout) as? Int ?? 120
        ballStyle = BallStyle(rawValue: d.string(forKey: Keys.ballStyle) ?? "") ?? .ringC
        ballDiameter = d.object(forKey: Keys.ballDiameter) as? Double ?? 64
        launchAtLogin = d.object(forKey: Keys.launchAtLogin) as? Bool ?? false
    }

    /// "provider/model" split, or nil to follow the global default.
    var modelParts: (provider: String, model: String)? {
        let parts = model.split(separator: "/", maxSplits: 1).map(String.init)
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
        return (parts[0], parts[1])
    }

    /// 每个服务商上次选用的 model（"provider/model"），切换服务商时自动带出。
    var lastModelByProvider: [String: String] {
        get {
            d.object(forKey: Keys.lastModelByProvider) as? [String: String] ?? [:]
        }
        set { d.set(newValue, forKey: Keys.lastModelByProvider) }
    }

    func rememberModel(_ id: String, forProviderID providerID: String) {
        guard !id.isEmpty, !providerID.isEmpty else { return }
        var map = lastModelByProvider
        map[providerID] = id
        lastModelByProvider = map
    }

    func lastModel(forProviderID providerID: String) -> String? {
        guard !providerID.isEmpty else { return nil }
        return lastModelByProvider[providerID]
    }

    /// 已配置过独立密钥的服务商 ID 列表（设置页打开时随目录同步；供 serve 覆写配置使用）。
    var credentialProviders: [String] {
        get { d.stringArray(forKey: Keys.credentialProviders) ?? [] }
        set { d.set(newValue, forKey: Keys.credentialProviders) }
    }

    func syncCredentialProviders(_ ids: [String]) {
        credentialProviders = Array(Set(ids)).sorted()
    }

    private func applyLaunchAtLogin() {
        do {
            if launchAtLogin {
                if SMAppService.mainApp.status != .enabled { try SMAppService.mainApp.register() }
            } else {
                if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            }
        } catch {
            NSLog("opentodo: launch-at-login failed: \(error.localizedDescription)")
        }
    }
}

final class SettingsWindowController {
    private var window: NSWindow?

    func show(settings: AppSettings, chat: ChatBackend) {
        if let window {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let view = SettingsView(settings: settings, chat: chat)
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 640),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        win.title = "Opentodo 设置"
        win.isReleasedWhenClosed = false
        win.contentView = NSHostingView(rootView: view)
        win.center()
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        window = win
    }
}

struct SettingsView: View {
    @ObservedObject var settings: AppSettings
    @ObservedObject var chat: ChatBackend

    @State private var providers: [ProviderInfo] = []
    @State private var loading = false
    @State private var loadError: String?
    @State private var providerScope = ""
    @State private var showAllProviders = false
    @State private var providerKeys: [String: String] = [:]
    @State private var providerBaseURLs: [String: String] = [:]
    @State private var savedHint: String?
    private let modelPicker = ModelPickerWindowController()

    var body: some View {
        Form {
            Section("模型") {
                Toggle("显示全部服务商", isOn: $showAllProviders)
                Picker("服务商", selection: $providerScope) {
                    Text("跟随全局默认").tag("")
                    ForEach(providerOptions) { p in
                        Text(providerLabel(p)).tag(p.id)
                    }
                }
                .onChange(of: providerScope) { _, newValue in
                    applyProviderScope(newValue)
                }
                if loading && providers.isEmpty {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text("正在连接 opencode serve 并加载模型目录…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } else if loadError != nil && providers.isEmpty {
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                        Text(loadError ?? "")
                            .font(.caption)
                            .foregroundStyle(.red)
                        Button("重试") { load() }.controlSize(.small)
                    }
                }
                Button {
                    modelPicker.show(
                        providerName: currentProvider?.displayName ?? "",
                        providerID: currentProvider?.id ?? "",
                        models: pickerModels,
                        settings: settings
                    )
                } label: {
                    HStack {
                        Text("模型")
                            .foregroundColor(.primary)
                        Spacer()
                        Text(currentModelLabel)
                            .foregroundColor(settings.model.isEmpty ? .secondary : .primary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                .onChange(of: settings.model) { _, newValue in
                    if let mp = settings.modelParts {
                        providerScope = mp.provider
                        settings.rememberModel(newValue, forProviderID: mp.provider)
                    }
                }
                if !currentVariants.isEmpty {
                    Picker("思考强度", selection: $settings.variant) {
                        Text("默认").tag("")
                        ForEach(currentVariants, id: \.self) { v in
                            Text(v).tag(v)
                        }
                    }
                }
                Toggle("快速模式（简单指令本地处理，不调用模型）", isOn: $settings.fastMode)
                HStack {
                    Button(loading ? "加载中…" : "刷新模型目录") { load() }
                        .disabled(loading)
                    if let loadError {
                        Text(loadError).font(.caption).foregroundStyle(.red)
                    } else if currentProvider != nil {
                        Text(currentProviderNote)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Section("独立 API Key") {
                if credentialRows.isEmpty {
                    Text("加载模型目录后可配置已连接服务商的独立密钥")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(credentialRows, id: \.self) { pid in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(providerDisplayName(pid))
                                .font(.headline)
                            SecureField("API Key", text: keyBinding(pid))
                                .textFieldStyle(.roundedBorder)
                            TextField("Base URL（可选，如代理/中转端点）", text: baseURLBinding(pid))
                                .textFieldStyle(.roundedBorder)
                        }
                        .padding(.vertical, 4)
                    }
                    HStack {
                        Button("保存到钥匙串") { saveKeys() }
                        if savedHint != nil {
                            Text(savedHint!).font(.caption).foregroundStyle(.green)
                        }
                    }
                    Text("密钥仅存入本机钥匙串，只用于 Opentodo 启动的 opencode serve（通过 OPENCODE_CONFIG 注入）；留空则回退全局配置，不影响全局 opencode。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section("悬浮球") {
                Picker("样式", selection: $settings.ballStyle) {
                    Text("A 渐变圆").tag(BallStyle.gradientA)
                    Text("B 玻璃").tag(BallStyle.glassB)
                    Text("C 进度环").tag(BallStyle.ringC)
                    Text("D 深色").tag(BallStyle.darkD)
                    Text("E 极简环").tag(BallStyle.minimalE)
                    Text("F 彩虹").tag(BallStyle.rainbowF)
                }
                HStack {
                    Text("大小")
                    Slider(value: $settings.ballDiameter, in: 48...80, step: 2)
                    Text("\(Int(settings.ballDiameter))px").monospacedDigit().frame(width: 48, alignment: .trailing)
                }
            }

            Section("opencode") {
                HStack {
                    Text("端口")
                    TextField("", value: $settings.port, format: .number).frame(width: 80)
                }
                TextField("可执行文件路径（留空自动检测）", text: $settings.opencodeBin)
                HStack {
                    Text("请求超时")
                    TextField("", value: $settings.timeoutSeconds, format: .number).frame(width: 80)
                    Text("秒")
                }
            }

            Section("系统") {
                Toggle("开机自启", isOn: $settings.launchAtLogin)
                HStack {
                    Text("数据文件")
                    Text(storePath).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 460, height: 600)
        .task { await loadInitial() }
    }

    // MARK: - derived state

    private var providerOptions: [ProviderInfo] {
        var list = providers.filter(\.connected)
        if showAllProviders {
            let known = Set(list.map(\.id))
            list += providers.filter { !known.contains($0.id) }
        }
        // 当前作用域始终可选
        if !providerScope.isEmpty, !list.contains(where: { $0.id == providerScope }) {
            if let p = providers.first(where: { $0.id == providerScope }) { list.append(p) }
        }
        return list
    }

    private var currentProvider: ProviderInfo? {
        providers.first { $0.id == providerScope }
    }

    /// 无服务商作用域时展示全部已连接服务商的模型，保证可搜索到任意模型。
    private var pickerModels: [ModelOption] {
        if let p = currentProvider { return p.models }
        return providers.filter(\.connected).flatMap(\.models)
            .sorted { $0.id < $1.id }
    }

    private var currentModelLabel: String {
        guard let opt = findOption(id: settings.model) else {
            return settings.model.isEmpty ? "跟随全局默认" : settings.model
        }
        return opt.name.isEmpty ? opt.id : opt.name
    }

    private var currentVariants: [String] {
        findOption(id: settings.model)?.variants ?? []
    }

    private var currentProviderNote: String {
        guard let p = currentProvider else { return "" }
        if p.connected {
            return "\(p.displayName) · 已连接 · \(p.models.count) 个模型"
        }
        return "\(p.displayName) · 未连接（未在 opencode 配置 Key）"
    }

    private func findOption(id: String) -> ModelOption? {
        for p in providers {
            if let m = p.models.first(where: { $0.id == id }) { return m }
        }
        return nil
    }

    private func providerLabel(_ p: ProviderInfo) -> String {
        p.connected ? p.displayName : "\(p.displayName)（未连接）"
    }

    // MARK: - 独立 API Key

    private var credentialRows: [String] {
        settings.credentialProviders
    }

    private func providerDisplayName(_ pid: String) -> String {
        providers.first { $0.id == pid }?.displayName ?? pid
    }

    private func keyBinding(_ pid: String) -> Binding<String> {
        Binding(
            get: { providerKeys[pid] ?? "" },
            set: { providerKeys[pid] = $0 }
        )
    }

    private func baseURLBinding(_ pid: String) -> Binding<String> {
        Binding(
            get: { providerBaseURLs[pid] ?? "" },
            set: { providerBaseURLs[pid] = $0 }
        )
    }

    private func loadCredentials() {
        let all = KeychainStore.loadAll()
        for pid in credentialRows {
            let cred = all[pid]
            providerKeys[pid] = (cred?.key.isEmpty == false) ? (cred?.key ?? "") : ""
            providerBaseURLs[pid] = (cred?.baseURL.isEmpty == false) ? (cred?.baseURL ?? "") : ""
        }
    }

    private func saveKeys() {
        for pid in credentialRows {
            KeychainStore.save(
                providerID: pid,
                credential: KeychainStore.Credential(
                    key: providerKeys[pid] ?? "",
                    baseURL: providerBaseURLs[pid] ?? ""
                )
            )
        }
        savedHint = "已保存，serve 已重启并生效"
        chat.restartServe()
    }

    private func applyProviderScope(_ providerID: String) {
        guard !providerID.isEmpty else {
            settings.model = ""
            return
        }
        guard settings.modelParts?.provider != providerID else { return }
        if let last = settings.lastModel(forProviderID: providerID),
           !last.isEmpty, last.hasPrefix(providerID + "/") {
            settings.model = last
        } else {
            settings.model = ""
        }
    }

    private var storePath: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/.config/opentodo/todos.json"
    }

    private func load() {
        loading = true
        loadError = nil
        Task {
            let result = await chat.fetchCatalog()
            providers = result
            loading = false
            if result.isEmpty {
                loadError = "未取到模型目录（检查端口/opencode）"
            } else {
                settings.syncCredentialProviders(result.filter(\.connected).map(\.id))
                loadCredentials()
                if providerScope.isEmpty {
                    // 首次：跟随当前默认模型的服务商
                    providerScope = settings.modelParts?.provider ?? ""
                }
            }
        }
    }

    private func loadInitial() async {
        if providers.isEmpty { load() }
    }
}

/// 模型选择独立窗口（NSWindow 承载，避免 sheet + NavigationStack + searchable 的 macOS 卡死问题）。
final class ModelPickerWindowController {
    private var window: NSWindow?

    func show(providerName: String, providerID: String, models: [ModelOption], settings: AppSettings) {
        window?.close()
        let view = ModelPickerView(
            settings: settings,
            providerName: providerName,
            providerID: providerID,
            models: models
        )
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 520),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        win.title = "选择模型"
        win.isReleasedWhenClosed = false
        win.contentView = NSHostingView(rootView: view)
        let controller = NSWindowController(window: win)
        controller.showWindow(nil)
        win.center()
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        window = win
    }
}

/// 模型选择窗口内容：搜索（普通 TextField）+ 手动输入 + 列表（费用/变体徽标）。
struct ModelPickerView: View {
    @ObservedObject var settings: AppSettings
    let providerName: String
    let providerID: String
    let models: [ModelOption]

    @State private var query = ""
    @State private var manual = ""

    private var filtered: [ModelOption] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return models }
        return models.filter {
            $0.id.lowercased().contains(q)
                || $0.name.lowercased().contains(q)
                || $0.family.lowercased().contains(q)
        }
    }

    private var current: String { settings.model }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                if !providerID.isEmpty {
                    HStack(spacing: 6) {
                        Text(providerName.isEmpty ? providerID : providerName)
                            .font(.headline)
                        Text("· \(models.count) 个模型")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                TextField("搜索模型（输入名称或 ID 过滤）", text: $query)
                    .textFieldStyle(.roundedBorder)
                HStack(spacing: 6) {
                    TextField(manualPlaceholder, text: $manual)
                        .textFieldStyle(.roundedBorder)
                        .autocorrectionDisabled()
                        .onSubmit { apply(manual) }
                    Button("使用") { apply(manual) }
                        .disabled(manual.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if !providerID.isEmpty {
                    Text("输入后将保存为 \(providerID)/模型名（或直接输入含 / 的完整 ID）")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(12)

            Divider()

            List {
                if filtered.isEmpty {
                    Text(query.isEmpty ? "暂无模型（请先在服务商处刷新目录）" : "无匹配模型")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(filtered) { model in
                        modelRow(model)
                    }
                }
            }

            Divider()

            HStack {
                Text("单价为 opencode 目录报告值（美元/百万 tokens）。变体为支持的思考强度。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("关闭") { NSApp.keyWindow?.close() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(12)
        }
        .frame(minWidth: 460, minHeight: 480)
    }

    private var manualPlaceholder: String {
        providerID.isEmpty ? "模型 ID（如 provider/model）" : "模型名（自动补全服务商前缀）"
    }

    private func modelRow(_ model: ModelOption) -> some View {
        Button {
            apply(model.id)
        } label: {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.name.isEmpty ? model.model : model.name)
                        .foregroundStyle(model.id == current ? Color.accentColor : .primary)
                        .lineLimit(1)
                    Text(currentModelNote(model))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                if !model.variants.isEmpty {
                    HStack(spacing: 2) {
                        ForEach(model.variants, id: \.self) { v in
                            Text(v)
                                .font(.system(size: 9))
                                .padding(.horizontal, 4)
                                .padding(.vertical, 1)
                                .background(Color.accentColor.opacity(0.15), in: Capsule())
                        }
                    }
                }
                if model.id == current {
                    Image(systemName: "checkmark")
                        .foregroundStyle(Color.accentColor)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func currentModelNote(_ model: ModelOption) -> String {
        var parts: [String] = [model.model]
        if let input = model.inputCost, let output = model.outputCost {
            parts.append("in \(Self.dollars(input)) / out \(Self.dollars(output))")
        }
        if !model.family.isEmpty, model.family != model.model.lowercased() {
            parts.append(model.family)
        }
        return parts.joined(separator: " · ")
    }

    private func apply(_ raw: String) {
        let resolved = ModelID.resolve(raw, provider: providerID.isEmpty ? nil : providerID)
        guard !resolved.isEmpty else { return }
        settings.model = resolved
        settings.rememberModel(resolved, forProviderID: (settings.modelParts?.provider) ?? providerID)
        NSApp.keyWindow?.close()
    }

    private static func dollars(_ v: Double) -> String {
        if v == v.rounded() { return String(format: "%.0f", v) }
        return String(format: "%.2f", v)
    }
}
