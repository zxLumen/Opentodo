import AppKit
import Carbon.HIToolbox
import Combine

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let store = TodoStore.shared
    private let settings = AppSettings.shared
    private let chat = ChatBackend()
    private let ui = UIState()
    private var ball: FloatingBallController!
    private var panel: TodoPanelController!
    private var hotkey: Hotkey?
    private var statusItem: NSStatusItem!
    private var ballMoveObserver: NSObjectProtocol?
    private let settingsWindow = SettingsWindowController()
    private var cancellables = Set<AnyCancellable>()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        store.start()
        chat.prepareEnvironment()

        ball = FloatingBallController(store: store, settings: settings)
        panel = TodoPanelController(
            store: store,
            chat: chat,
            ui: ui,
            ballFrame: { [weak ball] in ball?.frame ?? .zero }
        )
        ball.onClick = { [weak self] in self?.panel.toggle() }
        ball.isPanelOpen = { [weak self] in self?.panel.isVisible ?? false }
        panel.onVisibilityChanged = { [weak ball] in ball?.refreshEdgeState() }
        ball.setMenu(buildMenu())
        ball.show()

        settings.$ballDiameter
            .removeDuplicates()
            .sink { [weak self] _ in MainActor.assumeIsolated { self?.ball.resize() } }
            .store(in: &cancellables)

        ballMoveObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didMoveNotification, object: ball.panel, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.panel.isVisible else { return }
                self.panel.position()
            }
        }

        setupStatusItem()
        setupMainMenu()
        hotkey = Hotkey(
            keyCode: UInt32(kVK_ANSI_T),
            modifiers: UInt32(controlKey | optionKey)
        ) { [weak self] in
            self?.panel.toggle()
        }

        if ProcessInfo.processInfo.environment["OPENTODO_SHOW_PANEL"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.panel.show()
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationWillTerminate(_ notification: Notification) {
        chat.shutdown()
    }

    @objc private func togglePanel() { panel.toggle() }

    @objc private func openSettings() {
        settingsWindow.show(settings: settings, chat: chat)
    }

    @objc private func quit() { NSApp.terminate(nil) }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        let show = NSMenuItem(title: "显示 / 隐藏待办  (⌃⌥T)", action: #selector(togglePanel), keyEquivalent: "")
        let settingsItem = NSMenuItem(title: "设置…", action: #selector(openSettings), keyEquivalent: ",")
        let quitItem = NSMenuItem(title: "退出 Opentodo", action: #selector(quit), keyEquivalent: "q")
        show.target = self
        settingsItem.target = self
        quitItem.target = self
        menu.addItem(show)
        menu.addItem(settingsItem)
        menu.addItem(.separator())
        menu.addItem(quitItem)
        return menu
    }

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(
            systemSymbolName: "checklist",
            accessibilityDescription: "Opentodo"
        )
        statusItem.menu = buildMenu()
    }

    /// Provides the standard Edit menu so the chat TextField (an NSPanel,
    /// accessory app) responds to ⌘Z/X/C/V/A.
    private func setupMainMenu() {
        let main = NSMenu()

        let appMenuItem = NSMenuItem()
        main.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenuItem.submenu = appMenu
        appMenu.addItem(NSMenuItem(title: "设置…", action: #selector(openSettings), keyEquivalent: ","))
        appMenu.addItem(.separator())
        appMenu.addItem(NSMenuItem(title: "退出 Opentodo", action: #selector(quit), keyEquivalent: "q"))

        let editMenuItem = NSMenuItem()
        main.addItem(editMenuItem)
        let editMenu = NSMenu(title: "编辑")
        editMenuItem.submenu = editMenu
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        for item in [appMenu, editMenu] {
            for menuItem in item.items where menuItem.target == nil {
                menuItem.target = nil
            }
            item.autoenablesItems = false
        }
        NSApp.mainMenu = main
    }
}
