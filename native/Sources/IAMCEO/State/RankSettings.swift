import Foundation

enum RankSettingsCLI: String, CaseIterable {
    case claude, codex

    var title: String { self == .codex ? "Codex" : "Claude" }
    var models: [String] {
        self == .codex ? ["gpt-6.1-sol", "gpt-6-luna", "gpt-6.1-terra", "gpt-6-astra"] : ["fable", "opus", "sonnet", "haiku"]
    }
    var efforts: [String] {
        self == .codex ? ["minimal", "low", "medium", "high", "xhigh"] : ["low", "medium", "high", "xhigh", "max"]
    }
    var ranksKeyPath: WritableKeyPath<Settings, [String: RankConfig]> {
        self == .codex ? \.codexRanks : \.ranks
    }
}

/// Shared by the settings editor and team configuration display.
extension Settings {
    func rankConfig(_ rank: String, cli: RankSettingsCLI) -> RankConfig? {
        self[keyPath: cli.ranksKeyPath][rank]
    }

    func memberConfig(_ member: Member) -> RankConfig {
        let defaults = rankConfig(member.kind == "worker" ? "lead" : "manager", cli: member.cli == "codex" ? .codex : .claude)
        return RankConfig(model: member.modelOverride ?? defaults?.model, effort: member.effortOverride ?? defaults?.effort)
    }
}

enum RankSettingsEditing {
    static let ranks = ["manager", "lead", "staff"]

    static func modelError(_ value: String, custom: Bool, title: String) -> String? {
        let value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return custom ? "\(title) 모델 이름을 넣어 주세요" : nil }
        if value.range(of: #"^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,127}$"#, options: .regularExpression) == nil {
            return "\(title) 모델 이름이 잘못되었습니다. 영문·숫자와 . _ : - [ ] 만 씁니다."
        }
        return nil
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
