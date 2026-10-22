import SwiftUI
import UIKit
import OpentodoCore

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var serverURL = ""
    @State private var ownerToken = ""
    @State private var pairing = false
    @State private var message: String?
    @State private var messageIsError = false
    @State private var devices: [SyncDevice] = []
    @State private var loadingDevices = false
    @State private var confirmRevoke: SyncDevice?

    var body: some View {
        NavigationStack {
            Form {
                Section("同步") {
                    TextField("服务器地址", text: $serverURL, prompt: Text("https://todo.example.com"))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    SecureField("站长口令", text: $ownerToken, prompt: Text("只用于配对，不会保存在手机里"))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    Button {
                        pair()
                    } label: {
                        HStack {
                            Text(pairing ? "配对中…" : (model.sync.isConfigured ? "重新配对" : "配对并开始同步"))
                            if pairing { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(pairing || serverURL.trimmingCharacters(in: .whitespaces).isEmpty || ownerToken.isEmpty)

                    HStack {
                        Text("状态")
                        Spacer()
                        Text(statusText)
                            .font(.caption)
                            .foregroundStyle(statusColor)
                            .multilineTextAlignment(.trailing)
                    }

                    if model.sync.isConfigured {
                        Button("立即同步") { model.syncNow() }
                        Button("断开同步", role: .destructive) {
                            model.sync.disconnect()
                            message = "已断开同步"
                            messageIsError = false
                            devices = []
                        }
                    }

                    if let message {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(messageIsError ? .red : .green)
                    }
                }

                if model.sync.isConfigured {
                    Section("已配对设备") {
                        if loadingDevices {
                            HStack { ProgressView(); Text("加载中…").font(.caption).foregroundStyle(.secondary) }
                        } else if devices.isEmpty {
                            Text("暂无设备信息").font(.caption).foregroundStyle(.secondary)
                        } else {
                            ForEach(devices) { device in
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack {
                                        Text(device.name)
                                        if device.id == model.settings.deviceId {
                                            Text("本机")
                                                .font(.caption2)
                                                .padding(.horizontal, 5)
                                                .padding(.vertical, 1)
                                                .background(Color.accentColor.opacity(0.15), in: Capsule())
                                        }
                                        Spacer()
                                        if device.id != model.settings.deviceId {
                                            Button("撤销", role: .destructive) { confirmRevoke = device }
                                                .font(.caption)
                                        }
                                    }
                                    Text(device.id)
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        Button("刷新设备列表") { loadDevices() }
                            .font(.caption)
                    }
                }

                Section("同步规则") {
                    Text("以云端为准做合并：同一条待办按更新时间取新；删除永远优先，不会从旧设备复活；首次同步会把手机和云端两边已有待办合并（重复项保留）。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("AI 对话使用服务端已配置的模型，手机上不保存 API Key。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("关于") {
                    LabeledContent("版本", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1")
                    LabeledContent("设备", value: UIDevice.current.name)
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
            .onAppear {
                serverURL = model.settings.serverURL
                loadDevices()
            }
            .confirmationDialog(
                "撤销设备？",
                isPresented: Binding(
                    get: { confirmRevoke != nil },
                    set: { if !$0 { confirmRevoke = nil } }
                ),
                presenting: confirmRevoke
            ) { device in
                Button("撤销 \(device.name)", role: .destructive) {
                    revoke(device)
                }
            } message: { _ in
                Text("该设备需要重新配对才能继续同步。")
            }
        }
    }

    private var statusText: String {
        if !model.sync.isConfigured { return "未启用" }
        switch model.sync.phase {
        case .disabled: return "未启用"
        case .syncing: return "同步中…"
        case .failed(let message): return "失败：\(message)"
        case .idle:
            guard let last = model.sync.lastSyncAt else { return "已连接" }
            let f = DateFormatter()
            f.locale = Locale(identifier: "zh_CN")
            f.dateStyle = .none
            f.timeStyle = .short
            return "上次同步 \(f.string(from: last))"
        }
    }

    private var statusColor: Color {
        if case .failed = model.sync.phase { return .red }
        return .secondary
    }

    private func pair() {
        pairing = true
        message = nil
        Task {
            let error = await model.sync.pair(
                serverURL: serverURL,
                ownerToken: ownerToken,
                deviceName: UIDevice.current.name
            )
            pairing = false
            ownerToken = ""
            if let error {
                message = error
                messageIsError = true
            } else {
                message = "配对成功"
                messageIsError = false
                model.syncNow()
                loadDevices()
            }
        }
    }

    private func loadDevices() {
        guard model.sync.isConfigured else { return }
        loadingDevices = true
        Task {
            devices = (try? await model.sync.devices()) ?? []
            loadingDevices = false
        }
    }

    private func revoke(_ device: SyncDevice) {
        Task {
            do {
                try await model.sync.revoke(device)
                devices.removeAll { $0.id == device.id }
                message = "已撤销 \(device.name)"
                messageIsError = false
            } catch {
                message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                messageIsError = true
            }
        }
    }
}
