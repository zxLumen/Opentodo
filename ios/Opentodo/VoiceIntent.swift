import Foundation

enum VoiceAction: Equatable {
    case add(String)
    case complete(String)
    case remove(String)
    case archive(String)
    case reopen(String)

    var verb: String {
        switch self {
        case .add: return "添加"
        case .complete: return "完成"
        case .remove: return "删除"
        case .archive: return "归档"
        case .reopen: return "恢复"
        }
    }

    var query: String {
        switch self {
        case .add(let text), .complete(let text), .remove(let text),
             .archive(let text), .reopen(let text):
            return text
        }
    }
}

/// 语音转写后的本地意图解析（移植并扩展自 Mac 的 FastIntent）。
/// 原则：明确的动词才执行动作；否则一律当作一条新待办。
enum VoiceIntent {
    static func parse(_ raw: String) -> VoiceAction {
        let text = clean(raw)
        guard !text.isEmpty else { return .add("") }

        if let rest = capture(text, prefixes: ["彻底删除", "永久删除", "删除", "删掉", "移除", "去掉", "清除"]) {
            let q = strip(rest)
            if !q.isEmpty { return .remove(q) }
        }
        if let rest = capture(text, prefixes: ["取消归档", "取消完成", "重新打开", "恢复", "还原"]) {
            let q = strip(rest)
            if !q.isEmpty { return .reopen(q) }
        }
        if let rest = capture(text, prefixes: ["标记完成", "完成", "勾选", "搞定", "做完了"]) {
            let q = strip(rest)
            if !q.isEmpty { return .complete(q) }
        }
        if let rest = capture(text, prefixes: ["归档", "存档"]) {
            let q = strip(rest)
            if !q.isEmpty { return .archive(q) }
        }
        if let rest = capture(text, prefixes: [
            "帮我记一下", "帮我记一条", "帮我记", "记一下", "记一条",
            "添加待办", "新增待办", "添加一条", "新增一条", "加一条",
            "加个待办", "加一个待办", "提醒我", "添加", "新增",
        ]) {
            let q = strip(rest)
            if !q.isEmpty { return .add(q) }
        }

        // 没有动词/前缀：默认捕获成待办。
        return .add(strip(text))
    }

    private static func capture(_ text: String, prefixes: [String]) -> String? {
        for prefix in prefixes.sorted(by: { $0.count > $1.count }) where text.hasPrefix(prefix) {
            return String(text.dropFirst(prefix.count))
        }
        return nil
    }

    private static func strip(_ text: String) -> String {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // 去掉口语化的量词 / 连接词
        for prefix in ["一下", "一条", "一个", "个", "：", ":", "，", ",", "。", "、"] where s.hasPrefix(prefix) {
            s = String(s.dropFirst(prefix.count))
        }
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        s = s.trimmingCharacters(in: CharacterSet(charactersIn: "。！？!?，,；;、 "))
        return s
    }

    static func clean(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        s = s.replacingOccurrences(of: "\u{00a0}", with: " ")
        while s.contains("  ") { s = s.replacingOccurrences(of: "  ", with: " ") }
        return s
    }
}
