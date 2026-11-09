#if os(macOS)
import AppKit
import SwiftUI

/// Owns paste and drag at the native editor, before NSTextView can insert a Finder path as text.
struct MacComposerTextView: NSViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    let placeholder: String
    let intake: MacAttachmentIntake
    let canReceive: () -> Bool
    let receive: ([MacAttachmentItem]) -> Bool
    let submit: () -> Void
    var rejectionReason: (() -> String?)? = nil
    /// Incremented for local edits and external changes, including send/clear.
    /// The production binding supplies this to distinguish old empty drafts from intentional clears.
    var textRevision: (() -> Int)? = nil

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = false
        let view = Editor()
        view.allowsUndo = true
        view.isRichText = false
        view.importsGraphics = false
        view.drawsBackground = false
        view.font = .systemFont(ofSize: 15)
        view.textColor = NSColor(CE.ink)
        view.insertionPointColor = NSColor(CE.accent)
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = true
        view.isHorizontallyResizable = false
        view.isVerticallyResizable = true
        view.autoresizingMask = [.width]
        view.minSize = .zero
        view.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        let style = NSMutableParagraphStyle()
        style.lineSpacing = 4
        view.defaultParagraphStyle = style
        view.delegate = context.coordinator
        view.textChanged = { [weak coordinator = context.coordinator, weak view] in
            guard let view else { return }
            coordinator?.publish(view)
        }
        view.registerForDraggedTypes(MacAttachmentItem.pasteboardTypes)
        scroll.documentView = view
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let view = scroll.documentView as? Editor else { return }
        view.isEditable = context.environment.isEnabled
        view.isSelectable = context.environment.isEnabled
        view.canReceive = canReceive
        view.focusChanged = { context.coordinator.parent.focused = $0 }
        view.receive = receive
        view.rejectionReason = rejectionReason
        view.intake = intake
        view.submit = submit
        view.setAccessibilityLabel(placeholder)
        context.coordinator.synchronize(view, text: text, revision: textRevision?())
        if focused, view.window?.firstResponder !== view {
            // Focus requests also arrive while the hosting view is being installed.
            DispatchQueue.main.async { [weak view] in
                guard let view, context.coordinator.parent.focused else { return }
                view.window?.makeFirstResponder(view)
            }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView scroll: NSScrollView, context: Context) -> CGSize? {
        Self.measuredSize(text: text, proposedWidth: proposal.width)
    }

    /// SwiftUI probes multiple widths. Never lay out the live editor while measuring it;
    /// its container width is owned by widthTracksTextView during actual view layout.
    static func measuredSize(text: String, proposedWidth: CGFloat?) -> CGSize {
        let proposedWidth = proposedWidth ?? 300
        let width = proposedWidth.isFinite ? max(1, proposedWidth) : 300
        let style = NSMutableParagraphStyle()
        style.lineSpacing = 4
        // TextKit's usedRect omits the empty final paragraph. A zero-width glyph gives
        // it the same font and line spacing as other lines, without adding any width.
        let measuredText = text.hasSuffix("\n") ? text + "\u{200B}" : text
        let storage = NSTextStorage(string: measuredText, attributes: [
            .font: NSFont.systemFont(ofSize: 15), .paragraphStyle: style,
        ])
        let layout = NSLayoutManager()
        let container = NSTextContainer(size: NSSize(width: width, height: CGFloat.greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)
        layout.ensureLayout(for: container)
        return CGSize(width: width, height: min(154, max(22, ceil(layout.usedRect(for: container).height))))
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: MacComposerTextView
        private var lastRevision: Int?
        private var lastPublishedText: String?
        private var applyingExternalText = false
        init(_ parent: MacComposerTextView) { self.parent = parent }

        func synchronize(_ view: Editor, text: String, revision: Int?) {
            // Even a genuine external update must not destroy AppKit's marked range.
            guard !view.hasMarkedText(), !view.isHandlingInput else { return }
            if let revision, let lastRevision, revision <= lastRevision { return }
            if revision == nil, text == lastPublishedText { return }
            lastRevision = revision
            guard !view.string.utf8.elementsEqual(text.utf8) else { return }
            let selections = view.selectedRanges.map { $0.rangeValue }
            applyingExternalText = true
            defer { applyingExternalText = false }
            view.string = text
            let length = (text as NSString).length
            view.selectedRanges = selections.map { range in
                let location = min(range.location, length)
                return NSValue(range: NSRange(location: location, length: min(range.length, length - location)))
            }
            view.undoManager?.removeAllActions()
        }

        func publish(_ view: Editor) {
            guard !view.isHandlingInput, !applyingExternalText else { return }
            let value = view.string
            lastPublishedText = value
            if !parent.text.utf8.elementsEqual(value.utf8) { parent.text = value }
            // The binding setter is synchronous. Remember its revision before SwiftUI echoes it.
            if let revision = parent.textRevision?() {
                lastRevision = max(lastRevision ?? revision, revision)
            }
        }

        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? Editor else { return }
            publish(view)
        }
        func textDidBeginEditing(_ notification: Notification) { parent.focused = true }
        func textDidEndEditing(_ notification: Notification) { parent.focused = false }
    }

    final class Editor: NSTextView {
        private let editUndoManager = UndoManager()
        override var undoManager: UndoManager? { editUndoManager }
        var canReceive: (() -> Bool)?
        var focusChanged: ((Bool) -> Void)?
        var receive: (([MacAttachmentItem]) -> Bool)?
        var rejectionReason: (() -> String?)?
        var intake: MacAttachmentIntake?
        var submit: (() -> Void)?
        var textChanged: (() -> Void)?
        private var inputDepth = 0
        var isHandlingInput: Bool { inputDepth > 0 }

        private func finishInput() {
            inputDepth -= 1
            if inputDepth == 0 { textChanged?() }
        }

        override func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
            inputDepth += 1
            defer { finishInput() }
            super.setMarkedText(string, selectedRange: selectedRange, replacementRange: replacementRange)
        }

        override func insertText(_ string: Any, replacementRange: NSRange) {
            inputDepth += 1
            defer { finishInput() }
            super.insertText(string, replacementRange: replacementRange)
        }

        override func unmarkText() {
            inputDepth += 1
            defer { finishInput() }
            super.unmarkText()
        }

        /// Called by the send button before taking the draft snapshot.
        func commitComposition() {
            if hasMarkedText() {
                unmarkText()
                inputContext?.discardMarkedText()
            }
            textChanged?()
        }

        override func becomeFirstResponder() -> Bool {
            let accepted = super.becomeFirstResponder()
            if accepted { focusChanged?(true) }
            return accepted
        }
        override func resignFirstResponder() -> Bool {
            let accepted = super.resignFirstResponder()
            if accepted { focusChanged?(false) }
            return accepted
        }
        override func paste(_ sender: Any?) {
            if !pasteAttachments(from: .general) { super.paste(sender) }
        }
        @discardableResult func pasteAttachments(from pasteboard: NSPasteboard) -> Bool {
            guard MacAttachmentItem.supports(pasteboard) else { return false }
            // Consume recognized files/images even if writes are blocked; never fall back to path insertion.
            _ = acceptAttachments(MacAttachmentItem.read(pasteboard))
            return true
        }
        private func acceptAttachments(_ items: [MacAttachmentItem]) -> Bool {
            guard !items.isEmpty else {
                intake?.reportRejection("파일이나 이미지를 읽지 못했습니다")
                return false
            }
            guard let receive else {
                intake?.reportRejection("입력칸을 준비 중이라 첨부하지 못했습니다. 다시 놓아 주세요")
                return false
            }
            return receive(items)
        }
        override func keyDown(with event: NSEvent) {
            if (event.keyCode == 36 || event.keyCode == 76) && !hasMarkedText() {
                if event.modifierFlags.intersection([.shift, .option]).isEmpty { submit?() }
                else { insertNewline(nil) }
                return
            }
            super.keyDown(with: event)
        }
        // Files and images become attachments; anything else (a dragged text snippet) keeps NSTextView's own drop.
        override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
            guard MacAttachmentItem.supports(sender.draggingPasteboard) else { return super.draggingEntered(sender) }
            return updateDrag(sender)
        }
        override func draggingUpdated(_ sender: any NSDraggingInfo) -> NSDragOperation {
            guard MacAttachmentItem.supports(sender.draggingPasteboard) else { return super.draggingUpdated(sender) }
            return updateDrag(sender)
        }
        private func updateDrag(_ sender: any NSDraggingInfo) -> NSDragOperation {
            intake?.targeted = true
            return canReceive?() == true && sender.draggingSourceOperationMask.contains(.copy) ? .copy : []
        }
        override func prepareForDragOperation(_ sender: any NSDraggingInfo) -> Bool {
            guard MacAttachmentItem.supports(sender.draggingPasteboard) else { return super.prepareForDragOperation(sender) }
            guard canReceive?() == true else {
                intake?.reportRejection(rejectionReason?() ?? "지금은 이 입력칸에 첨부할 수 없습니다")
                return false
            }
            return true
        }
        override func draggingExited(_ sender: (any NSDraggingInfo)?) { intake?.targeted = false; super.draggingExited(sender) }
        override func draggingEnded(_ sender: any NSDraggingInfo) { intake?.targeted = false; super.draggingEnded(sender) }
        override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
            guard MacAttachmentItem.supports(sender.draggingPasteboard) else { return super.performDragOperation(sender) }
            defer { intake?.targeted = false }
            let items = MacAttachmentItem.read(sender.draggingPasteboard)
            return acceptAttachments(items)
        }
    }
}
#endif
