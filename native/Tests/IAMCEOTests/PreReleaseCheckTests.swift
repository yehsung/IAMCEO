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

    // MARK: 0.2.7 화면 재확인(verify/live-copy-2.md) N1 — 자료 › 옛 판 안내: 단추 글·제목을 자르거나 꺾지 않는다

    #if os(macOS)
    /// Mac 의 가장 좁은 읽기 칸의 글 너비: 창 1040 − 사이드바 320 − 자료 책상(24×2 + 목록 300 + 12) = 360, 그 안 26×2.
    private let narrowNoticeWidth: CGFloat = 308
    #else
    /// iPhone 390: 판 14×2, 글 칸 16×2.
    private let narrowNoticeWidth: CGFloat = 330
    #endif
    private let noticeIDs = ["notice.title", "notice.detail", "notice.action"]

    private func olderVersionNotice(_ title: String, _ detail: String, _ action: String, wraps: Bool, width: CGFloat) -> some View {
        InlineNotice(tone: .attention, icon: "clock.arrow.circlepath", title: title, detail: detail,
                     actionTitle: action, action: {}, wrapsAction: wraps)
            .frame(width: width)
    }

    /// 영어 iPhone 390(·Mac 가장 좁은 칸)에서 'View newer version'이 'View newer…'로, 제목이 'Older version · / Version 1'로
    /// 꺾이던 것. 실제 `InlineNotice` 를 문구 표의 영어 글로 그려 잰다. `wrapsAction` 을 되돌리면 단추가 옆에 남아 실패한다.
    func testOlderVersionNoticePutsItsButtonUnderTheTextWhenTheEnglishDoesNotFit() async throws {
        let title = String(format: try english("옛 판입니다 · 판 %lld"), 1)
        let detail = String(format: try english("고친 판이 있습니다: %@"), "가짜 자료: 출시 점검표")
        let action = try english("새 판 보기")
        XCTAssertEqual(action, "View newer version")
        let wide = try await probeFrames(olderVersionNotice(title, detail, action, wraps: true, width: 900),
                                         size: CGSize(width: 940, height: 300), waitFor: noticeIDs)
        let fullTitle = try XCTUnwrap(wide["notice.title"]), fullAction = try XCTUnwrap(wide["notice.action"])
        XCTAssertGreaterThan(fullAction.minX, fullTitle.maxX, "넉넉하면 단추는 글 옆 그대로")
        // 고치기 전(늘 옆)에는 이 너비에서 단추가 잘리거나 제목이 꺾였다 — 시험이 뜻이 있다.
        let before = try await probeFrames(olderVersionNotice(title, detail, action, wraps: false, width: narrowNoticeWidth),
                                           size: CGSize(width: narrowNoticeWidth + 40, height: 400), waitFor: noticeIDs)
        let cut = try XCTUnwrap(before["notice.action"]).width < fullAction.width - 1
        let bent = try XCTUnwrap(before["notice.title"]).height > fullTitle.height + 1
        XCTAssertTrue(cut || bent, "고치기 전 모양이 이 너비에서 잘리지 않는다면 이 시험은 뜻이 없다")

        let frames = try await probeFrames(olderVersionNotice(title, detail, action, wraps: true, width: narrowNoticeWidth),
                                           size: CGSize(width: narrowNoticeWidth + 40, height: 400), waitFor: noticeIDs)
        let shownTitle = try XCTUnwrap(frames["notice.title"]), shownDetail = try XCTUnwrap(frames["notice.detail"])
        let shownAction = try XCTUnwrap(frames["notice.action"])
        XCTAssertEqual(shownAction.width, fullAction.width, accuracy: 1, "단추 글을 자르지 않는다")
        XCTAssertEqual(shownTitle.height, fullTitle.height, accuracy: 1, "제목은 한 줄")
        XCTAssertGreaterThanOrEqual(shownAction.minY, shownDetail.maxY, "단추는 설명 글 아래")
        XCTAssertEqual(shownAction.minX, shownTitle.minX, accuracy: 1, "글과 같은 왼쪽 선")
        XCTAssertLessThanOrEqual(max(shownTitle.maxX, shownDetail.maxX, shownAction.maxX), shownTitle.minX + narrowNoticeWidth, "안내 안")
    }

    /// 한국어(시험은 열쇠 = 한국어 글을 본다)는 iPhone 390·Mac 좁은 칸·넓은 칸 모두 단추가 옆 그대로이고, 자리가 고치기 전
    /// (`wrapsAction` 끔)과 같다.
    func testOlderVersionNoticeKeepsTheKoreanLayout() async throws {
        let title = "옛 판입니다 · 판 1", detail = "고친 판이 있습니다: 가짜 자료: 출시 점검표", action = "새 판 보기"
        for width in [narrowNoticeWidth, 700] {
            let size = CGSize(width: width + 40, height: 300)
            let before = try await probeFrames(olderVersionNotice(title, detail, action, wraps: false, width: width), size: size, waitFor: noticeIDs)
            let after = try await probeFrames(olderVersionNotice(title, detail, action, wraps: true, width: width), size: size, waitFor: noticeIDs)
            for id in noticeIDs {
                let old = try XCTUnwrap(before[id], id), new = try XCTUnwrap(after[id], id)
                XCTAssertEqual(new.minX, old.minX, accuracy: 0.5, "\(id) @\(width)"); XCTAssertEqual(new.minY, old.minY, accuracy: 0.5, "\(id) @\(width)")
                XCTAssertEqual(new.width, old.width, accuracy: 0.5, "\(id) @\(width)"); XCTAssertEqual(new.height, old.height, accuracy: 0.5, "\(id) @\(width)")
            }
            XCTAssertGreaterThan(try XCTUnwrap(after["notice.action"]).minX, try XCTUnwrap(after["notice.title"]).maxX, "@\(width): 단추는 옆")
        }
    }

    // MARK: N1 — 실제 자료 읽기 화면: 머리의 작성자, 옛 판 안내

    /// 실제 `FileReader` 를 가짜 서버의 판 두 개(옛 판을 연다)로 띄운다. 시험은 한국어 열쇠를 보므로, 한 줄에 다 들어가지 않게
    /// 작성자 이름을 조금 길게(영어 iPhone 의 'Document' + 'check 총괄' + '14 min ago' 와 같은 처지), 옛 판 안내는 한국어도
    /// 넘치는 좁은 너비(iPhone 화면 확대 320)로 잰다. 머리 줄을 예전 HStack 으로 되돌리면 작성자가 줄어 실패하고,
    /// 안내에서 `wrapsAction` 을 빼면 단추가 옆에 남아 실패한다.
    func testRealFileReaderKeepsTheWholeAuthorAndTheNewerVersionButton() async throws {
        let (store, network) = try await fileVersionsStore()
        defer { store.disconnect() }
        let old = try XCTUnwrap(store.files.first { $0.id == "f1" }, "가짜 서버의 옛 판")
        let router = Router()
        #if os(macOS)
        let reader = CGSize(width: 360, height: 700), tight = CGSize(width: 280, height: 700), base: CGFloat = 118
        #else
        let reader = CGSize(width: 390, height: 844), tight = CGSize(width: 320, height: 844), base: CGFloat = 112
        #endif
        func screen() -> some View {
            FileReader(file: old, framed: !isMac).environment(store).environment(router).environment(\.ceWide, isMac)
        }
        let meta = ["file.meta", "file.meta.kind", "file.meta.who", "file.meta.time", "file.actions"]
        let wide = try await probeFrames(screen(), size: CGSize(width: 1200, height: 700), waitFor: meta + noticeIDs)
        let shown = try await probeFrames(screen(), size: reader, waitFor: meta + noticeIDs)
        let kind = try XCTUnwrap(shown["file.meta.kind"]), who = try XCTUnwrap(shown["file.meta.who"])
        let time = try XCTUnwrap(shown["file.meta.time"]), line = try XCTUnwrap(shown["file.meta"]), actions = try XCTUnwrap(shown["file.actions"])
        // 한국어 단추(복사 · 공유/받기)는 기본 자리 안이라 머리 줄 너비가 전과 같다(단추 오른쪽 끝 − 기본 자리).
        XCTAssertLessThanOrEqual(actions.width + CESpace.s, base)
        XCTAssertEqual(line.maxX, actions.maxX - base, accuracy: 1)
        XCTAssertGreaterThan(kind.width + who.width + time.width + 16, line.width, "한 줄에 다 들어가지 않는 머리여야 시험이 뜻이 있다")
        XCTAssertEqual(who.width, try XCTUnwrap(wide["file.meta.who"]).width, accuracy: 1, "작성자를 줄이지 않는다")
        XCTAssertEqual(time.width, try XCTUnwrap(wide["file.meta.time"]).width, accuracy: 1, "시각도 줄이지 않는다")
        XCTAssertGreaterThan(time.minY, who.maxY - 1, "넘치는 시각은 다음 줄로")
        XCTAssertLessThanOrEqual(max(kind.maxX, who.maxX, time.maxX), actions.minX, "단추 밑으로 들어가지 않는다")
        XCTAssertLessThanOrEqual(line.maxX, actions.minX - CESpace.s + 0.5, "머리 줄은 단추 앞 8 에서 끝난다")
        // 넉넉하면 한 줄이다.
        let wideKind = try XCTUnwrap(wide["file.meta.kind"]), wideTime = try XCTUnwrap(wide["file.meta.time"])
        XCTAssertEqual(wideKind.midY, wideTime.midY, accuracy: 1, "넉넉하면 한 줄")

        // 옛 판 안내: 한국어가 들어가는 너비는 단추가 옆(전과 같음), 넘치는 너비는 글 아래로 내려 단추 글을 자르지 않는다.
        let fullAction = try XCTUnwrap(wide["notice.action"])
        XCTAssertGreaterThan(try XCTUnwrap(shown["notice.action"]).minX, try XCTUnwrap(shown["notice.title"]).maxX, "한국어 390·Mac 좁은 칸: 옆 그대로")
        let narrow = try await probeFrames(screen(), size: tight, waitFor: noticeIDs)
        let action = try XCTUnwrap(narrow["notice.action"]), detail = try XCTUnwrap(narrow["notice.detail"])
        XCTAssertEqual(action.width, fullAction.width, accuracy: 1, "단추 글을 자르지 않는다")
        XCTAssertGreaterThanOrEqual(action.minY, detail.maxY, "넘치면 단추는 설명 글 아래")
        XCTAssertEqual(try XCTUnwrap(narrow["notice.title"]).height, try XCTUnwrap(wide["notice.title"]).height, accuracy: 1, "제목은 한 줄")
        await network.close()
    }

    #if os(iOS)
    /// 복사 · 공유 단추가 기본 자리(112)보다 넓으면(영어 'Copy' · 'Share', 한국어도 큰 글자) 그 너비 + 8 을 비워 머리 줄이
    /// 단추 밑으로 들어가지 않는다. 시험은 한국어 열쇠라 큰 글자로 넓힌다. 기본 자리 112 로 되돌리면 실패한다.
    func testRealFileReaderLeavesRoomForCopyShareButtonsWiderThanTheDefault() async throws {
        let (store, network) = try await fileVersionsStore()
        defer { store.disconnect() }
        let old = try XCTUnwrap(store.files.first { $0.id == "f1" }, "가짜 서버의 옛 판")
        let screen = FileReader(file: old, framed: true).environment(store).environment(Router()).environment(\.ceWide, false)
            .environment(\.dynamicTypeSize, .xxxLarge)
        let ids = ["file.meta", "file.meta.kind", "file.meta.who", "file.meta.time", "file.actions"]
        let frames = try await probeFrames(screen, size: CGSize(width: 390, height: 844), waitFor: ids)
        let line = try XCTUnwrap(frames["file.meta"]), actions = try XCTUnwrap(frames["file.actions"])
        XCTAssertGreaterThan(actions.width + CESpace.s, 112, "기본 자리보다 넓은 단추여야 시험이 뜻이 있다")
        XCTAssertLessThanOrEqual(line.maxX, actions.minX - CESpace.s + 0.5, "머리 줄은 단추 앞 8 에서 끝난다")
        for id in ["file.meta.kind", "file.meta.who", "file.meta.time"] {
            XCTAssertLessThanOrEqual(try XCTUnwrap(frames[id], id).maxX, actions.minX, "\(id): 단추 밑으로 들어가지 않는다")
        }
        await network.close()
    }
    #endif

    // MARK: 화면 확인 뒤 대응(verify/live-copy-3.md) 7 — 페이지 '크게 보기' 자리, N8 — 두 줄 머리일 때 제목 자리

    #if os(macOS)
    private let readerSize = CGSize(width: 360, height: 700)
    #else
    private let readerSize = CGSize(width: 390, height: 844)
    #endif
    private let headerIDs = ["file.meta", "file.meta.kind", "file.meta.who", "file.meta.time", "file.actions", "file.title"]

    private func reader(_ file: FileDoc, _ store: AppStore) -> some View {
        FileReader(file: file, framed: !isMac).environment(store).environment(Router()).environment(\.ceWide, isMac)
    }

    /// 실제 페이지(가짜 서버의 a1)를 열어 '크게 보기'가 나온 머리를 잰다. 한국어 '크게 보기'는 기본 자리(106) 안이라 머리 줄 끝이
    /// 전과 같은 자리(단추 오른쪽 끝 − 페이지 좌우 6 − 106)이고, 머리 줄이 한 줄이면 제목도 같은 자리를 비운다(N8 의 '한 줄은 그대로').
    func testRealPageHeaderKeepsTheKoreanEnlargeRoom() async throws {
        let (store, network) = try await fileVersionsStore()
        defer { store.disconnect() }
        let page = try XCTUnwrap(store.files.first { $0.id == "a1" }, "가짜 서버의 페이지")
        let frames = try await probeFrames(reader(page, store), size: readerSize, waitFor: headerIDs)
        let line = try XCTUnwrap(frames["file.meta"]), button = try XCTUnwrap(frames["file.actions"]), title = try XCTUnwrap(frames["file.title"])
        XCTAssertLessThanOrEqual(button.width + CESpace.s - 6, 106, "한국어 '크게 보기'는 기본 자리 안")
        XCTAssertEqual(fileHeaderReserve(base: 106, actionsWidth: button.width, sidePadding: 6), 106)
        XCTAssertEqual(line.maxX, button.maxX - 6 - 106, accuracy: 0.5, "머리 줄 끝이 전과 같은 자리")
        XCTAssertEqual(try XCTUnwrap(frames["file.meta.kind"]).midY, try XCTUnwrap(frames["file.meta.time"]).midY, accuracy: 1, "한 줄 머리")
        for id in ["file.meta.kind", "file.meta.who", "file.meta.time"] {
            XCTAssertLessThanOrEqual(try XCTUnwrap(frames[id], id).maxX, button.minX - CESpace.s + 0.5, "\(id): 단추 앞에서 끝난다")
        }
        XCTAssertGreaterThan(title.height, 30, "긴 제목이어야 시험이 뜻이 있다(여러 줄)")
        XCTAssertLessThanOrEqual(title.maxX, line.maxX + 0.5, "한 줄 머리면 제목도 단추 자리를 비운다(전과 같음)")
        XCTAssertGreaterThan(title.maxX, line.maxX - 40, "긴 제목은 그 자리까지 찬다")
        await network.close()
    }

    /// 영어 'View larger'(약 119~125pt)는 기본 자리 106 + 좌우 6 보다 넓어, 고치기 전에는 머리 줄 끝(시각)이 단추 밑으로 들어갔다
    /// (영어 Mac 좁은 칸 '33 min ago', iPhone '26 min ago'). 실제 단추 모양·문구 표의 영어 글로 너비를 재어, 머리 자리 규칙이
    /// 머리 줄을 단추 앞 8 에서 끝나게 하는지 본다. 같은 규칙을 실제 화면이 쓰는 것은 아래 큰 글자 시험(iPhone)과 한국어 시험이 지킨다.
    func testEnglishViewLargerButtonGetsRoomBeforeIt() throws {
        let label = try english("크게 보기")
        XCTAssertEqual(label, "View larger")
        let width = idealSize(Button {} label: { Label(label, systemImage: "arrow.up.left.and.arrow.down.right") }
            .buttonStyle(ViewerButtonStyle())).width
        XCTAssertLessThan(106 + 6 - width, CESpace.s, "고치기 전(106 고정)에는 단추 앞 8 이 남지 않았다 — 시험이 뜻이 있다")
        let room = fileHeaderReserve(base: 106, actionsWidth: width, sidePadding: 6)
        XCTAssertEqual(room + 6 - width, CESpace.s, accuracy: 0.5, "머리 줄은 단추 앞 8 에서 끝난다")
        XCTAssertEqual(fileHeaderReserve(base: 106, actionsWidth: 0, sidePadding: 6), 106, "아직 못 쟀으면 기본 자리")
    }

    #if os(iOS)
    /// 실제 페이지 머리: '크게 보기'가 기본 자리보다 넓으면(영어, 한국어도 큰 글자) 머리 줄이 단추 앞 8 에서 끝난다.
    /// 시험은 한국어 열쇠라 큰 글자로 넓힌다. 페이지 자리를 106 고정으로 되돌리면 실패한다.
    func testRealPageHeaderLeavesRoomForAnEnlargeButtonWiderThanTheDefault() async throws {
        let (store, network) = try await fileVersionsStore()
        defer { store.disconnect() }
        let page = try XCTUnwrap(store.files.first { $0.id == "a1" }, "가짜 서버의 페이지")
        let frames = try await probeFrames(reader(page, store).environment(\.dynamicTypeSize, .xxxLarge), size: readerSize, waitFor: headerIDs)
        let line = try XCTUnwrap(frames["file.meta"]), button = try XCTUnwrap(frames["file.actions"])
        XCTAssertGreaterThan(button.width + CESpace.s - 6, 106, "기본 자리보다 넓은 단추여야 시험이 뜻이 있다")
        XCTAssertEqual(line.maxX, button.minX - CESpace.s, accuracy: 0.5, "머리 줄은 단추 앞 8 에서 끝난다")
        for id in ["file.meta.kind", "file.meta.who", "file.meta.time"] {
            XCTAssertLessThanOrEqual(try XCTUnwrap(frames[id], id).maxX, button.minX, "\(id): 단추 밑으로 들어가지 않는다")
        }
        await network.close()
    }
    #endif

    /// N8: 머리 줄이 두 줄로 넘어가면 제목은 단추보다 아래에서 시작하므로 단추 자리를 비우지 않는다(긴 제목이 좁은 칸에 갇혀
    /// 1→2줄, 5→7줄이 되던 것). 같은 자료도 넉넉해 한 줄 머리면 전처럼 비운다. 제목 자리를 늘 비우게 되돌리면 실패한다.
    func testRealFileHeaderGivesTheTitleTheWholeWidthOnlyWhenTheMetaWraps() async throws {
        let (store, network) = try await fileVersionsStore()
        defer { store.disconnect() }
        let doc = try XCTUnwrap(store.files.first { $0.id == "d1" }, "가짜 서버의 긴 제목 문서")
        let frames = try await probeFrames(reader(doc, store), size: readerSize, waitFor: headerIDs)
        let line = try XCTUnwrap(frames["file.meta"]), actions = try XCTUnwrap(frames["file.actions"]), title = try XCTUnwrap(frames["file.title"])
        let who = try XCTUnwrap(frames["file.meta.who"]), time = try XCTUnwrap(frames["file.meta.time"])
        XCTAssertGreaterThan(time.minY, who.maxY - 1, "두 줄 머리여야 시험이 뜻이 있다")
        XCTAssertGreaterThan(title.maxX, line.maxX + 1, "두 줄 머리면 제목은 단추 자리까지 쓴다(자리를 비우면 머리 줄 끝을 넘지 못한다)")
        XCTAssertLessThanOrEqual(title.maxX, actions.maxX + 0.5, "글 칸 안")
        XCTAssertGreaterThanOrEqual(title.minY, actions.maxY, "제목은 단추보다 아래에서 시작한다(겹치지 않음)")

        let wide = try await probeFrames(reader(doc, store), size: CGSize(width: 1200, height: 700), waitFor: headerIDs)
        let wideLine = try XCTUnwrap(wide["file.meta"]), wideTitle = try XCTUnwrap(wide["file.title"])
        XCTAssertEqual(try XCTUnwrap(wide["file.meta.kind"]).midY, try XCTUnwrap(wide["file.meta.time"]).midY, accuracy: 1, "넉넉하면 한 줄 머리")
        XCTAssertLessThanOrEqual(wideTitle.maxX, wideLine.maxX + 0.5, "한 줄 머리면 제목도 단추 자리를 비운다(전과 같음)")
        await network.close()
    }

    /// 가짜 판 서버에 붙은 상점.
    private func fileVersionsStore() async throws -> (AppStore, IsolatedTestNetwork) {
        let server = FileVersionsServer(author: "가짜 결제 연동 담당 팀장"), network = try IsolatedTestNetwork(handler: server.handle)
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture-only"
        await store.connect()
        return (store, network)
    }

    // MARK: 0.2.7 화면 재확인 N5 — 사무실 말풍선: '서브에이전트'를 두 번 쓰지 않는다

    /// 실제 `OfficeMessageBox` 를 그려, 서브에이전트만 일하는 팀장은 상태 글 없이 '이름 · 서브에이전트 2개 · 마지막: …'
    /// (Mac 한 줄, 점 양옆 6), iPhone 은 이름 줄 아래 같은 글인지 잰다. 다른 팀장은 상태 글이 그대로다.
    func testOfficeBubbleDropsTheRepeatedStateForSubagentOnlyLeads() async throws {
        let busy = Member(id: "m", name: "가짜 개발", status: "idle", now: "가짜 판 8 값 넣는 중", subagentState: SubagentState(quality: "exact", count: 2))
        let working = Member(id: "w", name: "가짜 서버", status: "working", now: "가짜 시험 돌리는 중")
        #if os(macOS)
        let size = CGSize(width: 760, height: 120)
        #else
        let size = CGSize(width: 390, height: 160)
        #endif
        func bubble(_ member: Member) -> some View {
            OfficeMessageBox(subject: member, queue: [], decisions: [:], compactAt: 90, still: true, open: { _ in })
        }
        let other = try await probeFrames(bubble(working), size: size, waitFor: ["office.bubble.name", "office.bubble.state", "office.bubble.detail"])
        XCTAssertNotNil(other["office.bubble.state"], "다른 팀장은 상태 글 그대로")
        let frames = try await probeFrames(bubble(busy), size: size, waitFor: ["office.bubble.name", "office.bubble.detail"])
        XCTAssertNil(frames["office.bubble.state"], "'서브에이전트 일하는 중'을 따로 쓰지 않는다")
        let name = try XCTUnwrap(frames["office.bubble.name"]), detail = try XCTUnwrap(frames["office.bubble.detail"])
        #if os(macOS)
        let dot = idealSize(Text("·").font(.system(size: 13))).width
        XCTAssertEqual(detail.minX - name.maxX, 6 + dot + 6, accuracy: 1, "이름 · 서브에이전트 2개 — 점 양옆 6")
        XCTAssertEqual(detail.midY, name.midY, accuracy: 3, "Mac 은 한 줄")
        #else
        XCTAssertGreaterThan(detail.minY, name.maxY - 1, "iPhone 은 이름 줄 아래")
        XCTAssertEqual(detail.minX, name.minX, accuracy: 1)
        #endif
    }

    // MARK: 도우미

    /// 문구 표의 영어 값. 시험에는 언어 표가 없어 한국어 열쇠를 보므로, 영어 화면은 표를 직접 읽어 같은 글로 그린다.
    private func english(_ key: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("Resources/Shared/Localizable.xcstrings")))
        let strings = try XCTUnwrap((object as? [String: Any])?["strings"] as? [String: [String: Any]])
        let localizations = try XCTUnwrap(strings[key]?["localizations"] as? [String: Any], key)
        let unit = try XCTUnwrap((localizations["en"] as? [String: Any])?["stringUnit"] as? [String: Any], key)
        return try XCTUnwrap(unit["value"] as? String, key)
    }

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

