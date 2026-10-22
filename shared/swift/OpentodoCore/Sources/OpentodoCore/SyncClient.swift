import Foundation

/// 与 web/server.js 的多端同步接口对接。
public struct SyncPairResult: Codable, Sendable {
    public let deviceId: String
    public let deviceToken: String
    public let serverTime: String?
}

public struct SyncResult: Codable, Sendable {
    public let data: TodoFile
    public let revision: Int
    public let changed: Bool
    public let serverTime: String?
}

public struct SyncDevice: Codable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let createdAt: String?
    public let lastSeenAt: String?
}

public struct SyncError: Error, LocalizedError, Sendable {
    public let status: Int
    public let message: String
    public var errorDescription: String? { message }
}

/// 同步客户端。无状态、可并发创建；token 为空时只能配对。
public struct OpentodoSyncClient: Sendable {
    public let baseURL: URL
    public let token: String?
    private let session: URLSession

    public init(baseURL: URL, token: String? = nil, timeout: TimeInterval = 25) {
        self.baseURL = baseURL
        self.token = token
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = timeout
        cfg.timeoutIntervalForResource = timeout + 10
        cfg.waitsForConnectivity = false
        self.session = URLSession(configuration: cfg)
    }

    // MARK: - 配对

    public func pair(ownerToken: String, deviceName: String) async throws -> SyncPairResult {
        struct Body: Encodable { let ownerToken: String; let name: String }
        let data = try await post("api/devices/pair", body: Body(ownerToken: ownerToken, name: deviceName), auth: false)
        return try decode(SyncPairResult.self, from: data)
    }

    // MARK: - 同步

    public func sync(state: TodoFile, deviceId: String) async throws -> SyncResult {
        struct Body: Encodable {
            let deviceId: String
            let state: TodoFile
        }
        let data = try await post("api/sync", body: Body(deviceId: deviceId, state: state), auth: true)
        return try decode(SyncResult.self, from: data)
    }

    /// revision 未变化时返回 nil（服务端 304）。
    public func fetchState(since revision: Int? = nil) async throws -> TodoFile? {
        var path = "api/state"
        if let revision, revision > 0 { path += "?since=\(revision)" }
        var req = URLRequest(url: url(path))
        req.httpMethod = "GET"
        applyAuth(&req)
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw SyncError(status: -1, message: "无响应") }
        if http.statusCode == 304 { return nil }
        guard (200..<300).contains(http.statusCode) else {
            throw SyncError(status: http.statusCode, message: serverMessage(data) ?? "请求失败(\(http.statusCode))")
        }
        struct Resp: Decodable { let data: TodoFile }
        return try decode(Resp.self, from: data).data
    }

    public func devices() async throws -> [SyncDevice] {
        var req = URLRequest(url: url("api/devices"))
        req.httpMethod = "GET"
        applyAuth(&req)
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw SyncError(status: (resp as? HTTPURLResponse)?.statusCode ?? -1, message: serverMessage(data) ?? "读取设备失败")
        }
        struct Resp: Decodable { let devices: [SyncDevice] }
        return try decode(Resp.self, from: data).devices
    }

    public func revoke(deviceId: String) async throws {
        struct Body: Encodable { let id: String }
        _ = try await post("api/devices/revoke", body: Body(id: deviceId), auth: true)
    }

    // MARK: - 底层

    private func url(_ path: String) -> URL {
        if let q = path.firstIndex(of: "?") {
            let p = String(path[..<q])
            let query = String(path[path.index(after: q)...])
            var comps = URLComponents(url: baseURL.appendingPathComponent(p), resolvingAgainstBaseURL: false)
            comps?.percentEncodedQuery = query
            return comps?.url ?? baseURL
        }
        return baseURL.appendingPathComponent(path)
    }

    private func applyAuth(_ req: inout URLRequest) {
        if let token, !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
    }

    private func post<T: Encodable>(_ path: String, body: T, auth: Bool) async throws -> Data {
        var req = URLRequest(url: url(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if auth { applyAuth(&req) }
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw SyncError(status: -1, message: "无响应") }
        guard (200..<300).contains(http.statusCode) else {
            throw SyncError(status: http.statusCode, message: serverMessage(data) ?? "请求失败(\(http.statusCode))")
        }
        return data
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw SyncError(status: -2, message: "返回数据无法解析: \(error.localizedDescription)")
        }
    }

    private func serverMessage(_ data: Data) -> String? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return obj["error"] as? String
    }
}
