import AppKit
import SwiftUI

final class KeyablePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// Hosting view for the ball. Distinguishes a click from a drag explicitly:
/// the window only moves once the pointer travels past `threshold`, and a
/// mouse-up without movement counts as a click. We never use `performDrag`,
/// which does not start on a non-activating panel.
final class ClickDragHostingView<Content: View>: NSHostingView<Content> {
    var onClick: (() -> Void)?
    var onDragEnd: (() -> Void)?
    var contextMenu: NSMenu?

    private var startMouse: NSPoint = .zero
    private var startOrigin: NSPoint = .zero
    private var moved = false
    private let threshold: CGFloat = 4

    override func hitTest(_ point: NSPoint) -> NSView? { self }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        startMouse = NSEvent.mouseLocation
        startOrigin = window?.frame.origin ?? .zero
        moved = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let window else { return }
        let cur = NSEvent.mouseLocation
        let dx = cur.x - startMouse.x
        let dy = cur.y - startMouse.y
        if !moved, hypot(dx, dy) > threshold { moved = true }
        guard moved else { return }
        window.setFrameOrigin(NSPoint(x: startOrigin.x + dx, y: startOrigin.y + dy))
    }

    override func mouseUp(with event: NSEvent) {
        if moved { onDragEnd?() } else { onClick?() }
    }

    override func rightMouseDown(with event: NSEvent) {
        if let contextMenu, !contextMenu.items.isEmpty {
            NSMenu.popUpContextMenu(contextMenu, with: event, for: self)
        }
    }
}

@MainActor
final class FloatingBallController {
    let panel: KeyablePanel
    var onClick: (() -> Void)?

    private let settings: AppSettings
    private let host: ClickDragHostingView<BallView>
    private let posKey = "opentodo.ball.origin"
    private var moveObserver: NSObjectProtocol?

    init(store: TodoStore, settings: AppSettings) {
        self.settings = settings
        let size = settings.ballDiameter + BallMetrics.padding
        panel = KeyablePanel(
            contentRect: NSRect(x: 0, y: 0, width: size, height: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.isReleasedWhenClosed = false

        host = ClickDragHostingView(rootView: BallView(store: store, settings: settings))
        host.onClick = { [weak self] in self?.onClick?() }
        host.onDragEnd = { [weak self] in self?.snapToEdge() }
        panel.contentView = host

        moveObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didMoveNotification, object: panel, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.saveOrigin() }
        }
    }

    var frame: NSRect { panel.frame }

    func setMenu(_ menu: NSMenu) {
        host.contextMenu = menu
        menu.autoenablesItems = false
    }

    func show() {
        panel.setFrameOrigin(savedOrigin() ?? defaultOrigin())
        panel.orderFrontRegardless()
    }

    func resize() {
        let size = settings.ballDiameter + BallMetrics.padding
        panel.setContentSize(NSSize(width: size, height: size))
        snapToEdge()
    }

    /// Snap to the nearest left/right edge only when close enough; otherwise
    /// keep the dropped position (just clamped on-screen). The vertical position
    /// is preserved either way.
    func snapToEdge() {
        guard let screen = panel.screen ?? NSScreen.main else { return }
        let v = screen.visibleFrame
        let f = panel.frame
        let margin: CGFloat = 10
        let snapDistance: CGFloat = 48

        var x = min(max(f.minX, v.minX + margin), v.maxX - f.width - margin)
        var y = min(max(f.minY, v.minY + margin), v.maxY - f.height - margin)

        if f.midX <= v.minX + snapDistance {
            x = v.minX + margin
        } else if f.midX >= v.maxX - snapDistance {
            x = v.maxX - f.width - margin
        }
        if abs((y + f.height / 2) - v.midY) < 48 {
            y = v.midY - f.height / 2
        }

        panel.setFrame(NSRect(x: x, y: y, width: f.width, height: f.height), display: true, animate: true)
        saveOrigin()
    }

    private func defaultOrigin() -> NSPoint {
        guard let screen = NSScreen.main else { return NSPoint(x: 120, y: 300) }
        let v = screen.visibleFrame
        let size = panel.frame.width
        return NSPoint(x: v.maxX - size - 12, y: v.midY - size / 2)
    }

