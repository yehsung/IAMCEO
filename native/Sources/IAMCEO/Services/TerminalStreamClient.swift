import Foundation
import Observation

enum TerminalStreamMode: String, Codable, Sendable { case observe, control }
enum TerminalSizePolicy: String, Sendable { case core, fit }

enum TerminalPlatform: Sendable {
    case mac, iPhone
    static var current: Self {
        #if os(macOS)
        .mac
        #else
        .iPhone
        #endif
    }
    var controlSizePolicy: TerminalSizePolicy { .fit }
    var openingMode: TerminalStreamMode { .observe }
    var buffersStartingInput: Bool { true }
    var observeHint: String { "읽기 전용 화면입니다" }
    func usesCoreGrid(mode: TerminalStreamMode) -> Bool { mode == .observe || controlSizePolicy == .core }
    func acceptsKeyboard(mode: TerminalStreamMode) -> Bool { mode == .control }
}
enum TerminalStreamState: Equatable, Sendable {
    case connecting
    case live(mode: TerminalStreamMode, cols: Int, rows: Int)
    case closed(reason: String, message: String?)
    case unsupported
}

enum TerminalStreamEvent: Equatable, Sendable {
    case ready(mode: TerminalStreamMode, cols: Int, rows: Int, expiresAt: Double?)
    case resize(cols: Int, rows: Int)
    case lease(expiresAt: Double)
    case closed(reason: String, message: String?)

    static func parse(_ text: String) -> Self? {
        struct Wire: Decodable {
            let type: String
            var mode: TerminalStreamMode?
            var cols: Int?
            var rows: Int?
            var expiresAt: Double?
            var reason: String?
            var message: String?
        }
        guard let wire = try? JSONDecoder().decode(Wire.self, from: Data(text.utf8)) else { return nil }
        switch wire.type {
        case "ready":
            guard let mode = wire.mode, let cols = wire.cols, let rows = wire.rows,
                  (1...65535).contains(cols), (1...65535).contains(rows) else { return nil }
            return .ready(mode: mode, cols: cols, rows: rows, expiresAt: wire.expiresAt)
        case "resize":
            guard let cols = wire.cols, let rows = wire.rows, (1...65535).contains(cols), (1...65535).contains(rows) else { return nil }
            return .resize(cols: cols, rows: rows)
        case "lease": return wire.expiresAt.map { .lease(expiresAt: $0) }
        case "closed": return wire.reason.map { .closed(reason: $0, message: wire.message) }
        default: return nil
        }
    }
}

/// Bytes typed during claim/attach are replayed once, only within the bounded window.
struct TerminalStartBuffer {
    private(set) var data = Data()
    private(set) var startedAt: Date?
    private(set) var discarded = false
    mutating func begin(now: Date = Date()) { data = Data(); startedAt = now; discarded = false }
    @discardableResult mutating func append(_ bytes: Data, now: Date = Date()) -> Bool {
        guard !bytes.isEmpty else { return !discarded }
        guard let startedAt, !discarded, now.timeIntervalSince(startedAt) <= 3, data.count + bytes.count <= 4096 else {
            data = Data(); discarded = true; return false
        }
        data.append(bytes); return true
    }
    mutating func take(now: Date = Date()) -> Data? {
        defer { data = Data(); startedAt = nil }
        guard let startedAt else { return nil }
        if data.isEmpty && !discarded { return Data() }
        guard !discarded, now.timeIntervalSince(startedAt) <= 3 else { discarded = true; return nil }
        return data
    }
    mutating func clear() { self = Self() }
}

@MainActor @Observable
final class TerminalStreamClient {
    private(set) var state: TerminalStreamState = .connecting
    private(set) var expiresAt: Double?
    private(set) var outputGeneration = UUID()
    private(set) var grid = (cols: 100, rows: 30)
    @ObservationIgnored var onOutput: ((Data) -> Void)? {
        didSet { if let onOutput { let bytes = pendingOutput; pendingOutput.removeAll(); bytes.forEach(onOutput) } }
    }
    @ObservationIgnored var onReady: ((TerminalStreamMode) -> Void)?
    @ObservationIgnored var onLease: ((Double) -> Void)?
    @ObservationIgnored var onControlEnded: (() -> Void)?
    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private var receiveTask: Task<Void, Never>?
    @ObservationIgnored private var sendTask: Task<Void, Never>?
    @ObservationIgnored private var resizeTask: Task<Void, Never>?
    @ObservationIgnored private var session: URLSession
    @ObservationIgnored private var pendingOutput: [Data] = []
    @ObservationIgnored private var connection = UUID()
    @ObservationIgnored private var outputOwner: UUID?
    @ObservationIgnored private var sizePolicy: TerminalSizePolicy = .fit
    @ObservationIgnored private let resizeSender: ((String) async throws -> Void)?

