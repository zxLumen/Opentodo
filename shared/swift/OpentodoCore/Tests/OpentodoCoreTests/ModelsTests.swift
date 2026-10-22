import XCTest
@testable import OpentodoCore

final class ModelsTests: XCTestCase {
    func testRenameAndTombstoneNormalize() throws {
        let now = ISO8601DateFormatter().string(from: Date())
        let file = TodoFile(
            items: [
                TodoItem(id: "a", content: "旧条目", list: "旧项目"),
                TodoItem(id: "b", content: "已删除", list: "收件箱"),
            ],
            lists: ["旧项目", "收件箱"],
            tombstones: [TodoTombstone(id: "b", deletedAt: now)],
            listTombstones: [TodoListTombstone(name: "旧项目", deletedAt: now)],
            listRenames: [TodoListRename(from: "旧项目", to: "新项目", at: now)]
        )
        let normalized = TodoNormalize.normalize(file)
        XCTAssertEqual(normalized.items.count, 1)
        XCTAssertEqual(normalized.items.first?.listName, "新项目")
        XCTAssertEqual(normalized.lists, ["新项目", "收件箱"])
        XCTAssertEqual(normalized.version, 3)
    }

    func testRenameBackToOriginalNameDoesNotCycle() {
        let t1 = "2026-10-20T10:00:00.000Z"
        let t2 = "2026-10-21T10:00:00.000Z"
        let file = TodoFile(
            items: [TodoItem(id: "a", content: "任务", list: "A")],
            lists: ["A"],
            listTombstones: [TodoListTombstone(name: "B", deletedAt: t2)],
            listRenames: [
                TodoListRename(from: "A", to: "B", at: t1),
                TodoListRename(from: "B", to: "A", at: t2),
            ]
        )
        let normalized = TodoNormalize.normalize(file)
        XCTAssertEqual(normalized.items.first?.listName, "A")
        XCTAssertEqual(normalized.lists, ["A"])
    }

    func testRenameRecordsApplyChronologicallyRegardlessOfFileOrder() {
        let t1 = "2026-10-20T10:00:00.000Z"
        let t2 = "2026-10-21T10:00:00.000Z"
        let file = TodoFile(
            items: [TodoItem(id: "a", content: "任务", list: "A")],
            lists: ["A"],
            listTombstones: [TodoListTombstone(name: "B", deletedAt: t2)],
            listRenames: [
                TodoListRename(from: "B", to: "A", at: t2),
                TodoListRename(from: "A", to: "B", at: t1),
            ]
        )
        let normalized = TodoNormalize.normalize(file)
        XCTAssertEqual(normalized.items.first?.listName, "A")
        XCTAssertEqual(normalized.lists, ["A"])
    }

    func testLegacyDecodeFillsDefaults() throws {
        let json = #"{"version":2,"revision":5,"items":[{"id":"x","content":"旧数据","list":null}],"lists":[]}"#
        let file = try JSONDecoder().decode(TodoFile.self, from: Data(json.utf8))
        XCTAssertEqual(file.tombstones.count, 0)
        let normalized = TodoNormalize.normalize(file)
        XCTAssertEqual(normalized.items.first?.listName, "收件箱")
        XCTAssertEqual(normalized.lists, ["收件箱"])
    }
}
