import Foundation
import XCTest
@testable import IAMCEO

// 완성도 4차 R(B2): 앱 화면 영어.
// - 문구 표(Resources/Shared/Localizable.xcstrings)는 한국어 원문이 열쇠다. 한국어 기기와 시험은 열쇠를 그대로 보여 준다.
// - KoreanTextFreezeTests: 바꾸기 전(37408e8) 소스의 한국어 글자가 지금 소스에 그대로 있는지 대조한다(한국어 화면이 한 글자도 바뀌지 않았다).
// - LocalizationCatalogTests: 표의 모양(영어 번역, 형식 지정자, 한국어 표), 그리고 화면 문구가 표에 다 들어 있는지.
// - AppLanguageTests: 영어 화면에서만 갈리는 것(조사, 날짜, 서버 코드의 영어 문장).

/// 저장소의 native/ 폴더. iPhone 시험(check.sh ios)도 native/ 를 통째로 복사해 같은 상대 경로로 읽는다.
private let nativeRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

/// Swift 소스의 문자열 글자(끼워 넣는 값 안의 글자까지). 끼워 넣는 값은 "{}" 로 적는다. 시험용이라 단순하지만,
/// 주석·여러 줄 글자·# 글자·끼워 넣기 안의 글자를 가른다(대조용 파이썬 판과 같은 규칙).
enum SourceLiterals {
    struct Literal { let start: Int; let end: Int; let text: String }

    static func scan(_ source: String) -> (scalars: [Unicode.Scalar], literals: [Literal]) {
        let s = Array(source.unicodeScalars)
        var out: [Literal] = []
        var i = 0
        while i < s.count {
            if starts(s, i, "//") { while i < s.count && s[i] != "\n" { i += 1 }; continue }
            if starts(s, i, "/*") {
                var depth = 1; i += 2
                while i < s.count && depth > 0 {
                    if starts(s, i, "/*") { depth += 1; i += 2 } else if starts(s, i, "*/") { depth -= 1; i += 2 } else { i += 1 }
                }
                continue
            }
            if s[i] == "\"" || s[i] == "#" {
                var j = i
                while j < s.count && s[j] == "#" { j += 1 }
                if j < s.count && s[j] == "\"", let end = read(s, i, &out) { i = end; continue }
            }
            i += 1
        }
        return (s, out)
    }

    private static func starts(_ s: [Unicode.Scalar], _ i: Int, _ text: String) -> Bool {
        let t = Array(text.unicodeScalars)
        guard i + t.count <= s.count else { return false }
        for k in 0..<t.count where s[i + k] != t[k] { return false }
        return true
    }

    /// 글자 하나를 읽어 out 에 더하고(안쪽 글자도) 끝 위치를 돌려준다. 닫히지 않으면 nil.
    private static func read(_ s: [Unicode.Scalar], _ start: Int, _ out: inout [Literal]) -> Int? {
        var j = start, hashes = 0
        while s[j] == "#" { hashes += 1; j += 1 }
        let multi = starts(s, j, "\"\"\"")
        let quote = multi ? "\"\"\"" : "\""
        j += quote.unicodeScalars.count
        let close = quote + String(repeating: "#", count: hashes)
        let escape = "\\" + String(repeating: "#", count: hashes)
        var text = String.UnicodeScalarView()
        var nested: [Literal] = []
        while j < s.count {
            if starts(s, j, close) {
                let end = j + close.unicodeScalars.count
                out.append(Literal(start: start, end: end, text: String(text)))
                out.append(contentsOf: nested)
                return end
            }
            if starts(s, j, escape) {
                let k = j + escape.unicodeScalars.count
                if k < s.count && s[k] == "(" {
                    var depth = 1, m = k + 1
                    while m < s.count && depth > 0 {
                        var n = m
                        while n < s.count && s[n] == "#" { n += 1 }
                        if s[m] == "\"" || (s[m] == "#" && n < s.count && s[n] == "\"") {
                            var inner: [Literal] = []
                            guard let end = read(s, m, &inner) else { return nil }
                            nested.append(contentsOf: inner); m = end; continue
                        }
                        if s[m] == "(" { depth += 1 } else if s[m] == ")" { depth -= 1 }
                        m += 1
                    }
                    text.append(contentsOf: "{}".unicodeScalars)
                    j = m; continue
                }
                text.append(contentsOf: s[j...k]); j = k + 1; continue
            }
            if !multi && s[j] == "\n" { return nil }
            text.append(s[j]); j += 1
        }
        return nil
    }

    static func hasHangul(_ text: String) -> Bool { text.unicodeScalars.contains { (0xAC00...0xD7A3).contains($0.value) || (0x3131...0x318E).contains($0.value) } }

    static func swiftFiles(under folder: URL) -> [URL] {
        let walker = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: nil)
        var files: [URL] = []
        while let url = walker?.nextObject() as? URL { if url.pathExtension == "swift" { files.append(url) } }
        return files.sorted { $0.path < $1.path }
    }
}

