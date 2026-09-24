import AppKit

MainActor.assumeIsolated {
    let args = CommandLine.arguments
    if let i = args.firstIndex(of: "--export-icon"), i + 1 < args.count {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        AppIcon.export(to: args[i + 1])
        exit(0)
    }
    if ProcessInfo.processInfo.environment["OPENTODO_SELFTEST"] == "1" {
        exit(SelfTest.run())
    }
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
