# Opentodo

给 opencode 用的悬浮待办。点桌面上的浮球，从它左下角弹出待办面板——可以用鼠标勾选/添加/编辑/拖拽，也可以直接和 opencode 对话调整。Mac / Web / iOS 三端最终同步到同一份 JSON。

<img src="https://github.com/zxLumen/Opentodo/releases/download/assets/demo.gif" width="640" alt="Opentodo 演示">

**自包含**：App bundle 里带着自己的 opencode 插件，首次运行会在 `~/.config/opentodo/opencode/` 生成一份**只属于 App** 的 opencode 配置。所以它不会污染你的全局 opencode——普通 TUI 会话里没有 opentodo 模式、没有 opentodo 工具。**只要装了 opencode，解压即用**（不需要 node、不需要装 MCP、不需要改全局配置）。

## 架构

```
        云端 Web 服务 (todos.json 唯一真相源, 带 revision)
        ┌──────────────┼──────────────────────────────┐
        │        GET /api/state · POST /api/op        │
        │        POST /api/sync  ← 三端合并入口        │
        │        POST /api/devices/pair (设备令牌)     │
        └──────────────┼──────────────────────────────┘
                       │ HTTPS
        ┌──────────────┼──────────────┐
   Opentodo.app     Web (React)     iOS App
   本地镜像 + 同步    直连服务端      本地镜像 + 语音 + 同步
        │
        ├── app 专属插件（~/.config/opentodo/opencode/）
        └── (可选) opentodo-mcp
                       │ opencode V2 运行时
               App 自起的 `opencode serve`
          (XDG_CONFIG_HOME + location 隔离)

   同步语义：同一条目按 updatedAt 取新；删除写墓碑且永远优先；合并由服务端单点完成。
   Mac / iOS 离线可继续记录，联网后自动合并。
```

> 对话后端对接 **opencode V2 HTTP API**：所有路由在 `/api/*` 下并用 Basic 认证(用户名 `opencode`,密码是自起的 serve 打印到 stdout 的 `server password …`)。V2 的 server API 与 V1 **不兼容**——插件要用 `@opencode/plugin` 的 `Plugin.define`,插件工具经 Code Mode 的 `execute` 调用,所以 agent 权限必须放行 `execute`(见 `KeychainStore.buildOverlayData`)。

- **数据层（v3）**：服务端持有唯一真相源；Mac 本地文件 `/Users/you/.config/opentodo/todos.json` 作为镜像（插件 / MCP 仍读它），iOS 用应用沙盒内镜像。schema 见 `shared/schema.md`。删除写墓碑，项目改名写 `listRenames`。
- **工具层（关键）**：`plugin/opentodo.js` 是 opencode **V2** 插件（`@opencode/plugin` + `Plugin.define`），注册 `opentodo_*` 工具（增删改查/归档/项目）并往系统提示注入当前项目与待办摘要。它运行在 **opencode 自带的运行时**里，所以**不需要 node、不需要独立的 MCP 进程**。
- **App**：`app/`，SwiftUI + AppKit `NSPanel`。菜单栏常驻 + 可拖浮球 + 面板（**左侧项目栏** + 待办列表 + 对话）。对话后端是 App 自己拉起的 `opencode serve`。
- **Windows App**：`win/`，Electron + React。复用 `web/src` 面板与 `web/ops.js` / `mcp/lib/store.js` 数据层，主进程负责悬浮球、托盘、快捷键、对话与同步。
- **MCP（可选）**：`mcp/` 是一个独立的 stdio MCP server，功能与插件一致，供其它 MCP 客户端或开发使用；App 本身不依赖它。

## iOS

原生 SwiftUI 版：待办 / 项目 / 四段状态 / 拖拽 / 左滑操作 / **语音快速记录** / AI 对话，全部走同一套同步协议。

```bash
cd ios
xcodegen generate            # 已装 XcodeGen；或直接用已生成的 Opentodo.xcodeproj
open Opentodo.xcodeproj
```

- Xcode 里 **Signing & Capabilities** 选择你的 Personal Team（免费账号即可），设备开启开发者模式后直接 Run。
- 免费账号的 App **7 天过期**，到期重跑一次 Xcode；想长期免重签可上 TestFlight（需 $99/年）。
- 首次打开 → 设置 → 填服务器地址 + 站长口令 → 配对。之后所有请求用设备令牌（存 Keychain）。
- 语音用系统 `SFSpeechRecognizer`（中文），优先设备端模型，失败自动回落在线识别；识别结果交给本地意图解析，明确动作（完成/删除/归档）直接执行，其余默认记成待办。
- AI 对话调用服务端 `/api/chat`，手机上不保存模型 API Key。详见 `ios/README.md`。

## Windows

Electron + React 桌面版：悬浮球 / 面板 / 托盘 / 全局快捷键 / AI 对话 / 多端同步，数据与其它端共用同一份 `todos.json`。

