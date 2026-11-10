#if os(macOS)
import AppKit
import AttachmentException
import ImageIO
import XCTest
import UniformTypeIdentifiers
@testable import IAMCEO

@MainActor
final class MacAttachmentIntakeTests: XCTestCase {
    func testDropClassificationPrefersLocalFilesAndIgnoresRemoteURLs() throws {
        let local = URL(fileURLWithPath: "/private/tmp/example.png")
        let data = Data([1, 2, 3])
        guard case .file(let result) = MacAttachmentItem.classify(fileURL: local, image: data) else {
            return XCTFail("A preview must not duplicate its file")
        }
        XCTAssertEqual(result, local)
        XCTAssertNil(MacAttachmentItem.classify(fileURL: URL(string: "https://example.com/image.png"), image: nil))
        guard case .image(let result) = MacAttachmentItem.classify(fileURL: nil, image: data) else {
            return XCTFail("Image data should be accepted")
        }
        XCTAssertEqual(result, data)
    }

    func testPasteboardFilesImagesAndTextClassification() throws {
        let file = NSPasteboardItem()
        file.setString(URL(fileURLWithPath: "/private/tmp/a.txt").absoluteString, forType: .fileURL)
        file.setData(Data([0]), forType: .png)
        let image = NSPasteboardItem()
        image.setData(Data([1, 2]), forType: .tiff)
        let remote = NSPasteboardItem()
        remote.setString("https://example.com/a.png", forType: .URL)
        let text = NSPasteboardItem()
        text.setString("일반 글", forType: .string)
        let items = try MacAttachmentItem.read(items: [file, image, remote, text])
        XCTAssertEqual(items.count, 2)
        guard items.count == 2, case .file = items[0], case .image = items[1] else { return XCTFail("Wrong representations") }
        XCTAssertTrue(try MacAttachmentItem.read(items: [text, remote]).isEmpty, "Plain text keeps native text paste")
    }

    func testPasteAndDropAcceptEachImageFormatAndMultipleFiles() throws {
        for type in [UTType.png, .jpeg, .tiff, .heic, .heif] {
            let item = NSPasteboardItem()
            item.setData(Data([1]), forType: .init(type.identifier))
            let items = try MacAttachmentItem.read(items: [item])
            XCTAssertEqual(items.count, 1, type.identifier)
            guard let first = items.first, case .image = first else { return XCTFail(type.identifier) }
        }
        let files = ["a.txt", "b.png"].map { name in
            let item = NSPasteboardItem()
            item.setString(URL(fileURLWithPath: "/private/tmp/" + name).absoluteString, forType: .fileURL)
            return item
        }
        XCTAssertEqual(try MacAttachmentItem.read(items: files).count, 2)
    }

    func testReadOnlyReasonsRejectWithoutCallingUploader() {
        let intake = MacAttachmentIntake()
        var received = 0
        intake.receive = { _ in received += 1; return true }
        let items: [MacAttachmentItem] = [.image(Data([1]))]
        let policies = [
            MacAttachmentPolicy(archived: true, demo: false, connected: true, writable: true, missingTarget: false),
            MacAttachmentPolicy(archived: false, demo: true, connected: true, writable: true, missingTarget: false),
            MacAttachmentPolicy(archived: false, demo: false, connected: true, writable: true, missingTarget: true),
            MacAttachmentPolicy(archived: false, demo: false, connected: true, writable: true, missingTarget: false, composerCovered: true),
        ]
        for policy in policies {
            XCTAssertNotNil(policy.reason)
            XCTAssertFalse(intake.accept(items, policy: policy))
        }
        XCTAssertEqual(received, 0)
        let writable = MacAttachmentPolicy(archived: false, demo: false, connected: true, writable: true, missingTarget: false)
        XCTAssertFalse(intake.accept([], policy: writable))
        XCTAssertTrue(intake.accept(items, policy: writable))
        XCTAssertEqual(received, 1)
    }

    func testFinderFileIsCopiedAndOriginalSurvivesCleanup() async throws {
        let source = try PhotoAttachmentFile.write(Data("file content".utf8), filename: "참고.txt")
        defer { source.cleanup() }
        let files = try await MacAttachmentItem.file(source.url).prepare(date: Date(), index: 1)
        XCTAssertEqual(files.count, 1)
        let file = try XCTUnwrap(files.first)
        XCTAssertNotEqual(file.url, source.url)
        XCTAssertEqual(file.url.lastPathComponent, "참고.txt")
        XCTAssertEqual(try Data(contentsOf: file.url), Data("file content".utf8))
        file.cleanup()
        XCTAssertTrue(FileManager.default.fileExists(atPath: source.url.path))
    }

