import Foundation

/// 연결 화면 아래 칩의 명령: 서버 컴퓨터의 터미널에서 접속 주소와 접속 코드를 보여 준다.
///
/// 앱으로 설치한 서버는 앱 묶음 안의 실행 파일(`…/IAMCEO.app/Contents/Resources/runtime/iamceo`)로 돌고,
/// 그 명령은 PATH 에 없다. 그때는 앱 안 경로로 된 명령을 보인다. git 체크아웃·직접 깐 명령줄 도구처럼 그 밖이거나
/// 어떻게 도는지 모를 때는 예전 문구 `iamceo open` 을 그대로 보인다.
///
/// 아는 길은 두 가지다.
/// - 마지막으로 붙었던 그 서버가 Bootstrap 의 `cli` 로 알려 준 명령(서버가 자기 실행 파일을 셸에 맞게 따옴표까지 쳐서 준다).
/// - Mac 이면 이 Mac 에 등록된 서비스(`com.iamceo.server`)의 ProgramArguments.
enum ServerAccessCommand {
    static let plain = "iamceo open"
    private static let runtimeSuffix = ".app/Contents/Resources/runtime/iamceo"

    /// 서버가 알려 준 명령(`serverCLI`)이 있으면 그것으로만 정한다. 없을 때만 이 Mac 의 서비스를 본다.
    static func command(serverCLI: String?, serviceProgram: [String]?) -> String {
        if let serverCLI = serverCLI?.trimmingCharacters(in: .whitespacesAndNewlines), !serverCLI.isEmpty {
            guard let path = unquotedSingleWord(serverCLI), isAppRuntime(path) else { return plain }
            return "\(serverCLI) open"
        }
        if let program = serviceProgram, program.count == 2, program[1] == "serve", isAppRuntime(program[0]) {
            return "\(shellQuote(program[0])) open"
        }
        return plain
    }

    /// 칩에 길게 보일 앱 안 경로인가(짧은 예전 문구가 아닌가).
    static func isLong(_ command: String) -> Bool { command != plain }

    static func isAppRuntime(_ path: String) -> Bool {
        path.hasPrefix("/") && path.hasSuffix(runtimeSuffix) && !path.contains("\n")
    }

    /// 서버의 shellQuote 와 같은 규칙: 안전한 글자만이면 그대로, 아니면 작은따옴표.
    static func shellQuote(_ value: String) -> String {
        let safe = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-./:=@")
        if !value.isEmpty, value.unicodeScalars.allSatisfy({ safe.contains($0) }) { return value }
        return "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
    }

    /// 셸 낱말 하나(따옴표 없는 안전한 낱말 또는 작은따옴표로 싼 것)면 그 값을 돌려준다. `bun /…/iamceo.ts` 같은 두 낱말은 nil.
    private static func unquotedSingleWord(_ text: String) -> String? {
        if text.hasPrefix("'") {
            // 'a'\''b' 꼴을 푼다.
            var value = "", rest = Substring(text)
            while rest.hasPrefix("'") {
                rest = rest.dropFirst()
                guard let close = rest.firstIndex(of: "'") else { return nil }
                value += rest[..<close]
                rest = rest[rest.index(after: close)...]
                if rest.hasPrefix("\\'") { value += "'"; rest = rest.dropFirst(2) }
                else if !rest.isEmpty { return nil }
            }
            return rest.isEmpty ? value : nil
        }
        return shellQuote(text) == text ? text : nil
    }
}
