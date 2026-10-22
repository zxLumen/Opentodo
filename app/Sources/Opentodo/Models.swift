import Foundation
import OpentodoCore

// 数据模型现在放在 shared/swift/OpentodoCore，Mac / iOS 共用同一份契约。
// 这里保留 typealias，避免改动现有 UI / TodoStore 里的大量引用。
typealias TodoItem = OpentodoCore.TodoItem
typealias TodoFile = OpentodoCore.TodoFile
typealias TodoTombstone = OpentodoCore.TodoTombstone
typealias TodoListTombstone = OpentodoCore.TodoListTombstone
typealias TodoListRename = OpentodoCore.TodoListRename
