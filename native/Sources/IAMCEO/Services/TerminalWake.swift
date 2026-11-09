import Foundation
import Observation

enum TerminalAvailability {
    // Missing backend is the older server contract, which also supports core terminals.
    static func supportsTerminal(_ member: Member) -> Bool {
        member.origin != "manual" && member.origin != "adopted"
            && (member.backend == nil || member.backend == "core")
    }

    static func needsWake(_ member: Member) -> Bool {
        supportsTerminal(member) && member.backend == "core" && (member.paneId ?? "").isEmpty
            && ["asleep", "offline"].contains(member.status)
    }

    static func isReady(_ member: Member) -> Bool {
        !(member.paneId ?? "").isEmpty && !["asleep", "offline"].contains(member.status)
    }

    static func title(_ member: Member, waking: Bool, platform: TerminalPlatform = .current,
                      normal: String = "터미널 열기") -> String {
        if waking { return "깨우는 중…" }
        return needsWake(member) ? (platform == .mac ? "깨워서 터미널 열기" : "깨워서 터미널") : normal
    }
}

/// One wake per member across every entry point. Readiness comes from the live AppStore snapshot.
@MainActor @Observable
final class TerminalWake {
    enum Outcome: Equatable, Sendable {
        case ready, failed(String), timedOut, duplicate, cancelled
        var message: String? {
            switch self {
            case .failed(let reason): "깨우지 못했습니다: \(TerminalPresentation.message(reason))"
            case .timedOut: "깨우는 데 시간이 걸립니다. 잠시 뒤 다시 여세요"
            default: nil
            }
        }
    }
    private(set) var members: Set<String> = []

    @MainActor private final class Attempt {
        var continuation: CheckedContinuation<Outcome, Never>?
        var work: Task<Void, Never>?
        var updates: Task<Void, Never>?
        var deadline: Task<Void, Never>?

        func finish(_ outcome: Outcome) {
            guard let continuation else { return }
            self.continuation = nil
            work?.cancel(); updates?.cancel(); deadline?.cancel()
            work = nil; updates = nil; deadline = nil
            continuation.resume(returning: outcome)
        }
    }

    func wake(memberID: String, timeout: Duration? = nil,
              resume: @escaping @MainActor @Sendable () async -> String?,
              current: @escaping @MainActor @Sendable () -> Member?,
              allowed: @escaping @MainActor @Sendable () -> Bool) async -> Outcome {
        guard members.insert(memberID).inserted else { return .duplicate }
        defer { members.remove(memberID) }
        let attempt = Attempt()
        // Interactive terminal opening waits for readiness; legacy callers may still supply a deadline.
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                attempt.continuation = continuation
                if Task.isCancelled { attempt.finish(.cancelled); return }
                attempt.work = Task {
                    guard !Task.isCancelled else { return }
                    let reason = await resume()
                    guard !Task.isCancelled else { return }
                    if let reason { attempt.finish(.failed(reason)); return }
                }
                attempt.updates = Task {
                    while !Task.isCancelled {
                        guard allowed() else { attempt.finish(.failed("서버 연결 또는 프로젝트 상태를 확인해 주세요")); return }
                        guard let member = current() else { attempt.finish(.failed("직원을 찾을 수 없습니다")); return }
                        if TerminalAvailability.isReady(member) { attempt.finish(.ready); return }
                        do { try await Task.sleep(for: .milliseconds(50)) } catch { return }
                    }
                }
                if let timeout {
                    attempt.deadline = Task {
                        do { try await Task.sleep(for: timeout) } catch { return }
                        attempt.finish(.timedOut)
                    }
                }
            }
        } onCancel: {
            Task { @MainActor in attempt.finish(.cancelled) }
        }
    }
}
