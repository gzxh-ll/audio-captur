// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CaptureHelper",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "capture-helper", targets: ["CaptureHelper"])
    ],
    targets: [
        .executableTarget(
            name: "CaptureHelper",
            path: "Sources"
        )
    ]
)

