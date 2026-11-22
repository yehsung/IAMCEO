import Foundation

/// 팀장이 쓰는 CLI. rawValue 는 서버의 cli 값이다(shared/types.ts CliProvider).
/// 갈래는 모두 switch 로 쓴다: CLI 를 더하면 컴파일러가 빠진 곳을 알려 준다(`== .codex ? … : …` 꼴로 쓰면 새 CLI 가 Claude 로 흘러간다).
enum RankSettingsCLI: String, CaseIterable {
    case claude, codex, gemini

    /// 서버가 준 cli 값에서. 이 앱이 모르는 값은 nil 이다(Claude 로 읽지 않는다).
    init?(cli: String) { self.init(rawValue: cli) }

    var title: String {
        switch self {
        case .claude: "Claude"
        case .codex: "Codex"
        case .gemini: "Gemini"
        }
    }
    /// 서버의 모델 목록을 받기 전에 쓰는 기본 이름들.
    var models: [String] {
        switch self {
        case .claude: ["fable", "opus", "sonnet", "haiku"]
        case .codex: ["gpt-6.1-sol", "gpt-6-luna", "gpt-6.1-terra", "gpt-6-astra"]
        case .gemini: ["gemini-4-neon", "gemini-4-argon", "gemini-4-hydrogen", "gemini-3.8-flash"]
        }
    }
    var efforts: [String] {
        switch self {
        case .claude: ["low", "medium", "high", "xhigh", "max"]
        case .codex: ["minimal", "low", "medium", "high", "xhigh"]
        // Antigravity CLI(`agy --effort`)가 받는 값. 모델마다 고를 수 있는 값은 더 적다(모델 목록의 efforts 가 기준).
        case .gemini: ["low", "medium", "high", "xhigh", "max"]
        }
    }
    var ranksKeyPath: WritableKeyPath<Settings, [String: RankConfig]> {
        switch self {
        case .claude: \.ranks
        case .codex: \.codexRanks
        case .gemini: \.geminiRankTable
        }
    }
    /// 설정 화면이 이 CLI 에 보이는 직급. Antigravity CLI 는 서브에이전트의 모델을 따로 줄 길이 없어 staff 줄이 없다.
    var editableRanks: [String] {
        switch self {
        case .claude, .codex: ["manager", "lead", "staff"]
        case .gemini: ["manager", "lead"]
        }
    }
    /// 모델을 정해야만 effort 를 고를 수 있는가. Antigravity CLI 는 모델 없이 `--effort` 만 받으면 그 사용자의 기본 모델로 판정해,
    /// 그 모델이 받지 않는 값이면 뜨지 못한다(실측). 서버도 Gemini 의 '모델 없음 + effort' 를 거절한다.
    /// Claude·Codex 는 예전 그대로 모델을 정하지 않고도 effort 를 고른다.
    var effortNeedsModel: Bool {
        switch self {
        case .claude, .codex: false
        case .gemini: true
        }
    }
    /// IAMCEO 가 문맥 압축을 요청할 수 있는가. Antigravity CLI 는 스스로 압축하고, 서버는 요청을 거절한다(unsupported).
    var compacts: Bool {
        switch self {
        case .claude, .codex: true
        case .gemini: false
        }
    }
    /// 같은 CLI 에서 모델·effort 만 바꾸면 같은 대화를 이어 연다고 안내하는가(팀장 실행 설정의 문구).
    /// Codex 는 예전부터 '새 세션'으로 안내한다. Gemini 는 서버가 `agy --conversation <id>` 로 같은 대화를 연다.
    var resumesOnConfigChange: Bool {
        switch self {
        case .claude, .gemini: true
        case .codex: false
        }
    }
    /// 앱에서 이 CLI 의 계정으로 로그인할 수 있는가(AI 계정 화면, 사용 한도 카드의 '다른 계정으로 로그인').
    /// 0.2.10 부터 Antigravity CLI 도 된다(서버가 `agy acp --login` 을 띄운다). 그 서버가 아니면 로그인 시트가 서버의 답(409 등)을 그대로 보인다.
    var signsInFromApp: Bool {
        switch self {
        case .claude, .codex, .gemini: true
        }
    }
    /// 세션 id 로 그 대화를 다시 여는 터미널 명령의 앞부분(뒤에 세션 id 가 붙는다).
    /// Gemini 의 실행 파일은 `agy` 다. `gemini` 는 옛 Gemini CLI 라 쓰지 않는다.
    var resumeCommand: String {
        switch self {
        case .claude: "claude --resume"
        case .codex: "codex resume"
        case .gemini: "agy --conversation"
        }
    }
}

