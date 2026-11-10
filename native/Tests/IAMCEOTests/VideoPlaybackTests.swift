import Foundation
import XCTest
@testable import IAMCEO
#if os(macOS)
import AppKit
import AVKit
import SwiftUI
import os
#endif

final class VideoPlaybackSourceTests: XCTestCase {
    private var sourceRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/IAMCEO")
    }

    func testAppSourcesDoNotUseSwiftUIVideoPlayer() throws {
        let files = try XCTUnwrap(FileManager.default.enumerator(at: sourceRoot, includingPropertiesForKeys: nil))
        var checked = 0
        for case let url as URL in files where url.pathExtension == "swift" {
            let source = try String(contentsOf: url, encoding: .utf8)
            XCTAssertNil(source.range(of: #"\bVideoPlayer\s*(?:<[^>]*>)?\s*\("#, options: .regularExpression), url.path)
            checked += 1
        }
        XCTAssertGreaterThan(checked, 0)
    }

    func testCrashDiagnosticIsRegisteredBeforeAppStoreCreation() throws {
        let source = try String(contentsOf: sourceRoot.appendingPathComponent("IAMCEOApp.swift"), encoding: .utf8)
        let initializer = try XCTUnwrap(source.range(of: "    init() {"))
        let body = source[initializer.upperBound...]
        let registration = try XCTUnwrap(body.range(of: "UserDefaults.standard.register(defaults: [\"NSApplicationCrashOnExceptions\": true])"))
        let store = try XCTUnwrap(body.range(of: "let store = AppStore("))
        XCTAssertLessThan(registration.lowerBound, store.lowerBound)
        XCTAssertTrue(body[..<registration.lowerBound].contains("#if os(macOS)"))
    }

    #if os(macOS)
    func testArgumentDomainOverridesRegisteredCrashDefault() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "com.iamceo.video-crash-tests.\(UUID())"))
        let arguments = defaults.volatileDomain(forName: UserDefaults.argumentDomain)
        defer { defaults.setVolatileDomain(arguments, forName: UserDefaults.argumentDomain) }
        defaults.setVolatileDomain([:], forName: UserDefaults.argumentDomain)
        defaults.register(defaults: ["NSApplicationCrashOnExceptions": true])
        XCTAssertTrue(defaults.bool(forKey: "NSApplicationCrashOnExceptions"))
        defaults.setVolatileDomain(["NSApplicationCrashOnExceptions": false], forName: UserDefaults.argumentDomain)
        XCTAssertFalse(defaults.bool(forKey: "NSApplicationCrashOnExceptions"))
        XCTAssertEqual(defaults.volatileDomain(forName: UserDefaults.registrationDomain)["NSApplicationCrashOnExceptions"] as? Bool, true)
    }

    func testCommandLineNOOverridesRegisteredCrashDefault() throws {
        let arguments = ProcessInfo.processInfo.arguments
        guard let flag = arguments.firstIndex(of: "-NSApplicationCrashOnExceptions"),
              arguments.indices.contains(flag + 1), arguments[flag + 1] == "NO" else {
            throw XCTSkip("Run the XCTest bundle with -NSApplicationCrashOnExceptions NO to check actual launch arguments")
        }
        let defaults = UserDefaults.standard
        let previous = defaults.volatileDomain(forName: UserDefaults.registrationDomain)
        defer { defaults.setVolatileDomain(previous, forName: UserDefaults.registrationDomain) }
        defaults.register(defaults: ["NSApplicationCrashOnExceptions": true])
        XCTAssertFalse(defaults.bool(forKey: "NSApplicationCrashOnExceptions"))
        XCTAssertNotNil(defaults.volatileDomain(forName: UserDefaults.argumentDomain)["NSApplicationCrashOnExceptions"])
    }
    #endif
}

#if os(macOS)
@MainActor
final class VideoPlaybackTests: XCTestCase {
    /// A missing local asset exercises native player creation without accessing the app, credentials or a server.
    private func player() -> PauseTrackingPlayer {
        PauseTrackingPlayer(url: URL(fileURLWithPath: "/private/tmp/iamceo-video-crash-missing-\(UUID()).mp4"))
    }

    func testNativePlayerInWindowUpdatesWithoutAutoplayAndStopsOnRemoval() async throws {
        let first = player()
        let hosting = NSHostingView(rootView: AnyView(MediaPlayerView(player: first)))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 180),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = hosting
        defer { window.orderOut(nil); window.contentView = nil }
        try await waitFor(hosting) { self.findPlayer(in: hosting) != nil }
        let native = try XCTUnwrap(findPlayer(in: hosting))
        XCTAssertTrue(native.window === window)
        XCTAssertTrue(native.player === first)
        XCTAssertEqual(native.controlsStyle, .inline)
        XCTAssertEqual(first.rate, 0, "Mounting must not start playback")

        let pauses = first.pauseCount
        hosting.rootView = AnyView(MediaPlayerView(player: first))
        hosting.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertTrue(findPlayer(in: hosting) === native)
        XCTAssertEqual(first.pauseCount, pauses, "An unchanged player must keep playback state")

        let second = player()
        hosting.rootView = AnyView(MediaPlayerView(player: second))
        try await waitFor(hosting) { native.player === second }
        XCTAssertTrue(findPlayer(in: hosting) === native)
        XCTAssertGreaterThan(first.pauseCount, pauses, "Switching files must pause the previous player")
        XCTAssertEqual(second.rate, 0)

        let secondPauses = second.pauseCount
        hosting.rootView = AnyView(EmptyView())
        try await waitFor(hosting) { native.player == nil }
        XCTAssertGreaterThan(second.pauseCount, secondPauses)
        XCTAssertNil(findPlayer(in: hosting))
    }

    func testDismantlePausesAndDetachesPlayer() {
        let player = player()
        let view = AVPlayerView()
        view.player = player
        let pauses = player.pauseCount
        MediaPlayerView.dismantleNSView(view, coordinator: ())
        XCTAssertGreaterThan(player.pauseCount, pauses)
        XCTAssertNil(view.player)
        // Repeated teardown must remain safe.
        MediaPlayerView.dismantleNSView(view, coordinator: ())
        XCTAssertNil(view.player)
    }

    private func waitFor(_ hosting: NSView, _ condition: () -> Bool) async throws {
        for _ in 0..<100 {
            hosting.layoutSubtreeIfNeeded()
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Native player lifecycle did not settle within one second")
    }

    private func findPlayer(in view: NSView) -> AVPlayerView? {
        if let player = view as? AVPlayerView { return player }
        for child in view.subviews {
            if let player = findPlayer(in: child) { return player }
        }
        return nil
    }
}

private final class PauseTrackingPlayer: AVPlayer {
    private nonisolated let pauses = OSAllocatedUnfairLock(initialState: 0)
    var pauseCount: Int { pauses.withLock { $0 } }

    override func pause() {
        pauses.withLock { $0 += 1 }
        super.pause()
    }
}
#endif
