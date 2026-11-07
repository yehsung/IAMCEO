import XCTest
@testable import IAMCEO

/// The attach command shared by the terminal app launch, the drawer's copy item and the terminal sheet's footer line.
final class TerminalCommandTests: XCTestCase {
    func testAttachCommandQuotesTheHomeAndTheMember() {
        XCTAssertEqual(TerminalCommand.attach(cli: "iamceo", memberID: "m_abc-1", home: ""), "iamceo attach m_abc-1")
        XCTAssertEqual(TerminalCommand.attach(cli: "iamceo", memberID: "m_abc", home: "/Users/me/.iamceo"),
                       "IAMCEO_HOME=/Users/me/.iamceo iamceo attach m_abc")
        XCTAssertEqual(TerminalCommand.attach(cli: "iamceo", memberID: "m_abc", home: "/Users/me/My Work/.iamceo"),
                       "IAMCEO_HOME='/Users/me/My Work/.iamceo' iamceo attach m_abc")
        XCTAssertEqual(TerminalCommand.attach(cli: "iamceo", memberID: "m_abc", home: "/tmp/it's"),
                       "IAMCEO_HOME='/tmp/it'\\''s' iamceo attach m_abc")
        XCTAssertEqual(TerminalCommand.attach(cli: "iamceo", memberID: "m; rm -rf ~", home: "   "),
                       "iamceo attach 'm; rm -rf ~'")
        // The server sends `cli` already quoted (`bun <path>/iamceo.ts`): it is kept as is.
        XCTAssertEqual(TerminalCommand.attach(cli: "/Users/me/.bun/bin/bun '/Users/me/i am/bin/iamceo.ts'", memberID: "m_x", home: "/h"),
                       "IAMCEO_HOME=/h /Users/me/.bun/bin/bun '/Users/me/i am/bin/iamceo.ts' attach m_x")
    }

    func testAttachCommandFollowsTheBootstrap() {
        // Before the bootstrap loads: plain `iamceo`, no home.
        XCTAssertEqual(TerminalCommand.attach(memberID: "m_abc", bootstrap: nil), "iamceo attach m_abc")
        var bootstrap = Bootstrap()
        bootstrap.cli = "iamceo"
        bootstrap.home = "/Users/me/acc home"
        XCTAssertEqual(TerminalCommand.attach(memberID: "m_abc", bootstrap: bootstrap),
                       "IAMCEO_HOME='/Users/me/acc home' iamceo attach m_abc")
    }

    func testShellQuote() {
        XCTAssertEqual(TerminalCommand.shellQuote("/Users/me/work"), "/Users/me/work")
        XCTAssertEqual(TerminalCommand.shellQuote(""), "''")
        XCTAssertEqual(TerminalCommand.shellQuote("a b"), "'a b'")
        XCTAssertEqual(TerminalCommand.shellQuote("it's"), "'it'\\''s'")
        XCTAssertEqual(TerminalCommand.shellQuote("$(rm)"), "'$(rm)'")
    }
}
