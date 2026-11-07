import Foundation
import Observation
import UniformTypeIdentifiers

struct ComposerUpload: Identifiable {
    let id = UUID()
    let name: String
    let token: DraftUploadToken
}

struct ComposerUploadContext {
    let projectID: String
    let targetMemberID: String?
    let token: DraftUploadToken

    @MainActor func invalidationReason(in store: AppStore) -> String? {
        if Task.isCancelled { return "첨부 올리기를 취소했습니다" }
        if token.namespace != store.drafts.namespace || token.connectionGeneration != store.drafts.connectionGeneration {
            return "서버 연결이 바뀌어 첨부 올리기를 취소했습니다"
        }
        if projectID != store.selectedProjectID { return "프로젝트가 바뀌어 첨부 올리기를 취소했습니다" }
        if !store.drafts.isCurrentUpload(token) { return "초안이 지워지거나 바뀌어 첨부 올리기를 취소했습니다" }
        return ComposerAttachmentUploads.blockedReason(in: store, target: targetMemberID)
    }
}

/// AppStore owns transfers, rather than a transient SwiftUI composer. Both the picker and Mac intake use this path.
@MainActor @Observable
final class ComposerAttachmentUploads {
    private(set) var pending: [ComposerUpload] = []

    static func blockedReason(in store: AppStore, target: String?) -> String? {
        if store.isArchive || store.state?.project.archived == true { return "보관한 프로젝트는 첨부할 수 없습니다" }
        if store.isDemo { return "샘플 프로젝트는 읽기 전용입니다" }
        if store.connectionStatus != .connected || store.api == nil { return "서버 연결이 끊겨 첨부할 수 없습니다" }
        if store.selectedProjectID == nil { return "프로젝트를 고른 뒤 첨부해 주세요" }
        if let target, !store.members.contains(where: { $0.id == target }) { return "명부에 없는 대상에게는 첨부할 수 없습니다" }
        if !store.uiCanWrite { return "지금은 이 프로젝트에 첨부할 수 없습니다" }
        return nil
    }

    func pending(for key: String, drafts: DraftStore) -> [ComposerUpload] {
        pending.filter { $0.token.key == key && drafts.isCurrentUpload($0.token) }
    }

    /// Register the complete batch synchronously, so send stays disabled before the Task starts.
    @discardableResult
    func loadMedia(names: [String], context: ComposerUploadContext, store: AppStore,
                   load: @escaping @MainActor (Int) async throws -> [PhotoAttachmentFile]) -> Task<Void, Never> {
        let batch = names.map { ComposerUpload(name: $0, token: context.token) }
        pending.append(contentsOf: batch)
        return Task {
            defer { pending.removeAll { item in batch.contains { $0.id == item.id } } }
            for index in batch.indices {
                let item = batch[index]
                defer { pending.removeAll { $0.id == item.id } }
                do {
                    try check(context, store: store)
                    let files = try await load(index)
                    defer { files.forEach { $0.cleanup() } }
                    try check(context, store: store)
                    guard !files.isEmpty else { throw PhotoAttachmentError.unavailable }
                    for file in files {
                        try check(context, store: store)
                        try PhotoAttachment.validateSize(file.url)
                        let data = try Data(contentsOf: file.url, options: .mappedIfSafe)
                        let mime = UTType(filenameExtension: file.url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                        let attachment = await store.upload(data: data, filename: file.url.lastPathComponent, mime: mime,
                                                            targetMemberID: context.targetMemberID)
                        try check(context, store: store)
                        guard attachment != nil else {
                            throw APIError(status: 0, message: store.errorMessage ?? "첨부를 확인하지 못했습니다")
                        }
                    }
                } catch {
                    // Write to the captured host/draft even after a switch, clear, disconnect, or view replacement.
                    store.drafts.failUpload(name: item.name, token: item.token, id: item.id,
                                            detail: context.invalidationReason(in: store) ?? error.localizedDescription)
                }
            }
        }
    }

    @discardableResult
    func upload(_ urls: [URL], context: ComposerUploadContext, store: AppStore) -> Task<Void, Never> {
        loadMedia(names: urls.map(\.lastPathComponent), context: context, store: store) { index in
            let url = urls[index]
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            guard url.isFileURL else { throw PhotoAttachmentError.unavailable }
            try PhotoAttachment.validateSize(url)
            return [try PhotoAttachmentFile.copy(from: url, filename: url.lastPathComponent)]
        }
    }

    #if os(macOS)
    @discardableResult
    func receive(_ items: [MacAttachmentItem], context: ComposerUploadContext, store: AppStore) -> Bool {
        guard !items.isEmpty else {
            store.drafts.failUpload(name: "첨부", token: context.token, detail: "놓은 파일이나 이미지를 읽지 못했습니다")
            return false
        }
        if let reason = context.invalidationReason(in: store) {
            store.drafts.failUpload(name: items[0].name, token: context.token, detail: reason)
            return false
        }
        let date = Date()
        loadMedia(names: items.map(\.name), context: context, store: store) { index in
            try await items[index].prepare(date: date, index: index + 1)
        }
        return true
    }
    #endif

    private func check(_ context: ComposerUploadContext, store: AppStore) throws {
        if let reason = context.invalidationReason(in: store) { throw APIError(status: 0, message: reason) }
    }
}
