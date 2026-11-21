import Foundation

/// 서버와 실행 환경에 따라 달라지는 CLI 사정. CLI 를 고르는 화면들(새 팀장, 팀장 실행 설정, 새 프로젝트, 직급 설정)이 같은 규칙을 쓴다.
/// 규칙 자체는 ModelCatalog.offers 와 CLIInstall.missing 에 있다(저장소 없이 시험할 수 있게).
extension AppStore {
    /// CLI 를 고르는 칸에 늘어놓을 것. Gemini 는 서버가 안다고 알려 줄 때만 들어간다(모델 목록에 gemini 가 있다).
    var offeredCLIs: [RankSettingsCLI] { modelCatalog.offeredCLIs }
    /// 실행 호스트에 깔려 있지 않다고 아는가.
    func cliMissing(_ cli: String) -> Bool { CLIInstall.missing(cli, runtime: runtime) }
    /// CLI 를 고르는 칸 아래에 적는 한 줄: 그 칸들 가운데 깔려 있지 않은 것("Gemini · 설치 필요"). 없으면 nil.
    /// 예전에는 칸 안에 'Codex CLI · 설치 필요'로 적었다. 세 칸이 iPhone 폭에 들어가게 칸에는 짧은 이름만 두고 이 줄로 옮겼다.
    func missingCLINote(_ choices: [String]) -> String? { CLIInstall.missingNote(choices, runtime: runtime) }
}

extension CLIInstall {
    /// 고를 수 있는 CLI 들 가운데 깔려 있지 않은 것을 적은 한 줄("Codex·Gemini · 설치 필요"). 없으면 nil.
    /// (화면 이름을 쓰는 글이라 RankSettings.swift 가 아니라 여기 둔다. 그 파일은 출시본 호환 게이트가 해석 코드만으로 따로 빌드한다.)
    static func missingNote(_ choices: [String], runtime: RuntimeDiagnostics?) -> String? {
        let names = choices.filter { missing($0, runtime: runtime) }.map(providerName).joined(separator: "·")
        return names.isEmpty ? nil : String(localized: "\(names) · 설치 필요")
    }
}
