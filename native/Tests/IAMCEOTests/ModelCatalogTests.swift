import Foundation
import XCTest
@testable import IAMCEO

final class ModelCatalogTests: XCTestCase {
    private static let payload = #"{"claude":{"source":"cli","models":[{"value":"opus","label":"Opus","efforts":["high","max"]},{"value":"claude-fable-5-1[1m]","label":"Fable","description":"Extra","efforts":["low","high"]}]},"codex":{"source":"cli","updatedAt":"2026-11-07T00:00:00Z","models":[{"value":"new-codex","label":"New Codex","description":"Latest","efforts":["low","xhigh"],"defaultEffort":"xhigh"}]}}"#

    func testDecodeModelMetadataAndPerModelEfforts() throws {
        let catalog = try JSONDecoder().decode(ModelCatalog.self, from: Data(Self.payload.utf8))
        XCTAssertEqual(catalog.codex.source, "cli")
        XCTAssertEqual(catalog.codex.updatedAt, "2026-11-07T00:00:00Z")
        XCTAssertEqual(catalog.codex.models.first?.defaultEffort, "xhigh")
        XCTAssertEqual(catalog.codex.models.first?.description, "Latest")
        XCTAssertEqual(catalog.codex.efforts(for: "new-codex", cli: .codex), ["low", "xhigh"])
        XCTAssertEqual(catalog.claude.efforts(for: "opus", cli: .claude), ["high", "max"])
        XCTAssertEqual(catalog.codex.efforts(for: "old-model", cli: .codex), RankSettingsCLI.codex.efforts)
        let empty = ModelList(models: [ModelOption(value: "no-efforts", label: "Empty", efforts: [])], source: "cli")
        XCTAssertEqual(empty.efforts(for: "no-efforts", cli: .codex), RankSettingsCLI.codex.efforts)
    }

    func testUnknownCurrentIsDisplayOnlyAndFableAliasMatchesAdditionalModel() throws {
        let catalog = try JSONDecoder().decode(ModelCatalog.self, from: Data(Self.payload.utf8))
        XCTAssertEqual(catalog.codex.unknownCurrent("retired-model"), "retired-model · 목록에 없음")
        XCTAssertFalse(catalog.codex.models.contains { $0.value == "retired-model" })
        XCTAssertNil(catalog.codex.unknownCurrent(""))
        XCTAssertNil(catalog.codex.unknownCurrent("new-codex"))
        XCTAssertNil(catalog.claude.unknownCurrent("fable"))
        XCTAssertEqual(catalog.claude.option(for: "fable")?.value, "claude-fable-5-1[1m]")
        XCTAssertEqual(catalog.claude.efforts(for: "fable", cli: .claude), ["low", "high"])
    }

    func testOldServer404FallsBackButOtherErrorsRemainErrors() async throws {
        let fixture = try IsolatedTestNetwork { request in
            XCTAssertEqual(request.url?.path, "/api/models")
            return IsolatedTestHTTPReply(status: 404, data: Data(#"{"error":"old server"}"#.utf8))
        }
        let catalog = try await fixture.makeAPIClient().models()
        XCTAssertEqual(catalog, .fallback)
        XCTAssertEqual(catalog.claude.models.map(\.value), ["opus", "sonnet", "haiku"])
        XCTAssertEqual(catalog.codex.models.map(\.value), RankSettingsCLI.codex.models)
        XCTAssertEqual(fixture.requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-only")
        await fixture.close()
        let refused = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(status: 401, data: Data("{}".utf8)) }
        do { _ = try await refused.makeAPIClient().models(); XCTFail("401 must not be treated as an old server") }
        catch let error as APIError { XCTAssertEqual(error.status, 401) }
        await refused.close()
    }

    @MainActor func testConnectionAndExplicitRefreshLoadCatalogWithoutChangingRankDrafts() async throws {
        let fixture = try IsolatedTestNetwork { request in
            let text: String
            switch request.url?.path {
            case "/api/bootstrap": text = #"{"projects":[],"settings":{"ranks":{"lead":{"model":"retired","effort":"max"}}},"runtime":{}}"#
            case "/api/models": text = Self.payload
            default: return IsolatedTestHTTPReply(status: 404, data: Data("{}".utf8))
            }
            return IsolatedTestHTTPReply(data: Data(text.utf8))
        }
        let store = AppStore(session: fixture.session, persistCredentials: false)
        store.endpoint = fixture.endpoint.url.absoluteString; store.accessCode = "fixture-only"
        await store.connect()
        XCTAssertEqual(store.connectionStatus, .connected)
        XCTAssertEqual(store.modelCatalog.codex.models.first?.value, "new-codex")
        let settings = try XCTUnwrap(store.bootstrap?.settings)
        await store.refreshModels()
        XCTAssertEqual(store.bootstrap?.settings.ranks["lead"]?.model, settings.ranks["lead"]?.model)
        XCTAssertEqual(fixture.requests.filter { $0.url?.path == "/api/models" }.count, 2)
        store.disconnect()
        XCTAssertEqual(store.modelCatalog, .fallback)
        await fixture.close()
    }

    @MainActor func testDemoUsesFixedSampleWithoutRequests() async throws {
        let fixture = try IsolatedTestNetwork { _ in XCTFail("Demo must not request models"); throw URLError(.badURL) }
        let store = AppStore(demo: true, session: fixture.session, persistCredentials: false)
        await store.refreshModels()
        XCTAssertEqual(store.modelCatalog, .demo)
        XCTAssertEqual(store.modelCatalog.claude.option(for: "fable")?.label, "Fable")
        XCTAssertTrue(fixture.requests.isEmpty)
        await fixture.close()
    }
}