    private func checkActor() -> Int { MainActor.assumeIsolated { 42 } }

    private let writable = MacAttachmentPolicy(archived: false, demo: false, connected: false,
                                                writable: false, missingTarget: false)

    func testBothPerformDragOperationsStartEveryReceiverSynchronouslyInOneDirectory() async throws {
        for useEditor in [false, true] {
            let first = FakePromiseReceiver(names: ["a.txt"])
            let second = FakePromiseReceiver(names: ["b.txt"])
            let intake = MacAttachmentIntake()
            var accepted: [MacAttachmentItem] = []
            intake.receive = { accepted = $0; return true }
            let load: @MainActor (NSPasteboard) throws -> [MacAttachmentItem] = { _ in
                [.promised(try MacPromisedFiles(receivers: [first, second]))]
            }
            let board = NSPasteboard(name: .init("com.iamceo.attach-crash.\(UUID())"))
            defer { board.releaseGlobally() }
            let drag = PromiseFixtureDrag(board)
            let editor = MacComposerTextView.Editor()
            editor.canReceive = { true }; editor.receive = intake.receive
            editor.supportsAttachments = { _ in true }
            editor.intake = intake; editor.readDrop = load
            let surface = MacAttachmentDropSurface.DropView()
            surface.intake = intake; surface.policy = writable; surface.readDrop = load
            XCTAssertTrue(useEditor ? editor.performDragOperation(drag) : surface.performDragOperation(drag))
            XCTAssertEqual(first.calls, 1)
            XCTAssertEqual(second.calls, 1)
            XCTAssertEqual(first.destination, second.destination)
            XCTAssertTrue(first.queue === OperationQueue.main)
            XCTAssertEqual(accepted.count, 1)
            first.emit(name: "a.txt"); second.emit(name: "b.txt")
            let prepared = try await accepted[0].prepare(date: Date(), index: 1)
            XCTAssertEqual(prepared.map { $0.url.lastPathComponent }, ["a.txt", "b.txt"])
            XCTAssertEqual(first.calls, 1); XCTAssertEqual(second.calls, 1)
            prepared.forEach { $0.cleanup() }
        }
    }

    func testRejectedDropsNeverStartReceiversEvenIfPerformIsCalledDirectly() throws {
        let policies = [
            MacAttachmentPolicy(archived: true, demo: false, connected: true, writable: true, missingTarget: false),
            MacAttachmentPolicy(archived: false, demo: true, connected: true, writable: true, missingTarget: false),
            MacAttachmentPolicy(archived: false, demo: false, connected: true, writable: true, missingTarget: true),
            MacAttachmentPolicy(archived: false, demo: false, connected: true, writable: true, missingTarget: false, composerCovered: true),
        ]
        let receiver = FakePromiseReceiver(names: ["a.txt"])
        let board = NSPasteboard(name: .init("com.iamceo.attach-crash.\(UUID())"))
        defer { board.releaseGlobally() }
        let drag = PromiseFixtureDrag(board)
        let intake = MacAttachmentIntake()
        intake.receive = { _ in true }
        let surface = MacAttachmentDropSurface.DropView()
        surface.intake = intake
        surface.readDrop = { _ in [.promised(try MacPromisedFiles(receivers: [receiver]))] }
        for policy in policies { surface.policy = policy; XCTAssertFalse(surface.performDragOperation(drag)) }
        surface.policy = writable
        intake.install(owner: UUID(), canReceive: { false }, receive: { _ in true })
        XCTAssertFalse(surface.performDragOperation(drag))
        intake.receive = nil
        XCTAssertFalse(surface.performDragOperation(drag))
        let editor = MacComposerTextView.Editor()
        editor.intake = intake; editor.canReceive = { false }; editor.receive = { _ in true }
        editor.supportsAttachments = { _ in true }
        editor.readDrop = surface.readDrop
        XCTAssertFalse(editor.performDragOperation(drag))
        editor.canReceive = { true }; editor.receive = nil
        XCTAssertFalse(editor.performDragOperation(drag))
        XCTAssertEqual(receiver.calls, 0)
    }

