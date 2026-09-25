import SwiftUI

enum PanelMetrics {
    static let sidebarWidth: CGFloat = 150
    static let rightMinWidth: CGFloat = 330
    static let minHeight: CGFloat = 420
}

final class UIState: ObservableObject {
    @Published var focusAdd: Int = 0
    @Published var pinned: Bool = false
    /// 每次面板显示时 +1，视图据此把聊天输入框重新聚焦。
    @Published var chatFocusPulse: Int = 0
    /// 左侧项目栏是否收起（记住状态）。切换时由控制器向左扩展/收起窗口。
    @Published var sidebarCollapsed: Bool {
        didSet { UserDefaults.standard.set(sidebarCollapsed, forKey: "opentodo.sidebarCollapsed") }
    }

    init() {
        sidebarCollapsed = UserDefaults.standard.bool(forKey: "opentodo.sidebarCollapsed")
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

func priorityColor(_ p: String) -> Color {
    switch p {
    case "high": return .red
    case "low": return .secondary
    default: return .orange
    }
}

// MARK: - Floating ball

enum BallStyle: String, CaseIterable {
    case gradientA, glassB, ringC, darkD, minimalE, rainbowF

    /// Change this to pick the ball design.
    static let active: BallStyle = .ringC
}

enum BallMetrics {
    /// Visual diameter of the ball (icon size stays fixed when this changes).
    static let diameter: CGFloat = 64
    /// Extra room around the ball for shadow / badge.
    static let padding: CGFloat = 12
    /// Draw a faint full ring behind the progress ring (style C).
    static let showTrack: Bool = false
}

private let ballBlue1 = Color(hex: 0x4F8DFD)
private let ballBlue2 = Color(hex: 0x2F6BE0)

struct BallView: View {
    @ObservedObject var store: TodoStore
    @ObservedObject var settings: AppSettings

    private var d: CGFloat { CGFloat(settings.ballDiameter) }
    private var pad: CGFloat { BallMetrics.padding }
    private var style: BallStyle { settings.ballStyle }

    private var inList: [TodoItem] {
        guard let list = store.currentList else { return [] }
        return store.items.filter { $0.list == list }
    }

    private var activeCount: Int { inList.filter(\.isActive).count }

    /// Completion ratio within the current project, ignoring archived and
    /// cancelled items so 100% is reachable.
    private var progress: Double {
        let relevant = inList.filter { $0.status != "cancelled" && $0.archivedAt == nil }
        guard !relevant.isEmpty else { return 0 }
        return Double(relevant.filter(\.isDone).count) / Double(relevant.count)
    }

    var body: some View {
        ZStack {
            ZStack(alignment: .topTrailing) {
                shape
                if activeCount > 0, style != .ringC, style != .minimalE {
                    Text("\(activeCount)")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(.red))
                        .offset(x: 7, y: -3)
                }
            }
            .frame(width: d, height: d)

            Image(systemName: "checklist")
                .font(.system(size: iconSize, weight: .semibold))
                .foregroundStyle(iconColor)
                .frame(width: d, height: d)
        }
        .frame(width: d + pad, height: d + pad)
        .contentShape(Circle())
    }

    private var iconSize: CGFloat {
        switch style {
        case .ringC: return 22
        case .minimalE: return 20
        default: return 26
        }
    }

    private var iconColor: Color {
        switch style {
        case .glassB, .ringC: return ballBlue2
        default: return .white
        }
    }

    @ViewBuilder
    private var shape: some View {
        switch style {
        case .gradientA:
            Circle()
                .fill(LinearGradient(colors: [ballBlue1, ballBlue2], startPoint: .top, endPoint: .bottom))
                .overlay(Circle().strokeBorder(.white.opacity(0.25), lineWidth: 1))
                .shadow(color: .black.opacity(0.3), radius: 7, y: 2)
        case .glassB:
            Circle()
                .fill(Color.white.opacity(0.55))
                .overlay(Circle().fill(LinearGradient(colors: [.white.opacity(0.7), .white.opacity(0.15)], startPoint: .topLeading, endPoint: .bottomTrailing)))
                .overlay(Circle().strokeBorder(.white.opacity(0.9), lineWidth: 1))
                .shadow(color: .black.opacity(0.18), radius: 8, y: 3)
        case .ringC:
            ZStack {
                Circle().fill(.white).shadow(color: .black.opacity(0.22), radius: 7, y: 2)
                if BallMetrics.showTrack {
                    Circle()
                        .stroke(ballBlue1.opacity(0.18), lineWidth: 5)
                        .padding(4)
                }
                Circle()
                    .trim(from: 0, to: max(0.001, progress))
                    .stroke(ballBlue1, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .padding(4)
                    .animation(.easeInOut(duration: 0.35), value: progress)
            }
        case .darkD:
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(LinearGradient(colors: [Color(hex: 0x2A3140), Color(hex: 0x161B26)], startPoint: .top, endPoint: .bottom))
                .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(.white.opacity(0.12), lineWidth: 1))
                .shadow(color: .black.opacity(0.35), radius: 8, y: 3)
        case .minimalE:
            ZStack {
                Circle().strokeBorder(ballBlue1.opacity(0.28), lineWidth: 7)
                Circle()
                    .fill(LinearGradient(colors: [ballBlue1, ballBlue2], startPoint: .top, endPoint: .bottom))
                    .frame(width: d * 0.75, height: d * 0.75)
                    .shadow(color: .black.opacity(0.25), radius: 5, y: 2)
            }
        case .rainbowF:
            Circle()
                .fill(AngularGradient(
                    gradient: Gradient(colors: [Color(hex: 0x5B8CFF), Color(hex: 0x8A5CFF), Color(hex: 0xFF6FB5), Color(hex: 0xFFA24F), Color(hex: 0x5B8CFF)]),
                    center: .center
                ))
                .overlay(Circle().strokeBorder(.white.opacity(0.3), lineWidth: 1))
                .shadow(color: .black.opacity(0.3), radius: 7, y: 2)
        }
    }
}

// MARK: - Row

struct TodoRow: View {
    let item: TodoItem
    var onToggle: () -> Void
    var onDelete: () -> Void
    var onArchive: (() -> Void)?
    var onRestore: (() -> Void)?
    var onRename: ((String) -> Void)?
    /// 待办 → 进行中。
    var onStart: (() -> Void)?
    /// 待办/进行中 → 已取消。
    var onCancel: (() -> Void)?
    /// 已取消 → 待办。
    var onReopen: (() -> Void)?
    var onDropBefore: (String) -> Bool
    var draggable: Bool = true
    @State private var hovering = false
    @State private var dropTarget = false
    @State private var editing = false
    @State private var draft = ""
    @FocusState private var editFocused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Button(action: onToggle) {
                Image(systemName: icon)
                    .font(.system(size: 14))
                    .foregroundStyle(item.isDone ? Color.accentColor : .secondary)
            }
            .buttonStyle(.plain)

