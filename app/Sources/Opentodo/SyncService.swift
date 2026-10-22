import Foundation
import Combine
import OpentodoCore

/// Mac ↔ 云端同步：读本地完整状态 → POST /api/sync → 合并结果写回本地文件。
/// 本地文件仍是 App / 插件 / MCP 的共同入口，所以不需要改任何调用方。
@MainActor
final class SyncService: ObservableObject {
    enum Phase: Equatable {
        case disabled
        case idle
        case syncing
        case failed(String)
    }

    @Published private(set) var phase: Phase = .disabled
    @Published private(set) var lastSyncAt: Date?
    @Published private(set) var lastError: String?

    private let store: TodoStore
    private let settings: AppSettings
    private var token: String?
    private var localObserver: NSObjectProtocol?
    private var debounce: Task<Void, Never>?
    private var inFlight = false
    private var pendingAgain = false

    init(store: TodoStore, settings: AppSettings) {
        self.store = store
        self.settings = settings
        self.token = KeychainStore.loadSyncToken()
        refreshPhase()
    }

    var isConfigured: Bool {
        !settings.syncURL.isEmpty && token != nil && !settings.syncDeviceId.isEmpty
    }

    var serverURL: URL? {
        Self.normalizeURL(settings.syncURL)
    }

    func start() {
        refreshPhase()
        localObserver = NotificationCenter.default.addObserver(
            forName: .opentodoLocalChanged, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.scheduleSync(after: 2.0) }
        }
        if isConfigured { syncNow() }
    }

    func stop() {
        if let localObserver { NotificationCenter.default.removeObserver(localObserver) }
        localObserver = nil
        debounce?.cancel()
    }

    // MARK: - 配对 / 断开

    /// 返回 nil 表示成功，否则返回错误文案。
    func pair(serverURL raw: String, ownerToken: String) async -> String? {
        guard let url = Self.normalizeURL(raw) else { return "服务器地址无效" }
        let owner = ownerToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !owner.isEmpty else { return "请填写站长口令" }
        do {
            let client = OpentodoSyncClient(baseURL: url)
            let deviceName = Host.current().localizedName ?? "Mac"
            let result = try await client.pair(ownerToken: owner, deviceName: deviceName)
            KeychainStore.saveSyncToken(result.deviceToken)
            token = result.deviceToken
            settings.syncURL = url.absoluteString
            settings.syncDeviceId = result.deviceId
            lastError = nil
            refreshPhase()
            syncNow()
            return nil
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            lastError = message
            phase = .failed(message)
            return message
        }
    }

    func disconnect() {
        KeychainStore.deleteSyncToken()
        token = nil
        settings.syncDeviceId = ""
        lastSyncAt = nil
        lastError = nil
        phase = .disabled
    }

    // MARK: - 同步

    func scheduleSync(after seconds: Double) {
        guard isConfigured else { return }
        debounce?.cancel()
        debounce = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.syncNow() }
        }
    }

    func syncNow() {
        guard isConfigured, let baseURL = serverURL, let token else { return }
        if inFlight {
            pendingAgain = true
            return
        }
        guard let snapshot = store.readLocalSnapshot() else {
            lastError = "本地数据无法读取，已跳过同步"
            phase = .failed("本地数据无法读取，已跳过同步")
            return
        }

        inFlight = true
        phase = .syncing
        lastError = nil
        let client = OpentodoSyncClient(baseURL: baseURL, token: token)
        let deviceId = settings.syncDeviceId

        Task { [weak self] in
            var retry = false
            do {
                let result = try await client.sync(state: snapshot.file, deviceId: deviceId)
                if !result.data.sameContent(as: snapshot.file) {
                    let wrote = self?.store.writeRemoteSnapshot(result.data, expectedRaw: snapshot.raw) ?? false
                    if wrote {
                        self?.store.load(force: true)
                    } else {
                        // 请求期间本地又改了：不要覆盖，稍后再合并一次。
                        retry = true
                    }
                }
                self?.lastSyncAt = Date()
                self?.phase = .idle
            } catch {
                let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                self?.lastError = message
                self?.phase = .failed(message)
                if let se = error as? SyncError, se.status == 401 || se.status == 403 {
                    self?.lastError = "设备令牌已失效，请在设置里重新配对"
                    self?.phase = .failed("设备令牌已失效，请重新配对")
                }
            }
            self?.inFlight = false
            let shouldRetry = retry || (self?.pendingAgain ?? false)
            self?.pendingAgain = false
            if shouldRetry { self?.syncNow() }
        }
    }

    // MARK: - Helpers

    private func refreshPhase() {
        phase = isConfigured ? .idle : .disabled
    }

    static func normalizeURL(_ raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "https://" + text }
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else { return nil }
        return url
    }
}
