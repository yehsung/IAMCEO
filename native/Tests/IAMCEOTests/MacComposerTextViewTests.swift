#if os(macOS)
import AppKit
import SwiftUI
import XCTest
@testable import IAMCEO

@MainActor
final class MacComposerTextViewTests: XCTestCase {
    private func measure(_ text: String, width: CGFloat? = 300) -> CGSize {
        MacComposerTextView.measuredSize(text: text, proposedWidth: width)
    }

    private func expectedHeight(lines: Int) -> CGFloat {
        let lineHeight = NSLayoutManager().defaultLineHeight(for: .systemFont(ofSize: 15))
        return min(154, max(22, ceil(CGFloat(lines) * lineHeight + CGFloat(lines - 1) * 4)))
    }

    func testEmptyAndSingleLineUseMinimumHeight() {
        XCTAssertEqual(measure(""), CGSize(width: 300, height: 22))
        XCTAssertEqual(measure("Saved draft"), CGSize(width: 300, height: 22))
        XCTAssertEqual(measure("한 줄 초안").height, 22)
    }

    func testMultipleLinesUseSystemFontAndParagraphSpacing() {
        XCTAssertEqual(measure("one\ntwo").height, expectedHeight(lines: 2))
        XCTAssertEqual(measure("one\ntwo\nthree").height, expectedHeight(lines: 3))
    }

    func testLongLineWrapsAtProposedWidthWithoutFragmentPadding() {
        let font = NSFont.systemFont(ofSize: 15)
        let glyphWidth = ("M" as NSString).size(withAttributes: [.font: font]).width
        let text = String(repeating: "M", count: 12)
        // Six glyphs fit with zero padding; a default five-point inset would wrap sooner.
        XCTAssertEqual(measure(text, width: glyphWidth * 6 + 0.5).height, expectedHeight(lines: 2))
        XCTAssertEqual(measure(text, width: glyphWidth * 12 + 0.5).height, expectedHeight(lines: 1))
    }

    func testTrailingNewlinesIncludeEmptyFinalLine() {
        XCTAssertEqual(measure("one\n").height, expectedHeight(lines: 2))
        XCTAssertEqual(measure("\n").height, expectedHeight(lines: 2))
        XCTAssertEqual(measure("one\n\n").height, expectedHeight(lines: 3))
        XCTAssertEqual(measure("one\ntwo\n").height, measure("one\ntwo\nthree").height)
    }

    func testHeightIsCappedForManyLinesAndNarrowWrapping() {
        XCTAssertEqual(measure(String(repeating: "line\n", count: 30)).height, 154)
        XCTAssertEqual(measure(String(repeating: "M", count: 100), width: 1).height, 154)
    }

    func testWidthNormalizationMatchesPreviousBehavior() {
        for width: CGFloat? in [nil, .infinity, -.infinity, .nan] {
            XCTAssertEqual(measure("draft", width: width).width, 300)
        }
        XCTAssertEqual(measure("draft", width: 0).width, 1)
        XCTAssertEqual(measure("draft", width: -30).width, 1)
        XCTAssertEqual(measure("draft", width: 123.5).width, 123.5)
    }

    func testRepeatedAndAlternatingProposalsAreDeterministic() {
        for text in ["", "draft", "one\ntwo", String(repeating: "wrap ", count: 40), "draft\n"] {
            for width: CGFloat in [1, 80, 300, 600] {
                let first = measure(text, width: width)
                XCTAssertEqual(measure(text, width: width), first)
                _ = measure(text, width: width + 173)
                XCTAssertEqual(measure(text, width: width), first)
            }
        }
    }

    /// Uses only a synthetic draft and a composer host; never constructs the live app/store.
    func testHostedDraftMeasurementPreservesEditorAndSurvivesResizeHitTesting() async throws {
        let draft = String(repeating: "a", count: 29)
        let composer = MacComposerTextView(text: .constant(draft), focused: .constant(false),
                                           placeholder: "Draft", intake: MacAttachmentIntake(),
                                           canReceive: { false }, receive: { _ in false }, submit: {})
        let hosting = NSHostingView(rootView: composer)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 154),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = hosting
        defer { window.orderOut(nil); window.contentView = nil }
        hosting.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(20))
        let editor = try XCTUnwrap(findEditor(in: hosting))
        let container = try XCTUnwrap(editor.textContainer)
        let containerSize = container.containerSize
        let frame = editor.frame
        let selection = editor.selectedRange()
        let needsLayout = editor.needsLayout
        for width: CGFloat in [1, 80, 600, 300, 80, 300] {
            _ = measure(draft, width: width)
        }
        XCTAssertEqual(editor.string, draft)
        XCTAssertEqual(container.containerSize, containerSize)
        XCTAssertEqual(editor.frame, frame)
        XCTAssertEqual(editor.selectedRange(), selection)
        XCTAssertEqual(editor.needsLayout, needsLayout)
        XCTAssertTrue(container.widthTracksTextView)

        for width: CGFloat in [600, 80, 300, 120, 450, 300] {
            window.setContentSize(NSSize(width: width, height: 154))
            hosting.layoutSubtreeIfNeeded()
            _ = hosting.hitTest(NSPoint(x: 20, y: 10))
            window.displayIfNeeded()
            try await Task.sleep(for: .milliseconds(20))
            XCTAssertEqual(editor.string, draft)
        }
    }

    private func findEditor(in view: NSView) -> MacComposerTextView.Editor? {
        if let editor = view as? MacComposerTextView.Editor { return editor }
        for child in view.subviews {
            if let editor = findEditor(in: child) { return editor }
        }
        return nil
    }
}
#endif
