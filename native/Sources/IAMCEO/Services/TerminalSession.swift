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
    private(set) var inputEndedStatus: String?
    @ObservationIgnored private var inactiveSince: Date?
    @ObservationIgnored private var inactivityTask: Task<Void, Never>?
    /// 화면을 한 번 클릭해서 시작된 조작인가(버튼이나 타자로 시작한 것이 아님).
    @ObservationIgnored private var clickStarted = false
    /// 클릭만 하고 아무것도 치지 않은 조작권. 자리를 뜨면 곧 놓아 그 직원의 자동 전달을 오래 막지 않는다.
    private var holdsUntypedClick: Bool { clickStarted && !client.sentInput }
    static let inactiveGrace: TimeInterval = 180
    static let untypedClickGrace: TimeInterval = 10
    private(set) var missingTerminal = false
    private(set) var naturalCols = 100
    private(set) var naturalRows = 30
    @ObservationIgnored private var startBuffer = TerminalStartBuffer()
    @ObservationIgnored private var visible = false
    @ObservationIgnored private var active = false
    @ObservationIgnored private var requestID = UUID()
    @ObservationIgnored private var hasNaturalSize = false
    @ObservationIgnored private var pendingControl: (api: APIClient, memberID: String, leaseID: String)?
    @ObservationIgnored private var claimOwner: UUID?
    @ObservationIgnored private var missingPaneID: String?
    private(set) var ownedLeaseID: String?
    @ObservationIgnored private var revalidationTask: Task<Void, Never>?
    @ObservationIgnored private let connect: Connect
    @ObservationIgnored private let send: (Data) -> Void

    init(platform: TerminalPlatform = .current, client: TerminalStreamClient = TerminalStreamClient(), connect: Connect? = nil, send: ((Data) -> Void)? = nil) {
        self.platform = platform; self.client = client
        readOnly = platform.openingMode == .observe
        self.send = send ?? { client.send($0) }
        self.connect = connect ?? { api, memberID, mode, cols, rows, leaseID, policy in
            client.connect(api: api, memberID: memberID, mode: mode, cols: cols, rows: rows, leaseID: leaseID, sizePolicy: policy)
        }
    }

    var controlling: Bool {
        if case .live(mode: .control, cols: _, rows: _) = client.state { return true }
        return false
    }
    var surfaceMode: TerminalStreamMode { controlling || !readOnly ? .control : .observe }

    private let windowOwner = UUID()

    func appear(store: AppStore, member: Member, active: Bool) {
        store.terminalWindowOpened(memberID: member.id, owner: windowOwner)
        visible = true; self.active = active
        client.onReady = { [weak self] mode in
            guard let self, mode == .control else { return }
            if let expiry = self.client.expiresAt, store.terminalLeases[member.id]?.leaseId == self.ownedLeaseID { store.updateTerminalStreamLease(memberID: member.id, expiresAt: expiry) }
            self.starting = false
            if self.platform.buffersStartingInput {
                if let bytes = self.startBuffer.take(), !bytes.isEmpty { self.send(bytes) }
                else if self.startBuffer.discarded { self.notice = String(localized: "입력 준비가 길어져 친 키를 버렸습니다. 다시 입력해 주세요.") }
                // The viewport may have changed while the attach was in flight.
                self.client.resize(cols: self.naturalCols, rows: self.naturalRows)
            }
        }
        client.onLease = { [weak self] expiry in
            guard let self, let id = self.ownedLeaseID, store.terminalLeases[member.id]?.leaseId == id else { return }
            store.updateTerminalStreamLease(memberID: member.id, expiresAt: expiry)
        }
        client.onControlEnded = { [weak self] in
            guard let self else { return }
            var message = String(localized: "직접 입력 연결이 끝났습니다.")
            if case let .closed(reason, serverMessage) = self.client.state {
                if reason == "lease_ended", let id = self.ownedLeaseID, store.terminalLeases[member.id]?.leaseId == id { store.terminalStreamLeaseEnded(memberID: member.id) }
                message = serverMessage ?? (reason == "lease_ended" ? String(localized: "조작권이 끝났습니다.") : message)
            }
            if case .closed(reason: "disconnected", message: _) = self.client.state {
                self.inputEndedStatus = TerminalPresentation.disconnectedStatus
            }
            self.fallback(store: store, member: member, message: message, release: true)
        }
        open(store: store, member: member)
    }

    private func open(store: AppStore, member: Member) {
        let member = store.members.first { $0.id == member.id } ?? member
        if TerminalAvailability.needsWake(member) { memberChanged(store: store, member: member); return }
        guard !missingTerminal else { return }
        guard visible, active, !starting, !ending, !controlling, client.state != .unsupported else { return }
        if platform.openingMode == .control { beginInput(store: store, member: member) }
        else { observe(store: store, member: member) }
    }

    #if os(macOS)
    /// 터미널 창이 key를 잃거나 되찾았다. 클릭만으로 잡은 조작권에만 쓴다: 직접 시작했거나 타자한 조작은 지금처럼 앱 단위로 판단한다.
    func windowKeyChanged(_ isKey: Bool, store: AppStore, member: Member) {
        if isKey { if inactiveSince != nil { setActive(true, store: store, member: member) } }
        else if holdsUntypedClick, controlling || starting { setActive(false, store: store, member: member) }
    }
    #endif

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
        if !startBuffer.append(bytes) { notice = String(localized: "입력 준비 중에는 4KB·3초까지만 보관합니다. 다시 입력해 주세요.") }
    }

    /// All human input uses the same claim/refusal path as the input button.
    func requestInput(_ bytes: Data, store: AppStore, member: Member) {
        if controlling { if !bytes.isEmpty { send(bytes) }; return }
        if !starting { startInput(store: store, member: member, byClick: bytes.isEmpty) }
        else if !bytes.isEmpty { clickStarted = false }
        pendingInput(bytes)
    }

    func beginInput(store: AppStore, member: Member) { startInput(store: store, member: member, byClick: false) }

    private func startInput(store: AppStore, member: Member, byClick: Bool) {
        clickStarted = byClick
        client.renewsBeforeInput = !byClick
        beginClaim(store: store, member: member)
    }

    private func beginClaim(store: AppStore, member: Member) {
        let member = store.members.first { $0.id == member.id } ?? member
        if TerminalAvailability.needsWake(member) { memberChanged(store: store, member: member); return }
        guard !missingTerminal else { return }
        guard visible, active, !starting, !ending, !controlling else { return }
        if !store.isDemo, !store.canWrite, store.isRevalidating, store.api != nil,
           store.connectionStatus == .connected || store.connectionLost {
            starting = true; readOnly = false; notice = String(localized: "서버 연결을 확인하고 있습니다.")
            if platform.buffersStartingInput, startBuffer.startedAt == nil { startBuffer.begin() }
            let token = UUID(); requestID = token
            revalidationTask?.cancel()
            revalidationTask = Task {
                while store.isRevalidating && store.api != nil && (store.connectionStatus == .connected || store.connectionLost) && !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(50))
                }
                guard !Task.isCancelled, requestID == token, visible, active else { return }
                starting = false
                beginClaim(store: store, member: member)
            }
            return
        }
        guard !store.isDemo, store.canWrite else {
            fallback(store: store, member: member, message: store.isDemo ? String(localized: "샘플의 터미널은 예시 화면이라 입력할 수 없습니다.") : String(localized: "서버에 연결되지 않아 조작할 수 없습니다."))
            return
        }
        // 메인 창이 다른 프로젝트를 보는 동안에는 이 직원의 조작권을 받을 수 없다. 보기 연결은 건드리지 않고 이유만 알린다.
        guard Self.canControl(member, in: store) else {
            starting = false
            notice = String(localized: "메인 창이 다른 프로젝트를 보고 있어 입력할 수 없습니다. 이 팀원의 프로젝트로 돌아온 뒤 다시 시도하세요.")
            return
        }
        starting = true; readOnly = false; notice = nil; inputEndedStatus = nil
        if platform.buffersStartingInput, startBuffer.startedAt == nil { startBuffer.begin() }
        // Retrying from the read-only fallback must stop that socket before claiming.
        client.close()
        let previousOwner = takeOwner()
        let token = UUID(); requestID = token; claimOwner = token
        Task {
            if let previousOwner { _ = await store.releaseTerminalSession(member, owner: previousOwner) }
            guard requestID == token, visible, active else { return }
            let previousResults = store.operationResults
            let namespace = store.writeNamespace
            let acquired = await store.claimTerminalSession(member, owner: token)
            let claimed = acquired != nil
            guard requestID == token, visible, active else {
                _ = await store.releaseTerminalSession(member, owner: token)
                return
            }
            guard claimed, let lease = acquired?.leaseId, let api = store.api else {
                if store.isRevalidating, store.api != nil, store.connectionStatus == .connected || store.connectionLost {
                    starting = false
                    beginClaim(store: store, member: member)
                    return
                }
                // Use this claim's own server reason even when its missing-terminal
                // refusal is handled inside this window. Exclude older refusals and input.
                let refusals = store.operationResults.values.filter { receipt in
                    guard receipt.kind == .terminalControl, receipt.memberId == member.id,
                          receipt.status == .refused, previousResults[receipt.operationId]?.status != .refused,
                          let attempt = store.submissions?.terminalAttempt(id: receipt.operationId) else { return false }
                    return attempt.namespace == namespace && attempt.action == .claim
                }
                let refusal = refusals.first { previousResults[$0.operationId] == nil } ?? refusals.first
                fallback(store: store, member: member, message: refusal?.error ?? store.terminalWindowNotice(memberID: member.id) ?? store.rawErrorMessage ?? String(localized: "조작권을 받지 못했습니다. 다른 기기나 세션 상태를 확인해 주세요."),
                         reason: refusal?.error != nil ? refusal?.reason : nil)
                return
            }
            ownedLeaseID = lease
            pendingControl = (api, member.id, lease)
            attachControlIfSized()
        }
    }

    /// 조작권 요청은 지금 선택된 프로젝트의 직원에게만 보낼 수 있다(쓰기 revision이 그 프로젝트 것뿐이다).
    static func canControl(_ member: Member, in store: AppStore) -> Bool {
        store.members.contains { $0.id == member.id }
    }

    /// 버튼을 눌렀다는 것은 창이 보이고 쓰이고 있다는 뜻이다. 잠자기 뒤처럼 active가 꺼진 채 남아 있어도 반응한다.
    func userReconnect(store: AppStore, member: Member) { markActive(); observe(store: store, member: member) }
    func userBeginInput(store: AppStore, member: Member) { markActive(); beginInput(store: store, member: member) }
    private func markActive() {
        inactiveSince = nil; inactivityTask?.cancel(); inactivityTask = nil
        if visible { active = true }
    }

    func observe(store: AppStore, member: Member) {
        let member = store.members.first { $0.id == member.id } ?? member
        if TerminalAvailability.needsWake(member) { memberChanged(store: store, member: member); return }
        guard !missingTerminal else { return }
        guard visible, active, !starting, !ending else { return }
        readOnly = true
        if store.isDemo { client.showDemo(); return }
        guard let api = store.api else { return }
        connect(api, member.id, .observe, 100, 30, nil, platform.controlSizePolicy)
    }

    private func takeOwner() -> UUID? {
        let owner = claimOwner
        claimOwner = nil; ownedLeaseID = nil
        return owner
    }

    private func release(store: AppStore, member: Member, owner: UUID?) async -> Bool {
        guard let owner else { return true }
        return await store.releaseTerminalSession(member, owner: owner)
    }

    /// reason: 서버가 준 좁은 사유 코드(있으면 문장 대신 그것으로 가른다, ServerCode).
    private func fallback(store: AppStore, member: Member, message: String, reason: String? = nil, release: Bool = false) {
        if ServerCode.terminalMissing(reason: reason, message: message), TerminalAvailability.supportsTerminal(member) {
            terminalDisappeared(store: store, member: member)
            return
        }
        starting = false; readOnly = true; pendingControl = nil; startBuffer.clear(); notice = TerminalPresentation.message(message, reason: reason)
        if release {
            // Disable retry and invalidate the old attach before yielding to the release.
            ending = true; requestID = UUID(); client.close()
            let owner = takeOwner()
            Task {
                if !(await self.release(store: store, member: member, owner: owner)) { notice = store.errorMessage ?? String(localized: "조작권을 놓지 못했습니다. 다시 닫아 주세요.") }
                ending = false
                observe(store: store, member: member)
            }
        } else { observe(store: store, member: member) }
    }

    func memberChanged(store: AppStore, member: Member) {
        if TerminalAvailability.needsWake(member) { terminalDisappeared(store: store, member: member) }
        else if missingTerminal, TerminalAvailability.isReady(member), member.paneId != missingPaneID, !ending {
            missingTerminal = false; notice = nil
            open(store: store, member: member)
        } else if TerminalAvailability.isReady(member) { reopenIfRefused(store: store, member: member) }
    }

    /// 거절로 멈춘 보기 연결은 느린 재시도를 기다리지 않고 바로 다시 붙는다(직원 상태가 바뀌었거나 창으로 돌아왔을 때).
    private func reopenIfRefused(store: AppStore, member: Member) {
        guard !missingTerminal, visible, active, !starting, !ending, !controlling, readOnly,
              case .closed(reason: "refused", message: _) = client.state else { return }
        open(store: store, member: member)
    }

    func streamChanged(store: AppStore, member: Member) {
        if case .closed(_, let message) = client.state,
           message?.contains("No core terminal for member") == true, TerminalAvailability.supportsTerminal(member) {
            terminalDisappeared(store: store, member: member)
        }
    }

    private func terminalDisappeared(store: AppStore, member: Member) {
        let member = store.members.first { $0.id == member.id } ?? member
        missingPaneID = member.paneId
        guard !missingTerminal else { return }
        missingTerminal = true; notice = nil; starting = false; readOnly = true
        requestID = UUID(); pendingControl = nil; startBuffer.clear(); revalidationTask?.cancel(); client.close()
        let owner = takeOwner()
        ending = true
        Task {
            _ = await release(store: store, member: member, owner: owner)
            ending = false
            memberChanged(store: store, member: store.members.first { $0.id == member.id } ?? member)
        }
    }

    func finishInput(store: AppStore, member: Member, resume: Bool) async {
        guard !ending else { return }
        ending = true; requestID = UUID(); pendingControl = nil; revalidationTask?.cancel()
        let owner = takeOwner()
        client.close(); starting = false; startBuffer.clear()
        readOnly = true
        if !(await release(store: store, member: member, owner: owner)) { notice = store.errorMessage ?? String(localized: "조작권을 놓지 못했습니다. 다시 닫아 주세요.") }
        ending = false
        if resume { observe(store: store, member: member) }
        else if visible && active { open(store: store, member: member) }
    }

    func setActive(_ active: Bool, store: AppStore, member: Member, immediately: Bool = false, now: Date = Date()) {
        if !active, platform == .mac, !immediately {
            guard self.active, inactiveSince == nil else { return }
            inactiveSince = now
            let grace = holdsUntypedClick ? Self.untypedClickGrace : Self.inactiveGrace
            inactivityTask = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(grace)) } catch { return }
                self?.endInputIfInactive(store: store, member: member)
            }
            return
        }
        inactiveSince = nil; inactivityTask?.cancel(); inactivityTask = nil
        guard self.active != active else {
            // Mac 유예 중에는 active 가 그대로라 돌아와도 다시 열 계기가 없다.
            if active { reopenIfRefused(store: store, member: member) }
            return
        }
        self.active = active
        if !active {
            revalidationTask?.cancel()
            Task { await finishInput(store: store, member: member, resume: false) }
        } else if !controlling, !starting {
            // A brief Mac focus change leaves both sockets and leases intact.
            if case .live = client.state { return }
            open(store: store, member: member)
        }
    }

    func endInputIfInactive(store: AppStore, member: Member, now: Date = Date()) {
        guard let inactiveSince, visible, active,
              now.timeIntervalSince(inactiveSince) >= (holdsUntypedClick ? Self.untypedClickGrace : Self.inactiveGrace) else { return }
        self.inactiveSince = nil; inactivityTask?.cancel(); inactivityTask = nil
        guard controlling || starting || ownedLeaseID != nil else { return }
        inputEndedStatus = TerminalPresentation.inactiveStatus
        // 조작만 끝낸다. 옆에 띄워 둔 창이 멈춘 화면이 되지 않도록 읽기 전용 보기는 이어 간다.
        Task { await finishInput(store: store, member: member, resume: true) }
    }

    func disappear(store: AppStore, member: Member) {
        store.terminalWindowClosed(owner: windowOwner)
        inactiveSince = nil; inactivityTask?.cancel(); inactivityTask = nil
        visible = false; active = false; requestID = UUID(); pendingControl = nil
        starting = false; startBuffer.clear(); revalidationTask?.cancel(); client.dispose()
        let owner = takeOwner()
        Task { _ = await self.release(store: store, member: member, owner: owner) }
    }
}
