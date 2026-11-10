// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "SonosTube",
    platforms: [.macOS(.v26)],
    targets: [
        .executableTarget(
            name: "SonosTube",
            swiftSettings: [.defaultIsolation(MainActor.self)]
        )
    ]
)
