# Opentodo for Windows

Windows 桌面版：悬浮球 + 待办面板 + 托盘 + 全局快捷键 + opencode AI 对话 + 多端同步。
与 macOS / Web / iOS 共用同一份 `todos.json`（schema v3），无需迁移。

## 状态

已实现：

- 待办：四段视图（待办 / 进行中 / 已完成 / 归档）、项目栏、拖拽排序、跨项目拖动、行内编辑、归档/恢复/彻底删除、项目增删改与墓碑
- 悬浮球：透明置顶窗口、拖拽、贴边吸附、自动收起/探出、6 种样式、48–80px 尺寸
- 面板：无边框置顶、失焦自动收起（可固定）、Esc 关闭、项目栏折叠
- 托盘：显示/隐藏、设置、立即同步、开机自启、退出
- 快捷键：默认 `Ctrl+Alt+T`；被占用时回退 `Ctrl+Shift+Alt+T`，可在设置里改
- AI：自动拉起本机 `opencode serve`，加载内置 `opentodo` agent + 插件，自然语言增删改待办
- 同步：设备配对、双向合并、2 秒防抖、面板打开时 45 秒轮询
- 设置：模型/服务商目录、DPAPI 加密的 provider key、opencode 路径/端口/超时、悬浮球、同步
- 打包：NSIS 安装包 + 便携 zip + GitHub Actions

暂未包含：Windows ARM64、代码签名、自动更新、MSIX。

## 前置条件

- Windows 10 21H2+ / Windows 11，x64
- Node.js 22+（仅构建/开发需要；安装包自带 Electron）
- **opencode V2**（`opencode --version` 可用），并且已经按你平时的方式登录/配置好服务商
  - Windows 上 opencode 会读取 `%USERPROFILE%\.config\opencode`；本应用复用它已有的 provider 和凭据，不需要你重新填 key
- 可选：已部署的 Opentodo Web 服务，用于多端同步

## 开发

```powershell
cd win
npm install
# npm 11 可能跳过 electron 的 postinstall；没有 electron.exe 时手动执行一次：
node node_modules/electron/install.js

npm run dev        # Vite + Electron（热更新）
npm test           # node:test 单元测试
npm run typecheck
npm run build      # 主进程 + 渲染进程
npm start          # 运行已构建版本
```

开发时建议用临时数据文件，避免碰到真实待办：

```powershell
$env:OPENTODO_FILE = "$PWD\test-data\todos.json"
npm run dev
```

## 打包

```powershell
npm run icon       # ios 的 1024 图标 → build/icon.ico
npm run dist       # NSIS + portable，输出到 release/
```

产物：

- `win/release/Opentodo-Setup-<version>.exe`
- `win/release/Opentodo-<version>-portable.exe`

当前构建**未签名**，首次运行可能出现 SmartScreen「更多信息 → 仍要运行」。需要签名时配置 `CSC_LINK` / `CSC_KEY_PASSWORD` 后重跑。

## 数据与路径

| 内容 | 路径 |
|---|---|
| 待办（唯一真相源） | `%USERPROFILE%\.config\opentodo\todos.json`（`OPENTODO_FILE` 可覆盖） |
| 当前项目指针 | `%USERPROFILE%\.config\opentodo\.active` |
| 应用设置 | `%APPDATA%\Opentodo\settings.json` |
| 对话历史 | `%APPDATA%\Opentodo\chat-history.json` |
| 日志 | `%APPDATA%\Opentodo\logs\main.log` |
| 应用专属 opencode 配置 | `%USERPROFILE%\.config\opentodo\opencode\.opencode\opencode.json` |
| 内置插件副本 | `%USERPROFILE%\.config\opentodo\opencode\.opencode\plugins\opentodo\index.js` |

待办文件与 macOS / iOS / Web / MCP / opencode 插件完全共用；应用退出不会删除数据。

## 与 opencode 的关系

