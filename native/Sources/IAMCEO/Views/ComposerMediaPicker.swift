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
