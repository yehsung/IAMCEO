// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "IAMCEO",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.executable(name: "IAMCEO", targets: ["IAMCEO"])],
    targets: [
        .executableTarget(name: "IAMCEO", path: "Sources/IAMCEO"),
        .testTarget(name: "IAMCEOTests", dependencies: ["IAMCEO"], path: "Tests/IAMCEOTests")
    ],
    swiftLanguageModes: [.v6]
)
