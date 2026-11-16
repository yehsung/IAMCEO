import Foundation
import SwiftUI
import XCTest
@testable import IAMCEO
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// 0.2.7 배포 전 확인(verify/live-copy.md)에서 나온 앱 화면 문제. 견본 글은 가짜다.
@MainActor final class PreReleaseCheckTests: XCTestCase {
    // MARK: 문제 4 — 자료 '이전 판' 줄을 판 번호로 가른다

    func testEveryVersionHasItsNumberAndPlainFilesHaveNone() {
        let v1 = FileDoc(id: "f1", title: "가짜 점검표", replacedBy: "f2")
        let v2 = FileDoc(id: "f2", title: "가짜 점검표", replaces: "f1", replacedBy: "f3")
        let v3 = FileDoc(id: "f3", title: "가짜 점검표", replaces: "f2", versions: 3)
        let other = FileDoc(id: "x", title: "다른 자료")
        let orphan = FileDoc(id: "o1", title: "새 판을 아직 못 받음", replacedBy: "o2")
        let files = [v3, other, v2, v1, orphan]
        XCTAssertEqual([v1, v2, v3].map { FileVersions.number(of: $0, in: files) }, [1, 2, 3])
        // 최신 판의 번호는 서버가 단 판 수와 같다.
        XCTAssertEqual(FileVersions.number(of: v3, in: files), v3.versions)
        XCTAssertNil(FileVersions.number(of: other, in: files), "판 갈이가 없는 자료")
        XCTAssertNil(FileVersions.number(of: orphan, in: files), "새 판을 모르면 판 번호도 모른다")
        // 이전 판 줄(가까운 것부터)의 번호: 판 수 − 1 부터 1 까지.
        let older = FileVersions.previous(of: v3, in: files)
        XCTAssertEqual(older.indices.map { older.count - $0 }, older.map { FileVersions.number(of: $0, in: files) })
    }

    // MARK: 문제 7 — 첨부가 있으면 메모칸이 '꼭 적어 주세요'가 아니다

