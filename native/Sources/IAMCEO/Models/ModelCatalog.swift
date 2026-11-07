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
        !value.isEmpty && option(for: value) == nil ? "\(value) · 목록에 없음" : nil
    }

    func efforts(for value: String, cli: RankSettingsCLI) -> [String] {
        guard let option = option(for: value), !option.efforts.isEmpty else { return cli.efforts }
        return option.efforts
    }
}

struct ModelCatalog: Decodable, Sendable, Equatable {
    let claude: ModelList
    let codex: ModelList

    func list(for cli: RankSettingsCLI) -> ModelList { cli == .codex ? codex : claude }

    static let fallback = ModelCatalog(
        claude: ModelList(models: ["opus", "sonnet", "haiku"].map {
            ModelOption(value: $0, label: $0.capitalized, efforts: RankSettingsCLI.claude.efforts)
        }, source: "default"),
        codex: ModelList(models: RankSettingsCLI.codex.models.map {
            ModelOption(value: $0, label: $0, efforts: RankSettingsCLI.codex.efforts)
        }, source: "default")
    )
    static let demo = ModelCatalog(
        claude: ModelList(models: fallback.claude.models + [
            ModelOption(value: "claude-fable-5-1[1m]", label: "Fable", description: "샘플 모델", efforts: RankSettingsCLI.claude.efforts)
        ], source: "default"), codex: fallback.codex
    )
}
