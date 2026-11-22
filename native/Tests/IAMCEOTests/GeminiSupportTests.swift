import Foundation
import os
import SwiftUI
import XCTest
@testable import IAMCEO
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// 0.2.10: 세 번째 CLI Gemini(Google Antigravity CLI, 실행 파일 `agy`). 서버의 cli 값은 "gemini" 다.
/// - Gemini 를 모르는 서버(0.2.9 까지: 모델 목록에 gemini 가 없고 설정에 geminiRanks 가 없다)에 붙어도 Claude·Codex 가 예전 그대로다.
/// - Gemini 의 값이 Claude 칸으로 새지 않는다(직급표, 모델 목록, effort, 이름).
/// - 이 앱이 모르는 CLI 값은 Claude 로 읽지 않는다.
@MainActor final class GeminiSupportTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }
    private func object(_ value: some Encodable) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
    }

    // MARK: 직급 설정의 CLI

    func testGeminiIsAThirdCLIWithItsOwnValues() {
        XCTAssertEqual(RankSettingsCLI.allCases, [.claude, .codex, .gemini], "화면에 늘어놓는 순서")
        XCTAssertEqual(RankSettingsCLI(cli: "gemini"), .gemini)
        XCTAssertEqual(RankSettingsCLI.gemini.rawValue, "gemini", "서버에 보내는 cli 값")
        XCTAssertNil(RankSettingsCLI(cli: "agy"), "실행 파일 이름은 cli 값이 아니다")
        XCTAssertNil(RankSettingsCLI(cli: "something_new"), "모르는 값을 Claude 로 읽지 않는다")
        XCTAssertNil(RankSettingsCLI(cli: ""))

        XCTAssertEqual(RankSettingsCLI.gemini.title, "Gemini")
        XCTAssertEqual(RankSettingsCLI.gemini.efforts, ["low", "medium", "high", "xhigh", "max"])
        XCTAssertEqual(RankSettingsCLI.gemini.models, ["gemini-4-neon", "gemini-4-argon", "gemini-4-hydrogen", "gemini-3.8-flash"])
        // 서브에이전트(staff) 줄은 Gemini 에 없다.
        XCTAssertEqual(RankSettingsCLI.gemini.editableRanks, ["manager", "lead"])
        XCTAssertEqual(RankSettingsCLI.claude.editableRanks, ["manager", "lead", "staff"])
        XCTAssertEqual(RankSettingsCLI.codex.editableRanks, ["manager", "lead", "staff"])
        // Claude·Codex 의 값은 그대로다.
        XCTAssertEqual(RankSettingsCLI.claude.title, "Claude")
        XCTAssertEqual(RankSettingsCLI.codex.title, "Codex")
        XCTAssertEqual(RankSettingsCLI.claude.models, ["fable", "opus", "sonnet", "haiku"])
        XCTAssertEqual(RankSettingsCLI.claude.efforts, ["low", "medium", "high", "xhigh", "max"])
        XCTAssertEqual(RankSettingsCLI.codex.efforts, ["minimal", "low", "medium", "high", "xhigh"])
    }

    func testFeaturesThatDifferByCLI() {
        // 앱에서 로그인: Gemini 는 없다(사용 한도 카드의 '다른 계정으로 로그인' 단추가 이 값으로 갈린다).
        XCTAssertEqual(RankSettingsCLI.allCases.map(\.signsInFromApp), [true, true, false])
        XCTAssertNil(RankSettingsCLI(cli: "something_new")?.signsInFromApp, "모르는 CLI 에도 로그인 단추를 내지 않는다")
        // 모델·effort 만 바꿀 때 '같은 대화를 이어 연다'고 안내하는 CLI. Codex 는 예전 그대로 새 세션 안내다.
        XCTAssertEqual(RankSettingsCLI.allCases.map(\.resumesOnConfigChange), [true, false, true])
        // 터미널에서 그 대화를 다시 여는 명령. Gemini 는 agy 다(gemini 는 옛 Gemini CLI).
        XCTAssertEqual(RankSettingsCLI.claude.resumeCommand, "claude --resume")
        XCTAssertEqual(RankSettingsCLI.codex.resumeCommand, "codex resume")
        XCTAssertEqual(RankSettingsCLI.gemini.resumeCommand, "agy --conversation")
        XCTAssertFalse(RankSettingsCLI.gemini.resumeCommand.hasPrefix("gemini"))
    }

    // MARK: 설정(직급표)

    /// 옛 서버의 설정에는 geminiRanks 가 없다. 그 설정을 통째로 되돌려 보낼 때(옛 서버의 저장) 모르는 칸을 싣지 않는다.
    func testSettingsFromAnOlderServerKeepNoGeminiRanks() throws {
        var old = try decode(Settings.self, #"{"ranks":{"lead":{"model":"sonnet","effort":"max"}},"codexRanks":{"lead":{"model":"gpt-6-luna","effort":"low"}}}"#)
        XCTAssertNil(old.geminiRanks)
        XCTAssertTrue(old.geminiRankTable.isEmpty, "없으면 빈 표(전부 CLI 기본값)로 읽는다")
        XCTAssertNil(old.rankConfig("lead", cli: .gemini))
        XCTAssertEqual(old.ranks["lead"]?.model, "sonnet")
        XCTAssertEqual(old.codexRanks["lead"]?.model, "gpt-6-luna")
        XCTAssertNil(try object(old)["geminiRanks"], "옛 서버의 엄격한 설정 저장이 모르는 칸 때문에 통째로 거절되지 않는다")

        // 그 서버에 보낼 수 없는 값이라 써도 남지 않는다(직급 편집·충돌 정리가 표마다 도는 반복이 옛 서버 설정에 칸을 만들지 않는다).
        old[keyPath: RankSettingsCLI.gemini.ranksKeyPath]["lead"] = RankConfig(model: "gemini-4-neon", effort: "high")
        XCTAssertNil(old.geminiRanks)
        let rebased = RankSettingsEditing.rebase(previous: old, mine: old, onto: old)
        XCTAssertNil(rebased.geminiRanks)
        XCTAssertNil(try object(rebased)["geminiRanks"])
        XCTAssertEqual(rebased.ranks["lead"]?.model, "sonnet")
        XCTAssertNil(try object(AppStore.settingsPatch(base: old, draft: rebased))["geminiRanks"])
        // 손으로 만든 빈 설정도 같다.
        XCTAssertNil(try object(Settings())["geminiRanks"])
    }

    func testSettingsWithGeminiRanksDecodeAndRoundTrip() throws {
        let settings = try decode(Settings.self, #"{"ranks":{"lead":{"model":"sonnet","effort":"max"}},"geminiRanks":{"manager":{"model":null,"effort":null},"lead":{"model":"gemini-4-neon","effort":"high"},"staff":{"model":null,"effort":null}}}"#)
        XCTAssertEqual(settings.geminiRanks?["lead"]?.model, "gemini-4-neon")
        XCTAssertEqual(settings.rankConfig("lead", cli: .gemini), RankConfig(model: "gemini-4-neon", effort: "high"))
        XCTAssertNil(settings.rankConfig("manager", cli: .gemini)?.model)
        XCTAssertEqual(settings.rankConfig("lead", cli: .claude)?.model, "sonnet", "Claude 직급표는 따로다")
        let again = try JSONDecoder().decode(Settings.self, from: JSONEncoder().encode(settings))
        XCTAssertEqual(again, settings)
        // 서버가 기본값만 보낸 표(전부 null)도 '있는' 표다: 써진다.
        var blank = try decode(Settings.self, #"{"geminiRanks":{}}"#)
        XCTAssertNotNil(blank.geminiRanks)
        blank[keyPath: RankSettingsCLI.gemini.ranksKeyPath]["lead"] = RankConfig(model: "gemini-4-argon", effort: nil)
        XCTAssertEqual(blank.geminiRanks?["lead"]?.model, "gemini-4-argon")
        // 모양이 어긋난 gemini 표 때문에 설정 전체를 잃지 않는다(없는 것으로 읽는다).
        let odd = try decode(Settings.self, #"{"ranks":{"lead":{"model":"opus","effort":null}},"geminiRanks":[]}"#)
        XCTAssertNil(odd.geminiRanks)
        XCTAssertEqual(odd.ranks["lead"]?.model, "opus")
    }

    /// Gemini 직급을 고치면 geminiRanks 로만 간다. Claude·Codex 직급표를 덮어쓰지 않는다.
    func testEditingAGeminiRankWritesOnlyGeminiRanks() throws {
        let base = Settings(ranks: ["lead": RankConfig(model: "sonnet", effort: "max")],
                            codexRanks: ["lead": RankConfig(model: "gpt-6-luna", effort: "low")],
                            geminiRanks: ["manager": RankConfig(), "lead": RankConfig(), "staff": RankConfig()])
        var draft = base
        draft[keyPath: RankSettingsCLI.gemini.ranksKeyPath]["lead"] = RankConfig(model: "gemini-4-neon", effort: nil)
        XCTAssertEqual(draft.ranks, base.ranks)
        XCTAssertEqual(draft.codexRanks, base.codexRanks)
        XCTAssertEqual(draft.geminiRanks?["lead"]?.model, "gemini-4-neon")
        XCTAssertNotEqual(RankSettingsEditing.signature(base), RankSettingsEditing.signature(draft), "고친 것이 저장할 변경으로 잡힌다")

        let patch = try object(AppStore.settingsPatch(base: base, draft: draft))
        XCTAssertEqual(Set(patch.keys), ["geminiRanks"])
        let ranks = try XCTUnwrap(patch["geminiRanks"] as? [String: [String: Any]])
        XCTAssertEqual(Set(ranks.keys), ["lead"], "고친 직급만")
        XCTAssertEqual(Set(ranks["lead"]!.keys), ["model"], "고친 칸만")
        XCTAssertEqual(ranks["lead"]?["model"] as? String, "gemini-4-neon")

        // 되돌리면(null) 비우는 값이 명시돼 간다.
        var cleared = draft
        cleared[keyPath: RankSettingsCLI.gemini.ranksKeyPath]["lead"]?.model = nil
        let undo = try object(AppStore.settingsPatch(base: draft, draft: cleared))
        XCTAssertTrue((undo["geminiRanks"] as? [String: [String: Any]])?["lead"]?["model"] is NSNull)
    }

    /// 패치 계산을 CLI 표로 돌게 바꿨다: Claude·Codex 직급의 패치는 예전과 같은 모양이다.
    func testClaudeAndCodexPatchesAreUnchanged() throws {
        let base = Settings(ranks: ["lead": RankConfig(model: "sonnet", effort: "max")],
                            codexRanks: ["lead": RankConfig(model: "gpt-6-astra", effort: "high"), "staff": RankConfig(model: "gpt-6-luna", effort: "minimal")],
                            geminiRanks: ["lead": RankConfig()])
        var draft = base
        draft.ranks["lead"]?.effort = nil
        draft.ranks["manager"] = RankConfig(model: "opus", effort: nil)
        draft.codexRanks["staff"]?.model = "gpt-6.1-terra"
        let patch = try object(AppStore.settingsPatch(base: base, draft: draft))
        XCTAssertEqual(Set(patch.keys), ["ranks", "codexRanks"])
        let ranks = try XCTUnwrap(patch["ranks"] as? [String: [String: Any]])
        XCTAssertEqual(Set(ranks.keys), ["lead", "manager"])
        XCTAssertEqual(Set(ranks["lead"]!.keys), ["effort"])
        XCTAssertTrue(ranks["lead"]?["effort"] is NSNull)
        XCTAssertEqual(ranks["manager"]?["model"] as? String, "opus")
        XCTAssertNil(ranks["manager"]?["effort"], "없던 줄을 만들 때 비어 있는 칸은 싣지 않는다")
        let codex = try XCTUnwrap(patch["codexRanks"] as? [String: [String: Any]])
        XCTAssertEqual(Set(codex.keys), ["staff"])
        XCTAssertEqual(codex["staff"]?["model"] as? String, "gpt-6.1-terra")
        XCTAssertEqual(try object(AppStore.settingsPatch(base: base, draft: base)).count, 0, "바뀐 것이 없으면 빈 요청")
        // 요청 모양: geminiRanks 는 codexRanks 와 같은 꼴로 실린다.
        let request = try object(SettingsPatchRequest(geminiRanks: ["lead": RankConfigPatch(model: .null), "manager": RankConfigPatch(effort: .value("high"))]))
        XCTAssertEqual(Set(request.keys), ["geminiRanks"])
    }

    func testConflictReviewKeepsGeminiLeavesApart() {
        let base = Settings(ranks: ["lead": RankConfig(model: "sonnet", effort: "high")],
                            geminiRanks: ["lead": RankConfig(model: "gemini-4-neon", effort: "high"), "manager": RankConfig(model: "gemini-4-argon", effort: nil)])
        var mine = base
        mine[keyPath: RankSettingsCLI.gemini.ranksKeyPath]["lead"]?.model = "gemini-3.8-flash"
        var server = base
        server.geminiRanks?["lead"]?.effort = "low"
        server.geminiRanks?["manager"]?.model = "gemini-4-hydrogen"
        server.ranks["lead"]?.model = "opus"
        let reviewed = RankSettingsEditing.rebase(previous: base, mine: mine, onto: server)
        XCTAssertEqual(reviewed.geminiRanks?["lead"], RankConfig(model: "gemini-3.8-flash", effort: "low"), "내가 고친 칸과 서버가 고친 칸이 함께 남는다")
        XCTAssertEqual(reviewed.geminiRanks?["manager"]?.model, "gemini-4-hydrogen")
        XCTAssertEqual(reviewed.ranks["lead"]?.model, "opus")
    }

    // MARK: 팀장의 직급 기본값

    func testMemberConfigUsesTheRanksOfItsOwnCLI() {
        let settings = Settings(ranks: ["manager": RankConfig(model: "opus", effort: "max"), "lead": RankConfig(model: "sonnet", effort: "max")],
                                codexRanks: ["lead": RankConfig(model: "gpt-6-luna", effort: "low")],
                                geminiRanks: ["manager": RankConfig(model: "gemini-4-neon", effort: "xhigh"), "lead": RankConfig(model: "gemini-3.8-flash", effort: "high")])
        var member = Member(id: "m", kind: "worker", cli: "gemini")
        XCTAssertEqual(settings.memberConfig(member), RankConfig(model: "gemini-3.8-flash", effort: "high"))
        member.kind = "conductor"
        XCTAssertEqual(settings.memberConfig(member), RankConfig(model: "gemini-4-neon", effort: "xhigh"), "총괄은 manager 직급")
        member.modelOverride = "gemini-4-argon"
        XCTAssertEqual(settings.memberConfig(member), RankConfig(model: "gemini-4-argon", effort: "xhigh"), "팀장에 정한 값이 먼저")
        // Gemini 직급을 비워 둔 설정(기본): Claude 직급으로 떨어지지 않는다.
        let blank = Settings(ranks: ["lead": RankConfig(model: "sonnet", effort: "max")], geminiRanks: [:])
        XCTAssertEqual(blank.memberConfig(Member(id: "m", kind: "worker", cli: "gemini")), RankConfig())
        // Gemini 를 모르는 서버의 설정에서도 같다(그런 서버에 gemini 팀장은 없지만, Claude 값을 빌리지 않는다).
        let old = Settings(ranks: ["lead": RankConfig(model: "sonnet", effort: "max")])
        XCTAssertEqual(old.memberConfig(Member(id: "m", kind: "worker", cli: "gemini")), RankConfig())
        // 이 앱이 모르는 CLI: 직급 기본값을 붙이지 않고, 팀장에 정한 값만 남긴다.
        var unknown = Member(id: "u", kind: "worker", cli: "something_new")
        XCTAssertEqual(settings.memberConfig(unknown), RankConfig(), "예전에는 Claude 직급(sonnet)이 보였다")
        unknown.modelOverride = "its-own-model"
        XCTAssertEqual(settings.memberConfig(unknown).model, "its-own-model")
        // Claude·Codex 는 그대로다.
        XCTAssertEqual(settings.memberConfig(Member(id: "c", kind: "worker", cli: "claude")).model, "sonnet")
        XCTAssertEqual(settings.memberConfig(Member(id: "x", kind: "worker", cli: "codex")).model, "gpt-6-luna")
    }

    // MARK: 모델 목록

    private static let oldCatalog = #"{"claude":{"source":"cli","models":[{"value":"opus","label":"Opus","efforts":["high","max"]}]},"codex":{"source":"cli","models":[{"value":"new-codex","label":"New Codex","efforts":["low","xhigh"],"defaultEffort":"xhigh"}]}}"#
    private static let geminiList = #"{"source":"cli","updatedAt":"2026-11-21T00:00:00Z","models":[{"value":"gemini-4-neon","label":"Gemini 4 Neon","efforts":["low","medium","high","xhigh"],"defaultEffort":"medium"},{"value":"gemini-pro-orchestrator-neon","label":"Orchestrator (Neon)","efforts":[]},{"value":"claude-opus-5-5","label":"Claude Opus 5.5","efforts":["low","medium","high"],"defaultEffort":"medium"}]}"#
    private static var newCatalog: String { String(oldCatalog.dropLast()) + #","gemini":"# + geminiList + "}" }

    /// 옛 서버의 모델 목록에는 gemini 가 없다: Claude·Codex 는 그대로 읽히고, Gemini 는 '없음'이라 고르는 칸에 나오지 않는다.
    func testCatalogFromAnOlderServerDecodesAndHidesGemini() throws {
        let catalog = try decode(ModelCatalog.self, Self.oldCatalog)
        XCTAssertNil(catalog.gemini, "빈 목록이 아니라 없음")
        XCTAssertEqual(catalog.claude.models.map(\.value), ["opus"])
        XCTAssertEqual(catalog.codex.models.first?.defaultEffort, "xhigh")
        XCTAssertFalse(catalog.offers(.gemini))
        XCTAssertTrue(catalog.offers(.claude) && catalog.offers(.codex))
        XCTAssertEqual(catalog.offeredCLIs, [.claude, .codex])
        // 서버에 닿기 전·옛 서버(404)의 기본 목록도 Gemini 를 내놓지 않는다.
        XCTAssertNil(ModelCatalog.fallback.gemini)
        XCTAssertEqual(ModelCatalog.fallback.offeredCLIs, [.claude, .codex])
        // 목록 없이 Gemini 팀장을 그려야 할 때만 쓰는 기본 목록.
        XCTAssertEqual(catalog.list(for: .gemini), ModelCatalog.geminiDefault)
        XCTAssertEqual(ModelCatalog.geminiDefault.models.map(\.value), RankSettingsCLI.gemini.models)
        XCTAssertEqual(ModelCatalog.geminiDefault.efforts(for: "gemini-4-argon", cli: .gemini), ["low", "medium", "high"])
        XCTAssertEqual(ModelCatalog.geminiDefault.efforts(for: "gemini-4-neon", cli: .gemini), ["low", "medium", "high", "xhigh"])
    }

    func testCatalogWithGeminiOffersItsModelsAndEfforts() throws {
        let catalog = try decode(ModelCatalog.self, Self.newCatalog)
        let gemini = try XCTUnwrap(catalog.gemini)
        XCTAssertEqual(catalog.offeredCLIs, [.claude, .codex, .gemini])
        XCTAssertEqual(catalog.list(for: .gemini), gemini)
        XCTAssertEqual(gemini.source, "cli")
        XCTAssertEqual(gemini.models.map(\.value), ["gemini-4-neon", "gemini-pro-orchestrator-neon", "claude-opus-5-5"], "agy 가 준 순서와 모델을 그대로(다른 회사 모델 포함)")
        XCTAssertEqual(gemini.efforts(for: "gemini-4-neon", cli: .gemini), ["low", "medium", "high", "xhigh"], "모델마다의 effort")
        XCTAssertEqual(gemini.efforts(for: "gemini-pro-orchestrator-neon", cli: .gemini), [], "effort 가 없는 모델은 고를 값이 없다")
        XCTAssertEqual(gemini.efforts(for: "", cli: .gemini), [], "모델을 정하지 않았으면 고를 값이 없다(아래 testGeminiWithoutAModelOffersNoEfforts)")
        XCTAssertEqual(gemini.unknownCurrent("opus"), "opus · 목록에 없음", "Claude 모델 이름은 Gemini 목록에 없다")
        XCTAssertNil(gemini.unknownCurrent("gemini-4-neon"))
        // Claude·Codex 목록은 섞이지 않는다.
        XCTAssertEqual(catalog.list(for: .claude).models.map(\.value), ["opus"])
        XCTAssertEqual(catalog.list(for: .codex).models.map(\.value), ["new-codex"])
        // effort 가 빈 모델의 예전 규칙(Claude·Codex 는 CLI 의 값 전부)은 그대로다.
        let empty = ModelList(models: [ModelOption(value: "no-efforts", label: "Empty", efforts: [])], source: "cli")
        XCTAssertEqual(empty.efforts(for: "no-efforts", cli: .codex), RankSettingsCLI.codex.efforts)
        XCTAssertEqual(empty.efforts(for: "no-efforts", cli: .claude), RankSettingsCLI.claude.efforts)
    }

    /// 모델을 정하지 않은 Gemini 에는 effort 를 고르지 못한다. 모델 없이 `--effort` 만 주면 agy 가 그 사용자의 기본 모델로 판정해,
    /// 그 모델이 받지 않는 값이면 뜨지 못한다(실측: 기본 모델 gemini-4-neon 에 max). 서버도 '모델 없음 + effort' 를 거절한다.
    /// 설정의 Gemini 직급 줄과 팀장 실행 설정은 이 목록이 비면 effort 에 '기본값'만 보인다.
    func testGeminiWithoutAModelOffersNoEfforts() throws {
        let catalog = try decode(ModelCatalog.self, Self.newCatalog)
        let gemini = catalog.list(for: .gemini)
        XCTAssertEqual(gemini.efforts(for: "", cli: .gemini), [], "모델을 정하지 않음(기본값)")
        XCTAssertEqual(gemini.efforts(for: "gemini-4-argon", cli: .gemini), [], "이 서버의 목록에 없는 모델")
        XCTAssertEqual(gemini.efforts(for: "opus", cli: .gemini), [], "다른 CLI 의 모델 이름")
        XCTAssertEqual(ModelCatalog.geminiDefault.efforts(for: "", cli: .gemini), [], "목록을 받기 전의 기본 목록도 같다")
        XCTAssertEqual(ModelCatalog.geminiDefault.efforts(for: "gemini-pro-orchestrator-neon", cli: .gemini), [])
        // 모델을 정하면 그 모델이 받는 값이다.
        XCTAssertEqual(gemini.efforts(for: "gemini-4-neon", cli: .gemini), ["low", "medium", "high", "xhigh"])
        XCTAssertEqual(gemini.efforts(for: "claude-opus-5-5", cli: .gemini), ["low", "medium", "high"])
        // Claude·Codex 는 예전 그대로다: 모델을 정하지 않았거나 목록에 없는 모델이어도 CLI 가 받는 값 전부를 고른다.
        for (list, cli) in [(catalog.claude, RankSettingsCLI.claude), (catalog.codex, .codex), (ModelCatalog.fallback.claude, .claude), (ModelCatalog.fallback.codex, .codex)] {
            XCTAssertEqual(list.efforts(for: "", cli: cli), cli.efforts, cli.rawValue)
            XCTAssertEqual(list.efforts(for: "retired-model", cli: cli), cli.efforts, cli.rawValue)
        }
        XCTAssertEqual(catalog.claude.efforts(for: "opus", cli: .claude), ["high", "max"])
        XCTAssertEqual(catalog.codex.efforts(for: "new-codex", cli: .codex), ["low", "xhigh"])
        XCTAssertEqual(RankSettingsCLI.allCases.map(\.effortNeedsModel), [false, false, true], "모델을 정해야 effort 를 고르는 CLI 는 Gemini 뿐이다")
    }

    /// 설정의 Gemini 직급에서 모델을 '기본값'으로 되돌리면 고른 effort 도 기본값으로 되돌린다: 저장 요청에 effort 를 비우는 값(null)이 실린다.
    /// 그대로 두면 고를 수 없는 값이 남고 서버가 저장을 거절한다.
    func testResettingAGeminiRankModelAlsoResetsItsEffort() throws {
        let base = Settings(ranks: ["lead": RankConfig(model: "sonnet", effort: "max")],
                            codexRanks: ["lead": RankConfig(model: "gpt-6-luna", effort: "low")],
                            geminiRanks: ["manager": RankConfig(model: "gemini-4-argon", effort: nil), "lead": RankConfig(model: "gemini-4-neon", effort: "high")])
        var draft = base
        draft.setRankModel(nil, rank: "lead", cli: .gemini)
        XCTAssertEqual(draft.geminiRanks?["lead"], RankConfig(), "모델과 effort 가 함께 기본값이 된다")
        XCTAssertEqual(draft.ranks, base.ranks)
        XCTAssertEqual(draft.codexRanks, base.codexRanks)
        let patch = try object(AppStore.settingsPatch(base: base, draft: draft))
        XCTAssertEqual(Set(patch.keys), ["geminiRanks"])
        let lead = try XCTUnwrap((patch["geminiRanks"] as? [String: [String: Any]])?["lead"])
        XCTAssertEqual(Set(lead.keys), ["model", "effort"])
        XCTAssertTrue(lead["model"] is NSNull)
        XCTAssertTrue(lead["effort"] is NSNull, "effort 를 비우는 값이 명시돼 간다")

        // effort 를 고르지 않았던 직급은 모델만 실린다.
        var manager = base
        manager.setRankModel(nil, rank: "manager", cli: .gemini)
        let managerPatch = try XCTUnwrap((try object(AppStore.settingsPatch(base: base, draft: manager))["geminiRanks"] as? [String: [String: Any]])?["manager"])
        XCTAssertEqual(Set(managerPatch.keys), ["model"])
        // 다른 모델로 바꿀 때는 effort 를 건드리지 않는다(그 모델이 받지 않는 값이면 서버가 되돌리고 알려 준다. Claude·Codex 와 같다).
        var other = base
        other.setRankModel("gemini-4-argon", rank: "lead", cli: .gemini)
        XCTAssertEqual(other.geminiRanks?["lead"], RankConfig(model: "gemini-4-argon", effort: "high"))
        // 없던 줄에 모델을 고르면 그 줄이 생긴다.
        var fresh = Settings(geminiRanks: [:])
        fresh.setRankModel("gemini-4-neon", rank: "lead", cli: .gemini)
        XCTAssertEqual(fresh.geminiRanks?["lead"], RankConfig(model: "gemini-4-neon", effort: nil))

        // Claude·Codex 는 예전 그대로다: 모델을 기본값으로 되돌려도 고른 effort 는 남는다.
        var claude = base
        claude.setRankModel(nil, rank: "lead", cli: .claude)
        XCTAssertEqual(claude.ranks["lead"], RankConfig(model: nil, effort: "max"))
        let claudePatch = try XCTUnwrap((try object(AppStore.settingsPatch(base: base, draft: claude))["ranks"] as? [String: [String: Any]])?["lead"])
        XCTAssertEqual(Set(claudePatch.keys), ["model"])
        var codex = base
        codex.setRankModel(nil, rank: "lead", cli: .codex)
        XCTAssertEqual(codex.codexRanks["lead"], RankConfig(model: nil, effort: "low"))

        // 규칙 자체.
        XCTAssertNil(RankSettingsEditing.effort("high", afterModel: nil, cli: .gemini))
        XCTAssertNil(RankSettingsEditing.effort("high", afterModel: "  ", cli: .gemini), "빈 글도 정하지 않은 것이다")
        XCTAssertEqual(RankSettingsEditing.effort("high", afterModel: "gemini-4-neon", cli: .gemini), "high")
        XCTAssertNil(RankSettingsEditing.effort(nil, afterModel: "gemini-4-neon", cli: .gemini))
        XCTAssertEqual(RankSettingsEditing.effort("max", afterModel: nil, cli: .claude), "max")
        XCTAssertEqual(RankSettingsEditing.effort("minimal", afterModel: nil, cli: .codex), "minimal")
        XCTAssertEqual(RankSettingsEditing.effort("high", afterModel: nil, cli: nil), "high", "이 앱이 모르는 CLI 의 값은 건드리지 않는다")
    }

    /// 팀장 실행 설정: 팀장에 정한 모델이 없으면 직급의 모델이 쓰인다. Gemini 에서 둘 다 없을 때만 고른 effort 를 직급 기본값("")으로 되돌린다.
    func testMemberEffortResetsOnlyWhenAGeminiMemberEndsUpWithoutAModel() {
        // 모델을 '직급 기본값'으로 되돌렸고 직급에도 모델이 없다.
        XCTAssertEqual(RankSettingsEditing.memberEffort("high", model: "", rankModel: nil, cli: .gemini), "")
        XCTAssertEqual(RankSettingsEditing.memberEffort("high", model: " ", rankModel: "", cli: .gemini), "")
        // 직급에 모델이 있으면 그 모델이 쓰인다: 고른 effort 가 남는다.
        XCTAssertEqual(RankSettingsEditing.memberEffort("high", model: "", rankModel: "gemini-4-neon", cli: .gemini), "high")
        XCTAssertEqual(RankSettingsEditing.memberEffort("high", model: "gemini-4-argon", rankModel: nil, cli: .gemini), "high")
        XCTAssertEqual(RankSettingsEditing.memberEffort("", model: "", rankModel: nil, cli: .gemini), "")
        // Claude 팀장을 Gemini 로 바꾸면(모델은 아직 기본값) Claude 에서 고른 effort 를 들고 가지 않는다.
        XCTAssertEqual(RankSettingsEditing.memberEffort("max", model: "", rankModel: nil, cli: RankSettingsCLI(cli: "gemini")), "")
        // Claude·Codex, 이 앱이 모르는 CLI 는 예전 그대로다.
        XCTAssertEqual(RankSettingsEditing.memberEffort("max", model: "", rankModel: nil, cli: .claude), "max")
        XCTAssertEqual(RankSettingsEditing.memberEffort("minimal", model: "", rankModel: nil, cli: .codex), "minimal")
        XCTAssertEqual(RankSettingsEditing.memberEffort("high", model: "", rankModel: nil, cli: RankSettingsCLI(cli: "something_new")), "high")
    }

    /// 모양이 어긋난 gemini 목록이 Claude·Codex 목록까지 못 읽게 하지 않는다.
    func testMalformedGeminiListDoesNotLoseTheOtherLists() throws {
        let catalog = try decode(ModelCatalog.self, String(Self.oldCatalog.dropLast()) + #","gemini":{"models":"none"}}"#)
        XCTAssertNil(catalog.gemini)
        XCTAssertEqual(catalog.claude.models.map(\.value), ["opus"])
        XCTAssertEqual(catalog.codex.models.map(\.value), ["new-codex"])
        XCTAssertThrowsError(try decode(ModelCatalog.self, #"{"claude":{"source":"cli","models":[]}}"#), "Claude·Codex 목록은 예전처럼 꼭 있어야 한다")
    }

    func testStoreOffersGeminiOnlyWhenTheServerListsIt() async throws {
        for (payload, expected) in [(Self.oldCatalog, [RankSettingsCLI.claude, .codex]), (Self.newCatalog, [.claude, .codex, .gemini])] {
            let fixture = try IsolatedTestNetwork { request in
                switch request.url?.path {
                case "/api/bootstrap": return IsolatedTestHTTPReply(data: Data(#"{"projects":[],"settings":{},"runtime":{"providers":{"claude":{"installed":true},"codex":{"installed":false}}}}"#.utf8))
                case "/api/models": return IsolatedTestHTTPReply(data: Data(payload.utf8))
                default: return IsolatedTestHTTPReply(status: 404, data: Data("{}".utf8))
                }
            }
            let store = AppStore(session: fixture.session, persistCredentials: false)
            XCTAssertEqual(store.offeredCLIs, [.claude, .codex], "연결 전에는 Gemini 를 내놓지 않는다")
            store.endpoint = fixture.endpoint.url.absoluteString; store.accessCode = "fixture-only"
            await store.connect()
            await store.refreshModels()
            XCTAssertEqual(store.offeredCLIs, expected)
            // 실행 환경: Codex 는 서버가 없다고 알려 줬고, Gemini 줄은 없다(= 깔려 있지 않다).
            XCTAssertFalse(store.cliMissing("claude"))
            XCTAssertTrue(store.cliMissing("codex"))
            XCTAssertTrue(store.cliMissing("gemini"))
            XCTAssertEqual(store.missingCLINote(store.offeredCLIs.map(\.rawValue)), expected.contains(.gemini) ? "Codex·Gemini · 설치 필요" : "Codex · 설치 필요")
            XCTAssertEqual(DefaultProvider.choice(in: store), "claude")
            store.disconnect()
            XCTAssertEqual(store.offeredCLIs, [.claude, .codex])
            await fixture.close()
        }
    }

    /// 샘플(앱 안의 가짜 서버, 실제 서버 응답으로 만든 자료)도 Gemini 를 안다: 고르는 칸에 나오고, Gemini 직급을 고치면 그 칸만 바뀐다.
    func testSampleWorkspaceOffersGeminiAndSavesItsRanks() async throws {
        let fixture = try IsolatedTestNetwork { _ in XCTFail("샘플은 서버에 묻지 않는다"); throw URLError(.badURL) }
        let store = AppStore(demo: true, session: fixture.session, persistCredentials: false)
        defer { store.prepareForReplacement() }
        try await waitWhile({ store.api == nil || store.bootstrap == nil }, timeout: .seconds(15))
        await store.refreshModels()
        XCTAssertEqual(store.offeredCLIs, [.claude, .codex, .gemini])
        XCTAssertEqual(store.modelCatalog.gemini?.models.map(\.value), RankSettingsCLI.gemini.models, "서버의 기본 목록")
        XCTAssertFalse(store.cliMissing("gemini"), "샘플의 실행 환경에는 Antigravity CLI 가 깔려 있다")
        XCTAssertNil(store.missingCLINote(store.offeredCLIs.map(\.rawValue)))
        XCTAssertTrue(GeminiText.usable(in: store))

        var settings = try XCTUnwrap(store.bootstrap?.settings)
        let before = settings
        XCTAssertEqual(before.geminiRanks?.keys.sorted(), ["lead", "manager", "staff"], "서버는 세 직급을 모두 싣는다(앱은 서브에이전트 줄을 보이지 않는다)")
        XCTAssertEqual(before.rankConfig("lead", cli: .gemini), RankConfig())
        settings[keyPath: RankSettingsCLI.gemini.ranksKeyPath]["lead"] = RankConfig(model: "gemini-4-neon", effort: "high")
        let saved = await store.updateSettings(settings)
        XCTAssertTrue(saved)
        let after = try XCTUnwrap(store.bootstrap?.settings)
        XCTAssertEqual(after.geminiRanks?["lead"], RankConfig(model: "gemini-4-neon", effort: "high"))
        XCTAssertEqual(after.geminiRanks?["manager"], before.geminiRanks?["manager"], "고치지 않은 직급은 그대로")
        XCTAssertEqual(after.ranks, before.ranks)
        XCTAssertEqual(after.codexRanks, before.codexRanks)
        XCTAssertNil(store.errorMessage)
        XCTAssertTrue(fixture.requests.isEmpty)
        await fixture.close()
    }

    // MARK: 새 팀장의 모델 고르기

    func testNewMemberSelectionValidatesAgainstTheGeminiList() throws {
        let catalog = try decode(ModelCatalog.self, Self.newCatalog)
        var selection = NewMemberModelSelection()
        selection.model = "opus"
        XCTAssertEqual(selection.cli, .claude)
        selection.provider = "gemini"
        XCTAssertEqual(selection.cli, .gemini)
        XCTAssertEqual(selection.model, "", "CLI 를 바꾸면 다른 CLI 의 모델을 들고 가지 않는다")
        XCTAssertTrue(selection.isValid(in: catalog))
        selection.model = "gemini-4-neon"
        XCTAssertTrue(selection.isValid(in: catalog))
        selection.model = "opus"
        XCTAssertFalse(selection.isValid(in: catalog), "Claude 모델 이름은 Gemini 에서 통하지 않는다")
        selection.model = "gemini-4-argon"
        XCTAssertFalse(selection.isValid(in: catalog), "서버 목록에 없는 모델")
        XCTAssertTrue(selection.isValid(in: .fallback), "목록을 받기 전에는 기본 목록으로 본다")
        // 이 앱이 모르는 CLI: 모델을 정하지 않은 것만 통한다(Claude 목록으로 검사하지 않는다).
        selection.provider = "something_new"
        XCTAssertNil(selection.cli)
        XCTAssertTrue(selection.isValid(in: catalog))
        selection.model = "opus"
        XCTAssertFalse(selection.isValid(in: catalog))
    }

    // MARK: 처음 고르는 CLI

    func testDefaultProviderFollowsAGeminiLeadWhenGeminiCanBeChosen() {
        // 서버가 Gemini 를 알 때(gemini: true).
        XCTAssertEqual(DefaultProvider.choice(lead: "gemini", installed: ["claude": true, "codex": true, "gemini": true], gemini: true), "gemini")
        XCTAssertEqual(DefaultProvider.choice(lead: "gemini", installed: [:], gemini: true), "gemini", "실행 환경을 아직 못 읽었으면 총괄을 따른다")
        // 총괄이 Gemini 인데 Antigravity CLI 가 깔려 있지 않으면 예전 규칙이다.
        XCTAssertEqual(DefaultProvider.choice(lead: "gemini", installed: ["claude": true, "codex": true, "gemini": false], gemini: true), "claude")
        XCTAssertEqual(DefaultProvider.choice(lead: "gemini", installed: ["claude": false, "codex": true, "gemini": false], gemini: true), "codex")
        // 총괄이 없고 Antigravity CLI 만 깔린 Mac.
        XCTAssertEqual(DefaultProvider.choice(lead: nil, installed: ["claude": false, "codex": false, "gemini": true], gemini: true), "gemini")
        XCTAssertEqual(DefaultProvider.choice(lead: nil, installed: ["claude": true, "codex": false, "gemini": true], gemini: true), "claude", "Claude Code 가 있으면 Claude Code")
        XCTAssertEqual(DefaultProvider.choice(lead: nil, installed: ["claude": false, "codex": true, "gemini": true], gemini: true), "codex")
        XCTAssertEqual(DefaultProvider.choice(lead: nil, installed: ["gemini": true], gemini: true), "claude", "Claude Code·Codex 가 없다고 알려지지 않았으면 예전 그대로")
        // Claude·Codex 총괄은 예전 그대로 따른다.
        XCTAssertEqual(DefaultProvider.choice(lead: "codex", installed: ["claude": true, "codex": true, "gemini": true], gemini: true), "codex")
        XCTAssertEqual(DefaultProvider.choice(lead: "claude", installed: ["claude": false, "codex": false, "gemini": true], gemini: true), "claude")
        // 서버가 Gemini 를 모르면(옛 서버) 고르는 칸에 없으므로 고르지 않는다.
        XCTAssertEqual(DefaultProvider.choice(lead: "gemini", installed: ["gemini": true]), "claude")
        XCTAssertEqual(DefaultProvider.choice(lead: nil, installed: ["claude": false, "codex": false, "gemini": true]), "claude")
    }

    /// 새 팀장·새 프로젝트 시트가 모델 목록(Gemini 포함)을 받기 전에 열리면 고르는 칸에 Gemini 가 없어 총괄이 Gemini 여도 Claude 로 정해진다.
    /// 목록이 온 뒤 고르는 칸이 바뀌면 다시 맞춘다. 사용자가 칸을 직접 고른 뒤에는 건드리지 않는다.
    func testSheetDefaultFollowsAGeminiLeadOnceTheModelListArrives() async throws {
        let catalog = Self.newCatalog
        let listed = OSAllocatedUnfairLock(initialState: false)
        let fixture = try IsolatedTestNetwork { request in
            switch request.url?.path {
            case "/api/bootstrap":
                return IsolatedTestHTTPReply(data: Data(#"{"projects":[{"id":"p","name":"결제 앱"}],"settings":{},"runtime":{"providers":{"claude":{"installed":true},"codex":{"installed":true},"gemini":{"installed":true}}}}"#.utf8))
            case "/api/projects/p/state":
                return IsolatedTestHTTPReply(data: Data(#"{"project":{"id":"p","name":"결제 앱"},"members":[{"id":"lead","projectId":"p","kind":"conductor","cli":"gemini","status":"idle"}]}"#.utf8))
            case "/api/models":
                // 처음에는 목록을 못 받는다(연결 때의 첫 읽기 실패). 그 뒤 시트가 다시 읽을 때 받는다.
                return listed.withLock { $0 } ? IsolatedTestHTTPReply(data: Data(catalog.utf8)) : IsolatedTestHTTPReply(status: 503, data: Data("{}".utf8))
            default: return IsolatedTestHTTPReply(status: 404, data: Data("{}".utf8))
            }
        }
        let store = AppStore(session: fixture.session, persistCredentials: false)
        store.endpoint = fixture.endpoint.url.absoluteString; store.accessCode = "fixture-only"
        await store.connect()
        await store.refreshModels()
        XCTAssertEqual(store.members.first { $0.kind == "conductor" }?.cli, "gemini")
        XCTAssertEqual(store.offeredCLIs, [.claude, .codex], "목록을 못 받은 동안에는 Gemini 칸이 없다")

        // 시트가 처음 뜰 때: Gemini 를 고를 수 없어 Claude 다.
        var provider = DefaultProvider.choice(in: store)
        XCTAssertEqual(provider, "claude")

        // 시트가 목록을 다시 읽어(.task) 고르는 칸이 바뀐다.
        listed.withLock { $0 = true }
        for _ in 0..<5 where !store.offeredCLIs.contains(.gemini) { await store.refreshModels() }
        XCTAssertEqual(store.offeredCLIs, [.claude, .codex, .gemini])
        XCTAssertEqual(DefaultProvider.choice(in: store), "gemini")
        // 직접 고르기 전이면 총괄의 CLI 로 다시 맞춘다.
        provider = DefaultProvider.followed(current: provider, picked: false, choice: DefaultProvider.choice(in: store))
        XCTAssertEqual(provider, "gemini")
        // 직접 고른 뒤에는 건드리지 않는다(Claude 를 일부러 골랐어도, 다른 칸을 골랐어도).
        XCTAssertEqual(DefaultProvider.followed(current: "claude", picked: true, choice: DefaultProvider.choice(in: store)), "claude")
        XCTAssertEqual(DefaultProvider.followed(current: "codex", picked: true, choice: DefaultProvider.choice(in: store)), "codex")
        // 고르는 칸에서 Gemini 가 사라지면(연결을 끊음) 고르기 전의 값은 예전 규칙으로 돌아간다.
        store.disconnect()
        XCTAssertEqual(store.offeredCLIs, [.claude, .codex])
        XCTAssertEqual(DefaultProvider.followed(current: provider, picked: false, choice: DefaultProvider.choice(in: store)), "claude")
        await fixture.close()
    }

    // MARK: 설치 여부

    func testGeminiIsMissingUnlessTheServerSaysInstalled() {
        // 서버는 Antigravity CLI 가 깔려 있을 때만 그 줄을 보낸다.
        let without = RuntimeDiagnostics(providers: ["claude": ProviderRuntime(installed: true), "codex": ProviderRuntime(installed: false)])
        XCTAssertTrue(CLIInstall.missing("gemini", runtime: without))
        XCTAssertTrue(CLIInstall.missing("codex", runtime: without))
        XCTAssertFalse(CLIInstall.missing("claude", runtime: without))
        let with = RuntimeDiagnostics(providers: ["claude": ProviderRuntime(installed: true), "gemini": ProviderRuntime(installed: true)])
        XCTAssertFalse(CLIInstall.missing("gemini", runtime: with))
        XCTAssertFalse(CLIInstall.missing("codex", runtime: with), "Claude·Codex 는 줄이 없으면 모르는 것이다(예전 그대로)")
        XCTAssertTrue(CLIInstall.missing("gemini", runtime: RuntimeDiagnostics(providers: ["gemini": ProviderRuntime(installed: false)])))
        // 실행 환경을 아직 못 읽었으면 어느 것도 '없다'고 하지 않는다.
        for cli in ["claude", "codex", "gemini", "something_new"] { XCTAssertFalse(CLIInstall.missing(cli, runtime: nil), cli) }
        XCTAssertFalse(CLIInstall.missing("something_new", runtime: without))

        XCTAssertEqual(CLIInstall.missingNote(["claude", "codex", "gemini"], runtime: without), "Codex·Gemini · 설치 필요")
        XCTAssertEqual(CLIInstall.missingNote(["claude", "codex"], runtime: without), "Codex · 설치 필요")
        XCTAssertNil(CLIInstall.missingNote(["claude", "gemini"], runtime: with))
        XCTAssertNil(CLIInstall.missingNote(["claude", "codex", "gemini"], runtime: nil))
    }

    // MARK: 이름

    func testNamesOfGemini() throws {
        XCTAssertEqual(providerName("gemini"), "Gemini")
        XCTAssertEqual(providerFullName("gemini"), "Antigravity CLI")
        XCTAssertEqual(providerName("claude"), "Claude"); XCTAssertEqual(providerFullName("claude"), "Claude Code")
        XCTAssertEqual(providerName("codex"), "Codex"); XCTAssertEqual(providerFullName("codex"), "Codex CLI")
        // 모르는 값은 받은 글자 그대로(다른 CLI 이름으로 바꾸지 않는다).
        XCTAssertEqual(providerName("something"), "Something")
        XCTAssertEqual(providerFullName("something"), "something")
        // 짧은 이름은 직급 설정의 제목과 같다.
        for cli in RankSettingsCLI.allCases { XCTAssertEqual(providerName(cli.rawValue), cli.title) }

        // AI 계정 화면의 이름 표. 모르는 값은 Claude Code 가 아니다.
        XCTAssertEqual(CLIAccountText.name("claude"), "Claude Code")
        XCTAssertEqual(CLIAccountText.name("codex"), "Codex")
        XCTAssertEqual(CLIAccountText.name("gemini"), "Antigravity CLI")
        XCTAssertEqual(CLIAccountText.name("something_new"), "알 수 없는 CLI")
        XCTAssertEqual(unknownCLIName, "알 수 없는 CLI")

        // 폴더 신뢰 창 안내.
        let trust = Member(id: "m", cli: "gemini", backend: "core", status: "blocked", blockedCode: "trust_dialog_unrecognized")
        XCTAssertEqual(BlockedGuide(trust)?.explanation, "Antigravity CLI가 이 폴더를 신뢰할지 묻고 있습니다. 터미널에서 직접 답해 주세요.")

        // 전달 근거의 출처.
        func source(_ name: String) -> String {
            DeliveryEvidenceInfo(DeliveryEvidence(source: name, verdict: .present, location: "received_input", code: "test", complete: true, checkedAt: "time")).sourceLabel
        }
        XCTAssertEqual(source("gemini_log"), "Gemini 주 세션 입력 기록")
        XCTAssertEqual(source("claude_log"), "Claude 주 세션 입력 기록")
        XCTAssertEqual(source("codex_log"), "Codex 주 세션 입력 기록")
        XCTAssertEqual(source("future_log"), "전달 근거")

        // 첫 실행 안내: Antigravity CLI 가 깔린 Mac 에서만 Gemini 를 함께 적는다.
        XCTAssertTrue(PermissionModeChoice.firstRunLead(onThisMac: true, gemini: true).hasPrefix("팀장은 이 Mac에서 Claude Code·Codex·Gemini로 명령을 실행합니다."))
        XCTAssertTrue(PermissionModeChoice.firstRunLead(onThisMac: false, gemini: true).hasPrefix("팀장은 연결된 Mac에서 Claude Code·Codex·Gemini로 명령을 실행합니다."))
        XCTAssertEqual(PermissionModeChoice.firstRunLead(onThisMac: true, gemini: true).replacingOccurrences(of: "·Gemini", with: ""),
                       PermissionModeChoice.firstRunLead(onThisMac: true), "이름 말고는 같은 안내다")
        XCTAssertEqual(PermissionModeChoice.firstRunLead(onThisMac: true, gemini: false), PermissionModeChoice.firstRunLead(onThisMac: true))
    }

    // MARK: 로그인·첫 설정에서 막힌 팀장

    /// Antigravity CLI 의 로그인·첫 설정 화면에서 막힌 팀장(blockedCode gemini_setup). 그 화면은 대표만 끝낼 수 있다:
    /// '상태 확인 불가'가 아니라 까닭과 터미널 안내를 보이고, 승인 대기 목록·승인 카드로 가지 않는다(그 화면에 승인 답을 보내는 길이 없다).
    func testGeminiSetupBlockPointsAtTheTerminalAndIsNeverAnApproval() async throws {
        let observation = StatusObservation(source: "core", observedAt: "2026-11-21T03:00:00.000Z", freshness: "fresh", ownership: "verified",
                                            error: ObservationError(code: "gemini_setup", note: "Antigravity CLI의 로그인·첫 설정이 끝나지 않았습니다. 터미널을 열어 직접 끝내 주세요"))
        var member = Member(id: "g1", projectId: "p", kind: "worker", cli: "gemini", backend: "core", status: "blocked", paneId: "pane-1",
                            blockedReason: "setup", statusObservation: observation)
        member.blockedCode = "gemini_setup"

        let guide = try XCTUnwrap(BlockedGuide(member))
        XCTAssertEqual(guide.label, "로그인·첫 설정 필요")
        XCTAssertEqual(guide.explanation, "Antigravity CLI의 로그인·첫 설정이 끝나지 않았습니다. 터미널을 열어 직접 끝내 주세요.")
        XCTAssertEqual(guide.actionTitle, "터미널 열어 직접 끝내기")

        let info = MemberStatusInfo(member)
        XCTAssertEqual(info.label, guide.label, "'상태 확인 불가'·'상태 설정 확인 중'이 아니라 까닭을 적는다")
        XCTAssertEqual(info.explanation, guide.explanation)
        XCTAssertEqual(info.tone, .attention)
        XCTAssertTrue(info.needsMe)
        XCTAssertFalse(info.live)

        // 승인 창이 아니다: 승인 대기 목록에 들지 않고, 앱이 승인 창을 읽거나 답하지 않는다.
        XCTAssertNotEqual(info.tone, .approval)
        XCTAssertTrue(InboxHomePolicy.approvals([member]).isEmpty)
        XCTAssertEqual(InboxHomePolicy.inboxCount(decisions: [], members: [member]), 0)
        XCTAssertFalse(member.hasFolderTrustApproval)
        XCTAssertFalse(member.canReadCLIApproval)

        // 관측 메모가 없거나 낡았다고 와도 서버가 알려 준 까닭이 먼저다(막힘 코드만으로 고른다).
        var bare = member; bare.statusObservation = nil
        XCTAssertEqual(MemberStatusInfo(bare).label, guide.label)
        XCTAssertFalse(bare.canReadCLIApproval)
        var stale = member
        stale.statusObservation = StatusObservation(source: "core", freshness: "stale", ownership: "verified", error: ObservationError(code: "timeout", note: "재관측 중"))
        XCTAssertEqual(MemberStatusInfo(stale).explanation, guide.explanation)
        XCTAssertTrue(InboxHomePolicy.approvals([bare, stale]).isEmpty)
        // 막힘이 풀리면(쉬는 중) 안내도 없다.
        var idle = member; idle.status = "idle"; idle.blockedReason = nil; idle.statusObservation?.error = nil
        XCTAssertNil(BlockedGuide(idle))
        XCTAssertEqual(MemberStatusInfo(idle).label, "쉬는 중")
        // 정확히 알아본 폴더 신뢰 창(승인 카드로 답하는 것)과는 다른 길이다.
        var trust = member; trust.id = "t1"; trust.blockedCode = nil
        trust.statusObservation?.error = ObservationError(code: "folder_trust", note: "폴더 신뢰")
        XCTAssertTrue(trust.hasFolderTrustApproval)
        XCTAssertTrue(trust.canReadCLIApproval)
        XCTAssertEqual(InboxHomePolicy.approvals([member, trust]).map(\.id), ["t1"])

        // 저장소도 이 팀장의 승인 창을 읽으러 가지 않고, 답을 보내지 않는다(서버에 /approval 요청이 없다).
        let state = try JSONEncoder().encode(ProjectState(project: Project(id: "p", name: "결제 앱"), members: [member]))
        let fixture = try IsolatedTestNetwork { request in
            switch request.url?.path {
            case "/api/bootstrap": return IsolatedTestHTTPReply(data: Data(#"{"projects":[{"id":"p","name":"결제 앱"}],"settings":{},"runtime":{}}"#.utf8))
            case "/api/projects/p/state": return IsolatedTestHTTPReply(data: state)
            default: return IsolatedTestHTTPReply(status: 404, data: Data("{}".utf8))
            }
        }
        let store = AppStore(session: fixture.session, persistCredentials: false)
        store.endpoint = fixture.endpoint.url.absoluteString; store.accessCode = "fixture-only"
        await store.connect()
        let loaded = try XCTUnwrap(store.members.first { $0.id == "g1" })
        XCTAssertEqual(loaded.blockedCode, "gemini_setup")
        XCTAssertEqual(MemberStatusInfo(loaded).label, "로그인·첫 설정 필요")
        let read = try await store.readCLIApproval(loaded)
        XCTAssertNil(read)
        let prompt = CLIApprovalPrompt(title: "승인", body: "", question: "계속할까요?", options: [], fingerprint: "fixture")
        let answered = await store.answerCLIApproval(loaded, prompt: prompt, option: 1)
        XCTAssertFalse(answered)
        XCTAssertFalse(fixture.requests.contains { $0.url?.path.hasSuffix("/approval") == true }, "그 화면에 답을 보내지 않는다")
        store.disconnect()
        await fixture.close()
    }

    // MARK: 고르는 칸의 너비

    private func idealWidth<V: View>(_ view: V) -> CGFloat {
        #if os(macOS)
        NSHostingView(rootView: view.fixedSize()).fittingSize.width
        #else
        UIHostingController(rootView: view.fixedSize()).sizeThatFits(in: CGSize(width: 10_000, height: 10_000)).width
        #endif
    }

    /// CLI 를 고르는 칸은 셋이다. 칸에는 짧은 이름을 쓴다: 좁은 iPhone 폭에서도 한 칸에 잘리지 않고 들어간다.
    /// (예전의 긴 이름 'Antigravity CLI'·'… · 설치 필요'는 들어가지 않아, 설치 안내를 칸 아래 줄로 옮겼다.)
    func testShortNamesFitOneOfThreeSegmentsOnANarrowPhone() {
        // 새 프로젝트 시트의 칸(SettingsSegments, fill): 화면 320 - 시트 여백 16×2 - 알약 안쪽 3×2 를 셋으로 나누고, 칸 안쪽 여백 12×2 를 뺀다.
        let room: CGFloat = (320 - 32 - 6) / 3 - 24
        func width(_ text: String) -> CGFloat { idealWidth(Text(text).font(.system(size: 14, weight: .semibold)).lineLimit(1)) }
        for cli in RankSettingsCLI.allCases {
            XCTAssertLessThanOrEqual(width(cli.title), room, "\(cli.title) 가 한 칸(\(room)pt)에 들어가지 않는다")
        }
        XCTAssertGreaterThan(width(providerFullName("gemini")), room, "긴 이름은 한 칸에 들어가지 않는다")
        XCTAssertGreaterThan(width("Gemini · 설치 필요"), room, "짧은 이름에 설치 안내를 붙여도 들어가지 않는다")
    }

    // MARK: 사용량의 한도

    func testGeminiLimitsShowOneRowPerBucketWhenTheServerSendsThem() throws {
        let now = try XCTUnwrap(parseISODate("2026-11-21T03:00:00.000Z"))
        let claude = UsageLimitWindow(provider: "claude", window: "five_hour", windowMinutes: 300, usedPct: 22.4, resetsAt: "2026-11-21T04:00:00.000Z", observedAt: "2026-11-21T02:59:00.000Z")
        let codex = UsageLimitWindow(provider: "codex", window: "primary", windowMinutes: 300, usedPct: 18, observedAt: "2026-11-21T02:59:00.000Z")
        let neon = UsageLimitWindow(provider: "gemini", window: "gemini-4-neon", windowMinutes: nil, usedPct: 41.6, resetsAt: "2026-11-21T05:00:00.000Z", observedAt: "2026-11-21T02:57:00.000Z")
        let flash = UsageLimitWindow(provider: "gemini", window: "gemini-3.8-flash", windowMinutes: nil, usedPct: 83, observedAt: "2026-11-21T02:59:00.000Z")
        let unnamed = UsageLimitWindow(provider: "gemini", window: " ", windowMinutes: nil, usedPct: 5)

        // Gemini 는 한도 묶음의 이름을 그대로 쓴다(창 길이를 몰라도 보인다). 이름이 없으면 보이지 않는다.
        XCTAssertEqual(UsageText.windowLabel(neon), "gemini-4-neon")
        XCTAssertNil(UsageText.windowLabel(unnamed))
        XCTAssertNil(UsageText.windowLabel(UsageLimitWindow(provider: "codex", window: "gemini-4-neon", windowMinutes: nil, usedPct: 1)), "다른 CLI 의 모르는 창은 예전처럼 숨긴다")

        let groups = UsageText.limitGroups([flash, codex, unnamed, claude, neon])
        XCTAssertEqual(groups.map(\.provider), ["claude", "codex", "gemini", "gemini"], "Claude, Codex, 그다음 Gemini 묶음들(서버가 준 순서)")
        XCTAssertEqual(groups.map(\.id), ["claude", "codex", "gemini.gemini-3.8-flash", "gemini.gemini-4-neon"])
        XCTAssertEqual(UsageText.limitsTitle("gemini"), "Gemini 사용 한도")
        // 값은 사용률만, 묶음 이름은 줄 아래 글에.
        XCTAssertEqual(UsageText.limitsValue(groups[2]), "83%")
        XCTAssertEqual(UsageText.limitsHint(groups[2], now: now), "gemini-3.8-flash · 1분 전 기준")
        XCTAssertEqual(UsageText.limitsValue(groups[3]), "42%")
        let hint = UsageText.limitsHint(groups[3], now: now)
        XCTAssertTrue(hint.hasPrefix("3분 전 기준 · gemini-4-neon 한도 "), hint)
        XCTAssertTrue(hint.hasSuffix(" 초기화"), hint)
        XCTAssertEqual(hint.components(separatedBy: "gemini-4-neon").count, 2, "이름은 한 번만 적는다")
        // Claude·Codex 줄은 예전 그대로다.
        XCTAssertEqual(UsageText.limitsValue(groups[0]), UsageText.limitsValue(groups[0].limits))
        XCTAssertEqual(UsageText.limitsValue(groups[0]), "5시간 22%")
        XCTAssertEqual(UsageText.limitsHint(groups[0], now: now), UsageText.limitsHint(groups[0].limits, now: now))
        XCTAssertEqual(UsageText.limitsValue(groups[1]), "5시간 18%")
        // 서버가 Gemini 한도를 보내지 않으면 줄이 없다.
        XCTAssertEqual(UsageText.limitGroups([claude, codex]).map(\.id), ["claude", "codex"])
        XCTAssertEqual(UsageText.limitGroups([]).count, 0)
        // 팀원 줄의 CLI 이름.
        let row = UsageMemberRow(memberId: "m", projectId: "p", name: "자료 조사", providers: ["claude", "gemini"], amounts: UsageAmounts())
        XCTAssertEqual(UsageText.memberHint(row, projectName: "결제 앱"), "결제 앱 · 팀장 · Claude·Gemini")
    }

    /// 서버가 보내는 한도 줄 모양 그대로(provider "gemini", windowMinutes null)도 읽힌다.
    func testUsageReportWithGeminiRowsDecodes() throws {
        let report = try decode(UsageReport.self, #"""
        {"generatedAt":"2026-11-21T03:00:00.000Z","days":7,"from":"2026-11-15","to":"2026-11-21","retentionDays":90,"totals":{"costUsd":1.5,"inputTokens":10,"outputTokens":5},
         "members":[{"memberId":"g1","projectId":"p1","name":"자료 조사","kind":"worker","providers":["gemini"],"removed":false,"lastAt":"2026-11-21T02:59:00.000Z","costUsd":null,"inputTokens":null,"outputTokens":null}],
         "projects":[],"daily":[],
         "limits":[{"provider":"gemini","window":"gemini-4-neon","windowMinutes":null,"usedPct":12.5,"resetsAt":"2026-11-21T05:00:00.000Z","observedAt":"2026-11-21T02:59:00.000Z"}]}
        """#)
        XCTAssertEqual(report.members.first?.providers, ["gemini"])
        XCTAssertNil(report.members.first?.amounts.costUsd, "집계가 없으면 0 이 아니라 없음")
        XCTAssertEqual(UsageText.primary(try XCTUnwrap(report.members.first).amounts), "—")
        XCTAssertEqual(UsageText.limitGroups(report.limits).map(\.id), ["gemini.gemini-4-neon"])
        // 묶음 아래 설명: 보고에 Gemini 수치가 있을 때만 Antigravity CLI 를 함께 적는다. 없으면 예전 문장 그대로다.
        XCTAssertTrue(UsageText.reportsGemini(report))
        XCTAssertFalse(UsageText.reportsGemini(UsageReport(days: 1, from: "2026-11-21", to: "2026-11-21")))
        let withGemini = UsageText.footnote(retentionDays: 90, gemini: true)
        XCTAssertTrue(withGemini.hasPrefix("비용은 Claude Code와 Antigravity CLI(Gemini)가 보고한 금액 그대로이며, "), withGemini)
        XCTAssertEqual(withGemini.replacingOccurrences(of: "와 Antigravity CLI(Gemini)", with: ""), UsageText.footnote(retentionDays: 90), "이름 말고는 같은 설명이다")
        XCTAssertEqual(UsageText.footnote(retentionDays: 90, gemini: false), UsageText.footnote(retentionDays: 90))
    }

    // MARK: 서버 응답

    /// cli 값 "gemini" 는 팀장 모델에 그대로 남는다(문자열이라 모르는 값이어도 해석이 깨지지 않는다).
    func testMemberAndUsageLimitKeepTheGeminiValue() throws {
        let member = try decode(Member.self, #"{"id":"m1","projectId":"p1","kind":"worker","cli":"gemini","modelOverride":"gemini-4-neon","effortOverride":"high","appliedModel":"gemini-4-neon","status":"idle","sessionId":"0f3c2a1e-conv"}"#)
        XCTAssertEqual(member.cli, "gemini")
        XCTAssertEqual(RankSettingsCLI(cli: member.cli), .gemini)
        XCTAssertEqual(providerName(member.cli), "Gemini")
        // 실행 환경: gemini 줄은 깔려 있을 때만 온다.
        let runtime = try decode(RuntimeDiagnostics.self, #"{"backend":"core","core":{"installed":true,"available":true},"providers":{"claude":{"installed":true},"codex":{"installed":true},"gemini":{"installed":true}}}"#)
        XCTAssertEqual(runtime.providers["gemini"]?.installed, true)
        XCTAssertFalse(CLIInstall.missing("gemini", runtime: runtime))
    }
}
