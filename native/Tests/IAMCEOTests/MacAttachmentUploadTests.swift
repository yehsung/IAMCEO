#if os(macOS)
import AppKit
import SwiftUI
import XCTest
import ImageIO
import UniformTypeIdentifiers
@testable import IAMCEO

@MainActor
private final class FixtureDrag: NSObject, @preconcurrency NSDraggingInfo {
    let draggingPasteboard: NSPasteboard
    init(_ pasteboard: NSPasteboard) { draggingPasteboard = pasteboard }
    var draggingDestinationWindow: NSWindow? { nil }
    var draggingSourceOperationMask: NSDragOperation { .copy }
    var draggingLocation: NSPoint { .zero }
    var draggedImageLocation: NSPoint { .zero }
    var draggedImage: NSImage? { nil }
    var draggingSource: Any? { nil }
    var draggingSequenceNumber: Int { 1 }
    var draggingFormation: NSDraggingFormation = .none
    var animatesToDestination = false
    var numberOfValidItemsForDrop = 0
    var springLoadingHighlight: NSSpringLoadingHighlight { .none }
    func slideDraggedImage(to screenPoint: NSPoint) {}
    override func namesOfPromisedFilesDropped(atDestination dropDestination: URL) -> [String]? { nil }
    func resetSpringLoading() {}
    func enumerateDraggingItems(options: NSDraggingItemEnumerationOptions, for view: NSView?,
                                classes classArray: [AnyClass], searchOptions: [NSPasteboard.ReadingOptionKey: Any],
                                using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
}

@MainActor
final class MacAttachmentUploadTests: XCTestCase {
    private let writable = MacAttachmentPolicy(archived: false, demo: false, connected: true,
                                                writable: true, missingTarget: false)

