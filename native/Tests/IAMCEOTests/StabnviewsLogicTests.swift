import Foundation
import XCTest
@testable import IAMCEO

/// 화면 쪽 안정성 수정의 순수 로직 시험(날짜 캐시, 결재함 방문 정리, 승인 창 읽기 합치기, 표 숫자·정렬, 긴 텍스트 한도).
@MainActor final class StabnviewsLogicTests: XCTestCase {
    // MARK: 날짜 캐시

    func testDateCacheParsesEachStringOnceAndKeepsTheUncachedResults() {
        let cache = ISODateCache(limit: 8)
        let fractional = "2026-11-10T01:02:03.456Z", plain = "2026-11-10T01:02:03Z", offset = "2026-11-10T10:02:03+09:00"
        let reference = ISO8601DateFormatter()
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        for _ in 0..<50 {
            XCTAssertEqual(cache.date(fractional), withFraction.date(from: fractional))
            XCTAssertEqual(cache.date(plain), reference.date(from: plain))
            XCTAssertEqual(cache.date(offset), reference.date(from: offset))
            XCTAssertNil(cache.date("어제"))
        }
        // 실패한 값도 한 번만 파싱한다.
        XCTAssertEqual(cache.parses, 4)
        XCTAssertNotNil(cache.date(fractional))
        XCTAssertEqual(cache.date(plain), cache.date(offset))
    }

    func testDateCacheStaysBoundedAndStillAnswersAfterItIsEmptied() {
        let cache = ISODateCache(limit: 4)
        let values = (0..<20).map { String(format: "2026-11-10T01:02:%02dZ", $0) }
        let reference = ISO8601DateFormatter()
        for value in values { XCTAssertEqual(cache.date(value), reference.date(from: value)) }
        for value in values.reversed() { XCTAssertEqual(cache.date(value), reference.date(from: value)) }
    }

    func testSharedHelpersMatchFreshFormatters() throws {
        let value = "2026-03-02T05:06:07.890Z"
        let date = try XCTUnwrap(parseISODate(value))
        XCTAssertEqual(parseISODate(value), date)
        XCTAssertNil(parseISODate(nil)); XCTAssertNil(parseISODate("")); XCTAssertNil(parseISODate("not a date"))
        for format in ["HH:mm", "HH:mm:ss", "M월 d일", "yyyy년 M월 d일", "yyyy년 M월 d일 HH:mm"] {
            let fresh = DateFormatter()
            fresh.locale = Locale(identifier: "ko_KR")
            fresh.dateFormat = format
            XCTAssertEqual(koFormatted(date, format), fresh.string(from: date), format)
            XCTAssertEqual(koFormatted(date, format), fresh.string(from: date), format)
        }
        XCTAssertEqual(clockTime(value), koTime(date))
        XCTAssertEqual(koDateTime(date), koFormatted(date, "yyyy년 M월 d일 HH:mm"))
    }

    func testPulseStopsOnHiddenTabsAndUnderReduceMotion() {
        XCTAssertTrue(StatusDot.pulses(pulsing: true, reduceMotion: false, tabVisible: true))
        XCTAssertFalse(StatusDot.pulses(pulsing: true, reduceMotion: false, tabVisible: false))
        XCTAssertFalse(StatusDot.pulses(pulsing: true, reduceMotion: true, tabVisible: true))
        XCTAssertFalse(StatusDot.pulses(pulsing: false, reduceMotion: false, tabVisible: true))
    }

    // MARK: 결재함 방문 정리

    func testEndingAVisitClearsAnsweredAndElsewhereSettledCardsButKeepsOpenWork() {
        let state = InboxReviewState()
        state.engaged = ["open", "answered", "closedElsewhere", "vanished", "sending"]
        state.answeredHere = ["answered"]
        state.inFlight = ["sending"]
        state.memoOnly = ["open", "closedElsewhere"]
        state.cardErrors = ["closedElsewhere": "이미 처리된 결재입니다", "open": "보내지 않았습니다"]
        state.batchArmed = ["g": ["open"]]
        state.expandedDetail = ["open"]
        var review = DecisionReview(decision: Decision(id: "open", options: [DecisionOption(k: "a", label: "진행")], updatedAt: "v1"))
        review.choice = "a"; review.note = "조건"
        state.reviews["open"] = review
        let decisions = [Decision(id: "open"), Decision(id: "answered", status: "answered"),
                         Decision(id: "closedElsewhere", status: "closed"), Decision(id: "sending", status: "answered")]
        state.settleVisit(decisions: decisions)
        // 열린 카드의 선택·메모·펼침과 보내는 중인 카드는 그대로.
        XCTAssertEqual(state.engaged, ["open", "sending"])
        XCTAssertEqual(state.reviews["open"]?.choice, "a")
        XCTAssertEqual(state.reviews["open"]?.note, "조건")
        XCTAssertEqual(state.memoOnly, ["open"])
        XCTAssertEqual(state.cardErrors, ["open": "보내지 않았습니다"])
        XCTAssertEqual(state.expandedDetail, ["open"])
        XCTAssertTrue(state.answeredHere.isEmpty)
        XCTAssertTrue(state.batchArmed.isEmpty)
        XCTAssertEqual(state.inFlight, ["sending"])
    }