    func testNeedsNoteFieldIsOptionalOnceAnAttachmentIsThere() throws {
        let decision = try JSONDecoder().decode(Decision.self, from: Data(#"""
        {"id":"d","status":"open","updatedAt":"v","options":[{"k":"go","label":"진행"},{"k":"memo","label":"고칠 곳을 메모에 적음","needsNote":true}]}
        """#.utf8))
        var review = DecisionReview(decision: decision)
        review.choice = "memo"
        XCTAssertTrue(review.noteRequired())
        XCTAssertFalse(review.noteRequired(hasAttachments: true), "첨부만으로 보낼 수 있으면 메모칸은 '메모 (선택)'")
        XCTAssertFalse(review.noteMissing(hasAttachments: true))
        review.choice = "go"
        XCTAssertFalse(review.noteRequired())
        // 메모를 적었어도 '메모 필요' 선택지의 메모칸은 '꼭 적어 주세요' 그대로다(비우면 다시 막힌다).
        review.choice = "memo"; review.note = "가짜 메모"
        XCTAssertTrue(review.noteRequired())
        XCTAssertFalse(review.noteMissing())
    }

    // MARK: 문제 8 — 홈 팀 줄: 서브에이전트만 일하는 팀장

    func testHomeTeamRowSaysSubagentsAndMarksTheOldNowLineAsLast() {
        let busy = Member(id: "m1", status: "idle", now: "가짜 판 8 값 넣는 중", subagentState: SubagentState(quality: "exact", count: 2))
        XCTAssertEqual(HomeView.activeRowDoing(busy, info: MemberStatusInfo(busy)), "서브에이전트 2개 · 마지막: 가짜 판 8 값 넣는 중")
        let guessed = Member(id: "m2", status: "idle", subagentState: SubagentState(quality: "estimated", count: 3))
        XCTAssertEqual(HomeView.activeRowDoing(guessed, info: MemberStatusInfo(guessed)), "서브에이전트 약 3개")
        // 그 밖의 줄은 전과 같다: 일하는 팀장은 '지금' 글, 글이 없으면 상태 글.
        let working = Member(id: "m3", status: "working", now: "가짜 시험 돌리는 중", subagentState: SubagentState(quality: "exact", count: 2))
        XCTAssertEqual(HomeView.activeRowDoing(working, info: MemberStatusInfo(working)), "가짜 시험 돌리는 중")
        let waiting = Member(id: "m4", status: "waiting")
        XCTAssertEqual(HomeView.activeRowDoing(waiting, info: MemberStatusInfo(waiting)), MemberStatusInfo("waiting").label)
    }

    #if os(macOS)
    // MARK: 문제 6 — 받는 이 목록: 상태 글에 밀린 역할 줄

    func testRecipientListWidensOnlyAsFarAsTheLongestRowNeeds() {
        func width(_ text: String) -> CGFloat {
            NSHostingView(rootView: ClampedWidthLayout(minWidth: 340, maxWidth: 520) {
                Text(text).font(.system(size: 12.5)).lineLimit(1).fixedSize()
            }).fittingSize.width
        }
        XCTAssertEqual(width("짧은 줄"), 340, "다 들어가는 목록은 웹과 같은 340")
        let wanted = NSHostingView(rootView: Text("@dev · 가짜 개발(안드로이드 포함) · 서브에이전트 일하는 중 · ✓✓✓✓✓").font(.system(size: 12.5)).lineLimit(1)).fittingSize.width
        XCTAssertGreaterThan(wanted, 340)
        XCTAssertEqual(width("@dev · 가짜 개발(안드로이드 포함) · 서브에이전트 일하는 중 · ✓✓✓✓✓"), min(wanted, 520), accuracy: 1)
        XCTAssertEqual(width(String(repeating: "아주 긴 역할 ", count: 30)), 520, "넘치면 520 에서 줄인다")
        // 스크롤되는 긴 목록도 같은 너비를 쓴다.
        let scrolled = NSHostingView(rootView: ClampedWidthLayout(minWidth: 340, maxWidth: 520) {
            ScrollView { VStack { ForEach(0..<20, id: \.self) { _ in Text("@dev · 가짜 개발(안드로이드 포함) · 서브에이전트 일하는 중 · ✓✓✓✓✓").font(.system(size: 12.5)).lineLimit(1) } } }
                .frame(height: 100)
        }).fittingSize
        XCTAssertEqual(scrolled.width, min(wanted, 520), accuracy: 1)
        XCTAssertEqual(scrolled.height, 100, accuracy: 1)
    }

    // MARK: 문제 2 — 넉넉하면 전과 같다

    func testComposerHintIsTheSameSingleLineWhenItFits() {
        let full = NSHostingView(rootView: ComposerPlaceholderText(project: "check", text: "총괄에게 지시나 질문").font(.system(size: 15))).fittingSize.width
        let alone = NSHostingView(rootView: Text("총괄에게 지시나 질문").font(.system(size: 15))).fittingSize.width
        XCTAssertGreaterThan(full, alone)
        // 넉넉하면 전과 같은 한 글('check · 총괄에게 지시나 질문')의 너비다.
        let before = NSHostingView(rootView: Text("check · 총괄에게 지시나 질문").font(.system(size: 15))).fittingSize.width
        XCTAssertEqual(full, before, accuracy: 1)
    }
    #endif

    // MARK: 문제 2 — 좁으면 받는 이를 다 보이고 프로젝트 이름을 줄인다 (Mac·iPhone)

    /// 실제 `ComposerPlaceholderText` 를 받는 이 글보다 조금 넓고 한 글 전체보다 좁은 칸에 그린다.
    /// 끝에서 잘리는 한 글로 되돌리거나 ViewThatFits 의 둘째 갈래를 지우면 받는 이 자리가 없거나 줄어 실패한다.
    func testComposerHintKeepsTheWholeRecipientWhenTheProjectNameMustGive() async throws {
        #if os(macOS)
        let font = Font.system(size: 15)
        #else
        let font = CEFont.body
        #endif
        let project = "가짜 결제 페이지 전면 개편 프로젝트", text = "총괄에게 지시나 질문"
        let alone = idealSize(Text(text).font(font)).width
        let projectAlone = idealSize(Text(project).font(font)).width
        let full = idealSize(Text(verbatim: "\(project) · \(text)").font(font)).width
        let width = (alone + 70).rounded()
        XCTAssertLessThan(width, full - 20, "한 글로는 다 들어가지 않는 칸이어야 시험이 뜻이 있다")
        let frames = try await probeFrames(
            ComposerPlaceholderText(project: project, text: text).font(font).frame(width: width, alignment: .leading),
            size: CGSize(width: width + 40, height: 120), waitFor: ["composer.hint.recipient", "composer.hint.project"])
        let recipient = try XCTUnwrap(frames["composer.hint.recipient"]), shownProject = try XCTUnwrap(frames["composer.hint.project"])
        XCTAssertEqual(recipient.width, alone, accuracy: 1, "받는 이 글은 끝까지 보인다")
        XCTAssertLessThanOrEqual(recipient.maxX, shownProject.minX + width + 1, "칸 안에 있다")
        XCTAssertGreaterThan(shownProject.width, 0)
        XCTAssertLessThan(shownProject.width, projectAlone - 20, "줄어드는 쪽은 프로젝트 이름이다")
    }

    // MARK: 문제 1·9 — 실제 할 일 닫기 창: 단추를 자르지 않고, iPhone 은 내용을 위에 붙인다

    /// 실제 `TodoCompletionEditor` 를 가장 좁은 너비(Mac 시트 380, iPhone 390)와 넉넉한 너비에 그려 단추 자리를 잰다.
    /// 단추 줄을 예전 HStack 으로 되돌리면 긴 단추가 넉넉할 때보다 좁아져(글이 잘려) 실패하고,
    /// iPhone 에서 내용을 위에 붙인 것을 되돌리면 제목이 창 가운데로 내려가 실패한다.
    func testRealTodoCloseEditorWrapsItsButtonsInsteadOfCutting() async throws {
        let store = AppStore(demo: true, persistCredentials: false)
        defer { store.prepareForReplacement() }
        store.serverTakesRevisions = true
        let todo = Todo(id: "t-fake", projectId: "p", who: "가짜 결제 연동과 정산 화면을 맡은 팀장", title: "가짜 영수증 확인")
        let review = TodoCompletionReview(todo: todo, store: store)
        review.outcome = .delegated
        let buttons = ["todo.attach", "todo.submit", "todo.cancel"]
        #if os(macOS)
        let narrow = CGSize(width: 380, height: 640)
        #else
        let narrow = CGSize(width: 390, height: 844)
        #endif
        func sheet() -> some View {
            // 시트처럼 창 크기를 받는 틀 안에 놓는다(내용이 그보다 작으면 가운데 — 고치기 전 iPhone 의 위 빈 공간).
            TodoCompletionEditor(review: review)
                .layoutProbe("editor")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .layoutProbe("sheet")
                .environment(store).environment(store.drafts)
        }
        let wide = try await probeFrames(sheet(), size: CGSize(width: 1000, height: narrow.height), waitFor: buttons + ["editor"])
        // 넉넉한 창에서는 창이 넓게 펴져 단추가 모두 제 너비로 한 줄에 선다(비교 기준).
        XCTAssertGreaterThan(try XCTUnwrap(wide["editor"]).width, 900)
        XCTAssertEqual(Set(buttons.compactMap { wide[$0].map { Int($0.midY.rounded()) } }).count, 1, "넉넉하면 한 줄")
        let tight = try await probeFrames(sheet(), size: narrow, waitFor: buttons + ["sheet", "todo.title"])
        let box = try XCTUnwrap(tight["sheet"])
        let wanted = buttons.compactMap { wide[$0]?.width }.reduce(0, +) + 8 * 2
        XCTAssertGreaterThan(wanted, box.width - 2 * CESpace.l, "한 줄에 다 들어가지 않는 단추 글이어야 시험이 뜻이 있다")
        for id in buttons {
            let shown = try XCTUnwrap(tight[id], id), full = try XCTUnwrap(wide[id], id)
            XCTAssertEqual(shown.width, full.width, accuracy: 1, "\(id): 좁아도 글을 자르지 않는다")
            XCTAssertGreaterThanOrEqual(shown.minX, box.minX + CESpace.l - 1, id)
            XCTAssertLessThanOrEqual(shown.maxX, box.maxX - CESpace.l + 1, "\(id): 창 밖으로 나가지 않는다")
        }
        let attach = try XCTUnwrap(tight["todo.attach"])
        XCTAssertGreaterThan(buttons.compactMap { tight[$0]?.minY }.max() ?? 0, attach.maxY, "넘치는 단추는 다음 줄로 간다")
        #if os(iOS)
        let title = try XCTUnwrap(tight["todo.title"])
        XCTAssertLessThanOrEqual(title.minY - box.minY, CESpace.l + 1, "iPhone 시트는 내용을 위에 붙인다(위가 비지 않는다)")
        #endif
    }

    // MARK: 도우미

    private final class Frames { var value: [String: CGRect] = [:] }

    private func idealSize<V: View>(_ view: V) -> CGSize {
        #if os(macOS)
        NSHostingView(rootView: view.fixedSize()).fittingSize
        #else
        UIHostingController(rootView: view.fixedSize()).sizeThatFits(in: CGSize(width: 10_000, height: 10_000))
        #endif
    }

    /// 화면을 실제 창에 띄워 `layoutProbe` 자리(창 좌표)를 모은다. `waitFor` 가 다 모이면 돌려준다.
    private func probeFrames<V: View>(_ view: V, size: CGSize, waitFor ids: [String],
                                      file: StaticString = #filePath, line: UInt = #line) async throws -> [String: CGRect] {
        let frames = Frames()
        let window = ProbeWindow(view.environment(\.layoutProbes, true)
            .onPreferenceChange(LayoutProbeFrames.self) { value in MainActor.assumeIsolated { frames.value = value } }, size: size)
        defer { window.close() }
        let seen = await pollUntil("자리 \(ids)", timeout: .seconds(8), file: file, line: line) {
            window.layout()
            return ids.allSatisfy { frames.value[$0].map { $0.width > 0 } ?? false }
        }
        guard seen else { throw TestDeadlineError.expired }
        // 한 번 더 배치해 마지막 자리를 받는다(글자 크기 계산이 늦게 끝나는 첫 배치를 피함).
        window.layout()
        try await Task.sleep(for: .milliseconds(50))
        window.layout()
        return frames.value
    }
}

/// 시험에서 SwiftUI 화면을 실제 창에 띄운다(ChatThreadScrollTests 의 HostWindow 와 같은 방식).
@MainActor
private final class ProbeWindow {
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
