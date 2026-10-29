// swift-tools-version:5.9
// Keep Your Prompts Swift SDK. The sources live in swift/; this manifest sits at the
// repository root so the package can be added by git URL:
//   .package(url: "https://github.com/keep-your-prompts/keep-your-prompts-sdk.git", from: "0.1.0")
import PackageDescription

// CI sets KYP_SWIFT6=1 to compile this package's own targets in Swift 6 language mode and
// KYP_WERROR=1 to make their warnings errors (dependencies keep their own settings).
// Packages that depend on this one never set them, so no unsafe flags reach them.
var swiftSettings: [SwiftSetting] = [.enableUpcomingFeature("StrictConcurrency")]
if Context.environment["KYP_SWIFT6"] == "1" {
    swiftSettings.append(.unsafeFlags(["-swift-version", "6"]))
}
if Context.environment["KYP_WERROR"] == "1" {
    swiftSettings.append(.unsafeFlags(["-warnings-as-errors"]))
}

let package = Package(
    name: "KeepYourPrompts",
    platforms: [.iOS(.v15), .macOS(.v12), .tvOS(.v15), .watchOS(.v8), .visionOS(.v1)],
    products: [
        .library(name: "KeepYourPrompts", targets: ["KeepYourPrompts"]),
    ],
    dependencies: [
        // SHA-256 on Linux (Apple platforms use CryptoKit).
        .package(url: "https://github.com/apple/swift-crypto.git", "3.0.0"..<"5.0.0"),
    ],
    targets: [
        .target(
            name: "KeepYourPrompts",
            dependencies: [
                .product(name: "Crypto", package: "swift-crypto", condition: .when(platforms: [.linux, .android, .windows])),
            ],
            path: "swift/Sources/KeepYourPrompts",
            swiftSettings: swiftSettings
        ),
        .testTarget(
            name: "KeepYourPromptsTests",
            dependencies: ["KeepYourPrompts"],
            path: "swift/Tests/KeepYourPromptsTests",
            resources: [.copy("Resources/KeepYourPrompts")],
            swiftSettings: swiftSettings
        ),
    ]
)
