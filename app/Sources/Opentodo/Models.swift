import Foundation

struct TodoItem: Codable, Identifiable, Equatable {
    var id: String
    var content: String
    var status: String
    var priority: String
    var project: String?
    var list: String?
    var archivedAt: String?
    var order: Double
    var createdAt: String?
    var updatedAt: String?
    var completedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, content, status, priority, project, list, archivedAt, order, createdAt, updatedAt, completedAt
    }

    init(from decoder: Decoder) throws {
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

    init(
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
    static let inboxName = "收件箱"

    var isDone: Bool { status == "completed" }
    var isActive: Bool { status == "pending" || status == "in_progress" }
    var isArchived: Bool { archivedAt != nil }
    var projectName: String { project ?? "未分组" }
    var listName: String { list ?? Self.inboxName }
}

struct TodoFile: Codable {
    static let currentVersion = 2

    var version: Int
    var revision: Int
    var updatedAt: String?
    var items: [TodoItem]
    var lists: [String]

    enum CodingKeys: String, CodingKey { case version, revision, updatedAt, items, lists }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = (try? c.decode(Int.self, forKey: .version)) ?? 1
        revision = (try? c.decode(Int.self, forKey: .revision)) ?? 0
        updatedAt = (try? c.decodeIfPresent(String.self, forKey: .updatedAt)) ?? nil
        items = (try? c.decode([TodoItem].self, forKey: .items)) ?? []
        lists = (try? c.decode([String].self, forKey: .lists)) ?? []
    }

    init(version: Int = TodoFile.currentVersion, revision: Int = 0, updatedAt: String? = nil, items: [TodoItem] = [], lists: [String] = []) {
        self.version = version
        self.revision = revision
        self.updatedAt = updatedAt
        self.items = items
        self.lists = lists
    }

    static var empty: TodoFile { TodoFile() }
}
