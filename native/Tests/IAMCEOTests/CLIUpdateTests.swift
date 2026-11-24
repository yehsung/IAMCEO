import Foundation
import XCTest
@testable import IAMCEO

// 0.2.11: AI 도구(CLI) 새 판 알림과 원클릭 업데이트(앱 쪽).
// - Bootstrap 의 선택 칸 cliUpdates 를 관대하게 읽는다(옛 서버는 없음, 모르는 글자는 그대로, 읽지 못한 CLI 하나만 버림).
// - 상태 띠·확인 창·점검표 줄의 문구, 이 기기에서 본 판, Mac 알림은 판마다 한 번.
// - iPhone 푸시 cli_update 는 target 열쇠가 정확히 {screen, cli, version} 일 때만 받고, 누르면 설정 › 실행 환경을 연다.

#if os(macOS)
@MainActor private final class CLIUpdateDelivery: MacNotificationDelivering {
    struct Notice: Equatable { let identifier: String; let title: String; let body: String }
    var notices: [Notice] = []
    func requestPermission() async throws -> Bool { true }
    func deliver(identifier: String, title: String, metadata: Data) async throws {}
    func deliverNotice(identifier: String, title: String, body: String) async throws {
        notices.append(Notice(identifier: identifier, title: title, body: body))
    }
    func clear() {}
}
#endif

