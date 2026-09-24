import Foundation

/// Watches a directory for changes (works with atomic rename writes) and calls
/// `onChange` on the main queue, debounced.
final class DirectoryWatcher {
    private let url: URL
    private let onChange: () -> Void
    private var source: DispatchSourceFileSystemObject?
    private var fd: Int32 = -1
    private var pending: DispatchWorkItem?

    init(url: URL, onChange: @escaping () -> Void) {
        self.url = url
        self.onChange = onChange
    }

    func start() {
        stop()
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        fd = open(url.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let src = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .rename, .delete, .extend, .attrib],
            queue: DispatchQueue.global(qos: .utility)
        )
        src.setEventHandler { [weak self] in
            self?.schedule()
        }
        src.setCancelHandler { [weak self] in
            guard let self, self.fd >= 0 else { return }
            close(self.fd)
            self.fd = -1
        }
        src.resume()
        source = src
    }

    func stop() {
        pending?.cancel()
        pending = nil
        source?.cancel()
        source = nil
    }

    private func schedule() {
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in
            DispatchQueue.main.async { self?.onChange() }
        }
        pending = work
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.15, execute: work)
    }

    deinit { stop() }
}
