import Foundation

/// Headless checks run with OPENTODO_SELFTEST=1 (exits after printing).
/// Exercises the real TodoStore + FastIntent code paths.
enum SelfTest {
    @MainActor
    static func run() -> Int32 {
        var failures = 0
        func check(_ cond: Bool, _ name: String) {
            if cond { print("PASS  \(name)") } else { failures += 1; print("FAIL  \(name)") }
        }

        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("opentodo-selftest-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("todos.json")

        let store = TodoStore(fileURL: file)
        store.start()
        store.add(content: "alpha", project: "p1")
        store.add(content: "beta", project: "p1")
        store.add(content: "gamma", project: "p2")
        check(store.items.count == 3, "add 3 items")

        // External deletion while running must NOT wipe on the next mutation.
        try? FileManager.default.removeItem(at: file)
        store.reorder(orderedIds: store.items.reversed().map(\.id))
        check(store.items.count == 3, "external delete + reorder keeps items")
        let reloaded = TodoStore(fileURL: file)
        reloaded.start()
        check(reloaded.items.count == 3, "recreated file still has 3 items")

        // Corrupt file: refuse to write, keep memory, surface error.
        try? "not json".write(to: file, atomically: true, encoding: .utf8)
        let before = store.items.count
        store.add(content: "delta")
        check(store.items.count == before, "corrupt file: write refused")
        check(store.lastError != nil, "corrupt file: error surfaced")

        // Cross-group move: renumber + project change within one persist.
        let m = TodoStore(fileURL: dir.appendingPathComponent("move.json"))
        m.start()
        m.add(content: "a", project: "p1")
        m.add(content: "b", project: "p1")
        m.add(content: "c", project: "p2")
        m.add(content: "d", project: "p2")
        let ca = m.items.first { $0.content == "a" }!
        let cc = m.items.first { $0.content == "c" }!
        m.move(id: ca.id, toProject: "p2", beforeId: cc.id)
        check(m.items.filter { $0.project == "p2" }.count == 3, "move across projects")
        let cB = m.items.first { $0.content == "b" }!
        check(cB.order == 1, "source group renumbered after move")
        let moved = m.items.first { $0.content == "a" }!
        check(moved.project == "p2" && moved.order == 1, "moved item placed & ordered")
        m.move(id: moved.id, toProject: "未分组", beforeId: nil)
        check(m.items.first { $0.content == "a" }?.project == nil, "move to 未分组 sets nil project")
        check(m.items.filter { $0.project == "p2" }.map(\.order).sorted() == [1, 2], "target group contiguous after move-out")

        // FastIntent
        let s = TodoStore(fileURL: dir.appendingPathComponent("fast.json"))
        s.start()
        check(FastIntent.handle("加一条 写周报", store: s) == "已添加：写周报", "fast add")
        check(s.items.count == 1, "fast add persisted")
        check(FastIntent.handle("列出待办", store: s) != nil, "fast list")
        check(FastIntent.handle("完成 写周报", store: s) == "已完成：写周报", "fast complete")
        check(s.items.first?.isDone == true, "fast complete applied")
        check(FastIntent.handle("删除 写周报", store: s) == "已删除：写周报", "fast remove")
        check(s.items.isEmpty, "fast remove applied")
        check(FastIntent.handle("完成", store: s) == nil, "ambiguous falls back")
        check(FastIntent.handle("帮我规划一下这周的工作", store: s) == nil, "free text falls back")

        // ModelID resolution (settings model-string building)
        check(ModelID.resolve("glm-5.3-flash", provider: "zhipuai") == "zhipuai/glm-5.3-flash", "model id: prefix provider")
        check(ModelID.resolve("openrouter/deepseek/deepseek-chat", provider: "zhipuai") == "openrouter/deepseek/deepseek-chat", "model id: slash input wins")
        check(ModelID.resolve("  ", provider: "zhipuai") == "", "model id: empty rejected")
        check(ModelID.resolve("model-x", provider: nil) == "model-x", "model id: no provider returns raw")

        // ModelOption catalog flattening (used by picker)
        let mp = ProviderInfo(
            id: "p1", displayName: "P1", source: "api", connected: true,
            models: [ModelOption(provider: "p1", model: "m", name: "M", family: "f", variants: ["low", "high"], inputCost: 0.15, outputCost: 0.5)]
        )
        check(mp.models.first?.id == "p1/m", "provider models use provider/model id")
        check(mp.models.first?.variants == ["low", "high"], "provider model keeps variants")

        // Keychain credential roundtrip + serve overlay builder
        let roundtripID = "opentodo-selftest-credential"
        KeychainStore.save(
            providerID: roundtripID,
            credential: KeychainStore.Credential(key: "sk-test", baseURL: "https://x.example/v1")
        )
        let cred = KeychainStore.load(providerID: roundtripID)
        check(cred?.key == "sk-test" && cred?.baseURL == "https://x.example/v1", "keychain save/load roundtrip")
        KeychainStore.delete(providerID: roundtripID)
        check(KeychainStore.load(providerID: roundtripID) == nil, "keychain delete clears")

        let overlayData = KeychainStore.buildOverlayData(credentials: [
            "zhipuai": KeychainStore.Credential(key: "k1", baseURL: ""),
            "empty": KeychainStore.Credential(key: "", baseURL: ""),
        ])
        let overlay = (try? JSONSerialization.jsonObject(with: overlayData)) as? [String: Any]
        let prov = overlay?["provider"] as? [String: Any]
        check(prov?["zhipuai"] != nil, "overlay keeps non-empty cred")
        check(prov?["empty"] == nil, "overlay skips empty cred")
        let opt = (prov?["zhipuai"] as? [String: Any])?["options"] as? [String: Any]
        check(opt?["apiKey"] as? String == "k1", "overlay writes literal apiKey")
        check(opt?["baseURL"] == nil, "overlay omits empty baseURL")

        // v1 file migrates to v2 on next write, defaults surface on read
        let v1File = dir.appendingPathComponent("v1.json")
        try? """
        {"version":1,"revision":3,"updatedAt":"x","items":[{"id":"m1","content":"legacy","status":"completed","priority":"high","project":"cat","order":1,"completedAt":"2026-01-01T00:00:00Z"}]}
        """.write(to: v1File, atomically: true, encoding: .utf8)
        let v1store = TodoStore(fileURL: v1File)
        v1store.currentList = nil
        v1store.start()
        check(v1store.revision == 3, "v1 read keeps revision")
        check(v1store.items.first?.list == nil && v1store.items.first?.archivedAt == nil, "v1 items get v2 default fields")
        v1store.add(content: "v2item")
        let v1rewritten = try? String(contentsOf: v1File, encoding: .utf8)
        check(v1rewritten?.contains("\"version\" : 2") == true, "write upgrades file to v2")

        // Projects (lists): registry, rename, delete moves items to inbox
        let p = TodoStore(fileURL: dir.appendingPathComponent("lists.json"))
        p.currentList = nil
        p.start()
        p.add(content: "inbox item")
        p.add(content: "work item", list: "work")
        p.addList(name: "work")
        p.addList(name: "blog")
        check(p.lists == ["work", "blog"], "addList registers projects")
        check(p.items.first { $0.content == "work item" }?.list == "work", "add list scopes item")
        check(p.items.first { $0.content == "inbox item" }?.list == nil, "inbox is null list")
        p.renameList(oldName: "blog", to: "blog2")
        check(p.lists == ["work", "blog2"], "renameList updates registry")
        p.deleteList(name: "work")
        check(!p.lists.contains("work"), "deleteList removes registry")
        check(p.items.first { $0.content == "work item" }?.list == nil, "deleteList moves items to inbox")

        // moveToList crosses projects, keeps the sub-group, registers the target
        p.add(content: "cross", project: "grp")
        let crossId = p.items.first { $0.content == "cross" }!.id
        p.moveToList(id: crossId, to: "work")
        check(p.items.first { $0.content == "cross" }?.list == "work", "moveToList changes list")
        check(p.items.first { $0.content == "cross" }?.project == "grp", "moveToList keeps sub-group")
        check(p.lists.contains("work"), "moveToList registers target list")
        p.moveToList(id: crossId, to: nil)
        check(p.items.first { $0.content == "cross" }?.list == nil, "moveToList nil moves to inbox")

        // moveList reorders the project registry
        p.addList(name: "alpha")
        p.addList(name: "beta")
        p.moveList(name: "beta", before: "alpha")
        check(p.lists.firstIndex(of: "beta")! < p.lists.firstIndex(of: "alpha")!, "moveList inserts before target")
        p.moveList(name: "beta", before: nil)
        check(p.lists.last == "beta", "moveList nil moves to end")
        p.moveLists(fromOffsets: IndexSet(integer: p.lists.firstIndex(of: "beta")!), toOffset: 0)
        check(p.lists.first == "beta", "moveLists reorders projects")

        // Archive semantics: archive/unarchive/archiveCompleted/purge scoping
        let ar = TodoStore(fileURL: dir.appendingPathComponent("archive.json"))
        ar.currentList = nil
        ar.start()
        ar.add(content: "wdone", list: "work")
        ar.add(content: "bdone", list: "blog")
        ar.add(content: "wpending", list: "work")
        for c in ["wdone", "bdone"] {
            let it = ar.items.first { $0.content == c }!
            var done = it
            done.status = "completed"
            ar.update(done)
        }
        check(ar.items.first { $0.content == "wdone" }?.isDone == true, "completed status applied")
        ar.currentList = "work"
        ar.archive(id: ar.items.first { $0.content == "wdone" }!.id)
        check(ar.items.first { $0.content == "wdone" }?.isArchived == true, "archive sets archivedAt")
        ar.unarchive(id: ar.items.first { $0.content == "wdone" }!.id)
        check(ar.items.first { $0.content == "wdone" }?.isArchived == false, "unarchive clears archivedAt")
        ar.archiveCompleted()
        check(ar.items.first { $0.content == "wdone" }?.isArchived == true, "archiveCompleted archives done in current project")
        check(ar.items.first { $0.content == "wpending" }?.isArchived == false, "archiveCompleted spares pending")
        check(ar.items.first { $0.content == "bdone" }?.isArchived == false, "archiveCompleted scoped to current project")
        ar.archive(id: ar.items.first { $0.content == "bdone" }!.id)
        ar.purgeArchived()
        check(ar.items.first { $0.content == "wdone" } == nil, "purgeArchived removes current project archive")
        check(ar.items.first { $0.content == "bdone" }?.isArchived == true, "purgeArchived keeps other projects' archive")
        ar.purgeArchived(allLists: true)
        check(ar.items.first { $0.content == "bdone" } == nil, "purgeArchived(allLists) clears every project")

        // Archive restores the item inside its original list
        let rest = TodoStore(fileURL: dir.appendingPathComponent("restore.json"))
        rest.currentList = nil
        rest.start()
        rest.add(content: "R", list: "proj")
        let ri = rest.items.first { $0.content == "R" }!
        rest.archive(id: ri.id)
        rest.unarchive(id: ri.id)
        rest.update(rest.items.first { $0.content == "R" }!)
        check(rest.items.first { $0.content == "R" }?.list == "proj", "unarchive keeps original list")

        // FastIntent v2 phrases
        let f = TodoStore(fileURL: dir.appendingPathComponent("fastv2.json"))
        f.currentList = nil
        f.start()
        f.add(content: "项目任务", list: "work")
        f.currentList = "work"
        check(FastIntent.handle("加一条 当前项目的任务", store: f) == "已添加：当前项目的任务", "fast add in current project")
        check(f.items.contains { $0.content == "当前项目的任务" && $0.list == "work" }, "fast add uses store.currentList")
        f.currentList = nil
        f.add(content: "周报")
        check(FastIntent.handle("完成 周报", store: f) == "已完成：周报", "fast complete v2")
        check(FastIntent.handle("归档 周报", store: f) == "已归档：周报", "fast archive")
        check(f.items.first { $0.content == "周报" }?.isArchived == true, "fast archive applied")
        check(FastIntent.handle("恢复 周报", store: f) == "已恢复归档：周报", "fast restore from archive")
        check(f.items.first { $0.content == "周报" }?.isArchived == false, "fast restore applied")
        f.add(content: "表A")
        f.add(content: "表B")
        _ = FastIntent.handle("完成 表A", store: f)
        _ = FastIntent.handle("完成 表B", store: f)
        check(FastIntent.handle("清空已完成", store: f)?.hasPrefix("已把完成的待办移入归档") == true, "fast 清空已完成 moves to archive")
        check(f.items.filter { $0.archivedAt == nil && $0.status == "completed" }.isEmpty, "清空已完成 archives completed")
        check(FastIntent.handle("彻底删除 表A", store: f) == "已彻底删除：表A", "fast 彻底删除")
        check(f.items.filter { $0.content == "表A" }.isEmpty, "彻底删除 is hard delete")
        check(FastIntent.handle("清空归档", store: f)?.hasPrefix("已清空归档") == true, "fast 清空归档")
        check(f.items.filter(\.isArchived).isEmpty, "清空归档 empties archive")
        check(f.items.map(\.content).sorted() == ["当前项目的任务", "项目任务"], "清空归档 keeps non-archived items")
        f.add(content: "活动项")
        check(FastIntent.handle("归档 活动项", store: f)?.hasPrefix("只有已完成") == true, "archive rejects unfinished")
        check(FastIntent.handle("删除 活动项", store: f) == "已删除：活动项", "fast delete stays hard")
        check(f.items.map(\.content).sorted() == ["当前项目的任务", "项目任务"], "fast delete applied v2")

        // Self-heal: item lists absent from the registry are merged on load
        let healURL = dir.appendingPathComponent("heal.json")
        let healFixture = TodoFile(
            version: 2, revision: 1,
            items: [
                TodoItem(content: "ghost item", list: "ghostl"),
            ],
            lists: ["work"]
        )
        try? JSONEncoder().encode(healFixture).write(to: healURL)
        let heal = TodoStore(fileURL: healURL)
        heal.currentList = nil
        heal.start()
        check(heal.lists.contains("ghostl"), "load merges item lists into registry")
        check(heal.lists.contains("work"), "load keeps registered lists")
        heal.add(content: "x") // 触发 persist，自愈结果应随文件落盘
        let healData = (try? Data(contentsOf: healURL)).flatMap { try? JSONDecoder().decode(TodoFile.self, from: $0) }
        check(healData?.lists.contains("ghostl") == true, "self-healed list persists to disk")

        // restoreArchived restores current project's archive only
        let ra = TodoStore(fileURL: dir.appendingPathComponent("restoreall.json"))
        ra.currentList = nil
        ra.start()
        ra.add(content: "aw", list: "work")
        ra.add(content: "ab", list: "blog")
        ra.add(content: "ap", list: "work")
        for c in ["aw", "ab"] {
            var done = ra.items.first { $0.content == c }!
            done.status = "completed"
            ra.update(done)
        }
        ra.currentList = "work"
        ra.archiveCompleted()
        check(ra.items.filter(\.isArchived).count == 1, "restoreArchived fixture archived 1 work item")
        ra.restoreArchived()
        check(ra.items.filter { $0.content == "aw" }.allSatisfy { !$0.isArchived }, "restoreArchived unarchives current project items")
        check(ra.items.filter { $0.content == "ap" }.allSatisfy { !$0.isArchived }, "restoreArchived keeps non-archived items intact")
        check(ra.items.filter(\.isArchived).isEmpty, "restoreArchived clears current project archive")

        // Overlay config carries the app-only opentodo agent (and no MCP)
        if let overlay = try? JSONSerialization.jsonObject(
            with: KeychainStore.buildOverlayData(credentials: [:])
        ) as? [String: Any] {
            let agents = overlay["agent"] as? [String: Any]
            check(agents?["opentodo"] != nil, "overlay defines opentodo agent")
            check(overlay["mcp"] == nil, "overlay no longer defines an MCP server")
        } else {
            check(false, "overlay data is valid JSON")
        }

        print(failures == 0 ? "SELFTEST PASS" : "SELFTEST FAIL (\(failures))")
        return failures == 0 ? 0 : 1
    }
}