    func testEndingAVisitWithoutAStateOnlyClearsCardsAnsweredHere() {
        let state = InboxReviewState()
        state.engaged = ["working", "answered"]
        state.answeredHere = ["answered"]
        state.settleVisit(decisions: nil)
        XCTAssertEqual(state.engaged, ["working"])
        XCTAssertTrue(state.answeredHere.isEmpty)
    }

    // MARK: 승인 창 읽기

    func testApprovalReadIdentityIgnoresTheObservationClock() {
        let first = Member(id: "m", status: "blocked", statusObservation: StatusObservation(source: "core", observedAt: "2026-11-10T00:00:01.000Z"))
        let later = Member(id: "m", status: "blocked", statusObservation: StatusObservation(source: "core", observedAt: "2026-11-10T00:00:02.000Z"))
        XCTAssertEqual(CLIApprovalCard.readIdentity(namespace: "n", member: first), CLIApprovalCard.readIdentity(namespace: "n", member: later))
        XCTAssertNotEqual(CLIApprovalCard.readIdentity(namespace: "n", member: first), CLIApprovalCard.readIdentity(namespace: "other", member: first))
        XCTAssertNotEqual(CLIApprovalCard.readIdentity(namespace: "n", member: first), CLIApprovalCard.readIdentity(namespace: "n", member: Member(id: "x")))
    }

    func testApprovalRefreshNeverOverlapsAndCoalescesRequestsIntoOneMoreRead() {
        var refresh = CLIApprovalRefresh()
        XCTAssertTrue(refresh.request())
        // 읽는 동안 온 관측 다섯 번은 취소도, 다섯 번의 읽기도 아니다.
        for _ in 0..<5 { XCTAssertFalse(refresh.request()) }
        XCTAssertTrue(refresh.finished())
        XCTAssertFalse(refresh.finished())
        XCTAssertEqual(refresh, CLIApprovalRefresh())
        XCTAssertTrue(refresh.request())
        XCTAssertFalse(refresh.finished())
    }

    // MARK: 표

