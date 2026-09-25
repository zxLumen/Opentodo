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
    var onPress: (() -> Void)?
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
        onPress?()
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

/// A transparent strip that moves the panel window when dragged. Used for the
/// header, since `isMovableByWindowBackground` is off (it would steal the
/// splitter's drag gesture). `performDrag` does not start on a non-activating
/// panel, so the window is moved manually like `ClickDragHostingView`.
final class WindowDragNSView: NSView {
    private var startMouse: NSPoint = .zero
    private var startOrigin: NSPoint = .zero

    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        startMouse = NSEvent.mouseLocation
        startOrigin = window?.frame.origin ?? .zero
    }

    override func mouseDragged(with event: NSEvent) {
        guard let window else { return }
        let cur = NSEvent.mouseLocation
        window.setFrameOrigin(NSPoint(
            x: startOrigin.x + (cur.x - startMouse.x),
            y: startOrigin.y + (cur.y - startMouse.y)
        ))
    }
}

struct WindowDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> WindowDragNSView { WindowDragNSView() }
    func updateNSView(_ nsView: WindowDragNSView, context: Context) {}
}

@MainActor
final class FloatingBallController {
    let panel: KeyablePanel
    var onClick: (() -> Void)?
    /// 由 App 注入：待办面板是否打开（打开时气泡保持滑出，不收起）。
    var isPanelOpen: () -> Bool = { false }

    private enum Edge { case left, right }

    private let settings: AppSettings
    private let host: ClickDragHostingView<BallView>
    private let posKey = "opentodo.ball.origin"
    private var moveObserver: NSObjectProtocol?

    private var edge: Edge?
    private var retracted = false
    private var armed = false
    private var dragging = false
    private var suppressSave = false
    private var edgeTimer: Timer?

    /// 收起时露出的球体比例（1/4）。
    private let revealFraction: CGFloat = 0.25
    private let edgeMargin: CGFloat = 10
    private let snapDistance: CGFloat = 48

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
        host.onPress = { [weak self] in self?.pressBegan() }
        host.onClick = { [weak self] in self?.pressEnded(); self?.onClick?() }
        host.onDragEnd = { [weak self] in self?.pressEnded(); self?.snapToEdge() }
        panel.contentView = host

        moveObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didMoveNotification, object: panel, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, !self.suppressSave else { return }
                self.saveOrigin(self.panel.frame.origin)
            }
        }
    }

    deinit { edgeTimer?.invalidate() }

    var frame: NSRect { panel.frame }

    func setMenu(_ menu: NSMenu) {
        host.contextMenu = menu
        menu.autoenablesItems = false
    }

    func show() {
        panel.setFrameOrigin(savedOrigin() ?? defaultOrigin())
        panel.orderFrontRegardless()
        // 启动时按位置判定是否靠边，靠边则直接收起（无动画）。
        snapToEdge(animated: false)
    }

    func resize() {
        let size = settings.ballDiameter + BallMetrics.padding
        panel.setContentSize(NSSize(width: size, height: size))
        snapToEdge(animated: false)
    }

    /// 面板显隐变化时刷新（打开→保持滑出；关闭→若鼠标不在球上则收起）。
    func refreshEdgeState() { tick() }

    // MARK: - 交互

    private func pressBegan() {
        dragging = true
        stopTimer()
        // 点/拖收起中的气泡时先立即滑出，保证面板锚点位置正确。
        if retracted { setRetracted(false, animated: false) }
    }

    private func pressEnded() {
        dragging = false
        updateTimer()
    }

    /// 吸附到最近的左/右边缘；靠边则收起，中间则普通贴边。
    func snapToEdge(animated: Bool = true) {
        guard let screen = panel.screen ?? NSScreen.main else { return }
        let v = screen.visibleFrame
        let f = panel.frame

        var y = min(max(f.minY, v.minY + edgeMargin), v.maxY - f.height - edgeMargin)
        if abs((y + f.height / 2) - v.midY) < 48 { y = v.midY - f.height / 2 }

        var newEdge: Edge?
        if f.midX <= v.minX + snapDistance { newEdge = .left }
        else if f.midX >= v.maxX - snapDistance { newEdge = .right }

        edge = newEdge
        armed = false
        dragging = false

        let x: CGFloat
        if let newEdge {
            x = revealedX(newEdge)
        } else {
            x = min(max(f.minX, v.minX + edgeMargin), v.maxX - f.width - edgeMargin)
        }
        var target = f
        target.origin = NSPoint(x: x, y: y)
        moveSuppressed(animated: animated) { self.panel.setFrame(target, display: true, animate: animated) }
        saveOrigin(target.origin)

        if newEdge != nil {
            setRetracted(true, animated: animated)
            armed = false
        } else {
            setRetracted(false, animated: animated)
        }
        updateTimer()
    }

    private func updateTimer() {
        if edge != nil && !dragging {
            guard edgeTimer == nil else { return }
            let timer = Timer(timeInterval: 0.06, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick() }
            }
            RunLoop.main.add(timer, forMode: .common)
            edgeTimer = timer
        } else {
            stopTimer()
        }
    }

    private func stopTimer() {
        edgeTimer?.invalidate()
        edgeTimer = nil
    }

    /// 轮询鼠标位置：收起时鼠标进入露出块→滑出；滑出时鼠标离开→收起。
    private func tick() {
        guard edge != nil, !dragging else { return }
        if isPanelOpen() {
            if retracted { setRetracted(false, animated: true) }
            return
        }
        let cursor = NSEvent.mouseLocation
        if retracted {
            if !hotZone().contains(cursor) { armed = true }
            else if armed { setRetracted(false, animated: true) }
        } else if !keepZone().contains(cursor) {
            setRetracted(true, animated: true)
            armed = false
        }
    }

    private func setRetracted(_ value: Bool, animated: Bool) {
        guard let edge, retracted != value else { return }
        retracted = value
        let x = value ? retractedX(edge) : revealedX(edge)
        var f = panel.frame
        f.origin.x = x
        moveSuppressed(animated: animated) { self.panel.setFrame(f, display: true, animate: animated) }
    }

    private func moveSuppressed(animated: Bool, _ body: () -> Void) {
        suppressSave = true
        body()
        DispatchQueue.main.asyncAfter(deadline: .now() + (animated ? 0.4 : 0.05)) { [weak self] in
            self?.suppressSave = false
        }
    }

    // MARK: - 几何

    /// 完全滑出：球体完整位于屏幕内，并离可见边缘留出间距。
    private func revealedX(_ edge: Edge) -> CGFloat {
        guard let screen = panel.screen ?? NSScreen.main else { return panel.frame.origin.x }
        let v = screen.visibleFrame
        switch edge {
        case .left: return v.minX + edgeMargin
        case .right: return v.maxX - panel.frame.width - edgeMargin
        }
    }

    /// 收起：把窗口推到物理屏幕边缘之外，只留 `revealFraction` 的球体可见。
    private func retractedX(_ edge: Edge) -> CGFloat {
        guard let screen = panel.screen ?? NSScreen.main else { return panel.frame.origin.x }
        let full = screen.frame
        let pad = BallMetrics.padding
        let d = settings.ballDiameter
        let visible = d * revealFraction
        switch edge {
        case .right: return full.maxX - pad - visible
        case .left: return full.minX - d + visible - pad
        }
    }

    /// 收起后露出的那一块（相对收起位置计算，与当前是否滑出无关）。
    private func hotZone() -> NSRect {
        guard let edge, let screen = panel.screen ?? NSScreen.main else { return panel.frame }
        var f = panel.frame
        f.origin.x = retractedX(edge)
        let visible = f.intersection(screen.frame)
        return visible.insetBy(dx: -10, dy: -10)
    }

    /// 保持滑出的区域：滑出后的球框(+15) ∪ 边缘露出块。
    /// 鼠标停在边缘露出处时也不会立即收回。
    private func keepZone() -> NSRect {
        panel.frame.insetBy(dx: -15, dy: -15).union(hotZone())
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

    private func saveOrigin(_ origin: NSPoint) {
        UserDefaults.standard.set(NSStringFromPoint(origin), forKey: posKey)
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
    var onVisibilityChanged: (() -> Void)?
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
        // 背景拖动会让可交互视图（如分隔条）的拖动手势被窗口移动抢走，
        // 因此关闭它，改由标题栏的 WindowDragArea 手动移窗。
        panel.isMovableByWindowBackground = false
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
        onVisibilityChanged?()
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

    func hide() { panel.orderOut(nil); onVisibilityChanged?() }
    func toggle() { isVisible ? hide() : show() }
}