    private func network(failUploads: Bool = false, writable: Bool = true) throws -> IsolatedTestNetwork {
        try IsolatedTestNetwork { request in
            let json: String
            switch request.url?.path {
            case "/api/bootstrap": json = #"{"projects":[{"id":"p","name":"Fixture"},{"id":"q","name":"Other"}],"settings":{}}"#
            case "/api/projects/p/state":
                json = "{\"project\":{\"id\":\"p\",\"connection\":{\"ok\":\(writable)}},\"members\":[],\"messages\":[]}"
            case "/api/projects/q/state": json = #"{"project":{"id":"q","connection":{"ok":true}},"members":[],"messages":[]}"#
            case "/api/runtime": json = "{}"
            case "/api/uploads":
                if failUploads { return IsolatedTestHTTPReply(status: 503, data: Data(#"{"error":"fixture upload refused"}"#.utf8)) }
                json = "{\"id\":\"\(UUID().uuidString)\",\"name\":\"fixture\",\"url\":\"/uploads/fixture\"}"
            default: throw URLError(.resourceUnavailable)
            }
            return IsolatedTestHTTPReply(data: Data(json.utf8))
        }
    }

    private func settle() async throws { try await Task.sleep(for: .milliseconds(100)) }

    private func connected(_ net: IsolatedTestNetwork, drafts: DraftStore? = nil) async throws -> AppStore {
        let store = AppStore(session: net.session, persistCredentials: false, drafts: drafts)
        store.endpoint = net.endpoint.url.absoluteString; store.accessCode = "fixture-only"
        await store.connect(); store.setForeground(false)
        XCTAssertTrue(store.uiCanWrite)
        return store
    }

    private func context(_ store: AppStore, target: String? = nil) -> ComposerUploadContext {
        ComposerUploadContext(projectID: store.selectedProjectID!, targetMemberID: target,
                              token: store.drafts.uploadToken(for: DraftStore.key(project: store.selectedProjectID, target: target)))
    }

    private func drain(_ store: AppStore) async throws {
        let deadline = Date().addingTimeInterval(3)
        while !store.composerUploads.pending.isEmpty && Date() < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(store.composerUploads.pending.isEmpty)
    }

    private func png() throws -> Data {
        let context = try XCTUnwrap(CGContext(data: nil, width: 2, height: 2, bitsPerComponent: 8,
                                              bytesPerRow: 8, space: CGColorSpaceCreateDeviceRGB(),
                                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        let image = try XCTUnwrap(context.makeImage())
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }

    private func sources() throws -> [PhotoAttachmentFile] {
        try [("fixture.png", png()), ("fixture.pdf", Data("%PDF-1.4\n%%EOF".utf8)),
             ("fixture.txt", Data("fixture text".utf8))].map { try PhotoAttachmentFile.write($0.1, filename: $0.0) }
    }

    private func host(store: AppStore, intake: MacAttachmentIntake, router: Router) -> NSHostingView<some View> {
        let host = NSHostingView(rootView: ComposerBar(target: .constant(nil))
            .environment(store).environment(store.drafts).environment(router).environment(intake))
        host.frame = NSRect(x: 0, y: 0, width: 600, height: 160)
        host.layoutSubtreeIfNeeded()
        return host
    }

    private func editor(in view: NSView) -> MacComposerTextView.Editor? {
        if let result = view as? MacComposerTextView.Editor { return result }
        return view.subviews.lazy.compactMap { self.editor(in: $0) }.first
    }

    private func pasteboard() throws -> (NSPasteboard, [PhotoAttachmentFile]) {
        // Actual temporary Finder-style URLs: image, PDF and plain text.
        let files = try sources()
        let board = NSPasteboard.withUniqueName()
        guard board.writeObjects(files.map { $0.url as NSURL }) else {
            files.forEach { $0.cleanup() }
            board.releaseGlobally()
            throw XCTSkip("Sandbox cannot write to the AppKit pasteboard server; run this drag test outside the sandbox")
        }
        return (board, files)
    }

    func testFinderDropThroughSurfaceAndEditorReachesUploadsAndKeepsChips() async throws {
        let net = try network()
        let store = AppStore(session: net.session, persistCredentials: false)
        store.endpoint = net.endpoint.url.absoluteString; store.accessCode = "fixture-only"
        await store.connect(); store.setForeground(false)
        defer { store.disconnect() }
        XCTAssertTrue(store.uiCanWrite)
        let intake = MacAttachmentIntake()
        let host = host(store: store, intake: intake, router: Router())
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        defer { window.contentView = nil }
        try await settle()
        XCTAssertNotNil(intake.receive)
        let (board, sources) = try pasteboard()
        defer { board.releaseGlobally(); sources.forEach { $0.cleanup() } }
        let drag = FixtureDrag(board)
        let surface = MacAttachmentDropSurface.DropView()
        surface.intake = intake; surface.policy = writable
        XCTAssertEqual(surface.draggingEntered(drag), .copy)
        XCTAssertTrue(surface.performDragOperation(drag))
        try await drain(store)
        XCTAssertEqual(net.requests.filter { $0.url?.path == "/api/uploads" }.count, 3)
        let key = DraftStore.key(project: "p", target: nil)
        XCTAssertEqual(store.drafts.files(for: key).count, 3)
        let input = try XCTUnwrap(editor(in: host))
        XCTAssertEqual(input.draggingEntered(drag), .copy)
        XCTAssertTrue(input.performDragOperation(drag))
        try await drain(store)
        XCTAssertEqual(net.requests.filter { $0.url?.path == "/api/uploads" }.count, 6)
        XCTAssertEqual(store.drafts.files(for: key).count, 6)
        XCTAssertTrue(input.pasteAttachments(from: board))
        try await drain(store)
        XCTAssertEqual(net.requests.filter { $0.url?.path == "/api/uploads" }.count, 9)
        XCTAssertEqual(store.drafts.files(for: key).count, 9)
        await net.close()
    }

    func testDepartingComposerDoesNotEraseNewComposerReceiver() async throws {
        let net = try network()
        let store = AppStore(session: net.session, persistCredentials: false)
        store.endpoint = net.endpoint.url.absoluteString; store.accessCode = "fixture-only"
        await store.connect(); store.setForeground(false)
        defer { store.disconnect() }
        let intake = MacAttachmentIntake(), router = Router()
        let old = host(store: store, intake: intake, router: router)
        let replacement = host(store: store, intake: intake, router: router)
        let window = NSWindow(contentRect: old.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        let container = NSView(frame: old.frame)
        window.contentView = container
        defer { window.contentView = nil }
        container.addSubview(old)
        try await settle()
        container.addSubview(replacement)
        try await settle()
        old.removeFromSuperview()
        try await settle()
        XCTAssertNotNil(intake.receive, "The departing host must not erase the replacement's receiver")
        let (board, files) = try pasteboard()
        defer { board.releaseGlobally(); files.forEach { $0.cleanup() } }
        let surface = MacAttachmentDropSurface.DropView()
        surface.intake = intake; surface.policy = writable
        XCTAssertEqual(surface.draggingEntered(FixtureDrag(board)), .copy)
        XCTAssertTrue(surface.performDragOperation(FixtureDrag(board)), "The replacement must still receive the drop")
        try await drain(store)
        XCTAssertEqual(net.requests.filter { $0.url?.path == "/api/uploads" }.count, 3)
        XCTAssertEqual(store.drafts.files(for: DraftStore.key(project: "p", target: nil)).count, 3)
        await net.close()
    }

    func testReceiverOwnershipSurvivesNewAppearThenOldDisappear() {
        let intake = MacAttachmentIntake()
        let old = UUID(), replacement = UUID()
        var received = 0
        intake.install(owner: old) { _ in XCTFail("Old composer received the drop"); return false }
        intake.install(owner: replacement) { _ in received += 1; return true }
        intake.remove(owner: old)
        XCTAssertTrue(intake.accept([.file(URL(fileURLWithPath: "/private/tmp/fixture.txt"))], policy: writable))
        XCTAssertEqual(received, 1)
        intake.remove(owner: replacement)
        XCTAssertNil(intake.receive)
    }

    func testRealFileItemsAndPastedPixelsThroughSharedComposerPipelinePostAndStayInDraft() async throws {
        let net = try network(), store = try await connected(net)
        defer { store.disconnect() }
        let files = try sources()
        defer { files.forEach { $0.cleanup() } }
        let entries = files.map { file in
            let item = NSPasteboardItem()
            item.setString(file.url.absoluteString, forType: .fileURL)
            return item
        }
        let captured = context(store)
        let intake = MacAttachmentIntake()
        intake.install(owner: UUID()) { items in
            store.composerUploads.receive(items, context: captured, store: store)
        }
        XCTAssertTrue(intake.accept(MacAttachmentItem.read(items: entries), policy: writable))
        XCTAssertEqual(store.composerUploads.pending.count, 3, "Send must be blocked before the first suspension")
        try await drain(store)
        XCTAssertEqual(store.drafts.files(for: captured.token.key).count, 3)
        XCTAssertTrue(store.drafts.uploadFailures(for: captured.token.key).isEmpty)
        // File importer uses the very same coordinator, preserving source names and originals.
        await store.composerUploads.upload(files.map(\.url), context: captured, store: store).value
        let image = NSPasteboardItem()
        image.setData(try png(), forType: .png)
        XCTAssertTrue(intake.accept(MacAttachmentItem.read(items: [image]), policy: writable))
        try await drain(store)
        let uploads = net.requests.filter { $0.url?.path == "/api/uploads" }
        XCTAssertEqual(uploads.count, 7)
        XCTAssertTrue(uploads.allSatisfy { $0.httpMethod == "POST" && $0.url?.query == "project=p" })
        XCTAssertEqual(store.drafts.files(for: captured.token.key).count, 7)
        XCTAssertTrue(files.allSatisfy { FileManager.default.fileExists(atPath: $0.url.path) })
        await net.close()
    }

    func testClearBeforeLoadRecordsReasonInsteadOfSilentlyDroppingWholeBatch() async throws {
        let net = try network(), store = try await connected(net)
        defer { store.disconnect() }
        let captured = context(store)
        let upload = store.composerUploads.loadMedia(names: ["a.txt", "b.pdf"], context: captured, store: store) { _ in
            XCTFail("An invalidated draft must not be loaded")
            return []
        }
        store.drafts.clear(captured.token.key)
        await upload.value
        XCTAssertFalse(net.requests.contains { $0.url?.path == "/api/uploads" })
        let failures = store.drafts.uploadFailures(for: captured.token.key)
        XCTAssertEqual(failures.count, 2)
        XCTAssertTrue(failures.allSatisfy { $0.detail.contains("초안") })
        XCTAssertTrue(store.composerUploads.pending.isEmpty)
        await net.close()
    }

    func testProjectSwitchDuringPreparationRecordsFailureOnlyInOriginalDraftAndCleansCopy() async throws {
        let net = try network(), store = try await connected(net)
        defer { store.disconnect() }
        let captured = context(store)
        let prepared = try PhotoAttachmentFile.write(Data("content".utf8), filename: "prepared.txt")
        var resume: CheckedContinuation<Void, Never>?
        let upload = store.composerUploads.loadMedia(names: ["original.txt"], context: captured, store: store) { _ in
            await withCheckedContinuation { resume = $0 }
            return [prepared]
        }
        while resume == nil { await Task.yield() }
        await store.selectProject(id: "q")
        resume?.resume()
        await upload.value
        XCTAssertFalse(net.requests.contains { $0.url?.path == "/api/uploads" })
        XCTAssertFalse(FileManager.default.fileExists(atPath: prepared.url.path))
        XCTAssertTrue(store.drafts.uploadFailures(for: DraftStore.key(project: "q", target: nil)).isEmpty)
        XCTAssertEqual(store.drafts.uploadFailures(for: captured.token.key).count, 1)
        XCTAssertTrue(store.drafts.uploadFailures(for: captured.token.key)[0].detail.contains("프로젝트"))
        await net.close()
    }

    func testCancelledPreparationAndConnectionABAErrorsSurviveDraftPersistenceAndComposerReplacement() async throws {
        let saved = try PhotoAttachmentFile.write(Data(), filename: "drafts.json")
        defer { saved.cleanup() }
        try FileManager.default.removeItem(at: saved.url)
        let drafts = DraftStore(storageURL: saved.url)
        let net = try network(), store = try await connected(net, drafts: drafts)
        defer { store.disconnect() }
        let captured = context(store)
        var resume: CheckedContinuation<Void, Never>?
        let prepared = try PhotoAttachmentFile.write(Data("content".utf8), filename: "prepared.txt")
        let upload = store.composerUploads.loadMedia(names: ["original.txt"], context: captured, store: store) { _ in
            await withCheckedContinuation { resume = $0 }
            return [prepared]
        }
        while resume == nil { await Task.yield() }
        drafts.selectNamespace("other-host")
        resume?.resume()
        await upload.value
        XCTAssertTrue(drafts.uploadFailures(for: captured.token.key).isEmpty)
        drafts.selectNamespace(captured.token.namespace)
        XCTAssertFalse(drafts.isCurrentUpload(captured.token))
        XCTAssertTrue(drafts.uploadFailures(for: captured.token.key)[0].detail.contains("서버 연결"))
        let newContext = context(store)
        let cancelled = store.composerUploads.loadMedia(names: ["cancel.txt"], context: newContext, store: store) { _ in
            XCTFail("Cancelled before loading"); return []
        }
        cancelled.cancel()
        await cancelled.value
        let restored = DraftStore(namespace: captured.token.namespace, storageURL: saved.url)
        XCTAssertEqual(restored.uploadFailures(for: captured.token.key).count, 2)
        XCTAssertTrue(restored.uploadFailures(for: captured.token.key)[1].detail.contains("취소"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: prepared.url.path))
        XCTAssertFalse(net.requests.contains { $0.url?.path == "/api/uploads" })
        restored.dismissUploadFailures(for: captured.token.key)
        XCTAssertTrue(DraftStore(namespace: captured.token.namespace, storageURL: saved.url).uploadFailures(for: captured.token.key).isEmpty)
        await net.close()
    }

    func testMissingFileInvalidImageAndEmptyPreparationAllLeaveReasonsAndAllowOtherFiles() async throws {
        let net = try network(), store = try await connected(net)
        defer { store.disconnect() }
        let captured = context(store)
        let good = try PhotoAttachmentFile.write(Data("good".utf8), filename: "good.txt")
        defer { good.cleanup() }
        let missing = URL(fileURLWithPath: "/private/tmp/iamceo-missing-\(UUID()).txt")
        XCTAssertTrue(store.composerUploads.receive([.file(missing), .image(Data("bad".utf8)), .file(good.url)],
                                                    context: captured, store: store))
        try await drain(store)
        await store.composerUploads.loadMedia(names: ["empty"], context: captured, store: store) { _ in [] }.value
        XCTAssertEqual(store.drafts.uploadFailures(for: captured.token.key).count, 3)
        XCTAssertTrue(store.drafts.uploadFailures(for: captured.token.key).allSatisfy { !$0.detail.isEmpty })
        XCTAssertEqual(store.drafts.files(for: captured.token.key).count, 1)
        XCTAssertEqual(net.requests.filter { $0.url?.path == "/api/uploads" }.count, 1)
        await net.close()
    }

    func testBridgeMissingReceiverEmptyDropAndReadOnlyRejectionsAreVisibleInOriginalDraft() {
        let drafts = DraftStore(persist: false, namespace: "a")
        let token = drafts.uploadToken(for: "draft")
        let intake = MacAttachmentIntake(), owner = UUID()
        intake.install(owner: owner, receive: { _ in true }) { reason in
            drafts.failUpload(name: "첨부", token: token, detail: reason)
        }
        intake.remove(owner: owner)
        XCTAssertFalse(intake.accept([.image(Data())], policy: writable))
        XCTAssertFalse(intake.accept([], policy: writable))
        let blocked = MacAttachmentPolicy(archived: false, demo: false, connected: false, writable: false, missingTarget: false)
        XCTAssertFalse(intake.accept([.image(Data())], policy: blocked))
        XCTAssertEqual(drafts.uploadFailures(for: "draft").count, 3)
        XCTAssertTrue(drafts.uploadFailures(for: "draft")[0].detail.contains("준비"))
        XCTAssertTrue(drafts.uploadFailures(for: "draft")[1].detail.contains("읽지"))
        XCTAssertTrue(drafts.uploadFailures(for: "draft")[2].detail.contains("서버 연결"))
    }

    func testHTTPFailureLeavesReasonAndRunnerReadOnlyRejectsBeforePOST() async throws {
        let net = try network(failUploads: true), store = try await connected(net)
        defer { store.disconnect() }
        let captured = context(store)
        let file = try PhotoAttachmentFile.write(Data("good".utf8), filename: "good.txt")
        defer { file.cleanup() }
        await store.composerUploads.upload([file.url], context: captured, store: store).value
        XCTAssertEqual(net.requests.filter { $0.url?.path == "/api/uploads" }.count, 1)
        XCTAssertTrue(store.drafts.files(for: captured.token.key).isEmpty)
        XCTAssertEqual(store.drafts.uploadFailures(for: captured.token.key).count, 1)
        XCTAssertTrue(store.drafts.uploadFailures(for: captured.token.key)[0].detail.contains("fixture upload refused"))
        await net.close()

        let readOnly = try network(writable: false)
        let blocked = AppStore(session: readOnly.session, persistCredentials: false)
        blocked.endpoint = readOnly.endpoint.url.absoluteString; blocked.accessCode = "fixture-only"
        await blocked.connect(); blocked.setForeground(false)
        defer { blocked.disconnect() }
        XCTAssertFalse(blocked.uiCanWrite)
        let blockedContext = context(blocked)
        await blocked.composerUploads.upload([file.url], context: blockedContext, store: blocked).value
        XCTAssertFalse(readOnly.requests.contains { $0.url?.path == "/api/uploads" })
        XCTAssertEqual(blocked.drafts.uploadFailures(for: blockedContext.token.key).count, 1)
        XCTAssertTrue(blocked.drafts.uploadFailures(for: blockedContext.token.key)[0].detail.contains("지금은"))
        await readOnly.close()
    }
}
#endif
