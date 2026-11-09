#if os(macOS)
import AppKit
import SwiftUI
import XCTest
@testable import IAMCEO

@MainActor
final class KoreanIMETests: XCTestCase {
    /// Synthetic, synchronous binding with separately deliverable snapshots. No app/store/settings access.
    @MainActor private final class Draft {
        var value: String
        var incoming: String
        var revision = 0
        var revisionReads = 0
        private var nextRevision = 0

        init(_ value: String = "") { self.value = value; incoming = value }

        func write(_ value: String) {
            nextRevision += 1
            self.value = value
            incoming = value
            revision = nextRevision
        }

        func echo(_ value: String, revision: Int) {
            incoming = value
            self.revision = revision
        }

        func composer() -> MacComposerTextView {
            MacComposerTextView(
                text: Binding(get: { self.incoming }, set: { self.write($0) }),
                focused: .constant(false), placeholder: "IME test", intake: MacAttachmentIntake(),
                canReceive: { false }, receive: { _ in false }, submit: {},
                textRevision: { self.revisionReads += 1; return self.revision })
        }
    }

    @MainActor private final class EditorFixture {
        let draft: Draft
        let coordinator: MacComposerTextView.Coordinator
        let editor: MacComposerTextView.Editor

        init(_ initial: String = "") {
            _ = NSApplication.shared
            draft = Draft(initial)
            coordinator = draft.composer().makeCoordinator()
            editor = MacComposerTextView.Editor(frame: NSRect(x: 0, y: 0, width: 300, height: 100))
            editor.isRichText = false
            editor.allowsUndo = true
            editor.delegate = coordinator
            editor.textChanged = { [weak coordinator = coordinator, weak editor = editor] in
                guard let editor else { return }
                coordinator?.publish(editor)
            }
            synchronize()
            editor.setSelectedRange(NSRange(location: (initial as NSString).length, length: 0))
        }

        func synchronize() {
            coordinator.synchronize(editor, text: draft.incoming, revision: draft.revision)
        }

        func mark(_ value: String) {
            editor.setMarkedText(value, selectedRange: NSRange(location: (value as NSString).length, length: 0),
                                 replacementRange: NSRange(location: NSNotFound, length: 0))
        }

        func commit(_ value: String) {
            editor.insertText(value, replacementRange: NSRange(location: NSNotFound, length: 0))
        }
    }

    func testMarkedTextAndPrefixSurviveSameOldAndEmptyBindingUpdates() {
        let fixture = EditorFixture("앞 글 🙂 ")
        fixture.mark("ㅎ")
        let oldText = fixture.draft.value
        let oldRevision = fixture.draft.revision
        fixture.mark("하")
        let currentText = fixture.editor.string
        let markedRange = fixture.editor.markedRange()
        let selection = fixture.editor.selectedRange()
        let currentRevision = fixture.draft.revision
        XCTAssertTrue(fixture.editor.hasMarkedText())
        XCTAssertEqual(fixture.draft.value, currentText, "Marked text enables the send button too")

        for (value, revision) in [(currentText, currentRevision), (oldText, oldRevision), ("", 0), ("외부 변경", currentRevision + 1)] {
            fixture.draft.echo(value, revision: revision)
            fixture.synchronize()
            XCTAssertTrue(fixture.editor.hasMarkedText())
            XCTAssertEqual(fixture.editor.markedRange(), markedRange)
            XCTAssertEqual(fixture.editor.selectedRange(), selection)
            XCTAssertEqual(fixture.editor.string, "앞 글 🙂 하")
        }
    }

    func testInsertTextCommitsFinalKoreanStringToBindingSynchronously() {
        let fixture = EditorFixture("앞 글 ")
        fixture.mark("ㅎ")
        fixture.mark("하")
        fixture.commit("한")
        XCTAssertFalse(fixture.editor.hasMarkedText())
        XCTAssertEqual(fixture.editor.string, "앞 글 한")
        XCTAssertEqual(fixture.draft.value, "앞 글 한")
    }

    func testUnmarkTextPublishesEvenWithoutAnotherTextDidChange() {
        let fixture = EditorFixture("앞 글 ")
        fixture.mark("한")
        fixture.draft.echo("앞 글 ", revision: 0)
        fixture.editor.unmarkText()
        XCTAssertFalse(fixture.editor.hasMarkedText())
        XCTAssertEqual(fixture.draft.value, "앞 글 한")
        XCTAssertEqual(fixture.draft.incoming, "앞 글 한")
    }

    func testDelayedEchoAfterCommitCannotRestoreOldOrEmptyDraft() {
        let fixture = EditorFixture()
        fixture.commit("앞 글 ")
        let oldText = fixture.draft.value
        let oldRevision = fixture.draft.revision
        fixture.mark("ㅎ")
        fixture.commit("한")
        let selection = fixture.editor.selectedRange()
        for (value, revision) in [(oldText, oldRevision), ("", 0), ("앞 글 한", fixture.draft.revision)] {
            fixture.draft.echo(value, revision: revision)
            fixture.synchronize()
            XCTAssertEqual(fixture.editor.string, "앞 글 한")
            XCTAssertEqual(fixture.editor.selectedRange(), selection)
            XCTAssertEqual(fixture.draft.value, "앞 글 한")
        }
    }

