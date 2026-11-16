import Foundation

/// 0.2.7(D5-7): 자료의 판 갈이. 서버는 모든 판을 싣고 옛 판에 replacedBy, 최신 판에 versions(2 이상)를 단다.
/// 목록은 최신 판만 보이고, 옛 판은 최신 판의 '이전 판'으로 연다. 옛 판을 가리키는 보고·결재는 그 id 로 그대로 열린다.
enum FileVersions {
    /// 목록에 보일 판: 새 판이 목록에 있는 옛 판은 뺀다(새 판을 아직 못 받았으면 옛 판을 남긴다).
    static func listed(_ files: [FileDoc]) -> [FileDoc] {
        let ids = Set(files.map(\.id))
        return files.filter { file in file.replacedBy.map { !ids.contains($0) } ?? true }
    }

    /// 이 판의 가장 새 판(목록에 있는 것까지). 없으면 그 판 자신.
    static func newest(of file: FileDoc, in files: [FileDoc]) -> FileDoc {
        let byID = Dictionary(files.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var current = file
        var seen: Set<String> = [file.id]
        while let next = current.replacedBy, let newer = byID[next], seen.insert(newer.id).inserted { current = newer }
        return current
    }

    /// 이 판의 번호(처음 판이 1). 앞 판을 목록에서 따라 센다(서버의 versions 와 같은 셈). 판 갈이가 없는 자료는 nil.
    static func number(of file: FileDoc, in files: [FileDoc]) -> Int? {
        let count = previous(of: file, in: files).count + 1
        if count > 1 { return count }
        // 처음 판: 새 판이 목록에 있을 때만 '판 1'(새 판을 아직 못 받았으면 판 갈이를 모른다).
        guard let next = file.replacedBy, files.contains(where: { $0.id == next }) else { return nil }
        return 1
    }

    /// 이 판보다 앞선 판들(가까운 것부터).
    static func previous(of file: FileDoc, in files: [FileDoc]) -> [FileDoc] {
        let byID = Dictionary(files.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var result: [FileDoc] = []
        var seen: Set<String> = [file.id]
        var cursor = file.replaces
        while let id = cursor, let older = byID[id], seen.insert(older.id).inserted {
            result.append(older)
            cursor = older.replaces
        }
        return result
    }
}