Windows 版**复用你全局的 opencode 配置**（provider、登录状态、模型目录），只把
`opentodo` agent 和内置插件放在应用自己的 location 下：

```
~/.config/opentodo/opencode/          ← opencode location (cwd)
└─ .opencode/
   ├─ opencode.json                  ← agents.opentodo + 可选 providers
   └─ plugins/opentodo/index.js      ← 仓库里的 plugin/opentodo.js
```

因此：

- 你的普通 opencode 会话里**不会**出现 `opentodo` 模式/工具；
- App 的对话使用 `opentodo` agent，工具被限制为 `opentodo_*`；
- 插件读写同一个 `todos.json`（通过 `OPENTODO_FILE` 传给 serve）。

如果想给某个 provider 单独配 key，可在「设置 → 服务商密钥」里填写；密钥用 Windows
DPAPI（Electron `safeStorage`）加密后写入设置文件，并生成到应用专属的 location 配置里。

## 快捷键与交互

| 操作 | 方式 |
|---|---|
| 显示/隐藏面板 | `Ctrl+Alt+T`（冲突时 `Ctrl+Shift+Alt+T`，可在设置里改） |
| 关闭面板 | `Esc` 或点击面板外 |
| 悬浮球 | 拖动；松手吸附最近边缘；停靠后自动半收起，鼠标移入探出 |
| 悬浮球菜单 | 右键 |
| 托盘 | 左键显示/隐藏，右键菜单 |

## 排错

**找不到 opencode**

- 确认 `opencode --version` 可用；或在「设置 → opencode → 可执行文件」填绝对路径。
- 常见路径：`%APPDATA%\npm\node_modules\@opencode\cli\bin\opencode.exe`、`%USERPROFILE%\.opencode\bin\opencode.exe`。

**对话报「模型不可用 / 地区限制 / 需要开启 Privacy」**

- 这是 opencode 账户/模型本身的问题，不是待办数据问题。换一个模型（设置 → 对话模型）或到 opencode 控制台调整。
- 待办增删改查和同步不依赖模型，仍然可用。

**快捷键没反应**

- 说明 `Ctrl+Alt+T` 被其它程序占用；设置里会显示实际注册成功的组合（常见回退为 `Ctrl+Shift+Alt+T`）。
- 直接在设置里改成没被占用的组合。

**悬浮球被别的窗口挡住 / 点不到**

- 本应用是普通权限进程；如果另一个**以管理员身份运行**的程序（或另一个 always-on-top 悬浮窗）盖住了球，Windows 会先命中它。
- 处理：用全局快捷键打开面板，或让 Opentodo 也以管理员身份运行。

**同步失败**

- 401/403：设备令牌失效，在设置里重新配对。
- 端口/地址：确认 `https://你的域名` 可访问，且服务端 `web/` 已启动。
- Windows 上已有写入重试（`EPERM/EBUSY`），如果仍失败，看 `%APPDATA%\Opentodo\logs\main.log`。

**端口被占用**

- 应用会从设置里的端口开始向后找可用端口（最多 25 个）。可在设置里改起始端口。

## 代码结构

```
win/
├─ electron/           主进程：窗口/托盘/快捷键/存储/对话/同步/IPC
│  └─ windows/         panel / ball / settings 三个窗口
├─ src/                React 渲染进程
│  ├─ ui/              从 web/src 复用的面板 UI（api 层改为 IPC）
│  ├─ panel.tsx
│  ├─ settings.tsx     桌面设置窗口
│  └─ ball.tsx
├─ test/               node:test 单元测试
├─ build/icon.png      图标源（来自 ios 1024 图标）
└─ electron-builder.yml
```

复用：

- `mcp/lib/store.js`：数据契约、mkdir 锁、原子写（Windows 增加 rename 重试）
- `web/ops.js`：所有待办操作
- `web/src/*`：面板组件、拖拽、样式、快速意图
- `plugin/opentodo.js`：AI 工具与上下文注入
