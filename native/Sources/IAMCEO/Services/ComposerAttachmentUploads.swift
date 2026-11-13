import Foundation
import Observation
import UniformTypeIdentifiers

struct ComposerUpload: Identifiable {
    let id: UUID
    let name: String
    let token: DraftUploadToken
    let sourceID: String?
    var progress: Double? = nil
    var waiting = false
}

struct ComposerUploadContext {
    let projectID: String
    let targetMemberID: String?
    let token: DraftUploadToken

    @MainActor func invalidationReason(in store: AppStore) -> String? {
        if Task.isCancelled { return String(localized: "첨부 올리기를 취소했습니다") }
        if token.namespace != store.drafts.namespace || token.connectionGeneration != store.drafts.connectionGeneration {
            return String(localized: "서버 연결이 바뀌어 첨부 올리기를 취소했습니다")
        }
        if projectID != store.selectedProjectID { return String(localized: "프로젝트가 바뀌어 첨부 올리기를 취소했습니다") }
        if !store.drafts.isCurrentUpload(token) { return String(localized: "초안이 지워지거나 바뀌어 첨부 올리기를 취소했습니다") }
        return ComposerAttachmentUploads.blockedReason(in: store, target: targetMemberID)
    }
}

/// Each transfer owns its retained local copy. Reconnection resumes uploads only, never message submission.
@MainActor @Observable
final class ComposerAttachmentUploads {
    private(set) var pending: [ComposerUpload] = []
    private(set) var notice: String?
    @ObservationIgnored var sessionConfiguration: URLSessionConfiguration?
    @ObservationIgnored private var noticeID = UUID()
    @ObservationIgnored private var tasks: [UUID: Task<Void, Never>] = [:]
    @ObservationIgnored private var taskVersions: [UUID: UUID] = [:]
    private struct Retained {
        let file: PhotoAttachmentFile
        let context: ComposerUploadContext
        let sourceID: String?
    }
    @ObservationIgnored private var retained: [UUID: Retained] = [:]

    /// Local intake does not require network freshness or an active runner.
    static func blockedReason(in store: AppStore, target: String?) -> String? {
        if store.isArchive || store.state?.project.archived == true { return String(localized: "보관한 프로젝트는 첨부할 수 없습니다") }
        if store.selectedProjectID == nil { return String(localized: "프로젝트를 고른 뒤 첨부해 주세요") }
        if let target, store.state != nil, !store.members.contains(where: { $0.id == target }) { return String(localized: "명부에 없는 대상에게는 첨부할 수 없습니다") }
        return nil
    }

