// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Opentodo",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Opentodo",
            path: "Sources/Opentodo"
        )
    ]
)
