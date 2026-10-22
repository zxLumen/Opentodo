import Foundation

struct ChatLine: Codable, Identifiable, Equatable {
    var id: String = UUID().uuidString
    var role: String
    var text: String

    enum CodingKeys: String, CodingKey { case role, text }
}

enum ChatEvent {
    case delta(String)
    case done(String)
    case error(String)
}

/// 复用 Web 服务端的 /api/chat（SSE）与对话记录接口。
struct ChatClient {
    let baseURL: URL
    let token: String

    func stream(messages: [ChatLine], list: String) -> AsyncThrowingStream<ChatEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var req = URLRequest(url: baseURL.appendingPathComponent("api/chat"))
                    req.httpMethod = "POST"
                    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                    req.httpBody = try JSONEncoder().encode(
                        ChatRequest(
                            messages: messages.map { ["role": $0.role, "content": $0.text] },
                            list: list
                        )
                    )
                    req.timeoutInterval = 180

                    let (bytes, response) = try await URLSession.shared.bytes(for: req)
                    guard let http = response as? HTTPURLResponse else {
                        throw ChatError(message: "无响应")
                    }
                    guard (200..<300).contains(http.statusCode) else {
                        var body = ""
                        for try await line in bytes.lines { body += line }
                        throw ChatError(message: body.isEmpty ? "HTTP \(http.statusCode)" : body)
                    }

                    for try await line in bytes.lines {
                        let trimmed = line.trimmingCharacters(in: .whitespaces)
                        guard trimmed.hasPrefix("data:") else { continue }
                        let payload = trimmed.dropFirst(5).trimmingCharacters(in: .whitespaces)
                        guard let data = payload.data(using: .utf8),
                              let event = try? JSONDecoder().decode(ChatEventWire.self, from: data) else { continue }
                        if let delta = event.delta, !delta.isEmpty {
                            continuation.yield(.delta(delta))
                        }
                        if event.done == true {
                            continuation.yield(.done(event.text ?? ""))
                        }
                        if let error = event.error {
                            continuation.yield(.error(error))
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func loadHistory() async throws -> [ChatLine] {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/chat/history"))
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw ChatError(message: "读取对话记录失败")
        }
        struct Resp: Decodable { let messages: [ChatLine] }
        return try JSONDecoder().decode(Resp.self, from: data).messages
    }

    func saveHistory(_ messages: [ChatLine]) async {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/chat/history"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        struct Body: Encodable { let messages: [ChatLine] }
        req.httpBody = try? JSONEncoder().encode(Body(messages: messages))
        _ = try? await URLSession.shared.data(for: req)
    }
}

private struct ChatRequest: Encodable {
    let messages: [[String: String]]
    let list: String
}

private struct ChatEventWire: Decodable {
    let delta: String?
    let done: Bool?
    let text: String?
    let error: String?
}

private struct ChatError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
