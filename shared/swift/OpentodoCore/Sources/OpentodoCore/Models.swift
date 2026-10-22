import Foundation

// Opentodo 数据契约 v3。
// Mac / iOS 共用；字段与 mcp/lib/store.js 的 normalizeData 保持一致。

public struct TodoItem: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var content: String
    public var status: String
    public var priority: String
    public var project: String?
    public var list: String?
    public var archivedAt: String?
    public var order: Double
    public var createdAt: String?
    public var updatedAt: String?
    public var completedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, content, status, priority, project, list, archivedAt, order, createdAt, updatedAt, completedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        content = (try? c.decode(String.self, forKey: .content)) ?? ""
        status = (try? c.decode(String.self, forKey: .status)) ?? "pending"
        priority = (try? c.decode(String.self, forKey: .priority)) ?? "medium"
        project = (try? c.decodeIfPresent(String.self, forKey: .project)) ?? nil
        list = (try? c.decodeIfPresent(String.self, forKey: .list)) ?? nil
        archivedAt = (try? c.decodeIfPresent(String.self, forKey: .archivedAt)) ?? nil
        order = (try? c.decode(Double.self, forKey: .order)) ?? 0
        createdAt = (try? c.decodeIfPresent(String.self, forKey: .createdAt)) ?? nil
        updatedAt = (try? c.decodeIfPresent(String.self, forKey: .updatedAt)) ?? nil
        completedAt = (try? c.decodeIfPresent(String.self, forKey: .completedAt)) ?? nil
    }

    public init(
        id: String = UUID().uuidString,
        content: String,
        status: String = "pending",
        priority: String = "medium",
        project: String? = nil,
        list: String? = nil,
        archivedAt: String? = nil,
        order: Double = 0,
        createdAt: String? = nil,
        updatedAt: String? = nil,
        completedAt: String? = nil
    ) {
        self.id = id
        self.content = content
        self.status = status
        self.priority = priority
        self.project = project
        self.list = list
        self.archivedAt = archivedAt
        self.order = order
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.completedAt = completedAt
    }

    /// 默认项目名。旧数据中 `list == nil` 的条目读取时统一归入此项。
    public static let inboxName = "收件箱"

    public var isDone: Bool { status == "completed" }
    public var isActive: Bool { status == "pending" || status == "in_progress" }
    public var isArchived: Bool { archivedAt != nil }
    public var projectName: String { project ?? "未分组" }
    public var listName: String { list ?? Self.inboxName }
}

/// 已删除条目的墓碑：删除永远赢，避免旧客户端把条目推回来。
public struct TodoTombstone: Codable, Equatable, Sendable {
    public var id: String
    public var deletedAt: String
    public init(id: String, deletedAt: String) {
        self.id = id
        self.deletedAt = deletedAt
    }
}

public struct TodoListTombstone: Codable, Equatable, Sendable {
    public var name: String
    public var deletedAt: String
    public init(name: String, deletedAt: String) {
        self.name = name
        self.deletedAt = deletedAt
    }
}

public struct TodoListRename: Codable, Equatable, Sendable {
    public var from: String
    public var to: String
    public var at: String
    public init(from: String, to: String, at: String) {
        self.from = from
        self.to = to
        self.at = at
    }
}

public struct TodoFile: Codable, Sendable {
    public static let currentVersion = 3

    public var version: Int
    public var revision: Int
    public var updatedAt: String?
    public var items: [TodoItem]
    public var lists: [String]
    public var tombstones: [TodoTombstone]
    public var listTombstones: [TodoListTombstone]
    public var listRenames: [TodoListRename]
    public var listsUpdatedAt: String?

    enum CodingKeys: String, CodingKey {
        case version, revision, updatedAt, items, lists, tombstones, listTombstones, listRenames, listsUpdatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = (try? c.decode(Int.self, forKey: .version)) ?? 1
        revision = (try? c.decode(Int.self, forKey: .revision)) ?? 0
        updatedAt = (try? c.decodeIfPresent(String.self, forKey: .updatedAt)) ?? nil
        items = (try? c.decode([TodoItem].self, forKey: .items)) ?? []
        lists = (try? c.decode([String].self, forKey: .lists)) ?? []
        tombstones = (try? c.decode([TodoTombstone].self, forKey: .tombstones)) ?? []
        listTombstones = (try? c.decode([TodoListTombstone].self, forKey: .listTombstones)) ?? []
        listRenames = (try? c.decode([TodoListRename].self, forKey: .listRenames)) ?? []
        listsUpdatedAt = (try? c.decodeIfPresent(String.self, forKey: .listsUpdatedAt)) ?? nil
    }

