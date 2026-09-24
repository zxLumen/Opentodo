import AppKit

MainActor.assumeIsolated {
    if ProcessInfo.processInfo.environment["OPENTODO_SELFTEST"] == "1" {
        exit(SelfTest.run())
    }
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
