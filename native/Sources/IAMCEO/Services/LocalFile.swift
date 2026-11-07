import Foundation
import SwiftUI

struct LocalFileInfo: Decodable, Sendable {
    let name: String
    let path: String
    let size: Int64
    let modifiedAt: String
    let mime: String
    let kind: String
    let content: String?
}
struct LocalFilePreview: Sendable {
    let info: LocalFileInfo
    var imageData: Data? = nil
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
    static func isPath(_ value: String) -> Bool {
        guard !value.isEmpty, !value.contains("://"), !value.contains(":"),
              !value.contains("\n"), !value.lowercased().hasPrefix("www."), value != "/", value != "~/", !value.hasPrefix("//") else { return false }
        // Exclude email/host forms, while explicit filesystem paths may contain @.
        let explicit = value.hasPrefix("/") || value.hasPrefix("~/") || value.hasPrefix("./") || value.hasPrefix("../")
        if !explicit && value.range(of: #"^[^/\s@]+@[^/\s@]+(?:/.*)?$"#, options: .regularExpression) != nil { return false }
        if value.hasPrefix("/") || value.hasPrefix("~/") || value.hasPrefix("./") || value.hasPrefix("../") { return true }
        let ext = (value as NSString).pathExtension.lowercased()
        let extensions = Set("md markdown txt csv tsv json jsonl yaml yml html htm pdf png jpg jpeg gif webp heic mp4 mov m4v webm mp3 wav m4a zip swift ts tsx js jsx py rb sh sql css scss xml toml log c h cpp rs go java kt vue svelte xlsx docx pptx".split(separator: " ").map(String.init))
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
        let urls = try! NSRegularExpression(pattern: #"(?:[A-Za-z][A-Za-z0-9+.-]*://|mailto:|www\.)[^\s<>\"']+"#, options: .caseInsensitive)
        let urlRanges = urls.matches(in: plain, range: NSRange(plain.startIndex..., in: plain)).map(\.range)
        let regex = try! NSRegularExpression(pattern: #"[^\s`<>\[\](){}\"']+"#)
        for match in regex.matches(in: plain, range: NSRange(plain.startIndex..., in: plain)) {
            if urlRanges.contains(where: { NSIntersectionRange($0, match.range).length > 0 }) { continue }
            guard let range = Range(match.range, in: plain) else { continue }
            let candidate = String(plain[range]).replacingOccurrences(of: #"[.,;!?，。]+$"#, with: "", options: .regularExpression)
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
            if response.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("image/") == true,
               let encoded = response.value(forHTTPHeaderField: "X-Local-File-Metadata"), let metadata = Data(base64Encoded: encoded) {
                return LocalFilePreview(info: try JSONDecoder().decode(LocalFileInfo.self, from: metadata), imageData: data)
            }
            return LocalFilePreview(info: try JSONDecoder().decode(LocalFileInfo.self, from: data))
        } catch let error as APIError where error.status == 404 && error.code != "LOCAL_FILE_NOT_FOUND" {
            throw APIError(status: 404, message: "이 서버는 파일 보기를 지원하지 않습니다")
        }
    }
    func publishLocalFile(projectID: String, path: String) async throws -> FileDoc {
        struct Body: Encodable, Sendable { let path: String }
        return try await send("/api/projects/\(Self.segment(projectID))/files/from-path", body: Body(path: path))
    }
}
