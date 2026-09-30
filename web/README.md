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
`setArchived` / `remove` / `reorder` / `moveToList` / `moveList` / `addList` / `renameList` /
`deleteList`。

## 待办(TODO)

- **访客隔离**:目前单用户、无鉴权。对外部署前必须加访问控制(反向代理 basic_auth 或
  按访客分库)。
- **AI 对话**:桌面版底部有「和 opencode 对话」;网页版暂未接入(桌面 App 是通过本地
  `opencode serve` 实现的,搬到服务端要另选后端)。
- **拖拽**:支持同段重排与拖到左栏项目;跨分组的精细落点后续再打磨。