@MainActor final class CLIUpdateTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }
    private let claude = CLIUpdateInfo(cli: "claude", current: "2.1.323", latest: "2.1.332", available: true, latestVerified: false,
                                       method: "brew_cask", oneClick: true, manualCommand: "brew upgrade --cask claude-code@latest",
                                       source: "Homebrew cask claude-code@latest", checkedAt: "2026-11-25T00:00:00.000Z", liveSessions: 3)

    // MARK: 해독

    func testBootstrapReadsTheOptionalCLIUpdatesFieldLeniently() throws {
        XCTAssertNil(try decode(Bootstrap.self, #"{"projects":[]}"#).cliUpdates, "옛 서버")
        XCTAssertNil(try decode(Bootstrap.self, #"{"projects":[],"cliUpdates":{"claude":1}}"#).cliUpdates, "배열이 아니면 없는 것으로 읽는다")
        let decoded = try decode(Bootstrap.self, #"""
        {"projects":[],"cliUpdates":[
          {"cli":"claude","current":"2.1.323","latest":"2.1.332","available":true,"latestVerified":false,"method":"brew_cask","oneClick":true,
           "manualCommand":"brew upgrade --cask claude-code@latest","source":"Homebrew cask claude-code@latest","checkedAt":"2026-11-25T00:00:00.000Z",
           "liveSessions":3,"run":{"id":"u1","cli":"claude","from":"2.1.323","to":"2.1.332","phase":"installing","startedAt":"2026-11-25T00:01:00.000Z",
           "endedAt":null,"installed":null,"error":null,"manualCommand":"brew upgrade --cask claude-code@latest"}},
          {"cli":"codex","current":"0.166.0","latest":null,"available":false,"latestVerified":false,"method":"pip_future","oneClick":false,
           "manualCommand":null,"source":null,"checkedAt":null,"run":{"id":"u2","cli":"codex","phase":"paused","startedAt":"x"},"extra":1},
          {"current":"1.5.16"},
          {"cli":"gemini","available":"yes","pendingReopen":"two"}
        ]}
        """#)
        let updates = try XCTUnwrap(decoded.cliUpdates)
        XCTAssertEqual(updates.map(\.cli), ["claude", "codex", "gemini"], "cli 가 없는 줄만 버린다")
        XCTAssertEqual(updates[0].run?.phase, "installing")
        XCTAssertEqual(updates[0].run?.active, true)
        XCTAssertEqual(updates[0].liveSessions, 3)
        // 서버가 더한 모르는 글자(설치 방식·단계)는 버리지 않고 그대로 둔다. 모르는 단계는 도는 중으로 보지 않는다.
        XCTAssertEqual(updates[1].method, "pip_future")
        XCTAssertEqual(updates[1].run?.phase, "paused")
        XCTAssertEqual(updates[1].run?.active, false)
        // 형이 어긋난 칸은 기본값으로.
        XCTAssertEqual(updates[2].available, false)
        XCTAssertNil(updates[2].pendingReopen)
        // 기기에 남기는 마지막 상태로 다시 쓰고 읽어도 같다.
        let round = try JSONDecoder().decode(Bootstrap.self, from: JSONEncoder().encode(decoded))
        XCTAssertEqual(round.cliUpdates, decoded.cliUpdates)
    }

    func testWhatTheRowAndTheStripOffer() {
        XCTAssertTrue(claude.announces)
        XCTAssertTrue(claude.canStart)
        var running = claude; running.run = CLIUpdateRun(id: "u", cli: "claude", from: "2.1.323", to: "2.1.332", phase: "downloading")
        XCTAssertFalse(running.announces, "올리는 중인 판은 알리지 않는다")
        XCTAssertFalse(running.canStart)
        var failed = claude; failed.run = CLIUpdateRun(id: "u", cli: "claude", to: "2.1.332", phase: "failed")
        XCTAssertTrue(failed.announces, "실패하면 옛 판이 남아 새 판은 그대로 새 판이다")
        XCTAssertTrue(failed.canStart)
        var manual = claude; manual.oneClick = false
        XCTAssertTrue(manual.announces)
        XCTAssertFalse(manual.canStart)
        let unknownCLI = CLIUpdateInfo(cli: "future", latest: "1.0.0", available: true)
        XCTAssertFalse(unknownCLI.announces, "이 앱이 모르는 CLI 는 알리지 않는다")
        XCTAssertFalse(CLIUpdateInfo(cli: "codex", current: "0.172.0", latest: "0.172.0").announces)
    }

    // MARK: 문구

    func testStripAndNotificationWords() {
        XCTAssertEqual(CLIUpdateText.available([claude]), "Claude Code 2.1.332 업데이트가 있습니다")
        let codex = CLIUpdateInfo(cli: "codex", current: "0.166.0", latest: "0.172.0", available: true)
        let agy = CLIUpdateInfo(cli: "gemini", current: "1.5.16", latest: "1.5.17", available: true)
        XCTAssertEqual(CLIUpdateText.available([claude, codex, agy]), "Claude Code 2.1.332 · Codex 0.172.0 · Antigravity CLI 1.5.17 업데이트가 있습니다")
        XCTAssertEqual(CLIUpdateText.macNotificationBody, "설정 › AI 모델 › 실행 환경에서 업데이트할 수 있습니다.")
    }

    func testRowWordsFollowTheRun() {
        XCTAssertEqual(CLIUpdateText.newVersion(claude), "새 판 2.1.332 · 아직 IAMCEO가 확인하지 않은 판")
        var verified = claude; verified.latestVerified = true
        XCTAssertEqual(CLIUpdateText.newVersion(verified), "새 판 2.1.332 · IAMCEO가 확인한 판")
        var manual = claude; manual.oneClick = false
        XCTAssertEqual(CLIUpdateText.manual(manual), "이 Mac의 터미널에서 직접 업데이트하세요: brew upgrade --cask claude-code@latest")
        manual.manualCommand = nil
        XCTAssertEqual(CLIUpdateText.manual(manual), "이 설치 방식은 IAMCEO가 업데이트하지 못합니다. 깐 방법으로 직접 업데이트하세요.")
        XCTAssertEqual(CLIUpdateText.phase(CLIUpdateRun(id: "u", cli: "claude", phase: "downloading")), "내려받는 중…")
        XCTAssertEqual(CLIUpdateText.phase(CLIUpdateRun(id: "u", cli: "claude", phase: "installing")), "설치 중…")
        XCTAssertEqual(CLIUpdateText.phase(CLIUpdateRun(id: "u", cli: "claude", phase: "verifying")), "새 판을 확인하는 중…")
        // 판 뒤 조사: 0·3·6 으로 끝나면 '으로'.
        let done = CLIUpdateRun(id: "u", cli: "claude", to: "2.1.332", phase: "done", installed: "2.1.332")
        XCTAssertEqual(CLIUpdateText.done(done, pendingReopen: nil), "2.1.332로 올렸습니다")
        XCTAssertEqual(CLIUpdateText.done(done, pendingReopen: 2), "2.1.332로 올렸습니다 · 적용 중: 2명 남음")
        XCTAssertEqual(CLIUpdateText.done(CLIUpdateRun(id: "u", cli: "codex", phase: "done", installed: "0.170.0"), pendingReopen: 0), "0.170.0으로 올렸습니다")
        XCTAssertEqual(CLIUpdateText.done(CLIUpdateRun(id: "u", cli: "codex", phase: "done", installed: "1.5.16"), pendingReopen: nil), "1.5.16으로 올렸습니다")
        XCTAssertEqual(CLIUpdateText.done(CLIUpdateRun(id: "u", cli: "codex", phase: "done", installed: "1.5.17"), pendingReopen: nil), "1.5.17로 올렸습니다")
        XCTAssertTrue(CLIUpdateText.takesEuro("0.170.0-alpha.3"))
        // 실패: 서버 코드의 문장, 직접 할 명령.
        let failed = CLIUpdateRun(id: "u", cli: "claude", phase: "failed", error: CLIUpdateFailure(code: "cli_update_failed", message: "업데이트 명령이 실패했습니다. 옛 판이 그대로 남아 있습니다"))
        XCTAssertTrue(CLIUpdateText.failure(failed).contains("업데이트 명령이 실패했습니다"))
        XCTAssertEqual(CLIUpdateText.manualCommand("brew upgrade --cask claude-code@latest"), "직접 할 명령: brew upgrade --cask claude-code@latest")
    }

    func testConfirmationTellsWhatHappens() {
        XCTAssertEqual(CLIUpdateText.confirmTitle(claude), "Claude Code 2.1.323 → 2.1.332")
        let message = CLIUpdateText.confirmMessage(claude)
        XCTAssertTrue(message.contains("아직 IAMCEO가 확인하지 않은 판이라 화면 판독이 어긋날 수 있습니다."))
        XCTAssertTrue(message.contains("떠 있는 총괄·팀장 3명은 쉬는 때에 같은 대화로 다시 열려 새 판을 씁니다(일하는 중이면 그 턴이 끝난 뒤)."))
        XCTAssertTrue(message.contains("brew upgrade --cask claude-code@latest"))
        XCTAssertTrue(message.contains("실패하면 옛 판이 그대로 남습니다."))
        var verified = claude; verified.latestVerified = true; verified.liveSessions = 0
        let quiet = CLIUpdateText.confirmMessage(verified)
        XCTAssertTrue(quiet.contains("IAMCEO가 화면 견본으로 확인한 판입니다."))
        XCTAssertFalse(quiet.contains("떠 있는"))
    }

    // MARK: 이 기기 값과 서버 스냅샷

    func testLocalRunShowsUntilTheServerCatchesUp() {
        let started = CLIUpdateRun(id: "u1", cli: "claude", from: "2.1.323", to: "2.1.332", phase: "downloading", startedAt: "2026-11-25T00:01:00.000Z")
        var mine = claude; mine.run = started
        // 서버 스냅샷이 아직 이 업데이트를 모른다: 이 기기 값.
        XCTAssertEqual(CLIUpdateMerge.shown(server: claude, local: mine)?.run, started)
        XCTAssertFalse(CLIUpdateMerge.serverCaughtUp(server: claude, local: mine))
        // 서버가 같은 업데이트를 더 나아간 단계로 안다: 서버 값.
        var server = claude; server.run = CLIUpdateRun(id: "u1", cli: "claude", to: "2.1.332", phase: "installing", startedAt: started.startedAt)
        XCTAssertEqual(CLIUpdateMerge.shown(server: server, local: mine)?.run?.phase, "installing")
        XCTAssertTrue(CLIUpdateMerge.serverCaughtUp(server: server, local: mine))
        // 같은 업데이트인데 이 기기 값이 더 나아갔다(진행 읽기가 먼저 왔다): 그 단계.
        var ahead = mine; ahead.run?.phase = "verifying"
        XCTAssertEqual(CLIUpdateMerge.shown(server: server, local: ahead)?.run?.phase, "verifying")
        // 업데이트가 없는 이 기기 값(다시 확인한 값)은 다음 스냅샷에 지운다.
        XCTAssertTrue(CLIUpdateMerge.serverCaughtUp(server: nil, local: claude))
        XCTAssertNil(CLIUpdateMerge.shown(server: nil, local: nil))
    }

    func testStripButtonUpdatesOnlyASingleOneClickVersion() {
        let codex = CLIUpdateInfo(cli: "codex", current: "0.166.0", latest: "0.172.0", available: true, oneClick: true)
        XCTAssertEqual(CLIUpdateText.oneClickTarget([claude])?.cli, "claude")
        XCTAssertNil(CLIUpdateText.oneClickTarget([claude, codex]), "여럿이면 '보기'")
        var manual = claude; manual.oneClick = false
        XCTAssertNil(CLIUpdateText.oneClickTarget([manual]), "서버가 올릴 수 없으면 '보기'")
        XCTAssertNil(CLIUpdateText.oneClickTarget([]))
    }

    // MARK: 'AI 도구 새 판 알림' 칸(설정 › 알림, 서버 설정 notifyCliUpdates)

    func testNotifySettingIsReadOnlyFromServersThatKnowIt() throws {
        XCTAssertNil(try decode(Settings.self, "{}").notifyCliUpdates, "옛 서버는 이 칸을 보내지 않는다(칸을 그리지 않는다)")
        XCTAssertEqual(try decode(Settings.self, #"{"notifyCliUpdates":false}"#).notifyCliUpdates, false)
        XCTAssertEqual(try decode(Settings.self, #"{"notifyCliUpdates":"x","compactAtPct":60}"#).compactAtPct, 60, "틀린 형 하나로 설정 전체를 버리지 않는다")
        // 옛 서버에 통째로 보내는 저장(PUT)에 그 서버가 모르는 칸이 실리지 않는다.
        let encoded = String(decoding: try JSONEncoder().encode(Settings()), as: UTF8.self)
        XCTAssertFalse(encoded.contains("notifyCliUpdates"))
        XCTAssertTrue(CLIUpdateNotify.enabled(nil))
        XCTAssertTrue(CLIUpdateNotify.enabled(Settings()))
        var off = Settings(); off.notifyCliUpdates = false
        XCTAssertFalse(CLIUpdateNotify.enabled(off))
    }

    func testTurningNotificationsOffHidesTheStripButNotTheRow() {
        let seen = CLIUpdateSeen(defaults: nil)
        var off = Settings(); off.notifyCliUpdates = false
        XCTAssertEqual(seen.strip(server: "s", [claude], settings: off), [], "꺼 두면 띠를 내지 않는다")
        XCTAssertEqual(seen.strip(server: "s", [claude], settings: Settings()).map(\.cli), ["claude"])
        XCTAssertTrue(claude.canStart, "점검표 줄의 업데이트 단추는 알림 칸과 상관없다")
    }

    func testSeenVersionsAreNotShownAgain() {
        let seen = CLIUpdateSeen(defaults: nil)
        let codex = CLIUpdateInfo(cli: "codex", current: "0.166.0", latest: "0.172.0", available: true)
        XCTAssertEqual(seen.unseen(server: "s", [claude, codex]).map(\.cli), ["claude", "codex"])
        seen.markSeen(server: "s", [claude])
        XCTAssertEqual(seen.unseen(server: "s", [claude, codex]).map(\.cli), ["codex"])
        XCTAssertEqual(seen.unseen(server: "other", [claude]).map(\.cli), ["claude"], "서버마다 따로")
        var newer = claude; newer.latest = "2.1.333"
        XCTAssertEqual(seen.unseen(server: "s", [newer]).map(\.latest), ["2.1.333"], "더 새 판은 다시 보인다")
        XCTAssertEqual(seen.unseen(server: "s", nil), [])
    }

    func testMacNoticeTrackerAnnouncesEachVersionOnce() {
        var tracker = CLIUpdateNoticeTracker(defaults: nil)
        XCTAssertEqual(tracker.take([claude], serverID: "s", appOwnsNotifications: true).map(\.cli), ["claude"])
        XCTAssertEqual(tracker.take([claude], serverID: "s", appOwnsNotifications: true), [])
        // 앱이 알림을 맡지 않는 동안 본 판은 처리한 것으로 적는다(서버가 냈거나 Mac 알림을 꺼 두었다).
        let codex = CLIUpdateInfo(cli: "codex", current: "0.166.0", latest: "0.172.0", available: true)
        XCTAssertEqual(tracker.take([codex], serverID: "s", appOwnsNotifications: false), [])
        XCTAssertEqual(tracker.take([codex], serverID: "s", appOwnsNotifications: true), [])
        XCTAssertEqual(CLIUpdateNoticeTracker.identifier(server: "s", info: claude), "s:cli_update:claude:2.1.332")
    }

    #if os(macOS)
    func testMacAppPostsOneNoticePerVersionWhenItOwnsNotifications() async {
        let delivery = CLIUpdateDelivery(), service = MacNotificationService(defaults: nil, delivery: delivery)
        let server = "277551bf-cf60-4ecd-a450-1fd3e695a8d8"
        await service.setEnabled(true)
        XCTAssertNil(service.noteCLIUpdates(nil, serverID: server, appOwnsNotifications: true))
        _ = await service.noteCLIUpdates([claude], serverID: server, appOwnsNotifications: true)?.value
        XCTAssertEqual(delivery.notices, [CLIUpdateDelivery.Notice(identifier: "\(server):cli_update:claude:2.1.332",
                                                                   title: "Claude Code 2.1.332 업데이트가 있습니다",
                                                                   body: "설정 › AI 모델 › 실행 환경에서 업데이트할 수 있습니다.")])
        for _ in 0..<3 { XCTAssertNil(service.noteCLIUpdates([claude], serverID: server, appOwnsNotifications: true)) }
        XCTAssertEqual(delivery.notices.count, 1)
        // 서버가 스크립트 알림을 맡는 동안 본 판은 띄우지 않는다.
        let codex = CLIUpdateInfo(cli: "codex", current: "0.166.0", latest: "0.172.0", available: true)
        XCTAssertNil(service.noteCLIUpdates([codex], serverID: server, appOwnsNotifications: false))
        XCTAssertEqual(delivery.notices.count, 1)
        // 'AI 도구 새 판 알림'을 꺼 두면 앱이 알림을 맡아도 띄우지 않고, 그 판은 처리한 것으로 적는다(켜도 뒤늦게 띄우지 않는다).
        let gemini = CLIUpdateInfo(cli: "gemini", current: "1.5.16", latest: "1.5.17", available: true)
        XCTAssertNil(service.noteCLIUpdates([gemini], serverID: server, appOwnsNotifications: true, notify: false))
        XCTAssertNil(service.noteCLIUpdates([gemini], serverID: server, appOwnsNotifications: true))
        XCTAssertEqual(delivery.notices.count, 1)
    }
    #endif

    // MARK: iPhone 푸시

    private let server = "277551bf-cf60-4ecd-a450-1fd3e695a8d8"
    private let event = "32c3c71b-2e9b-4f02-9edc-d23d372d418f"
    private func metadata(kind: String = "cli_update", target: String) -> Data {
        Data("{\"v\":1,\"serverId\":\"\(server)\",\"eventId\":\"\(event)\",\"kind\":\"\(kind)\",\"target\":\(target)}".utf8)
    }

    func testCLIUpdatePushNeedsExactlyScreenCLIAndVersion() throws {
        let link = try XCTUnwrap(NotificationLink.parse(metadata: metadata(target: #"{"screen":"home","cli":"claude","version":"2.1.332"}"#)))
        XCTAssertEqual(link.kind, "cli_update")
        XCTAssertEqual(link.target, .home)
        XCTAssertEqual(link.updateCLI, "claude")
        XCTAssertNil(NotificationLink.parse(metadata: metadata(kind: "test", target: #"{"screen":"home"}"#))?.updateCLI)
        XCTAssertNotNil(NotificationLink.parse(metadata: metadata(target: #"{"screen":"home","cli":"codex","version":"0.170.0-alpha.2"}"#)))
        XCTAssertNotNil(NotificationLink.parse(metadata: metadata(target: #"{"screen":"home","cli":"gemini","version":"1.5.17"}"#)))
        for target in [
            #"{"screen":"home"}"#,
            #"{"screen":"home","cli":"claude"}"#,
            #"{"screen":"home","cli":"claude","version":"2.1.332","url":"https://evil.invalid"}"#,
            #"{"screen":"inbox","cli":"claude","version":"2.1.332"}"#,
            #"{"screen":"home","cli":"other","version":"2.1.332"}"#,
            #"{"screen":"home","cli":"claude","version":"latest"}"#,
            #"{"screen":"home","cli":"claude","version":"2.1"}"#,
            #"{"screen":"home","cli":"claude","version":"2.1.332\n"}"#,
            #"{"screen":"home","cli":"claude","version":"2.1.332; rm"}"#,
            #"{"screen":"home","cli":"claude","version":2}"#,
            "{\"screen\":\"home\",\"cli\":\"claude\",\"version\":\"1.2.\(String(repeating: "3", count: 40))\"}",
            #"{"screen":"home","projectId":"p_1","cli":"claude","version":"2.1.332"}"#,
        ] { XCTAssertNil(NotificationLink.parse(metadata: metadata(target: target)), target) }
        // 다른 종류의 판정은 그대로: test 의 home 은 screen 하나만.
        XCTAssertNil(NotificationLink.parse(metadata: metadata(kind: "test", target: #"{"screen":"home","cli":"claude","version":"2.1.332"}"#)))
        XCTAssertNotNil(NotificationLink.parse(metadata: metadata(kind: "test", target: #"{"screen":"home"}"#)))
    }

    func testCLIUpdateRouteOpensRuntimeSettings() {
        let router = Router()
        SettingsNavigation.shared.pendingRuntime = false
        var route = NotificationRoute(target: .home)
        route.openRuntime = true
        route.updateCLI = "codex"
        router.applyNotification(route, afterProjectChange: false, resetRevision: router.projectResetRevision)
        XCTAssertEqual(router.destination, .home)
        XCTAssertTrue(router.showSettings)
        XCTAssertTrue(SettingsNavigation.shared.pendingRuntime)
        // 그 CLI 의 줄이 확인 창을 한 번 꺼내 쓴다(다른 CLI 의 줄은 꺼내지 못한다).
        XCTAssertFalse(SettingsNavigation.shared.takeUpdate(cli: "claude"))
        XCTAssertTrue(SettingsNavigation.shared.takeUpdate(cli: "codex"))
        XCTAssertFalse(SettingsNavigation.shared.takeUpdate(cli: "codex"))
        // 30초 넘게 지난 요청은 확인 창을 띄우지 않는다(늦게 나타난 줄).
        SettingsNavigation.shared.requestUpdate(cli: "gemini")
        XCTAssertFalse(SettingsNavigation.shared.takeUpdate(cli: "gemini", now: Date().addingTimeInterval(31)))
        SettingsNavigation.shared.pendingRuntime = false
        // 다른 알림은 설정을 열지 않는다.
        let other = Router()
        other.applyNotification(NotificationRoute(target: .home), afterProjectChange: false, resetRevision: other.projectResetRevision)
        XCTAssertFalse(other.showSettings)
        XCTAssertFalse(SettingsNavigation.shared.pendingRuntime)
    }
}