```powershell
cd win
npm install
node node_modules/electron/install.js   # npm 11 跳过 postinstall 时执行一次
npm run dev
```

- 打包：`npm run icon` → `npm run dist`，输出 `win/release/Opentodo-Setup-<version>.exe` 和便携版。
- 前置：Windows 10 21H2+ / 11 x64、Node.js 22+（构建用）、已配置好的 **opencode V2**。
- 快捷键默认 `Ctrl+Alt+T`，被占用时回退 `Ctrl+Shift+Alt+T`。
- 数据仍在 `%USERPROFILE%\.config\opentodo\todos.json`，与 Mac / iOS / Web / 插件 / MCP 共用。
- 首次运行未签名安装包可能触发 SmartScreen；详细说明与排错见 [`win/README.md`](win/README.md)。

## 三端同步怎么开

1. 把 Web 服务部署到带 HTTPS 的域名（Docker 镜像见 `web/`）；**升级前先备份线上 `todos.json`**。
2. 浏览器打开 `https://你的域名/?owner=<站长口令>` 认领站长身份（口令在服务端 `data/owner.token`，或由 `OPENTODO_OWNER_TOKEN` 指定）。
3. Mac：右键浮球 → 设置 → **多端同步** → 填服务器地址 + 站长口令 → 配对并开始同步。
4. iOS：设置 → **同步** → 同样填地址 + 口令 → 配对。
5. 首次同步会把 Mac 本地、Web 云端两边的历史数据**合并**（不是覆盖）；完全相同内容的重复项会保留，需要手动清理。

之后：Mac 的本地改动（包括 opencode 插件直接改文件）会在 2 秒防抖后推送；Web 改写由服务端即时生效；iOS 在启动 / 回前台 / 修改后同步。断网时三端都能继续记录，联网自动合并。

## 安装 / 运行

