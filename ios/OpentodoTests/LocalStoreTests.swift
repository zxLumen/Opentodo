import XCTest
@testable import Opentodo
import OpentodoCore

final class LocalStoreTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func store() -> LocalStore {
        LocalStore(fileURL: dir.appendingPathComponent("todos.json"))
    }

    func testAddAndRemoveWritesTombstone() {
        let s = store()
        let afterAdd = s.add(content: "买牛奶", list: "收件箱")
        XCTAssertEqual(afterAdd.items.count, 1)
        let id = afterAdd.items[0].id
        let afterRemove = s.remove(id: id)
        XCTAssertTrue(afterRemove.items.isEmpty)
        XCTAssertEqual(afterRemove.tombstones.map(\.id), [id])
    }

    func testRenameListMovesItemsAndRecordsRename() {
        let s = store()
        _ = s.add(content: "任务", list: "工作")
        let renamed = s.renameList(old: "工作", new: "新工作")
        XCTAssertEqual(renamed.lists, ["收件箱", "新工作"])
        XCTAssertEqual(renamed.items.first?.listName, "新工作")
        XCTAssertTrue(renamed.listRenames.contains { $0.from == "工作" && $0.to == "新工作" })
        XCTAssertTrue(renamed.listTombstones.contains { $0.name == "工作" })
    }

    func testDeleteListTombstonesItems() {
        let s = store()
        let file = s.add(content: "任务", list: "临时")
        let id = file.items[0].id
        let deleted = s.deleteList(name: "临时")
        XCTAssertTrue(deleted.items.isEmpty)
        XCTAssertFalse(deleted.lists.contains("临时"))
        XCTAssertTrue(deleted.tombstones.contains { $0.id == id })
        XCTAssertTrue(deleted.listTombstones.contains { $0.name == "临时" })
    }

    func testReorderUpdatesOrder() {
        let s = store()
        _ = s.add(content: "A", list: "收件箱")
        let file = s.add(content: "B", list: "收件箱")
        let ids = file.items.map(\.id).reversed().map { $0 }
        let reordered = s.reorder(orderedIds: ids)
        let sorted = reordered.items.sorted { $0.order < $1.order }.map(\.content)
        XCTAssertEqual(sorted, ["B", "A"])
    }

    func testMoveToGroupReordersAcrossGroups() {
        let s = store()
        let a = s.add(content: "A", list: "收件箱")
        let idA = a.items.first { $0.content == "A" }!.id
        let b = s.add(content: "B", list: "收件箱")
        let idB = b.items.first { $0.content == "B" }!.id

        let movedA = s.moveToGroup(id: idA, group: "工作", beforeId: nil)
        XCTAssertEqual(movedA.items.first { $0.id == idA }?.project, "工作")

        let movedB = s.moveToGroup(id: idB, group: "工作", beforeId: idA)
        let group = movedB.items.filter { $0.project == "工作" }.sorted { $0.order < $1.order }
        XCTAssertEqual(group.map(\.id), [idB, idA])

        let back = s.moveToGroup(id: idB, group: nil, beforeId: nil)
        XCTAssertNil(back.items.first { $0.id == idB }?.project)
        XCTAssertEqual(back.items.first { $0.id == idB }?.order, 1)
    }

    func testNormalizeDropsTombstonedItems() {
        let s = store()
        let file = s.add(content: "任务", list: "收件箱")
        let item = file.items[0]
        var withTombstone = file
        withTombstone.tombstones = [TodoTombstone(id: item.id, deletedAt: LocalStore.iso())]
        let normalized = TodoNormalize.normalize(withTombstone)
        XCTAssertTrue(normalized.items.isEmpty)
    }
}
