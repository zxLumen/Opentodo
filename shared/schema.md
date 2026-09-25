# Opentodo 数据契约

唯一真相源是一个 JSON 文件：

```
~/.config/opentodo/todos.json
```

可用环境变量 `OPENTODO_FILE` 覆盖路径（MCP server、插件、App 都读同一变量）。

## 顶层结构

```jsonc
{
  "version": 2,              // schema 版本，当前为 2
  "revision": 42,            // 单调递增，每次写入 +1，用于并发/冲突检测
  "updatedAt": "2026-09-23T08:00:00.000Z",
  "items": [ /* TodoItem[] */ ],
  "lists": [ /* 项目名（独立 todolist），有序；默认项目「收件箱」也在这里，与其它项目一致 */ ]
}
```

## TodoItem

```jsonc
{
  "id": "b3f1c2a4",          // 稳定唯一 id（默认 8 位十六进制）
  "content": "完成 ai lighting 项目",
  "status": "pending",       // pending | in_progress | completed | cancelled
  "priority": "high",        // high | medium | low
  "list": "收件箱",          // 项目（独立 todolist），不允许 null/空
  "project": "ai lighting",  // 项目内的分类/分组名，可为 null
  "archivedAt": null,        // 归档时间，非空即归档（从工作视图移出，可恢复）
  "order": 1,                // 组内排序，越小越靠前
  "createdAt": "2026-09-23T07:00:00.000Z",
  "updatedAt": "2026-09-23T07:30:00.000Z",
  "completedAt": null        // 完成时间，status 为 completed 时写入，非 completed 时为 null
}
```

## 语义

- **项目（list）**：互相独立的 todolist。**「收件箱」是默认项目**，首次运行自动进入
  `lists`，与其它项目完全一致：可拖动排序、可重命名、可删除。`list` 不允许 `null`/空；
  读写层读取时会自动把旧数据中的 `null` 条目归入「收件箱」（数据自愈）。条目在项目内
  可按 `project`（分类）分组。
- **状态（status）**：`pending`（待办）/ `in_progress`（进行中）/ `completed`（已完成）/
  `cancelled`（已取消）。App 顶部按状态分段展示，并支持手动把待办置为「进行中」或
  「已取消」；被取消的条目统一归入「待办」里的灰色「已取消」分组。
- **归档（archivedAt）**：已完成的条目可移入归档，从「待办/已完成」视图隐藏；可恢复
  （清空 `archivedAt`）。
- **删除**：`remove` / 垃圾桶 = 彻底删除，没有回收站；重要完成项请先归档。删除项目（含
  「收件箱」）会**连同其下所有待办一起彻底删除**，不可恢复；App 会弹窗确认，插件/MCP 的
  `remove_project` 同样直接删除。

## 约束

- `status` 只允许四个值：`pending` / `in_progress` / `completed` / `cancelled`。
- `priority` 只允许三个值：`high` / `medium` / `low`。
- `completedAt` 在 `status` 变为 `completed` 时写入，从 `completed` 变回其它状态时清空。
- `archivedAt` 与 `status` 正交：只有状态层面的完成/取消用 `status`，归档是独立的时间戳标记。
- 缺失字段由读写层补齐默认值，保证向后兼容；v1 文件读取后在下一次写入时升级为 v2
  （新增字段默认 `null`/`[]`）。
- **数据自愈**：读取/写入时，`list` 为 `null`/空 的条目统一归入「收件箱」；`lists` 为空时
  预置默认项目「收件箱」；条目中出现、但不在 `lists` 里的项目名会自动并入注册表。
- 写入必须原子：先写临时文件再 `rename`，避免读到半截文件。
- 并发写入用文件锁 + `revision` 乐观校验，避免多进程（opencode / 豆包工作 / App 各自拉起一个 MCP server 进程）互相覆盖。

## 示例

见 `shared/todos.example.json`。