    func attachOutput(owner: UUID, handler: @escaping (Data) -> Void) { outputOwner = owner; onOutput = handler }
    func detachOutput(owner: UUID) { if outputOwner == owner { onOutput = nil; outputOwner = nil } }

    init(session: URLSession? = nil, resizeSender: ((String) async throws -> Void)? = nil) {
        self.resizeSender = resizeSender
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.timeoutIntervalForResource = 0
        self.session = session ?? URLSession(configuration: config, delegate: OriginRedirectDelegate(), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }
    static func isUnsupported(status: Int) -> Bool { [404, 405, 501].contains(status) }
    static func reconnectDelay(attempt: Int) -> Double { [1, 2, 4, 8, 15][min(4, max(0, attempt))] }

    func connect(api: APIClient, memberID: String, mode: TerminalStreamMode, cols: Int = 100, rows: Int = 30, leaseID: String? = nil,
                 sizePolicy: TerminalSizePolicy = TerminalPlatform.current.controlSizePolicy) {
        close()
        self.sizePolicy = sizePolicy
        let token = UUID(); connection = token
        state = .connecting
        receiveTask = Task { [weak self] in
            var retry = TerminalReconnectPolicy()
            var liveSince: Date?
            while !Task.isCancelled {
                guard let self, self.connection == token else { return }
                self.state = .connecting
                self.pendingOutput.removeAll()
                do {
                    let request = try await api.terminalStreamRequest(memberID: memberID, mode: mode, cols: cols, rows: rows, leaseID: leaseID, sizePolicy: sizePolicy)
                    guard !Task.isCancelled, self.connection == token else { return }
                    let ws = self.session.webSocketTask(with: request)
                    self.socket = ws; ws.resume()
                    while !Task.isCancelled {
                        let message = try await ws.receive()
                        guard self.connection == token else { return }
                        switch message {
                        case .data(let bytes): self.output(bytes)
                        case .string(let text):
                            if let event = TerminalStreamEvent.parse(text) {
                                self.accept(event)
                                if case .ready = event { liveSince = Date() }
                                if case .resize = event, mode == .observe { throw StreamResized() }
                                if case .closed = event { throw StreamEnded() }
                            }
                        @unknown default: break
                        }
                    }
                } catch {
                    guard !Task.isCancelled, self.connection == token else { return }
                    var status = (self.socket?.response as? HTTPURLResponse)?.statusCode ?? (error as? APIError)?.status ?? 0
                    var refusal: APIError?
                    // Foundation does not expose the body of a rejected upgrade.
                    if !(error is StreamEnded) && !(error is StreamResized) && (status == 0 || status == 409) {
                        refusal = await api.terminalStreamRefusal(memberID: memberID)
                        guard !Task.isCancelled, self.connection == token else { return }
                        if let refusal { status = refusal.status }
                    }
                    self.socket?.cancel(with: .goingAway, reason: nil); self.socket = nil
                    if error is StreamResized { continue }
                    if Self.isUnsupported(status: status) { self.state = .unsupported; return }
                    if case .closed = self.state {} else {
                        self.state = .closed(reason: "disconnected", message: refusal?.message ?? (status == 401 ? "접속 코드를 확인해 주세요" : status == 409 ? "세션을 처리 중이거나 조작권이 없습니다" : "터미널 연결이 끊겼습니다"))
                    }
                    if mode == .control { self.onControlEnded?(); return }
                    let stable = liveSince.map { Date().timeIntervalSince($0) >= 15 } ?? false
                    liveSince = nil
                    guard let delay = retry.failed(status: status, code: refusal?.code, stable: stable) else {
                        self.state = .closed(reason: "refused", message: refusal?.message ?? "터미널 연결이 계속 거절되었습니다")
                        return
                    }
                    do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                }
            }
        }
    }
    func accept(_ event: TerminalStreamEvent) {
        switch event {
        case let .ready(mode, cols, rows, expiry):
            onOutput = nil; outputOwner = nil
            grid = (cols, rows); outputGeneration = UUID()
            expiresAt = expiry; state = .live(mode: mode, cols: cols, rows: rows); onReady?(mode)
        case let .resize(cols, rows):
            guard case let .live(mode, _, _) = state else { return }
            grid = (cols, rows)
            if mode == .observe {
                onOutput = nil; outputOwner = nil; pendingOutput.removeAll(); outputGeneration = UUID()
            }
            state = .live(mode: mode, cols: cols, rows: rows)
        case .lease(let expiry): expiresAt = expiry; onLease?(expiry)
        case let .closed(reason, message): state = .closed(reason: reason, message: message)
        }
    }
    private func output(_ bytes: Data) {
        if let onOutput { onOutput(bytes) } else { pendingOutput.append(bytes) }
    }
    func showDemo() {
        close(); onOutput = nil; outputOwner = nil; grid = (100, 30); outputGeneration = UUID()
        state = .live(mode: .observe, cols: 100, rows: 30)
        output(Data("\u{1b}c\u{1b}[38;5;141m╭─ Claude Code ──────────────────────────────╮\r\n│ IAMCEO · 샘플 프로젝트                     │\r\n╰────────────────────────────────────────────╯\u{1b}[0m\r\n\r\n\u{1b}[32m●\u{1b}[0m 요청한 변경을 확인했습니다.\r\n  앱 안에서 CLI 화면과 색을 확인할 수 있습니다.\r\n\r\n\u{1b}[38;5;141m❯\u{1b}[0m 다음 작업을 입력하세요\r\n".utf8))
    }
    func send(_ bytes: Data) {
        guard case .live(mode: .control, cols: _, rows: _) = state, let socket else { return }
        // Serialize sends so fast typing cannot overtake earlier bytes.
        let previous = sendTask
        let token = connection
        sendTask = Task { [weak self] in
            await previous?.value
            guard let self, !Task.isCancelled, self.connection == token else { return }
            do { try await socket.send(.data(bytes)) } catch { socket.cancel(with: .goingAway, reason: nil) }
        }
    }
    func resize(cols: Int, rows: Int) {
        resizeTask?.cancel()
        guard sizePolicy == .fit, case .live(mode: .control, cols: _, rows: _) = state, socket != nil || resizeSender != nil else { return }
        let socket = socket
        let token = connection
        resizeTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .milliseconds(150))
                guard let self, self.connection == token else { return }
                let data = try JSONSerialization.data(withJSONObject: ["type": "resize", "cols": cols, "rows": rows])
                let text = String(decoding: data, as: UTF8.self)
                if let sender = self.resizeSender { try await sender(text) }
                else if let socket { try await socket.send(.string(text)) }
            } catch { /* cancellation or receive loop will handle disconnect */ }
        }
    }
    func close() {
        connection = UUID()
        receiveTask?.cancel(); receiveTask = nil
        sendTask?.cancel(); sendTask = nil
        resizeTask?.cancel(); resizeTask = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        pendingOutput.removeAll()
        state = .closed(reason: "client_closed", message: nil)
    }
    /// Sheet teardown breaks callbacks that capture SwiftUI State and invalidates the session.
    func dispose() {
        onReady = nil; onLease = nil; onControlEnded = nil; onOutput = nil; outputOwner = nil
        close(); session.invalidateAndCancel()
    }
    private struct StreamEnded: Error {}
    private struct StreamResized: Error {}
}

