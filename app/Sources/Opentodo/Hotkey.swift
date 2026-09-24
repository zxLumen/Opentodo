import Carbon.HIToolbox

/// Global hotkey via the Carbon hotkey API (no Accessibility permission needed).
final class Hotkey {
    private var ref: EventHotKeyRef?
    private let handler: () -> Void
    private let id: UInt32
    private static var registry: [UInt32: Hotkey] = [:]
    private static var handlerInstalled = false

    init?(keyCode: UInt32, modifiers: UInt32, handler: @escaping () -> Void) {
        self.handler = handler
        self.id = UInt32.random(in: 1...UInt32.max)

        if !Hotkey.handlerInstalled {
            var eventType = EventTypeSpec(
                eventClass: OSType(kEventClassKeyboard),
                eventKind: UInt32(kEventHotKeyPressed)
            )
            let status = InstallEventHandler(
                GetApplicationEventTarget(),
                { _, event, _ -> OSStatus in
                    guard let event else { return noErr }
                    var hkID = EventHotKeyID()
                    let err = GetEventParameter(
                        event,
                        EventParamName(kEventParamDirectObject),
                        EventParamType(typeEventHotKeyID),
                        nil,
                        MemoryLayout<EventHotKeyID>.size,
                        nil,
                        &hkID
                    )
                    if err == noErr, let hotkey = Hotkey.registry[hkID.id] {
                        DispatchQueue.main.async { hotkey.handler() }
                    }
                    return noErr
                },
                1,
                &eventType,
                nil,
                nil
            )
            if status == noErr { Hotkey.handlerInstalled = true }
        }

        Hotkey.registry[id] = self
        let hotKeyID = EventHotKeyID(signature: OSType(0x4F50544F), id: id) // 'OPTO'
        let status = RegisterEventHotKey(
            keyCode, modifiers, hotKeyID, GetApplicationEventTarget(), 0, &ref
        )
        if status != noErr {
            Hotkey.registry[id] = nil
            return nil
        }
    }

    deinit {
        if let ref { UnregisterEventHotKey(ref) }
        Hotkey.registry[id] = nil
    }
}
