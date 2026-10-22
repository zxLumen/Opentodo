import Foundation
import Combine
import Speech
import AVFoundation

/// 苹果原生中文语音识别。优先使用设备端模型；不可用时回落到在线识别。
@MainActor
final class SpeechRecognizer: ObservableObject {
    @Published var transcript = ""
    @Published var isRecording = false
    @Published var error: String?

    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var timeout: Task<Void, Never>?
    private var usedOnDevice = false
    private var didFallback = false

    func start() {
        guard !isRecording else { return }
        transcript = ""
        error = nil
        Task { await begin() }
    }

    func stop() {
        guard isRecording || request != nil else { return }
        timeout?.cancel()
        timeout = nil
        request?.endAudio()
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        isRecording = false
        task?.finish()
        task = nil
        request = nil
        deactivateSession()
    }

    private func begin() async {
        guard await requestPermissions() else {
            error = "请在系统设置里允许 Opentodo 使用麦克风和语音识别"
            return
        }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN")), recognizer.isAvailable else {
            error = "中文语音识别暂不可用，请稍后再试"
            return
        }

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: [.duckOthers, .allowBluetooth])
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let req = SFSpeechAudioBufferRecognitionRequest()
            req.shouldReportPartialResults = true
            if #available(iOS 16.0, *) { req.addsPunctuation = true }
            let onDevice = recognizer.supportsOnDeviceRecognition && !didFallback
            if onDevice {
                req.requiresOnDeviceRecognition = true
            }
            usedOnDevice = onDevice
            request = req

            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                req.append(buffer)
            }
            engine.prepare()
            try engine.start()
            isRecording = true

            task = recognizer.recognitionTask(with: req) { [weak self] result, error in
                Task { @MainActor in
                    guard let self else { return }
                    if let result {
                        let text = result.bestTranscription.formattedString
                        if !text.isEmpty { self.transcript = text }
                    }
                    if let error {
                        if self.usedOnDevice && !self.didFallback && self.transcript.isEmpty {
                            // 设备端模型不可用（未下载等）→ 自动回落到在线识别一次。
                            self.didFallback = true
                            self.stop()
                            try? await Task.sleep(nanoseconds: 300_000_000)
                            self.start()
                        } else {
                            self.fail(error.localizedDescription)
                        }
                    } else if result?.isFinal == true {
                        self.stop()
                    }
                }
            }

            // 最长录 60 秒，避免一直占用麦克风。
            timeout = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                guard !Task.isCancelled else { return }
                await MainActor.run { self?.stop() }
            }
        } catch {
            fail(error.localizedDescription)
        }
    }

    private func fail(_ message: String) {
        error = message
        stop()
    }

    private func deactivateSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func requestPermissions() async -> Bool {
        let speech: Bool = await withCheckedContinuation { cont in
            SFSpeechRecognizer.requestAuthorization { status in
                cont.resume(returning: status == .authorized)
            }
        }
        guard speech else { return false }

        if #available(iOS 17.0, *) {
            return await withCheckedContinuation { cont in
                AVAudioApplication.requestRecordPermission { granted in
                    cont.resume(returning: granted)
                }
            }
        } else {
            return await withCheckedContinuation { cont in
                AVAudioSession.sharedInstance().requestRecordPermission { granted in
                    cont.resume(returning: granted)
                }
            }
        }
    }
}