private func fixture<T: Decodable>(_ name: String, as: T.Type) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(contentsOf: nativeRoot.appendingPathComponent("Tests/Fixtures/\(name)")))
}

private struct TextList: Decodable { let texts: [String] }
private struct TextReasons: Decodable { let texts: [String: String]; let prefixes: [String: String]? }

private struct Catalog: Decodable {
    struct Unit: Decodable { let state: String?; let value: String }
    struct Localization: Decodable {
        let stringUnit: Unit?
        let variations: [String: [String: Localization]]?
        /// 복수형 등으로 나뉜 번역까지 모두.
        var values: [String] { (stringUnit.map { [$0.value] } ?? []) + (variations?.values.flatMap { $0.values.flatMap(\.values) } ?? []) }
    }
    struct Entry: Decodable { let localizations: [String: Localization]?; let extractionState: String? }
    let sourceLanguage: String
    let strings: [String: Entry]

    static func load(_ path: String = "Resources/Shared/Localizable.xcstrings") throws -> Catalog {
        try JSONDecoder().decode(Catalog.self, from: Data(contentsOf: nativeRoot.appendingPathComponent(path)))
    }
}

private let appSources = nativeRoot.appendingPathComponent("Sources/IAMCEO")

final class KoreanTextFreezeTests: XCTestCase {
    /// 바꾸기 전 소스의 한국어 글자가 모두 지금 소스에 있다. 문구 표로 옮기면서 한국어 글자는 열쇠로 그대로 남기 때문에,
    /// 여기서 빠진 글자가 있으면 한국어 화면이 바뀐 것이다. 일부러 바꾼 글자는 korean-text-changed.json 에 이유와 함께 적는다.
    func testEveryKoreanTextOfTheBaselineIsStillInTheSource() throws {
        let baseline = try fixture("korean-text-37408e8.json", as: TextList.self).texts
        let changed = try fixture("korean-text-changed.json", as: TextReasons.self).texts
        var current = Set<String>()
        for file in SourceLiterals.swiftFiles(under: appSources) where file.lastPathComponent != "DemoFixtures.swift" {
            for literal in SourceLiterals.scan(try String(contentsOf: file, encoding: .utf8)).literals where SourceLiterals.hasHangul(literal.text) {
                current.insert(literal.text)
            }
        }
        XCTAssertGreaterThan(baseline.count, 1500)
        let missing = baseline.filter { !current.contains($0) && changed[$0] == nil }
        XCTAssertEqual(missing, [], "한국어 화면 글자가 바뀌었다. 일부러 바꿨다면 native/Tests/Fixtures/korean-text-changed.json 에 이유를 적는다")
    }

    /// 한국어 기기는 영어 표를 읽지 않는다: 한국어 열쇠에 열쇠와 다른 한국어 번역을 두지 않는다(한국어 표가 생기면 원문 대신 그 값이 보인다).
    func testCatalogNeverOverridesKoreanText() throws {
        let catalog = try Catalog.load()
        XCTAssertEqual(catalog.sourceLanguage, "ko")
        let overridden = catalog.strings.compactMap { key, entry -> String? in
            guard SourceLiterals.hasHangul(key), let ko = entry.localizations?["ko"] else { return nil }
            return ko.values.allSatisfy { $0 == key } ? nil : key
        }
        XCTAssertEqual(overridden, [])
    }

