import Foundation
import os
import XCTest
@testable import IAMCEO

/// 0.2.10: 폰에서 Gemini(Antigravity CLI) 로그인. 서버(server/cli-login.ts)는 agy 가 깔려 있을 때만 새 칸 allAccounts·allLogins 에 Gemini 를 싣고,
/// 옛 칸(accounts·logins)은 Claude Code·Codex 그대로다. Gemini 줄에는 메일이 없고(로그인을 마친 그 응답에만), 첫 설정이 남았으면 setupPending 이다.
@MainActor final class GeminiLoginTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }
    private let claude = #"{"cli":"claude","installed":true,"loggedIn":true,"email":"me@example.com","organization":"Org","plan":"max","method":"claude.ai","checkedAt":"2026-11-22T00:00:00.000Z"}"#
    private let codex = #"{"cli":"codex","installed":true,"loggedIn":false,"email":null,"organization":null,"plan":null,"method":null,"checkedAt":"2026-11-22T00:00:00.000Z"}"#
    private let gemini = #"{"cli":"gemini","installed":true,"loggedIn":true,"email":null,"organization":null,"plan":"Pro","method":null,"checkedAt":"2026-11-22T00:00:00.000Z","setupPending":true}"#
    private func login(cli: String = "gemini", phase: String = "waiting", account: String = "null", changed: String = "null", applied: String = "null") -> String {
        #"{"id":"cl_1","cli":"\#(cli)","flow":"paste_code","phase":"\#(phase)","startedAt":"2026-11-22T00:00:00.000Z","expiresAt":"2026-11-22T00:15:00.000Z","endedAt":null,"url":"https://accounts.google.com/o/oauth2/auth?state=s","localUrl":null,"userCode":null,"error":null,"account":\#(account),"accountChanged":\#(changed),"applied":\#(applied)}"#
    }

    func testResponseShowsGeminiOnlyFromTheNewFields() throws {
        // 새 서버 + agy 가 깔린 Mac: 새 칸에 세 줄, 옛 칸은 두 줄.
        let both = try decode(CLIAccountsResponse.self, #"{"accounts":[\#(claude),\#(codex)],"logins":[],"allAccounts":[\#(claude),\#(codex),\#(gemini)],"allLogins":[\#(login())]}"#)
        XCTAssertEqual(both.accounts.map(\.cli), ["claude", "codex"])
        XCTAssertEqual(both.shownAccounts.map(\.cli), ["claude", "codex", "gemini"])
        XCTAssertEqual(both.shownLogins.map(\.cli), ["gemini"])
        XCTAssertEqual(both.shownAccounts.last?.setupPending, true)
        XCTAssertTrue(both.shownLogins[0].pastesCode, "Gemini 는 Claude 처럼 코드를 붙여넣는다")
        // 옛 서버(또는 agy 가 없는 Mac): 새 칸이 없으면 옛 칸 그대로(Gemini 줄 없음).
        let old = try decode(CLIAccountsResponse.self, #"{"accounts":[\#(claude),\#(codex)],"logins":[]}"#)
        XCTAssertEqual(old.shownAccounts.map(\.cli), ["claude", "codex"])
        XCTAssertNil(old.shownAccounts.first?.setupPending)
        XCTAssertEqual(try decode(CLILoginApplied.self, #"{"reopenedNow":0,"atNextTurn":1}"#).setupBlocked, nil)
        XCTAssertEqual(try decode(CLILoginApplied.self, #"{"reopenedNow":0,"atNextTurn":1,"setupBlocked":2}"#).setupBlocked, 2)
    }

    func testGeminiRowHintHasNoMailAndShowsSetupLeft() throws {
        let row = try decode(CLIAccount.self, gemini)
        XCTAssertEqual(CLIAccountText.hint(row), "로그인되어 있습니다\u{00A0}· Pro\u{00A0}· 첫 설정이 남았습니다")
        XCTAssertTrue(CLIAccountText.needsAttention(row), "첫 설정이 남았으면 주의 색")
        let done = try decode(CLIAccount.self, gemini.replacingOccurrences(of: #","setupPending":true"#, with: #","setupPending":false"#))
        XCTAssertEqual(CLIAccountText.hint(done), "로그인되어 있습니다\u{00A0}· Pro")
        XCTAssertFalse(CLIAccountText.needsAttention(done))
        // 로그인을 마친 그 응답에는 agy 가 알려 준 메일이 있다(그때만 보인다).
        let after = try decode(CLIAccount.self, gemini.replacingOccurrences(of: #""email":null"#, with: #""email":"test@example.invalid""#).replacingOccurrences(of: #","setupPending":true"#, with: ""))
        XCTAssertEqual(CLIAccountText.hint(after), "test@example.invalid\u{00A0}· Pro")
        // Claude·Codex 줄은 예전 그대로다.
        XCTAssertEqual(CLIAccountText.hint(try decode(CLIAccount.self, claude)), "me@example.com\u{00A0}· Org\u{00A0}· Max")
        XCTAssertEqual(CLIAccountText.hint(try decode(CLIAccount.self, codex)), "로그인되어 있지 않습니다")
        XCTAssertEqual(CLIAccountText.plan("ultra"), "Ultra")
    }

    func testAppliedTextForGemini() throws {
        // 앞 계정을 모른다(서버가 메일을 저장하지 않는다): 쉬는 팀장 수와, 로그인·첫 설정 화면에서 그대로 둔 팀장 수를 알린다.
        let first = try decode(CLILogin.self, login(phase: "succeeded", applied: #"{"reopenedNow":0,"atNextTurn":2,"setupBlocked":1}"#))
        XCTAssertEqual(CLIAccountText.applied(first),
                       "Antigravity CLI 팀장 2명은 하던 일을 마치는 대로(쉬고 있으면 곧바로) 같은 대화를 다시 열어 이 계정을 씁니다. 로그인·첫 설정 화면에서 멈춘 팀장 1명은 그대로 둡니다. 터미널을 열어 그 화면을 끝내면 새 계정으로 다시 엽니다.")
        let changed = try decode(CLILogin.self, login(phase: "succeeded", changed: "true", applied: #"{"reopenedNow":0,"atNextTurn":1,"setupBlocked":0}"#))
        XCTAssertEqual(CLIAccountText.applied(changed), "이제 이 Mac의 Antigravity CLI 팀장들이 새 계정을 씁니다. 다른 팀장 1명은 하던 일을 마치는 대로 같은 대화를 새 계정으로 다시 엽니다.")
        // Claude 는 앞 계정을 모르면 예전처럼 쉬는 팀장 수를 말하지 않는다.
        let claudeLogin = try decode(CLILogin.self, login(cli: "claude", phase: "succeeded", applied: #"{"reopenedNow":0,"atNextTurn":2}"#))
        XCTAssertNil(CLIAccountText.applied(claudeLogin))
    }

    /// 설정의 AI 계정 묶음이 읽는 상태: 새 칸이 있으면 Gemini 까지, 없으면(옛 서버) 옛 칸 그대로. Gemini 시작 요청은 cli "gemini" 로 간다.
    func testPanelUsesTheNewFieldsAndStartsGeminiSignIn() async throws {
        let withGemini = #"{"accounts":[\#(claude),\#(codex)],"logins":[],"allAccounts":[\#(claude),\#(codex),\#(gemini)],"allLogins":[]}"#
        let oldServer = #"{"accounts":[\#(claude),\#(codex)],"logins":[]}"#
        let body = OSAllocatedUnfairLock(initialState: withGemini)
        let started = OSAllocatedUnfairLock<String?>(initialState: nil)
        let loginJSON = login(phase: "starting")
        let network = try IsolatedTestNetwork { request in
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/api/cli-accounts"): return IsolatedTestHTTPReply(data: Data(body.withLock { $0 }.utf8))
            case ("POST", "/api/cli-login"):
                let sent = request.httpBodyStream.map { stream -> Data in
                    stream.open(); defer { stream.close() }
                    var data = Data(); var buffer = [UInt8](repeating: 0, count: 1024)
                    while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
                    return data
                } ?? request.httpBody ?? Data()
                started.withLock { $0 = String(decoding: sent, as: UTF8.self) }
                return IsolatedTestHTTPReply(data: Data(loginJSON.utf8))
            default: return IsolatedTestHTTPReply(status: 404)
            }
        }
        let api = network.makeAPIClient()
        let panel = CLIAccountsPanel()
        await panel.load(api)
        XCTAssertEqual(panel.accounts.map(\.cli), ["claude", "codex", "gemini"])
        XCTAssertEqual(panel.account("gemini")?.setupPending, true)
        body.withLock { $0 = oldServer }
        await panel.load(api)
        XCTAssertEqual(panel.accounts.map(\.cli), ["claude", "codex"], "옛 서버에는 Gemini 줄이 없다")
        let login = try await api.startCLILogin(cli: "gemini")
        XCTAssertEqual(login.cli, "gemini")
        let sent = try XCTUnwrap(started.withLock { $0 })
        XCTAssertEqual(try JSONSerialization.jsonObject(with: Data(sent.utf8)) as? [String: String], ["cli": "gemini"])
    }

    func testWarningTexts() {
        XCTAssertEqual(CLIAccountText.geminiSharedAccountTitle, "이 Mac의 Antigravity 앱·IDE 계정도 함께 바뀝니다")
        XCTAssertTrue(CLIAccountText.geminiSetupDetail.contains("agy를 한 번 실행해 첫 설정"))
        XCTAssertTrue(RankSettingsCLI.gemini.signsInFromApp)
    }
}
