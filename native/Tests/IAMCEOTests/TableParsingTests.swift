import Foundation
import XCTest
@testable import IAMCEO

/// E7 §6: 표 해석을 자료 화면에서 Models/TableParsing.swift 로 옮겼다(전에는 private 이라 시험이 없었다). 지금의 결과를 고정한다.
final class TableParsingTests: XCTestCase {
    func testQuotedCellsDoubledQuotesAndNewlinesInsideQuotes() {
        let table = parseTable("name,note\n\"Kim, J\",\"say \"\"hi\"\"\"\n\"multi\nline\",x\n", tab: false, truncated: false)
        XCTAssertEqual(table.header, ["name", "note"])
        XCTAssertEqual(table.rows, [["Kim, J", "say \"hi\""], ["multi\nline", "x"]])
        XCTAssertEqual(table.hiddenColumns, 0)
        XCTAssertEqual(table.numeric, [false, false])
    }

    func testByteOrderMarkCRLFBlankLinesAndShortRows() {
        let table = parseTable("\u{FEFF}a,b,c\r\n1,2\r\n\r\n3,4,5\r\n", tab: false, truncated: false)
        XCTAssertEqual(table.header, ["a", "b", "c"])
        XCTAssertEqual(table.rows, [["1", "2"], ["3", "4", "5"]], "a blank line is not a row")
        XCTAssertEqual(table.numeric, [true, true, true], "a missing cell does not make a column text")
    }

    func testDelimiterIsSniffedFromTheFirstUnquotedLine() {
        XCTAssertEqual(sniffDelimiter(Array("a;b;c\n1,2".unicodeScalars)), ";")
        XCTAssertEqual(sniffDelimiter(Array("\"x;y;z\",b\n".unicodeScalars)), ",", "quoted delimiters do not count")
        XCTAssertEqual(sniffDelimiter(Array("a\tb\n".unicodeScalars)), "\t")
        XCTAssertEqual(sniffDelimiter(Array("single".unicodeScalars)), ",")
        let excel = parseTable("이름;금액\n김;1.234\n", tab: false, truncated: false)
        XCTAssertEqual(excel.header, ["이름", "금액"])
        XCTAssertEqual(excel.rows, [["김", "1.234"]])
        XCTAssertEqual(parseTable("a;b\tc\n", tab: true, truncated: false).header, ["a;b", "c"], "a .tsv file always splits on tabs")
    }

    func testCutFileDropsItsUnfinishedLastLineAndColumnsAreCapped() {
        XCTAssertEqual(parseTable("a,b\n1,2\n3,", tab: false, truncated: true).rows, [["1", "2"]])
        XCTAssertEqual(parseTable("a,b\n1,2\n3,", tab: false, truncated: false).rows, [["1", "2"], ["3", ""]])
        let wide = (0..<35).map { "c\($0)" }.joined(separator: ",") + "\n" + (0..<35).map(String.init).joined(separator: ",")
        let table = parseTable(wide, tab: false, truncated: false)
        XCTAssertEqual(table.header.count, tableColumnLimit)
        XCTAssertEqual(table.hiddenColumns, 35 - tableColumnLimit)
        XCTAssertEqual(table.rows.first?.count, tableColumnLimit)
    }

    func testEmptyInputAndHeaderOnly() {
        let empty = parseTable("", tab: false, truncated: false)
        XCTAssertEqual(empty.header, [])
        XCTAssertEqual(empty.rows, [])
        XCTAssertEqual(empty.hiddenColumns, 0)
        let header = parseTable("x,y", tab: false, truncated: false)
        XCTAssertEqual(header.header, ["x", "y"])
        XCTAssertEqual(header.rows, [])
        XCTAssertEqual(header.numeric, [false, false], "a column with no number is text")
    }

    func testNumericColumnsSkipBlankCellsAndNeedOneNumber() {
        XCTAssertEqual(parseTable("n,t,e\n1,a, \n2,3, \n", tab: false, truncated: false).numeric, [true, false, false])
    }

    func testDecodeTextFollowsTheWebOrder() throws {
        XCTAssertEqual(decodeText(Data([0xFF, 0xFE]) + (try XCTUnwrap("표".data(using: .utf16LittleEndian))), truncated: false), "표")
        XCTAssertEqual(decodeText(Data([0xFE, 0xFF]) + (try XCTUnwrap("표".data(using: .utf16BigEndian))), truncated: false), "표")
        let utf8 = Data("가나".utf8)
        XCTAssertEqual(decodeText(utf8, truncated: false), "가나")
        XCTAssertEqual(decodeText(utf8.prefix(5), truncated: true), "가", "a cut head drops its broken last character")
        let cp949 = String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.dosKorean.rawValue)))
        XCTAssertEqual(decodeText(try XCTUnwrap("한글".data(using: cp949)), truncated: false), "한글")
    }
}