    /// 4차 리뷰 lang-6: 한국어도 영어도 고르지 않은 기기(일본어만 등)는 영어로 떨어진다(앱의 대체 언어 en).
    /// 대체 언어가 en 이라, 문구 파일이 ko.lproj 에 없으면 한국어 기기도 그 파일만은 en.lproj 에서 읽는다(파일 단위로 대체한다).
    /// 그래서 영어 쪽에만 생기던 두 파일 — 복수형(Localizable.stringsdict)과 권한 안내(InfoPlist.strings) — 이 ko.lproj 에도
    /// 생기도록, 그 항목에 원문과 같은 한국어 값을 둔다(4차 확인: 한국어 기기에서 '5 decisions'·영어 권한 창이 나왔다).
    func testOtherLanguagesFallBackToEnglishWhileKoreanStaysAvailable() throws {
        let project = try String(contentsOf: nativeRoot.appendingPathComponent("project.yml"), encoding: .utf8)
        XCTAssertEqual(project.components(separatedBy: "CFBundleDevelopmentRegion: en").count - 1, 2, "Mac·iPhone 앱 둘 다")
        XCTAssertFalse(project.contains("CFBundleDevelopmentRegion: ko"))
        XCTAssertEqual(project.components(separatedBy: "CFBundleLocalizations: [ko, en]").count - 1, 2)
        XCTAssertTrue(project.contains("developmentLanguage: ko"), "문구 표의 원문 언어는 한국어 그대로")
        var korean: [String: String] = [:]
        for plist in ["Configuration/macOS-Info.plist", "Configuration/iOS-Info.plist"] {
            let info = try XCTUnwrap(NSDictionary(contentsOf: nativeRoot.appendingPathComponent(plist)) as? [String: Any])
            XCTAssertEqual(info["CFBundleDevelopmentRegion"] as? String, "en", plist)
            XCTAssertEqual(info["CFBundleLocalizations"] as? [String], ["ko", "en"], plist)
            for (key, value) in info where key.hasSuffix("UsageDescription") { korean[key] = value as? String }
        }

        // 복수형·끼워 넣기로 나뉜 영어 항목은 모두 한국어 값(원문 그대로)을 가진다. 하나라도 한국어 복수형이 있어야 ko.lproj 에 stringsdict 가 생긴다.
        let raw = try rawCatalog("Resources/Shared/Localizable.xcstrings")
        let catalog = try Catalog.load()
        var split: [String] = [], missing: [String] = [], koreanPlurals = 0
        for (key, entry) in raw {
            let localizations = entry["localizations"] as? [String: Any] ?? [:]
            guard let english = localizations["en"] as? [String: Any], english["variations"] != nil || english["substitutions"] != nil else { continue }
            split.append(key)
            guard let ko = localizations["ko"] as? [String: Any] else { missing.append(key); continue }
            if (ko["variations"] as? [String: Any])?["plural"] != nil { koreanPlurals += 1 }
            XCTAssertEqual(catalog.strings[key]?.localizations?["ko"]?.values.allSatisfy { $0 == key }, true, "한국어 값은 원문 그대로: \(key)")
        }
        XCTAssertGreaterThan(split.count, 30)
        XCTAssertEqual(missing, [], "영어가 복수형으로 나뉜 항목은 한국어 값(원문 그대로)도 둔다. 없으면 한국어 기기가 그 문구를 영어로 본다")
        XCTAssertGreaterThan(koreanPlurals, 0)

        // 권한 안내: 한국어 값이 Info.plist 원문과 같고 'translated' 다(빌드는 'new' 상태의 값을 넣지 않아 ko.lproj 에 파일이 생기지 않았다).
        let info = try rawCatalog("Resources/Shared/InfoPlist.xcstrings")
        XCTAssertEqual(Set(info.keys), Set(korean.keys), "권한 안내마다 표 항목이 있다")
        for (key, entry) in info {
            let localizations = entry["localizations"] as? [String: Any] ?? [:]
            let ko = (localizations["ko"] as? [String: Any])?["stringUnit"] as? [String: Any]
            let en = (localizations["en"] as? [String: Any])?["stringUnit"] as? [String: Any]
            XCTAssertEqual(ko?["state"] as? String, "translated", key)
            XCTAssertEqual(ko?["value"] as? String, korean[key], key)
            XCTAssertEqual(en?["state"] as? String, "translated", key)
        }
        // 두 표 어디서든 한국어 값은 'translated' 여야 빌드에 들어간다.
        for (path, table) in [("Localizable", raw), ("InfoPlist", info)] {
            let untranslated = table.filter { _, entry in
                guard let ko = (entry["localizations"] as? [String: Any])?["ko"] else { return false }
                return Self.states(in: ko).contains { $0 != "translated" }
            }.map(\.key)
            XCTAssertEqual(untranslated, [], path)
        }
    }