    func testDelayedReadersUseNamesAfterReceiveAndResumeAllWaitersOnce() async throws {
        let receiver = FakePromiseReceiver(names: ["a.txt", "b.txt"])
        XCTAssertTrue(receiver.fileNames.isEmpty)
        let receipt = try MacPromisedFiles(receivers: [receiver])
        let one = Task { try await receipt.receivedFiles() }
        let two = Task { try await receipt.receivedFiles() }
        await Task.yield()
        receiver.emit(name: "a.txt")
        receiver.emit(name: "a.txt") // Duplicate must not satisfy the missing b.txt callback.
        try await Task.sleep(for: .milliseconds(10))
        XCTAssertTrue(FileManager.default.fileExists(atPath: receipt.directory.path))
        receiver.emit(name: "b.txt")
        let files = try await one.value
        let other = try await two.value
        XCTAssertEqual(files.map { $0.url.lastPathComponent }, ["a.txt", "b.txt"])
        XCTAssertEqual(other.map(\.url), files.map(\.url))
        receiver.emit(name: "b.txt") // No second continuation resume after completion.
        let repeated = try await receipt.receivedFiles()
        XCTAssertEqual(repeated.count, 2)
        files.forEach { $0.cleanup() }
        XCTAssertFalse(FileManager.default.fileExists(atPath: receipt.directory.path))
    }

    func testSynchronousReadersBeforeFileNamesAreKnownAndMinimumOneCallback() async throws {
        let first = FakePromiseReceiver(names: ["a.txt", "b.txt"])
        first.immediate = { $0.emit(name: "a.txt"); $0.emit(name: "b.txt") }
        let second = FakePromiseReceiver(names: [])
        second.immediate = { $0.emit(name: "c.txt") }
        let receipt = try MacPromisedFiles(receivers: [first, second])
        let files = try await receipt.receivedFiles()
        XCTAssertEqual(files.map { $0.url.lastPathComponent }, ["a.txt", "b.txt", "c.txt"])
        XCTAssertEqual(first.calls, 1); XCTAssertEqual(second.calls, 1)
        files.forEach { $0.cleanup() }
    }

