# Opentodo iOS

原生 SwiftUI 版：待办 / 项目 / 四段状态 / 拖拽 / 左滑操作 / **语音快速记录** / AI 对话。
数据和 Mac / Web 走同一套 v3 契约与同步协议。

## 打开工程

工程用 [XcodeGen](https://github.com/yonaskolb/XcodeGen) 生成（仓库里也带了生成好的
`Opentodo.xcodeproj`，可以直接打开）：

```bash
cd ios
xcodegen generate
open Opentodo.xcodeproj
```

要求：Xcode 16+，iOS 17+。

## 装到 iPhone

### 免费（推荐先这样）

1. Xcode → 选中 `Opentodo` target → **Signing & Capabilities**。
2. Team 选你的 **Personal Team**（登录 Apple ID 即可，不需要付费）。
3. 把 `PRODUCT_BUNDLE_IDENTIFIER` 改成一个全局唯一的值，例如 `com.你的名字.opentodo`。
4. iPhone 打开「开发者模式」，用数据线连接后 Run。

限制：免费账号签名 **7 天过期**，到期重新 Run 一次即可；最多 3 台设备。想免掉每周重签，
可用 AltStore / SideStore 自动续签，或上 TestFlight（需要 Apple Developer Program，$99/年）。

### TestFlight / App Store

需要付费开发者账号。Archive 后在 App Store Connect 上传构建，TestFlight 每个构建 90 天有效，
不用连 Mac 安装。个人工具不需要真的上架 App Store。

## 真机部署 + 自动续签（沿用 yijing64 / Opencode-Pocket 链路）

免费个人账号的签名 7 天过期，用 Mac 上的 launchd 任务自动续签，手机端零动作。

```bash
cd ios

# 1) 本地 Wi-Fi 密码（gitignore；用于 2.4G/5G 频段自动切换）
cp scripts/wifi.local.sh.example scripts/wifi.local.sh
# 编辑 scripts/wifi.local.sh，填入 CU_77qd / CU_77qd_5G 的密码

# 2) 首次构建 + 安装 + 启动
bash scripts/sync.sh

# 3) 安装每 30 分钟检查一次的自动续签任务
bash scripts/install-autorenew.sh

# 4) 安装独立看门狗（续签脚本自己挂掉时仍能报警）
bash scripts/install-watchdog.sh

# 5) 查看状态 / 手动强制续签
bash scripts/auto-renew.sh --status
bash scripts/auto-renew.sh --force
```

关键点（与参考项目一致）：

- 描述文件剩余 **≤ 3 天** 才触发续签；续签时先清掉本 bundle 的缓存 profile，否则 Xcode
  会复用旧 profile，有效期不会 +7 天。
- **手机端零动作**：续签只 `devicectl install`，不 launch；App 正在运行则本轮顺延。
- 自家光猫会隔离同频段客户端：**Mac 连 2.4G（`CU_77qd`），iPhone 保持 5G（`CU_77qd_5G`）**
  才可达；脚本会自动切频段并在结束后切回。
- 通知走 `terminal-notifier`（launchd 下 `osascript` 不可靠）；日志/状态在
  `ios/.build/auto-renew.log`、`auto-renew.state`。
- launchd 标签：`com.opentodo.ios.autorenew`、`com.opentodo.ios.renewwatch`。
- 免费账号同时最多 3 个 App；如果已经装了两个自签 App，再加 Opentodo 就是第三个。

> 首次部署、以及每次改完 `project.yml` / Swift 代码，执行一次 `bash scripts/sync.sh`。
> 之后日常更新只改代码，续签任务会自己处理签名到期。

## 配对同步

1. Mac / Web 端先部署好带 HTTPS 的 Web 服务（见 `../web/README.md`）。
2. App → 设置 → **同步** → 填 `https://你的域名` + 站长口令 → 配对。
3. 配对成功后设备 token 存钥匙串；口令不落盘。
4. 在设置里可以看已配对设备、撤销其它设备。

同步时机：启动、回前台、本地修改后 1.5 秒防抖、设置里手动同步。
断网时照常记录，联网后自动合并。

## 语音

- 底部麦克风 / 空列表里的「说一句记一条」→ 全屏录音页。
- 使用 `SFSpeechRecognizer`（`zh-CN`），优先设备端识别；设备端模型不可用时自动回落在线识别。
- 识别结果交给本地 `VoiceIntent`：
  - 「加一条 / 帮我记 / 提醒我 …」→ 新增待办；
  - 「完成 / 搞定 …」→ 模糊匹配现有条目，唯一命中直接完成，多条命中让你选；
  - 「删除 / 归档 / 恢复 …」→ 同理；
  - 没有明确动词 → 默认**记成一条待办**，并可以点「仍然记为一条待办」兜底。
- 语音只在识别阶段用到系统能力；待办解析全部本地完成。AI 对话里的麦克风只填输入框，不自动发送。

权限：首次使用会请求麦克风与语音识别；拒绝后可在系统设置里重新开启（录音页有跳转按钮）。

## AI 对话

点右上角 ✨。走服务端 `POST /api/chat`（SSE 流式），模型 / 密钥沿用 Web 端设置，手机上不保存
模型 API Key。AI 在服务端改完待办后，客户端会自动同步拿回结果。对话记录保存在服务端
`data/chat/owner.json`。

## 结构

```
ios/
├─ project.yml            XcodeGen 配置（改工程设置/权限文案改这里）
├─ Opentodo.xcodeproj     生成产物
├─ Opentodo/
│  ├─ OpentodoApp.swift   入口 / scenePhase 同步
│  ├─ AppModel.swift      状态、筛选、语音结果落地、同步调度
│  ├─ LocalStore.swift    本地镜像（原子写 + v3 墓碑）
│  ├─ SyncService.swift   配对 / push / 设备管理
│  ├─ SettingsStore.swift 偏好 + Keychain 设备 token
│  ├─ ChatClient.swift    SSE 对话 + 历史
│  ├─ SpeechRecognizer.swift
│  ├─ VoiceIntent.swift
│  ├─ RootView.swift      项目栏 + 同步状态 + 设置
│  ├─ TodoListView.swift  四段 / 分组 / 拖拽 / 左滑 / 编辑
│  ├─ VoiceCaptureView.swift
│  ├─ ChatView.swift
│  └─ SettingsView.swift
└─ OpentodoTests/         语音意图 + 本地存储单元测试
```

共用模型与同步客户端在 `../shared/swift/OpentodoCore`，Mac App 也依赖它。

## 测试

```bash
cd ios
xcodebuild test -project Opentodo.xcodeproj -scheme Opentodo \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  CODE_SIGNING_ALLOWED=NO
```

## 常见问题

- **语音没反应 / 报权限错误**：系统设置 → Opentodo → 麦克风 / 语音识别；模拟器麦克风走 Mac 输入。
- **同步一直失败**：确认地址是 HTTPS、服务端已升级到带 `/api/sync` 的版本、口令正确；
  设备被撤销后会返回 401，重新配对即可。
- **首次同步后出现重复待办**：预期行为。Mac 本地和云端原来各有一份，合并是并集，不会自动去重。
- **App 打不开 / 闪退**：确认 iOS 17+，并重新用 Xcode Run 一次（免费签名 7 天过期会表现为无法启动）。
