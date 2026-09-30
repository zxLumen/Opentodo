# Opentodo Web

把桌面 App 的前端**迁移成网页版**,做成一个能独立跑、也能被个人站点以「悬浮组件」嵌入的
面板。数据层**原样复用** `../mcp/lib/store.js` —— 和桌面 App / opencode 插件 / MCP
读写同一份 `todos.json`(schema v2),所以多端天然共存,不需要迁移脚本。

## 跑起来

```bash
cd web
npm install

# 开发(vite 5173 + api 8787,自动代理 /api)
npm run dev            # → http://localhost:5173

# 生产(构建前端 + Node 发静态)
npm run build
npm start              # → http://localhost:8787
```

## 数据文件

- 默认:`web/data/todos.json`(已在 `.gitignore`,不入库)。
- 想和本机桌面 App 共用同一份:`OPENTODO_FILE=~/.config/opentodo/todos.json npm start`。
- 和 App / 插件 / MCP 完全兼容:同一把 mkdir 文件锁、同一条原子 rename、同一个 `revision`。

## 结构

```
web/
├─ server.js        Node ESM:HTTP 接口 + 发静态
├─ src/             React 前端(视觉照搬 UI.swift)
│   ├─ App.tsx        面板:项目栏 / 四段 / 列表 / 分组
│   ├─ useRowDrag.ts  指针拖拽(重排 + 拖到项目)
│   ├─ api.ts         /api/state、/api/op
│   └─ types.ts       schema v2 类型
└─ dist/            vite 构建产物(不入库)
```

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | `{ data: TodoFile }`(items / lists / revision) |
| POST | `/api/op` | `{ op, ...args }` → `{ data }`,应用一个操作 |
| GET | `/api/health` | `{ ok, file }` |

`op` 取值(语义对齐 `plugin/opentodo.js`):`add` / `update` / `setStatus` / `toggle` /
`setArchived` / `remove` / `reorder` / `move`(改分组 + 组内重排)/ `moveToList` / `moveList` /
`addList` / `renameList` / `deleteList`,以及批量 `archiveCompleted` / `restoreArchived` /
`purgeArchived`(按 `list` 作用域)。

## 对话 / 快速模式

面板底部有常驻对话(可拖动分隔条调高度,双击复位)。目前接的是**快速模式**——
明确指令在本地毫秒级处理、**不调模型**(移植自桌面 `FastIntent.swift`,逻辑在
`src/intent.ts`,`fastIntent(text, items, list) → { reply, ops }`):

| 说什么 | 效果 |
|---|---|
| `加一条 写周报` | 新增到当前项目 |
| `完成 周报` / `勾选 …` | 命中唯一一条就勾选完成 |
| `恢复 …` / `重新打开 …` | 取消完成 / 从归档恢复 |
| `归档 …` | 已完成项移入归档 |
| `删除 …` | 彻底删除 |
| `列出待办` / `看下待办` | 列出未完成 |
| `清空已完成` / `清空归档` | 批量归档 / 清空 |

含糊、或内容不唯一时**不猜**——回一条系统提示,留给将来的 LLM 回落。

## 待办(TODO)

- **访客隔离**:目前单用户、无鉴权。对外部署前必须加访问控制(反向代理 basic_auth 或
  按访客分库)。
- **LLM 回落**:快速模式未命中时,桌面版会转给 `opencode serve`(带 `opentodo_*` 工具)。
  网页版暂未接 —— 待定后端:服务器跑 opencode serve / 复用博客模型 / 直连 OpenAI 兼容 API。
- **分组(project)**:已支持新增时选分组、行内「移动到分组」、拖到别的分组即改分组。
- **面板交互细节**:置顶、四边缩放(桌面版有;网页版是浏览器浮层,暂未做)。
- 需要 `zone` 提醒 / 子任务等桌面版还没有的功能时再提。
