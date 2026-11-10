#if os(macOS)
import AppKit
import AttachmentException
import UniformTypeIdentifiers

enum MacAttachmentReadError: LocalizedError {
    case dropped, pasted
    var errorDescription: String? {
        switch self {
        case .dropped: "끌어다 놓은 이미지를 받지 못했습니다. 저장한 뒤 첨부하거나 복사해서 붙여 넣어 주세요"
        case .pasted: "붙여 넣은 항목을 읽지 못했습니다. 파일로 저장한 뒤 첨부해 주세요"
        }
    }
}

/// AppKit and test receivers share the same synchronous, main-queue contract.
@MainActor
protocol MacFilePromiseReceiving: AnyObject {
    var fileNames: [String] { get }
    func receivePromisedFiles(atDestination destination: URL, options: [AnyHashable: Any],
                              operationQueue: OperationQueue,
                              reader: @escaping @Sendable (URL, (any Error)?) -> Void)
}

extension NSFilePromiseReceiver: MacFilePromiseReceiving {}

/// Created only while accepting a drag. Async preparation can only await its already-started result.
@MainActor
final class MacPromisedFiles {
    private struct Receipt {
        var expected: Int?
        var count = 0
        var urls: Set<URL> = []
    }
    let directory: URL
    private var receipts: [Receipt]
    private var registering = true
    private var files: [PhotoAttachmentFile] = []
    private var failure: (any Error)?
    private var result: Result<[PhotoAttachmentFile], any Error>?
    private var waiters: [CheckedContinuation<[PhotoAttachmentFile], any Error>] = []
    private var timeoutTask: Task<Void, Never>?

    init(receivers: [any MacFilePromiseReceiving], timeout: Duration = .seconds(60)) throws {
        guard !receivers.isEmpty else { throw MacAttachmentReadError.dropped }
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("iamceo-promise-\(UUID())", isDirectory: true)
        receipts = receivers.map { _ in Receipt() }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        var caughtException = false
        for (index, receiver) in receivers.enumerated() {
            // fileNames is meaningful only AFTER this call. Synchronous readers are buffered until registration ends.
            let caught = IAMCEOCatchException {
                receiver.receivePromisedFiles(atDestination: directory, options: [:], operationQueue: .main) { [self] url, error in
                    MainActor.assumeIsolated { record(url, error: error, receiver: index) }
                }
                receipts[index].expected = max(1, receiver.fileNames.count)
            }
            if caught != nil { caughtException = true }
        }
        registering = false
        if caughtException {
            finish(.failure(MacAttachmentReadError.dropped))
            throw MacAttachmentReadError.dropped
        }
        completeIfReady()
        if result == nil {
            // Keep an abandoned/incomplete receipt alive until its bounded cleanup, even if a provider drops its reader.
            timeoutTask = Task { [self] in
                do { try await Task.sleep(for: timeout) } catch { return }
                finish(.failure(MacAttachmentReadError.dropped))
            }
        }
    }

    func receivedFiles() async throws -> [PhotoAttachmentFile] {
        if let result { return try result.get() }
        return try await withCheckedThrowingContinuation { waiters.append($0) }
    }

    private func owns(_ url: URL) -> Bool {
        url.isFileURL && url.deletingLastPathComponent().standardizedFileURL == directory.standardizedFileURL
    }

    private func record(_ url: URL, error: (any Error)?, receiver index: Int) {
        // An error URL is unspecified by AppKit and must never be inspected or deleted.
        defer {
            if error == nil, owns(url) { try? FileManager.default.removeItem(at: url) }
            if result != nil { try? FileManager.default.removeItem(at: directory) }
        }
        guard result == nil else { return }
        if let expected = receipts[index].expected, receipts[index].count >= expected { return }
        if error == nil, !receipts[index].urls.insert(url.standardizedFileURL).inserted { return }
        receipts[index].count += 1
        do {
            if error != nil { throw MacAttachmentReadError.dropped }
            guard owns(url) else { throw MacAttachmentReadError.dropped }
            // Copy during AppKit's coordinated read. Async preparation never depends on a provider-owned URL.
            if !Self.isImage(url) { try PhotoAttachment.validateSize(url) }
            files.append(try PhotoAttachmentFile.copy(from: url, filename: url.lastPathComponent))
        } catch { failure = error }
        completeIfReady()
    }

    private func completeIfReady() {
        guard !registering, receipts.allSatisfy({ receipt in
            guard let expected = receipt.expected else { return false }
            return receipt.count >= expected
        }) else { return }
        if let failure { finish(.failure(failure)) }
        else { finish(.success(files)) }
    }

