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

/// Talks to a dedicated `opencode serve` (OpenCode **V2** HTTP API) over HTTP.
///
/// V2 differences from V1 (see https://opencode.ai/v2/docs/api):
///   · every route lives under `/api/*` and requires HTTP Basic auth. A serve we
///     spawn prints `server password <pw>` on stdout, so we read that pipe and
///     authenticate as `opencode:<pw>`.
///   · requests are scoped to a *location* (a directory). We use the app's own
///     config dir, where we drop the `opentodo` plugin.
///   · `POST /api/session/{id}/prompt` only *admits* the message; the reply has
///     to be polled from `GET /api/session/{id}/message` until it completes.
@MainActor
final class ChatBackend: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var busy = false

    private let settings = AppSettings.shared
    private var store: TodoStore { .shared }
    private var sessionID: String?
    private var serverProcess: Process?
    private var serverStdout: Pipe?
    private var serverStderr: Pipe?
    private var stdoutBuffer = Data()
    private var servePassword: String?
    private var currentTask: Task<Void, Never>?
    private var currentSessionID: String?

    private var activePort: Int?
    private var baseURL: URL { URL(string: "http://127.0.0.1:\(activePort ?? settings.port)")! }

    /// App 专属的 serve 位置(location):插件与配置都放这里,和其它 opencode 会话完全隔离。
    private var locationDir: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/opentodo/opencode")
    }

    /// App 专属 XDG 配置根:让 serve 只读我们生成的全局配置,不加载用户 `~/.config/opencode`。
    private var xdgConfigHome: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/opentodo/xdg")
    }

    init() {}

    /// 启动时预置 App 专属 opencode 配置(插件目录 + 隔离的 XDG 配置根 + 覆盖层),使首次对话前一切就绪。
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

    /// 拉取服务商与模型目录（带 5 分钟内存缓存）。返回全部服务商；`connected` 标记可用的。
    func fetchCatalog() async -> [ProviderInfo] {
        if let cache = catalogCache,
           Date().timeIntervalSince(cache.storedAt) < 300 {
            return cache.catalog
        }
        do { try await ensureServer() } catch { return [] }

        // providers: id -> (name, activation)
        var nameByID: [String: String] = [:]
        var activeByID: [String: Bool] = [:]
        if let (pdata, _) = try? await request("api/provider", method: "GET"),
           let pobj = try? JSONSerialization.jsonObject(with: pdata) as? [String: Any],
           let plist = pobj["data"] as? [[String: Any]] {
            for p in plist {
                guard let pid = p["id"] as? String else { continue }
                nameByID[pid] = p["name"] as? String ?? pid
                activeByID[pid] = (p["activation"] as? String) != "disabled"
            }
        }

        guard let (mdata, _) = try? await request("api/model", method: "GET"),
              let mobj = try? JSONSerialization.jsonObject(with: mdata) as? [String: Any],
              let mlist = mobj["data"] as? [[String: Any]] else { return [] }

        var byProvider: [String: [ModelOption]] = [:]
        for m in mlist {
            guard let pid = m["providerID"] as? String, let mid = m["id"] as? String else { continue }
            if (m["enabled"] as? Bool) == false { continue }
            let variants = (m["variants"] as? [[String: Any]] ?? [])
                .compactMap { $0["id"] as? String }
            let cost = m["cost"] as? [String: Any]
            let inputCost = (cost?["input"] as? NSNumber)?.doubleValue
            let outputCost = (cost?["output"] as? NSNumber)?.doubleValue
            byProvider[pid, default: []].append(ModelOption(
                provider: pid,
                model: mid,
                name: m["name"] as? String ?? mid,
                family: m["family"] as? String ?? "",
                variants: variants.sorted(),
                inputCost: inputCost,
                outputCost: outputCost
            ))
        }

        var providers: [ProviderInfo] = []
        for (pid, models) in byProvider {
            providers.append(ProviderInfo(
                id: pid,
                displayName: nameByID[pid] ?? pid,
                source: "",
                connected: activeByID[pid] ?? true,
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
        serverStdout?.fileHandleForReading.readabilityHandler = nil
        serverStderr?.fileHandleForReading.readabilityHandler = nil
        serverStdout = nil
        serverStderr = nil
        servePassword = nil
        stdoutBuffer.removeAll()
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
    /// （通过环境变量 OPENTODO_SERVE=1 识别，不误杀用户的 TUI / 共享服务）。
    private func reapStaleServes() {
        guard let pids = runCommand("/usr/bin/pgrep", ["-f", "opencode serve"]) else { return }
        for token in pids.split(whereSeparator: \.isNewline) {
            guard let pid = Int(token.trimmingCharacters(in: .whitespaces)), pid > 0 else { continue }
            guard let info = runCommand("/bin/ps", ["-E", "-p", "\(pid)"]),
                  info.contains("OPENTODO_SERVE=1") else { continue }
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

    /// App 专属的 opencode 配置目录：只被 App 拉起的 serve 通过 XDG_CONFIG_HOME 加载，
    /// 因此里面的 opentodo 插件（提供 opentodo_* 工具 + 注入上下文）不会出现在其它 opencode 会话。
    private func appConfigDir() -> URL { locationDir }

    private func provisionXdgConfigHome() -> URL {
        let dir = xdgConfigHome
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// 把 `opentodo` 插件复制到 location 的 `.opencode/plugins/opentodo/`（V2 会自动发现）。
    /// 幂等,每次覆盖以保持最新。
    @discardableResult
    private func provisionPlugin() -> URL {
        let dir = appConfigDir()
        let plugins = dir.appendingPathComponent(".opencode/plugins/opentodo")
        try? FileManager.default.createDirectory(at: plugins, withIntermediateDirectories: true)
        if let src = Bundle.main.resourceURL?.appendingPathComponent("plugin/opentodo.js"),
           FileManager.default.fileExists(atPath: src.path) {
            let dst = plugins.appendingPathComponent("index.js")
            try? FileManager.default.removeItem(at: dst)
            try? FileManager.default.copyItem(at: src, to: dst)
        }
        return dir
    }

    /// 把钥匙串里的独立密钥 + opentodo agent 写成 serve 的全局配置
    /// (`<XDG_CONFIG_HOME>/opencode/opencode.json`)。
    @discardableResult
    private func writeProviderOverrides() -> String {
        let dir = xdgConfigHome.appendingPathComponent("opencode")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        var credentials: [String: KeychainStore.Credential] = [:]
        for pid in settings.credentialProviders {
            if let cred = KeychainStore.load(providerID: pid) {
                credentials[pid] = cred
            }
        }
        let data = KeychainStore.buildOverlayData(credentials: credentials)
        let path = dir.appendingPathComponent("opencode.json")
        do {
            try data.write(to: path, options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
        } catch {
            NSLog("opentodo: write provider overrides failed: \(error.localizedDescription)")
        }
        return path.path
    }

    // MARK: - HTTP

    private var authHeader: String? {
        guard let pw = servePassword else { return nil }
        return "Basic " + Data("opencode:\(pw)".utf8).base64EncodedString()
    }

    private func url(_ path: String, query: [String: String] = [:]) -> URL {
        var comps = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty {
            comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        return comps.url!
    }

    private func request(
        _ path: String,
        method: String,
        body: [String: Any]? = nil,
        query: [String: String] = [:]
    ) async throws -> (Data, URLResponse) {
        var req = URLRequest(url: url(path, query: query))
        req.httpMethod = method
        req.timeoutInterval = TimeInterval(max(10, settings.timeoutSeconds))
        if let authHeader { req.setValue(authHeader, forHTTPHeaderField: "Authorization") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return try await URLSession.shared.data(for: req)
    }

    private func json(
        _ path: String,
        method: String = "GET",
        body: [String: Any]? = nil,
        query: [String: String] = [:]
    ) async throws -> [String: Any] {
        let (data, resp) = try await request(path, method: method, body: body, query: query)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw NSError(domain: "opentodo", code: http.statusCode, userInfo: [
                NSLocalizedDescriptionKey: "opencode 返回 \(http.statusCode)\(text.isEmpty ? "" : ": \(text.prefix(200))")",
            ])
        }
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: "opentodo", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "opencode 返回了非 JSON 响应",
            ])
        }
        return obj
    }

    private func health(timeout: TimeInterval = 1, port: Int? = nil) async -> Bool {
        guard servePassword != nil else { return false }
        let target = port ?? activePort
        guard let target, let u = URL(string: "http://127.0.0.1:\(target)/api/info") else { return false }
        var req = URLRequest(url: u)
        req.timeoutInterval = timeout
        if let authHeader { req.setValue(authHeader, forHTTPHeaderField: "Authorization") }
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            return (resp as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    private func hasOpentodoAgent() async -> Bool {
        guard let obj = try? await json("api/agent", query: ["location[directory]": appConfigDir().path]),
              let list = obj["data"] as? [[String: Any]] else { return false }
        return list.contains { ($0["id"] as? String) == "opentodo" }
    }

    /// Picks the first free port and spawns our own `opencode serve` there.
    /// V2 has no "reuse a foreign serve" mode (our agent/plugin live in our own
    /// location + XDG config), so we always own the process.
    private func ensureServer() async throws {
        if let owned = serverProcess, owned.isRunning, await health() { return }
        terminateServer()
        let bin = try OpenCodeLocator.find(explicit: settings.opencodeBin)
        var lastError: Error?
        for delta in 0..<25 {
            do {
                try await spawnServe(bin: bin, port: settings.port + delta)
                return
            } catch {
                lastError = error
            }
        }
        throw lastError ?? NSError(domain: "opentodo", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "找不到可用的 opencode serve 端口",
        ])
    }

    private func spawnServe(bin: String, port: Int) async throws {
        _ = writeProviderOverrides()
        let loc = provisionPlugin()
        _ = provisionXdgConfigHome()

        let p = Process()
        p.executableURL = URL(fileURLWithPath: bin)
        p.arguments = ["serve", "--port", "\(port)", "--hostname", "127.0.0.1"]
        p.currentDirectoryURL = loc
        let out = Pipe()
        let err = Pipe()
        p.standardOutput = out
        p.standardError = err
        var env = ProcessInfo.processInfo.environment
        env["XDG_CONFIG_HOME"] = xdgConfigHome.path
        env["OPENTODO_SERVE"] = "1"
        p.environment = env

        servePassword = nil
        stdoutBuffer.removeAll()

        do {
            try p.run()
        } catch {
            throw NSError(domain: "opentodo", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "无法启动 opencode serve：\(error.localizedDescription)",
            ])
        }

        out.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            // 管道到达 EOF 后 readabilityHandler 会被反复唤醒：必须在此摘除，
            // 否则 serve 退出后这里会 100% 空转烧 CPU。
            guard !data.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            Task { @MainActor in self?.consumeStdout(data) }
        }
        // V2 的 serve 日志走 stderr；必须排空，否则缓冲写满会把它堵死。
        // 同样要在 EOF 时摘除 handler，避免 serve 退出后空转。
        err.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
        }

        serverProcess = p
        serverStdout = out
        serverStderr = err
        activePort = port

        // 等它把 "server password <pw>" 打到 stdout（这样我们才能认证 V2 API）。
        for _ in 0..<80 { // 80 × 250ms = 20s
            if servePassword != nil { return }
            if !p.isRunning { break }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        terminateServer()
        throw NSError(domain: "opentodo", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "opencode serve 启动超时（端口 \(port)）",
        ])
    }

    /// Reads the serve's stdout line by line, capturing `server password <pw>`.
    private func consumeStdout(_ data: Data) {
        stdoutBuffer.append(data)
        while let nl = stdoutBuffer.firstIndex(of: 0x0A) {
            let lineData = stdoutBuffer[stdoutBuffer.startIndex..<nl]
            stdoutBuffer.removeSubrange(stdoutBuffer.startIndex...nl)
            guard let line = String(data: lineData, encoding: .utf8) else { continue }
            let marker = "server password "
            if let r = line.range(of: marker) {
                let pw = String(line[r.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
                if !pw.isEmpty { servePassword = pw }
            }
        }
    }

    // MARK: - Session

    private func ensureSession() async throws -> String {
        if let sessionID { return sessionID }
        var body: [String: Any] = [
            "location": ["directory": appConfigDir().path],
            "agent": "opentodo",
        ]
        if let mp = settings.modelParts {
            var model: [String: Any] = ["providerID": mp.provider, "id": mp.model]
            if !settings.variant.isEmpty { model["variant"] = settings.variant }
            body["model"] = model
        }
        let obj = try await json("api/session", method: "POST", body: body)
        guard let data = obj["data"] as? [String: Any], let id = data["id"] as? String else {
            throw NSError(domain: "opentodo", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "无法创建 opencode 会话",
            ])
        }
        sessionID = id
        return id
    }

    private func sessionMessages(_ sessionID: String) async throws -> [[String: Any]] {
        let obj = try await json("api/session/\(sessionID)/message")
        return obj["data"] as? [[String: Any]] ?? []
    }

    /// 从一条消息里抽出 assistant 的文字(按 order 拼接 text 段)。
    private func textOf(_ m: [String: Any]) -> String {
        (m["content"] as? [[String: Any]] ?? [])
            .filter { ($0["type"] as? String) == "text" }
            .compactMap { $0["text"] as? String }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func createdOf(_ m: [String: Any]) -> Double {
        ((m["time"] as? [String: Any])?["created"] as? NSNumber)?.doubleValue ?? 0
    }

    /// 该会话是否仍在执行(V2 的 /api/session/active)。
    private func isSessionActive(_ sessionID: String) async -> Bool {
        guard let obj = try? await json("api/session/active"),
              let data = obj["data"] as? [String: Any] else { return false }
        return data[sessionID] != nil
    }

    private func postMessage(sessionID: String, text: String) async throws -> String {
        // 不上屏的上下文前缀：即使插件未注入，也保证按 App 当前项目归类。
        let project = store.currentList ?? TodoItem.inboxName
        let listArg = "\"\(project)\""
        let context =
            "[Opentodo 上下文] 当前项目：\(project)。新增待办默认归入该项目（list=\(listArg)）；"
            + "仅当用户明确指定其他项目或要求跨项目时才改变。\n\n"

        let before = Set((try await sessionMessages(sessionID)).compactMap { $0["id"] as? String })

        _ = try await json("api/session/\(sessionID)/prompt", method: "POST", body: ["text": context + text])

        // V2 的 prompt 只做「收件」：回复要等这一回合真正跑完再取。
        // 注意两点(实测)：
        //   · /message 是【倒序】(最新的在前)，不能靠"数组最后一条"取回复；
        //   · 一个回合会有多条 assistant 消息 —— 工具那条 finish=tool-calls 没有文字,
        //     最终文字在 finish=stop 那条。所以要按 created 取最新且【文字非空】的那条。
        // 回合结束的可靠信号：会话从 /api/session/active 里消失(连续两次确认，避免起步竞态)。
        let deadline = Date().addingTimeInterval(TimeInterval(max(10, settings.timeoutSeconds)))
        var fresh: [[String: Any]] = []
        var idleStreak = 0
        while Date() < deadline {
            if Task.isCancelled { throw CancellationError() }
            fresh = (try await sessionMessages(sessionID)).filter {
                ($0["type"] as? String) == "assistant"
                    && !before.contains(($0["id"] as? String) ?? "")
            }
            if !fresh.isEmpty, !(await isSessionActive(sessionID)) {
                idleStreak += 1
                if idleStreak >= 2 { break }
            } else {
                idleStreak = 0
            }
            try await Task.sleep(nanoseconds: 1_000_000_000)
        }

        // 取本轮新增里 created 最大、且有文字的那条。
        let replied = fresh.sorted { createdOf($0) < createdOf($1) }.last { !textOf($0).isEmpty }
        if let final = replied {
            if let err = final["error"] as? [String: Any] {
                let msg = err["message"] as? String ?? "opencode 返回错误"
                throw NSError(domain: "opentodo", code: 5, userInfo: [NSLocalizedDescriptionKey: msg])
            }
            return textOf(final)
        }
        // 没有文字：先看有没有报错，再判断是超时还是真·空回复。
        if let err = fresh.compactMap({ $0["error"] as? [String: Any] }).last {
            let msg = err["message"] as? String ?? "opencode 返回错误"
            throw NSError(domain: "opentodo", code: 5, userInfo: [NSLocalizedDescriptionKey: msg])
        }
        if fresh.isEmpty {
            throw NSError(domain: "opentodo", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "模型响应超时（> \(settings.timeoutSeconds)s）",
            ])
        }
        return "(无回复)"
    }

    private func abort() async {
        guard let sid = currentSessionID else { return }
        _ = try? await json("api/session/\(sid)/interrupt", method: "POST")
    }
}
