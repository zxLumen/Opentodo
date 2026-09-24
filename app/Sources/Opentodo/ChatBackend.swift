import Foundation

struct ChatMessage: Identifiable, Equatable {
    let id = UUID()
    let role: String // "user" | "assistant" | "system"
    var text: String
}

enum OpenCodeLocator {
    static func find(explicit: String = "") throws -> String {
        if !explicit.isEmpty, FileManager.default.isExecutableFile(atPath: explicit) {
            return explicit
        }
        let env = ProcessInfo.processInfo.environment["OPENCODE_BIN"]
        if let env, FileManager.default.isExecutableFile(atPath: env) { return env }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            "\(home)/.opencode/bin/opencode",
            "/opt/homebrew/bin/opencode",
            "/usr/local/bin/opencode",
        ]
        for c in candidates where FileManager.default.isExecutableFile(atPath: c) { return c }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-lc", "command -v opencode"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = Pipe()
        try? p.run()
        p.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        if let path = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !path.isEmpty, FileManager.default.isExecutableFile(atPath: path) {
            return path
        }
        throw NSError(domain: "opentodo", code: 2, userInfo: [
            NSLocalizedDescriptionKey: "找不到 opencode 可执行文件，请在设置里指定路径",
        ])
    }
}

/// Talks to a dedicated `opencode serve` instance over HTTP.
@MainActor
final class ChatBackend: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var busy = false

    private let settings = AppSettings.shared
    private var store: TodoStore { .shared }
    private var sessionID: String?
    private var serverProcess: Process?
    private var currentTask: Task<Void, Never>?
    private var currentSessionID: String?

    private var activePort: Int?
    private var baseURL: URL { URL(string: "http://127.0.0.1:\(activePort ?? settings.port)")! }

    init() {}

    /// 启动时预置 App 专属 opencode 配置（插件目录 + 隔离的 XDG 配置根 + 覆盖层），使首次对话前一切就绪。
    func prepareEnvironment() {
        reapStaleServes()
        _ = writeProviderOverrides()
        _ = provisionPlugin()
        _ = provisionXdgConfigHome()
    }

    func send(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !busy else { return }
        messages.append(ChatMessage(role: "user", text: trimmed))

        if settings.fastMode, let reply = FastIntent.handle(trimmed, store: .shared) {
            messages.append(ChatMessage(role: "assistant", text: reply))
            return
        }

        busy = true
        currentTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await self.ensureServer()
                var sid = try await self.ensureSession()
                self.currentSessionID = sid
                var reply = try await self.postMessage(sessionID: sid, text: trimmed)
                // 达到 agent 步数上限时：静默开新会话续聊，不把超限文案显示给用户，
                // 也不动面板上的历史消息（只重开后端 session）。
                var continueCount = 0
                while !Task.isCancelled, Self.isStepLimit(reply), continueCount < 3 {
                    continueCount += 1
                    self.sessionID = nil
                    sid = try await self.ensureSession()
                    self.currentSessionID = sid
                    reply = try await self.postMessage(sessionID: sid, text: "继续，不要重复已完成的")
                }
                if !Task.isCancelled {
                    self.messages.append(ChatMessage(role: "assistant", text: reply))
                }
            } catch is CancellationError {
                // stop() already handled UI state
            } catch {
                if !Task.isCancelled {
                    self.messages.append(ChatMessage(role: "system", text: "错误: \(error.localizedDescription)"))
                }
                await self.abort()
            }
            self.busy = false
            self.currentTask = nil
        }
    }

    func stop() {
        guard busy else { return }
        currentTask?.cancel()
        currentTask = nil
        busy = false
        messages.append(ChatMessage(role: "system", text: "已停止"))
        Task { await abort() }
    }

    func clear() {
        messages.removeAll()
    }

    // MARK: - Models

    private var catalogCache: (storedAt: Date, catalog: [ProviderInfo])?

    /// 拉取服务商与模型目录（带 5 分钟内存缓存）。返回全部服务商；`connected` 标记已配 Key 的。
    func fetchCatalog() async -> [ProviderInfo] {
        if let cache = catalogCache,
           Date().timeIntervalSince(cache.storedAt) < 300 {
            return cache.catalog
        }
        do { try await ensureServer() } catch { return [] }
        guard let (data, _) = try? await request("provider", method: "GET"),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let all = obj["all"] as? [[String: Any]] else { return [] }
        let connected = Set(obj["connected"] as? [String] ?? [])

        var providers: [ProviderInfo] = []
        for p in all {
            guard let pid = p["id"] as? String else { continue }
            let name = p["name"] as? String ?? pid
            let source = p["source"] as? String ?? ""
            let rawModels = p["models"] as? [String: Any] ?? [:]
            var models: [ModelOption] = []
            for (mid, mv) in rawModels {
                guard let m = mv as? [String: Any] else { continue }
                var variants: [String] = []
                if let vs = m["variants"] as? [String: Any] {
                    variants = vs.keys.sorted()
                }
                let cost = m["cost"] as? [String: Any]
                let inputCost = (cost?["input"] as? NSNumber)?.doubleValue
                let outputCost = (cost?["output"] as? NSNumber)?.doubleValue
                models.append(ModelOption(
                    provider: pid,
                    model: mid,
                    name: m["name"] as? String ?? mid,
                    family: m["family"] as? String ?? "",
                    variants: variants,
                    inputCost: inputCost,
                    outputCost: outputCost
                ))
            }
            providers.append(ProviderInfo(
                id: pid,
                displayName: name,
                source: source,
                connected: connected.contains(pid),
                models: models.sorted { $0.id < $1.id }
            ))
        }
        let sorted = providers.sorted { a, b in
            if a.connected != b.connected { return a.connected && !b.connected }
            return a.displayName.localizedCaseInsensitiveCompare(b.displayName) == .orderedAscending
        }
        catalogCache = (Date(), sorted)
        return sorted
    }

    // MARK: - Server lifecycle

    /// 终止自家 serve 并使会话/目录缓存失效；下次请求以最新配置重新拉起。
    func restartServe() {
        terminateServer()
        catalogCache = nil
    }

    /// App 退出时结束自起的 serve，避免残留孤儿进程占用端口与内存。
    func shutdown() {
        terminateServer()
    }

    private func terminateServer() {
        guard let process = serverProcess else {
            activePort = nil
            sessionID = nil
            currentSessionID = nil
            return
        }
        serverProcess = nil
        activePort = nil
        sessionID = nil
        currentSessionID = nil
        guard process.isRunning else { return }
        let pid = process.processIdentifier
        process.terminate()
        // 兜底：1.5s 后仍未退出则 SIGKILL，确保不留孤儿。
        DispatchQueue.global().asyncAfter(deadline: .now() + 1.5) {
            if kill(pid, 0) == 0 { kill(pid, SIGKILL) }
        }
    }

    /// 启动时回收上次遗留的、由本 App 拉起的 `opencode serve`
    /// （通过环境变量 OPENCODE_CONFIG 指向我们的覆盖层来识别，不误杀用户的 TUI serve）。
    private func reapStaleServes() {
        let marker = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/opentodo/opencode-overrides.jsonc").path
        guard let pids = runCommand("/usr/bin/pgrep", ["-f", "opencode serve"]) else { return }
        for token in pids.split(whereSeparator: \.isNewline) {
            guard let pid = Int(token.trimmingCharacters(in: .whitespaces)), pid > 0 else { continue }
            guard let info = runCommand("/bin/ps", ["-E", "-p", "\(pid)"]), info.contains(marker) else { continue }
            kill(pid_t(pid), SIGKILL)
        }
    }

    private func runCommand(_ path: String, _ args: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = args
        let out = Pipe()
        process.standardOutput = out
        process.standardError = Pipe()
        do { try process.run() } catch { return nil }
        process.waitUntilExit()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8)
    }

    /// 识别 opencode 的"达到最大步数限制"提示（中英文）。
    private static func isStepLimit(_ text: String) -> Bool {
        text.contains("最大步骤限制")
            || text.contains("工具已禁用")
            || text.lowercased().contains("maximum steps")
            || text.lowercased().contains("step limit")
    }

    /// 把钥匙串里的独立密钥写成 serve 覆盖配置（OPENCODE_CONFIG 指向它），返回配置文件路径。
    @discardableResult
    private func writeProviderOverrides() -> String {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/opentodo")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path)

        var credentials: [String: KeychainStore.Credential] = [:]
        for pid in settings.credentialProviders {
            if let cred = KeychainStore.load(providerID: pid) {
                credentials[pid] = cred
            }
        }
        let data = KeychainStore.buildOverlayData(credentials: credentials)
        let path = dir.appendingPathComponent("opencode-overrides.jsonc")
        do {
            try data.write(to: path, options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
        } catch {
            NSLog("opentodo: write provider overrides failed: \(error.localizedDescription)")
        }
        return path.path
    }

    /// App 专属的 opencode 配置目录：只被 App 拉起的 serve 通过 OPENCODE_CONFIG_DIR 加载，
    /// 因此里面的 opentodo 插件（提供 opentodo_* 工具 + 注入上下文）不会出现在其它 opencode 会话。
    private func appConfigDir() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/opentodo/opencode")
    }

    /// App 专属的 XDG 配置根：让 App 的 serve 不加载全局 `~/.config/opencode`
    /// 的配置与插件，从而避免全局插件影响 App 对话
    /// （smart-voice 的语音提醒、aistatus 把 App 会话当成 session 捕捉）。
    /// 认证仍在数据目录（XDG_DATA_HOME 未隔离），标准 provider 照常可用。
    private func xdgConfigHome() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/opentodo/xdg")
    }

    @discardableResult
    private func provisionXdgConfigHome() -> URL {
        let dir = xdgConfigHome()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// 从 App bundle 把插件复制到专属目录（幂等，每次覆盖以保持最新）。
    @discardableResult
    private func provisionPlugin() -> URL {
        let dir = appConfigDir()
        let plugins = dir.appendingPathComponent("plugins")
        try? FileManager.default.createDirectory(at: plugins, withIntermediateDirectories: true)
        if let src = Bundle.main.resourceURL?.appendingPathComponent("plugin/opentodo.js"),
           FileManager.default.fileExists(atPath: src.path) {
            let dst = plugins.appendingPathComponent("opentodo.js")
            try? FileManager.default.removeItem(at: dst)
            try? FileManager.default.copyItem(at: src, to: dst)
        }
        return dir
    }

    private func health(idle: Bool = false, timeout: TimeInterval = 1, port: Int? = nil) async -> Bool {
        let target = port ?? activePort ?? settings.port
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(target)/global/health")!)
        req.timeoutInterval = timeout
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
            if ok, idle, serverProcess != nil {
                // Owned serve is still healthy; nothing more to do.
            }
            return ok
        } catch {
            return false
        }
    }

    private func hasOpentodoAgent(on port: Int) async -> Bool {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/agent")!)
        req.timeoutInterval = 2
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let agents = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return false
        }
        return agents.contains { ($0["name"] as? String) == "opentodo" }
    }

    /// 是否已配置至少一个非空独立密钥/端点（此时必须用自家带 OPENCODE_CONFIG 的 serve）。
    private func wantsKeyOverrides() -> Bool {
        for pid in settings.credentialProviders {
            if let c = KeychainStore.load(providerID: pid),
               !c.key.isEmpty || !c.baseURL.isEmpty {
                return true
            }
        }
        return false
    }

    /// Picks the port to talk to: reuse an owned serve, reuse a foreign serve that
    /// already has the `opentodo` agent (e.g. another tool's fresh serve), otherwise
    /// spawn our own `opencode serve` on the first free port.
    private func ensureServer() async throws {
        if let owned = serverProcess, owned.isRunning, await health() { return }

        for delta in 0..<25 {
            let port = settings.port + delta

            if await health(timeout: 0.4, port: port) {
                // 配置了独立密钥时不可复用外部 serve（它没带我们的 OPENCODE_CONFIG 覆写），
                // 一律自起带覆写的 serve。
                if await hasOpentodoAgent(on: port), !wantsKeyOverrides() {
                    activePort = port
                    return
                }
                continue // foreign or misconfigured serve without our agent; skip it
            }

            let bin = try OpenCodeLocator.find(explicit: settings.opencodeBin)
            let p = Process()
            p.executableURL = URL(fileURLWithPath: bin)
            p.arguments = ["serve", "--port", "\(port)", "--hostname", "127.0.0.1"]
            p.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
            p.standardOutput = Pipe()
            p.standardError = Pipe()
            var env = ProcessInfo.processInfo.environment
            env["OPENCODE_CONFIG"] = writeProviderOverrides()
            env["OPENCODE_CONFIG_DIR"] = provisionPlugin().path
            env["XDG_CONFIG_HOME"] = provisionXdgConfigHome().path
            p.environment = env
            try p.run()
            serverProcess = p
            activePort = port
            for _ in 0..<40 {
                try await Task.sleep(nanoseconds: 250_000_000)
                if await health(port: port) { return }
            }
            p.terminate()
            if p.isRunning { kill(p.processIdentifier, SIGKILL) }
            serverProcess = nil
            activePort = nil
            throw NSError(domain: "opentodo", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "opencode serve 启动超时（端口 \(port)）",
            ])
        }
        throw NSError(domain: "opentodo", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "找不到可用的 opencode serve 端口",
        ])
    }

    private func ensureSession() async throws -> String {
        if let sessionID { return sessionID }
        let (data, _) = try await request("session", method: "POST", body: ["title": "Opentodo"])
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = obj["id"] as? String else {
            throw NSError(domain: "opentodo", code: 3, userInfo: [NSLocalizedDescriptionKey: "无法创建 opencode 会话"])
        }
        sessionID = id
        return id
    }

    private func postMessage(sessionID: String, text: String) async throws -> String {
        // 不上屏的上下文前缀：即使插件未注入，也保证按 App 当前项目归类。
        let project = store.currentList
        let listArg = project.map { "\"\($0)\"" } ?? "null"
        let context =
            "[Opentodo 上下文] 当前项目：\(project ?? "收件箱")。新增待办默认归入该项目（list=\(listArg)）；"
            + "仅当用户明确指定其他项目或要求跨项目时才改变。\n\n"
        var body: [String: Any] = [
            "parts": [["type": "text", "text": context + text]],
            "agent": "opentodo",
        ]
        if let mp = settings.modelParts {
            body["model"] = ["providerID": mp.provider, "modelID": mp.model]
        }
        if !settings.variant.isEmpty { body["variant"] = settings.variant }

        let (data, resp) = try await request("session/\(sessionID)/message", method: "POST", body: body)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            throw NSError(domain: "opentodo", code: http.statusCode, userInfo: [
                NSLocalizedDescriptionKey: "opencode 返回 \(http.statusCode)",
            ])
        }
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let parts = obj["parts"] as? [[String: Any]] else {
            return "(无回复)"
        }
        let texts = parts.compactMap { p -> String? in
            (p["type"] as? String) == "text" ? (p["text"] as? String) : nil
        }
        let joined = texts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return joined.isEmpty ? "(无回复)" : joined
    }

    private func abort() async {
        guard let sid = currentSessionID else { return }
        _ = try? await request("session/\(sid)/abort", method: "POST")
    }

    private func request(_ path: String, method: String, body: [String: Any]? = nil) async throws -> (Data, URLResponse) {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = method
        req.timeoutInterval = TimeInterval(max(10, settings.timeoutSeconds))
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return try await URLSession.shared.data(for: req)
    }
}
