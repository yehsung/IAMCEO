import XCTest
@testable import IAMCEO

final class MarkdownTableColumnsTests: XCTestCase {
    private func assertFits(_ ideal: [CGFloat], floor: CGFloat = 54, available: CGFloat, file: StaticString = #filePath, line: UInt = #line) -> [CGFloat] {
        let widths = MarkdownTableColumns.widths(ideal: ideal, floor: floor, available: available)
        XCTAssertEqual(widths.count, ideal.count, file: file, line: line)
        XCTAssertLessThanOrEqual(widths.reduce(0, +), available + 0.001, "table wider than the space", file: file, line: line)
        return widths
    }

    /// A wide decision card: five columns, one very wide, on an iPhone card (~329pt). Before the fix the floors were
    /// added on top of the proportional split and the table came out ~40pt wider than the screen.
    func testWideFiveColumnTableNeverExceedsPhoneWidth() {
        let widths = assertFits([140, 460, 300, 200, 110], available: 329)
        XCTAssertEqual(widths.reduce(0, +), 329, accuracy: 0.001)
        XCTAssertTrue(widths.allSatisfy { $0 >= 54 - 0.001 })
        // The widest column still gets the most room.
        XCTAssertEqual(widths.firstIndex(of: widths.max()!), 1)
    }

    func testNarrowColumnsKeepNaturalWidthAndWideOnesShareTheRest() {
        let widths = assertFits([60, 400, 380], available: 329)
        XCTAssertEqual(widths[0], 60, accuracy: 0.001)
        XCTAssertEqual(widths.reduce(0, +), 329, accuracy: 0.001)
    }

    func testFittingTableStretchesToFill() {
        let widths = assertFits([80, 100], available: 360)
        XCTAssertEqual(widths.reduce(0, +), 360, accuracy: 0.001)
    }

    func testTooManyColumnsForFloorsSplitsEvenly() {
        let widths = assertFits([200, 200, 200, 200, 200, 200, 200], available: 300)
        XCTAssertEqual(widths.reduce(0, +), 300, accuracy: 0.001)
        XCTAssertEqual(widths[0], widths[6], accuracy: 0.001)
    }

    func testUnspecifiedWidthUsesNaturalSizes() {
        XCTAssertEqual(MarkdownTableColumns.widths(ideal: [30, 120], floor: 54, available: nil), [54, 120])
    }

    func testManyRandomTablesAlwaysFit() {
        var seed: UInt64 = 42
        func next() -> CGFloat { seed = seed &* 6364136223846793005 &+ 1442695040888963407; return CGFloat(seed >> 40) }
        for _ in 0..<500 {
            let count = Int(next().truncatingRemainder(dividingBy: 7)) + 1
            let ideal = (0..<count).map { _ in 20 + next().truncatingRemainder(dividingBy: 480) }
            let available = 200 + next().truncatingRemainder(dividingBy: 700)
            _ = assertFits(ideal, available: available)
        }
    }
}
