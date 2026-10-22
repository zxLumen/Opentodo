import Foundation
import OpentodoCore

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

    private let settings: SettingsStore

    init(settings: SettingsStore) {
        self.settings = settings
        phase = settings.isConfigured ? .idle : .disabled
    }

    var isConfigured: Bool { settings.isConfigured }

    func refreshPhase() {
        if !settings.isConfigured {
            phase = .disabled
        } else if case .failed = phase {
            // 保留错误，等下一次成功再清掉
        } else {
            phase = .idle
        }
    }

    /// 返回 nil 表示成功。
    func pair(serverURL: String, ownerToken: String, deviceName: String) async -> String? {
        guard let url = SettingsStore.baseURL(from: serverURL) else { return "服务器地址无效" }
        let token = ownerToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { return "请填写站长口令" }
        do {
            let client = OpentodoSyncClient(baseURL: url)
            let result = try await client.pair(ownerToken: token, deviceName: deviceName)
            settings.savePair(
                serverURL: url.absoluteString,
                deviceId: result.deviceId,
                deviceToken: result.deviceToken,
                deviceName: deviceName
            )
            phase = .idle
            return nil
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            phase = .failed(message)
            return message
        }
    }

    /// 把本地状态推给云端，返回合并后的权威状态。
    func push(_ state: TodoFile) async -> TodoFile? {
        guard let url = settings.baseURL, let token = settings.token, !settings.deviceId.isEmpty else {
            phase = .disabled
            return nil
        }
        phase = .syncing
        do {
            let client = OpentodoSyncClient(baseURL: url, token: token)
            let result = try await client.sync(state: state, deviceId: settings.deviceId)
            lastSyncAt = Date()
            phase = .idle
            return result.data
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            if let syncError = error as? SyncError, syncError.status == 401 || syncError.status == 403 {
                phase = .failed("设备令牌已失效，请在设置里重新配对")
            } else {
                phase = .failed(message)
            }
            return nil
        }
    }

    func devices() async throws -> [SyncDevice] {
        guard let url = settings.baseURL, let token = settings.token else { return [] }
        return try await OpentodoSyncClient(baseURL: url, token: token).devices()
    }

    func revoke(_ device: SyncDevice) async throws {
        guard let url = settings.baseURL, let token = settings.token else { return }
        try await OpentodoSyncClient(baseURL: url, token: token).revoke(deviceId: device.id)
    }

    func disconnect() {
        settings.disconnect()
        phase = .disabled
        lastSyncAt = nil
    }
}