    func testSendCommitPrecedesSnapshotAndNewExternalClearIsApplied() {
        let fixture = EditorFixture("앞 글 ")
        fixture.mark("한")
        fixture.draft.echo("앞 글 ", revision: 0)
        fixture.editor.commitComposition()
        let sentText = fixture.draft.value
        XCTAssertFalse(fixture.editor.hasMarkedText())
        XCTAssertEqual(sentText, "앞 글 한")

        fixture.draft.write("") // Send accepted: the external draft consumes the captured text.
        fixture.synchronize()
        XCTAssertEqual(fixture.editor.string, "")
        XCTAssertEqual(fixture.editor.selectedRange(), NSRange(location: 0, length: 0))
        XCTAssertFalse(fixture.editor.undoManager?.canUndo ?? true)
    }

    func testSameStringWithOlderRevisionCannotLowerPublishedRevision() {
        let fixture = EditorFixture()
        fixture.commit("앞 글 ")
        let oldRevision = fixture.draft.revision
        fixture.commit("한")
        fixture.draft.echo("앞 글 한", revision: 0)
        fixture.coordinator.publish(fixture.editor)
        fixture.draft.echo("앞 글 ", revision: oldRevision)
        fixture.synchronize()
        XCTAssertEqual(fixture.editor.string, "앞 글 한")
    }

    func testExternalReplacementMovesSelectionToUTF16End() {
        let fixture = EditorFixture("🙂 앞 글 한글")
        fixture.editor.setSelectedRange(NSRange(location: 3, length: 2))
        fixture.draft.write("🙂 앞 글 다른 초안")
        fixture.synchronize()
        XCTAssertEqual(fixture.editor.selectedRange(), NSRange(location: "🙂 앞 글 다른 초안".utf16.count, length: 0))
        fixture.draft.write("짧음")
        fixture.synchronize()
        XCTAssertEqual(fixture.editor.string, "짧음")
        XCTAssertEqual(fixture.editor.selectedRange(), NSRange(location: 2, length: 0))
    }

    func testReturnDuringCompositionDoesNotSubmitAndCommittedReturnDoes() throws {
        let fixture = EditorFixture("앞 글 ")
        var submissions = 0
        fixture.editor.submit = { submissions += 1 }
        fixture.mark("한")
        let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
            timestamp: 0, windowNumber: 0, context: nil, characters: "\r", charactersIgnoringModifiers: "\r",
            isARepeat: false, keyCode: 36))
        fixture.editor.keyDown(with: event)
        XCTAssertEqual(submissions, 0)
        fixture.editor.commitComposition()
        fixture.editor.keyDown(with: event)
        XCTAssertEqual(submissions, 1)
    }

    /// Exercises the actual NSViewRepresentable updateNSView path, not just its synchronization helper.
    func testHostedBindingRoundTripPreservesMarkedTextThenAcceptsExternalClear() async throws {
        _ = NSApplication.shared
        let draft = Draft("앞 글 ")
        let hosting = NSHostingView(rootView: draft.composer())
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 100),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = hosting
        defer { window.orderOut(nil); window.contentView = nil }
        try await waitUntil { hosting.layoutSubtreeIfNeeded(); return self.findEditor(in: hosting) != nil && draft.revisionReads > 0 }
        let editor = try XCTUnwrap(findEditor(in: hosting))
        editor.setSelectedRange(NSRange(location: (editor.string as NSString).length, length: 0))
        editor.setMarkedText("한", selectedRange: NSRange(location: 1, length: 0),
                             replacementRange: NSRange(location: NSNotFound, length: 0))
        let markedRange = editor.markedRange()
        let text = editor.string
        let revision = draft.revision

        for (value, revision) in [(text, revision), ("앞 글 ", 0), ("", 0)] {
            draft.echo(value, revision: revision)
            let reads = draft.revisionReads
            hosting.rootView = draft.composer()
            try await waitUntil { hosting.layoutSubtreeIfNeeded(); return draft.revisionReads > reads }
            XCTAssertTrue(editor.hasMarkedText())
            XCTAssertEqual(editor.markedRange(), markedRange)
            XCTAssertEqual(editor.string, "앞 글 한")
        }
        editor.insertText("한국", replacementRange: NSRange(location: NSNotFound, length: 0))
        XCTAssertEqual(draft.value, "앞 글 한국")
        XCTAssertFalse(editor.hasMarkedText())
        draft.write("")
        hosting.rootView = draft.composer()
        try await waitUntil { hosting.layoutSubtreeIfNeeded(); return editor.string.isEmpty }
    }

    private func waitUntil(timeout: Duration = .seconds(2), _ condition: () -> Bool) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while !condition() {
            guard clock.now < deadline else {
                XCTFail("IME host update exceeded its deadline")
                throw NSError(domain: "KoreanIMETests.Timeout", code: 1)
            }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    private func findEditor(in view: NSView) -> MacComposerTextView.Editor? {
        if let editor = view as? MacComposerTextView.Editor { return editor }
        return view.subviews.lazy.compactMap { self.findEditor(in: $0) }.first
    }
}
#endif
