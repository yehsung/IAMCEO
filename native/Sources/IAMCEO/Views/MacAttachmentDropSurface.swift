#if os(macOS)
import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// An AppKit drag destination above the entire detail column. Mouse clicks pass through to the normal UI.
struct MacAttachmentDropSurface: NSViewRepresentable {
    let intake: MacAttachmentIntake
    let policy: MacAttachmentPolicy

    func makeNSView(context: Context) -> DropView { DropView() }
    func updateNSView(_ view: DropView, context: Context) {
        view.intake = intake
        view.policy = policy
    }
    static func dismantleNSView(_ view: DropView, coordinator: ()) { view.intake?.targeted = false }

    final class DropView: NSView {
        var intake: MacAttachmentIntake?
        var readDrop: @MainActor (NSPasteboard) throws -> [MacAttachmentItem] = MacAttachmentItem.readDrop
        var policy = MacAttachmentPolicy(archived: false, demo: false, connected: false,
                                         writable: false, missingTarget: false)
        override init(frame: NSRect) {
            super.init(frame: frame)
            registerForDraggedTypes(MacAttachmentItem.pasteboardTypes)
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func wantsPeriodicDraggingUpdates() -> Bool { true }
        override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation { update(sender) }
        override func draggingUpdated(_ sender: any NSDraggingInfo) -> NSDragOperation { update(sender) }
        private func update(_ sender: any NSDraggingInfo) -> NSDragOperation {
            let supported = MacAttachmentItem.supports(sender.draggingPasteboard)
            intake?.targeted = supported
            return supported && policy.canAccept && intake?.receive != nil
                && sender.draggingSourceOperationMask.contains(.copy) ? .copy : []
        }
        override func draggingExited(_ sender: (any NSDraggingInfo)?) { intake?.targeted = false }
        override func draggingEnded(_ sender: any NSDraggingInfo) { intake?.targeted = false }
        override func prepareForDragOperation(_ sender: any NSDraggingInfo) -> Bool {
            intake?.preflight(policy: policy) ?? false
        }
        override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
            defer { intake?.targeted = false }
            return intake?.acceptDrop(policy: policy) {
                try readDrop(sender.draggingPasteboard)
            } ?? false
        }
    }
}
#endif
