// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "IAMCEO",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.executable(name: "IAMCEO", targets: ["IAMCEO"])],
    dependencies: [.package(url: "https://github.com/migueldeicaza/SwiftTerm", exact: "1.18.0")],
    targets: [
        .target(name: "AttachmentException", path: "Sources/AttachmentException", publicHeadersPath: "include"),
        .executableTarget(name: "IAMCEO", dependencies: ["AttachmentException", .product(name: "SwiftTerm", package: "SwiftTerm")], path: "Sources/IAMCEO"),
        .testTarget(name: "IAMCEOTests", dependencies: ["IAMCEO", "AttachmentException"], path: "Tests/IAMCEOTests")
    ],
    swiftLanguageModes: [.v6]
)