/// CLI 가 깔려 있는지(서버의 실행 환경 응답으로).
enum CLIInstall {
    /// 깔려 있지 않다고 아는가. 실행 환경을 아직 못 읽었으면 false(모른다).
    /// Claude·Codex 는 서버가 미설치라고 알려 줄 때만이다. Gemini 는 서버가 깔려 있을 때만 그 줄을 보내므로, 줄이 없으면 미설치다.
    static func missing(_ cli: String, runtime: RuntimeDiagnostics?) -> Bool {
        guard let runtime else { return false }
        switch RankSettingsCLI(cli: cli) {
        case .gemini: return runtime.providers[cli]?.installed != true
        case .claude, .codex, nil: return runtime.providers[cli]?.installed == false
        }
    }
}

/// Shared by the settings editor and team configuration display.
extension Settings {
    func rankConfig(_ rank: String, cli: RankSettingsCLI) -> RankConfig? {
        self[keyPath: cli.ranksKeyPath][rank]
    }

    /// 직급의 모델을 고른다(설정 화면의 모델 메뉴). 모델을 정해야 effort 를 고르는 CLI(Gemini)는 모델을 기본값으로 되돌리면
    /// 고른 effort 도 기본값으로 되돌린다(RankSettingsEditing.effort): 저장 요청에 effort 를 비우는 값이 함께 실린다.
    /// Claude·Codex 는 예전 그대로 모델만 바뀐다.
    mutating func setRankModel(_ model: String?, rank: String, cli: RankSettingsCLI) {
        var config = rankConfig(rank, cli: cli) ?? RankConfig()
        config.model = model
        config.effort = RankSettingsEditing.effort(config.effort, afterModel: model, cli: cli)
        self[keyPath: cli.ranksKeyPath][rank] = config
    }

    func memberConfig(_ member: Member) -> RankConfig {
        // 이 앱이 모르는 CLI 에는 직급 기본값을 붙이지 않는다(다른 CLI 의 모델 이름이 그 팀장의 것으로 보이지 않게). 팀장에 따로 정한 값만 남는다.
        let defaults = RankSettingsCLI(cli: member.cli).flatMap { rankConfig(member.kind == "worker" ? "lead" : "manager", cli: $0) }
        return RankConfig(model: member.modelOverride ?? defaults?.model, effort: member.effortOverride ?? defaults?.effort)
    }
}

enum RankSettingsEditing {
    static let ranks = ["manager", "lead", "staff"]

    static func modelError(_ value: String, custom: Bool, title: String) -> String? {
        let value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return custom ? String(localized: "\(title) 모델 이름을 넣어 주세요") : nil }
        if value.range(of: #"^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,127}$"#, options: .regularExpression) == nil {
            return String(localized: "\(title) 모델 이름이 잘못되었습니다. 영문·숫자와 . _ : - [ ] 만 씁니다.")
        }
        return nil
    }

    /// 모델을 `model` 로 고른 뒤에 남길 effort(`model` 은 실제로 쓰일 모델: 팀장에 정한 것이 없으면 직급의 모델).
    /// 모델을 정해야 effort 를 고르는 CLI(Gemini)는 모델이 기본값(없음)이 되면 고른 effort 도 기본값(nil)으로 되돌린다.
    /// 그대로 두면 고를 수 없는 값이 남고, 서버가 저장을 거절한다. 그 밖(Claude·Codex, 이 앱이 모르는 CLI, 모델이 정해진 Gemini)은 그대로다.
    static func effort(_ effort: String?, afterModel model: String?, cli: RankSettingsCLI?) -> String? {
        guard let cli, cli.effortNeedsModel, (model ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return effort }
        return nil
    }

    /// 팀장 실행 설정에서 CLI 나 모델을 고른 뒤에 남길 effort("" 는 직급 기본값). 팀장에 정한 모델(`model`)이 없으면 직급의 모델(`rankModel`)이
    /// 쓰인다: 둘 다 없을 때만 위 규칙으로 effort 를 되돌린다.
    static func memberEffort(_ effort: String, model: String, rankModel: String?, cli: RankSettingsCLI?) -> String {
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
        return self.effort(effort.isEmpty ? nil : effort, afterModel: trimmed.isEmpty ? rankModel : trimmed, cli: cli) ?? ""
    }

    static func signature(_ settings: Settings) -> [String] {
        RankSettingsCLI.allCases.flatMap { cli in
            ranks.map { rank in
                let config = settings.rankConfig(rank, cli: cli)
                return "\(cli.rawValue).\(rank)=\((config?.model ?? "").trimmingCharacters(in: .whitespacesAndNewlines))/\(config?.effort ?? "")"
            }
        }
    }

    /// Preserve concurrent server changes to leaves the editor did not touch.
    static func rebase(previous: Settings, mine: Settings, onto server: Settings) -> Settings {
        var next = server
        for cli in RankSettingsCLI.allCases {
            for rank in ranks {
                let before = previous.rankConfig(rank, cli: cli), after = mine.rankConfig(rank, cli: cli)
                var config = next.rankConfig(rank, cli: cli) ?? RankConfig()
                if after?.model != before?.model { config.model = after?.model }
                if after?.effort != before?.effort { config.effort = after?.effort }
                next[keyPath: cli.ranksKeyPath][rank] = config
            }
        }
        return next
    }
}
