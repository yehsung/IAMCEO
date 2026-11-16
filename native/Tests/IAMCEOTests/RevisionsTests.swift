import Foundation
import XCTest
@testable import IAMCEO

/// 0.2.7 묶음 4: 결재·할 일·자료 고치기와 결재 답 첨부(점검 D3-4·D3-5·D3-7·D1-5·D3-9·D5-7·D5-10). 견본 글은 가짜다.
final class RevisionsTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }
    private func object(_ value: some Encodable) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
    }

    // MARK: 새 칸을 읽고, 없으면 예전처럼

    func testDecisionReadsReplacementsNeedsNoteAndAnswerAttachments() throws {
        let decision = try decode(Decision.self, """
        {"id":"d_new","status":"open","options":[{"k":"a","label":"가"},{"k":"memo","label":"메모에 적음","needsNote":true}],
         "replaces":"d_old","answerAttachments":[{"id":"a_1","name":"캡처.png","mime":"image/png","size":3,"url":"/u/a_1","path":"/p","isImage":true}]}
        """)
        XCTAssertEqual(decision.replaces, "d_old")
        XCTAssertNil(decision.replacedBy)
        XCTAssertEqual(decision.options.map(\.needsNote), [false, true])
        XCTAssertEqual(decision.answerAttachments.map(\.id), ["a_1"])
        XCTAssertEqual(decision.lastAnswerAttachments, [])
        // 다시 열린 카드의 직전 답 첨부.
        let reopened = try decode(Decision.self, """
        {"id":"d_r","status":"open","options":[],"lastNote":"가짜","lastAnswerAttachments":[{"id":"a_2","name":"표시.png","mime":"image/png","size":3,"url":"/u/a_2","path":"/p","isImage":true}]}
        """)
        XCTAssertEqual(reopened.lastAnswerAttachments.map(\.id), ["a_2"])
        // 옛 서버(칸 없음)와 엉뚱한 값은 예전처럼 읽는다.
        let old = try decode(Decision.self, #"{"id":"d","options":[{"k":"a","label":"가","needsNote":"yes"}],"replacedBy":7,"lastAnswerAttachments":"x"}"#)
        XCTAssertEqual(old.options.first?.needsNote, false)
        XCTAssertNil(old.replacedBy)
        XCTAssertEqual(old.answerAttachments, [])
        XCTAssertEqual(old.lastAnswerAttachments, [])
    }

    func testFileReadsVersionsAndOldServersStayTheSame() throws {
        let file = try decode(FileDoc.self, #"{"id":"f_3","kind":"document","replaces":"f_2","versions":3}"#)
        XCTAssertEqual(file.replaces, "f_2")
        XCTAssertEqual(file.versions, 3)
        let old = try decode(FileDoc.self, #"{"id":"f_1","kind":"document"}"#)
        XCTAssertNil(old.replaces); XCTAssertNil(old.replacedBy); XCTAssertNil(old.versions)
    }

    func testRequestsLeaveNewFieldsOutUnlessUsed() throws {
        let plain = try object(AnswerRequest(choice: "a", note: nil, batch: false, expectedVersion: "v"))
        XCTAssertNil(plain["fileIds"])
        let attached = try object(AnswerRequest(choice: "a", note: nil, batch: false, expectedVersion: "v", fileIds: ["a_1"]))
        XCTAssertEqual(attached["fileIds"] as? [String], ["a_1"])
        XCTAssertNil(try object(TodoCompletionRequest(done: true))["outcome"])
        XCTAssertEqual(try object(TodoCompletionRequest(done: true, outcome: "delegated"))["outcome"] as? String, "delegated")
        XCTAssertNil(TodoCloseOutcome.done.wire)
        XCTAssertEqual(TodoCloseOutcome.allCases.compactMap(\.wire), ["dropped", "delegated"])
    }

    func testCapabilityTellsWhetherTheServerTakesRevisions() throws {
        let now = try decode(ServerCapabilities.self, #"{"contractVersion":2,"capabilities":{"operations":true,"revisions":true}}"#)
        XCTAssertEqual(now.capabilities?.revisions, true)
        let old = try decode(ServerCapabilities.self, #"{"contractVersion":2,"capabilities":{"operations":true}}"#)
        XCTAssertNil(old.capabilities?.revisions)
    }

    // MARK: D3-7 메모가 있어야 하는 선택지

    func testNeedsNoteOptionCannotBeSentWithoutANote() throws {
        let decision = try decode(Decision.self, #"{"id":"d","status":"open","updatedAt":"v","options":[{"k":"go","label":"진행"},{"k":"memo","label":"메모에 적음","needsNote":true}]}"#)
        var review = DecisionReview(decision: decision)
        review.choice = "go"
        XCTAssertTrue(review.canSubmit(comparedTo: decision))
        XCTAssertFalse(review.noteMissing())
        review.choice = "memo"
        XCTAssertTrue(review.noteMissing())
        XCTAssertFalse(review.canSubmit(comparedTo: decision))
        // 메모 대신 첨부를 붙이면 보낼 수 있다(서버도 첨부를 메모처럼 친다).
        XCTAssertFalse(review.noteMissing(hasAttachments: true))
        XCTAssertTrue(review.canSubmit(comparedTo: decision, hasAttachments: true))
        review.note = "  \n "
        XCTAssertFalse(review.canSubmit(comparedTo: decision))
        review.note = "1. 제목 2. 여백"
        XCTAssertFalse(review.noteMissing())
        XCTAssertTrue(review.canSubmit(comparedTo: decision))
    }

    // MARK: D3-5 대체된 카드에서 올리던 첨부

    @MainActor func testUploadsOfAReplacedCardLandOnTheNewCard() throws {
        let drafts = DraftStore(persist: false)
        let old = DecisionAnswerDraft.key("d_old"), new = DecisionAnswerDraft.key("d_new")
        let token = drafts.uploadToken(for: old)
        drafts.failUpload(name: "큰 영상.mov", token: token, detail: "끊김")
        XCTAssertEqual(drafts.uploadDestination(token), old)
        drafts.forwardUploads(from: old, to: new)
        // 옛 카드에서 실패한 것은 새 카드에 보이고, 올리던 것이 끝나면 새 카드에 들어간다(옛 열쇠의 세대는 그대로다).
        XCTAssertEqual(drafts.uploadFailures(for: new).map(\.name), ["큰 영상.mov"])
        XCTAssertTrue(drafts.uploadFailures(for: old).isEmpty)
        XCTAssertEqual(drafts.uploadDestination(token), new)
        XCTAssertTrue(drafts.isCurrentUpload(token))
        let file = try decode(Attachment.self, #"{"id":"a_9","name":"큰 영상.mov","mime":"video/quicktime","size":3,"url":"/u/a_9","path":"/p","isImage":false}"#)
        XCTAssertTrue(drafts.completeUpload(file, token: token))
        XCTAssertEqual(drafts.files(for: new).map(\.id), ["a_9"])
        XCTAssertEqual(drafts.files(for: old), [])
        // 다른 열쇠(대화 초안)는 그대로다.
        let chat = drafts.uploadToken(for: DraftStore.key(project: "p", target: nil))
        XCTAssertEqual(drafts.uploadDestination(chat), DraftStore.key(project: "p", target: nil))
    }

    // MARK: D5-7 자료 판

    func testFileVersionsListOnlyTheNewestAndWalkBothWays() {
        let v1 = FileDoc(id: "f1", title: "안내", replacedBy: "f2")
        let v2 = FileDoc(id: "f2", title: "안내 2", replaces: "f1", replacedBy: "f3")
        let v3 = FileDoc(id: "f3", title: "안내 3", replaces: "f2", versions: 3)
        let other = FileDoc(id: "x", title: "다른 자료")
        // 새 판을 아직 받지 못한 옛 판은 남긴다.
        let orphan = FileDoc(id: "o1", title: "새 판이 아직 없음", replacedBy: "o2")
        let files = [v3, other, v2, v1, orphan]
        XCTAssertEqual(FileVersions.listed(files).map(\.id), ["f3", "x", "o1"])
        XCTAssertEqual(FileVersions.newest(of: v1, in: files).id, "f3")
        XCTAssertEqual(FileVersions.newest(of: v3, in: files).id, "f3")
        XCTAssertEqual(FileVersions.previous(of: v3, in: files).map(\.id), ["f2", "f1"])
        XCTAssertEqual(FileVersions.previous(of: other, in: files), [])
        // 고리로 이어진 잘못된 자료에서도 끝난다.
        let loopA = FileDoc(id: "a", replaces: "b", replacedBy: "b"), loopB = FileDoc(id: "b", replaces: "a", replacedBy: "a")
        XCTAssertEqual(FileVersions.newest(of: loopA, in: [loopA, loopB]).id, "b")
        XCTAssertEqual(FileVersions.previous(of: loopA, in: [loopA, loopB]).map(\.id), ["b"])
    }

    // MARK: D5-10 대표 글

    func testOwnerTextDropsControlCharactersButKeepsLinesTabsAndEmoji() {
        XCTAssertEqual(OwnerText.clean("가\u{8}나\u{0}다\r\n라\t마\u{85}바\u{1B}"), "가나다\n라\t마바")
        XCTAssertEqual(OwnerText.clean("줄1\r줄2\r\n줄3\n"), "줄1\n줄2\n줄3\n")
        XCTAssertEqual(OwnerText.clean("👨‍👩‍👧 함께"), "👨‍👩‍👧 함께")
    }

    func testReturnAtTheEndOfTheFirstNumberedItemContinuesTheList() {
        let rule = ComposerReturnRule.self
        let text = "할 것\n1. 첫 항목 손보기"
        XCTAssertEqual(rule.listContinuation(text: text, caret: (text as NSString).length), "\n2. ")
        XCTAssertEqual(rule.listContinuation(text: "  1) 첫째", caret: ("  1) 첫째" as NSString).length), "\n  2) ")
        // 두 번째 항목부터·빈 항목·줄 가운데·목록이 아닌 줄은 평소대로 보낸다.
        XCTAssertNil(rule.listContinuation(text: "1. 첫째\n2. 둘째", caret: ("1. 첫째\n2. 둘째" as NSString).length))
        XCTAssertNil(rule.listContinuation(text: "1. ", caret: 3))
        XCTAssertNil(rule.listContinuation(text: "1. 첫째", caret: 3))
        XCTAssertNil(rule.listContinuation(text: "11/ 일정", caret: ("11/ 일정" as NSString).length))
        XCTAssertNil(rule.listContinuation(text: "10. 열째", caret: ("10. 열째" as NSString).length))
        XCTAssertNil(rule.listContinuation(text: "그냥 글", caret: ("그냥 글" as NSString).length))
        // 캐럿 뒤가 줄바꿈이면 그 줄의 끝이다.
        XCTAssertEqual(rule.listContinuation(text: "1. 첫째\n다음", caret: ("1. 첫째" as NSString).length), "\n2. ")
    }

    @MainActor func testDecisionAnswerDraftKeyNeverCollidesWithChatDrafts() {
        let key = DecisionAnswerDraft.key("d_1")
        XCTAssertNotEqual(key, DraftStore.key(project: "d_1", target: nil))
        XCTAssertNotEqual(key, DraftStore.key(project: nil, target: "d_1"))
        XCTAssertFalse(key.hasPrefix("-") || key.first?.isNumber == true)
    }
}
