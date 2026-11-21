import Foundation

struct ModelOption: Decodable, Sendable, Equatable, Identifiable {
    let value: String
    let label: String
    var description: String? = nil
    let efforts: [String]
    var defaultEffort: String? = nil
    var id: String { value }
}

struct ModelList: Decodable, Sendable, Equatable {
    let models: [ModelOption]
    let source: String
    var updatedAt: String? = nil

    func option(for value: String) -> ModelOption? {
        if let exact = models.first(where: { $0.value == value }) { return exact }
        // Older IAMCEO settings used the short alias for Claude's additional option.
        if value == "fable" { return models.first { $0.label.lowercased() == "fable" } }
        return nil
    }

    func unknownCurrent(_ value: String) -> String? {
        !value.isEmpty && option(for: value) == nil ? String(localized: "\(value) · 목록에 없음") : nil
    }

    func efforts(for value: String, cli: RankSettingsCLI) -> [String] {
        if let option = option(for: value), !option.efforts.isEmpty { return option.efforts }
        switch cli {
        case .claude, .codex: return cli.efforts
        // Antigravity CLI 의 effort 는 모델마다 정해져 있다. effort 가 없는 모델(orchestrator 등)은 고를 값이 없다.
        // 모델을 정하지 않았을 때(빈 값, 목록에 없는 값)도 고를 값이 없다: 모델 없이 `--effort` 만 주면 agy 가 그 사용자의 기본 모델로
        // 판정해, 그 모델이 받지 않는 값이면 뜨지 못한다(실측: 기본 모델 gemini-4-neon 에 max). 서버도 그 조합을 거절한다.
        case .gemini: return []
        }
    }
}

struct ModelCatalog: Decodable, Sendable, Equatable {
    let claude: ModelList
    let codex: ModelList
    /// Gemini(Antigravity CLI)의 목록. 이 키를 보내지 않는 서버(0.2.9 까지)는 Gemini 를 모른다: nil 이고, Gemini 를 고르는 칸을 보이지 않는다.
    let gemini: ModelList?

    init(claude: ModelList, codex: ModelList, gemini: ModelList? = nil) {
        self.claude = claude; self.codex = codex; self.gemini = gemini
    }

    private enum CodingKeys: String, CodingKey { case claude, codex, gemini }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        claude = try c.decode(ModelList.self, forKey: .claude)
        codex = try c.decode(ModelList.self, forKey: .codex)
        // 모양이 어긋난 gemini 목록 때문에 Claude·Codex 목록까지 잃지 않는다: 없는 것으로 읽는다.
        gemini = c.lenient(ModelList.self, forKey: .gemini)
    }

    /// 서버가 이 CLI 를 아는가(고르는 칸에 늘어놓을지). Claude·Codex 는 늘 안다. Gemini 는 모델 목록에 그 키가 있을 때다.
    func offers(_ cli: RankSettingsCLI) -> Bool {
        switch cli {
        case .claude, .codex: true
        case .gemini: gemini != nil
        }
    }
    var offeredCLIs: [RankSettingsCLI] { RankSettingsCLI.allCases.filter(offers) }

    func list(for cli: RankSettingsCLI) -> ModelList {
        switch cli {
        case .claude: claude
        case .codex: codex
        // 목록을 받기 전에 Gemini 팀장을 그려야 할 때만 기본 목록을 쓴다.
        case .gemini: gemini ?? Self.geminiDefault
        }
    }

    /// Antigravity CLI 의 기본 모델들(서버가 `agy models` 결과를 받기 전에 쓰기로 한 목록과 같은 값).
    static let geminiDefault = ModelList(models: [
        ModelOption(value: "gemini-4-neon", label: "Gemini 4 Neon", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium"),
        ModelOption(value: "gemini-4-argon", label: "Gemini 4 Argon", efforts: ["low", "medium", "high"], defaultEffort: "medium"),
        ModelOption(value: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium"),
        ModelOption(value: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"], defaultEffort: "medium"),
    ], source: "default")

    /// 모델 목록을 못 받았을 때(옛 서버의 404 포함). Gemini 는 없다: 서버가 안다고 알려 주기 전에는 고르는 칸에 넣지 않는다.
    static let fallback = ModelCatalog(
        claude: ModelList(models: ["opus", "sonnet", "haiku"].map {
            ModelOption(value: $0, label: $0.capitalized, efforts: RankSettingsCLI.claude.efforts)
        }, source: "default"),
        codex: ModelList(models: RankSettingsCLI.codex.models.map {
            ModelOption(value: $0, label: $0, efforts: RankSettingsCLI.codex.efforts)
        }, source: "default")
    )
}
