// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "IAMCEO",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.executable(name: "IAMCEO", targets: ["IAMCEO"])],
    dependencies: [.package(url: "https://github.com/migueldeicaza/SwiftTerm", exact: "1.18.0")],
    targets: [
        .executableTarget(name: "IAMCEO", dependencies: [.product(name: "SwiftTerm", package: "SwiftTerm")], path: "Sources/IAMCEO"),
        .testTarget(name: "IAMCEOTests", dependencies: ["IAMCEO"], path: "Tests/IAMCEOTests")
    ],
    swiftLanguageModes: [.v6]
)
