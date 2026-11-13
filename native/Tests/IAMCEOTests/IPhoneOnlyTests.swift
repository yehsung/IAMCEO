// E8: iPhone 에서만 컴파일되는 경로(입력칸, 배경 복귀, 알림 탭)의 시험. Mac 의 `swift test` 에는 들어가지 않고,
// 같은 시험 폴더를 iPhone 시뮬레이터에서 돌리는 `bash scripts/check.sh ios` 에서만 돈다.
#if os(iOS)
import SwiftUI
import UIKit
import XCTest
@testable import IAMCEO

@MainActor final class IPhoneOnlyTests: XCTestCase {
    private func connect(_ network: IsolatedTestNetwork) async -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "test"
        await store.connect()
        return store
    }

    // 공용 pollUntil(TestSupport)을 부르는 얇은 껍데기. 기한은 느린 CI 러너에 맞춘 공용 기본값(10초)을 쓴다.
    private func eventually(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        await pollUntil(file: file, line: line) { condition() }
    }

    // MARK: 입력칸 — UIKit 입력칸(IOSComposerTextView)이 IME 와 커서를 쥔다

    /// 입력칸의 바깥 값(초안 복원, 보내고 비우기)과 화면 사이의 상태.
    @MainActor private final class ComposerBox {
        var text = ""
        var focused = false
        var revision = 0
    }

    private func composer(_ box: ComposerBox) -> (IOSComposerTextView.Coordinator, IOSComposerTextView.Editor) {
        let view = IOSComposerTextView(text: Binding(get: { box.text }, set: { box.text = $0 }),
                                       focused: Binding(get: { box.focused }, set: { box.focused = $0 }),
                                       placeholder: "메시지", textRevision: { box.revision })
        let coordinator = view.makeCoordinator()
        let editor = IOSComposerTextView.Editor()
        editor.font = .preferredFont(forTextStyle: .subheadline)
        editor.textChanged = { [weak coordinator, weak editor] in
            guard let coordinator, let editor else { return }
            coordinator.textViewDidChange(editor)
        }
        return (coordinator, editor)
    }

    func testComposerRestoresADraftWithItsLineSpacingAndTheCaretAtTheEnd() {
        let box = ComposerBox()
        let (coordinator, editor) = composer(box)
        coordinator.synchronize(editor, text: "안녕하세요", revision: 1)
        XCTAssertEqual(editor.text, "안녕하세요")
        XCTAssertEqual(editor.selectedRange, NSRange(location: 5, length: 0))
        // `text =` 로 넣으면 문단 모양이 빠져 복원한 초안의 줄 간격(웹 22pt 줄)이 사라진다.
        let style = editor.attributedText.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle
        XCTAssertEqual(style?.lineSpacing, 4)
        // 같은 판(이미 반영한 것)이나 옛 판은 커서를 다시 옮기지 않는다.
        editor.selectedRange = NSRange(location: 2, length: 0)
        coordinator.synchronize(editor, text: "다른 글", revision: 1)
        XCTAssertEqual(editor.text, "안녕하세요")
        XCTAssertEqual(editor.selectedRange, NSRange(location: 2, length: 0))
        // 보내고 비우기는 새 판이라 그대로 들어간다.
        coordinator.synchronize(editor, text: "", revision: 2)
        XCTAssertEqual(editor.text, "")
    }

    func testComposerTypingReachesTheDraftOnceTheInputFinishes() {
        let box = ComposerBox()
        let (coordinator, editor) = composer(box)
        coordinator.synchronize(editor, text: "", revision: 0)
        var changes = 0
        editor.textChanged = { [weak coordinator, weak editor] in
            changes += 1
            guard let coordinator, let editor else { return }
            XCTAssertFalse(editor.isHandlingInput, "입력이 끝난 뒤에만 바깥 값을 고친다")
            coordinator.textViewDidChange(editor)
        }
        editor.insertText("보고")
        XCTAssertEqual(changes, 1)
        XCTAssertEqual(box.text, "보고")
        // 입력 도중(UIKit 이 글을 넣는 중)의 변경 알림은 바깥 값을 건드리지 않는다.
        XCTAssertFalse(editor.isHandlingInput)
    }

    func testComposerNeverOverwritesKoreanTextStillBeingComposed() throws {
        let box = ComposerBox()
        let (coordinator, editor) = composer(box)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.addSubview(editor)
        editor.frame = CGRect(x: 0, y: 0, width: 300, height: 44)
        window.makeKeyAndVisible()
        defer { editor.resignFirstResponder(); window.isHidden = true }
        coordinator.synchronize(editor, text: "확인", revision: 1)
        XCTAssertTrue(editor.becomeFirstResponder())
        editor.setMarkedText("ㅎ", selectedRange: NSRange(location: 1, length: 0))
        XCTAssertNotNil(editor.markedTextRange, "조합 중인 글자가 있다")
        let composing = editor.text
        // 조합 중에 바깥 값(다른 기기의 초안, 복원)이 와도 조합 중인 글을 덮지 않는다.
        coordinator.synchronize(editor, text: "바깥 값", revision: 2)
        XCTAssertEqual(editor.text, composing)
        XCTAssertNotNil(editor.markedTextRange)
        // 조합을 끝내면(unmarkText) 그 글이 바깥 값이 된다.
        editor.unmarkText()
        XCTAssertNil(editor.markedTextRange)
        XCTAssertEqual(box.text, editor.text)
        XCTAssertTrue(box.text.hasPrefix("확인"))
    }

    // MARK: 배경 복귀 — iPhone 은 '비활성'(제어 센터, 권한 창)에서도 쉰다. 돌아오면 다시 읽는다

    func testLeavingTheForegroundPausesAndReturningReadsAgain() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        defer { store.disconnect() }
        let lifecycle = ApplicationLifecycle()
        XCTAssertFalse(ApplicationLifecycle.syncs(in: .inactive), "iPhone 은 비활성에서 동기화를 멈춘다")
        lifecycle.active = ApplicationLifecycle.syncs(in: .active); lifecycle.apply(to: store)
        lifecycle.active = ApplicationLifecycle.syncs(in: .background); lifecycle.apply(to: store)
        let reads = { network.requests.filter { $0.url?.path == "/api/sync" }.count }
        let before = reads()
        lifecycle.active = ApplicationLifecycle.syncs(in: .active); lifecycle.apply(to: store)
        XCTAssertTrue(store.isRevalidating, "돌아오면 새 스냅샷이 올 때까지 쓰기를 잠근다")
        await eventually { reads() > before && !store.isRevalidating }
        XCTAssertEqual(store.connectionStatus, .connected)
    }

    func testProtectedDataLockPausesUntilTheDeviceUnlocks() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        defer { store.disconnect() }
        let lifecycle = ApplicationLifecycle()
        lifecycle.active = true; lifecycle.apply(to: store)
        // 잠금으로 보호된 자료를 못 읽게 되면 앞에 있어도 쉰다(iPhone 전용 알림 경로).
        lifecycle.protectedDataAvailable = false; lifecycle.apply(to: store)
        let reads = { network.requests.filter { $0.url?.path == "/api/sync" }.count }
        let before = reads()
        lifecycle.protectedDataAvailable = true; lifecycle.apply(to: store)
        await eventually { reads() > before && !store.isRevalidating }
    }

    func testReleasingTheTerminalRunsUnderABackgroundTaskAndFinishes() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        defer { store.disconnect() }
        let member = try XCTUnwrap(store.members.first)
        let claimed = await store.claimTerminal(member)
        XCTAssertTrue(claimed)
        XCTAssertNotNil(store.terminalLeases[member.id])
        // iPhone 은 놓기를 배경 작업으로 감싼다: 앱이 배경으로 가도 놓기 요청이 끝까지 간다.
        let released = await store.releaseTerminal(member)
        XCTAssertTrue(released)
        XCTAssertNil(store.terminalLeases[member.id])
        XCTAssertEqual(server.read { $0.terminalBodies.last?["action"] as? String }, "release")
    }

    // MARK: 알림 탭 — iPhone 은 팀원 화면을 탭 안의 쌓기(phonePaths)로 연다

    func testTappedStaffNotificationOpensTheMemberOnThePhoneStack() async throws {
        let server = ManagementNavigationServer(), network = try IsolatedTestNetwork { try server.handle($0) }
        // 서버가 알림 사건의 실제 대상을 알려 준다(알림에 실린 대상은 힌트일 뿐이다).
        server.change { $0.target = .team(projectId: "p", memberId: "m") }
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        await store.connect()
        await store.selectProject(id: "p")
        defer { store.disconnect() }
        // NotificationAppDelegate 가 탭에서 읽는 것과 같은 모양: 알림 userInfo 의 "iamceo" 칸.
        let metadata = try JSONEncoder().encode(PushNotificationMetadata(v: 1, serverId: ManagementNavigationServer.serverID,
                                                                         eventId: UUID().uuidString, kind: "error",
                                                                         target: .team(projectId: "p", memberId: "m")))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: metadata) as? [String: Any])
        let link = try XCTUnwrap(NotificationLink.parse(payload: ["aps": ["alert": "막힘"], "iamceo": object]))
        let inbox = NotificationInbox(), router = Router(destination: .home)
        XCTAssertTrue(router.usesPhoneNavigation)
        inbox.receive(link, tapped: true)
        await store.processNotifications(router: router, inbox: inbox)
        XCTAssertEqual(store.selectedProjectID, "p")
        XCTAssertEqual(router.destination, .team)
        XCTAssertEqual(router.phonePaths[.team], [.member("m")])
        XCTAssertNil(router.memberID, "iPhone 은 Mac 의 옆 칸 선택을 쓰지 않는다")
        XCTAssertTrue(inbox.pending.isEmpty)
    }

    @MainActor private final class PushRecorder {
        var tokens: [(Data, UUID)] = []
        var failures: [UUID] = []
    }

    func testRemoteNotificationRegistrationsRunOneAtATime() {
        let provider = SystemPushAuthorizationProvider(), recorder = PushRecorder()
        provider.onToken = { recorder.tokens.append(($0, $1)) }
        provider.onFailure = { recorder.failures.append($0) }
        let first = UUID(), second = UUID()
        XCTAssertTrue(provider.register(generation: first))
        // UIKit 의 콜백에는 짝을 맞출 표가 없다: 앞 요청이 끝날 때까지 다음 요청은 줄을 선다.
        XCTAssertTrue(provider.register(generation: second))
        provider.didRegister(Data([1, 2]))
        XCTAssertEqual(recorder.tokens.map(\.1), [first])
        XCTAssertEqual(recorder.tokens.first?.0, Data([1, 2]))
        provider.didFail()
        XCTAssertEqual(recorder.failures, [second])
        // 기다리는 요청이 없으면 늦게 온 콜백은 버린다.
        provider.didRegister(Data([3]))
        XCTAssertEqual(recorder.tokens.count, 1)
    }

    // MARK: 연결

    func testIPhoneStartsWithoutTheMacOnlyLocalAddress() throws {
        // iPhone 의 127.0.0.1 은 iPhone 자신이다: 빈 칸에서 시작해 Tailscale 주소 자리를 보인다.
        let network = try IsolatedTestNetwork()
        let store = AppStore(session: network.session, persistCredentials: false)
        XCTAssertEqual(store.endpoint, "")
    }
}
#endif
