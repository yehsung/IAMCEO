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
        view.intake = intake
        view.submit = submit
        view.setAccessibilityLabel(placeholder)
        if view.string != text {
            view.string = text
            view.undoManager?.removeAllActions()
        }
        if focused, view.window?.firstResponder !== view {
            // Focus requests also arrive while the hosting view is being installed.
            DispatchQueue.main.async { [weak view] in
                guard let view, context.coordinator.parent.focused else { return }
                view.window?.makeFirstResponder(view)
            }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView scroll: NSScrollView, context: Context) -> CGSize? {
        guard let view = scroll.documentView as? Editor,
              let container = view.textContainer, let layout = view.layoutManager else { return nil }
        let proposedWidth = proposal.width ?? 300
        let width = proposedWidth.isFinite ? max(1, proposedWidth) : 300
        container.containerSize = NSSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        return CGSize(width: width, height: min(154, max(22, ceil(layout.usedRect(for: container).height))))
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: MacComposerTextView
        init(_ parent: MacComposerTextView) { self.parent = parent }
        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            parent.text = view.string
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
        var intake: MacAttachmentIntake?
        var submit: (() -> Void)?

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
            let items = MacAttachmentItem.read(.general)
            guard !items.isEmpty else { super.paste(sender); return }
            // Consume recognized files/images even if writes are blocked; never fall back to path insertion.
            _ = receive?(items)
        }
        override func keyDown(with event: NSEvent) {
            if event.keyCode == 36 || event.keyCode == 76 {
                if event.modifierFlags.intersection([.shift, .option]).isEmpty && !hasMarkedText() { submit?(); return }
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
            return canReceive?() == true
        }
        override func draggingExited(_ sender: (any NSDraggingInfo)?) { intake?.targeted = false; super.draggingExited(sender) }
        override func draggingEnded(_ sender: any NSDraggingInfo) { intake?.targeted = false; super.draggingEnded(sender) }
        override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
            guard MacAttachmentItem.supports(sender.draggingPasteboard) else { return super.performDragOperation(sender) }
            defer { intake?.targeted = false }
            let items = MacAttachmentItem.read(sender.draggingPasteboard)
            return receive?(items) ?? false
        }
    }
}
#endif
