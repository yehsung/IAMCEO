import Foundation
import Observation

/// Owns claim/attach/release independently of the renderer's lifetime.
@MainActor @Observable
final class TerminalSession {
    typealias Connect = (APIClient, String, TerminalStreamMode, Int, Int, String?, TerminalSizePolicy) -> Void
    let client: TerminalStreamClient
    let platform: TerminalPlatform
    private(set) var starting = false
    private(set) var ending = false
    private(set) var readOnly: Bool
    private(set) var notice: String?
    private(set) var naturalCols = 100
    private(set) var naturalRows = 30
    @ObservationIgnored private var startBuffer = TerminalStartBuffer()
    @ObservationIgnored private var visible = false
    @ObservationIgnored private var active = false
    @ObservationIgnored private var requestID = UUID()
    @ObservationIgnored private var hasNaturalSize = false
    @ObservationIgnored private var pendingControl: (api: APIClient, memberID: String, leaseID: String)?
    @ObservationIgnored private let connect: Connect

    init(platform: TerminalPlatform = .current, client: TerminalStreamClient = TerminalStreamClient(), connect: Connect? = nil) {
        self.platform = platform; self.client = client
        readOnly = platform.openingMode == .observe
        self.connect = connect ?? { api, memberID, mode, cols, rows, leaseID, policy in
            client.connect(api: api, memberID: memberID, mode: mode, cols: cols, rows: rows, leaseID: leaseID, sizePolicy: policy)
        }
    }

    var controlling: Bool {
        if case .live(mode: .control, cols: _, rows: _) = client.state { return true }
        return false
    }
    var surfaceMode: TerminalStreamMode { controlling || (platform == .mac && !readOnly) ? .control : .observe }

    func appear(store: AppStore, member: Member, active: Bool) {
        visible = true; self.active = active
        client.onReady = { [weak self] mode in
            guard let self, mode == .control else { return }
            if let expiry = self.client.expiresAt { store.updateTerminalStreamLease(memberID: member.id, expiresAt: expiry) }
            self.starting = false
            if self.platform.buffersStartingInput {
                if let bytes = self.startBuffer.take(), !bytes.isEmpty { self.client.send(bytes) }
                else if self.startBuffer.discarded { self.notice = "입력 준비가 길어져 친 키를 버렸습니다. 다시 입력해 주세요." }
                // The viewport may have changed while the attach was in flight.
                self.client.resize(cols: self.naturalCols, rows: self.naturalRows)
            }
        }
        client.onLease = { expiry in store.updateTerminalStreamLease(memberID: member.id, expiresAt: expiry) }
        client.onControlEnded = { [weak self] in
            guard let self else { return }
            var message = self.platform == .mac ? "직접 입력 연결이 끝났습니다." : "직접 입력 연결이 끝났습니다. 보는 중으로 돌아갑니다."
            if case let .closed(reason, serverMessage) = self.client.state {
                if reason == "lease_ended" { store.terminalStreamLeaseEnded(memberID: member.id) }
                message = serverMessage ?? (reason == "lease_ended" ? "조작권이 끝났습니다." : message)
            }
            self.fallback(store: store, member: member, message: message, release: self.platform == .mac)
        }
        open(store: store, member: member)
    }

    private func open(store: AppStore, member: Member) {
        guard visible, active, !starting, !ending, !controlling, client.state != .unsupported else { return }
        if platform.openingMode == .control { beginInput(store: store, member: member) }
        else { observe(store: store, member: member) }
    }

    func sizeChanged(cols: Int, rows: Int) {
        naturalCols = cols; naturalRows = rows; hasNaturalSize = true
        attachControlIfSized()
    }

    private func attachControlIfSized() {
        guard hasNaturalSize, visible, active, starting, let pending = pendingControl else { return }
        pendingControl = nil
        connect(pending.api, pending.memberID, .control, naturalCols, naturalRows, pending.leaseID, platform.controlSizePolicy)
    }

    func pendingInput(_ bytes: Data) {
        guard platform.buffersStartingInput, starting, !readOnly else { return }
        if !startBuffer.append(bytes) { notice = "입력 준비 중에는 4KB·3초까지만 보관합니다. 다시 입력해 주세요." }
    }

