import Foundation

struct FileSearchResult: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let match: String
    let excerpt: String
    let rank: Int

    var bodyLabel: String? { match == "body" ? String(localized: "본문에서 찾음") : nil }
}

/// The view uses these same results for visibility, body badges and excerpts.
struct FileSearchPresentation {
    let results: [FileSearchResult]

    func result(for id: String) -> FileSearchResult? { results.first { $0.id == id } }

    func files(_ files: [FileDoc], kind: String?) -> [FileDoc] {
        let byID = Dictionary(files.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return results.sorted { $0.rank < $1.rank }.compactMap { result in
            guard let file = byID[result.id], kind == nil || file.kind == kind else { return nil }
            return file
        }
    }
}
