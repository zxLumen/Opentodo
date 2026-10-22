import SwiftUI
import UIKit
import OpentodoCore

struct VoiceCaptureView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var speech = SpeechRecognizer()

    @State private var manual = ""
    @State private var message: String?
    @State private var candidates: [TodoItem] = []
    @State private var pendingAction: VoiceAction?
    @State private var pulse = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                Text("说一句话，记一条待办")
                    .font(.headline)
                    .padding(.top, 12)

                ZStack {
                    if speech.isRecording {
                        Circle()
                            .fill(Color.accentColor.opacity(0.16))
                            .frame(width: pulse ? 128 : 96, height: pulse ? 128 : 96)
                            .animation(.easeInOut(duration: 1).repeatForever(autoreverses: true), value: pulse)
                    }
                    Button {
                        if speech.isRecording {
                            speech.stop()
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                                if !speech.transcript.isEmpty { manual = speech.transcript }
                            }
                        } else {
                            speech.start()
                        }
                    } label: {
                        Image(systemName: speech.isRecording ? "stop.fill" : "mic.fill")
                            .font(.system(size: 34, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 76, height: 76)
                            .background(Circle().fill(speech.isRecording ? Color.red : Color.accentColor))
                    }
                }
                .onAppear { pulse = true }

                Text(speech.isRecording ? "正在听…" : (manual.isEmpty ? "点击麦克风开始" : "确认内容后保存"))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                if !speech.transcript.isEmpty && speech.isRecording {
                    Text(speech.transcript)
                        .font(.title3)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                        .transition(.opacity)
                }

                TextField("待办内容", text: $manual, axis: .vertical)
                    .lineLimit(2...6)
                    .textFieldStyle(.roundedBorder)
                    .padding(.horizontal)

                if let error = speech.error {
                    VStack(spacing: 8) {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .multilineTextAlignment(.center)
                        Button("打开系统设置") {
                            if let url = URL(string: UIApplication.openSettingsURLString) {
                                UIApplication.shared.open(url)
                            }
                        }
                        .font(.caption)
                    }
                    .padding(.horizontal)
                }

                if let message {
                    VStack(spacing: 8) {
                        Text(message)
                            .font(.callout)
                            .foregroundStyle(.orange)
                        if candidates.isEmpty {
                            Button("仍然记为一条待办") { forceAdd() }
                                .font(.caption)
                        }
                    }
                }

                if !candidates.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("找到多条匹配，选择一条：")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        ScrollView {
                            VStack(spacing: 8) {
                                ForEach(candidates) { item in
                                    Button {
                                        commit(item)
                                    } label: {
                                        HStack {
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(item.content)
                                                    .foregroundStyle(.primary)
                                                    .multilineTextAlignment(.leading)
                                                Text(item.listName)
                                                    .font(.caption2)
                                                    .foregroundStyle(.secondary)
                                            }
                                            Spacer()
                                            Image(systemName: "chevron.right")
                                                .font(.caption)
                                                .foregroundStyle(.tertiary)
                                        }
                                        .padding(10)
                                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                        .frame(maxHeight: 220)
                    }
                    .padding(.horizontal)
                }

                Spacer()

                HStack(spacing: 12) {
                    Button("取消") { dismiss() }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                    Button("保存") { save() }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(!canSave)
                }
                .padding(.horizontal)
                .padding(.bottom, 12)
            }
            .onAppear {
                speech.start()
            }
            .onDisappear {
                speech.stop()
            }
            .onChange(of: speech.isRecording) { _, recording in
                if !recording, manual.isEmpty, !speech.transcript.isEmpty {
                    manual = speech.transcript
                }
            }
            .onChange(of: speech.transcript) { _, text in
                if speech.isRecording || manual.isEmpty { manual = text }
            }
        }
        .presentationDetents([.large])
    }

    private var canSave: Bool {
        !manual.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !speech.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func save() {
        if speech.isRecording {
            speech.stop()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { finishSave() }
            return
        }
        finishSave()
    }

    private func finishSave() {
        if manual.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !speech.transcript.isEmpty {
            manual = speech.transcript
        }
        let text = manual.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        switch model.handleVoice(text) {
        case .done(let result):
            model.showToast(result)
            dismiss()
        case .notFound(let result):
            message = result
        case .choose(let action, let items):
            pendingAction = action
            candidates = items
            message = nil
            speech.stop()
        }
    }

    private func forceAdd() {
        let text = manual.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        model.add(text)
        model.showToast("已添加：\(text)")
        dismiss()
    }

    private func commit(_ item: TodoItem) {
        guard let action = pendingAction else { return }
        let result = model.commitVoice(action, item: item)
        model.showToast(result)
        dismiss()
    }
}