    func beginInput(store: AppStore, member: Member) {
        guard visible, active, !starting, !ending, !controlling else { return }
        guard !store.isDemo, store.canWrite else {
            fallback(store: store, member: member, message: store.isDemo ? "샘플은 읽기 전용입니다." : "서버에 연결되지 않아 조작할 수 없습니다.")
            return
        }
        starting = true; readOnly = false; notice = nil
        if platform.buffersStartingInput { startBuffer.begin() }
        // Retrying from the read-only fallback must stop that socket before claiming.
        if platform == .mac { client.close() }
        let token = UUID(); requestID = token
        Task {
            let previousResults = store.operationResults
            let namespace = store.writeNamespace
            let claimed = await store.claimTerminal(member)
            guard requestID == token, visible, active else {
                if claimed { _ = await store.releaseTerminal(member) }
                return
            }
            guard claimed, let lease = store.terminalLeases[member.id]?.leaseId, let api = store.api else {
                // A refused v2 claim is recorded before receipt reconciliation, whose
                // missing/failed lookup can overwrite the shared errorMessage. Keep
                // the claim's own server reason, excluding earlier refusals and input.
                let refusals = store.operationResults.values.filter { receipt in
                    guard receipt.kind == .terminalControl, receipt.memberId == member.id,
                          receipt.status == .refused, previousResults[receipt.operationId]?.status != .refused,
                          let attempt = store.submissions?.terminalAttempt(id: receipt.operationId) else { return false }
                    return attempt.namespace == namespace && attempt.action == .claim
                }
                let refusal = refusals.first { previousResults[$0.operationId] == nil } ?? refusals.first
                fallback(store: store, member: member, message: refusal?.error ?? store.errorMessage ?? "조작권을 받지 못했습니다. 다른 기기나 세션 상태를 확인해 주세요.")
                return
            }
            pendingControl = (api, member.id, lease)
            attachControlIfSized()
        }
    }

    func observe(store: AppStore, member: Member) {
        guard visible, active, !starting, !ending else { return }
        readOnly = true
        if store.isDemo { client.showDemo(); return }
        guard let api = store.api else { return }
        connect(api, member.id, .observe, 100, 30, nil, platform.controlSizePolicy)
    }

    private func fallback(store: AppStore, member: Member, message: String, release: Bool = false) {
        starting = false; readOnly = true; pendingControl = nil; startBuffer.clear(); notice = message
        if release {
            // Disable retry and invalidate the old attach before yielding to the release.
            ending = true; requestID = UUID(); client.close()
            Task {
                if !(await store.releaseTerminal(member)) { notice = store.errorMessage ?? "조작권을 놓지 못했습니다. 다시 닫아 주세요." }
                ending = false
                observe(store: store, member: member)
            }
        } else if platform == .mac {
            observe(store: store, member: member)
        } else if case .live(mode: .observe, cols: _, rows: _) = client.state {
            // iPhone keeps its current observer while an explicit claim is refused.
        } else { observe(store: store, member: member) }
    }

    func finishInput(store: AppStore, member: Member, resume: Bool) async {
        guard !ending else { return }
        ending = true; requestID = UUID(); pendingControl = nil
        client.close(); starting = false; startBuffer.clear()
        if !(await store.releaseTerminal(member)) { notice = store.errorMessage ?? "조작권을 놓지 못했습니다. 다시 닫아 주세요." }
        ending = false
        if resume { observe(store: store, member: member) }
        else if visible && active { open(store: store, member: member) }
    }

    func setActive(_ active: Bool, store: AppStore, member: Member) {
        self.active = active
        if !active {
            if client.state == .unsupported { Task { _ = await store.releaseTerminal(member) } }
            else { Task { await finishInput(store: store, member: member, resume: false) } }
        } else { open(store: store, member: member) }
    }

    func disappear(store: AppStore, member: Member) {
        visible = false; active = false; requestID = UUID(); pendingControl = nil
        starting = false; startBuffer.clear(); client.dispose()
        Task { _ = await store.releaseTerminal(member) }
    }
}
