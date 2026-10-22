import SwiftUI
import Combine
import OpentodoCore

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var showSettings = false
    /// iPhone 上 NavigationSplitView 折叠时，返回后必须清掉选中值，
    /// 否则同一项目会保持灰色且再次点击不会触发导航。
    @State private var selectedList: String?

    var body: some View {
        NavigationSplitView {
            SidebarView(selectedList: $selectedList, showSettings: $showSettings)
                .navigationSplitViewColumnWidth(min: 200, ideal: 240, max: 320)
        } detail: {
            TodoListView()
                .onDisappear { selectedList = nil }
        }
        .onChange(of: selectedList) { _, newValue in
            if let newValue { model.selectList(newValue) }
        }
        .onChange(of: model.lists) { _, lists in
            // 云端同步删除/改名了当前项目时，不要留下一个不存在的选中值。
            if let selectedList, !lists.contains(selectedList) {
                self.selectedList = nil
            }
        }
        .onAppear {
            // 首次进入保留原来的行为：直接打开上次的项目；返回后由 onDisappear 清空。
            if selectedList == nil { selectedList = model.currentList }
        }
        .overlay(alignment: .bottom) {
            if let toast = model.toast {
                Text(toast)
                    .font(.callout.weight(.medium))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                    .shadow(radius: 8, y: 2)
                    .padding(.bottom, 84)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: model.toast)
        .sheet(isPresented: $showSettings) {
            SettingsView()
                .environmentObject(model)
        }
        .onReceive(Timer.publish(every: 60, on: .main, in: .common).autoconnect()) { _ in
            if scenePhase == .active { model.syncNow() }
        }
    }
}

struct SidebarView: View {
    @EnvironmentObject private var model: AppModel
    @Binding var selectedList: String?
    @Binding var showSettings: Bool

    @State private var showNewList = false
    @State private var newListName = ""
    @State private var renaming: String?
    @State private var renameText = ""
    @State private var deleting: String?
    @State private var showChat = false

    var body: some View {
        List(selection: $selectedList) {
            Section("项目") {
                ForEach(model.lists, id: \.self) { name in
                    HStack(spacing: 8) {
                        Image(systemName: name == TodoItem.inboxName ? "tray" : "list.bullet")
                            .foregroundStyle(.secondary)
                            .frame(width: 18)
                        Text(name)
                            .lineLimit(2)
                        Spacer()
                        let count = model.count(for: name)
                        if count > 0 {
                            Text("\(count)")
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }
                    }
                    .tag(name)
                    .contextMenu {
                        Button("重命名") {
                            renameText = name
                            renaming = name
                        }
                        Button("删除", role: .destructive) {
                            deleting = name
                        }
                    }
                }
                .onMove { model.moveLists(from: $0, to: $1) }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Opentodo")
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                SyncBadge()
                Button {
                    showChat = true
                } label: {
                    Image(systemName: "sparkles")
                }
                Button {
                    newListName = ""
                    showNewList = true
                } label: {
                    Image(systemName: "folder.badge.plus")
                }
                Button {
                    showSettings = true
                } label: {
                    Image(systemName: "gearshape")
                }
            }
        }
        .alert("新建项目", isPresented: $showNewList) {
            TextField("项目名称", text: $newListName)
            Button("取消", role: .cancel) {}
            Button("创建") { model.addList(newListName) }
        }
        .alert("重命名项目", isPresented: Binding(
            get: { renaming != nil },
            set: { if !$0 { renaming = nil } }
        )) {
            TextField("新名称", text: $renameText)
            Button("取消", role: .cancel) { renaming = nil }
            Button("保存") {
                if let old = renaming { model.renameList(old, to: renameText) }
                renaming = nil
            }
        }
        .alert("删除项目？", isPresented: Binding(
            get: { deleting != nil },
            set: { if !$0 { deleting = nil } }
        )) {
            Button("取消", role: .cancel) { deleting = nil }
            Button("删除", role: .destructive) {
                if let name = deleting { model.deleteList(name) }
                deleting = nil
            }
        } message: {
            Text("「\(deleting ?? "")」下的待办会一并彻底删除，不可恢复。")
        }
        .sheet(isPresented: $showChat) {
            ChatView()
                .environmentObject(model)
        }
    }
}

struct SyncBadge: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Button {
            model.syncNow()
        } label: {
            Image(systemName: icon)
                .foregroundStyle(color)
        }
        .accessibilityLabel(accessibility)
    }

    private var icon: String {
        if !model.sync.isConfigured { return "icloud.slash" }
        switch model.sync.phase {
        case .syncing: return "arrow.triangle.2.circlepath"
        case .failed: return "exclamationmark.icloud"
        default: return "checkmark.icloud"
        }
    }

    private var color: Color {
        if !model.sync.isConfigured { return .secondary }
        switch model.sync.phase {
        case .failed: return .red
        case .syncing: return .orange
        default: return .green
        }
    }

    private var accessibility: String {
        if !model.sync.isConfigured { return "未启用同步" }
        switch model.sync.phase {
        case .syncing: return "同步中"
        case .failed(let message): return "同步失败：\(message)"
        default: return "已连接同步"
        }
    }
}
