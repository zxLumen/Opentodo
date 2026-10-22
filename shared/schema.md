# Opentodo 数据契约

唯一真相源是一个 JSON 文件：

```
~/.config/opentodo/todos.json
```

可用环境变量 `OPENTODO_FILE` 覆盖路径（MCP server、插件、App 都读同一变量）。

## 顶层结构

```jsonc
{
  "version": 3,              // schema 版本，当前为 3
  "revision": 42,            // 单调递增，每次写入 +1，用于并发/冲突检测
  "updatedAt": "2026-09-23T08:00:00.000Z",
  "items": [ /* TodoItem[] */ ],
  "lists": [ /* 项目名（独立 todolist），有序；默认项目「收件箱」也在这里，与其它项目一致 */ ],

  // v3 多端同步元数据（全部可选；旧文件读取时按空数组补齐）
  "tombstones": [            // 已彻底删除的条目：删除永远赢，防止旧客户端复活
    { "id": "b3f1c2a4", "deletedAt": "2026-09-23T08:00:00.000Z" }
  ],
  "listTombstones": [        // 已删除的项目
    { "name": "旧项目", "deletedAt": "2026-09-23T08:00:00.000Z" }
  ],
  "listRenames": [           // 项目改名记录（旧名 → 新名），用于迁移并发修改
    { "from": "旧项目", "to": "新项目", "at": "2026-09-23T08:00:00.000Z" }
  ],
  "listsUpdatedAt": "2026-09-23T08:00:00.000Z" // 项目注册表/顺序最后变更时间
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
- **墓碑（v3）**：所有彻底删除都要写 `tombstones` / `listTombstones`。读取时墓碑优先于
  条目本身——即使另一台设备还持有旧副本，也不会把已删除内容同步回来。
- **项目改名（v3）**：写 `listRenames` + 旧名墓碑，并更新条目所属项目。合并时旧名下的
  并发修改会迁移到新名。
- **同步**：Mac / iOS 把本地完整状态 `POST /api/sync` 给服务端，服务端在文件锁里合并后
  返回权威状态；客户端仅在本地自读取后未变化时写回（避免覆盖刚做的修改）。

## 约束

- `status` 只允许四个值：`pending` / `in_progress` / `completed` / `cancelled`。
- `priority` 只允许三个值：`high` / `medium` / `low`。
- `completedAt` 在 `status` 变为 `completed` 时写入，从 `completed` 变回其它状态时清空。
- `archivedAt` 与 `status` 正交：只有状态层面的完成/取消用 `status`，归档是独立的时间戳标记。
- 缺失字段由读写层补齐默认值，保证向后兼容；v1/v2 文件读取后在下一次写入时升级为 v3
  （新增字段默认 `null`/`[]`）。
- **数据自愈**：读取/写入时，`list` 为 `null`/空 的条目统一归入「收件箱」；`lists` 为空时
  预置默认项目「收件箱」；条目中出现、但不在 `lists` 里的项目名会自动并入注册表。
- 写入必须原子：先写临时文件再 `rename`，避免读到半截文件。
- 并发写入用文件锁 + `revision` 乐观校验，避免多进程（opencode / 豆包工作 / App 各自拉起一个 MCP server 进程）互相覆盖。
- **合并规则**（服务端 `mcp/lib/merge.js` 单点执行）：
  - 同一条目两边都改 → `updatedAt` 新的赢；时间相同服务端赢。
  - 一边删、一边改 → 删除永远赢（墓碑优先）。
  - 两边各加新条目 → 按 `id` 求并集。
  - 项目列表 → 并集 − 墓碑，顺序取 `listsUpdatedAt` 更新的一方。
  - 合并后按 `(list, project)` 重新编号 `order` 1..n，不改 `updatedAt`（避免回环）。
  - 时间比较按 ISO8601 解析；客户端时钟偏差会影响「谁更新」，删除不受影响。

## 示例

见 `shared/todos.example.json`。