    private func savedOrigin() -> NSPoint? {
        guard let s = UserDefaults.standard.string(forKey: posKey) else { return nil }
        let p = NSPointFromString(s)
        guard p.x.isFinite, p.y.isFinite, p != .zero else { return nil }
        return p
    }

    private func saveOrigin() {
        UserDefaults.standard.set(NSStringFromPoint(panel.frame.origin), forKey: posKey)
    }
}

private struct PanelResizeEdges: OptionSet {
    let rawValue: Int
    static let left = PanelResizeEdges(rawValue: 1)
    static let right = PanelResizeEdges(rawValue: 2)
    static let bottom = PanelResizeEdges(rawValue: 4)
    static let top = PanelResizeEdges(rawValue: 8)
}

/// A transparent border ring added on top of the window's frame view. It only
/// claims hits within ~6pt of the edges, so interior events pass straight
/// through to the SwiftUI content, while the edges resize the borderless panel
/// and show the proper resize cursors.
final class PanelResizeBorderView: NSView {
    var minPanelSize = NSSize(width: 320, height: 400)

    private let edge: CGFloat = 6
    private var activeEdges: PanelResizeEdges = []
    private var startFrame: NSRect = .zero
    private var startMouse: NSPoint = .zero

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private func edges(at p: NSPoint) -> PanelResizeEdges {
        var e: PanelResizeEdges = []
        if p.x <= edge { e.insert(.left) }
        if p.x >= bounds.width - edge { e.insert(.right) }
        if p.y <= edge { e.insert(.bottom) }
        if p.y >= bounds.height - edge { e.insert(.top) }
        return e
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let p = convert(point, from: superview)
        return edges(at: p).isEmpty ? nil : self
    }

    override func resetCursorRects() {
        let b = bounds
        addCursorRect(NSRect(x: 0, y: 0, width: b.width, height: edge), cursor: .resizeUpDown)
        addCursorRect(NSRect(x: 0, y: b.height - edge, width: b.width, height: edge), cursor: .resizeUpDown)
        addCursorRect(NSRect(x: 0, y: 0, width: edge, height: b.height), cursor: .resizeLeftRight)
        addCursorRect(NSRect(x: b.width - edge, y: 0, width: edge, height: b.height), cursor: .resizeLeftRight)
    }

    override func mouseDown(with event: NSEvent) {
        let e = edges(at: convert(event.locationInWindow, from: nil))
        guard !e.isEmpty else { return }
        activeEdges = e
        startFrame = window?.frame ?? .zero
        startMouse = NSEvent.mouseLocation
    }

    override func mouseDragged(with event: NSEvent) {
        guard !activeEdges.isEmpty, let window else { return }
        let cur = NSEvent.mouseLocation
        let dx = cur.x - startMouse.x
        let dy = cur.y - startMouse.y
        var f = startFrame
        if activeEdges.contains(.left) { f.origin.x += dx; f.size.width -= dx }
        if activeEdges.contains(.right) { f.size.width += dx }
        if activeEdges.contains(.bottom) { f.origin.y += dy; f.size.height -= dy }
        if activeEdges.contains(.top) { f.size.height += dy }

        if f.size.width < minPanelSize.width {
            if activeEdges.contains(.left) { f.origin.x = startFrame.maxX - minPanelSize.width }
            f.size.width = minPanelSize.width
        }
        if f.size.height < minPanelSize.height {
            if activeEdges.contains(.bottom) { f.origin.y = startFrame.maxY - minPanelSize.height }
            f.size.height = minPanelSize.height
        }
        window.setFrame(f, display: true)
    }

    override func mouseUp(with event: NSEvent) {
        activeEdges = []
    }
}

@MainActor
final class TodoPanelController {
    let panel: KeyablePanel
    private let ballFrameProvider: () -> NSRect
    private let isPinned: () -> Bool
    private let ui: UIState
    private var globalMonitor: Any?
    private var localMonitor: Any?
    private var resizeBorder: PanelResizeBorderView?