**直接下载**：[Opentodo.zip](https://github.com/zxLumen/Opentodo/releases/download/assets/Opentodo.zip)（解压即用）。

或从源码构建：

```bash
./scripts/build-app.sh
open dist/Opentodo.app          # 或把 dist/Opentodo.zip 拷到任何机器解压运行
```

- 前置条件：目标机装了 **opencode**（`opencode` 在 PATH，或 App 设置里指定路径）。
- 从 zip 解压首次运行若被 Gatekeeper 拦截：`xattr -dr com.apple.quarantine Opentodo.app`。
- `scripts/install.sh` 只用于**清理旧的全局安装**（旧版曾把插件/agent/MCP 写进全局配置）。

## 使用

- **浮球**：常驻屏幕边缘，可拖动；松手吸附最近左/右边缘；位置记忆；进度环反映**当前项目**完成比例（不含已取消/归档）。吸附到左/右边缘后会**自动半收起**（只露约 1/4 球），鼠标移上去**滑出**、移开**收回**（带动画）。
- **打开面板**：点浮球，或全局热键 **⌃⌥T**；面板从浮球左下角弹出；点面板外自动收起。面板**四边可拖拽缩放**（贴边出现缩放光标）。
- **左侧项目栏**：列出所有项目（带未完成数，**「收件箱」是默认项目，与其它项目无差别**），点击切换；右键项目可重命名/删除；底部「+ 新建项目」。删除项目时弹窗确认，确认后**连同其下待办一并彻底删除**（不可恢复）；收件箱也同样可拖、可改名、可删。点**左上角 checklist 图标**可收起/展开项目栏——**窗口向左扩展/收起，待办区宽度保持不变**；**拖动项目行**可调整顺序（记住状态与顺序）。项目名过长自动换行，悬浮可看全名。
- **顶部**显示当前项目名与未完成数。
- **待办操作**：
  - **分段**：顶部「待办 / 进行中 / 已完成 / 归档」四段；待办与进行中都有「添加待办」输入框，进行中里新建的条目直接是进行中状态。
  - 勾选完成；悬停行显示操作按钮：待办 →「开始」（转进行中）/「取消」；进行中 →「取消」；已取消 →「重新打开」；已完成 →「归档」；归档 →「恢复」；每行都可「编辑 / 彻底删除」。
  - **已取消**：被取消的条目在「待办」里统一归入灰色的「已取消」分组（图标 minus、文字删除线），不可拖动。
  - **编辑**：悬停某行，点行尾的**铅笔图标**就地编辑内容——**支持多行自动换行**（Enter 换行，点别处/失焦保存，Esc 取消），各段都可编辑。整行保持可拖拽，互不冲突。
  - **拖拽排序**：拖动行到目标位置，行间会出现一条**插入横杠**提示落点（不再整行高亮）。
  - **拖到左侧项目**：把待办拖到左栏某个项目上，即移动到该项目（子分组保留）。
- **对话调整**：面板底部常驻 AI 对话，输入框随内容增高（Enter 发送 / Option+Enter 换行）。
- **快速模式（默认开）**：明确句式（"加一条 X""完成 X""删除 X""列出待办""清空已完成"）本地直接处理、毫秒级；含糊的才回落给模型。
- **停止**：AI 回复期间输入框右侧变成红色"停止"按钮。
- **右键浮球 / 菜单栏**：显示/隐藏、设置…、退出。

## 设置

右键浮球（或菜单栏图标）→「设置…」：

| 分类 | 项 | 默认 |
|---|---|---|
| 模型 | provider/model（可从 opencode 拉取列表） | `zhipuai/glm-5.3-flash` |
| | 服务商作用域（跟随全局 / 已连接 / 显示全部） | 跟随全局默认 |
| | 思考强度 variant（该模型有才列） | 默认（最低） |
| | 快速模式 | 开 |
| 独立 API Key | 已连接服务商的 key + 可选 baseURL（存 macOS 钥匙串） | 空（回退全局） |
| 悬浮球 | 样式 A–F | C 进度环 |
| | 大小 48–80 | 64px |
| opencode | 端口 / 可执行文件路径 / 请求超时 | 4096 / 自动检测 / 120s |
| 系统 | 开机自启 | 关 |

### 独立 API Key 与 App 专属配置

- 密钥存 **macOS 钥匙串**（`com.opentodo.provider-credential`），不写明文到任何配置文件。
- App 启动时把钥匙串里的 key/baseURL 写成 `~/.config/opentodo/opencode-overrides.jsonc`（chmod 600），并在 `~/.config/opentodo/opencode/plugins/` 放好插件；自起的 `opencode serve` 通过 `OPENCODE_CONFIG`（覆盖层：provider + 受限 `opentodo` agent）、`OPENCODE_CONFIG_DIR`（专属插件目录）与 `XDG_CONFIG_HOME=~/.config/opentodo/xdg`（隔离的配置根）加载。
- 因为隔离了配置根，App 的 serve **不加载全局 `~/.config/opencode` 的配置与插件**：全局的 `smart-voice-notify`（会话完成语音播报）和 `aistatus`（把会话当作 session 上报给 AI 状态灯）都不会在 App 里生效。认证仍在数据目录（`XDG_DATA_HOME` 未隔离），标准 provider 照常可用。
- 因此 **opentodo 只活在 App 的 serve 进程里**，其它 opencode 会话完全看不到。

## 数据与安全

- 路径：`~/.config/opentodo/todos.json`（`OPENTODO_FILE` 可覆盖）。
- 并发：多进程通过 mkdir 文件锁 + `revision` + 原子 rename 保证不互相覆盖。
- 防丢数据：写前备份 `todos.json.bak`；文件被删时以内存列表重建；解析失败则拒写。
- 自检：`OPENTODO_SELFTEST=1 dist/Opentodo.app/Contents/MacOS/Opentodo` 跑数据安全与快速模式断言。

## 环境变量

| 变量 | 作用 |
|---|---|
| `OPENTODO_FILE` | 覆盖数据文件路径 |
| `OPENCODE_BIN` | 指定 opencode 可执行文件（App 的对话后端用） |
| `OPENTODO_MCP_SERVER` | 覆盖 `mcp/server.js` 路径（仅独立 MCP 用） |

## 仓库结构

```
plugin/     opencode 插件：提供 opentodo_* 工具 + 注入上下文（App 用这个）
app/        SwiftUI 桌面 App（浮球 + 左侧项目栏面板 + 对话 + 同步）
ios/        SwiftUI iOS App（待办 + 语音 + AI 对话 + 同步）
shared/     数据契约与示例；shared/swift/OpentodoCore 为 Mac/iOS 共用模型与同步客户端
mcp/        独立 stdio MCP server（可选，供其它客户端/开发）+ merge.js 合并引擎
web/        Web 版（服务端 API + React 前端 + 设备配对 + /api/sync）
win/        Windows 桌面版（Electron 主进程 + 复用 web/src 的 React 面板）
scripts/    build-app.sh / install.sh（清理）/ setup-signing.sh
```

## 状态

- ✅ 数据契约 v3（项目/归档/彻底删除 + 跨端墓碑/改名元数据）
- ✅ 插件化工具（无 node / 无独立 MCP，运行在 opencode 运行时）
- ✅ 与全局 opencode 隔离（TUI 只有 build/plan，无 opentodo 模式/工具）
- ✅ App 自包含：bundle 内置插件，运行时 provision 专属配置，解压即用
- ✅ 左侧项目栏、点击就地编辑、拖拽排序（插入横杠）、拖到项目
- ✅ 数据防丢（内存重建 + 备份 + 损坏拒写）、自检通过
- ✅ 三端同步：服务端合并（条目 LWW + 删除墓碑 + 项目改名）、Mac/iOS 离线缓存
- ✅ Windows 桌面版：悬浮球/面板/托盘/快捷键/AI 对话/同步，Electron + React
- ✅ iOS：待办管理 + 中文语音快速记录 + AI 对话（复用服务端模型）
- ⏳ 签名/公证打磨（Mac 当前用稳定自签名/Apple Development，未公证）