    func reportRejection(_ detail: String) {
        let id = UUID()
        noticeID = id
        notice = friendlyError(detail)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            if self?.noticeID == id { self?.notice = nil }
        }
    }

    func pending(for key: String, drafts: DraftStore) -> [ComposerUpload] {
        pending.filter { $0.token.key == key && drafts.isCurrentUpload($0.token) }
    }

    func canRetry(_ id: UUID, store: AppStore) -> Bool {
        guard let item = retained[id], tasks[id] == nil else { return false }
        return item.context.invalidationReason(in: store) == nil
    }

    func cancel(_ id: UUID, drafts: DraftStore) {
        tasks[id]?.cancel()
        tasks.removeValue(forKey: id)
        taskVersions.removeValue(forKey: id)
        retained.removeValue(forKey: id)
        pending.removeAll { $0.id == id }
        drafts.dismissUploadFailure(id)
    }

    @discardableResult
    func retry(_ id: UUID, store: AppStore) -> Task<Void, Never>? {
        guard let item = retained[id], tasks[id] == nil,
              item.context.invalidationReason(in: store) == nil else { return nil }
        store.drafts.dismissUploadFailure(id)
        return start(id: id, item: item, store: store)
    }

    /// Register all selected items synchronously, before any asynchronous provider work.
    @discardableResult
    func loadMedia(names: [String], sourceIDs: [String?] = [], context: ComposerUploadContext, store: AppStore,
                   load: @escaping @MainActor (Int) async throws -> [PhotoAttachmentFile]) -> Task<Void, Never> {
        let batch = names.enumerated().map { index, name in
            ComposerUpload(id: UUID(), name: name, token: context.token,
                           sourceID: sourceIDs.indices.contains(index) ? sourceIDs[index] : nil)
        }
        pending.append(contentsOf: batch)
        return Task {
            for index in batch.indices {
                if Task.isCancelled {
                    pending.removeAll { item in batch.contains { $0.id == item.id } }
                    break
                }
                let item = batch[index]
                guard pending.contains(where: { $0.id == item.id }) else { continue }
                let version = UUID()
                taskVersions[item.id] = version
                let preparation = Task { @MainActor in
                    defer {
                        if taskVersions[item.id] == version {
                            pending.removeAll { $0.id == item.id }
                            tasks.removeValue(forKey: item.id)
                            taskVersions.removeValue(forKey: item.id)
                        }
                    }
                    do {
                        try check(context, store: store)
                        let files = try await load(index)
                        defer { files.forEach { $0.cleanup() } }
                        try Task.checkCancellation()
                        guard !files.isEmpty else { throw PhotoAttachmentError.unavailable }
                        for file in files {
                            try Task.checkCancellation()
                            let id = files.count == 1 ? item.id : UUID()
                            let sourceID = files.count == 1 ? item.sourceID : nil
                            // Never retain the provider's URL. Failed uploads keep an app-owned retry copy.
                            let copy = try PhotoAttachmentFile.copy(from: file.url, filename: file.url.lastPathComponent)
                            let saved = Retained(file: copy, context: context, sourceID: sourceID)
                            retained[id] = saved
                            let transfer = start(id: id, item: saved, store: store)
                            await withTaskCancellationHandler { await transfer.value } onCancel: { transfer.cancel() }
                        }
                    } catch {
                        if !Task.isCancelled { reportRejection(friendlyLoadError(error, what: "첨부", verb: "읽지")) }
                    }
                }
                tasks[item.id] = preparation
                await withTaskCancellationHandler { await preparation.value } onCancel: { preparation.cancel() }
            }
        }
    }

    private func start(id: UUID, item: Retained, store: AppStore) -> Task<Void, Never> {
        let upload = ComposerUpload(id: id, name: item.file.url.lastPathComponent, token: item.context.token, sourceID: item.sourceID)
        if let index = pending.firstIndex(where: { $0.id == id }) { pending[index] = upload }
        else { pending.append(upload) }
        let version = UUID()
        taskVersions[id] = version
        let task = Task { @MainActor in
            var beganUpload = false
            defer {
                if taskVersions[id] == version {
                    pending.removeAll { $0.id == id }
                    tasks.removeValue(forKey: id)
                    taskVersions.removeValue(forKey: id)
                }
            }
            do {
                try check(item.context, store: store)
                try PhotoAttachment.validateSize(item.file.url)
                while !store.uiCanWrite || store.api == nil {
                    update(id) { $0.waiting = true }
                    try await Task.sleep(for: .milliseconds(250))
                    try check(item.context, store: store)
                }
                try check(item.context, store: store)
                guard let api = store.api else { throw URLError(.notConnectedToInternet) }
                let data = try Data(contentsOf: item.file.url, options: .mappedIfSafe)
                let mime = UTType(filenameExtension: item.file.url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                let (request, body) = try await Self.request(api: api, data: data, filename: item.file.url.lastPathComponent,
                                                           mime: mime, projectID: item.context.projectID, target: item.context.targetMemberID)
                try check(item.context, store: store)
                // Readiness can change while the API actor constructs the authenticated request.
                while !store.uiCanWrite {
                    update(id) { $0.waiting = true }
                    try await Task.sleep(for: .milliseconds(250))
                    try check(item.context, store: store)
                }
                guard store.api === api else { throw CancellationError() }
                beganUpload = true
                update(id) { $0.waiting = false; $0.progress = 0 }
                let file = try await ComposerUploadTransport.upload(request: request, body: body, configuration: sessionConfiguration) { [weak self] value in
                    Task { @MainActor [weak self] in
                        guard let self, self.taskVersions[id] == version else { return }
                        self.update(id) { $0.progress = value }
                    }
                }
                try check(item.context, store: store)
                guard store.drafts.completeUpload(file, token: item.context.token) else { throw CancellationError() }
                store.drafts.dismissUploadFailure(id)
                store.drafts.resolveUploadFailures(sourceID: item.sourceID, token: item.context.token)
                if let sourceID = item.sourceID {
                    let resolved = retained.filter {
                        $0.value.sourceID == sourceID && $0.value.context.token.namespace == item.context.token.namespace
                            && $0.value.context.token.key == item.context.token.key && tasks[$0.key] == nil
                    }.map(\.key)
                    for previous in resolved { retained.removeValue(forKey: previous) }
                }
                retained.removeValue(forKey: id)
            } catch {
                if Task.isCancelled {
                    retained.removeValue(forKey: id)
                } else if beganUpload {
                    store.drafts.failUpload(name: item.file.url.lastPathComponent, token: item.context.token, id: id,
                        sourceID: item.sourceID, detail: item.context.invalidationReason(in: store)
                            ?? friendlyLoadError(error, what: "첨부", verb: "올리지"))
                } else {
                    retained.removeValue(forKey: id)
                    reportRejection(item.context.invalidationReason(in: store) ?? friendlyLoadError(error, what: "첨부", verb: "읽지"))
                }
            }
        }
        tasks[id] = task
        return task
    }

    private func update(_ id: UUID, change: (inout ComposerUpload) -> Void) {
        if let index = pending.firstIndex(where: { $0.id == id }) { change(&pending[index]) }
    }

    static func request(api: APIClient, data: Data, filename: String, mime: String, projectID: String,
                        target: String?) async throws -> (URLRequest, Data) {
        guard data.count <= PhotoAttachment.maximumBytes else { throw PhotoAttachmentError.tooLarge }
        let boundary = "IAMCEO-\(UUID())"
        let name = filename.replacingOccurrences(of: "\"", with: "_").replacingOccurrences(of: "\r", with: "_").replacingOccurrences(of: "\n", with: "_")
        // Accept only bare ASCII type/subtype names; CRLF can be a single Swift Character.
        let mimePattern = #"\A[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\z"#
        let type = mime.range(of: mimePattern, options: .regularExpression) != nil ? mime : "application/octet-stream"
        var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\nContent-Type: \(type)\r\n\r\n".utf8)
        body.append(data)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        var path = "/api/uploads?project=\(APIClient.segment(projectID))"
        if let target { path += "&target=\(APIClient.segment(target))" }
        // Reuse the API client's proven credential header; never read mutable settings or put a code in a URL.
        var request = try await api.webSocketRequest()
        request.url = try await api.authorizedURL(path)
        request.httpMethod = "POST"
        request.timeoutInterval = 150
        request.httpShouldHandleCookies = false
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        return (request, body)
    }

    @discardableResult
    func upload(_ urls: [URL], context: ComposerUploadContext, store: AppStore) -> Task<Void, Never> {
        loadMedia(names: urls.map(\.lastPathComponent), sourceIDs: urls.map { "file:\($0.standardizedFileURL.absoluteString)" },
                  context: context, store: store) { index in
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
        guard !items.isEmpty else { reportRejection(String(localized: "놓은 파일이나 이미지를 읽지 못했습니다")); return false }
        if let reason = context.invalidationReason(in: store) { reportRejection(reason); return false }
        let date = Date()
        loadMedia(names: items.map(\.name), sourceIDs: items.map {
            if case .file(let url) = $0 { return "file:\(url.standardizedFileURL.absoluteString)" }
            return nil
        }, context: context, store: store) { index in
            try await items[index].prepare(date: date, index: index + 1)
        }
        return true
    }
    #endif

    private func check(_ context: ComposerUploadContext, store: AppStore) throws {
        if let reason = context.invalidationReason(in: store) { throw APIError(status: 0, message: reason) }
    }
}

/// 전송 전체 상한을 크기에 맞춘다. 고정 160초면 느린 연결에서 큰 파일은 몇 번을 다시 보내도 같은 자리에서 끊긴다.
/// 멈춘 연결은 요청의 무응답 제한이 따로 끊는다.
enum TransferTimeout {
    static func resource(bytes: Int) -> TimeInterval {
        max(160, Double(max(0, bytes)) / (64 * 1024) + 60) // 초당 64KB 는 나온다고 본다: 50MB 면 약 14분
    }
}

/// URLSession reports bytes actually written. Redirects are always refused, including same-origin redirects.
final class ComposerUploadTransport: NSObject, URLSessionTaskDelegate, Sendable {
    let progress: @Sendable (Double) -> Void
    init(progress: @escaping @Sendable (Double) -> Void) { self.progress = progress }
    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                    totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard totalBytesExpectedToSend > 0 else { return }
        progress(min(1, max(0, Double(totalBytesSent) / Double(totalBytesExpectedToSend))))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
    static func upload(request: URLRequest, body: Data, configuration: URLSessionConfiguration? = nil, progress: @escaping @Sendable (Double) -> Void) async throws -> Attachment {
        let configuration = (configuration?.copy() as? URLSessionConfiguration) ?? URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForResource = TransferTimeout.resource(bytes: body.count)
        let session = URLSession(configuration: configuration, delegate: ComposerUploadTransport(progress: progress), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.upload(for: request, from: body)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError(status: http.statusCode, message: String(localized: "첨부를 올리지 못했습니다"))
        }
        return try JSONDecoder().decode(Attachment.self, from: data)
    }
}