    init(store: TodoStore, chat: ChatBackend, ui: UIState, ballFrame: @escaping () -> NSRect) {
        self.ui = ui
        self.ballFrameProvider = ballFrame
        self.isPinned = { ui.pinned }
        let width = PanelMetrics.rightMinWidth + (ui.sidebarCollapsed ? 0 : PanelMetrics.sidebarWidth)
        panel = KeyablePanel(
            contentRect: NSRect(x: 0, y: 0, width: width, height: 520),
            styleMask: [.borderless, .nonactivatingPanel, .resizable],
            backing: .buffered,
            defer: false
        )
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isFloatingPanel = true
        panel.isReleasedWhenClosed = false
        panel.isMovableByWindowBackground = true
        panel.minSize = NSSize(width: PanelMetrics.rightMinWidth, height: PanelMetrics.minHeight)
        panel.contentView = NSHostingView(
            rootView: TodoPanelView(
                store: store,
                chat: chat,
                ui: ui,
                onClose: { [weak self] in self?.hide() },
                onToggleSidebar: { [weak self] in self?.toggleSidebar() }
            )
        )
        installResizeBorder()
        installDismissHandlers()
    }

    /// 展开/收起项目栏：先把窗口宽度调整到位，再翻转状态，
    /// 避免 SwiftUI 在旧窗口宽度下先重排造成"多阶段"。
    func toggleSidebar() {
        let collapsed = !ui.sidebarCollapsed
        let delta = collapsed ? -PanelMetrics.sidebarWidth : PanelMetrics.sidebarWidth
        var f = panel.frame
        f.origin.x -= delta
        f.size.width += delta
        if f.size.width < PanelMetrics.rightMinWidth {
            f.size.width = PanelMetrics.rightMinWidth
            f.origin.x = panel.frame.maxX - PanelMetrics.rightMinWidth
        }
        if let screen = panel.screen ?? NSScreen.main {
            let v = screen.visibleFrame
            if f.origin.x < v.minX + 8 { f.origin.x = v.minX + 8 }
            if f.maxX > v.maxX - 8 { f.origin.x = v.maxX - 8 - f.size.width }
        }
        panel.setFrame(f, display: true)
        ui.sidebarCollapsed = collapsed
    }

    /// 在窗口的 frame view 上叠加一个只在边缘响应的透明环，实现无边框窗口缩放。
    private func installResizeBorder() {
        guard resizeBorder == nil, let frameView = panel.contentView?.superview else { return }
        let border = PanelResizeBorderView(frame: frameView.bounds)
        border.minPanelSize = panel.minSize
        border.autoresizingMask = [.width, .height]
        frameView.addSubview(border)
        resizeBorder = border
    }

    deinit {
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
    }

    var isVisible: Bool { panel.isVisible }

    private func installDismissHandlers() {
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            MainActor.assumeIsolated { self?.dismissIfOutside() }
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
            MainActor.assumeIsolated { self?.dismissIfOutside() }
            return event
        }
    }

    private func dismissIfOutside() {
        guard panel.isVisible, !isPinned() else { return }
        let loc = NSEvent.mouseLocation
        if panel.frame.contains(loc) { return }
        if ballFrameProvider().contains(loc) { return }
        hide()
    }

    func show() {
        installResizeBorder()
        position()
        panel.orderFrontRegardless()
        panel.makeKey()
        ui.chatFocusPulse += 1
    }

    func position() {
        let ball = ballFrameProvider()
        let size = panel.frame.size
        var origin = NSPoint(x: ball.minX - size.width, y: ball.minY - size.height)
        if let screen = panel.screen ?? NSScreen.main {
            let v = screen.visibleFrame
            origin.x = min(max(origin.x, v.minX + 8), v.maxX - size.width - 8)
            origin.y = min(max(origin.y, v.minY + 8), v.maxY - size.height - 8)
        }
        panel.setFrameOrigin(origin)
    }

    func hide() { panel.orderOut(nil) }
    func toggle() { isVisible ? hide() : show() }
}
