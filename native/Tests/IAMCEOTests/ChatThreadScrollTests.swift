import Foundation
import SwiftUI
import XCTest
@testable import IAMCEO
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// 0.2.5 iPhone 영어 샘플의 빈 대화 화면. 샘플 서버는 대화 기록을 제대로 주었는데(첫 페이지 11개), 대화 목록이
/// 맨 아래에 머문 채 보이는 자리에 행을 하나도 그리지 않았다. 원인은 목록의 `defaultScrollAnchor(.bottom)` 가운데
/// '내용이 커질 때 아래를 붙잡는' 역할(.sizeChanges)이다: 첫 페이지가 '불러오는 중' 줄 자리에 한꺼번에 들어와 LazyVStack 의
/// 높이 어림이 실제와 어긋나면 그 역할 아래에서 빈 화면이 된다. 글 높이에 따라 나서 한국어도 큰 글자에서 같았다.
/// 고치기 전 코드로 이 시험을 돌리면 iPhone(iOS 26.4)에서 큰 글자 네 경우가 `["history-bottom"]`(글 행 없음)으로 실패한다(Mac 은 재현 안 됨).
@MainActor
final class ChatThreadScrollTests: XCTestCase {
    private final class Frames { var value: [String: CGRect] = [:] }

    private func rowID(_ id: String) -> String { "m:" + Data(id.utf8).base64EncodedString() }

    /// 화면(대화 목록) 안에 들어온 글 행. 맨 아래 표시(history-bottom)의 아래 끝이 보이는 영역의 아래 끝이다(맨 아래에 붙어 있을 때).
    private func visibleRows(_ frames: [String: CGRect]) -> [String: CGRect] {
        guard let bottom = frames["history-bottom"]?.maxY, bottom > 0 else { return [:] }
        return frames.filter { id, frame in id.hasPrefix("m:") && frame.height > 0 && frame.maxY > 1 && frame.minY < bottom - 1 }
    }

    private func sample(_ language: AppLanguage) -> AppStore {
        let store = AppLanguage.withOverride(language) { AppStore(demo: true) }
        if let server = store.sampleServer { server.deliveryDelay = .milliseconds(30); server.replyDelay = .milliseconds(60) }
        return store
    }

    /// 영어 샘플도 한국어와 같은 대화 기록(프로젝트 대화, 팀장 대화, 글이 없는 팀장 대화, 두 번째 프로젝트)을 같은 길로 받는다.
    func testEnglishSampleServesTheSameConversationHistory() async throws {
        var counts: [AppLanguage: [Int]] = [:]
        for language in [AppLanguage.ko, .en] {
            let store = sample(language)
            defer { store.prepareForReplacement() }
            try await waitWhile({ !(store.connectionStatus == .connected && store.state != nil && store.canWrite) }, timeout: .seconds(15))
            var seen: [Int] = []
            for target in [nil, "m-copy", "m-qa"] as [String?] {
                let owner = await store.activateHistory(targetMemberID: target)
                try await waitWhile({ store.history?.initialized != true })
                XCTAssertNil(store.history?.error, "\(language) \(target ?? "project")")
                if let target {
                    XCTAssertTrue(store.historyMessages.allSatisfy { $0.memberId == target || $0.targetMemberId == target })
                }
                seen.append(store.historyMessages.count)
                store.deactivateHistory(ownerID: owner)
            }
            await store.selectProject(id: "sample-ir")
            try await waitWhile({ store.state?.project.id != "sample-ir" || !store.canWrite })
            let owner = await store.activateHistory()
            try await waitWhile({ store.history?.initialized != true })
            seen.append(store.historyMessages.count)
            store.deactivateHistory(ownerID: owner)
            counts[language] = seen
        }
        XCTAssertEqual(counts[.ko], [11, 2, 0, 1])
        XCTAssertEqual(counts[.en], counts[.ko])
    }