/// 판 두 개(옛 판 f1 → 새 판 f2)를 가진 문서, 제목이 긴 문서 d1, 제목이 긴 페이지 a1 을 주는 가짜 서버(NetAppServer 와 같은
/// 방식). 글은 가짜다.
private final class FileVersionsServer: @unchecked Sendable {
    private let state: ProjectState
    private let bootstrap = Bootstrap(projects: [ProjectSummary(id: "p")])
    static let longTitle = "가짜 자료: 출시 전 마지막 점검표와 스토어 설명 문구, 심사 메모를 한곳에 모은 정리"
    init(author: String) {
        let member = Member(id: "m", name: author, status: "idle")
        let old = FileDoc(id: "f1", kind: "document", projectId: "p", title: "가짜 자료: 출시 점검표", who: author, memberId: "m",
                          body: "# 출시 점검표\n\n판 1(시험용 가짜 글)", createdAt: "2026-11-14T09:00:00.000Z", replacedBy: "f2")
        let new = FileDoc(id: "f2", kind: "document", projectId: "p", title: "가짜 자료: 출시 점검표", who: author, memberId: "m",
                          body: "# 출시 점검표\n\n판 2(시험용 가짜 글)", createdAt: "2026-11-14T09:05:00.000Z", replaces: "f1", versions: 2)
        let long = FileDoc(id: "d1", kind: "document", projectId: "p", title: Self.longTitle, who: author, memberId: "m",
                           body: "시험용 가짜 글", createdAt: "2026-11-14T09:10:00.000Z")
        let page = FileDoc(id: "a1", kind: "artifact", projectId: "p", title: Self.longTitle, who: "총괄",
                           createdAt: "2026-11-14T09:15:00.000Z")
        state = ProjectState(project: Project(id: "p", connection: ProjectConnection(ok: true)), members: [member], files: [new, old, long, page])
    }
    func handle(_ request: URLRequest) throws -> IsolatedTestHTTPReply {
        func reply<T: Encodable>(_ value: T) throws -> IsolatedTestHTTPReply { IsolatedTestHTTPReply(data: try JSONEncoder().encode(value)) }
        switch request.url?.path {
        case "/api/bootstrap": return try reply(bootstrap)
        case "/api/capabilities": return IsolatedTestHTTPReply(status: 404)
        case "/api/projects/p/state": return try reply(state)
        case "/api/sync":
            let id = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "projectId" }?.value
            return try reply(SyncSnapshot(protocolVersion: 2, cursor: SyncCursor(epoch: "file-versions", seq: 1),
                requestedProjectId: id, projectStatus: id == nil ? .none : .ok, bootstrap: bootstrap,
                state: id == nil ? nil : state, revisions: nil, apiOutage: nil))
        case "/api/files/a1/artifact":
            return IsolatedTestHTTPReply(data: Data("<p>가짜 페이지</p>".utf8),
                                         headers: ["Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "sandbox allow-scripts; default-src 'none'"])
        case let path? where path.hasPrefix("/api/files/"):
            let id = String(path.dropFirst("/api/files/".count))
            guard let file = state.files.first(where: { $0.id == id }) else { return IsolatedTestHTTPReply(status: 404) }
            return try reply(file)
        default: return IsolatedTestHTTPReply(status: 404)
        }
    }
}
