import SwiftUI
import UIKit
import OpentodoCore

struct ChatView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var speech = SpeechRecognizer()

    @State private var lines: [ChatLine] = []
    @State private var input = ""
    @State private var busy = false
    @State private var error: String?
    @State private var streamTask: Task<Void, Never>?
    @State private var loaded = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            if lines.isEmpty {
                                intro
                            }
                            ForEach(lines) { line in
                                MessageBubble(line: line)
                                    .id(line.id)
                            }
                            if let error {
                                Text(error)
                                    .font(.caption)
                                    .foregroundStyle(.red)
                                    .padding(.horizontal, 4)
                            }
                        }
                        .padding(14)
                    }
                    .onChange(of: lines) { _, _ in
                        if let last = lines.last {
                            withAnimation(.easeOut(duration: 0.15)) {
                                proxy.scrollTo(last.id, anchor: .bottom)
                            }
                        }
                    }
                }

                if speech.isRecording {
                    Text(speech.transcript.isEmpty ? "正在听…" : speech.transcript)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 6)
                }

                inputBar
            }
            .navigationTitle("AI 对话")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") {
                        streamTask?.cancel()
                        speech.stop()
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("清空") {
                        streamTask?.cancel()
                        lines = []
                        if let url = model.settings.baseURL, let token = model.settings.token {
                            Task { await ChatClient(baseURL: url, token: token).saveHistory([]) }
                        }
                    }
                    .disabled(lines.isEmpty || busy)
                }
            }
            .task {
                if !loaded {
                    loaded = true
                    await loadHistory()
                }
            }
            .onChange(of: speech.transcript) { _, text in
                if speech.isRecording || input.isEmpty { input = text }
            }
        }
    }

    private var intro: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("可以让我帮你整理待办")
                .font(.headline)
            Text("例如：\n· 把今天要做的拆成三条\n· 完成买牛奶\n· 列一下这个项目的待办")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 20)
    }

    private var inputBar: some View {
        HStack(spacing: 8) {
            Button {
                if speech.isRecording {
                    speech.stop()
                } else {
                    speech.start()
                }
            } label: {
                Image(systemName: speech.isRecording ? "waveform" : "mic")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(speech.isRecording ? .red : .secondary)
                    .frame(width: 38, height: 38)
                    .background(Color(.secondarySystemBackground), in: Circle())
            }
            .accessibilityLabel("语音输入")

            TextField("和 AI 说…", text: $input, axis: .vertical)
                .lineLimit(1...4)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))

            if busy {
                Button {
                    streamTask?.cancel()
                    streamTask = nil
                    busy = false
                } label: {
                    Image(systemName: "stop.circle.fill")
                        .font(.title2)
                        .foregroundStyle(.red)
                }
            } else {
                Button {
                    send()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                }
                .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func send() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !busy else { return }
        guard let url = model.settings.baseURL, let token = model.settings.token else {
            error = "请先在设置里配对同步服务器（AI 对话走服务端模型）"
            return
        }
        input = ""
        speech.stop()
        error = nil
        lines.append(ChatLine(role: "user", text: text))
        lines.append(ChatLine(role: "assistant", text: ""))
        let convo = Array(lines.dropLast())
        busy = true

        let client = ChatClient(baseURL: url, token: token)
        streamTask = Task {
            do {
                for try await event in client.stream(messages: convo, list: model.currentList) {
                    switch event {
                    case .delta(let delta):
                        if let i = lines.indices.last {
                            lines[i].text += delta
                        }
                    case .done(let final):
                        if let i = lines.indices.last, !final.isEmpty {
                            lines[i].text = final
                        }
                    case .error(let message):
                        error = message
                    }
                }
            } catch {
                if !Task.isCancelled {
                    self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                    if let i = lines.indices.last, lines[i].text.isEmpty {
                        lines[i].text = "模型暂时不可用"
                    }
                }
            }
            busy = false
            streamTask = nil
            let history = lines.filter { !$0.text.isEmpty }
            await client.saveHistory(history)
            await MainActor.run { model.scheduleSync(after: 0.5) }
        }
    }

    private func loadHistory() async {
        guard let url = model.settings.baseURL, let token = model.settings.token else { return }
        if let history = try? await ChatClient(baseURL: url, token: token).loadHistory() {
            lines = history
        }
    }
}

private struct MessageBubble: View {
    let line: ChatLine

    var body: some View {
        HStack {
            if line.role == "user" { Spacer(minLength: 40) }
            Text(line.text.isEmpty ? "…" : line.text)
                .textSelection(.enabled)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    line.role == "user" ? Color.accentColor : Color(.secondarySystemBackground),
                    in: RoundedRectangle(cornerRadius: 14)
                )
                .foregroundStyle(line.role == "user" ? .white : .primary)
            if line.role != "user" { Spacer(minLength: 40) }
        }
    }
}
