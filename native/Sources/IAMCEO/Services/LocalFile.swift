import Foundation
import ImageIO
import SwiftUI

struct LocalFileInfo: Decodable, Sendable {
    let name: String
    let path: String
    let size: Int64
    let modifiedAt: String
    let mime: String
    let kind: String
    let content: String?
    var rows: [[String]]? = nil
    var previewAvailable: Bool? = nil
    var previewNote: String? = nil
}
struct LocalFilePreview: Sendable {
    let info: LocalFileInfo
    var imageData: Data? = nil
    var pdfData: Data? = nil
}

enum LocalFileLinks {
    static let scheme = "iamceo-local-file"
    static func url(_ path: String) -> URL? {
        var parts = URLComponents()
        parts.scheme = scheme; parts.host = "preview"
        parts.queryItems = [URLQueryItem(name: "path", value: path)]
        return parts.url
    }
    static func path(_ url: URL) -> String? {
        guard url.scheme == scheme, url.host == "preview" else { return nil }
        return URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "path" }?.value
    }
    // 문단마다, 토큰마다 불린다. 정규식과 확장자 집합은 한 번만 만든다.
    private static let extensions: Set<String> = Set("md markdown txt csv tsv json jsonl yaml yml html htm pdf png jpg jpeg gif webp heic mp4 mov m4v webm mp3 wav m4a zip swift ts tsx js jsx py rb sh sql css scss xml toml log c h cpp rs go java kt vue svelte xlsx docx pptx".split(separator: " ").map(String.init))
    private static let emailPattern = try! NSRegularExpression(pattern: #"^[^/\s@]+@[^/\s@]+(?:/.*)?$"#)
    private static let urlPattern = try! NSRegularExpression(pattern: #"(?:[A-Za-z][A-Za-z0-9+.-]*://|mailto:|www\.)[^\s<>\"']+"#, options: .caseInsensitive)
    private static let tokenPattern = try! NSRegularExpression(pattern: #"[^\s`<>\[\](){}\"']+"#)
    private static let trailingPunctuation = try! NSRegularExpression(pattern: #"[.,;!?，。]+$"#)

    static func isPath(_ value: String) -> Bool {
        guard !value.isEmpty, !value.contains("://"), !value.contains(":"),
              !value.contains("\n"), !value.lowercased().hasPrefix("www."), value != "/", value != "~/", !value.hasPrefix("//") else { return false }
        // Exclude email/host forms, while explicit filesystem paths may contain @.
        let explicit = value.hasPrefix("/") || value.hasPrefix("~/") || value.hasPrefix("./") || value.hasPrefix("../")
        if !explicit && value.contains("@") && emailPattern.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil { return false }
        if value.hasPrefix("/") || value.hasPrefix("~/") || value.hasPrefix("./") || value.hasPrefix("../") { return true }
        let ext = (value as NSString).pathExtension.lowercased()
        if extensions.contains(ext) { return true }
        guard value.contains("/"), !value.contains(" ") else { return false }
        let components = value.split(separator: "/", omittingEmptySubsequences: false)
        guard components.count >= 2, components.allSatisfy({ !$0.isEmpty }),
              !components.allSatisfy({ $0.allSatisfy(\.isNumber) }),
              !["and/or", "yes/no", "on/off", "n/a", "ci/cd", "입력/출력", "및/또는"].contains(value.lowercased()) else { return false }
        // Bare prose joined by a slash (especially Korean) is ambiguous; filenames and explicit paths above work.
        return components.allSatisfy { part in part.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "._-".contains($0)) } }
    }
    static func applying(to input: AttributedString) -> AttributedString {
        var result = input
        let plain = String(input.characters)
        // Code defines exact boundaries. Exclude it from prose even when it is a URL.
        let codeRanges = input.runs.filter { $0.inlinePresentationIntent?.contains(.code) == true }.map(\.range)
        for range in codeRanges {
            let value = String(input[range].characters)
            if input[range].runs.allSatisfy({ $0.link == nil }), isPath(value) {
                result[range].link = url(value)
                result[range].foregroundColor = CE.accent
                result[range].underlineStyle = .single
            }
        }
        // Reserve whole URLs before punctuation splits path candidates. Parentheses,
        // query strings and fragments can all contain path-looking substrings.
        let urlRanges = urlPattern.matches(in: plain, range: NSRange(plain.startIndex..., in: plain)).map(\.range)
        for match in tokenPattern.matches(in: plain, range: NSRange(plain.startIndex..., in: plain)) {
            if urlRanges.contains(where: { NSIntersectionRange($0, match.range).length > 0 }) { continue }
            guard let range = Range(match.range, in: plain) else { continue }
            let token = String(plain[range])
            let candidate = trailingPunctuation.stringByReplacingMatches(in: token, range: NSRange(token.startIndex..., in: token), withTemplate: "")
            guard isPath(candidate), let start = AttributedString.Index(range.lowerBound, within: result),
                  let endString = plain.index(range.lowerBound, offsetBy: candidate.count, limitedBy: range.upperBound),
                  let end = AttributedString.Index(endString, within: result) else { continue }
            let span = start..<end
            guard !codeRanges.contains(where: { $0.overlaps(span) }),
                  !result[span].runs.contains(where: { run in
                      // Only correct mailto auto-detection when its address equals
                      // the displayed text; authored links to another address survive.
                      guard let link = run.link else { return false }
                      guard link.scheme?.lowercased() == "mailto",
                            let parts = URLComponents(url: link, resolvingAgainstBaseURL: false),
                            parts.query == nil, parts.fragment == nil else { return true }
                      return parts.path != String(result[run.range].characters)
                  }) else { continue }
            result[span].link = url(candidate)
            result[span].foregroundColor = CE.accent
            result[span].underlineStyle = .single
        }
        return result
    }
}

extension APIClient {
    func localFile(projectID: String, path: String) async throws -> LocalFilePreview {
        var query = URLComponents()
        query.queryItems = [URLQueryItem(name: "path", value: path)]
        do {
            let (data, response) = try await raw("/api/projects/\(Self.segment(projectID))/local-file?\(query.percentEncodedQuery ?? "")")
            if let mime = response.value(forHTTPHeaderField: "Content-Type"),
               (mime.hasPrefix("image/") || mime.hasPrefix("application/pdf")),
               let encoded = response.value(forHTTPHeaderField: "X-Local-File-Metadata"), let metadata = Data(base64Encoded: encoded) {
                return LocalFilePreview(info: try JSONDecoder().decode(LocalFileInfo.self, from: metadata),
                                        imageData: mime.hasPrefix("image/") ? data : nil,
                                        pdfData: mime.hasPrefix("application/pdf") ? data : nil)
            }
            return LocalFilePreview(info: try JSONDecoder().decode(LocalFileInfo.self, from: data))
        } catch let error as APIError where error.status == 404 && error.code != "LOCAL_FILE_NOT_FOUND" {
            throw APIError(status: 404, message: "이 서버는 파일 보기를 지원하지 않습니다")
        }
    }
    func localFileHTML(projectID: String, path: String) async throws -> String {
        var query = URLComponents()
        query.queryItems = [URLQueryItem(name: "path", value: path), URLQueryItem(name: "render", value: "1")]
        let (data, response) = try await raw("/api/projects/\(Self.segment(projectID))/local-file?\(query.percentEncodedQuery ?? "")")
        guard response.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("text/html") == true,
              response.value(forHTTPHeaderField: "Content-Security-Policy")?.contains("sandbox allow-scripts") == true,
              let html = String(data: data, encoding: .utf8) else { throw APIError(status: 0, message: "안전한 HTML 미리보기를 받을 수 없습니다") }
        return html
    }
    func publishLocalFile(projectID: String, path: String) async throws -> FileDoc {
        struct Body: Encodable, Sendable { let path: String }
        return try await send("/api/projects/\(Self.segment(projectID))/files/from-path", body: Body(path: path))
    }
}


/// Conservative host check: paths from a remote server must never be passed to the local workspace.
enum FileHost {
    static func isLocal(_ endpoint: String) -> Bool {
        guard let host = URLComponents(string: endpoint)?.host?.lowercased() else { return false }
        return ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
    }
    static func localURL(_ path: String, endpoint: String) -> URL? {
        guard isLocal(endpoint), path.hasPrefix("/"), !path.hasPrefix("//"), !path.contains("\0") else { return nil }
        return URL(fileURLWithPath: path)
    }
}

struct FileHostConnection: Sendable {
    let api: APIClient
    let endpoint: String
    @MainActor func localURL(_ path: String, current: APIClient?) -> URL? {
        guard current === api else { return nil }
        return FileHost.localURL(path, endpoint: endpoint)
    }
    static func current(_ api: APIClient?) async -> FileHostConnection? {
        guard let api else { return nil }
        return FileHostConnection(api: api, endpoint: await api.endpoint.url.absoluteString)
    }
    /// Re-run the server's secret-path/link checks before passing a path to Finder or a local application.
    func validatedURL(path: String, projectID: String) async throws -> URL? {
        guard FileHost.isLocal(endpoint) else { return nil }
        let file: LocalFilePreview = try await api.localFile(projectID: projectID, path: path)
        return FileHost.localURL(file.info.path, endpoint: endpoint)
    }
}

enum FileTransferProgress {
    static func fraction(received: Int64, expected: Int64) -> Double? {
        expected > 0 ? min(max(Double(received) / Double(expected), 0), 1) : nil
    }
}

/// A lease keeps an evicted temporary file alive while Quick Look, a player or a share sheet is using it.
final class FileResource: Sendable {
    let api: APIClient?
    let url: URL
    let size: Int
    let memory: Data?
    init(api: APIClient?, data: Data, name: String) throws {
        self.api = api; size = data.count
        memory = data.count <= 4 * 1024 * 1024 ? data : nil
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("IAMCEO-cache-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let basename = (name as NSString).lastPathComponent
        url = folder.appendingPathComponent(basename.isEmpty || [".", ".."].contains(basename) ? "file" : basename)
        do { try data.write(to: url, options: .atomic); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path) }
        catch { try? FileManager.default.removeItem(at: folder); throw error }
    }
    init(api: APIClient, downloadedURL: URL, name: String) throws {
        self.api = api
        size = try downloadedURL.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        memory = size <= 4 * 1024 * 1024 ? try Data(contentsOf: downloadedURL) : nil
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("IAMCEO-cache-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let basename = (name as NSString).lastPathComponent
        url = folder.appendingPathComponent(basename.isEmpty || [".", ".."].contains(basename) ? "file" : basename)
        do {
            try FileManager.default.moveItem(at: downloadedURL, to: url)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch { try? FileManager.default.removeItem(at: folder); throw error }
    }
    func read() throws -> Data { try memory ?? Data(contentsOf: url) }
    deinit { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
}

@MainActor final class FileResourceCache {
    static let shared = FileResourceCache()
    struct Key: Hashable { let api: ObjectIdentifier; let path: String }
    private var entries: [Key: FileResource] = [:]
    private var order: [Key] = []
    let diskLimit: Int
    let memoryLimit: Int
    init(diskLimit: Int = 128 * 1024 * 1024, memoryLimit: Int = 32 * 1024 * 1024) {
        self.diskLimit = max(0, diskLimit); self.memoryLimit = max(0, memoryLimit)
    }
    var diskBytes: Int { entries.values.reduce(0) { $0 + $1.size } }
    var memoryBytes: Int { entries.values.reduce(0) { $0 + ($1.memory?.count ?? 0) } }
    func resource(api: APIClient, path: String) -> FileResource? {
        let key = Key(api: ObjectIdentifier(api), path: path)
        guard let value = entries[key] else { return nil }
        guard FileManager.default.fileExists(atPath: value.url.path) else {
            entries.removeValue(forKey: key); order.removeAll { $0 == key }; return nil
        }
        order.removeAll { $0 == key }; order.append(key)
        return value
    }
    func insert(_ value: FileResource, path: String) {
        guard let api = value.api else { return }
        let key = Key(api: ObjectIdentifier(api), path: path)
        order.removeAll { $0 == key }; entries[key] = value; order.append(key)
        while diskBytes > diskLimit || memoryBytes > memoryLimit || entries.count > 64 {
            entries.removeValue(forKey: order.removeFirst())
        }
    }
}

extension APIClient {
    /// Reuse the existing origin-checked header request factory; no credential is ever put into a URL.
    func attachmentDownloadRequest(_ attachment: Attachment) throws -> URLRequest {
        let url = try authorizedURL(attachment.url)
        var request = try webSocketRequest()
        request.url = url
        request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
        return request
    }
    func downloadAttachment(_ attachment: Attachment, progress: @escaping @Sendable (Double?) -> Void) async throws -> FileResource {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForResource = TransferTimeout.resource(bytes: attachment.size)
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let (url, response) = try await session.download(for: attachmentDownloadRequest(attachment), delegate: FileDownloadProgress(progress))
        defer { try? FileManager.default.removeItem(at: url) }
        try Task.checkCancellation()
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            throw APIError(status: (response as? HTTPURLResponse)?.statusCode ?? 0, message: "파일을 받지 못했습니다. 다시 시도해 주세요.")
        }
        progress(1)
        return try FileResource(api: self, downloadedURL: url, name: attachment.name)
    }
    func artifactDocument(fileID: String) async throws -> String {
        let (data, response) = try await raw("/api/files/\(Self.segment(fileID))/artifact?render=1")
        guard response.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("text/html") == true,
              response.value(forHTTPHeaderField: "Content-Security-Policy")?.contains("sandbox allow-scripts") == true,
              let html = String(data: data, encoding: .utf8) else {
            throw APIError(status: 0, message: "페이지를 안전하게 열 수 없습니다. 앱과 서버 버전을 확인해 주세요.")
        }
        return html
    }
}

private final class FileDownloadProgress: NSObject, URLSessionDownloadDelegate, Sendable {
    let report: @Sendable (Double?) -> Void
    init(_ report: @escaping @Sendable (Double?) -> Void) { self.report = report }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {}
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        report(FileTransferProgress.fraction(received: totalBytesWritten, expected: totalBytesExpectedToWrite))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor enum FileResources {
    private static var flights: [FileResourceCache.Key: Task<FileResource, any Error>] = [:]
    static func attachment(_ attachment: Attachment, api: APIClient,
                           progress: (@Sendable (Double?) -> Void)? = nil) async throws -> FileResource {
        let path = "attachment:" + attachment.url
        if let cached = FileResourceCache.shared.resource(api: api, path: path) { progress?(1); return cached }
        if let progress {
            // 진행률을 보이는 큰 파일은 여는 화면이 닫히면 받기도 함께 멈춘다.
            let resource = try await api.downloadAttachment(attachment, progress: progress)
            try Task.checkCancellation()
            FileResourceCache.shared.insert(resource, path: path)
            return resource
        }
        // 같은 첨부를 여러 행·화면이 동시에 열어도 한 번만 받는다. 받은 것은 연 쪽이 사라져도 캐시에 남는다.
        let key = FileResourceCache.Key(api: ObjectIdentifier(api), path: path)
        let flight = flights[key] ?? {
            let name = attachment.name
            let task = Task<FileResource, any Error> {
                defer { flights[key] = nil }
                let data = try await api.attachmentData(attachment)
                // 원본을 임시 파일로 쓰는 일은 메인 밖에서 한다.
                let resource = try await Task.detached(priority: .userInitiated) { try FileResource(api: api, data: data, name: name) }.value
                FileResourceCache.shared.insert(resource, path: path)
                return resource
            }
            flights[key] = task
            return task
        }()
        let resource = try await flight.value
        try Task.checkCancellation()
        return resource
    }
    static func data(_ attachment: Attachment, api: APIClient) async throws -> Data {
        try await self.attachment(attachment, api: api).read()
    }
    static func artifact(_ fileID: String, api: APIClient) async throws -> String {
        let path = "artifact:" + fileID
        if let cached = FileResourceCache.shared.resource(api: api, path: path) { return String(decoding: try cached.read(), as: UTF8.self) }
        let html = try await api.artifactDocument(fileID: fileID)
        let resource = try FileResource(api: api, data: Data(html.utf8), name: "artifact.html")
        FileResourceCache.shared.insert(resource, path: path)
        return html
    }
}


/// 미리보기용 축소 디코드. 스크린샷 한 장을 푸는 데 수십 ms가 들어 메인 밖에서 하고, 같은 원본·크기는 한 번만 푼다.
@MainActor enum PreviewImages {
    private final class Entry { let image: CGImage; init(_ image: CGImage) { self.image = image } }
    private struct Decoded: @unchecked Sendable { let image: CGImage? }
    private static let cache: NSCache<NSString, Entry> = {
        let cache = NSCache<NSString, Entry>()
        cache.countLimit = 200; cache.totalCostLimit = 96 * 1024 * 1024
        return cache
    }()

    static func image(_ resource: FileResource, maxPixel: Int) async -> CGImage? {
        // 받아 둔 원본마다 폴더가 다르다. 같은 원본이면 같은 키다.
        let key = "\(resource.url.path)|\(maxPixel)" as NSString
        if let hit = cache.object(forKey: key) { return hit.image }
        let decoded = await Task.detached(priority: .userInitiated) {
            Decoded(image: (try? resource.read()).flatMap { decode($0, maxPixel: maxPixel) })
        }.value
        guard let image = decoded.image else { return nil }
        cache.setObject(Entry(image), forKey: key, cost: image.bytesPerRow * image.height)
        return image
    }

    /// Downsampled decode so a thread full of screenshots does not hold full-size bitmaps.
    nonisolated static func decode(_ data: Data, maxPixel: Int) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }
}

/// 앱이 임시 폴더에 만든 첨부 캐시·사진 사본은 프로세스가 살아 있는 동안만 쓴다. 충돌·강제 종료로 남은 것은
/// 다음 실행 때 치운다. 지금 떠 있는 다른 실행(시험, 개발용 빌드)의 것은 건드리지 않도록 하루 넘은 것만 지운다.
enum TemporaryFiles {
    static let prefixes = ["IAMCEO-cache-", "iamceo-photo-", "iamceo-promise-", "IAMCEO-"]
    /// 지운 폴더 수를 돌려준다.
    @discardableResult static func sweepStale(in directory: URL = FileManager.default.temporaryDirectory,
                                              olderThan age: TimeInterval = 24 * 60 * 60, now: Date = Date()) -> Int {
        let manager = FileManager.default
        guard let entries = try? manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isDirectoryKey, .contentModificationDateKey],
                                                             options: [.skipsSubdirectoryDescendants]) else { return 0 }
        var removed = 0
        for entry in entries {
            let name = entry.lastPathComponent
            guard let prefix = prefixes.first(where: { name.hasPrefix($0) }),
                  // 접두 뒤가 UUID인 것만 이 앱이 만든 폴더다.
                  UUID(uuidString: String(name.dropFirst(prefix.count))) != nil,
                  let values = try? entry.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey, .contentModificationDateKey]),
                  values.isDirectory == true, values.isSymbolicLink != true,
                  let modified = values.contentModificationDate, now.timeIntervalSince(modified) >= age else { continue }
            if (try? manager.removeItem(at: entry)) != nil { removed += 1 }
        }
        return removed
    }
}

@MainActor final class FileBodyMemory {
    static let shared = FileBodyMemory()
    private var entries: [FileResourceCache.Key: (APIClient, FileDoc)] = [:]
    private var order: [FileResourceCache.Key] = []
    func get(_ id: String, api: APIClient) -> FileDoc? { entries[.init(api: ObjectIdentifier(api), path: id)]?.1 }
    func insert(_ file: FileDoc, api: APIClient) {
        let key = FileResourceCache.Key(api: ObjectIdentifier(api), path: file.id)
        entries[key] = (api, file); order.removeAll { $0 == key }; order.append(key)
        while entries.count > 32 || entries.values.reduce(0, { $0 + $1.1.body.utf8.count }) > 32 * 1024 * 1024 {
            entries.removeValue(forKey: order.removeFirst())
        }
    }
}
