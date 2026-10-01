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

运行期数据统一放 **`OPENTODO_DATA_DIR`**(默认 `web/data`;容器里**务必指到挂载卷**,如 `/data`,
否则落在容器可写层、重建即丢):

- **站长待办**(`OPENTODO_FILE`,默认 `<DATA_DIR>/todos.json`):想和本机桌面 App 共用同一份,设
  `OPENTODO_FILE=~/.config/opentodo/todos.json`。
- **访客待办**:每人一个随机 `cid`(cookie `zx_todo_cid`),数据在 `<DATA_DIR>/visitors/<cid>.json`。
- **对话记录**:每个数据域一份 `<DATA_DIR>/chat/<key>.json`(`key` = `owner` | 访客 cid | 被查看的 cid),
  每个域只留最近 60 条。**单独存**的原因:数据层的 `normalizeData()` 只保留待办字段,未知字段会被丢掉,
  对话塞进 `todos.json` 保不住。
- **配置**:`<DATA_DIR>/settings.json`、`<DATA_DIR>/chat.key`、`<DATA_DIR>/owner.token`。
- 待办文件与 App / 插件 / MCP 完全兼容:同一把 mkdir 文件锁、同一条原子 rename、同一个 `revision`。

## 访客隔离(B 方案)

- **每个访客一份独立数据**:服务端给每个访客发 `zx_todo_cid` cookie,数据落
  `data/visitors/<cid>.json` —— 访客之间、以及和站长的数据**完全隔离**。访客**首次进来**
  会自带一个「**使用提示**」项目(5 条上手说明,当待办条目)。
- **站长**可以从标题栏 **👥** 打开访客列表:看到每个访客的 cid 短码 / 待办数 / 最近一条,
  点一个即可**查看并管理**那名访客的待办(顶部有「返回我的」)。
- **站长**:两种方式认定 ——
  1. **与博客共用登录(推荐)**:本地两边用**同一个 `SESSION_SECRET`**,你在博客 `/admin`
     登录后,本应用本地验签博客的 `zx_admin` cookie 即视为站长(登出即失效)。
     ⚠️ 本地 cookie 只看主机不看端口,所以博客与 iframe 要用**同一个 host**(都 `localhost`);
     生产把博客的 `ADMIN_COOKIE_DOMAIN=.你的域名` 配上,子域 `todo.<域名>` 才收得到。
  2. **owner token(兜底)**:直接访问 `/?owner=<token>`(token 存 `data/owner.token`,
     启动打印;`OPENTODO_OWNER_TOKEN` 可覆盖),不开博客时也能当站长。
- **AI 站长/访客都能用**:LLM 对话走**站长配的 provider/model/密钥**(访客编辑的是自己那份数据)。
  默认放行访客;`OPENTODO_VISITOR_AI=0` 可关掉(关掉后访客只能用本地快速模式)。
  聊天**配置 / 密钥**仍**仅站长**可改(访客看不到 ⚙)。
- 环境变量:`OPENTODO_FILE`(站长数据文件)/ `OPENTODO_OWNER_TOKEN`(站长口令)/
  `OPENTODO_VISITOR_AI`(是否放行访客 AI,默认放行)。

## 结构

```
web/
├─ server.js        Node ESM:HTTP 接口 + SSE + 发静态
├─ ops.js           op 表(/api/op 与聊天的工具循环共用)
├─ providers.js     供应商预设(融合博客 providers.ts)
├─ settings.js      聊天配置/密钥存取 + 拉模型
├─ effort.js        思考强度查表(models.dev 切片)
├─ effort-options.json  生成的「按模型可选的思考强度」(入库)
├─ chat.js          聊天引擎:流式 + tools 循环 + 指令协议兜底
├─ chatstore.js     对话记录落盘(按数据域,原子写,最近 60 条)
├─ scripts/mock-openai.mjs  本地 mock provider(仅开发验证)
├─ scripts/gen-effort-slice.mjs  生成 effort-options.json
├─ scripts/selftest.mjs  思考强度/请求体自测(node --test)
├─ src/             React 前端(视觉照搬 UI.swift)
│   ├─ App.tsx        面板:项目栏 / 四段 / 列表 / 分组 / 对话
│   ├─ Settings.tsx   聊天设置浮层
│   ├─ intent.ts      快速模式(移植 FastIntent.swift)
│   ├─ useRowDrag.ts  指针拖拽(重排 + 拖到项目 + 项目重排)
│   ├─ api.ts / types.ts
│   └─ styles.css
└─ dist/            vite 构建产物(不入库)
```

## 加载与缓存(线上首屏)

`server.js` 发静态时做了三件事,专门解决「博客主页点开浮窗转圈久」:

- **强缓存 + 校验**:`/assets/*`(vite 带 hash)发 `Cache-Control: public, max-age=31536000,
  immutable`,二次打开 0 请求体;`index.html` 发 `no-cache` 并带 `ETag`,数据没变就回 `304`。