    func testPartialReaderTimesOutAndCleansOwnedOutputOnly() async throws {
        let receiver = FakePromiseReceiver(names: ["a.txt", "b.txt"])
        let receipt = try MacPromisedFiles(receivers: [receiver], timeout: .milliseconds(20))
        receiver.emit(name: "a.txt")
        let external = try PhotoAttachmentFile.write(Data([9]), filename: "external.txt")
        defer { external.cleanup() }
        let partial = receipt.directory.appendingPathComponent("partial.txt")
        try Data([1]).write(to: partial)
        do { _ = try await receipt.receivedFiles(); XCTFail("Partial promise should time out") }
        catch { XCTAssertEqual(error.localizedDescription, MacAttachmentReadError.dropped.localizedDescription) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: receipt.directory.path))
        receiver.emit(name: "b.txt") // Late owned output is removed without resuming again.
        XCTAssertFalse(FileManager.default.fileExists(atPath: receipt.directory.path))
        receiver.callback?(external.url, nil) // Late out-of-directory output must survive.
        XCTAssertTrue(FileManager.default.fileExists(atPath: external.url.path))
        do { _ = try await receipt.receivedFiles(); XCTFail("Timeout must stay terminal") } catch {}
    }

    func testErrorURLsAndOutOfDirectoryURLsAreNeverDeleted() async throws {
        for providerError in [true, false] {
            let external = try PhotoAttachmentFile.write(Data([9]), filename: "external.txt")
            defer { external.cleanup() }
            let receiver = FakePromiseReceiver(names: ["a.txt"])
            let receipt = try MacPromisedFiles(receivers: [receiver])
            receiver.callback?(external.url, providerError ? PhotoAttachmentError.unavailable : nil)
            do { _ = try await receipt.receivedFiles(); XCTFail("Must reject provider errors and foreign URLs") } catch {}
            XCTAssertTrue(FileManager.default.fileExists(atPath: external.url.path))
        }
    }

    func testPromisedImagesUsePhotoPreparationAndOtherFilesKeepTheirNames() async throws {
        let context = try XCTUnwrap(CGContext(data: nil, width: 2, height: 2, bitsPerComponent: 8,
                                              bytesPerRow: 8, space: CGColorSpaceCreateDeviceRGB(),
                                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        let image = try XCTUnwrap(context.makeImage())
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        let receiver = FakePromiseReceiver(names: ["preview.png", "notes.txt"])
        let receipt = try MacPromisedFiles(receivers: [receiver])
        receiver.emit(name: "preview.png", data: data as Data)
        receiver.emit(name: "notes.txt")
        let date = Date(timeIntervalSince1970: 0)
        let prepared = try await MacAttachmentItem.promised(receipt).prepare(date: date, index: 3)
        defer { prepared.forEach { $0.cleanup() } }
        XCTAssertEqual(prepared.map { $0.url.lastPathComponent }, [PhotoAttachment.filename(date: date, index: 3, extension: "png"), "notes.txt"])
        XCTAssertEqual(try Data(contentsOf: prepared[0].url), data as Data)
        XCTAssertEqual(try Data(contentsOf: prepared[1].url), Data("notes.txt".utf8))
        XCTAssertEqual(receiver.calls, 1)
    }

    func testObjectiveCExceptionBecomesNSErrorAndMainActorStillWorks() async throws {
        let error = IAMCEOCatchException {
            NSException(name: .internalInconsistencyException, reason: "fixture", userInfo: nil).raise()
        }
        let caught = try XCTUnwrap(error) as NSError
        XCTAssertEqual(caught.domain, "com.iamceo.attachment.exception")
        XCTAssertEqual(caught.userInfo["exceptionName"] as? String, NSExceptionName.internalInconsistencyException.rawValue)
        let actorValue = await Task { @MainActor in checkActor() }.value
        XCTAssertEqual(actorValue, 42)
    }

    func testReceiverExceptionRejectsDropAndKeepsMainActorHealthy() async throws {
        let receiver = FakePromiseReceiver(names: ["a.txt"])
        receiver.immediate = { _ in NSException(name: .internalInconsistencyException, reason: "fixture", userInfo: nil).raise() }
        let intake = MacAttachmentIntake()
        intake.receive = { _ in XCTFail("Exception must reject attachment"); return true }
        XCTAssertFalse(intake.acceptDrop(policy: writable) { [.promised(try MacPromisedFiles(receivers: [receiver]))] })
        XCTAssertEqual(intake.rejection, MacAttachmentReadError.dropped.localizedDescription)
        XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(receiver.destination).path))
        let actorValue = await Task { @MainActor in checkActor() }.value
        XCTAssertEqual(actorValue, 42)
    }

    func testPastePromiseOnlyRejectsAndPromiseWithPixelsUsesPixels() throws {
        let item = NSPasteboardItem()
        let promiseType = NSPasteboard.PasteboardType(NSFilePromiseReceiver.readableDraggedTypes[0])
        item.setData(Data(), forType: promiseType)
        let board = NSPasteboard(name: .init("com.iamceo.attach-crash.\(UUID())"))
        defer { board.releaseGlobally() }
        let intake = MacAttachmentIntake()
        let editor = MacComposerTextView.Editor()
        editor.intake = intake; editor.canReceive = { true }
        editor.supportsAttachments = { _ in true }
        editor.readPaste = { _ in try MacAttachmentItem.read(items: [item]) }
        let receiver = FakePromiseReceiver(names: ["a.png"])
        var accepted = 0
        editor.receive = { accepted += $0.count; return true }
        editor.readDrop = { _ in
            XCTFail("Paste must never read or receive promises")
            return [.promised(try MacPromisedFiles(receivers: [receiver]))]
        }
        XCTAssertTrue(editor.pasteAttachments(from: board))
        XCTAssertEqual(accepted, 0)
        XCTAssertEqual(receiver.calls, 0)
        XCTAssertEqual(intake.rejection, MacAttachmentReadError.pasted.localizedDescription)
        let pixels = NSPasteboardItem()
        pixels.setData(Data([1, 2]), forType: .png)
        pixels.setData(Data(), forType: promiseType)
        editor.readPaste = { _ in try MacAttachmentItem.read(items: [pixels]) }
        XCTAssertTrue(editor.pasteAttachments(from: board))
        XCTAssertEqual(accepted, 1)
        let file = NSPasteboardItem()
        file.setString(URL(fileURLWithPath: "/private/tmp/paste.txt").absoluteString, forType: .fileURL)
        file.setData(Data(), forType: promiseType)
        editor.readPaste = { _ in try MacAttachmentItem.read(items: [file]) }
        XCTAssertTrue(editor.pasteAttachments(from: board))
        XCTAssertEqual(accepted, 2)
        XCTAssertEqual(receiver.calls, 0)
    }

    func testPasteboardDataExceptionIsCaughtBeforeReturningToAsyncCaller() async {
        XCTAssertThrowsError(try MacAttachmentItem.read(items: [ThrowingPromisePasteboardItem()])) { error in
            XCTAssertEqual(error.localizedDescription, MacAttachmentReadError.pasted.localizedDescription)
        }
        let actorValue = await Task { @MainActor in checkActor() }.value
        XCTAssertEqual(actorValue, 42)
    }

    private func realPromiseFixture() throws -> (PromiseProviderDelegate, NSFilePromiseProvider, NSPasteboard) {
        let delegate = PromiseProviderDelegate()
        var provider: NSFilePromiseProvider?
        var board: NSPasteboard?
        let error = IAMCEOCatchException {
            provider = NSFilePromiseProvider(fileType: UTType.png.identifier, delegate: delegate)
            board = NSPasteboard(name: .init("com.iamceo.attach-crash.\(UUID())"))
        }
        guard error == nil, let provider, let board else {
            throw XCTSkip("AppKit non-drag promise fixture unavailable: \(error?.localizedDescription ?? "no provider/pasteboard")")
        }
        return (delegate, provider, board)
    }

    func testRealAppKitNonDragPromiseFailsSafelyAndMainActorSurvives() async throws {
        let (delegate, provider, board) = try realPromiseFixture()
        defer { board.releaseGlobally() }
        var wrote = false
        let writeError = IAMCEOCatchException { wrote = board.writeObjects([provider]) }
        guard writeError == nil, wrote else { throw XCTSkip("AppKit pasteboard server rejected NSFilePromiseProvider: \(writeError?.localizedDescription ?? "write failed")") }
        var receivers: [NSFilePromiseReceiver] = []
        let error = IAMCEOCatchException {
            receivers = board.readObjects(forClasses: [NSFilePromiseReceiver.self]) as? [NSFilePromiseReceiver] ?? []
        }
        guard error == nil, !receivers.isEmpty else {
            throw XCTSkip("AppKit cannot materialize NSFilePromiseReceiver on a named non-drag pasteboard in this environment")
        }
        do {
            let receipt = try MacPromisedFiles(receivers: receivers, timeout: .milliseconds(100))
            _ = try await receipt.receivedFiles()
            XCTFail("Receiving a promise outside a drag must fail")
        } catch { XCTAssertEqual(error.localizedDescription, MacAttachmentReadError.dropped.localizedDescription) }
        let actorValue = await Task { @MainActor in checkActor() }.value
        XCTAssertEqual(actorValue, 42)
        withExtendedLifetime(delegate) {}
    }
}
@MainActor
private final class FakePromiseReceiver: MacFilePromiseReceiving {
    let names: [String]
    private var registered = false
    var fileNames: [String] { registered ? names : [] }
    var calls = 0
    var destination: URL?
    var queue: OperationQueue?
    var callback: (@Sendable (URL, (any Error)?) -> Void)?
    var immediate: ((FakePromiseReceiver) -> Void)?
    init(names: [String]) { self.names = names }
    func receivePromisedFiles(atDestination destination: URL, options: [AnyHashable: Any], operationQueue: OperationQueue,
                              reader: @escaping @Sendable (URL, (any Error)?) -> Void) {
        calls += 1; self.destination = destination; queue = operationQueue; callback = reader
        immediate?(self)
        registered = true
    }
    func emit(name: String, data: Data? = nil) {
        guard let destination else { return XCTFail("Receive was not started") }
        let url = destination.appendingPathComponent(name)
        // Late callbacks may arrive after cleanup; recreate only our test-owned directory.
        try? FileManager.default.createDirectory(at: destination, withIntermediateDirectories: false)
        do { try (data ?? Data(name.utf8)).write(to: url); callback?(url, nil) } catch { callback?(url, error) }
    }
}

private final class ThrowingPromisePasteboardItem: NSPasteboardItem {
    override func string(forType dataType: NSPasteboard.PasteboardType) -> String? {
        NSException(name: .internalInconsistencyException, reason: "fixture", userInfo: nil).raise()
        return nil
    }
}

@MainActor
private final class PromiseFixtureDrag: NSObject, @preconcurrency NSDraggingInfo {
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

private final class PromiseProviderDelegate: NSObject, NSFilePromiseProviderDelegate {
    @MainActor func filePromiseProvider(_ filePromiseProvider: NSFilePromiseProvider, fileNameForType fileType: String) -> String { "fixture.png" }
    func filePromiseProvider(_ filePromiseProvider: NSFilePromiseProvider, writePromiseTo url: URL,
                             completionHandler: @escaping ((any Error)?) -> Void) {
        do { try Data([1]).write(to: url); completionHandler(nil) } catch { completionHandler(error) }
    }
}
#endif
