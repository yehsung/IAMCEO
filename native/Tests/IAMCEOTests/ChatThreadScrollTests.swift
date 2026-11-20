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

    /// 0.2.9: 대화의 첫 쪽이 늦게 와도(멀리서 붙은 폰) 화면이 비지 않는다. 프로젝트 상태에 든 최근 글이 먼저 보이고,
    /// 첫 쪽이 오면 그 기록으로 바뀐 뒤에도 마지막 글이 맨 아래에 그대로 보인다. 고치기 전에는 첫 쪽이 올 때까지 글 행이 하나도 없었다.
    func testRecentMessagesShowWhileTheFirstHistoryPageIsStillLoading() async throws {
        #if os(macOS)
        let size = CGSize(width: 1200, height: 800)
        #else
        let size = CGSize(width: 402, height: 874)
        #endif
        for language in [AppLanguage.ko, .en] {
            let store = sample(language)
            defer { store.prepareForReplacement() }
            store.sampleServer?.historyDelay = .seconds(4)
            let router = Router(destination: .chat)
            let frames = Frames()
            let view = AppShell()
                .environment(store).environment(router).environment(store.drafts)
                .preferredColorScheme(.dark)
                .onPreferenceChange(ChatMessageFramesKey.self) { value in MainActor.assumeIsolated { frames.value = value } }
            let window = HostWindow(view, size: size)
            defer { window.close() }

            try await waitWhile({ store.state == nil }, timeout: .seconds(15))
            let recent = try XCTUnwrap(store.state?.messages.filter { $0.targetMemberId == nil || $0.mine }.last, "\(language)")
            let previewed = await pollUntil("\(language): 첫 쪽을 받기 전에 최근 글이 보인다", timeout: .seconds(3)) {
                window.layout()
                return !visibleRows(frames.value).isEmpty
            }
            XCTAssertTrue(previewed, "\(language) frames: \(frames.value.keys.sorted())")
            XCTAssertNotEqual(store.history?.initialized, true, "\(language): 첫 쪽은 아직 오지 않았다")
            XCTAssertNotNil(visibleRows(frames.value)[rowID(recent.id)] ?? visibleRows(frames.value).first?.value, "\(language)")

            // 미리 보기 동안 보낸 글도 첫 쪽을 기다리지 않고 바로 보인다.
            let text = language == .en ? "Pin the receipt link too" : "영수증 링크도 고정해 주세요"
            // 보내기는 뒤따르는 새로고침까지 기다릴 수 있어(첫 쪽이 와야 끝난다) 따로 돌리고, 그 사이의 화면을 본다.
            let sending = Task { await store.sendMessage(text: text, targetMemberID: nil) }
            let mineShown = await pollUntil("\(language): 미리 보기 동안 보낸 글이 보인다", timeout: .seconds(2)) {
                window.layout()
                guard store.history?.initialized != true, let mine = store.history?.arrivals.last(where: { $0.mine && $0.body == text }) else { return false }
                return visibleRows(frames.value)[rowID(mine.id)] != nil
            }
            XCTAssertTrue(mineShown, "\(language) initialized=\(store.history?.initialized == true) arrivals=\((store.history?.arrivals ?? []).map { "\($0.mine)|\($0.body.prefix(12))|\(frames.value[rowID($0.id)] != nil)" }) rows=\(frames.value.keys.filter { $0.hasPrefix("m:") }.count)")
            let sent = await sending.value
            XCTAssertTrue(sent, "\(language)")

            try await waitWhile({ store.history?.initialized != true }, timeout: .seconds(15))
            let rows = store.historyMessages
            XCTAssertGreaterThanOrEqual(rows.count, 12, "\(language)")
            let last = try XCTUnwrap(rows.last, "\(language)")
            let shown = await pollUntil("\(language): 첫 쪽이 온 뒤에도 마지막 글이 맨 아래에 보인다", timeout: .seconds(8)) {
                window.layout()
                return visibleRows(frames.value)[rowID(last.id)] != nil
            }
            XCTAssertTrue(shown, "\(language) frames: \(frames.value.keys.sorted())")
        }
    }

    /// 0.2.9: 새 팀장·새 프로젝트 화면이 처음 고르는 CLI 는 총괄의 CLI 를 따르고, 총괄이 없으면 설치된 쪽이다.
    func testDefaultProviderFollowsTheLeadThenWhatIsInstalled() {
        XCTAssertEqual(DefaultProvider.choice(lead: "codex", installed: ["claude": true, "codex": true]), "codex")
        XCTAssertEqual(DefaultProvider.choice(lead: "claude", installed: ["claude": false, "codex": true]), "claude")
        XCTAssertEqual(DefaultProvider.choice(lead: nil, installed: ["claude": false, "codex": true]), "codex")
        XCTAssertEqual(DefaultProvider.choice(lead: nil, installed: ["claude": true, "codex": true]), "claude")
        XCTAssertEqual(DefaultProvider.choice(lead: nil, installed: ["claude": false, "codex": false]), "claude")
        XCTAssertEqual(DefaultProvider.choice(lead: nil, installed: [:]), "claude")
        XCTAssertEqual(DefaultProvider.choice(lead: "gemini", installed: ["codex": true]), "claude")
    }

    /// 미리 보기 규칙: 최근 글이 있고 이 대화의 첫 쪽을 아직 받지 못했을 때만. 다른 글을 보여야 하는 경우에는 끼어들지 않는다.
    func testChatPreviewRule() {
        func shows(recent: Int = 3, context: Bool = false, archive: Bool = false, lastSeen: Bool = false, unsupported: Bool = false,
                   initialized: Bool = false, changed: Bool = false, bridging: Bool = false) -> Bool {
            ChatPreview.shows(recentCount: recent, showingContext: context, archive: archive, lastSeen: lastSeen, pagingUnsupported: unsupported,
                              historyInitialized: initialized, storeChanged: changed, bridging: bridging)
        }
        XCTAssertTrue(shows())
        XCTAssertFalse(shows(recent: 0), "보일 글이 없으면 '불러오는 중'으로 기다린다")
        XCTAssertFalse(shows(initialized: true), "첫 쪽을 받았으면 그 기록이 화면의 주인이다")
        XCTAssertFalse(shows(context: true), "특정 글의 앞뒤를 보는 중")
        XCTAssertFalse(shows(archive: true), "보관한 대화")
        XCTAssertFalse(shows(lastSeen: true), "마지막으로 본 상태는 제 글을 보인다")
        XCTAssertFalse(shows(unsupported: true), "최근 글만 주는 옛 서버는 이미 그 글을 보인다")
        XCTAssertFalse(shows(changed: true), "서버 기록이 바뀌었다")
        XCTAssertFalse(shows(bridging: true), "끊긴 사이의 글을 이어 받는 중")
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
