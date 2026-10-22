// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Opentodo",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(path: "../shared/swift/OpentodoCore")
    ],
    targets: [
        .executableTarget(
            name: "Opentodo",
            dependencies: [
                .product(name: "OpentodoCore", package: "OpentodoCore")
            ],
            path: "Sources/Opentodo"
        )
    ]
)