    public init(
        version: Int = TodoFile.currentVersion,
        revision: Int = 0,
        updatedAt: String? = nil,
        items: [TodoItem] = [],
        lists: [String] = [],
        tombstones: [TodoTombstone] = [],
        listTombstones: [TodoListTombstone] = [],
        listRenames: [TodoListRename] = [],
        listsUpdatedAt: String? = nil
    ) {
        self.version = version
        self.revision = revision
        self.updatedAt = updatedAt
        self.items = items
        self.lists = lists
        self.tombstones = tombstones
        self.listTombstones = listTombstones
        self.listRenames = listRenames
        self.listsUpdatedAt = listsUpdatedAt
    }

    public static var empty: TodoFile { TodoFile() }

    /// 只比较实际数据（忽略 revision / updatedAt / 数组顺序等元数据）。
    public func sameContent(as other: TodoFile) -> Bool {
        func itemsKey(_ items: [TodoItem]) -> [String] {
            items.map { item in
                [
                    item.id, item.content, item.status, item.priority,
                    item.project ?? "", item.list ?? "", item.archivedAt ?? "",
                    String(item.order), item.createdAt ?? "", item.updatedAt ?? "",
                    item.completedAt ?? "",
                ].joined(separator: "\u{1f}")
            }.sorted()
        }
        let ts = tombstones.map { "\($0.id)|\($0.deletedAt)" }.sorted()
        let lts = listTombstones.map { "\($0.name)|\($0.deletedAt)" }.sorted()
        let lrs = listRenames.map { "\($0.from)|\($0.to)|\($0.at)" }.sorted()
        return itemsKey(items) == itemsKey(other.items)
            && lists == other.lists
            && ts == other.tombstones.map({ "\($0.id)|\($0.deletedAt)" }).sorted()
            && lts == other.listTombstones.map({ "\($0.name)|\($0.deletedAt)" }).sorted()
            && lrs == other.listRenames.map({ "\($0.from)|\($0.to)|\($0.at)" }).sorted()
    }
}

// MARK: - 规范化（与 Node 侧 normalizeData 对齐）

public enum TodoNormalize {
    public static func stamp(_ value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: value) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: value)
    }

    /// 应用项目改名、过滤墓碑、补全收件箱与条目所属项目。
    public static func normalize(_ raw: TodoFile) -> TodoFile {
        var file = raw
        file.version = TodoFile.currentVersion

        // 同一个旧名只保留最新一条(并发改名 LWW)，再按时间/文件顺序依次应用，
        // 这样 a→b→c 和 b→a 改回原名都能正确处理。
        let ordered = file.listRenames.enumerated()
            .filter { !$0.element.from.isEmpty && !$0.element.to.isEmpty && $0.element.from != $0.element.to }
            .sorted { lhs, rhs in
                let lt = stamp(lhs.element.at) ?? .distantPast
                let rt = stamp(rhs.element.at) ?? .distantPast
                return lt == rt ? lhs.offset < rhs.offset : lt < rt
            }
        var newest: [String: (index: Int, rename: TodoListRename)] = [:]
        for item in ordered {
            let at = stamp(item.element.at) ?? .distantPast
            if let prev = newest[item.element.from],
               (stamp(prev.rename.at) ?? .distantPast) > at { continue }
            newest[item.element.from] = (item.offset, item.element)
        }
        let steps = newest.values.sorted { lhs, rhs in
            let lt = stamp(lhs.rename.at) ?? .distantPast
            let rt = stamp(rhs.rename.at) ?? .distantPast
            return lt == rt ? lhs.index < rhs.index : lt < rt
        }.map(\.rename)
        func applyRename(_ name: String) -> String {
            var current = name
            for step in steps where step.from == current {
                current = step.to
            }
            return current
        }

        let deletedItems = Set(file.tombstones.map(\.id))
        let deletedLists = Set(file.listTombstones.map(\.name))

        file.items = file.items.compactMap { item in
            var item = item
            item.list = applyRename(item.listName)
            if deletedItems.contains(item.id) { return nil }
            if deletedLists.contains(item.listName) { return nil }
            return item
        }

        var lists: [String] = []
        var seen = Set<String>()
        for raw in file.lists {
            let name = applyRename(raw)
            guard !name.isEmpty, !deletedLists.contains(name), !seen.contains(name) else { continue }
            seen.insert(name)
            lists.append(name)
        }
        if lists.isEmpty {
            lists = [TodoItem.inboxName]
            seen.insert(TodoItem.inboxName)
        }
        for item in file.items where !seen.contains(item.listName) {
            seen.insert(item.listName)
            lists.append(item.listName)
        }
        file.lists = lists
        return file
    }
}