    private func rawCatalog(_ path: String) throws -> [String: [String: Any]] {
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: nativeRoot.appendingPathComponent(path)))
        return try XCTUnwrap((object as? [String: Any])?["strings"] as? [String: [String: Any]])
    }

    /// 한 언어 값 안의 모든 stringUnit 상태(복수형·끼워 넣기 안쪽까지).
    private static func states(in value: Any) -> [String] {
        guard let object = value as? [String: Any] else { return [] }
        var found: [String] = []
        if let unit = object["stringUnit"] as? [String: Any] { found.append(unit["state"] as? String ?? "") }
        for (key, child) in object where key != "stringUnit" { found += states(in: child) }
        return found
    }

    #if os(macOS)
    /// 빌드가 쓰는 컴파일러(xcstringstool)로 두 표를 직접 컴파일해 본다: ko.lproj 에 en.lproj 의 파일이 모두 있고,
    /// 한국어 복수형은 원문 그대로 풀리며, 한국어 권한 안내는 Info.plist 의 원문이다.
    /// 빌드된 앱 번들 자체는 scripts/check-app-languages.sh(check.sh build, CI)가 같은 조건으로 본다.
    func testCompiledKoreanTablesHaveEveryFileTheEnglishOnesHave() throws {
        let find = Process()
        find.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        find.arguments = ["--find", "xcstringstool"]
        find.standardOutput = FileHandle.nullDevice; find.standardError = FileHandle.nullDevice
        try find.run(); find.waitUntilExit()
        guard find.terminationStatus == 0 else { throw XCTSkip("xcstringstool 이 없는 환경") }
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("iamceo-l10n-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: out) }
        for table in ["Localizable", "InfoPlist"] {
            let compile = Process()
            compile.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
            compile.arguments = ["xcstringstool", "compile", nativeRoot.appendingPathComponent("Resources/Shared/\(table).xcstrings").path,
                                 "--output-directory", out.path]
            let errors = Pipe()
            compile.standardOutput = FileHandle.nullDevice; compile.standardError = errors
            try compile.run()
            let message = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            compile.waitUntilExit()
            XCTAssertEqual(compile.terminationStatus, 0, "\(table): \(message)")
        }
        let files = { (language: String) in
            Set((try? FileManager.default.contentsOfDirectory(atPath: out.appendingPathComponent("\(language).lproj").path)) ?? [])
        }
        XCTAssertEqual(files("en"), ["Localizable.strings", "Localizable.stringsdict", "InfoPlist.strings"])
        XCTAssertEqual(files("ko"), files("en"), "ko.lproj 에 없는 파일은 한국어 기기도 en.lproj 에서 읽는다")

        let plurals = try XCTUnwrap(NSDictionary(contentsOf: out.appendingPathComponent("ko.lproj/Localizable.stringsdict")) as? [String: [String: Any]])
        XCTAssertGreaterThan(plurals.count, 30)
        for (key, rule) in plurals {
            XCTAssertEqual(rule["NSStringLocalizedFormatKey"] as? String, "%#@value@", key)
            XCTAssertEqual((rule["value"] as? [String: Any])?["other"] as? String, key, "한국어 복수형은 원문 그대로: \(key)")
            XCTAssertEqual(Set(((rule["value"] as? [String: Any]) ?? [:]).keys.filter { !$0.hasPrefix("NSString") }), ["other"], key)
        }
        let permissions = try XCTUnwrap(NSDictionary(contentsOf: out.appendingPathComponent("ko.lproj/InfoPlist.strings")) as? [String: String])
        let iOS = try XCTUnwrap(NSDictionary(contentsOf: nativeRoot.appendingPathComponent("Configuration/iOS-Info.plist")) as? [String: Any])
        XCTAssertEqual(permissions.keys.sorted(), ["NSCameraUsageDescription", "NSLocalNetworkUsageDescription", "NSPhotoLibraryAddUsageDescription"])
        for (key, value) in permissions { XCTAssertEqual(value, iOS[key] as? String, key) }
    }
    #endif

    /// 시험(패키지·iPhone 시험 앱)에는 문구 표가 없어 열쇠 = 한국어 원문이 나온다. 그래서 기존 시험의 한국어 기대값이 그대로 통한다.
    func testTestsSeeTheKoreanSource() {
        XCTAssertEqual(AppLanguage.current, .ko)
        XCTAssertEqual(String(localized: "보관한 프로젝트는 읽기 전용입니다."), "보관한 프로젝트는 읽기 전용입니다.")
        XCTAssertEqual(messageKindLabel("완료"), "완료")
        XCTAssertEqual(Destination.files.title, "자료")
    }
}

