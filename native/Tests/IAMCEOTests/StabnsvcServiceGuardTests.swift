import Foundation
import XCTest
@testable import IAMCEO

/// 대기가 영영 남지 않게 하는 작은 안전장치들.
final class StabnsvcServiceGuardTests: XCTestCase {
    func testSetupChoiceEndsAsUndecidedWhenDroppedWithoutAnAnswer() async {
        // 알림창이 버튼 없이 사라지면 핸들러와 함께 풀린다. 그때 대기가 끝나야 다음에 다시 안내할 수 있다.
        let dropped: Bool? = await withCheckedContinuation { continuation in
            _ = PendingSetupChoice(continuation)
        }
        XCTAssertNil(dropped)
        let chosen: Bool? = await withCheckedContinuation { continuation in
            let choice = PendingSetupChoice(continuation)
            choice.resolve(true)
            choice.resolve(false) // 두 번째 답과 해제는 무시한다
        }
        XCTAssertEqual(chosen, true)
        let later: Bool? = await withCheckedContinuation { continuation in
            PendingSetupChoice(continuation).resolve(false)
        }
        XCTAssertEqual(later, false)
    }

    func testTransferTimeoutGrowsWithSizeAndKeepsTheOldFloor() {
        XCTAssertEqual(TransferTimeout.resource(bytes: 0), 160)
        XCTAssertEqual(TransferTimeout.resource(bytes: -1), 160)
        XCTAssertEqual(TransferTimeout.resource(bytes: 1024 * 1024), 160)
        // 50MB 를 초당 64KB 로 보내도 끝나야 한다.
        XCTAssertEqual(TransferTimeout.resource(bytes: 50 * 1024 * 1024), 860)
        XCTAssertGreaterThan(TransferTimeout.resource(bytes: 20 * 1024 * 1024), 160)
    }

    func testPairingClaimWaitsOutABusyServer() async throws {
        XCTAssertEqual(PairingClient.claimTimeout, 30)
        let network = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(data: Data(#"{"accessCode":"code"}"#.utf8)) }
        let link = PairingLink(code: "ABCD1234", urls: [network.endpoint.url])
        let result = try await PairingClient.claim(link, device: "test", session: network.session)
        XCTAssertEqual(result.accessCode, "code")
        // 8초면 서버가 바쁠 때 폰은 실패를 보이고 서버는 뒤늦게 일회용 코드를 소비한다.
        XCTAssertEqual(network.requests.map(\.timeoutInterval), [30])
        await network.close()
    }

    #if os(macOS)
    func testChildProcessWaitReturnsExitCodeAndEndsOnTimeoutOrCancellation() async throws {
        let exit = try await LocalHostService.run(URL(fileURLWithPath: "/usr/bin/false"), arguments: [], environment: [:], timeout: 30)
        XCTAssertEqual(exit, 1)
        // 멈춘 자식 프로세스: 제한 시간이 지나면 끝내고 오류로 돌아온다(예전에는 영원히 대기).
        do {
            _ = try await LocalHostService.run(URL(fileURLWithPath: "/bin/sleep"), arguments: ["600"], environment: [:], timeout: 0.2)
            XCTFail("A hung child must not be awaited forever")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("제한 시간"), error.localizedDescription)
        }
        // 취소해도 끝난다.
        let waiting = Task { try await LocalHostService.run(URL(fileURLWithPath: "/bin/sleep"), arguments: ["600"], environment: [:], timeout: 600) }
        waiting.cancel()
        do { _ = try await waiting.value; XCTFail("Cancellation must end the wait") }
        catch { XCTAssertTrue(error is CancellationError) }
        // 실행할 수 없는 파일은 바로 오류다.
        do {
            _ = try await LocalHostService.run(URL(fileURLWithPath: "/nonexistent/iamceo-stab-test"), arguments: [], environment: [:], timeout: 30)
            XCTFail("A missing executable must fail")
        } catch { XCTAssertFalse(error is CancellationError) }
    }
    #endif
}
