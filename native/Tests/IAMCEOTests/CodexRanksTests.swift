import Foundation
import XCTest
@testable import IAMCEO

final class CodexRanksTests: XCTestCase {
    func testOlderSettingsDecodeToEmptyCodexDefaultsAndNewSettingsRoundTrip() throws {
        let old = try JSONDecoder().decode(Settings.self, from: Data(#"{"ranks":{"lead":{"model":"sonnet","effort":"max"}}}"#.utf8))
        XCTAssertTrue(old.codexRanks.isEmpty)
        let data = Data(#"{"codexRanks":{"manager":{"model":null,"effort":null},"lead":{"model":"gpt-6-luna","effort":"minimal"},"staff":{"model":"gpt-6.1-terra","effort":"low"}}}"#.utf8)
        let settings = try JSONDecoder().decode(Settings.self, from: data)
        XCTAssertNil(settings.codexRanks["manager"]?.model)
        XCTAssertEqual(settings.codexRanks["lead"]?.effort, "minimal")
        let roundTrip = try JSONDecoder().decode(Settings.self, from: JSONEncoder().encode(settings))
        XCTAssertEqual(roundTrip.codexRanks["staff"]?.model, "gpt-6.1-terra")
        XCTAssertThrowsError(try JSONDecoder().decode(Settings.self, from: Data(#"{"codexRanks":[]}"#.utf8)))
    }

    func testPatchEncodesOnlyCodexDirtyLeafWithExplicitNullClear() throws {
        let patch = SettingsPatchRequest(codexRanks: ["lead": RankConfigPatch(model: .null), "staff": RankConfigPatch(effort: .value("minimal"))])
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Any])
        XCTAssertEqual(Set(json.keys), ["codexRanks"])
        let ranks = try XCTUnwrap(json["codexRanks"] as? [String: [String: Any]])
        XCTAssertEqual(Set(ranks["lead"]!.keys), ["model"])
        XCTAssertTrue(ranks["lead"]?["model"] is NSNull)
        XCTAssertEqual(Set(ranks["staff"]!.keys), ["effort"])
        XCTAssertEqual(ranks["staff"]?["effort"] as? String, "minimal")
    }

    func testRankEditingDirtySignatureCustomValidationAndSeparateProviderChoices() {
        let base = Settings()
        var draft = base
        draft.codexRanks["lead"] = RankConfig(model: "gpt-6-luna", effort: "low")
        XCTAssertNotEqual(RankSettingsEditing.signature(base), RankSettingsEditing.signature(draft))
        draft.codexRanks["lead"]?.model = " gpt-6-luna "
        var normalized = draft; normalized.codexRanks["lead"]?.model = "gpt-6-luna"
        XCTAssertEqual(RankSettingsEditing.signature(draft), RankSettingsEditing.signature(normalized))
        XCTAssertNil(RankSettingsEditing.modelError("", custom: false, title: "팀장"))
        XCTAssertNotNil(RankSettingsEditing.modelError("  ", custom: true, title: "팀장"))
        for invalid in ["--model", "two words", "가나다"] {
            XCTAssertNotNil(RankSettingsEditing.modelError(invalid, custom: true, title: "팀장"))
        }
        XCTAssertNil(RankSettingsEditing.modelError("gpt-6.1-sol", custom: true, title: "팀장"))
        XCTAssertEqual(RankSettingsCLI.codex.efforts, ["minimal", "low", "medium", "high", "xhigh"])
        XCTAssertEqual(RankSettingsCLI.claude.efforts, ["low", "medium", "high", "xhigh", "max"])
        XCTAssertEqual(RankSettingsCLI.codex.models, ["gpt-6.1-sol", "gpt-6-luna", "gpt-6.1-terra", "gpt-6-astra"])
    }

    func testConflictReviewRebasesOnlyChangedCodexLeavesAndPreservesStoredStaffEffort() {
        let base = Settings(ranks: ["lead": RankConfig(model: "sonnet", effort: "high")], codexRanks: ["lead": RankConfig(model: "gpt-6-astra", effort: "high"), "staff": RankConfig(model: "gpt-6-luna", effort: "minimal")])
        var mine = base; mine.codexRanks["lead"]?.model = nil
        var server = base
        server.codexRanks["lead"]?.effort = "low"
        server.ranks["lead"]?.model = "opus"
        server.codexRanks["staff"]?.model = "gpt-6.1-terra"
        let reviewed = RankSettingsEditing.rebase(previous: base, mine: mine, onto: server)
        XCTAssertNil(reviewed.codexRanks["lead"]?.model)
        XCTAssertEqual(reviewed.codexRanks["lead"]?.effort, "low")
        XCTAssertEqual(reviewed.codexRanks["staff"]?.model, "gpt-6.1-terra")
        XCTAssertEqual(reviewed.codexRanks["staff"]?.effort, "minimal")
        XCTAssertEqual(reviewed.ranks["lead"]?.model, "opus")
    }

    func testTeamResolvesCodexRankAndIndependentOverrides() {
        let settings = Settings(ranks: ["lead": RankConfig(model: "sonnet", effort: "max")], codexRanks: ["manager": RankConfig(model: "gpt-6.1-sol", effort: "medium"), "lead": RankConfig(model: "gpt-6-luna", effort: "low")])
        var member = Member(id: "m", kind: "worker", cli: "codex")
        XCTAssertEqual(settings.memberConfig(member).model, "gpt-6-luna")
        member.modelOverride = "gpt-6-astra"
        XCTAssertEqual(settings.memberConfig(member).model, "gpt-6-astra")
        XCTAssertEqual(settings.memberConfig(member).effort, "low")
        member.effortOverride = "minimal"
        XCTAssertEqual(settings.memberConfig(member).effort, "minimal")
        member.modelOverride = nil; member.effortOverride = nil; member.kind = "conductor"
        XCTAssertEqual(settings.memberConfig(member).model, "gpt-6.1-sol")
        member.kind = "worker"; member.cli = "claude"
        XCTAssertEqual(settings.memberConfig(member).model, "sonnet")
        XCTAssertEqual(settings.memberConfig(member).effort, "max")
    }
}