final class LocalizationCatalogTests: XCTestCase {
    private static let specifier = try! NSRegularExpression(pattern: #"%(?:(\d+)\$)?[-+ #0]*\d*(?:\.\d+)?(ll|l|h|hh|q|z|t|j|L)?([@dDuUxXoOfeEgGcCsSpaAF%])"#)

    /// (자리, 형) 목록. %% 는 뺀다.
    private static func specifiers(_ text: String) -> [(Int?, String)] {
        let ns = text as NSString
        return specifier.matches(in: text, range: NSRange(location: 0, length: ns.length)).compactMap { match in
            let kind = ns.substring(with: match.range(at: 3))
            guard kind != "%" else { return nil }
            let size = match.range(at: 2).location == NSNotFound ? "" : ns.substring(with: match.range(at: 2))
            let position = match.range(at: 1).location == NSNotFound ? nil : Int(ns.substring(with: match.range(at: 1)))
            return (position, size + kind)
        }
    }

    /// 번역의 형식 지정자가 열쇠(또는 열쇠가 id 면 한국어 기본값)의 것과 맞는다. 쓰지 않는 값은 끝에만 둘 수 있다.
    private static func specifierProblem(source: String, translation: String) -> String? {
        let types = specifiers(source).map(\.1)
        var used = Set<Int>(), next = 0
        for (position, kind) in specifiers(translation) {
            let index: Int
            if let position { index = position } else { next += 1; index = next }
            guard (1...max(1, types.count)).contains(index), index <= types.count else { return "값 \(index) 없음" }
            guard types[index - 1] == kind else { return "값 \(index) 형 \(kind) ≠ \(types[index - 1])" }
            used.insert(index)
        }
        if let last = used.max(), let gap = (1...last).first(where: { !used.contains($0) }) { return "값 \(gap) 를 건너뜀" }
        if source.components(separatedBy: "%%").count != translation.components(separatedBy: "%%").count { return "%% 수가 다름" }
        return nil
    }

    func testEveryEntryHasAnEnglishTranslationThatFitsTheFormat() throws {
        let catalog = try Catalog.load()
        let defaults = try keyedDefaults()
        var problems: [String] = []
        for (key, entry) in catalog.strings where entry.extractionState != "manual" {
            guard let english = entry.localizations?["en"]?.values, !english.isEmpty else { problems.append("영어 없음: \(key)"); continue }
            let source = defaults[key] ?? key
            for value in english {
                if SourceLiterals.hasHangul(value) { problems.append("영어에 한글: \(key) → \(value)") }
                if value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !source.trimmingCharacters(in: .whitespaces).isEmpty {
                    problems.append("빈 번역: \(key)")
                }
                if let problem = Self.specifierProblem(source: source, translation: value) { problems.append("\(problem): \(key) → \(value)") }
            }
        }
        XCTAssertEqual(problems, [])
    }

    func testFormatCheckCatchesMistakes() {
        XCTAssertNil(Self.specifierProblem(source: "%@에게 %lld건", translation: "%2$lld for %1$@"))
        XCTAssertNil(Self.specifierProblem(source: "%@%@ 이 폴더", translation: "%1$@%2$@ this folder"))
        XCTAssertNil(Self.specifierProblem(source: "%@ %@.", translation: "The lead %1$@."), "끝의 값은 쓰지 않아도 된다")
        XCTAssertNotNil(Self.specifierProblem(source: "%@ %lld", translation: "%lld %@"))
        XCTAssertNotNil(Self.specifierProblem(source: "%@", translation: "%@ %@"))
        XCTAssertNotNil(Self.specifierProblem(source: "문맥 %lld%%", translation: "Context %lld%"))
    }

    /// id 열쇠(`String(localized: "tab.files", defaultValue: "자료")`)는 표에 한국어 값도 같게 둔다. 같은 한국어가 뜻에 따라 다른 영어가 될 때만 쓴다.
    private func keyedDefaults() throws -> [String: String] {
        let pattern = try NSRegularExpression(pattern: #"String\(localized: "([a-z]+(?:\.[a-z_]+)+)", defaultValue: "([^"\\]*)""#)
        var found: [String: String] = [:]
        for file in SourceLiterals.swiftFiles(under: appSources) {
            let text = try String(contentsOf: file, encoding: .utf8)
            let ns = text as NSString
            for match in pattern.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
                found[ns.substring(with: match.range(at: 1))] = ns.substring(with: match.range(at: 2))
            }
        }
        return found
    }

    func testKeyedEntriesKeepTheKoreanDefault() throws {
        let catalog = try Catalog.load()
        let defaults = try keyedDefaults()
        XCTAssertFalse(defaults.isEmpty)
        for (key, korean) in defaults {
            let entry = try XCTUnwrap(catalog.strings[key], "표에 없음: \(key)")
            XCTAssertEqual(entry.localizations?["ko"]?.values, [korean], key)
            XCTAssertNotNil(entry.localizations?["en"], key)
        }
    }

    /// 화면에 나올 한국어 글자는 모두 표에 영어와 함께 있다. 판정·서버 문장 비교·조사·샘플 내용처럼 화면 문구가 아닌 글자는
    /// 자리(case, ==, contains, friendlyLoadError 의 낱말 조각 등)나 korean-text-not-ui.json 으로 뺀다.
    /// 새 화면 문구를 String(localized:) 로 쓰고 표에 넣지 않으면 여기서 걸린다.
    func testEveryScreenTextIsInTheCatalog() throws {
        let catalog = try Catalog.load()
        let notUI = try fixture("korean-text-not-ui.json", as: TextReasons.self)
        let spec = try NSRegularExpression(pattern: #"%(?:\d+\$)?[-+ #0]*\d*(?:\.\d+)?(?:ll|l|h|hh|q|z|t|j|L)?[@dDuUxXoOfeEgGcCsSpaAF]"#)
        func shape(_ key: String) -> String {
            let ns = key as NSString
            return spec.stringByReplacingMatches(in: key, range: NSRange(location: 0, length: ns.length), withTemplate: "{}")
                .replacingOccurrences(of: "%%", with: "%")
        }
        let shapes = Set(catalog.strings.keys.map(shape))
        let skipFiles: Set<String> = ["DemoFixtures.swift", "SampleWorkspaceData.swift", "SampleServer.swift", "ServerErrorText.swift"]
        var missing: [String] = []
        for file in SourceLiterals.swiftFiles(under: appSources) where !skipFiles.contains(file.lastPathComponent) {
            let (scalars, literals) = SourceLiterals.scan(try String(contentsOf: file, encoding: .utf8))
            for literal in literals where SourceLiterals.hasHangul(literal.text) {
                if notUI.texts[literal.text] != nil || notUI.prefixes?.keys.contains(where: { literal.text.hasPrefix($0) }) == true { continue }
                if Self.isNotScreenText(scalars, literal) { continue }
                if shapes.contains(Self.unescaped(literal.text)) { continue }
                missing.append("\(file.lastPathComponent): \(literal.text)")
            }
        }
        XCTAssertEqual(missing, [], "Localizable.xcstrings 에 영어 번역과 함께 넣는다(화면 문구가 아니면 korean-text-not-ui.json)")
    }

    /// 글자 앞뒤(같은 줄)로 본 '화면 문구가 아닌 자리'.
    static func isNotScreenText(_ s: [Unicode.Scalar], _ literal: SourceLiterals.Literal) -> Bool {
        var lineStart = literal.start
        while lineStart > 0 && s[lineStart - 1] != "\n" { lineStart -= 1 }
        var lineEnd = literal.end
        while lineEnd < s.count && s[lineEnd] != "\n" { lineEnd += 1 }
        let before = String(String.UnicodeScalarView(s[lineStart..<literal.start]))
        let after = String(String.UnicodeScalarView(s[literal.end..<lineEnd]))
        let line = before + after
        func ends(_ pattern: String) -> Bool { before.range(of: pattern + "$", options: .regularExpression) != nil }
        func begins(_ pattern: String) -> Bool { after.range(of: "^" + pattern, options: .regularExpression) != nil }
        if (ends(#"\bcase\s+"#) || ends(#"\bcase\s+("[^"]*"\s*,\s*)+"#)) && begins(#"\s*[:,]"#) { return true }
        if ends(#"(==|!=)\s*"#) || begins(#"\s*(==|!=)"#) { return true }
        if ends(#"(\.contains|hasPrefix|hasSuffix|\bhas|range\(of:|replacingOccurrences\(of:|components\(separatedBy:)\s*\(?\s*"#) { return true }
        if ends(#"with:\s*"#) && line.contains("replacingOccurrences") { return true }
        if begins(#"[^\]\)]*\]\s*\.contains"#) { return true }
        if ends(#"\b(what|verb):\s*"#) && line.contains("friendlyLoadError(") { return true }
        if ends(#"\b(what|verb): String = "#) { return true }
        if ends(#"\b(ko|defaultValue):\s*"#) { return true }
        if ends(#"(dateFormat\s*=|koFormatted\([^,]*,)\s*"#) { return true }
        return false
    }

    /// 소스 글자의 이스케이프를 실제 글자로(표의 열쇠와 맞추려고).
    static func unescaped(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        let s = Array(text.unicodeScalars)
        var i = 0
        while i < s.count {
            guard s[i] == "\\", i + 1 < s.count else { out.append(s[i]); i += 1; continue }
            switch s[i + 1] {
            case "n": out.append("\n"); i += 2
            case "t": out.append("\t"); i += 2
            case "r": out.append("\r"); i += 2
            case "0": out.append("\0"); i += 2
            case "u":
                if i + 2 < s.count, s[i + 2] == "{", let close = s[(i + 3)...].firstIndex(of: "}"),
                   let value = UInt32(String(String.UnicodeScalarView(s[(i + 3)..<close])), radix: 16), let scalar = Unicode.Scalar(value) {
                    out.append(scalar); i = close + 1
                } else { out.append(s[i]); i += 1 }
            default: out.append(s[i + 1]); i += 2
            }
        }
        return String(out)
    }

    func testInfoPlistTextsHaveEnglish() throws {
        let catalog = try Catalog.load("Resources/Shared/InfoPlist.xcstrings")
        XCTAssertEqual(catalog.sourceLanguage, "ko")
        for key in ["NSCameraUsageDescription", "NSLocalNetworkUsageDescription", "NSPhotoLibraryAddUsageDescription"] {
            let english = try XCTUnwrap(catalog.strings[key]?.localizations?["en"]?.values.first, key)
            XCTAssertFalse(SourceLiterals.hasHangul(english), key)
        }
    }

    /// '접수 확인 중입니다' 안내는 머리 글자로 지운다(AppStore). 영어 번역도 같은 머리로 시작해야 영어 화면에서도 지워진다.
    func testReceiptCheckNoticesShareTheirEnglishPrefix() throws {
        let catalog = try Catalog.load()
        let head = try XCTUnwrap(catalog.strings["접수 확인 중입니다"]?.localizations?["en"]?.values.first)
        for (key, entry) in catalog.strings where key.hasPrefix("접수 확인 중입니다") {
            for value in entry.localizations?["en"]?.values ?? [] { XCTAssertTrue(value.hasPrefix(head), "\(key) → \(value)") }
        }
    }

    func testScannerReadsNestedAndRawLiterals() {
        let source = ##"""
        let a = "바깥 \(flag ? "안쪽" : "다른") 끝" // "주석은 빼다"
        let b = #"원시 \#(x) 글자"#
        /* "막힌 주석" */
        let c = """
            여러 줄
            """
        """##
        let texts = SourceLiterals.scan(source).literals.map(\.text)
        XCTAssertEqual(texts.filter(SourceLiterals.hasHangul), ["바깥 {} 끝", "안쪽", "다른", "원시 {} 글자", "\n    여러 줄\n    "])
    }
}

final class AppLanguageTests: XCTestCase {
    func testKoreanStaysAsBefore() {
        XCTAssertEqual(objectParticle("파일"), "을")
        XCTAssertEqual(subjectParticle("Codex"), "가")
        XCTAssertEqual(loadErrorVerb("받지"), "받지")
        XCTAssertEqual(loadErrorNoun("첨부"), "첨부")
        XCTAssertEqual(ServerErrorText.display("인증이 필요합니다", code: "unauthorized"), "인증이 필요합니다")
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = .current
        let date = calendar.date(from: DateComponents(year: 2026, month: 11, day: 4, hour: 14, minute: 20))!
        XCTAssertEqual(koTime(date), "14:20")
        XCTAssertEqual(appFormatted(date, ko: "M월 d일", en: "MMMd"), "11월 4일")
        XCTAssertEqual(friendlyLoadError(APIError(status: 0, message: "x"), what: "첨부", verb: "올리지"), "첨부를 올리지 못했습니다.")
    }

    func testEnglishDropsParticlesAndUsesEnglishWords() {
        AppLanguage.withOverride(.en) {
            XCTAssertEqual(AppLanguage.current, .en)
            XCTAssertEqual(objectParticle("파일"), "")
            XCTAssertEqual(subjectParticle("Codex"), "")
            XCTAssertFalse(appUsesParticles)
            XCTAssertEqual(loadErrorVerb("받지"), "download")
            XCTAssertEqual(loadErrorVerb("모르는 조각"), "load")
            XCTAssertEqual(loadErrorNoun("첨부"), "attachment")
            XCTAssertEqual(loadErrorNoun("Mac 연결"), "Mac connection")
            XCTAssertEqual(loadErrorNoun("모르는 조각"), "item")
        }
        XCTAssertEqual(AppLanguage.current, .ko, "덮어쓰기는 블록이 끝나면 풀린다")
    }

    func testEnglishDatesUseEnglishMonthNames() {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = .current
        let date = calendar.date(from: DateComponents(year: 2026, month: 11, day: 4, hour: 14, minute: 20))!
        AppLanguage.withOverride(.en) {
            let day = appFormatted(date, ko: "M월 d일", en: "MMMd")
            XCTAssertTrue(day.contains("Nov") && day.contains("4"), day)
            XCTAssertFalse(SourceLiterals.hasHangul(koDateTime(date)))
            XCTAssertFalse(SourceLiterals.hasHangul(koTime(date)))
        }
    }

    /// 서버가 보낸 문장이 그 코드의 대표 문장과 같으면 영어 화면은 코드의 영어 문장을, 이름이 끼었거나 코드가 없으면 받은 그대로.
    func testServerErrorsUseTheCodeInEnglish() {
        AppLanguage.withOverride(.en) {
            XCTAssertEqual(ServerErrorText.display("인증이 필요합니다", code: "unauthorized"), "Authentication required")
            XCTAssertEqual(ServerErrorText.display("인증이 필요합니다.", code: "unauthorized"), "Authentication required", "끝의 마침표는 같게 본다")
            XCTAssertEqual(ServerErrorText.display("dev 팀장이 일하는 중입니다", code: "member_working"), "dev 팀장이 일하는 중입니다", "이름이 낀 문장은 그대로")
            XCTAssertEqual(ServerErrorText.display("인증이 필요합니다", code: nil), "인증이 필요합니다", "코드가 없는 옛 서버는 그대로")
            XCTAssertEqual(ServerErrorText.display("No core terminal for member", code: "TERMINAL_REFUSED", reason: "core_terminal_missing"),
                           "This staff member is asleep, so there is no terminal", "실행 엔진의 거절은 사유 코드로")
            XCTAssertEqual(APIError(status: 401, message: "인증이 필요합니다", code: "unauthorized").localizedDescription, "Authentication required")
            XCTAssertEqual(APIError(status: 401, message: "인증이 필요합니다", code: "unauthorized").message, "인증이 필요합니다", "판정용 문장은 그대로")
            XCTAssertTrue(ServerErrorText.matches("Authentication required", code: "unauthorized"))
            XCTAssertEqual(plainDeliveryNote("잠듦", code: "held_asleep"), "Asleep")
        }
        XCTAssertEqual(APIError(status: 401, message: "인증이 필요합니다", code: "unauthorized").localizedDescription, "인증이 필요합니다")
        XCTAssertEqual(plainDeliveryNote("잠듦", code: "held_asleep"), "잠듦")
    }

    /// 2차 F 가 미룬 표시 문장 바꿈을 코드로: 코드가 있으면 코드로, 없는 옛 서버는 예전처럼 문장으로(한국어 결과는 같다).
    func testDeferredDisplayRewritesFollowCodes() {
        let starting = "세션을 시작했는지 아직 확인하지 못했습니다. 상태를 다시 확인하고 있습니다."
        XCTAssertEqual(friendlyError("어떤 문장이든", code: "starting_unknown"), starting)
        XCTAssertEqual(friendlyError("starting_unknown: core 확인 중"), starting, "옛 서버: 문장으로")
        XCTAssertEqual(TerminalPresentation.message("아무 글", reason: "core_terminal_missing"), "이 팀원은 잠들어 있어 터미널이 없습니다")
        XCTAssertEqual(TerminalPresentation.message("No core terminal for member"), "이 팀원은 잠들어 있어 터미널이 없습니다", "옛 서버: 문장으로")
        let unauthorized = "접속 코드가 맞지 않거나 바뀌었습니다. Mac에서 새 QR을 만들어 다시 연결해 주세요."
        XCTAssertEqual(ConnectionRecovery.reason("인증이 필요합니다"), unauthorized)
        XCTAssertEqual(ConnectionRecovery.reason("Authentication required"), unauthorized, "영어 화면의 401 문장도 알아본다")
        XCTAssertEqual(ConnectionRecovery.reason("The access code changed or this device was disconnected. Connect again"), unauthorized)
        XCTAssertEqual(plainDeliveryNote("자동 재전송 상한에 도달했습니다"), "몇 번 다시 넣어 봤지만 들어가지 않았습니다. '다시 보내기'를 눌러 주세요.")
    }

    /// 4차 리뷰 lang-1·ui-6: 영어 화면에서 이미 영어인 까닭(앱이 지은 문장, 다듬어 둔 첨부 오류)을 일반 문장으로 덮지 않는다.
    func testEnglishReasonsAreKeptAsIs() {
        struct PortBusy: LocalizedError { var errorDescription: String? { "Port 7878 is already in use by another app." } }
        struct Synthesized: LocalizedError { var errorDescription: String? { "The operation couldn’t be completed. (Foo.Bar error 1.)" } }
        let address = "Enter a server address like https://your-mac.tailnet.ts.net."
        AppLanguage.withOverride(.en) {
            XCTAssertEqual(friendlyLoadError(APIError(status: 0, message: address), what: "Mac 연결", verb: "확인하지"), address)
            XCTAssertEqual(ConnectionRecovery.reason(address), address, "직접 입력 폼의 주소 안내가 살아남는다")
            XCTAssertEqual(friendlyLoadError(PortBusy(), what: "이 Mac의 연결", verb: "준비하지"), "Port 7878 is already in use by another app.")
            let once = friendlyLoadError(APIError(status: 0, message: "Attachment is too large."), what: "첨부", verb: "올리지")
            XCTAssertEqual(friendlyLoadError(APIError(status: 0, message: once), what: "첨부", verb: "올리지"), once, "두 번 감싸도 같다")
            XCTAssertFalse(friendlyLoadError(APIError(status: 418, message: "Request failed (418).")).contains("Request failed"))
            XCTAssertFalse(friendlyLoadError(Synthesized()).contains("error 1"), "Foundation 이 지은 문장은 일반 문장으로")
            XCTAssertFalse(friendlyLoadError(APIError(status: 0, message: "  ")).isEmpty)
            XCTAssertEqual(friendlyError("Authentication required"), "Authentication required", "401 문장이 AI 로그인 안내가 되지 않는다")
            XCTAssertEqual(friendlyError("Authentication required. This device was disconnected. Make a new QR on the Mac and connect again"),
                           "Authentication required. This device was disconnected. Make a new QR on the Mac and connect again")
            XCTAssertEqual(friendlyError("Not logged in · Please run /login"), "AI 계정 로그인이 풀렸습니다. Mac 터미널에서 다시 로그인해 주세요.",
                           "CLI 의 로그인 문장은 여전히 AI 로그인 안내")
        }
        // 한국어 화면은 예전과 같다: 한글이 없는 문장은 일반 문장, 401 대표 문장은 그대로.
        XCTAssertEqual(friendlyLoadError(APIError(status: 0, message: address), what: "Mac 연결", verb: "확인하지"), "Mac 연결을 확인하지 못했습니다.")
        XCTAssertEqual(friendlyLoadError(PortBusy(), what: "원본", verb: "받지"), "원본을 받지 못했습니다.")
        XCTAssertEqual(friendlyError("인증이 필요합니다"), "인증이 필요합니다")
    }

    /// 4차 리뷰 lang-2: 화면 날짜는 appFormatted 로만 만든다. koFormatted(ko_KR 고정)를 바로 부르면 영어 화면에도 한국어 날짜가 나온다.
    func testScreenDatesGoThroughAppFormatted() throws {
        var direct: [String] = []
        for file in SourceLiterals.swiftFiles(under: appSources) where file.lastPathComponent != "AppLanguage.swift" {
            let lines = try String(contentsOf: file, encoding: .utf8).components(separatedBy: "\n")
            for (index, line) in lines.enumerated() where line.contains("koFormatted(") && !line.contains("func koFormatted(") {
                direct.append("\(file.lastPathComponent):\(index + 1)")
            }
        }
        XCTAssertEqual(direct, [], "appFormatted(date, ko:, en:) 를 쓴다")
    }

    func testMessageKindsAreShownByName() {
        XCTAssertEqual(["완료", "진행", "질문", "막힘", "알림", "답변", "지시", "직접", "나", "시스템"].map(messageKindLabel),
                       ["완료", "진행", "질문", "막힘", "알림", "답변", "지시", "직접", "나", "시스템"])
        XCTAssertEqual(messageKindLabel("새 종류"), "새 종류", "모르는 종류는 그대로")
    }
}