    private func finish(_ outcome: Result<[PhotoAttachmentFile], any Error>) {
        guard result == nil else { return }
        result = outcome
        timeoutTask?.cancel()
        timeoutTask = nil
        if case .failure = outcome { files.forEach { $0.cleanup() }; files.removeAll() }
        // This UUID directory belongs exclusively to this receipt, including partial and late provider output.
        try? FileManager.default.removeItem(at: directory)
        let pending = waiters
        waiters.removeAll()
        for waiter in pending { waiter.resume(with: outcome) }
    }

    nonisolated static func isImage(_ url: URL) -> Bool {
        ["png", "jpg", "jpeg", "tif", "tiff", "heic", "heif", "gif", "bmp"].contains(url.pathExtension.lowercased())
            || UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) == true
    }

    deinit { try? FileManager.default.removeItem(at: directory) }
}

/// One representation per pasteboard item: file > promise > pixels. Never fetch an internet URL.
@MainActor
enum MacAttachmentItem {
    case file(URL)
    case image(Data)
    case promised(MacPromisedFiles)

    static let imageTypes = [UTType.png, .jpeg, .tiff, .heic, .heif, .gif, .bmp, .image]
    static func isImageType(_ identifier: String) -> Bool {
        imageTypes.contains { $0.identifier == identifier } || UTType(identifier)?.conforms(to: .image) == true
    }

    static var pasteboardTypes: [NSPasteboard.PasteboardType] {
        [.fileURL] + imageTypes.map { .init($0.identifier) }
            + NSFilePromiseReceiver.readableDraggedTypes.map { .init($0) }
    }

    static func classify(fileURL: URL?, image: Data?) -> MacAttachmentItem? {
        if let fileURL, fileURL.isFileURL { return .file(fileURL) }
        if let image { return .image(image) }
        return nil
    }

    static func supports(_ pasteboard: NSPasteboard) -> Bool {
        var supported = false
        // Type/data discovery can invoke a pasteboard provider as well.
        if IAMCEOCatchException({
            supported = pasteboard.types?.contains {
                pasteboardTypes.contains($0) || isImageType($0.rawValue)
            } == true
        }) != nil { return true } // Consume the operation and report through the normal rejection path.
        return supported
    }

    /// Ordinary paste never constructs or calls a file-promise receiver.
    static func read(_ pasteboard: NSPasteboard) throws -> [MacAttachmentItem] {
        var items: [MacAttachmentItem] = []
        if IAMCEOCatchException({ items = readUnprotected(items: pasteboard.pasteboardItems ?? []) }) != nil {
            throw MacAttachmentReadError.pasted
        }
        return items
    }

    /// Must be called synchronously from performDragOperation, after policy/readiness checks.
    static func readDrop(_ pasteboard: NSPasteboard) throws -> [MacAttachmentItem] {
        var receivers: [NSFilePromiseReceiver] = []
        var items: [MacAttachmentItem] = []
        if IAMCEOCatchException({
            receivers = pasteboard.readObjects(forClasses: [NSFilePromiseReceiver.self]) as? [NSFilePromiseReceiver] ?? []
            let promiseTypes = NSFilePromiseReceiver.readableDraggedTypes.map { NSPasteboard.PasteboardType($0) }
            let ordinary = (pasteboard.pasteboardItems ?? []).filter { item in
                receivers.isEmpty || !item.types.contains { promiseTypes.contains($0) }
            }
            items = readUnprotected(items: ordinary)
        }) != nil { throw MacAttachmentReadError.dropped }
        if !receivers.isEmpty { items.append(.promised(try MacPromisedFiles(receivers: receivers))) }
        return items
    }

    static func read(items: [NSPasteboardItem]) throws -> [MacAttachmentItem] {
        var result: [MacAttachmentItem] = []
        if IAMCEOCatchException({ result = readUnprotected(items: items) }) != nil { throw MacAttachmentReadError.pasted }
        return result
    }

    private static func readUnprotected(items: [NSPasteboardItem]) -> [MacAttachmentItem] {
        items.compactMap { item in
            let url = item.string(forType: .fileURL).flatMap(URL.init(string:))
            if let url, url.isFileURL { return .file(url) }
            let image = item.types.filter { isImageType($0.rawValue) }.lazy.compactMap { item.data(forType: $0) }.first
            return classify(fileURL: url, image: image)
        }
    }

