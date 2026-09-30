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
├─ server.js        Node ESM:HTTP 接口 + SSE + 发静态
├─ ops.js           op 表(/api/op 与聊天的工具循环共用)
├─ providers.js     供应商预设(融合博客 providers.ts)
├─ settings.js      聊天配置/密钥存取 + 拉模型
├─ chat.js          聊天引擎:流式 + tools 循环 + 指令协议兜底
├─ scripts/mock-openai.mjs  本地 mock provider(仅开发验证)
├─ src/             React 前端(视觉照搬 UI.swift)
│   ├─ App.tsx        面板:项目栏 / 四段 / 列表 / 分组 / 对话
│   ├─ Settings.tsx   聊天设置浮层
│   ├─ intent.ts      快速模式(移植 FastIntent.swift)
│   ├─ useRowDrag.ts  指针拖拽(重排 + 拖到项目 + 项目重排)
│   ├─ api.ts / types.ts
│   └─ styles.css
└─ dist/            vite 构建产物(不入库)
```

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | `{ data: TodoFile }`(items / lists / revision) |
| POST | `/api/op` | `{ op, ...args }` → `{ data }`,应用一个操作 |
| GET | `/api/health` | `{ ok, file }` |
| GET | `/api/chat/state` | 聊天配置(密钥掩码)+ 供应商预设 |
| POST | `/api/chat/config` | 保存 provider / baseUrl / model / 温度 / maxTokens / fastMode |
| POST | `/api/chat/key` | 保存 API Key |
| POST | `/api/chat/models` | 拉取该 provider 的模型列表 |
| POST | `/api/chat` | **SSE 流式对话**(快速模式未命中时) |

`op` 取值(语义对齐 `plugin/opentodo.js`):`add` / `update` / `setStatus` / `toggle` /
`setArchived` / `remove` / `reorder` / `move`(改分组 + 组内重排)/ `moveToList` / `moveList` /
`addList` / `renameList` / `deleteList`,以及批量 `archiveCompleted` / `restoreArchived` /
`purgeArchived`(按 `list` 作用域)。

## 对话 / 快速模式 / LLM

面板底部有常驻对话(可拖动分隔条调高度,双击复位)。分两层:

1. **快速模式(本地、不调模型)**:明确指令毫秒级处理(移植自桌面 `FastIntent.swift`,
   逻辑在 `src/intent.ts`)。命中就直接改、直接回:

   | 说什么 | 效果 |
   |---|---|
   | `加一条 写周报` | 新增到当前项目 |
   | `完成 周报` / `勾选 …` | 命中唯一一条就勾选完成 |
   | `恢复 …` / `重新打开 …` | 取消完成 / 从归档恢复 |
   | `归档 …` | 已完成项移入归档 |
   | `删除 …` | 彻底删除 |
   | `列出待办` / `看下待办` | 列出未完成 |
   | `清空已完成` / `清空归档` | 批量归档 / 清空 |

   含糊或内容不唯一时**不猜**,转给 LLM。

2. **LLM 回落**:未命中就流式调模型(`/api/chat`)。让模型改待办用两条路 ——
   **原生 tools(function calling)优先**;provider 不支持(400/422)时自动回落
   **指令协议**(system 约定输出 `@@op {...}` 行,服务端解析执行)。模型回复逐字流式显示。

模型侧会自动**分项目 / 分组**(对齐桌面 App 的系统提示):每条新待办尽量给一个简短分组、
优先复用已有分组;新增默认落到当前项目,只有「用户明确提到别的项目」或「内容强相关」时才
换项目(不存在就先建)。也能按你的话**建项目 / 改名 / 删项目**(`addList` / `renameList` /
`deleteList`;删项目会连带其下待办、不可恢复,只在明确要求时用)。

设置(面板头部 **⚙**):选供应商 → baseUrl 自动带出(**「拉取模型」**按 `/models` 拉下拉)
→ 选/填模型 → API Key → 温度 / maxTokens → 快速模式开关。

## 供应商配置

`providers.js` 融合了两处现成清单(博客 `providers.ts` 的 id/baseUrl + 桌面 App 的
`provider/model` 概念)。直连 OpenAI 兼容接口(或本地 Ollama):

| id | 名称 |
|---|---|
| `deepseek` | DeepSeek |
| `zhipuai` | 智谱 GLM |
| `openai` | OpenAI |
| `dashscope` | 通义千问(百炼) |
| `moonshot` | Moonshot / Kimi |
| `siliconflow` | 硅基流动 |
| `openrouter` | OpenRouter |
| `opencode-z` | OpenCode Go(带专属请求头) |
| `ollama` | 本地 Ollama |
| `custom` | 自定义(OpenAI 兼容) |

- 配置存 `web/data/settings.json`;密钥存 `web/data/chat.key`(chmod 600),env
  `OPENTODO_CHAT_KEY` 优先。
- 本地验证:`node scripts/mock-openai.mjs`(8901)→ 设置里 provider 选 `custom`、
  baseUrl `http://localhost:8901/v1`、模型 `mock-model`。

## 待办(TODO)

- **访客隔离**:目前单用户、无鉴权。对外部署前必须加访问控制(反向代理 basic_auth 或
  按访客分库)。
- **面板交互细节**:置顶、四边缩放(桌面版有;网页版是浏览器浮层,暂未做)。
- 需要 `zone` 提醒 / 子任务等桌面版还没有的功能时再提。
