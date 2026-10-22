import SwiftUI
import OpentodoCore

@main
struct OpentodoApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .active:
                        model.syncNow()
                    case .background:
                        model.syncNow()
                    default:
                        break
                    }
                }
        }
    }
}