    var name: String {
        if case .file(let url) = self { return url.lastPathComponent }
        return "사진"
    }

    func prepare(date: Date, index: Int) async throws -> [PhotoAttachmentFile] {
        switch self {
        case .file(let url):
            guard url.isFileURL else { throw PhotoAttachmentError.unavailable }
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            try PhotoAttachment.validateSize(url)
            return [try PhotoAttachmentFile.copy(from: url, filename: url.lastPathComponent)]
        case .image(let data):
            return [try await Task.detached(priority: .userInitiated) {
                try PhotoAttachment.prepare(data: data, date: date, index: index)
            }.value]
        case .promised(let receipt):
            let sources = try await receipt.receivedFiles()
            return try await Task.detached(priority: .userInitiated) {
                var prepared: [PhotoAttachmentFile] = []
                do {
                    for source in sources {
                        if MacPromisedFiles.isImage(source.url) {
                            prepared.append(try PhotoAttachment.prepare(source: source.url, video: false, date: date,
                                                                        index: index + prepared.count))
                        } else {
                            try PhotoAttachment.validateSize(source.url)
                            prepared.append(try PhotoAttachmentFile.copy(from: source.url, filename: source.url.lastPathComponent))
                        }
                    }
                    return prepared
                } catch { prepared.forEach { $0.cleanup() }; throw error }
            }.value
        }
    }
}

struct MacAttachmentPolicy {
    let reason: String?
    var canAccept: Bool { reason == nil }

    init(archived: Bool, demo: Bool, connected: Bool, writable: Bool, missingTarget: Bool,
         composerCovered: Bool = false) {
        // Keep the shell's connected/writable arguments source-compatible. Local intake is independent of freshness;
        // the installed composer validates the selected project and upload waits for write readiness.
        reason = archived ? "보관한 프로젝트는 첨부할 수 없습니다"
            : demo ? "샘플 프로젝트는 읽기 전용입니다"
            : missingTarget ? "명부에 없는 대상에게는 첨부할 수 없습니다"
            : composerCovered ? "구성원 상세를 닫은 뒤 첨부해 주세요"
            : nil
    }
}

/// Window-local bridge. The composer captures its existing upload context synchronously at acceptance.
@MainActor
@Observable
final class MacAttachmentIntake {
    var targeted = false
    var receive: (([MacAttachmentItem]) -> Bool)?
    private var canReceive: (() -> Bool)?
    private var receiverOwner: UUID?
    private var reject: ((String) -> Void)?
    private(set) var rejection: String?
    func install(owner: UUID, canReceive: @escaping () -> Bool = { true }, receive: @escaping ([MacAttachmentItem]) -> Bool,
                 reject: ((String) -> Void)? = nil) {
        if self.reject == nil, let rejection { reject?(rejection) }
        receiverOwner = owner
        self.receive = receive
        self.canReceive = canReceive
        self.reject = reject
    }
    func remove(owner: UUID) {
        guard receiverOwner == owner else { return }
        receiverOwner = nil
        receive = nil
        canReceive = nil
        // Keep the last draft's notice sink for a drop during a view replacement gap.
    }
    func accept(_ items: [MacAttachmentItem], policy: MacAttachmentPolicy) -> Bool {
        guard preflight(policy: policy) else { return false }
        guard !items.isEmpty else { reportRejection("놓은 파일이나 이미지를 읽지 못했습니다"); return false }
        guard receive?(items) == true else {
            reportRejection("파일이나 이미지를 첨부하지 못했습니다. 입력칸의 상태를 확인해 주세요")
            return false
        }
        rejection = nil
        return true
    }
    func preflight(policy: MacAttachmentPolicy) -> Bool {
        if let reason = policy.reason { reportRejection(reason); return false }
        guard receive != nil else {
            reportRejection("입력칸을 준비 중이라 첨부하지 못했습니다. 다시 놓아 주세요")
            return false
        }
        return canReceive?() ?? true
    }
    /// The loader runs only after acceptance checks and in the caller's synchronous drag stack.
    func acceptDrop(policy: MacAttachmentPolicy, read: () throws -> [MacAttachmentItem]) -> Bool {
        guard preflight(policy: policy) else { return false }
        do { return accept(try read(), policy: policy) }
        catch { reportRejection(MacAttachmentReadError.dropped.localizedDescription); return false }
    }
    func reportRejection(_ reason: String) {
        rejection = reason
        reject?(reason)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            if self?.rejection == reason { self?.rejection = nil }
        }
    }
}
#endif
