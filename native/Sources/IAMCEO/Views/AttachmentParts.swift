import SwiftUI
import UniformTypeIdentifiers
#if os(iOS)
import PhotosUI
import AVFoundation
import UIKit
#endif

// 0.2.7: 대화 입력칸의 첨부 부품(첨부 단추·칩·올리기)을 다른 입력에서도 그대로 쓴다. 결재 답의 첨부(D3-4)가 처음 쓰는 곳이다.
// 올리기·재시도·취소는 대화 입력칸과 같은 ComposerAttachmentUploads 가, 올린 첨부는 DraftStore 가 열쇠(key)별로 맡는다.

/// 결재 답 첨부의 초안 열쇠. 대화 초안의 열쇠(DraftStore.key: 길이 접두사)와 겹치지 않는다. 메모처럼 이 기기에 남는다.
enum DecisionAnswerDraft {
    static func key(_ decisionID: String) -> String { "decision-answer:\(decisionID)" }
}

/// 한 초안의 첨부 칩: 올린 첨부(빼기), 올리는 중(취소), 실패(다시 올리기·빼기). 대화 입력칸의 칩과 같은 모양이다.
struct DraftAttachmentChips: View {
    @Environment(AppStore.self) private var store
    @Environment(DraftStore.self) private var drafts
    let key: String

    var body: some View {
        ForEach(drafts.files(for: key)) { fileChip($0) }
        ForEach(store.composerUploads.pending(for: key, drafts: drafts)) { uploadingChip($0) }
        ForEach(drafts.uploadFailures(for: key)) { failedUploadChip($0) }
    }

    /// web .cmp-chip--file: 28 tall, 12.5/500, an image shows a 20pt round thumbnail at −5, max 260 wide, and the
    /// 28pt round × sits flush at the trailing end.
    private func fileChip(_ file: Attachment) -> some View {
        HStack(spacing: 6) {
            if file.isImage {
                ComposerChipThumb(file: file).padding(.leading, -5)
            } else {
                Image(systemName: "doc").font(.system(size: 10.5, weight: .semibold)).foregroundStyle(CE.ink2)
            }
            Text(file.name).lineLimit(1).truncationMode(.middle).frame(maxWidth: 200, alignment: .leading)
            Button { drafts.removeFile(file.id, for: key) } label: {
                Image(systemName: "xmark").font(.system(size: 8.5, weight: .bold))
            }
            .buttonStyle(ChipRemoveStyle())
            .accessibilityLabel("\(file.name) 빼기")
        }
        .font(CEFont.meta.weight(.medium))
        .foregroundStyle(CE.ink)
        .padding(.leading, 9).frame(height: 28)
        .background(Color.white.opacity(0.08), in: Capsule())
        .overlay { Capsule().strokeBorder(Color.white.opacity(0.1)) }
        .help(file.name)
    }

    private func uploadingChip(_ upload: ComposerUpload) -> some View {
        HStack(spacing: 6) {
            ProgressView().controlSize(.mini)
            Text(upload.name).lineLimit(1).truncationMode(.middle).frame(maxWidth: 160, alignment: .leading)
            // web .cmp-chip__state: regular weight, ink-2.
            Text(upload.waiting ? "연결 뒤 올림" : upload.progress.map { "\(Int($0 * 100))%" } ?? "준비 중")
                .fontWeight(.regular).foregroundStyle(CE.ink2)
            Button { store.composerUploads.cancel(upload.id, drafts: drafts) } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(ChipRemoveStyle()).accessibilityLabel("\(upload.name) 올리기 취소")
        }
        .font(CEFont.meta.weight(.medium))
        .foregroundStyle(CE.ink)
        .padding(.horizontal, 9).frame(height: 28)
        .background(Color.white.opacity(0.08), in: Capsule())
        .overlay { Capsule().strokeBorder(Color.white.opacity(0.1)) }
        .accessibilityElement(children: .combine)
    }

    private func failedUploadChip(_ failure: DraftUploadFailure) -> some View {
        HStack(spacing: 6) {
            Text(failure.name).lineLimit(1).truncationMode(.middle)
            Text("실패").foregroundStyle(CE.danger)
            if store.composerUploads.canRetry(failure.id, store: store) {
                Button("다시 올리기") { store.composerUploads.retry(failure.id, store: store) }
                    .buttonStyle(.plain).foregroundStyle(CE.accent)
            }
            Button { store.composerUploads.cancel(failure.id, drafts: drafts) } label: { Image(systemName: "xmark") }
                .buttonStyle(ChipRemoveStyle()).accessibilityLabel("\(failure.name) 빼기")
        }
        .font(CEFont.meta).padding(.leading, 9).frame(height: 28)
        .background(Color.white.opacity(0.08), in: Capsule())
        .help(friendlyLoadError(APIError(status: 0, message: failure.detail), what: "첨부", verb: "올리지"))
    }
}