/// Retry state survives short-lived ready/output bursts from a failing attach.
struct TerminalReconnectPolicy {
    private(set) var attempt = 0
    private(set) var refusals = 0
    mutating func failed(status: Int, code: String?, stable: Bool = false) -> Double? {
        if stable { attempt = 0; refusals = 0 }
        refusals = status == 409 && code == "TERMINAL_REFUSED" ? refusals + 1 : 0
        guard refusals < 3 else { return nil }
        let delay = [1.0, 2, 4, 8, 15][min(4, attempt)]
        attempt += 1
        return delay
    }
}

struct TerminalPresentation {
    /// Display only: APIError.message, stream state and receipts retain the server's original text.
    static func message(_ raw: String) -> String {
        let translations = [
            ("No core terminal for member", "이 직원은 잠들어 있어 터미널이 없습니다"),
            ("Terminal has finished", "터미널이 종료되었습니다"),
            ("A matching active terminal control lease is required", "직접 조작 시간이 끝났습니다. 다시 시작하세요"),
            ("Another terminal control lease is active", "다른 기기에서 터미널을 조작하고 있습니다")
        ]
        return translations.reduce(raw) { text, pair in text.replacingOccurrences(of: pair.0, with: pair.1) }
    }

    static func controlStatus(expiresAt: Double?, now: Date) -> String {
        let status = "직접 입력 중 · 보낸 지시는 잠시 기다립니다"
        guard let expiresAt else { return status }
        let seconds = max(0, Int(ceil(expiresAt / 1000 - now.timeIntervalSince1970)))
        return seconds < 60 ? "\(status) · \(seconds)초 남음" : status
    }
    static func holdsLease(_ lease: TerminalLease?, now: Date = Date()) -> Bool {
        lease?.leaseId != nil && (lease?.expiresAt.map { $0 > now.timeIntervalSince1970 * 1000 } ?? true)
    }
    static func canReconnect(starting: Bool, ending: Bool, controlling: Bool) -> Bool {
        !starting && !ending && !controlling
    }
    static func pausesFollowing(userScroll: Bool, programmatic: Bool, layingOut: Bool) -> Bool {
        userScroll && !programmatic && !layingOut
    }
    static func renderScale(zoom: CGFloat, screen: CGFloat) -> CGFloat { max(1, zoom) * screen }
}

/// One reading preference shared by the live and legacy iPhone renderers (12–36pt).
enum TerminalReadingScale {
    static let preferenceKey = "terminalReadingZoom"
    static func zoom(_ value: Double) -> Double {
        value.isFinite ? min(max(value, 1), 3) : 1
    }
}