            // 文本区：内层 `.draggable` 负责拖动；透明 ClickCatcher 精准区分
            // 点击（编辑）与拖拽（排序），不会误触。
            HStack(spacing: 8) {
                if editing {
                    TextField("", text: $draft, axis: .vertical)
                        .textFieldStyle(.plain)
                        .font(.system(size: 13))
                        .lineLimit(1...6)
                        .focused($editFocused)
                        .onExitCommand { editing = false }
                        .onChange(of: editFocused) { _, focused in if !focused { commitEdit() } }
                } else {
                    Text(item.content)
                        .font(.system(size: 13))
                        .strikethrough(item.isDone || isCancelled, color: .secondary)
                        .foregroundStyle(item.isDone || isCancelled ? .secondary : .primary)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 4)
                Circle().fill(priorityColor(item.priority)).frame(width: 6, height: 6)
            }
            .frame(maxWidth: .infinity)

            if hovering, !editing {
                if let onStart {
                    Button(action: onStart) {
                        Image(systemName: "play.circle").font(.system(size: 11))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .help("开始（标记为进行中）")
                }
                if let onCancel {
                    Button(action: onCancel) {
                        Image(systemName: "xmark.circle").font(.system(size: 11))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .help("取消")
                }
                if onRename != nil {
                    Button { beginEdit() } label: {
                        Image(systemName: "pencil").font(.system(size: 11))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .help("编辑")
                }
                if let onArchive {
                    Button(action: onArchive) {
                        Image(systemName: "archivebox").font(.system(size: 11))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .help("归档")
                }
                if let onRestore {
                    Button(action: onRestore) {
                        Image(systemName: "arrow.uturn.backward").font(.system(size: 11))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .help("恢复")
                }
                if let onReopen {
                    Button(action: onReopen) {
                        Image(systemName: "arrow.uturn.backward").font(.system(size: 11))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .help("重新打开")
                }
                Button(action: onDelete) {
                    Image(systemName: "trash").font(.system(size: 11))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("彻底删除")
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .draggable("todo:\(item.id)")
        .dropDestination(for: String.self) { ids, _ in
            guard draggable, !editing, let payload = ids.first, payload.hasPrefix("todo:") else { return false }
            let dragged = String(payload.dropFirst("todo:".count))
            guard dragged != item.id else { return false }
            return onDropBefore(dragged)
        } isTargeted: { dropTarget = $0 }
        // 插入指示：在目标行上缘画一条横杠，而不是高亮覆盖整行。
        .overlay(alignment: .top) {
            if dropTarget {
                Capsule()
                    .fill(Color.accentColor)
                    .frame(height: 2)
                    .padding(.horizontal, 4)
                    .offset(y: -1)
                    .allowsHitTesting(false)
            }
        }
    }

    private func beginEdit() {
        guard onRename != nil, !editing else { return }
        draft = item.content
        editing = true
        DispatchQueue.main.async { editFocused = true }
    }

    private func commitEdit() {
        guard editing else { return }
        editing = false
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty, text != item.content { onRename?(text) }
    }

    private var icon: String {
        if isCancelled { return "minus.circle" }
        if item.isDone { return "checkmark.circle.fill" }
        if item.status == "in_progress" { return "circle.lefthalf.filled" }
        return "circle"
    }

    private var isCancelled: Bool { item.status == "cancelled" }
}

/// 子分组末尾的"追加"投放带：悬停时在该分组下缘显示插入横杠。
private struct AppendDropZone: View {
    var onDrop: (String) -> Void
    @State private var targeted = false

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.clear.frame(height: 12)
            if targeted {
                Capsule()
                    .fill(Color.accentColor)
                    .frame(height: 2)
                    .padding(.horizontal, 4)
            }
        }
        .contentShape(Rectangle())
        .dropDestination(for: String.self) { ids, _ in
            guard let payload = ids.first, payload.hasPrefix("todo:") else { return false }
            onDrop(String(payload.dropFirst("todo:".count)))
            return true
        } isTargeted: { targeted = $0 }
    }
}

/// 左侧项目栏的一行；作为"拖待办到该目录"的投放目标。
/// 选中与拖动排序由外层 `List(selection:)` + `.onMove` 负责。
private struct ProjectSidebarRow: View {
    let name: String?
    let selected: Bool
    let count: Int
    let dropEnabled: Bool
    var onRename: (() -> Void)?
    var onDelete: (() -> Void)?
    var onDropTodo: (String) -> Void
    @State private var targeted = false

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: selected ? "folder.fill" : "folder")
                .font(.system(size: 12))
                .foregroundStyle(selected ? Color.accentColor : .secondary)
            Text(name ?? TodoItem.inboxName)
                .font(.system(size: 12, weight: selected ? .semibold : .regular))
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .help(name ?? TodoItem.inboxName)
            Spacer(minLength: 4)
            if count > 0 {
                Text("\(count)")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(targeted ? Color.accentColor.opacity(0.24) : Color.clear)
        )
        .contextMenu {
            if let onRename { Button("重命名…", action: onRename) }
            if let onDelete { Button("删除", role: .destructive, action: onDelete) }
        }
        .dropDestination(for: String.self) { ids, _ in
            guard dropEnabled, let payload = ids.first, payload.hasPrefix("todo:") else { return false }
            onDropTodo(String(payload.dropFirst("todo:".count)))
            return true
        } isTargeted: { targeted = $0 }
    }
}

// MARK: - Panel

enum PanelSection: String, CaseIterable {
    case active = "待办"
    case inProgress = "进行中"
    case done = "已完成"
    case archive = "归档"
}

struct TodoPanelView: View {
    @ObservedObject var store: TodoStore
    @ObservedObject var chat: ChatBackend
    @ObservedObject var ui: UIState
    var onClose: () -> Void
    var onToggleSidebar: () -> Void

    @State private var chatInput = ""
    @State private var newTodo = ""
    @State private var section: PanelSection = .active
    @State private var showNewProject = false
    @State private var newProjectName = ""
    @State private var renamingProject: String?
    @State private var renameName = ""
    @State private var pendingDeleteName: String?
    @FocusState private var chatFocused: Bool
    @FocusState private var addFocused: Bool

    /// 聊天框高度（用户拖动分隔条设置，持久化）。
    @AppStorage("opentodo.chatHeight") private var storedChatHeight: Double = 160
    @State private var dragStartChat: CGFloat?
    /// list + 分隔条 + 聊天框 这块可分配区域的总高度。
    @State private var regionHeight: CGFloat = 0
    /// 聊天输入行的高度（用于计算聊天框上限，给待办框留空间）。
    @State private var chatInputHeight: CGFloat = 0

    private let chatBottomID = "chatBottom"
    private let chatMinHeight: CGFloat = 64
    private let chatDefaultHeight: CGFloat = 160
    private let chatSplitterHeight: CGFloat = 6
    private let listMinHeight: CGFloat = 110
    private static let cancelledGroupName = "已取消"

    /// 聊天框高度上限：给待办框至少留 `listMinHeight`。
    private var maxChatHeight: CGFloat {
        guard regionHeight > 0 else { return max(chatMinHeight, CGFloat(storedChatHeight)) }
        return max(chatMinHeight, regionHeight - listMinHeight - chatInputHeight - chatSplitterHeight)
    }

    private var effectiveChatHeight: CGFloat {
        min(max(CGFloat(storedChatHeight), chatMinHeight), maxChatHeight)
    }

    var body: some View {
        HStack(spacing: 0) {
            if !ui.sidebarCollapsed {
                projectSidebar
                Divider()
            }
            VStack(spacing: 0) {
                header
                Divider()
                toolbar
                Divider()
                if section == .active || section == .inProgress {
                    if store.lists.isEmpty { noProjectBar } else { addBar }
                    Divider()
                }
                VStack(spacing: 0) {
                    list
                    chatSplitter
                    chatArea
                }
                .background(
                    GeometryReader { geo in
                        Color.clear.preference(key: RegionHeightKey.self, value: geo.size.height)
                    }
                )
                .onPreferenceChange(RegionHeightKey.self) { regionHeight = $0 }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minHeight: PanelMetrics.minHeight)
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(.white.opacity(0.12), lineWidth: 1)
        )
        .alert("新建项目", isPresented: $showNewProject) {
            TextField("项目名称", text: $newProjectName)
            Button("创建") {
                store.addList(name: newProjectName)
                if let created = store.lists.last(where: { $0 == newProjectName.trimmingCharacters(in: .whitespacesAndNewlines) }) {
                    store.currentList = created
                }
                newProjectName = ""
            }
            Button("取消", role: .cancel) { newProjectName = "" }
        }
        .alert("重命名项目", isPresented: renameBinding) {
            TextField("项目名称", text: $renameName)
            Button("保存") {
                if let old = renamingProject { store.renameList(oldName: old, to: renameName) }
                renamingProject = nil
            }
            Button("取消", role: .cancel) { renamingProject = nil }
        }
        .alert("删除项目「\(pendingDeleteName ?? "")」？", isPresented: deleteAlertBinding) {
            Button("取消", role: .cancel) { pendingDeleteName = nil }
            Button("删除", role: .destructive) {
                if let name = pendingDeleteName { store.deleteList(name: name) }
                pendingDeleteName = nil
            }
        } message: {
            Text("其下 \(pendingDeleteName.flatMap(countIn) ?? 0) 条待办将一并删除，不可恢复。")
        }
        .onAppear { chatFocused = true }
        .onChange(of: ui.chatFocusPulse) { _, _ in chatFocused = true }
    }

    private var renameBinding: Binding<Bool> {
        Binding(
            get: { renamingProject != nil },
            set: { if !$0 { renamingProject = nil } }
        )
    }

    /// 统一删除对话框（收件箱与普通项目行为一致）。
    private var deleteAlertBinding: Binding<Bool> {
        Binding(
            get: { pendingDeleteName != nil },
            set: { if !$0 { pendingDeleteName = nil } }
        )
    }

    private func countIn(_ name: String) -> Int {
        store.items.filter { $0.list == name }.count
    }

    private var header: some View {
        HStack(spacing: 8) {
            Button {
                onToggleSidebar()
            } label: {
                Image(systemName: "checklist").foregroundStyle(Color.accentColor)
            }
            .buttonStyle(.plain)
            .help(ui.sidebarCollapsed ? "显示项目栏" : "隐藏项目栏")
            HStack(spacing: 8) {
                Text(store.currentList ?? TodoItem.inboxName)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .help(store.currentList ?? TodoItem.inboxName)
                Text("·")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                Text("\(activeCount) 待办")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity)
            .background(WindowDragArea())
            Button {
                ui.pinned.toggle()
            } label: {
                Image(systemName: ui.pinned ? "pin.fill" : "pin")
            }
            .buttonStyle(.plain)
            .foregroundStyle(ui.pinned ? Color.accentColor : .secondary)
            .help(ui.pinned ? "已置顶（点击其他位置不收起）" : "置顶")
            Button(action: onClose) {
                Image(systemName: "xmark.circle.fill")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
    }

    private var toolbar: some View {
        HStack(spacing: 8) {
            Picker("", selection: $section) {
                ForEach(PanelSection.allCases, id: \.self) { s in
                    Text(s.rawValue).tag(s)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .controlSize(.small)
            .frame(maxWidth: 220)

            Spacer(minLength: 0)

            switch section {
            case .active:
                if store.currentList != nil {
                    Button {
                        pendingDeleteName = store.currentList
                    } label: {
                        Text("删除项目")
                            .font(.system(size: 11))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.red.opacity(0.85))
                    .help("删除当前项目（连同其下待办一并删除）")
                    .disabled(sectionItems.isEmpty)
                }
            case .inProgress:
                EmptyView()
            case .done:
                Button {
                    store.archiveCompleted()
                } label: {
                    Text("移入归档")
                        .font(.system(size: 11))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.accentColor)
                .disabled(sectionItems.isEmpty)
            case .archive:
                Button {
                    store.restoreArchived()
                } label: {
                    Text("全部恢复")
                        .font(.system(size: 11))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.accentColor)
                .help("把当前项目归档的条目全部恢复回已完成")
                .disabled(sectionItems.isEmpty)
                Button {
                    store.purgeArchived()
                } label: {
                    Text("清空归档")
                        .font(.system(size: 11))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.red.opacity(0.85))
                .disabled(sectionItems.isEmpty)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    private var noProjectBar: some View {
        HStack(spacing: 6) {
            Image(systemName: "folder.badge.plus")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            Text("还没有项目，先新建一个再添加待办")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var addBar: some View {
        HStack(spacing: 6) {
            Image(systemName: "plus.circle.fill")
                .font(.system(size: 13))
                .foregroundStyle(Color.accentColor)
            TextField(addPlaceholder, text: $newTodo)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .focused($addFocused)
                .onSubmit(addTodo)
            if !newTodo.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button(action: addTodo) {
                    Image(systemName: "return").font(.system(size: 11))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.accentColor)
                .help("添加到当前项目")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    private var addPlaceholder: String {
        section == .inProgress ? "添加进行中的待办，回车即可…" : "添加待办，回车即可…"
    }

    private func addTodo() {
        let text = newTodo.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        store.add(
            content: text,
            list: store.currentList,
            status: section == .inProgress ? "in_progress" : "pending"
        )
        newTodo = ""
        addFocused = true
    }

    private var projectSidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("项目")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 14)
                .padding(.top, 10)
                .padding(.bottom, 6)
            List(selection: projectSelection) {
                ForEach(store.lists, id: \.self) { name in
                    ProjectSidebarRow(
                        name: name,
                        selected: store.currentList == name,
                        count: activeCount(in: name),
                        dropEnabled: reorderEnabled,
                        onRename: { renameName = name; renamingProject = name },
                        onDelete: { pendingDeleteName = name },
                        onDropTodo: { store.moveToList(id: $0, to: name) }
                    )
                    .tag(name)
                    .listRowInsets(EdgeInsets(top: 1, leading: 8, bottom: 1, trailing: 8))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                }
                .onMove { from, to in store.moveLists(fromOffsets: from, toOffset: to) }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            Divider()
            Button {
                newProjectName = ""
                showNewProject = true
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "folder.badge.plus")
                    Text("新建项目").font(.system(size: 12))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.accentColor)
        }
        .frame(width: PanelMetrics.sidebarWidth)
        .background(Color.primary.opacity(0.04))
    }

    private var projectSelection: Binding<String> {
        Binding(
            get: { store.currentList ?? TodoItem.inboxName },
            set: { store.currentList = $0 }
        )
    }

    private func activeCount(in list: String?) -> Int {
        store.items.filter { $0.list == list && $0.isActive && !$0.isArchived }.count
    }

    private var list: some View {
        List {
            ForEach(groups, id: \.0) { group in
                Section {
                    ForEach(group.1) { item in
                        row(for: item)
                        .listRowInsets(EdgeInsets(top: 1, leading: 8, bottom: 1, trailing: 8))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                    }
                    if reorderEnabled, group.0 != Self.cancelledGroupName {
                        AppendDropZone { dragged in
                            store.move(id: dragged, toProject: group.0, beforeId: nil)
                        }
                        .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 2, trailing: 8))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                    }
                } header: {
                    Text(group.0)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .textCase(nil)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                        .padding(.vertical, 2)
                        .dropDestination(for: String.self) { ids, _ in
                            guard reorderEnabled, group.0 != Self.cancelledGroupName,
                                  let payload = ids.first, payload.hasPrefix("todo:") else { return false }
                            store.move(id: String(payload.dropFirst("todo:".count)), toProject: group.0, beforeId: nil)
                            return true
                        }
                }
            }
            if sectionItems.isEmpty {
                emptyText
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                    .padding(.vertical, 18)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .frame(maxHeight: .infinity)
    }

    @ViewBuilder
    private func row(for item: TodoItem) -> some View {
        let rename: (String) -> Void = { text in
            var copy = item
            copy.content = text
            store.update(copy)
        }
        switch section {
        case .active:
            if item.status == "cancelled" {
                TodoRow(
                    item: item,
                    onToggle: { setStatus(item, "pending") },
                    onDelete: { store.remove(id: item.id) },
                    onRename: rename,
                    onReopen: { setStatus(item, "pending") },
                    onDropBefore: { _ in false },
                    draggable: false
                )
            } else {
                TodoRow(
                    item: item,
                    onToggle: { store.toggle(item) },
                    onDelete: { store.remove(id: item.id) },
                    onRename: rename,
                    onStart: { setStatus(item, "in_progress") },
                    onCancel: { setStatus(item, "cancelled") },
                    onDropBefore: { dragged in
                        store.move(id: dragged, toProject: item.project, beforeId: item.id)
                        return true
                    }
                )
            }
        case .inProgress:
            TodoRow(
                item: item,
                onToggle: { store.toggle(item) },
                onDelete: { store.remove(id: item.id) },
                onRename: rename,
                onCancel: { setStatus(item, "cancelled") },
                onDropBefore: { dragged in
                    store.move(id: dragged, toProject: item.project, beforeId: item.id)
                    return true
                }
            )
        case .done:
            TodoRow(
                item: item,
                onToggle: { store.toggle(item) },
                onDelete: { store.remove(id: item.id) },
                onArchive: { store.archive(id: item.id) },
                onRename: rename,
                onDropBefore: { _ in false },
                draggable: false
            )
        case .archive:
            TodoRow(
                item: item,
                onToggle: {},
                onDelete: { store.purge(id: item.id) },
                onRestore: { store.unarchive(id: item.id) },
                onRename: rename,
                onDropBefore: { _ in false },
                draggable: false
            )
        }
    }

    private func setStatus(_ item: TodoItem, _ status: String) {
        var copy = item
        copy.status = status
        store.update(copy)
    }

    private var emptyText: some View {
        let text = switch section {
        case .active: "这个项目还没有待办。在下面和 AI 说一句，比如「加一条：明天写周报」。"
        case .inProgress: "没有进行中的待办。在「待办」里悬停某条，点「开始」就会移到这里。"
        case .done: "完成的任务会出现在这里，可以逐条归档，或点右上角「移入归档」。"
        case .archive: "归档为空。已完成的条目归档后会在这里，可恢复或彻底删除。"
        }
        return Text(text)
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
            .padding(.vertical, 18)
    }

    /// 待办框与聊天框之间的可拖动分隔条。
    private var chatSplitter: some View {
        ZStack {
            Rectangle().fill(Color.clear)
            Rectangle()
                .fill(Color.primary.opacity(0.14))
                .frame(height: 1)
        }
        .frame(maxWidth: .infinity)
        .frame(height: chatSplitterHeight)
        .contentShape(Rectangle())
        .onContinuousHover { phase in
            switch phase {
            case .active: NSCursor.resizeUpDown.set()
            case .ended: NSCursor.arrow.set()
            }
        }
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { value in
                    let start = dragStartChat ?? effectiveChatHeight
                    if dragStartChat == nil { dragStartChat = start }
                    let proposed = start - value.translation.height
                    storedChatHeight = Double(min(max(proposed, chatMinHeight), maxChatHeight))
                }
                .onEnded { _ in dragStartChat = nil }
        )
        .simultaneousGesture(
            TapGesture(count: 2).onEnded { storedChatHeight = Double(chatDefaultHeight) }
        )
    }

    private var chatArea: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        if chat.messages.isEmpty {
                            Text("和 opencode 对话，让它帮你增删改待办。")
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                                .padding(.vertical, 4)
                        }
                        ForEach(chat.messages) { msg in
                            chatBubble(msg)
                        }
                        if chat.busy {
                            HStack(spacing: 6) {
                                ProgressView().controlSize(.small)
                                Text("思考中…").font(.system(size: 11)).foregroundStyle(.secondary)
                            }
                        }
                        Color.clear
                            .frame(height: 1)
                            .id(chatBottomID)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(height: effectiveChatHeight)
                .onAppear { scrollChatToBottom(proxy, animated: false) }
                .onChange(of: chat.messages.count) { _, _ in scrollChatToBottom(proxy) }
                .onChange(of: chat.busy) { _, _ in scrollChatToBottom(proxy) }
            }

            HStack(alignment: .bottom, spacing: 6) {
                TextField("和 AI 说点什么…", text: $chatInput, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12))
                    .lineLimit(1...6)
                    .focused($chatFocused)
                    .onSubmit(sendChat)
                if chat.busy {
                    Button(action: { chat.stop() }) {
                        Image(systemName: "stop.circle.fill").font(.system(size: 14))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.red)
                    .help("停止")
                } else {
                    Button(action: sendChat) {
                        Image(systemName: "paperplane.fill").font(.system(size: 12))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(chatInput.isEmpty ? .secondary : Color.accentColor)
                    .disabled(chatInput.isEmpty)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(
                GeometryReader { geo in
                    Color.clear.preference(key: ChatInputHeightKey.self, value: geo.size.height)
                }
            )
            .onPreferenceChange(ChatInputHeightKey.self) { chatInputHeight = $0 }
        }
        .contentShape(Rectangle())
        .onTapGesture { chatFocused = true }
    }

    private func chatBubble(_ msg: ChatMessage) -> some View {
        HStack {
            if msg.role == "user" { Spacer(minLength: 20) }
            Text(msg.text)
                .font(.system(size: 12))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 9)
                .padding(.vertical, 6)
                .background(bubbleColor(msg.role), in: RoundedRectangle(cornerRadius: 9))
                .foregroundStyle(msg.role == "user" ? Color.white : .primary)
            if msg.role != "user" { Spacer(minLength: 20) }
        }
    }

    private func bubbleColor(_ role: String) -> Color {
        switch role {
        case "user": return Color.accentColor
        case "system": return Color.red.opacity(0.15)
        default: return Color.primary.opacity(0.08)
        }
    }

    private var activeCount: Int { itemsInList.filter(\.isActive).count }

    /// 当前项目下的条目。
    private var itemsInList: [TodoItem] {
        guard let list = store.currentList else { return [] }
        return store.items.filter { $0.list == list }
    }

    private var sectionItems: [TodoItem] {
        switch section {
        case .active:
            return itemsInList.filter { $0.status == "pending" || $0.status == "cancelled" }
        case .inProgress:
            return itemsInList.filter { $0.status == "in_progress" && !$0.isArchived }
        case .done:
            return itemsInList.filter { $0.status == "completed" && !$0.isArchived }
        case .archive:
            return itemsInList.filter(\.isArchived)
        }
    }

    /// 待办 / 进行中允许拖动排序与拖入项目。
    private var reorderEnabled: Bool { section == .active || section == .inProgress }

    private var groups: [(String, [TodoItem])] {
        let pending = section == .active ? sectionItems.filter { $0.status != "cancelled" } : sectionItems
        var result = groupedByProject(pending)
        if section == .active {
            let cancelled = sectionItems
                .filter { $0.status == "cancelled" }
                .sorted { $0.order < $1.order }
            if !cancelled.isEmpty { result.append((Self.cancelledGroupName, cancelled)) }
        }
        return result
    }

    private func groupedByProject(_ items: [TodoItem]) -> [(String, [TodoItem])] {
        let sorted = items.sorted { a, b in
            let pa = a.project ?? "", pb = b.project ?? ""
            if pa != pb { return pa < pb }
            return a.order < b.order
        }
        var order: [String] = []
        var map: [String: [TodoItem]] = [:]
        for it in sorted {
            let key = it.projectName
            if map[key] == nil { order.append(key) }
            map[key, default: []].append(it)
        }
        return order.map { ($0, map[$0] ?? []) }
    }

    private func sendChat() {
        let text = chatInput
        chatInput = ""
        chat.send(text)
        chatFocused = true
    }

    private func scrollChatToBottom(_ proxy: ScrollViewProxy, animated: Bool = true) {
        DispatchQueue.main.async {
            if animated {
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(chatBottomID, anchor: .bottom)
                }
            } else {
                proxy.scrollTo(chatBottomID, anchor: .bottom)
            }
        }
    }
}

private struct RegionHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct ChatInputHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}
