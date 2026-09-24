import Foundation

/// Read/write access to the shared Opentodo JSON file.
/// Uses an exclusive mkdir lock + atomic rename so it can coexist with the
/// MCP server and other clients writing the same file.
@MainActor
final class TodoStore: ObservableObject {
    @Published private(set) var items: [TodoItem] = []
    @Published private(set) var lists: [String] = []
    @Published private(set) var revision: Int = 0
    @Published var lastError: String?

    let fileURL: URL
    private var watcher: DirectoryWatcher?
    private var hasLoaded = false

    private enum Keys {
        static let activeList = "opentodo.activeList"
    }

    static let shared = TodoStore()

    @Published var currentList: String? {
        didSet {
            UserDefaults.standard.set(currentList ?? "", forKey: Keys.activeList)
            writeActiveFile()
        }
    }

    init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
        } else if let env = ProcessInfo.processInfo.environment["OPENTODO_FILE"], !env.isEmpty {
            self.fileURL = URL(fileURLWithPath: env)
        } else {
            let home = FileManager.default.homeDirectoryForCurrentUser
            self.fileURL = home.appendingPathComponent(".config/opentodo/todos.json")
        }
        let saved = UserDefaults.standard.string(forKey: Keys.activeList) ?? ""
        self.currentList = saved.isEmpty ? nil : saved
    }

    func start() {
        load(force: true)
        watcher = DirectoryWatcher(url: fileURL.deletingLastPathComponent()) { [weak self] in
            self?.load(force: false)
        }
        watcher?.start()
    }

    func load(force: Bool) {
        guard let data = try? Data(contentsOf: fileURL) else {
            if force {
                items = []
                lists = []
                revision = 0
                hasLoaded = true
            }
            return
        }
        guard let file = try? JSONDecoder().decode(TodoFile.self, from: data) else { return }
        if force || !hasLoaded || file.revision != revision {
            items = file.items
            lists = Self.mergedLists(file)
            revision = file.revision
            hasLoaded = true
            writeActiveFile()
        }
    }

    /// 条目中出现的项目若不在 lists 注册表里（例如 agent 通过 update 直接改 list），
    /// 读文件时自动并入，使项目立刻可见；下次写入时一并落盘。
    nonisolated static func mergedLists(_ file: TodoFile) -> [String] {
        var seen = Set(file.lists)
        var merged = file.lists
        let itemLists = file.items.compactMap(\.list).filter { !$0.isEmpty }
        for name in itemLists where !seen.contains(name) {
            seen.insert(name)
            merged.append(name)
        }
        return merged
    }

    /// True when the file on disk predates schema v2; bumped lazily on the
    /// next write so reads never clobber anything.
    nonisolated private static func migrate(_ file: inout TodoFile) {
        if file.version < TodoFile.currentVersion {
            file.version = TodoFile.currentVersion
        }
    }

    // MARK: - Mutations

    func add(content: String, priority: String = "medium", project: String? = nil, list: String? = nil) {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        // 预生成，保证 transform 可重复执行（乐观更新 + 后台落盘各一次）。
        let newID = UUID().uuidString
        let created = Self.iso()
        persist { file in
            let nextOrder = file.items
                .filter { $0.project == project && $0.list == list }
                .map(\.order).max() ?? 0
            file.items.append(TodoItem(
                id: newID,
                content: trimmed,
                priority: priority,
                project: (project?.isEmpty ?? true) ? nil : project,
                list: (list?.isEmpty ?? true) ? nil : list,
                order: nextOrder + 1,
                createdAt: created
            ))
        }
    }

    func update(_ item: TodoItem) {
        persist { file in
            guard let idx = file.items.firstIndex(where: { $0.id == item.id }) else { return }
            var next = item
            next.updatedAt = Self.iso()
            if next.status == "completed" {
                if next.completedAt == nil { next.completedAt = Self.iso() }
            } else {
                next.completedAt = nil
            }
            file.items[idx] = next
        }
    }

    func remove(id: String) {
        persist { file in
            file.items.removeAll { $0.id == id }
        }
    }

    /// 把（当前项目内）已完成的待办全部移入归档；cancelled 维持现状。
    func archiveCompleted() {
        let cl = currentList
        persist { file in
            for i in file.items.indices where file.items[i].status == "completed" && file.items[i].list == cl && file.items[i].archivedAt == nil {
                file.items[i].archivedAt = Self.iso()
                file.items[i].updatedAt = Self.iso()
            }
        }
    }

    /// 归档单条（一般为已完成项）。
    func archive(id: String) {
        persist { file in
            guard let idx = file.items.firstIndex(where: { $0.id == id }) else { return }
            file.items[idx].archivedAt = Self.iso()
            file.items[idx].updatedAt = Self.iso()
        }
    }

    func unarchive(id: String) {
        persist { file in
            guard let idx = file.items.firstIndex(where: { $0.id == id }) else { return }
            file.items[idx].archivedAt = nil
            file.items[idx].updatedAt = Self.iso()
        }
    }

    /// 恢复当前项目的全部归档条目（清 archivedAt，status 保持不变）。
    func restoreArchived() {
        let cl = currentList
        persist { file in
            for i in file.items.indices where file.items[i].archivedAt != nil && file.items[i].list == cl {
                file.items[i].archivedAt = nil
                file.items[i].updatedAt = Self.iso()
            }
        }
    }

    /// 彻底删除（仅归档不可恢复；未归档条目请用 remove）。
    func purge(id: String) {
        persist { file in
            file.items.removeAll { $0.id == id }
        }
    }

    /// 清空当前项目的归档（彻底删除，不可恢复；归档不属任何项目，scope=all 时清理全部）。
    func purgeArchived(allLists: Bool = false) {
        let cl = currentList
        persist { file in
            file.items.removeAll { it in
                guard it.archivedAt != nil else { return false }
                return allLists || it.list == cl
            }
        }
    }

    // MARK: - Projects (lists)

    var listNames: [String] {
        var names = [TodoItem.inboxName]
        names.append(contentsOf: lists.filter { !$0.isEmpty })
        return names
    }

    func addList(name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != TodoItem.inboxName else { return }
        persist { file in
            guard !file.lists.contains(trimmed) else { return }
            file.lists.append(trimmed)
        }
    }

    func renameList(oldName: String, to newName: String) {
        let trimmed = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != TodoItem.inboxName, oldName != trimmed else { return }
        persist { file in
            guard let idx = file.lists.firstIndex(of: oldName) else { return }
            if file.lists.contains(trimmed) { return }
            file.lists[idx] = trimmed
            for i in file.items.indices where file.items[i].list == oldName {
                file.items[i].list = trimmed
            }
        }
        if currentList == oldName { currentList = trimmed }
    }

    /// 删除项目：其下条目安全移回收件箱（nil），不丢数据。
    func deleteList(name: String) {
        persist { file in
            file.lists.removeAll { $0 == name }
            for i in file.items.indices where file.items[i].list == name {
                file.items[i].list = nil
            }
        }
        if currentList == name { currentList = nil }
    }

    /// 调整项目顺序（左侧栏拖拽重排）。语义同 `Array.move(fromOffsets:toOffset:)`。
    func moveLists(fromOffsets: IndexSet, toOffset: Int) {
        persist { file in
            let moving = fromOffsets.compactMap { $0 < file.lists.count ? file.lists[$0] : nil }
            guard !moving.isEmpty else { return }
            for i in fromOffsets.sorted(by: >) where i < file.lists.count {
                file.lists.remove(at: i)
            }
            var insertAt = toOffset
            for i in fromOffsets where i < toOffset { insertAt -= 1 }
            insertAt = max(0, min(insertAt, file.lists.count))
            file.lists.insert(contentsOf: moving, at: insertAt)
        }
    }

    func toggle(_ item: TodoItem) {
        var next = item
        next.status = item.isDone ? "pending" : "completed"
        update(next)
    }

    func reorder(orderedIds: [String]) {
        persist { file in
            var orderById: [String: Double] = [:]
            for (i, id) in orderedIds.enumerated() { orderById[id] = Double(i + 1) }
            for i in file.items.indices {
                if let o = orderById[file.items[i].id] { file.items[i].order = o }
            }
        }
    }

    /// 把条目移动到另一个项目（list）；nil = 收件箱。子分组 `project` 保持不变，
    /// order 置为目标列表末尾。目标列表会在写入时经 `mergedLists` 自动登记。
    func moveToList(id: String, to list: String?) {
        persist { file in
            guard let idx = file.items.firstIndex(where: { $0.id == id }) else { return }
            guard file.items[idx].list != list else { return }
            let maxOrder = file.items.filter { $0.list == list }.map(\.order).max() ?? 0
            file.items[idx].list = list
            file.items[idx].order = maxOrder + 1
            file.items[idx].updatedAt = Self.iso()
        }
    }

    /// 调整项目在注册表中的顺序（决定左侧栏显示顺序）。`before` 为 nil 时移到末尾。
    func moveList(name: String, before: String?) {
        persist { file in
            guard let from = file.lists.firstIndex(of: name) else { return }
            file.lists.remove(at: from)
            if let before, let to = file.lists.firstIndex(of: before) {
                file.lists.insert(name, at: to)
            } else {
                file.lists.append(name)
            }
        }
    }

    /// Move an item onto `project` within its own list and insert it right
    /// before `beforeId` (nil appends at the end of the target group). Orders
    /// are renumbered 1..n within the affected groups. "未分组" maps to
    /// project == nil. The item never leaves its list here; crossing projects
    /// happens through `update` / the agent (which sets `list` directly).
    func move(id: String, toProject project: String?, beforeId: String? = nil) {
        persist { file in
            guard let movingIdx = file.items.firstIndex(where: { $0.id == id }) else { return }
            let moving = file.items[movingIdx]
            let list = moving.list
            let oldProject = moving.project
            let targetProject: String? = (project == "未分组" || (project?.isEmpty ?? false)) ? nil : project
            guard oldProject != targetProject || beforeId != nil else { return }

            var next = moving
            next.project = targetProject
            next.updatedAt = Self.iso()
            file.items.remove(at: movingIdx)

            var group = file.items
                .enumerated()
                .filter { $0.element.project == targetProject && $0.element.list == list }
                .map(\.element)
                .sorted { a, b -> Bool in
                    if a.order != b.order { return a.order < b.order }
                    return (a.createdAt ?? "") < (b.createdAt ?? "")
                }
            let at = beforeId.flatMap { id in group.firstIndex(where: { $0.id == id }) } ?? group.endIndex
            group.insert(next, at: at)
            for i in group.indices { group[i].order = Double(i + 1) }

            var oldGroup = file.items
                .enumerated()
                .filter { $0.element.project == oldProject && $0.element.list == list }
                .map(\.element)
                .sorted { a, b -> Bool in
                    if a.order != b.order { return a.order < b.order }
                    return (a.createdAt ?? "") < (b.createdAt ?? "")
                }
            for i in oldGroup.indices { oldGroup[i].order = Double(i + 1) }

            file.items.removeAll { $0.project == targetProject && $0.list == list }
            file.items.append(contentsOf: group)
            if let oldProject, oldProject != targetProject {
                file.items.removeAll { $0.project == oldProject && $0.list == list }
                file.items.append(contentsOf: oldGroup)
            }
        }
    }

    // MARK: - Persistence

    private let ioQueue = DispatchQueue(label: "app.opentodo.io")
    private var isSelftest: Bool {
        ProcessInfo.processInfo.environment["OPENTODO_SELFTEST"] == "1"
    }

    private enum PersistOutcome {
        case success(items: [TodoItem], lists: [String], revision: Int)
        case failure(String)
    }

    /// 应用一次变更：先在主线程乐观更新内存（UI 立即响应），
    /// 磁盘 I/O（抢锁/读/编码/备份/原子写）放到后台串行队列完成后再对齐。
    private func persist(_ transform: @escaping (inout TodoFile) -> Void) {
        let preSnapshot = snapshotState()
        if isSelftest {
            applyOutcome(Self.performPersist(fileURL: fileURL, snapshot: preSnapshot, transform: transform))
            return
        }

        // 1) 乐观更新内存，保证拖拽/勾选即时反馈
        var optimistic = TodoFile(
            version: TodoFile.currentVersion,
            revision: preSnapshot.revision,
            updatedAt: Self.iso(),
            items: preSnapshot.items,
            lists: preSnapshot.lists
        )
        transform(&optimistic)
        Self.migrate(&optimistic)
        optimistic.lists = Self.mergedLists(optimistic)
        optimistic.revision += 1
        optimistic.updatedAt = Self.iso()
        items = optimistic.items
        lists = optimistic.lists
        revision = optimistic.revision
        hasLoaded = true
        writeActiveFile()

        // 2) 后台落盘（重新读取以保留其它客户端的改动）
        let fileURL = self.fileURL
        ioQueue.async { [weak self] in
            let outcome = Self.performPersist(fileURL: fileURL, snapshot: preSnapshot, transform: transform)
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.applyOutcome(outcome) }
            }
        }
    }

    private func snapshotState() -> (items: [TodoItem], lists: [String], revision: Int) {
        (items, lists, revision)
    }

    private func applyOutcome(_ outcome: PersistOutcome) {
        switch outcome {
        case .success(let newItems, let newLists, let newRevision):
            // 乐观更新已把 revision 推到同一个值（无外部改动）时跳过，
            // 避免同一次操作触发两轮列表刷新造成卡顿。
            if newRevision == revision { return }
            items = newItems
            lists = newLists
            revision = newRevision
            hasLoaded = true
            lastError = nil
            writeActiveFile()
        case .failure(let message):
            lastError = message
        }
    }

    /// 纯函数式的一次「抢锁 → 读 → 变换 → 写」，可在任意线程执行。
    nonisolated private static func performPersist(
        fileURL: URL,
        snapshot: (items: [TodoItem], lists: [String], revision: Int),
        transform: (inout TodoFile) -> Void
    ) -> PersistOutcome {
        withLock(fileURL: fileURL) {
            let fm = FileManager.default
            var file: TodoFile

            if fm.fileExists(atPath: fileURL.path) {
                // 文件存在：必须能解析，否则拒写以保护用户数据。
                guard let data = try? Data(contentsOf: fileURL),
                      let decoded = try? JSONDecoder().decode(TodoFile.self, from: data) else {
                    return .failure("数据文件无法解析，已放弃写入以保护数据")
                }
                file = decoded
            } else {
                // 文件被外部删除：以内存快照重建，绝不用空列表覆盖。
                file = TodoFile(
                    version: TodoFile.currentVersion,
                    revision: snapshot.revision,
                    updatedAt: iso(),
                    items: snapshot.items,
                    lists: snapshot.lists
                )
            }

            transform(&file)
            migrate(&file)
            file.lists = mergedLists(file)
            file.revision += 1
            file.updatedAt = iso()

            do {
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
                let data = try encoder.encode(file)
                backup(fileURL: fileURL)
                try writeAtomic(fileURL: fileURL, data: data)
                return .success(items: file.items, lists: file.lists, revision: file.revision)
            } catch {
                return .failure("保存失败: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Active project pointer (read by the opencode plugin)

    private var activeFileURL: URL {
        fileURL.deletingLastPathComponent().appendingPathComponent(".active")
    }

    private var lastActiveWritten: String?

    private func writeActiveFile() {
        let value = currentList ?? ""
        // 内容没变就不写，避免每次增删改都触发一次磁盘写与文件监听。
        guard value != lastActiveWritten else { return }
        lastActiveWritten = value
        let url = activeFileURL
        let dir = url.deletingLastPathComponent()
        let text = value.isEmpty ? "" : value + "\n"
        ioQueue.async {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try? text.write(to: url, atomically: true, encoding: .utf8)
        }
    }

    /// Keep the last good copy next to the data file before every write.
    nonisolated private static func backup(fileURL: URL) {
        let fm = FileManager.default
        guard fm.fileExists(atPath: fileURL.path) else { return }
        let bak = fileURL.appendingPathExtension("bak")
        try? fm.removeItem(at: bak)
        try? fm.copyItem(at: fileURL, to: bak)
    }

    nonisolated private static func writeAtomic(fileURL: URL, data: Data) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let tmp = fileURL.deletingLastPathComponent()
            .appendingPathComponent(".todos-\(UUID().uuidString).tmp")
        try data.write(to: tmp)
        if fm.fileExists(atPath: fileURL.path) {
            _ = try fm.replaceItemAt(fileURL, withItemAt: tmp)
        } else {
            try fm.moveItem(at: tmp, to: fileURL)
        }
    }

    nonisolated private static func withLock<T>(fileURL: URL, _ body: () -> T) -> T {
        let fm = FileManager.default
        let lockDir = fileURL.path + ".lock"
        try? fm.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        var acquired = false
        for _ in 0..<200 {
            do {
                try fm.createDirectory(atPath: lockDir, withIntermediateDirectories: false)
                acquired = true
                break
            } catch {
                Thread.sleep(forTimeInterval: 0.025)
            }
        }
        defer { if acquired { try? fm.removeItem(atPath: lockDir) } }
        return body()
    }

    nonisolated static func iso() -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date())
    }
}
