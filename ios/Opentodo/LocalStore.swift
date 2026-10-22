import Foundation
import OpentodoCore

/// iOS 本地镜像：离线优先，所有修改先落盘，再由 SyncService 合并到云端。
final class LocalStore {
    let fileURL: URL

    init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
            return
        }
        let fm = FileManager.default
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.temporaryDirectory
        let dir = base.appendingPathComponent("Opentodo", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        self.fileURL = dir.appendingPathComponent("todos.json")
    }

    func read() -> TodoFile {
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? JSONDecoder().decode(TodoFile.self, from: data) else {
            return TodoFile(version: TodoFile.currentVersion, updatedAt: Self.iso(), lists: [TodoItem.inboxName])
        }
        return TodoNormalize.normalize(decoded)
    }

    func snapshot() -> (file: TodoFile, raw: Data?)? {
        let fm = FileManager.default
        if !fm.fileExists(atPath: fileURL.path) {
            return (read(), nil)
        }
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? JSONDecoder().decode(TodoFile.self, from: data) else { return nil }
        return (TodoNormalize.normalize(decoded), data)
    }

    /// 同步结果写回：只有本地自读取后没变才覆盖，避免吞掉用户刚做的修改。
    @discardableResult
    func writeIfUnchanged(_ file: TodoFile, expectedRaw: Data?) -> Bool {
        let fm = FileManager.default
        var current: Data? = nil
        if fm.fileExists(atPath: fileURL.path) {
            current = try? Data(contentsOf: fileURL)
        }
        guard current == expectedRaw else { return false }
        var out = file
        out.version = TodoFile.currentVersion
        out.updatedAt = Self.iso()
        guard let data = try? Self.encode(out) else { return false }
        backup()
        do {
            try data.write(to: fileURL, options: .atomic)
            return true
        } catch {
            return false
        }
    }

    // MARK: - 本地修改

    @discardableResult
    private func mutate(_ body: (inout TodoFile) -> Void) -> TodoFile {
        // 文件存在但解析失败时拒绝写入，避免把损坏但可能可恢复的数据覆盖成空列表。
        let fm = FileManager.default
        var file: TodoFile
        if fm.fileExists(atPath: fileURL.path) {
            guard let data = try? Data(contentsOf: fileURL),
                  let decoded = try? JSONDecoder().decode(TodoFile.self, from: data) else {
                return read()
            }
            file = TodoNormalize.normalize(decoded)
        } else {
            file = read()
        }
        body(&file)
        file.version = TodoFile.currentVersion
        file.revision += 1
        file.updatedAt = Self.iso()
        file = TodoNormalize.normalize(file)
        if let data = try? Self.encode(file) {
            backup()
            try? data.write(to: fileURL, options: .atomic)
        }
        return file
    }

    func add(content: String, list: String, status: String = "pending", project: String? = nil) -> TodoFile {
        let text = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return read() }
        let now = Self.iso()
        return mutate { file in
            let target = list.isEmpty ? TodoItem.inboxName : list
            let maxOrder = file.items
                .filter { $0.listName == target && $0.project == project }
                .map(\.order).max() ?? 0
            file.items.append(TodoItem(
                id: UUID().uuidString,
                content: text,
                status: status == "in_progress" ? "in_progress" : "pending",
                priority: "medium",
                project: project,
                list: target,
                order: maxOrder + 1,
                createdAt: now,
                updatedAt: now,
                completedAt: nil
            ))
            let existed = file.lists.contains(target)
            let revived = file.listTombstones.contains { $0.name == target }
            file.listTombstones.removeAll { $0.name == target }
            if revived { file.listRenames.removeAll { $0.from == target || $0.to == target } }
            if !existed { file.lists.append(target) }
            if revived || !existed { file.listsUpdatedAt = now }
        }
    }

    func updateContent(id: String, content: String) -> TodoFile {
        let text = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return read() }
        return mutate { file in
            guard let i = file.items.firstIndex(where: { $0.id == id }) else { return }
            file.items[i].content = text
            file.items[i].updatedAt = Self.iso()
        }
    }

    func setStatus(id: String, status: String) -> TodoFile {
        let now = Self.iso()
        return mutate { file in
            guard let i = file.items.firstIndex(where: { $0.id == id }) else { return }
            file.items[i].status = status
            file.items[i].completedAt = status == "completed" ? now : nil
            file.items[i].updatedAt = now
        }
    }

    func toggle(id: String) -> TodoFile {
        let file = read()
        guard let item = file.items.first(where: { $0.id == id }) else { return file }
        return setStatus(id: id, status: item.isDone ? "pending" : "completed")
    }

    func setArchived(id: String, archived: Bool) -> TodoFile {
        let now = Self.iso()
        return mutate { file in
            guard let i = file.items.firstIndex(where: { $0.id == id }) else { return }
            file.items[i].archivedAt = archived ? now : nil
            file.items[i].updatedAt = now
        }
    }

    func remove(id: String) -> TodoFile {
        mutate { file in
            guard file.items.contains(where: { $0.id == id }) else { return }
            Self.addTombstone(&file, id: id)
            file.items.removeAll { $0.id == id }
        }
    }

    func archiveCompleted(list: String) -> TodoFile {
        let now = Self.iso()
        return mutate { file in
            for i in file.items.indices where file.items[i].listName == list
                && file.items[i].status == "completed" && file.items[i].archivedAt == nil {
                file.items[i].archivedAt = now
                file.items[i].updatedAt = now
            }
        }
    }

    func purgeArchived(list: String, allLists: Bool = false) -> TodoFile {
        mutate { file in
            for item in file.items where item.archivedAt != nil && (allLists || item.listName == list) {
                Self.addTombstone(&file, id: item.id)
            }
            file.items.removeAll { item in
                guard item.archivedAt != nil else { return false }
                return allLists || item.listName == list
            }
        }
    }

    func addList(name: String) -> TodoFile {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return read() }
        return mutate { file in
            let revived = file.listTombstones.contains { $0.name == trimmed }
            file.listTombstones.removeAll { $0.name == trimmed }
            if revived { file.listRenames.removeAll { $0.from == trimmed || $0.to == trimmed } }
            if !file.lists.contains(trimmed) { file.lists.append(trimmed) }
            file.listsUpdatedAt = Self.iso()
        }
    }

    func renameList(old: String, new: String) -> TodoFile {
        let trimmed = new.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, old != trimmed else { return read() }
        let now = Self.iso()
        return mutate { file in
            guard file.lists.contains(old), !file.lists.contains(trimmed) else { return }
            file.lists = file.lists.map { $0 == old ? trimmed : $0 }
            for i in file.items.indices where file.items[i].listName == old {
                file.items[i].list = trimmed
                file.items[i].updatedAt = now
            }
            file.listRenames.removeAll { $0.from == old }
            file.listRenames.append(TodoListRename(from: old, to: trimmed, at: now))
            Self.addListTombstone(&file, name: old, at: now)
            file.listTombstones.removeAll { $0.name == trimmed }
            file.listsUpdatedAt = now
        }
    }

    func deleteList(name: String) -> TodoFile {
        mutate { file in
            for item in file.items where item.listName == name {
                Self.addTombstone(&file, id: item.id)
            }
            file.lists.removeAll { $0 == name }
            file.items.removeAll { $0.listName == name }
            file.listRenames.removeAll { $0.from == name || $0.to == name }
            Self.addListTombstone(&file, name: name)
        }
    }

    func moveLists(ordered: [String]) -> TodoFile {
        mutate { file in
            let known = Set(file.lists)
            var next = ordered.filter { known.contains($0) }
            for name in file.lists where !next.contains(name) { next.append(name) }
            file.lists = next
            file.listsUpdatedAt = Self.iso()
        }
    }

    func reorder(orderedIds: [String]) -> TodoFile {
        let now = Self.iso()
        return mutate { file in
            var order: [String: Double] = [:]
            for (i, id) in orderedIds.enumerated() { order[id] = Double(i + 1) }
            for i in file.items.indices {
                if let value = order[file.items[i].id] {
                    file.items[i].order = value
                    file.items[i].updatedAt = now
                }
            }
        }
    }

    func move(id: String, toList list: String) -> TodoFile {
        let now = Self.iso()
        return mutate { file in
            guard let i = file.items.firstIndex(where: { $0.id == id }) else { return }
            let target = list.isEmpty ? TodoItem.inboxName : list
            let maxOrder = file.items.filter { $0.listName == target }.map(\.order).max() ?? 0
            file.items[i].list = target
            file.items[i].order = maxOrder + 1
            file.items[i].updatedAt = now
            let existed = file.lists.contains(target)
            let revived = file.listTombstones.contains { $0.name == target }
            file.listTombstones.removeAll { $0.name == target }
            if revived { file.listRenames.removeAll { $0.from == target || $0.to == target } }
            if !existed { file.lists.append(target) }
            if revived || !existed { file.listsUpdatedAt = now }
        }
    }

    /// 在同一个「项目(list)」内跨分组拖拽：把条目移到 `group`（nil = 未分组），
    /// 插到 `beforeId` 之前（nil = 该分组末尾），并把新旧分组的 order 重排为 1..n。
    /// 语义对齐 Web 的 ops.move / Mac 的 TodoStore.move。
    func moveToGroup(id: String, group: String?, beforeId: String?) -> TodoFile {
        let targetGroup = (group?.isEmpty ?? true) ? nil : group
        let now = Self.iso()
        return mutate { file in
            guard let movingIndex = file.items.firstIndex(where: { $0.id == id }) else { return }
            let list = file.items[movingIndex].listName
            let oldGroup = file.items[movingIndex].project
            guard oldGroup != targetGroup || beforeId != nil else { return }

            file.items[movingIndex].project = targetGroup
            file.items[movingIndex].updatedAt = now

            func sortedGroup(_ project: String?) -> [TodoItem] {
                file.items
                    .filter { $0.listName == list && $0.project == project && $0.id != id }
                    .sorted(by: Self.byOrder)
            }

            var target = sortedGroup(targetGroup)
            var insertAt = target.count
            if let beforeId, let at = target.firstIndex(where: { $0.id == beforeId }) {
                insertAt = at
            }
            target.insert(file.items[movingIndex], at: insertAt)
            for (n, item) in target.enumerated() {
                if let idx = file.items.firstIndex(where: { $0.id == item.id }) {
                    file.items[idx].order = Double(n + 1)
                }
            }

            if oldGroup != targetGroup {
                for (n, item) in sortedGroup(oldGroup).enumerated() {
                    if let idx = file.items.firstIndex(where: { $0.id == item.id }) {
                        file.items[idx].order = Double(n + 1)
                    }
                }
            }
        }
    }

    private static func byOrder(_ a: TodoItem, _ b: TodoItem) -> Bool {
        if a.order != b.order { return a.order < b.order }
        return (a.createdAt ?? "") < (b.createdAt ?? "")
    }

    #if DEBUG
    /// 仅 UI 测试使用：写入固定分组的数据，便于验证跨分组拖拽。
    func seedUITestGroups() {
        let now = Self.iso()
        func item(_ id: String, _ content: String, _ project: String, _ order: Double) -> TodoItem {
            TodoItem(
                id: id,
                content: content,
                status: "pending",
                priority: "medium",
                project: project,
                list: TodoItem.inboxName,
                order: order,
                createdAt: now,
                updatedAt: now
            )
        }
        let file = TodoFile(
            version: TodoFile.currentVersion,
            revision: 1,
            updatedAt: now,
            items: [
                item("alpha", "Alpha", "A", 1),
                item("bravo", "Bravo", "A", 2),
                item("charlie", "Charlie", "B", 1),
                item("delta", "Delta", "B", 2),
            ],
            lists: [TodoItem.inboxName],
            listsUpdatedAt: now
        )
        if let data = try? Self.encode(file) {
            try? data.write(to: fileURL, options: .atomic)
        }
    }
    #endif

    // MARK: - Helpers

    private func backup() {
        let bak = fileURL.appendingPathExtension("bak")
        let fm = FileManager.default
        guard fm.fileExists(atPath: fileURL.path) else { return }
        try? fm.removeItem(at: bak)
        try? fm.copyItem(at: fileURL, to: bak)
    }

    private static func encode(_ file: TodoFile) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
        return try encoder.encode(file)
    }

    private static func addTombstone(_ file: inout TodoFile, id: String, at: String = iso()) {
        if let i = file.tombstones.firstIndex(where: { $0.id == id }) {
            if at > file.tombstones[i].deletedAt { file.tombstones[i].deletedAt = at }
        } else {
            file.tombstones.append(TodoTombstone(id: id, deletedAt: at))
        }
    }

    private static func addListTombstone(_ file: inout TodoFile, name: String, at: String = iso()) {
        if let i = file.listTombstones.firstIndex(where: { $0.name == name }) {
            if at > file.listTombstones[i].deletedAt { file.listTombstones[i].deletedAt = at }
        } else {
            file.listTombstones.append(TodoListTombstone(name: name, deletedAt: at))
        }
        file.listsUpdatedAt = at
    }

    static func iso() -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date())
    }
}
