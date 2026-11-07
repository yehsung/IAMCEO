import Foundation

/// The one place that spells the shell command joining a member's CLI terminal. The drawer's
/// "터미널 명령 복사" and the terminal sheet use it, so every copy carries the same home and quoting.
enum TerminalCommand {
    /// `[IAMCEO_HOME=<home>] <cli> attach <member>`. `cli` comes from the server already shell-quoted (it may be
    /// `bun <path>/iamceo.ts`), so it is used as is; the home and the member id are quoted here. The home is the server's
    /// own (`IAMCEO_HOME`), so `attach` reads the same config and port as the server that runs the session.
    static func attach(cli: String, memberID: String, home: String) -> String {
        let base = "\(cli) attach \(shellQuote(memberID))"
        let trimmedHome = home.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmedHome.isEmpty ? base : "IAMCEO_HOME=\(shellQuote(trimmedHome)) \(base)"
    }

    /// The same command from the server's bootstrap; plain `iamceo` with no home until the bootstrap has loaded.
    static func attach(memberID: String, bootstrap: Bootstrap?) -> String {
        attach(cli: bootstrap?.cli ?? "iamceo", memberID: memberID, home: bootstrap?.home ?? "")
    }

    /// Same quoting as the web `shellQuote`: bare when safe, else single-quoted.
    static func shellQuote(_ value: String) -> String {
        let safe = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-./:=@")
        if !value.isEmpty, value.unicodeScalars.allSatisfy({ safe.contains($0) }) { return value }
        return "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
