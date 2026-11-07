#if os(macOS)
import AppKit
import UniformTypeIdentifiers

/// One representation per pasteboard item: file > promise > pixels. Never fetch an internet URL.
@MainActor
enum MacAttachmentItem {
    case file(URL)
    case image(Data)
    case promise([NSFilePromiseReceiver])

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
        pasteboard.types?.contains {
            pasteboardTypes.contains($0) || isImageType($0.rawValue)
        } == true
    }

    static func read(_ pasteboard: NSPasteboard) -> [MacAttachmentItem] {
        // Receivers retain the promise after the drag pasteboard goes away. Do not also import preview pixels.
        if let receivers = pasteboard.readObjects(forClasses: [NSFilePromiseReceiver.self]) as? [NSFilePromiseReceiver],
           !receivers.isEmpty {
            let promiseTypes = NSFilePromiseReceiver.readableDraggedTypes.map { NSPasteboard.PasteboardType($0) }
            let ordinary = (pasteboard.pasteboardItems ?? []).filter { item in
                !item.types.contains { promiseTypes.contains($0) }
            }
            return read(items: ordinary) + [.promise(receivers)]
        }
        return read(items: pasteboard.pasteboardItems ?? [])
    }

    static func read(items: [NSPasteboardItem]) -> [MacAttachmentItem] {
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
            // Finder files keep the normal file-upload behavior, including their original names.
            try PhotoAttachment.validateSize(url)
            return [try PhotoAttachmentFile.copy(from: url, filename: url.lastPathComponent)]
        case .image(let data):
            return [try await Task.detached(priority: .userInitiated) {
                try PhotoAttachment.prepare(data: data, date: date, index: index)
            }.value]
        case .promise(let receivers):
            return try await Self.receive(receivers, date: date, index: index)
        }
    }

    private static func receive(_ receivers: [NSFilePromiseReceiver], date: Date, index: Int) async throws -> [PhotoAttachmentFile] {
        guard !receivers.isEmpty else { throw PhotoAttachmentError.unavailable }
        // AppKit requires every receiver in one drag to use the same destination directory.
        let marker = try PhotoAttachmentFile.write(Data(), filename: ".receiving")
        let directory = marker.url.deletingLastPathComponent()
        defer {
            // All readers have finished. Remove partial promise output only inside our own UUID directory.
            for url in (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
                where url != marker.url {
                try? FileManager.default.removeItem(at: url)
            }
            marker.cleanup()
        }
        return try await withCheckedThrowingContinuation { continuation in
            var remaining = 0
            var files: [PhotoAttachmentFile] = []
            var failure: Error?
            for receiver in receivers {
                receiver.receivePromisedFiles(atDestination: directory, options: [:], operationQueue: .main) { url, error in
                    MainActor.assumeIsolated {
                        defer {
                            remaining -= 1
                            if remaining == 0 {
                                if let failure {
                                    files.forEach { $0.cleanup() }
                                    continuation.resume(throwing: failure)
                                } else { continuation.resume(returning: files) }
                            }
                        }
                        do {
                            // AppKit says to ignore the URL on error; it may not be an owned file at all.
                            if let error { throw error }
                            guard url.deletingLastPathComponent().standardizedFileURL == directory.standardizedFileURL else {
                                throw PhotoAttachmentError.unavailable
                            }
                            defer { try? FileManager.default.removeItem(at: url) }
                            if ["png", "jpg", "jpeg", "tif", "tiff", "heic", "heif", "gif", "bmp"].contains(url.pathExtension.lowercased())
                                || UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) == true {
                                files.append(try PhotoAttachment.prepare(source: url, video: false, date: date,
                                                                         index: index + files.count))
                            } else {
                                try PhotoAttachment.validateSize(url)
                                files.append(try PhotoAttachmentFile.copy(from: url, filename: url.lastPathComponent))
                            }
                        } catch { failure = error }
                    }
                }
                // fileNames is EMPTY until receivePromisedFiles has been called. Readers run later on .main.
                // An unsuccessful promise still calls its reader once.
                remaining += max(1, receiver.fileNames.count)
            }
        }
    }
}

struct MacAttachmentPolicy {
    let reason: String?
    var canAccept: Bool { reason == nil }

    init(archived: Bool, demo: Bool, connected: Bool, writable: Bool, missingTarget: Bool,
         composerCovered: Bool = false) {
        reason = archived ? "보관한 프로젝트는 첨부할 수 없습니다"
            : demo ? "샘플 프로젝트는 읽기 전용입니다"
            : !connected ? "서버 연결이 끊겨 첨부할 수 없습니다"
            : missingTarget ? "명부에 없는 대상에게는 첨부할 수 없습니다"
            : composerCovered ? "구성원 상세를 닫은 뒤 첨부해 주세요"
            : !writable ? "지금은 이 프로젝트에 첨부할 수 없습니다" : nil
    }
}

/// Window-local bridge. The composer captures its existing upload context synchronously at acceptance.
@MainActor
@Observable
final class MacAttachmentIntake {
    var targeted = false
    var receive: (([MacAttachmentItem]) -> Bool)?
    func accept(_ items: [MacAttachmentItem], policy: MacAttachmentPolicy) -> Bool {
        guard policy.canAccept, !items.isEmpty else { return false }
        return receive?(items) ?? false
    }
}
#endif
