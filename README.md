# Opentodo

给 opencode 用的悬浮待办。点桌面上的浮球，从它左下角弹出待办面板——可以用鼠标勾选/添加/编辑/拖拽，也可以直接和 opencode 对话调整。所有客户端共用一份 JSON。

<img src="https://github.com/zxLumen/Opentodo/releases/download/assets/demo.gif" width="640" alt="Opentodo 演示">

**自包含**：App bundle 里带着自己的 opencode 插件，首次运行会在 `~/.config/opentodo/opencode/` 生成一份**只属于 App** 的 opencode 配置。所以它不会污染你的全局 opencode——普通 TUI 会话里没有 opentodo 模式、没有 opentodo 工具。**只要装了 opencode，解压即用**（不需要 node、不需要装 MCP、不需要改全局配置）。

## 架构

```
                    ~/.config/opentodo/todos.json   (唯一真相源, 带 revision)
                              ▲ 原子读写 + 文件锁
             ┌────────────────┼─────────────────────────┐
        Opentodo.app     app 专属插件               (可选) opentodo-mcp
      浮球 + 面板      ~/.config/opentodo/opencode/   mcp/ 独立 stdio server
        (鼠标+对话)      plugins/opentodo.js            (给其它 MCP 客户端/开发用)
                              │ opencode 运行时
                      App 自起的 `opencode serve`
                 (OPENCODE_CONFIG_DIR / OPENCODE_CONFIG)
```

- **数据层**：`~/.config/opentodo/todos.json`（`OPENTODO_FILE` 可覆盖），schema 见 `shared/schema.md`。
- **工具层（关键）**：`plugin/opentodo.js` 是 opencode 插件，注册 `opentodo_*` 工具（增删改查/归档/项目）并往系统提示注入当前项目与待办摘要。它运行在 **opencode 自带的运行时**里，所以**不需要 node、不需要独立的 MCP 进程**。
- **App**：`app/`，SwiftUI + AppKit `NSPanel`。菜单栏常驻 + 可拖浮球 + 面板（**左侧项目栏** + 待办列表 + 对话）。对话后端是 App 自己拉起的 `opencode serve`。
- **MCP（可选）**：`mcp/` 是一个独立的 stdio MCP server，功能与插件一致，供其它 MCP 客户端或开发使用；App 本身不依赖它。

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

- **浮球**：常驻屏幕边缘，可拖动；松手吸附最近左/右边缘；位置记忆；进度环反映**当前项目**完成比例（不含已取消/归档）。
- **打开面板**：点浮球，或全局热键 **⌃⌥T**；面板从浮球左下角弹出；点面板外自动收起。面板**四边可拖拽缩放**（贴边出现缩放光标）。
- **左侧项目栏**：列出「收件箱」+ 各项目（带未完成数），点击切换；右键项目可重命名/删除；底部「+ 新建项目」。点**左上角 checklist 图标**可收起/展开项目栏——**窗口向左扩展/收起，待办区宽度保持不变**；**拖动项目行**可调整顺序（记住状态与顺序）。
- **待办操作**：
  - **手动添加**：待办段顶部有「添加待办」输入框，输入后回车即加到当前项目。
  - 勾选完成；悬停行显示归档/恢复/删除。
  - **编辑**：悬停某行，点行尾的**铅笔图标**就地编辑内容（Enter/失焦保存，Esc 取消），三段（待办/已完成/归档）都可编辑。整行保持可拖拽，互不冲突。
  - **拖拽排序**：拖动行到目标位置，行间会出现一条**插入横杠**提示落点（不再整行高亮）。
  - **拖到左侧项目**：把待办拖到左栏某个项目上，即移动到该项目（子分组保留）。
- **对话调整**：面板底部常驻 AI 对话，输入框随内容增高（Enter 发送 / Option+Enter 换行）。待办通过对话添加（没有独立添加框）。
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
app/        SwiftUI 桌面 App（浮球 + 左侧项目栏面板 + 对话）
mcp/        独立 stdio MCP server（可选，供其它客户端/开发）
shared/     数据契约与示例
scripts/    build-app.sh / install.sh（清理）/ setup-signing.sh
```

## 状态

- ✅ 数据契约 v2（项目/归档/彻底删除）
- ✅ 插件化工具（无 node / 无独立 MCP，运行在 opencode 运行时）
- ✅ 与全局 opencode 隔离（TUI 只有 build/plan，无 opentodo 模式/工具）
- ✅ App 自包含：bundle 内置插件，运行时 provision 专属配置，解压即用
- ✅ 左侧项目栏、点击就地编辑、拖拽排序（插入横杠）、拖到项目
- ✅ 数据防丢（内存重建 + 备份 + 损坏拒写）、自检通过
- ⏳ 签名/公证打磨（当前用稳定自签名/Apple Development，未公证）