/// 대화 입력칸과 같은 44pt 클립 단추. iPhone 은 사진 보관함·사진 찍기·파일, Mac 은 파일. 50MB 까지.
/// context 는 누를 때마다 다시 묻는다(초안 세대·연결이 바뀌면 nil, 까닭은 그쪽이 알린다).
struct AttachmentPickerButton: View {
    @Environment(AppStore.self) private var store
    let context: () -> ComposerUploadContext?
    @State private var importing = false
    @State private var importContext: ComposerUploadContext?
    #if os(iOS)
    @State private var choosingPhotos = false
    @State private var photoSelection: [PhotosPickerItem] = []
    @State private var photoContext: ComposerUploadContext?
    @State private var takingPhoto = false
    @State private var cameraContext: ComposerUploadContext?
    #endif

    private var icon: some View {
        Image(systemName: "paperclip").font(.system(size: 17)).frame(width: 44, height: 44)
    }

    var body: some View {
        button
            .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                switch result {
                case .success(let urls):
                    if let importContext { _ = store.composerUploads.upload(urls, context: importContext, store: store) }
                    else if !urls.isEmpty { store.composerUploads.reportRejection(String(localized: "파일을 받을 초안을 확인하지 못했습니다")) }
                case .failure(let error): store.composerUploads.reportRejection(friendlyLoadError(error, what: "첨부", verb: "받지"))
                }
            }
            #if os(iOS)
            .photosPicker(isPresented: $choosingPhotos, selection: $photoSelection, maxSelectionCount: 10,
                          selectionBehavior: .ordered, matching: .any(of: [.images, .videos]), preferredItemEncoding: .current)
            .onChange(of: photoSelection) { _, items in
                guard !items.isEmpty else { return }
                photoSelection = []
                guard let photoContext else { store.composerUploads.reportRejection(String(localized: "사진을 받을 초안을 확인하지 못했습니다")); return }
                store.composerUploads.loadPhotos(items, context: photoContext, store: store)
            }
            .fullScreenCover(isPresented: $takingPhoto) {
                ComposerCameraPicker { result in
                    takingPhoto = false
                    guard let result, let cameraContext else { return }
                    store.composerUploads.loadCameraPhoto(result, context: cameraContext, store: store)
                }
                .ignoresSafeArea()
            }
            #endif
    }

    @ViewBuilder private var button: some View {
        #if os(iOS)
        Menu {
            Button {
                photoContext = context()
                choosingPhotos = photoContext != nil
            } label: { Label("사진 보관함", systemImage: "photo.on.rectangle") }
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button { openCamera() } label: { Label("사진 찍기", systemImage: "camera") }
            }
            Button { importContext = context(); importing = importContext != nil } label: {
                Label("파일", systemImage: "folder")
            }
        } label: { icon }
        .menuStyle(.button)
        .menuOrder(.fixed)
        .menuIndicator(.hidden)
        .buttonStyle(ComposerGhostStyle())
        .help("첨부 (50MB까지)")
        .accessibilityLabel("첨부")
        #else
        Button { importContext = context(); importing = importContext != nil } label: { icon }
            .buttonStyle(ComposerGhostStyle())
            .help("첨부 (50MB까지)")
            .accessibilityLabel("첨부")
        #endif
    }

    #if os(iOS)
    private func openCamera() {
        guard let context = context() else { return }
        Task {
            guard await AVCaptureDevice.requestAccess(for: .video) else {
                store.composerUploads.reportRejection(String(localized: "설정에서 카메라 접근을 허용해 주세요"))
                return
            }
            guard context.invalidationReason(in: store) == nil else { return }
            cameraContext = context
            takingPhoto = true
        }
    }
    #endif
}

#if os(iOS)
extension ComposerAttachmentUploads {
    /// 사진 보관함에서 고른 사진·영상을 올린다(대화 입력칸에서 옮겨 왔다. 동작은 그대로다).
    func loadPhotos(_ items: [PhotosPickerItem], context: ComposerUploadContext, store: AppStore) {
        let date = Date()
        let names = items.enumerated().map { index, item in
            PhotoAttachment.filename(date: date, index: index + 1, extension: item.supportedContentTypes.contains {
                $0.conforms(to: .movie)
            } ? "mov" : "jpg", video: item.supportedContentTypes.contains { $0.conforms(to: .movie) })
        }
        _ = loadMedia(names: names, context: context, store: store) { index in
            guard let media = try await items[index].loadTransferable(type: ComposerPickedMedia.self) else {
                throw PhotoAttachmentError.unavailable
            }
            defer { media.file.cleanup() }
            return try await Task.detached(priority: .userInitiated) {
                [try PhotoAttachment.prepare(source: media.file.url, video: media.video, date: date, index: index + 1)]
            }.value
        }
    }

    /// 방금 찍은 사진을 올린다(대화 입력칸에서 옮겨 왔다. 동작은 그대로다).
    func loadCameraPhoto(_ result: Result<Data, Error>, context: ComposerUploadContext, store: AppStore) {
        let date = Date()
        _ = loadMedia(names: [PhotoAttachment.filename(date: date, index: 1, extension: "jpg")], context: context, store: store) { _ in
            let data = try result.get()
            return try await Task.detached(priority: .userInitiated) {
                let original = try PhotoAttachmentFile.write(data, filename: "capture.jpg")
                defer { original.cleanup() }
                return [try PhotoAttachment.prepare(source: original.url, video: false, date: date, index: 1, forceJPEG: true)]
            }.value
        }
    }
}
#endif
