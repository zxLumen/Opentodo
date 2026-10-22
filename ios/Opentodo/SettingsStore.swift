import Foundation
import Security
import OpentodoCore

enum Keychain {
    private static let service = "com.opentodo.ios.sync"

    private static var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "device",
        ]
    }

    static func loadToken() -> String? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func saveToken(_ token: String) {
        guard !token.isEmpty else {
            deleteToken()
            return
        }
        let data = Data(token.utf8)
        if loadToken() != nil {
            SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        } else {
            var q = query
            q[kSecValueData as String] = data
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(q as CFDictionary, nil)
        }
    }

    static func deleteToken() {
        SecItemDelete(query as CFDictionary)
    }
}

@MainActor
final class SettingsStore: ObservableObject {
    static let shared = SettingsStore()

    private let d = UserDefaults.standard
    private enum Keys {
        static let serverURL = "opentodo.ios.serverURL"
        static let deviceId = "opentodo.ios.deviceId"
        static let deviceName = "opentodo.ios.deviceName"
        static let currentList = "opentodo.ios.currentList"
    }

    @Published var serverURL: String { didSet { d.set(serverURL, forKey: Keys.serverURL) } }
    @Published var deviceId: String { didSet { d.set(deviceId, forKey: Keys.deviceId) } }
    @Published var currentList: String { didSet { d.set(currentList, forKey: Keys.currentList) } }
    @Published private(set) var token: String?

    init() {
        serverURL = d.string(forKey: Keys.serverURL) ?? ""
        deviceId = d.string(forKey: Keys.deviceId) ?? ""
        currentList = d.string(forKey: Keys.currentList) ?? TodoItem.inboxName
        token = Keychain.loadToken()
    }

    var isConfigured: Bool {
        !serverURL.isEmpty && !deviceId.isEmpty && token != nil
    }

    var baseURL: URL? {
        Self.baseURL(from: serverURL)
    }

    static func baseURL(from raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "https://" + text }
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else { return nil }
        return url
    }

    var deviceName: String {
        d.string(forKey: Keys.deviceName) ?? "iPhone"
    }

    func savePair(serverURL: String, deviceId: String, deviceToken: String, deviceName: String) {
        var text = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.contains("://") { text = "https://" + text }
        self.serverURL = text
        self.deviceId = deviceId
        self.currentList = currentList.isEmpty ? TodoItem.inboxName : currentList
        Keychain.saveToken(deviceToken)
        token = deviceToken
        d.set(deviceName, forKey: Keys.deviceName)
    }

    func disconnect() {
        Keychain.deleteToken()
        token = nil
        deviceId = ""
    }
}
