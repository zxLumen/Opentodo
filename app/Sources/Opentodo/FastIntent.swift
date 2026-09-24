import Foundation

/// Handles unambiguous todo commands locally, without calling a model.
/// Returns a reply string when it handled the request, or nil to fall back to
/// the LLM. Deliberately conservative: anything ambiguous returns nil.
enum FastIntent {
    @MainActor
    static func handle(_ text: String, store: TodoStore) -> String? {
        let t = clean(text)

        if ["列出待办", "看看待办", "有哪些待办", "待办列表", "列出所有待办", "看下待办", "查看待办", "我的待办"].contains(t) {
            return listReply(store)
        }

        if ["清空已完成", "清除已完成", "删除已完成", "清理已完成"].contains(t) {
            let before = store.items.filter { $0.status == "completed" && $0.archivedAt == nil }.count
            store.archiveCompleted()
            return "已把完成的待办移入归档（\(before) 条），可在归档里恢复"
        }

        if ["清空归档", "清空回收站", "清空垃圾箱"].contains(t) {
            let before = store.items.filter(\.isArchived).count
            store.purgeArchived(allLists: true)
            return "已清空归档（\(before) 条，不可恢复）"
        }

        if let content = capture(t, prefixes: ["加一条", "添加待办", "新增待办", "添加一条", "新增一条", "加个待办", "加一个待办", "添加", "新增"]) {
            let c = strip(content)
            guard !c.isEmpty else { return nil }
            store.add(content: c, list: store.currentList)
            return "已添加：\(c)"
        }

        if let target = capture(t, prefixes: ["标记完成", "完成", "勾选", "搞定"]) {
            let q = strip(target)
            guard !q.isEmpty, let item = uniqueMatch(store, q) else { return nil }
            if item.isDone { return "「\(item.content)」已经是完成状态" }
            store.toggle(item)
            return "已完成：\(item.content)"
        }

        if let target = capture(t, prefixes: ["恢复", "取消归档", "还原", "取消完成", "重新打开"]) {
            let q = strip(target)
            guard !q.isEmpty, let item = uniqueMatch(store, q) else { return nil }
            if item.isArchived {
                store.unarchive(id: item.id)
                return "已恢复归档：\(item.content)"
            }
            if item.isDone {
                var next = item
                next.status = "pending"
                store.update(next)
                return "已恢复：\(item.content)"
            }
            return "「\(item.content)」本就没完成"
        }

        if let target = capture(t, prefixes: ["归档", "存档"]) {
            let q = strip(target)
            guard !q.isEmpty, let item = uniqueMatch(store, q) else { return nil }
            if item.isArchived { return "「\(item.content)」已经在归档里" }
            guard item.isDone else { return "只有已完成的任务才能归档：「\(item.content)」还挂着" }
            store.archive(id: item.id)
            return "已归档：\(item.content)"
        }

        if let target = capture(t, prefixes: ["彻底删除", "永久删除"]) {
            let q = strip(target)
            guard !q.isEmpty, let item = uniqueMatch(store, q) else { return nil }
            store.purge(id: item.id)
            return "已彻底删除：\(item.content)"
        }

        if let target = capture(t, prefixes: ["删除", "删掉", "移除", "去掉"]) {
            let q = strip(target)
            guard !q.isEmpty, let item = uniqueMatch(store, q) else { return nil }
            store.remove(id: item.id)
            return "已删除：\(item.content)"
        }

        return nil
    }

    // MARK: - Helpers

    private static func clean(_ s: String) -> String {
        s.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "。！!？?"))
    }

    private static func strip(_ s: String) -> String {
        s.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "：:，,、。\"'「」《》"))
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func capture(_ text: String, prefixes: [String]) -> String? {
        for p in prefixes where text.hasPrefix(p) {
            return String(text.dropFirst(p.count))
        }
        return nil
    }

    @MainActor
    private static func uniqueMatch(_ store: TodoStore, _ query: String) -> TodoItem? {
        let q = query.lowercased()
        let matches = store.items.filter { $0.content.lowercased().contains(q) }
        return matches.count == 1 ? matches[0] : nil
    }

    @MainActor
    private static func listReply(_ store: TodoStore) -> String {
        let active = store.items
            .filter(\.isActive)
            .sorted { a, b in
                let pa = a.project ?? "", pb = b.project ?? ""
                if pa != pb { return pa < pb }
                return a.order < b.order
            }
        guard !active.isEmpty else { return "当前没有未完成的待办。" }
        var lines = ["未完成待办（\(active.count)）："]
        for it in active {
            let list = it.list.map { "@\($0) " } ?? ""
            let proj = it.project.map { " [\($0)]" } ?? ""
            let mark = it.status == "in_progress" ? "~" : " "
            lines.append("- [\(mark)] \(list)\(proj) \(it.content)")
        }
        return lines.joined(separator: "\n")
    }
}
