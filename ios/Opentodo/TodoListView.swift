import SwiftUI
import OpentodoCore

struct TodoListView: View {
    @EnvironmentObject private var model: AppModel
    @State private var newText = ""
    @State private var editing: TodoItem?
    @State private var showVoice = false
    @State private var showChat = false
    @State private var showSettings = false

    var body: some View {
        VStack(spacing: 0) {
            header

            Picker("状态", selection: $model.segment) {
                ForEach(TodoSegment.allCases) { segment in
                    Text(segment.rawValue).tag(segment)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)

            if model.sections.isEmpty {
                emptyState
            } else {
                List {
                    ForEach(model.sections) { section in
                        Section {
                            ForEach(section.items) { item in
                                TodoRow(item: item) { editing = item }
                                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                        actions(for: item)
                                    }
                            }
                            .onMove { model.move(section: section, from: $0, to: $1) }
                        } header: {
                            HStack {
                                Text(section.title)
                                Spacer()
                                Text("\(section.items.count)")
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                .listStyle(.plain)
                .refreshable { await model.refresh() }
            }

            addBar
        }
        .navigationTitle(model.currentList)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                EditButton()
                SyncBadge()
                Button {
                    showChat = true
                } label: {
                    Image(systemName: "sparkles")
                }
                Button {
                    showSettings = true
                } label: {
                    Image(systemName: "gearshape")
                }
            }
        }
        .sheet(item: $editing) { item in
            EditItemView(item: item)
                .environmentObject(model)
        }
        .sheet(isPresented: $showVoice) {
            VoiceCaptureView()
                .environmentObject(model)
        }
        .sheet(isPresented: $showChat) {
            ChatView()
                .environmentObject(model)
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
                .environmentObject(model)
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("\(model.currentItems.filter { $0.isActive && !$0.isArchived }.count) 条未完成")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer()
            Menu {
                Button("把完成的移入归档") { model.archiveCompleted() }
                Button("清空归档", role: .destructive) { model.purgeArchived() }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.title3)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 8)
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: model.segment == .archived ? "archivebox" : "checkmark.circle")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(.tertiary)
            Text(emptyText)
                .font(.callout)
                .foregroundStyle(.secondary)
            Button {
                showVoice = true
            } label: {
                Label("说一句记一条", systemImage: "mic.fill")
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyText: String {
        switch model.segment {
        case .pending: return "这里还很空，记一条吧"
        case .inProgress: return "没有进行中的待办"
        case .completed: return "还没有完成的待办"
        case .archived: return "归档是空的"
        }
    }

    private var addBar: some View {
        HStack(spacing: 10) {
            Button {
                showVoice = true
            } label: {
                Image(systemName: "mic.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(Color.accentColor))
            }
            .accessibilityLabel("语音添加待办")

            HStack(spacing: 8) {
                TextField("添加一条待办…", text: $newText, axis: .vertical)
                    .lineLimit(1...4)
                    .submitLabel(.done)
                    .onSubmit { addFromField() }
                if !newText.trimmingCharacters(in: .whitespaces).isEmpty {
                    Button {
                        addFromField()
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.title2)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func addFromField() {
        let text = newText
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        newText = ""
        model.add(text, status: model.segment == .inProgress ? "in_progress" : "pending")
    }

    @ViewBuilder
    private func actions(for item: TodoItem) -> some View {
        if item.isArchived {
            Button {
                model.unarchive(item)
            } label: {
                Label("恢复", systemImage: "arrow.uturn.backward")
            }
            .tint(.blue)
            Button(role: .destructive) {
                model.delete(item)
            } label: {
                Label("删除", systemImage: "trash")
            }
        } else {
            Button(role: .destructive) {
                model.delete(item)
            } label: {
                Label("删除", systemImage: "trash")
            }

            switch item.status {
            case "pending":
                Button {
                    model.start(item)
                } label: {
                    Label("开始", systemImage: "play")
                }
                .tint(.blue)
                Button {
                    model.cancel(item)
                } label: {
                    Label("取消", systemImage: "minus.circle")
                }
                .tint(.orange)
            case "in_progress":
                Button {
                    model.toggle(item)
                } label: {
                    Label("完成", systemImage: "checkmark")
                }
                .tint(.green)
                Button {
                    model.cancel(item)
                } label: {
                    Label("取消", systemImage: "minus.circle")
                }
                .tint(.orange)
            case "completed":
                Button {
                    model.archive(item)
                } label: {
                    Label("归档", systemImage: "archivebox")
                }
                .tint(.indigo)
                Button {
                    model.reopen(item)
                } label: {
                    Label("重开", systemImage: "arrow.uturn.backward")
                }
                .tint(.orange)
            case "cancelled":
                Button {
                    model.reopen(item)
                } label: {
                    Label("重开", systemImage: "arrow.uturn.backward")
                }
                .tint(.blue)
            default:
                EmptyView()
            }
        }
    }
}

struct TodoRow: View {
    @EnvironmentObject private var model: AppModel
    let item: TodoItem
    let onEdit: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Button {
                model.toggle(item)
            } label: {
                Image(systemName: item.isDone ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 21))
                    .foregroundStyle(item.isDone ? Color.green : Color.secondary)
            }
            .buttonStyle(.plain)
            .disabled(item.isArchived)
            .padding(.top, 1)

            VStack(alignment: .leading, spacing: 3) {
                Text(item.content)
                    .font(.body)
                    .strikethrough(item.status == "cancelled" || item.isDone, color: .secondary)
                    .foregroundStyle(item.status == "cancelled" ? .secondary : .primary)
                    .lineLimit(4)

                HStack(spacing: 6) {
                    if item.status == "in_progress" {
                        tag("进行中", color: .blue)
                    }
                    if item.status == "cancelled" {
                        tag("已取消", color: .gray)
                    }
                    if item.isArchived {
                        tag("归档", color: .indigo)
                    }
                    if item.project != nil {
                        tag(item.projectName, color: .secondary)
                    }
                    if item.priority == "high" {
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                    }
                }
            }
            .contentShape(Rectangle())
            .onTapGesture(perform: onEdit)

            Spacer(minLength: 0)
        }
        .padding(.vertical, 5)
    }

    private func tag(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.12), in: Capsule())
            .foregroundStyle(color)
    }
}

struct EditItemView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    let item: TodoItem
    @State private var text: String
    @State private var targetList: String

    init(item: TodoItem) {
        self.item = item
        _text = State(initialValue: item.content)
        _targetList = State(initialValue: item.listName)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("内容") {
                    TextEditor(text: $text)
                        .frame(minHeight: 90)
                }
                Section("项目") {
                    Picker("所在项目", selection: $targetList) {
                        ForEach(model.lists, id: \.self) { name in
                            Text(name).tag(name)
                        }
                    }
                    LabeledContent("状态", value: statusLabel)
                    if let project = item.project {
                        LabeledContent("分组", value: project)
                    }
                }
                Section {
                    if item.isDone && !item.isArchived {
                        Button("移入归档") {
                            model.archive(item)
                            dismiss()
                        }
                    }
                    if item.isArchived {
                        Button("从归档恢复") {
                            model.unarchive(item)
                            dismiss()
                        }
                    }
                    Button("彻底删除", role: .destructive) {
                        model.delete(item)
                        dismiss()
                    }
                }
            }
            .navigationTitle("编辑待办")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        if targetList != item.listName {
                            model.move(item: item, to: targetList)
                        }
                        if text.trimmingCharacters(in: .whitespacesAndNewlines) != item.content {
                            model.updateContent(item, content: text)
                        }
                        dismiss()
                    }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var statusLabel: String {
        switch item.status {
        case "pending": return "待办"
        case "in_progress": return "进行中"
        case "completed": return "已完成"
        case "cancelled": return "已取消"
        default: return item.status
        }
    }
}
