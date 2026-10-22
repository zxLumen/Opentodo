// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "OpentodoCore",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "OpentodoCore", targets: ["OpentodoCore"])
    ],
    targets: [
        .target(name: "OpentodoCore", path: "Sources/OpentodoCore"),
        .testTarget(name: "OpentodoCoreTests", dependencies: ["OpentodoCore"], path: "Tests/OpentodoCoreTests"),
    ]
)