    /// 바꾸기 전 구현(정규식 리터럴 두 개)을 그대로 옮긴 기준.
    private func referenceNumber(_ cell: String) -> Double? {
        let s = cell.trimmingCharacters(in: .whitespaces)
        guard s.wholeMatch(of: #/^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?%?$/#) != nil, s.contains(where: \.isNumber) else { return nil }
        if s.wholeMatch(of: #/^[-+]?0\d.*/#) != nil { return nil }
        return Double(s.replacingOccurrences(of: ",", with: "").replacingOccurrences(of: "%", with: ""))
    }

    func testCellNumberMatchesTheOldRegexOnEveryShape() {
        var cases = ["", " ", "-", "+", "%", "-%", ".", "-.", "0", "00", "007", "0.5", "-0.5", "+0.25", ".5", "-.5", "+.5", "5.", "5.%",
                     "1", "12", "123", "1234", "1,234", "12,345", "123,456", "1,234,567", "1234,567", "1,23", "1,2345", "1,234,56",
                     ",123", "1,,234", "1,234,", "1,234.5", "1,234.", "1,234.5%", "12%", "12 %", "%12", "12%%", "-3.5", "--3", "+-3",
                     "3-", "1e5", "1.2.3", "0,123", "0,123.4", "01,234", "010-1234-5678", "02", "0%", "0.0", "00.5", " 42 ", "\t42\t",
                     "42\n", "4 2", "１２３", "١٢٣", "1́", "12a", "a12", "NaN", "inf", "0x10", "1_000", "999,999,999,999", "-1,000%",
                     "+1,000.001%", "12345678901234567890", "0.000000001", "3.14159", "1.0e3", "₩1,000", "1,000원", "(123)"]
        // 조합으로 만든 값도 모두 같은지 본다.
        let signs = ["", "-", "+"], wholes = ["", "0", "7", "012", "123", "1,234", "12,34", "1234,567"], fractions = ["", ".", ".0", ".25"], tails = ["", "%", " ", "x"]
        for sign in signs { for whole in wholes { for fraction in fractions { for tail in tails { cases.append(sign + whole + fraction + tail) } } } }
        for value in cases {
            XCTAssertEqual(cellNumber(value), referenceNumber(value), "'\(value)'")
        }
    }

    func testSortKeepsEmptyCellsLastAndEqualValuesInOriginalOrder() {
        let rows = [["b", "10"], ["a", "9"], ["c", ""], ["d", "1,000"], ["e", "9"], ["f"], ["g", " 12% "]]
        func reference(numeric: Bool, ascending: Bool, column: Int) -> [[String]] {
            Array(rows.enumerated()).sorted { a, b in
                let x = column < a.element.count ? a.element[column].trimmingCharacters(in: .whitespaces) : ""
                let y = column < b.element.count ? b.element[column].trimmingCharacters(in: .whitespaces) : ""
                if x.isEmpty || y.isEmpty { return x.isEmpty == y.isEmpty ? a.offset < b.offset : !x.isEmpty }
                let order: ComparisonResult
                if numeric, let nx = referenceNumber(x), let ny = referenceNumber(y) {
                    order = nx == ny ? .orderedSame : nx < ny ? .orderedAscending : .orderedDescending
                } else { order = x.localizedStandardCompare(y) }
                if order == .orderedSame { return a.offset < b.offset }
                return ascending ? order == .orderedAscending : order == .orderedDescending
            }.map(\.element)
        }
        for numeric in [true, false] { for ascending in [true, false] { for column in [0, 1] {
            XCTAssertEqual(sortedTableRows(rows, column: column, numeric: numeric, ascending: ascending),
                           reference(numeric: numeric, ascending: ascending, column: column), "\(numeric) \(ascending) \(column)")
        } } }
        XCTAssertEqual(sortedTableRows(rows, column: 1, numeric: true, ascending: true).map { $0[0] }, ["a", "e", "b", "g", "d", "c", "f"])
        XCTAssertEqual(sortedTableRows(rows, column: 1, numeric: true, ascending: false).map { $0[0] }, ["d", "g", "b", "a", "e", "c", "f"])
    }

    // MARK: 로컬 파일 미리보기

    func testLongLocalTextIsDrawnInBoundedChunksAndShortTextIsUnchanged() {
        let short = LocalTextPreview(code: "a\r\nb\rc\n")
        XCTAssertEqual(short.chunks, ["a\nb\nc"])
        XCTAssertEqual(short.totalLines, 3)
        XCTAssertFalse(short.cut)
        XCTAssertEqual(LocalTextPreview(code: "").chunks, [" "])

        let lines = (0..<17_068).map { "line \($0)" }
        let long = LocalTextPreview(code: lines.joined(separator: "\n"))
        XCTAssertEqual(long.totalLines, 17_068)
        XCTAssertEqual(long.shownLines, LocalTextPreview.lineLimit)
        XCTAssertTrue(long.cut)
        XCTAssertEqual(long.chunks.count, LocalTextPreview.lineLimit / LocalTextPreview.chunkLines)
        XCTAssertEqual(long.chunks.joined(separator: "\n"), lines.prefix(LocalTextPreview.lineLimit).joined(separator: "\n"))
        for chunk in long.chunks { XCTAssertEqual(chunk.components(separatedBy: "\n").count, LocalTextPreview.chunkLines) }

        // 빈 줄로 끝나는 조각은 그 줄의 높이를 지킨다.
        let gap = LocalTextPreview(code: (0..<400).map { $0 == 199 ? "" : "x" }.joined(separator: "\n"))
        XCTAssertTrue(gap.chunks[0].hasSuffix("\n "))
    }

    func testLongMarkdownIsCutAtALineBoundaryAndShortMarkdownIsUnchanged() {
        XCTAssertEqual(LocalTextPreview.markdownHead("# 제목\n본문").text, "# 제목\n본문")
        XCTAssertFalse(LocalTextPreview.markdownHead("# 제목\n본문").cut)
        let paragraph = "한글 문단입니다. 줄 경계에서만 자릅니다.\n"
        let text = String(repeating: paragraph, count: 2 * LocalTextPreview.markdownBytes / paragraph.utf8.count)
        let head = LocalTextPreview.markdownHead(text)
        XCTAssertTrue(head.cut)
        XCTAssertLessThanOrEqual(head.text.utf8.count, LocalTextPreview.markdownBytes)
        XCTAssertGreaterThan(head.text.utf8.count, LocalTextPreview.markdownBytes - paragraph.utf8.count - 1)
        XCTAssertTrue(text.hasPrefix(head.text))
        XCTAssertTrue((head.text + "\n").hasSuffix(paragraph))
    }

    func testActivityListOnlyReplacesItsRowsWhenTheyChanged() {
        let a = [Activity(id: 2, memberId: "m", at: "t2", kind: "tool", text: "ls"), Activity(id: 1, memberId: "m", at: "t1", kind: "text", text: "hi")]
        XCTAssertTrue(ActivityList.same(a, a))
        var changed = a; changed[1].text = "hello"
        XCTAssertFalse(ActivityList.same(a, changed))
        XCTAssertFalse(ActivityList.same(a, Array(a.prefix(1))))
        XCTAssertTrue(ActivityList.same([], []))
    }
}