- **压缩**:按 `Accept-Encoding` 出 brotli/gzip(实测入口 JS 255KB → 76KB br / 80KB gz)。
- **首屏内联**:发 HTML 时把 `/api/state`、`/api/chat/state`、`/api/chat/history` 的数据
  内联成 `<script>window.__BOOT__=…</script>`,前端首帧直接用,**省掉「下载 JS → 再发 3 个
  API」的往返**(`App.tsx` 仍有 4s 轮询兜底)。
- 未知的静态资源(带扩展名或 `/assets/*`)返回 **404**,不再回落成 HTML。
- ⚠️ 反向代理/CDN 别强缓存 `index.html`:它内联了当次数据,必须回源(靠 ETag 走 304)。
- 若部署平台会**缩容到 0**,首个请求还要等容器冷启(与前端无关):设最小实例数 / 保活可消除。

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | `{ data: TodoFile }`(items / lists / revision) |
| POST | `/api/op` | `{ op, ...args }` → `{ data }`,应用一个操作 |
| GET | `/api/health` | `{ ok, file }` |
| GET | `/api/chat/state` | 聊天配置(密钥掩码)+ 供应商预设 |
| GET | `/api/chat/history` | 当前数据域的**对话记录** `{ messages }` |
| POST | `/api/chat/history` | 保存当前数据域对话 `{ messages }`(查看访客时 **403 只读**) |
| POST | `/api/chat/config` | 保存 provider / baseUrl / model / 温度 / maxTokens / fastMode / effort |
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

模型侧**以桌面插件的系统提示为规范**(整段对齐):每条新待办都尽量给一个简短分组(优先复用已有);
**放哪个项目按「消息主体词」判断** —— 主体是领域/项目名(如 装修 / 汽车保养 / 健身 / 读书)→
不存在就**新建项目**;只是时间/动作/一次性事项(如 开会 / 买牛奶)→ 留当前项目;**拿不准先反问一句**。
也能按你的话**建/改名/删项目**(`addList` / `renameList` / `deleteList`)、**整理**(`clear`)、
**查全部项目**(`listItems`)。删项目会连带其下待办、不可恢复,只在明确要求时用。

设置(面板头部 **⚙**):选供应商 → baseUrl 自动带出(**「拉取模型」**按 `/models` 拉下拉)
→ 选/填模型 → API Key → 温度 / maxTokens → 快速模式开关。

## 对话记录(持久化)

每次一轮对话结束,前端把该**数据域**的最近对话存到服务端(`POST /api/chat/history`),
下次打开(刷新 / 重开浮层 / 换设备)先拉回(`GET /api/chat/history`):**站长、每个访客各自独立
一份**,互不可见。临时提示(「AI 仅站长可用」/「模型出错」等 `system` 消息)不入库;每个域只留最近 60 条。

> 若 `OPENTODO_DATA_DIR` 没指到持久卷(如容器里的 `/data`),这些记录会随容器重建一起丢。

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
  `OPENTODO_CHAT_KEY` 优先;数据目录可用 `OPENTODO_DATA_DIR` 指向挂载卷。
- 本地验证:`node scripts/mock-openai.mjs`(8901)→ 设置里 provider 选 `custom`、
  baseUrl `http://localhost:8901/v1`、模型 `mock-model`。

### 思考强度(per-model effort)

部分模型支持可选「思考强度」(如 `low`/`medium`/`high`,有的还有 `minimal`/`none`/
`xhigh`/`max`)。web 直连各家接口拿不到这个能力信息,所以离线生成一份切片入库:

- `web/effort-options.json` — 由 `web/scripts/gen-effort-slice.mjs` 从 models.dev 目录
  (`~/.cache/opencode/models.json`)生成,按 模型/provider 记录档位。
  刷新:`npm run gen:effort`(或 `--from-url https://models.dev/api.json`)。
- `web/effort.js` — 只做查表:命中才在设置里显示「思考强度」下拉、才在请求体里下发
  `reasoning_effort`;查不到一律不下发(避免给不支持的 provider 塞字段导致 400)。
  请求若仍被以 400/422 拒绝,会自动去掉该字段重试一次。
- 落库在 `settings.json` 的 `effort`(空 = 默认不发送)。换模型后若原值已不适配,保存时
  自动清空。目录里没有的模型可用 `effortOverrides` 手动补:
  `{ "effortOverrides": { "custom/my-model": ["low", "high"] } }`。

## 待办(TODO)

- **面板交互细节**:置顶、四边缩放(桌面版有;网页版是浏览器浮层,暂未做)。
- 需要 `zone` 提醒 / 子任务等桌面版还没有的功能时再提。
- (访客隔离、对话持久化、SSO、`todo.<domain>` 上线均已完成。)
