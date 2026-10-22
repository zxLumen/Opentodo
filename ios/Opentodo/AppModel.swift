import Foundation
import Combine
import OpentodoCore

enum TodoSegment: String, CaseIterable, Identifiable {
    case pending = "待办"
    case inProgress = "进行中"
    case completed = "已完成"
    case archived = "归档"

    var id: String { rawValue }
}

struct TodoSection: Identifiable {
    let title: String
    let items: [TodoItem]
    var id: String { title }
}

enum VoiceOutcome {
    case done(String)
    case choose(VoiceAction, [TodoItem])
    case notFound(String)
}

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var file: TodoFile
    @Published var currentList: String
    @Published var segment: TodoSegment = .pending
    @Published var toast: String?
    @Published private(set) var syncing = false

    let local: LocalStore
    let settings: SettingsStore
    let sync: SyncService

    private var debounce: Task<Void, Never>?
    private var toastTask: Task<Void, Never>?
    private var cancellables = Set<AnyCancellable>()

    init() {
        let local = LocalStore()
        let settings = SettingsStore.shared

        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-UITestSeedGroups") {
            local.seedUITestGroups()
            settings.currentList = TodoItem.inboxName
        }
        #endif

        self.local = local
        self.settings = settings
        self.sync = SyncService(settings: settings)
        self.file = local.read()
        self.currentList = settings.currentList
        if !file.lists.contains(currentList) {
            currentList = file.lists.first ?? TodoItem.inboxName
        }
        sync.objectWillChange
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)

        #if DEBUG
        // 开发/自动化验证用：从启动环境变量自动配对，不参与发布逻辑。
        let env = ProcessInfo.processInfo.environment
        if !sync.isConfigured,
           let url = env["OPENTODO_SYNC_URL"],
           let owner = env["OPENTODO_OWNER_TOKEN"] {
            Task {
                if await sync.pair(serverURL: url, ownerToken: owner, deviceName: "iOS Simulator") == nil {
                    syncNow()
                }
            }
        }
        #endif
    }

    // MARK: - 读取

    var lists: [String] { file.lists }

    var currentItems: [TodoItem] {
        file.items.filter { $0.listName == currentList }
    }

    func count(for list: String) -> Int {
        file.items.filter { $0.listName == list && $0.isActive && !$0.isArchived }.count
    }

    var sections: [TodoSection] {
        let all = currentItems
        var groups: [String: [TodoItem]] = [:]

        func add(_ items: [TodoItem]) {
            for item in items {
                groups[item.projectName, default: []].append(item)
            }
        }

        switch segment {
        case .pending:
            add(all.filter { $0.status == "pending" && !$0.isArchived })
            let cancelled = all.filter { $0.status == "cancelled" && !$0.isArchived }
            var out = sortedGroups(groups)
            if !cancelled.isEmpty {
                out.append(TodoSection(title: "已取消", items: cancelled.sorted(by: Self.byOrder)))
            }
            return out
        case .inProgress:
            add(all.filter { $0.status == "in_progress" && !$0.isArchived })
        case .completed:
            add(all.filter { $0.status == "completed" && !$0.isArchived })
        case .archived:
            add(all.filter { $0.isArchived })
        }
        return sortedGroups(groups)
    }

    private func sortedGroups(_ groups: [String: [TodoItem]]) -> [TodoSection] {
        groups.keys
            .sorted { a, b in
                if a == "未分组" { return true }
                if b == "未分组" { return false }
                return a.localizedStandardCompare(b) == .orderedAscending
            }
            .map { TodoSection(title: $0, items: groups[$0]!.sorted(by: Self.byOrder)) }
    }

    private static func byOrder(_ a: TodoItem, _ b: TodoItem) -> Bool {
        if a.order != b.order { return a.order < b.order }
        return (a.createdAt ?? "") < (b.createdAt ?? "")
    }

    // MARK: - 本地修改

    func reload() {
        file = local.read()
        if !file.lists.contains(currentList) {
            currentList = file.lists.first ?? TodoItem.inboxName
        }
        settings.currentList = currentList
    }

    func add(_ text: String, status: String = "pending") {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        file = local.add(content: trimmed, list: currentList, status: status)
        afterLocalChange()
    }

    func add(to list: String, text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        file = local.add(content: trimmed, list: list)
        afterLocalChange()
    }

    func toggle(_ item: TodoItem) {
        file = local.toggle(id: item.id)
        afterLocalChange()
    }

    func start(_ item: TodoItem) {
        file = local.setStatus(id: item.id, status: "in_progress")
        afterLocalChange()
    }

    func cancel(_ item: TodoItem) {
        file = local.setStatus(id: item.id, status: "cancelled")
        afterLocalChange()
    }

    func reopen(_ item: TodoItem) {
        file = local.setStatus(id: item.id, status: "pending")
        afterLocalChange()
    }

    func archive(_ item: TodoItem) {
        file = local.setArchived(id: item.id, archived: true)
        afterLocalChange()
    }

    func unarchive(_ item: TodoItem) {
        file = local.setArchived(id: item.id, archived: false)
        afterLocalChange()
    }

    func delete(_ item: TodoItem) {
        file = local.remove(id: item.id)
        afterLocalChange()
        showToast("已删除")
    }

    func updateContent(_ item: TodoItem, content: String) {
        file = local.updateContent(id: item.id, content: content)
        afterLocalChange()
    }

    func move(item: TodoItem, to list: String) {
        file = local.move(id: item.id, toList: list)
        afterLocalChange()
    }

    /// 同项目内拖到另一个分组（`group == nil` = 未分组）。
    /// `beforeId == nil` 表示放到目标分组末尾。
    @discardableResult
    func moveToGroup(id: String, to group: String?, beforeId: String?) -> Bool {
        guard let item = file.items.first(where: { $0.id == id }),
              item.listName == currentList else { return false }
        file = local.moveToGroup(id: id, group: group, beforeId: beforeId)
        afterLocalChange()
        return true
    }

    func archiveCompleted() {
        file = local.archiveCompleted(list: currentList)
        afterLocalChange()
        showToast("已把完成的待办移入归档")
    }

    func purgeArchived() {
        file = local.purgeArchived(list: currentList)
        afterLocalChange()
        showToast("已清空归档")
    }

    func addList(_ name: String) {
        file = local.addList(name: name)
        currentList = name.trimmingCharacters(in: .whitespacesAndNewlines)
        settings.currentList = currentList
        afterLocalChange()
    }

    func renameList(_ old: String, to new: String) {
        file = local.renameList(old: old, new: new)
        if currentList == old { currentList = new }
        settings.currentList = currentList
        afterLocalChange()
    }

    func deleteList(_ name: String) {
        file = local.deleteList(name: name)
        if currentList == name { currentList = file.lists.first ?? TodoItem.inboxName }
        settings.currentList = currentList
        afterLocalChange()
    }

    func moveLists(from source: IndexSet, to destination: Int) {
        var next = file.lists
        next.move(fromOffsets: source, toOffset: destination)
        file = local.moveLists(ordered: next)
        afterLocalChange()
    }

    func selectList(_ name: String) {
        currentList = name
        settings.currentList = name
    }

    private func afterLocalChange() {
        scheduleSync()
    }

    // MARK: - 同步

    func scheduleSync(after seconds: Double = 1.5) {
        guard sync.isConfigured else { return }
        debounce?.cancel()
        debounce = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.syncNow() }
        }
    }

    func syncNow() {
        guard sync.isConfigured, !syncing, let snapshot = local.snapshot() else { return }
        syncing = true
        Task { [weak self] in
            guard let self else { return }
            if let merged = await sync.push(snapshot.file) {
                if merged.sameContent(as: snapshot.file) {
                    // 云端没有新内容
                } else if local.writeIfUnchanged(merged, expectedRaw: snapshot.raw) {
                    reload()
                } else {
                    scheduleSync(after: 0.5)
                }
            }
            syncing = false
        }
    }

    func refresh() async {
        syncNow()
        // 给同步一点时间完成，下拉刷新手势随即结束。
        try? await Task.sleep(nanoseconds: 400_000_000)
    }

    // MARK: - 语音

    func handleVoice(_ text: String) -> VoiceOutcome {
        let action = VoiceIntent.parse(text)
        switch action {
        case .add(let content):
            guard !content.isEmpty else { return .notFound("没有听清，请再说一次") }
            file = local.add(content: content, list: currentList)
            afterLocalChange()
            return .done("已添加：\(content)")
        default:
            break
        }

        let query = action.query.lowercased()
        let pool = file.items.filter { item in
            switch action {
            case .reopen:
                return item.isArchived || item.isDone
            default:
                return !item.isArchived
            }
        }
        let matches = pool.filter { item in
            let content = item.content.lowercased()
            return content.contains(query) || query.contains(content)
        }

        if matches.isEmpty {
            return .notFound("没找到「\(action.query)」")
        }
        if matches.count == 1 {
            return .done(apply(action, to: matches[0]))
        }
        return .choose(action, Array(matches.prefix(8)))
    }

    func commitVoice(_ action: VoiceAction, item: TodoItem) -> String {
        apply(action, to: item)
    }

    private func apply(_ action: VoiceAction, to item: TodoItem) -> String {
        switch action {
        case .add:
            return "已添加"
        case .complete:
            if item.isDone { return "「\(item.content)」已经完成了" }
            file = local.setStatus(id: item.id, status: "completed")
            afterLocalChange()
            return "已完成：\(item.content)"
        case .remove:
            file = local.remove(id: item.id)
            afterLocalChange()
            return "已删除：\(item.content)"
        case .archive:
            if item.isArchived { return "「\(item.content)」已在归档里" }
            guard item.isDone else { return "只有已完成的待办才能归档：\(item.content)" }
            file = local.setArchived(id: item.id, archived: true)
            afterLocalChange()
            return "已归档：\(item.content)"
        case .reopen:
            if item.isArchived {
                file = local.setArchived(id: item.id, archived: false)
            } else {
                file = local.setStatus(id: item.id, status: "pending")
            }
            afterLocalChange()
            return "已恢复：\(item.content)"
        }
    }

    // MARK: - Toast

    func showToast(_ text: String) {
        toast = text
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_400_000_000)
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.toast = nil }
        }
    }
}