    /// 앱 화면(AppShell)째 창에 띄운다. 앱처럼 연결 전에 열어 두어, 첫 페이지가 '불러오는 중' 줄 자리에 한꺼번에 들어오게 한다.
    /// 받은 기록의 마지막 글이 화면 맨 아래에 보이고, 새 글(보낸 글과 팀장의 답)이 오면 그 글까지 따라간다.
    /// 빈 화면은 글 높이에 따라 났다: 두 언어, 두 글자 크기, 두 창 크기에서 본다.
    func testFirstHistoryPageIsDrawnAtTheBottomAndFollowsNewMessages() async throws {
        #if os(macOS)
        let sizes = [CGSize(width: 1200, height: 800), CGSize(width: 1040, height: 680)]
        #else
        let sizes = [CGSize(width: 440, height: 956), CGSize(width: 402, height: 874)]
        #endif
        for language in [AppLanguage.en, .ko] {
            for type in [DynamicTypeSize.large, .xxLarge] {
                for size in sizes { try await checkThread(language: language, type: type, size: size) }
            }
        }
    }

    private func checkThread(language: AppLanguage, type: DynamicTypeSize, size: CGSize) async throws {
        let label = "\(language) \(type) \(Int(size.width))x\(Int(size.height))"
        let store = sample(language)
        defer { store.prepareForReplacement() }
        let router = Router(destination: .chat)
        let frames = Frames()
        let view = AppShell()
            .environment(store).environment(router).environment(store.drafts)
            .environment(\.dynamicTypeSize, type)
            .preferredColorScheme(.dark)
            .onPreferenceChange(ChatMessageFramesKey.self) { value in MainActor.assumeIsolated { frames.value = value } }
        let window = HostWindow(view, size: size)
        defer { window.close() }

        try await waitWhile({ store.history?.initialized != true }, timeout: .seconds(15))
        let rows = store.historyMessages
        XCTAssertEqual(rows.count, 11, label)
        let last = try XCTUnwrap(rows.last, label)
        let shown = await pollUntil("\(label): 받은 기록의 마지막 글이 화면 맨 아래에 보인다", timeout: .seconds(8)) {
            window.layout()
            return visibleRows(frames.value)[rowID(last.id)] != nil
        }
        XCTAssertTrue(shown, "\(label) frames: \(frames.value.keys.sorted())")
        guard shown else { return }

        let sent = await store.sendMessage(text: language == .en ? "Pin the receipt link too" : "영수증 링크도 고정해 주세요", targetMemberID: nil)
        XCTAssertTrue(sent, label)
        try await waitWhile({ !store.historyMessages.contains { !$0.mine && $0.at > last.at } }, timeout: .seconds(10))
        let reply = try XCTUnwrap(store.historyMessages.last, label)
        let followed = await pollUntil("\(label): 새 답글이 화면 맨 아래에 보인다", timeout: .seconds(8)) {
            window.layout()
            return visibleRows(frames.value)[rowID(reply.id)] != nil
        }
        XCTAssertTrue(followed, "\(label) frames: \(frames.value.keys.sorted())")
    }
}

/// 시험에서 SwiftUI 화면을 실제 창에 띄운다(LazyVStack 의 배치와 스크롤은 창 안에서만 돈다).
@MainActor
private final class HostWindow {
    #if os(macOS)
    private let window: NSWindow
    private let hosting: NSView
    init<V: View>(_ view: V, size: CGSize) {
        hosting = NSHostingView(rootView: view)
        window = NSWindow(contentRect: CGRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = hosting
        window.orderFront(nil)
    }
    func layout() { hosting.layoutSubtreeIfNeeded() }
    func close() { window.orderOut(nil); window.contentView = nil }
    #else
    private let window: UIWindow
    init<V: View>(_ view: V, size: CGSize) {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow()
        window.frame = CGRect(origin: .zero, size: size)
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
    }
    func layout() { window.layoutIfNeeded() }
    func close() { window.isHidden = true; window.rootViewController = nil }
    #endif
}
