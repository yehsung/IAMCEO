import Foundation
import UniformTypeIdentifiers
#if os(iOS)
import SwiftUI
import PhotosUI
import CoreTransferable
import UniformTypeIdentifiers
import UIKit

/// A provider URL is valid only during the import callback; copy it before returning.
struct ComposerPickedMedia: Transferable, Sendable {
    let file: PhotoAttachmentFile
    let video: Bool

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in
            let ext = received.file.pathExtension
            return Self(file: try PhotoAttachmentFile.copy(from: received.file, filename: "original.\(ext)"), video: false)
        }
        FileRepresentation(importedContentType: .movie) { received in
            try PhotoAttachment.validateSize(received.file)
            let ext = received.file.pathExtension.lowercased()
            return Self(file: try PhotoAttachmentFile.copy(from: received.file,
                filename: "original.\(ext == "mp4" ? "mp4" : "mov")"), video: true)
        }
    }
}

struct ComposerCameraPicker: UIViewControllerRepresentable {
    var onResult: (Result<Data, Error>?) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onResult: onResult) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.mediaTypes = [UTType.image.identifier]
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onResult: (Result<Data, Error>?) -> Void
        init(onResult: @escaping (Result<Data, Error>?) -> Void) { self.onResult = onResult }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { onResult(nil) }

        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            // Do not attach the capture's mediaMetadata dictionary (which may contain GPS).
            guard let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 1) else {
                onResult(.failure(PhotoAttachmentError.invalidImage))
                return
            }
            onResult(.success(data))
        }
    }
}
#endif

/// Shared provider loader, so iPhone paste intake is regression-tested without a system clipboard.
/// PasteButton grants access only after a deliberate paste. Providers are copied inside their URL callback.
@MainActor
enum ComposerPasteIntake {
    static let contentTypes: [UTType] = [.fileURL, .image, .pdf, .archive, .audio, .movie, .spreadsheet, .presentation]

    #if os(iOS)
    /// Whether the clipboard holds something the composer can attach. A type check only: it reads no content and
    /// shows no paste prompt, so the composer can offer 붙여넣기 just when it would do something.
    static var clipboardHasAttachment: Bool {
        UIPasteboard.general.contains(pasteboardTypes: contentTypes.map(\.identifier), inItemSet: nil)
    }
    #endif

    static func receive(_ providers: [NSItemProvider], context: ComposerUploadContext, store: AppStore) {
        let date = Date()
        store.composerUploads.loadMedia(names: providers.enumerated().map {
            $0.element.suggestedName ?? String(localized: "붙여넣은 첨부 \($0.offset + 1)")
        }, context: context, store: store) { index in
            let provider = providers[index]
            let original = try await copy(provider)
            defer { original.cleanup() }
            if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                return try await Task.detached(priority: .userInitiated) {
                    [try PhotoAttachment.prepare(source: original.url, video: false, date: date, index: index + 1)]
                }.value
            }
            return [try PhotoAttachmentFile.copy(from: original.url, filename: original.url.lastPathComponent)]
        }
    }

    static func copy(_ provider: NSItemProvider) async throws -> PhotoAttachmentFile {
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            return try await withCheckedThrowingContinuation { continuation in
                provider.loadObject(ofClass: NSURL.self) { item, error in
                    do {
                        if let error { throw error }
                        guard let url = item as? URL, url.isFileURL else { throw PhotoAttachmentError.unavailable }
                        let access = url.startAccessingSecurityScopedResource()
                        defer { if access { url.stopAccessingSecurityScopedResource() } }
                        try PhotoAttachment.validateSize(url)
                        continuation.resume(returning: try PhotoAttachmentFile.copy(from: url, filename: url.lastPathComponent))
                    } catch { continuation.resume(throwing: error) }
                }
            }
        }
        guard let identifier = provider.registeredTypeIdentifiers.first(where: {
            UTType($0)?.conforms(to: .image) == true
        }) ?? provider.registeredTypeIdentifiers.first(where: {
            UTType($0)?.conforms(to: .data) == true && UTType($0)?.conforms(to: .text) != true
        }) else { throw PhotoAttachmentError.unavailable }
        do {
            return try await withCheckedThrowingContinuation { continuation in
                provider.loadFileRepresentation(forTypeIdentifier: identifier) { url, error in
                    do {
                        if let error { throw error }
                        guard let url, url.isFileURL else { throw PhotoAttachmentError.unavailable }
                        try PhotoAttachment.validateSize(url)
                        continuation.resume(returning: try PhotoAttachmentFile.copy(from: url, filename: url.lastPathComponent))
                    } catch { continuation.resume(throwing: error) }
                }
            }
        } catch {
            // Pixel-only paste providers can offer data without a file representation.
            let name = provider.suggestedName.map { URL(fileURLWithPath: $0).lastPathComponent } ?? String(localized: "붙여넣은 파일")
            let filename = URL(fileURLWithPath: name).pathExtension.isEmpty
                ? name + "." + (UTType(identifier)?.preferredFilenameExtension ?? "bin") : name
            return try await withCheckedThrowingContinuation { continuation in
                provider.loadDataRepresentation(forTypeIdentifier: identifier) { data, error in
                    do {
                        if let error { throw error }
                        guard let data else { throw PhotoAttachmentError.unavailable }
                        guard data.count <= PhotoAttachment.maximumBytes else { throw PhotoAttachmentError.tooLarge }
                        continuation.resume(returning: try PhotoAttachmentFile.write(data, filename: filename))
                    } catch { continuation.resume(throwing: error) }
                }
            }
        }
    }
}
