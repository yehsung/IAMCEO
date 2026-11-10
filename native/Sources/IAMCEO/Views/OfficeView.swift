import SwiftUI

// 팀 > 사무실: a calm, work-first office on the team plate. The lead (총괄) sits alone at the top behind a wide desk,
// facing the team; below it the team sits in bands, two rows of desks facing each other on an even grid of columns
// that spans the plate. Every session is the same small pixel mascot with its own desk (desk, laptop or monitor,
// keyboard, chair; nothing else); its body colour is its state, and one small accessory tells members apart (the lead
// wears the crown). Working ones type at a lit screen; one waiting for the CEO looks up (or turns its chair around)
// with a "?", one at an approval prompt waves with a "!", an error squashes flat with dizzy eyes. Nobody leaves the
// desk: one on a break folds its paws on it, content; an asleep one slumps onto it under drifting z's. At most
// `OfficeSeating.workerDesks` team desks: past that the longest unused give theirs up and wait in a quiet row under the
// scene until they work again. Sessions keep their work names; residents never carry letters or initials. Map, art,
// sprites, cast and drawing live in Views/Office/.

/// Help text of the 팀장 추가 button (office header, and the bare button when there is no team yet).
@MainActor func teamAddMemberHelp(_ store: AppStore, _ project: Project) -> String {
    if store.isDemo { return "샘플은 읽기 전용입니다" }
    if !store.canWrite { return "서버에 연결되면 추가할 수 있습니다" }
    if !project.runnerEnabled { return "총괄을 시작한 뒤 추가할 수 있습니다" }
    return "새 CLI 세션을 띄워 팀장으로 등록합니다"
}

/// State label. In the office an idle CLI reads as a break, not as "대기".
private func officeStateLabel(_ status: String) -> String {
    status == "unknown" ? "상태 확인 불가" : status == "idle" ? "쉬는 중" : MemberStatusInfo(status).label
}

private func officeStateKey(_ member: Member) -> String {
    MemberStatusInfo.isUncertain(member) ? "unknown" : member.status
}

/// Keep observation failures and quiet-run guidance consistent with Home and member detail.
func officeStateLabel(_ member: Member) -> String {
    MemberStatusInfo.isUncertain(member) ? MemberStatusInfo(member).label : officeStateLabel(member.status)
}

/// The office's state colour: the body colour of a resident in that state (its base tone), so the header legend and
/// the nameplate dots match what the scene shows. nil for states nobody is drawn in (offline, unknown).
private func officeStateColor(_ status: String) -> Color? {
    guard let ramp = OfficeArt.states[status], let i = OfficeArt.stateRoles.firstIndex(of: "b"), ramp.indices.contains(i)
    else { return nil }
    return Color(hex: ramp[i])
}

/// A state dot in the office's state colour; offline and unknown states, which have no body, are a hollow ring.
private struct OfficeStateDot: View {
    let status: String
    var size: CGFloat = 5

    var body: some View {
        if let color = officeStateColor(status) {
            Circle().fill(color).frame(width: size, height: size)
        } else {
            Circle().strokeBorder(MemberStatusInfo(status).tone.color, lineWidth: size > 5 ? 1.4 : 1).frame(width: size, height: size)
        }
    }
}

/// Absent: offline or in an unknown state (no body is drawn). Such desks recede, their chairs empty.
private func officeAway(_ status: String) -> Bool {
    !["working", "waiting", "blocked", "error", "idle", "asleep"].contains(status)
}

/// A quieter nameplate: asleep or absent.
private func officeDim(_ status: String) -> Bool {
    status == "asleep" || officeAway(status)
}

/// Same rule as the member detail: no terminal for a session started by hand or by a legacy runner.
private func officeAllowsTerminal(_ member: Member) -> Bool {
    TerminalAvailability.supportsTerminal(member)
}

/// What the message box (and accessibility) says a member is doing.
private func officeDetail(_ member: Member) -> String {
    if MemberStatusInfo.isUncertain(member) { return MemberStatusInfo(member).explanation }
    let now = plainOneLine(member.now)
    switch member.status {
    case "error":
        if let error = member.lastError, !error.isEmpty { return plainOneLine(friendlyError(error)) }
    case "idle", "asleep":
        return now.isEmpty ? (member.status == "idle" ? "맡은 일 없음" : "세션을 내려 두었습니다") : "마지막: \(now)"
    case "offline":
        return "세션을 찾지 못했습니다"
    default:
        break
    }
    return now.isEmpty ? "맡은 일 없음" : now
}

// MARK: - Cache

/// Memoised map and residents (not observed: rebuilding only follows the inputs read in `body`).
@MainActor
private final class OfficeCache {
    private var key = ""
    private(set) var map = OfficeMap()
    private(set) var revision = 0
    private var wearKey = ""
    private var residents: [String: OfficeResident] = [:]
    /// Frames composed per accessory, kept across team changes.
    private var shapes: [OfficeAccessory: OfficeShapeSet] = [:]

    func map(key: String, build: () -> OfficeMap) -> (OfficeMap, Int) {
        if key != self.key {
            self.key = key
            map = build()
            revision &+= 1
        }
        return (map, revision)
    }

    /// One accessory per member in display order (see `OfficeWear.assign`), with its composed frames.
    func residents(_ ids: [String], lead: String?) -> [String: OfficeResident] {
        let key = (lead ?? "") + "|" + ids.joined(separator: ",")
        if key != wearKey {
            wearKey = key
            residents = OfficeWear.assign(ids, lead: lead).mapValues { accessory in
                let set = shapes[accessory] ?? OfficeShapeSet(accessory: accessory)
                shapes[accessory] = set
                return OfficeResident(accessory: accessory, shapes: set)
            }
        }
        return residents
    }
}

// MARK: - Office

struct OfficeView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var displayScale
    @Environment(\.scenePhase) private var scenePhase
    /// Mac and regular-width iPad: the wide office (more columns, the rest area a column at the right edge).
    @Environment(\.ceWide) private var wide
    /// Mac은 숨은 탭도 계속 올려 둔다. 보이지 않는 동안에는 장면을 한 프레임만 그리고 멈춘다.
    @Environment(\.ceTabVisible) private var tabVisible
    #if os(macOS)
    /// Keyboard focus is only shown while the window is active (a background window keeps AppKit's first key view).
    @Environment(\.appearsActive) private var appearsActive
    @State private var windowAllowsAnimation = false
    #endif
    let project: Project
    let members: [Member]
    let decisions: [Decision]

    @State private var width: CGFloat = 0
    /// Moves the map onto the device pixel grid when the stage itself sits between pixels.
    @State private var nudge: CGSize = .zero
    @State private var cache = OfficeCache()
    /// The cast being drawn, and the walks in progress (the only moving state; positions are pure functions of time).
    @State private var cast: OfficeCast?
    @State private var plans: [String: OfficeWalkPlan] = [:]
    @State private var hovered: String?
    @State private var visible = true
    @State private var fadeUntil: Double = 0
    @AppStorage("teamOfficeList") private var savedShowsList = false
    @State private var sampleShowsList = false
    private var showsList: Bool { store.isDemo ? sampleShowsList : savedShowsList }
    private var listSelection: Binding<Bool> {
        Binding(get: { showsList }, set: {
            if store.isDemo { sampleShowsList = $0 } else { savedShowsList = $0 }
        })
    }
    @State private var fadeTick = 0
    @FocusState private var focused: String?
    #if DEBUG
    /// `--office-cycle` (demo only): 자료 조사 goes back and forth between a break and work, to review the walk.
    @State private var cycleWorking = false
    #endif

    init(project: Project, members: [Member], decisions: [Decision]) {
        self.project = project
        self.members = members
        self.decisions = decisions
    }

    /// Lead first, then everyone in `state.members` order. Never sorted by status.
    private var shown: [Member] {
        var ordered = members.filter { $0.kind != "worker" } + members.filter { $0.kind == "worker" }
        #if DEBUG
        ordered = OfficeDebug.members(ordered)
        if cycleWorking {
            ordered = ordered.map { member in
                var copy = member
                if copy.id == "m-research" && copy.status == "idle" { copy.status = "working" }
                return copy
            }
        }
        #endif
        return ordered
    }

    var body: some View {
        let list = shown
        // Web team panels (.tm-card, .tm-work__list): radius 18, text 16pt in from the edge.
        Plate(padding: 0, radius: CERadius.card) {
            VStack(alignment: .leading, spacing: 12) {
                OfficeHeader(counts: Self.counts(list), showsAdd: !project.isHq,
                             canAdd: store.canWrite && project.runnerEnabled, help: teamAddMemberHelp(store, project)) {
                    router.showNewMember = true
                }
                .padding(.horizontal, isMac ? 2 : 4)
                #if os(iOS)
                CESegmentPill(selection: listSelection, items: [(false, "사무실"), (true, "목록")])
                    .accessibilityLabel("팀 보기")
                if showsList {
                    OfficeNowList(members: list, decisions: openDecisions, selected: router.memberID,
                                  hover: { _, _ in }) { router.openMember($0) }
                } else { stage(list) }
                #else
                stage(list)
                #endif
            }
            .padding(.horizontal, isMac ? 14 : 10)
            .padding(.vertical, 14)
        }
        .task { await cycle() }
    }

    // MARK: Stage

    private var compactAt: Int { store.bootstrap?.settings.compactAtPct ?? 70 }

    /// `--office-pixel P` (DEBUG review hook); nil = the pixel size follows the width.
    private var forcedPixel: CGFloat? {
        #if DEBUG
        OfficeDebug.pixel
        #else
        nil
        #endif
    }

    /// Device pixels per point the layout snaps to (`--office-scale S` lays out a Retina screen on a 1x one, DEBUG).
    private var layoutScale: CGFloat {
        #if DEBUG
        OfficeDebug.scale ?? displayScale
        #else
        displayScale
        #endif
    }

    private func contextDue(_ member: Member) -> Int? {
        guard let pct = member.contextPct else { return nil }
        let value = Int(min(max(pct, 0), 100).rounded())
        return value >= compactAt ? value : nil
    }

    private var openDecisions: [String: Int] {
        Dictionary(grouping: decisions.filter { $0.status == "open" }, by: { $0.memberId ?? "" }).mapValues(\.count)
    }

    @ViewBuilder private func stage(_ everyone: [Member]) -> some View {
        let open = openDecisions
        let placeholder = !project.isHq && !everyone.contains { $0.kind == "worker" }
        // At most `OfficeSeating.workerDesks` team desks; the rest wait in a row under the scene.
        let (list, benched) = OfficeSeating.split(everyone)
        let decor = decor(list)
        let wideLayout = isMac || wide
        let input = OfficeLayoutInput(members: list, placeholder: placeholder, width: width, displayScale: layoutScale,
                                      wide: wideLayout, decor: decor, forcedPixel: forcedPixel)
        let key = ["\(width)", "\(layoutScale)", wideLayout ? "W" : "N", placeholder ? "P" : "",
                   list.map { "\($0.id):\($0.kind == "worker" ? "w" : "l")" }.joined(separator: ","),
                   list.map { (decor.desks[$0.id]?.away ?? true) ? "1" : "0" }.joined()].joined(separator: "|")
        let (map, revision) = cache.map(key: key) { OfficeMap.build(input) }
        let fresh = OfficeCast.build(map: map, members: list)
        let current = cast.flatMap { $0.signature == fresh.signature ? $0 : nil } ?? fresh
        let p = map.pixel
        let mapSize = CGSize(width: map.size.width * p, height: map.size.height * p)
        let scale = max(displayScale, 1)
        // The few leftover points (less than a sprite pixel) split evenly on both sides, on the device pixel grid.
        let originX = ((max(0, width - mapSize.width) / 2) * scale).rounded(.down) / scale
        let lead = list.first { $0.kind != "worker" }?.id
        let scene = OfficeScene(map: map, cast: current, plans: plans, residents: cache.residents(list.map(\.id), lead: lead),
                                screens: screens(map, list), batteries: batteries(map, list), still: reduceMotion)
        let _ = fadeTick
        VStack(alignment: .leading, spacing: 10) {
            ZStack(alignment: .topLeading) {
                OfficeFloorDots(step: 8 * p, origin: CGPoint(x: originX + nudge.width, y: nudge.height))
                if width > 0 {
                    sceneStack(scene, list: list, revision: revision, pixel: p, size: mapSize, cadence: cadence(map: map), open: open)
                        .padding(.leading, originX + nudge.width)
                        .padding(.top, nudge.height)
                }
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .frame(height: width > 0 ? mapSize.height : 200)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            .onGeometryChange(for: CGSize.self) { proxy in
                let origin = proxy.frame(in: .global).origin
                func rest(_ v: CGFloat) -> CGFloat {
                    let px = v * scale
                    let f = px - px.rounded(.down)
                    return f < 0.01 || f > 0.99 ? 0 : ((1 - f) / scale * 100).rounded() / 100
                }
                return CGSize(width: rest(origin.x), height: rest(origin.y))
            } action: { nudge = $0 }
            .onChange(of: fresh, initial: true) { _, new in apply(new, map: map) }
            #if os(macOS)
            .background {
                OfficeAnimationWindowReader { windowAllowsAnimation = $0 }
                    .allowsHitTesting(false)
            }
            #endif
            .onAppear { visible = true }
            .onDisappear { visible = false }
            .modifier(OfficeScrollVisibility(visible: $visible))

            if !benched.isEmpty {
                OfficeBench(members: benched, decisions: open) { id in router.memberID = id }
            }
            OfficeMessageBox(subject: boxSubject(everyone), queue: boxQueue(everyone), decisions: open, compactAt: compactAt,
                             still: reduceMotion) { id in router.memberID = id }
            // Everyone awake at a glance (the web's member cards): what each one is doing, one row per member.
            let awake = nowList(everyone)
            if !awake.isEmpty {
                OfficeNowList(members: awake, decisions: open, selected: router.memberID, hover: { id, inside in
                    if inside { hovered = id } else if hovered == id { hovered = nil }
                }) { id in router.memberID = id }
                .padding(.top, 4)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("사무실")
    }

    /// Who the 지금 list shows: everyone not asleep, the lead first, then who needs the CEO first (승인 창 앞, 내 답
    /// 기다림, 오류), then who works, rests or is missing. Same order as the web's member cards.
    private func nowList(_ list: [Member]) -> [Member] {
        let rank = ["blocked": 0, "waiting": 1, "error": 2, "working": 3, "idle": 4, "offline": 5]
        let awake = list.enumerated().filter { $0.element.status != "asleep" }
        return awake.sorted { a, b in
            let la = a.element.kind != "worker", lb = b.element.kind != "worker"
            if la != lb { return la }
            let ra = rank[a.element.status] ?? 6, rb = rank[b.element.status] ?? 6
            return ra != rb ? ra < rb : a.offset < b.offset
        }.map(\.element)
    }

    /// Only the office's own key, unoccluded Mac window animates. A terminal window becoming key pauses it.
    private var sceneActive: Bool {
        #if os(macOS)
        scenePhase == .active && windowAllowsAnimation
        #else
        scenePhase == .active
        #endif
    }

    /// 30 fps for walking, 12 fps at rest; one frame when hidden, inactive, or Reduce Motion is at rest.
    private func cadence(map: OfficeMap) -> OfficeCadence {
        let now = Date().timeIntervalSinceReferenceDate
        var cadence = OfficeCadence()
        cadence.paused = !visible || !tabVisible || !sceneActive || (reduceMotion && now > fadeUntil)
        cadence.walks = plans.values.filter { $0.signature == map.layout && $0.end > now }.map { $0.start...$0.end }
        return cadence
    }

    private func focusedDesk(_ map: OfficeMap) -> String? {
        #if os(macOS)
        guard appearsActive else { return nil }
        #endif
        return focused.flatMap { id in map.desks.first { $0.id == id }.map { $0.memberID ?? $0.id } }
    }

    /// Static desk facts: away (the desk recedes).
    private func decor(_ list: [Member]) -> OfficeDecor {
        var decor = OfficeDecor()
        for member in list { decor.desks[member.id] = OfficeDeskDecor(away: officeAway(member.status)) }
        return decor
    }

    /// Desks whose member's context window is filling up (a low battery on the desk front).
    private func batteries(_ map: OfficeMap, _ list: [Member]) -> Set<Int> {
        Set(list.compactMap { member in
            contextDue(member) == nil ? nil : map.desks.firstIndex { $0.memberID == member.id }
        })
    }

    private func screens(_ map: OfficeMap, _ list: [Member]) -> [Int: OfficeScreen] {
        var result: [Int: OfficeScreen] = [:]
        for member in list {
            guard let d = map.desks.firstIndex(where: { $0.memberID == member.id }) else { continue }
            result[d] = switch member.status {
            case "working": .working
            case "waiting": .waiting
            case "blocked": .blocked
            case "error": .error
            default: .off
            }
        }
        return result
    }

    private func sceneStack(_ scene: OfficeScene, list: [Member], revision: Int, pixel p: CGFloat, size: CGSize,
                            cadence: OfficeCadence, open: [String: Int]) -> some View {
        let map = scene.map
        let byID = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return ZStack(alignment: .topLeading) {
            ForEach(marks(map: map)) { mark in
                let shape = RoundedRectangle(cornerRadius: isMac ? 10 : 8, style: .continuous)
                shape.fill(CE.accent.opacity(mark.strong ? 0.15 : 0.10))
                    .overlay { shape.strokeBorder(CE.accent.opacity(mark.strong ? 0.5 : 0.35), lineWidth: 1) }
                    .frame(width: mark.rect.width * p, height: mark.rect.height * p)
                    .offset(x: mark.rect.minX * p, y: mark.rect.minY * p)
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            OfficeStaticLayer(map: map, revision: revision, pixel: p)
                .equatable()
                .frame(width: size.width, height: size.height)
            TimelineView(cadence) { context in
                Canvas { ctx, _ in
                    ctx.scaleBy(x: p, y: p)
                    OfficeRenderer.drawDynamic(&ctx, scene: scene, t: context.date.timeIntervalSinceReferenceDate)
                }
            }
            .frame(width: size.width, height: size.height)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            // Above the residents: seated ones never reach a nameplate, and one walking past goes behind it, so a
            // name is never hidden.
            OfficePlateLayout(pixel: p) {
                ForEach(map.desks) { desk in
                    OfficeNameplate(member: desk.memberID.flatMap { byID[$0] }, decisions: open[desk.memberID ?? ""] ?? 0,
                                    delivery: desk.memberID.flatMap { store.deliverySummary(memberID: $0) })
                        .layoutValue(key: OfficePlateKey.self, value: desk.plate)
                }
            }
            .frame(width: size.width, height: size.height)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            ForEach(map.desks) { desk in
                deskControl(desk, member: desk.memberID.flatMap { byID[$0] }, decisions: open[desk.memberID ?? ""] ?? 0,
                            scene: scene, pixel: p, residents: Set(byID.keys))
                    .frame(width: desk.cell.width * p, height: desk.cell.height * p)
                    .position(x: desk.cell.midX * p, y: desk.cell.midY * p)
            }
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .contentShape(Rectangle())
        .onTapGesture(coordinateSpace: .local) { location in
            let point = CGPoint(x: location.x / p, y: location.y / p)
            if let id = scene.hit(point, t: Date().timeIntervalSinceReferenceDate), byID[id] != nil { router.memberID = id }
        }
        #if os(macOS)
        .onContinuousHover(coordinateSpace: .local) { phase in
            switch phase {
            case .active(let location):
                let point = CGPoint(x: location.x / p, y: location.y / p)
                let id = scene.hit(point, t: Date().timeIntervalSinceReferenceDate)
                if hovered != id { hovered = id }
            case .ended:
                if hovered != nil { hovered = nil }
            }
        }
        #endif
    }

    // MARK: Hover and selection

    /// Soft accent areas under the scene: the selected member (stronger) and the hovered or focused one. Each covers
    /// the member's desk with its resident.
    private func marks(map: OfficeMap) -> [OfficeMark] {
        var result: [OfficeMark] = []
        func add(_ id: String, strong: Bool) {
            guard let desk = map.desks.first(where: { ($0.memberID ?? $0.id) == id }) else { return }
            result.append(OfficeMark(id: "\(id)-desk", rect: desk.cell, strong: strong))
        }
        let selected = router.memberID
        if let selected { add(selected, strong: true) }
        if let hover = hovered ?? focusedDesk(map), hover != selected { add(hover, strong: false) }
        return result
    }

    // MARK: Desks (tap, context menu, accessibility, keyboard)

    @ViewBuilder private func deskControl(_ desk: OfficeDesk, member: Member?, decisions: Int, scene: OfficeScene, pixel p: CGFloat,
                                          residents: Set<String>) -> some View {
        if let member {
            let due = contextDue(member)
            // Keyboard (Space/Return) and VoiceOver activate the Button: always this desk's member.
            Button {
                router.memberID = member.id
            } label: {
                Color.clear.contentShape(Rectangle())
            }
            .buttonStyle(OfficeHitStyle())
            // A click or tap takes the scene's hit test at that point: a resident drawn over the desk (walking past,
            // or a neighbour's) wins over the desk itself.
            .highPriorityGesture(SpatialTapGesture().onEnded { value in
                let point = CGPoint(x: desk.cell.minX + value.location.x / p, y: desk.cell.minY + value.location.y / p)
                let hit = scene.hit(point, t: Date().timeIntervalSinceReferenceDate)
                router.memberID = hit.flatMap { residents.contains($0) ? $0 : nil } ?? member.id
            })
            .focused($focused, equals: desk.id)
            .focusEffectDisabled()
            .help(deskHelp(member, decisions: decisions, due: due))
            .contextMenu {
                Button { openChat(member) } label: { Label("대화방 열기", systemImage: "bubble.left.and.bubble.right") }
                Button { instruct(member) } label: { Label("지시", systemImage: "text.bubble") }
                if officeAllowsTerminal(member) {
                    TeamSessionMenu(member: member)
                }
            } preview: {
                OfficeContextPreview(member: member)
            }
            .accessibilityLabel(accessibilityText(member, decisions: decisions))
            .accessibilityHint("대화방 정보 보기")
            .accessibilityAction(.default) { router.memberID = member.id }
            .accessibilityAction(named: "대화방 열기") { openChat(member) }
            .accessibilityAction(named: "지시") { instruct(member) }
            .accessibilityActions {
                if officeAllowsTerminal(member) {
                    Button(TerminalAvailability.title(member, waking: store.terminalWake.members.contains(member.id))) {
                        router.openTerminal(member.id)
                    }
                    .disabled(!store.canOpenTerminal(member))
                }
            }
        } else {
            Color.clear
                .contentShape(Rectangle())
                .help("아직 팀장이 없습니다. 총괄이 일을 나누면 생깁니다.")
                .accessibilityElement()
                .accessibilityLabel("빈 자리, 아직 팀장이 없습니다. 총괄이 일을 나누면 생깁니다.")
        }
    }

    private func deskHelp(_ member: Member, decisions: Int, due: Int?) -> String {
        var title = decisions > 0 ? "\(member.name) · 결재 \(decisions)건 · 대화방 정보 보기" : "\(member.name) · 대화방 정보 보기"
        if let summary = store.deliverySummary(memberID: member.id), summary.needsOwnerCount > 0 {
            title += " · 전달 확인 \(summary.needsOwnerCount)건 · 상세에서 근거 확인"
        }
        title += "\n\(officeStateLabel(member)) · \(MemberStatusInfo(member).explanation)"
        return due.map { "\(title)\n문맥 \($0)% 사용 — 상세에서 '문맥 압축'" } ?? title
    }

    private func accessibilityText(_ member: Member, decisions: Int) -> String {
        var parts = [member.name, officeStateLabel(member), officeDetail(member)]
        if decisions > 0 { parts.append("결재 \(decisions)건") }
        if let summary = store.deliverySummary(memberID: member.id), summary.needsOwnerCount > 0 {
            parts.append("전달 확인 \(summary.needsOwnerCount)건, 상세에서 근거 확인")
        }
        if let due = contextDue(member) { parts.append("문맥 \(due)퍼센트 사용, 상세에서 문맥 압축") }
        return parts.joined(separator: ", ")
    }

    private func openChat(_ member: Member) { router.openChat(member.kind == "worker" ? member.id : nil) }

    /// Same as the detail's 지시: point the composer at this member (the docked composer on Mac and iPhone).
    private func instruct(_ member: Member) {
        router.chatTarget = member.kind == "worker" ? member.id : nil
        router.focusComposer &+= 1
    }

    // MARK: Message box

    /// Hovered (Mac), else selected; nil shows the first of `boxQueue`.
    private func boxSubject(_ list: [Member]) -> Member? {
        if let hovered, let member = list.first(where: { $0.id == hovered }) { return member }
        if let selected = router.memberID, let member = list.first(where: { $0.id == selected }) { return member }
        return nil
    }

    /// Who needs the CEO first (승인 창 앞, 오류, 내 답 기다림), then who is working.
    private func boxQueue(_ list: [Member]) -> [Member] {
        ["blocked", "error", "waiting", "working"].flatMap { status in list.filter { $0.status == status } }
    }

    // MARK: Walks

    /// A new cast: every resident whose place changed walks there from where it is right now (a walk in progress
    /// re-plans from its current point). A new map (resize, members added or removed) places everyone directly.
    private func apply(_ new: OfficeCast, map: OfficeMap) {
        let now = Date().timeIntervalSinceReferenceDate
        guard let old = cast, old.signature == new.signature, map.layout == new.signature else {
            cast = new
            plans = [:]
            return
        }
        guard old != new else { return }
        var next = plans.filter { new.placements[$0.key] != nil }
        for id in new.ids {
            let before = old.placements[id]
            let after = new.placements[id] ?? .hidden
            guard before != after else { continue }
            let tone = new.tones[id] ?? old.tones[id] ?? .idle
            let current = before.flatMap { OfficeStage.actor(id, placement: $0, tone: tone, plan: plans[id], map: map, t: now, still: reduceMotion) }
            next[id] = OfficeStage.plan(id, from: current, old: before, to: after, map: map, t: now, still: reduceMotion)
        }
        plans = next
        cast = new
        if reduceMotion && next.values.contains(where: { $0.fade && $0.end > now }) {
            fadeUntil = now + 0.3
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(350))
                fadeTick &+= 1
            }
        }
    }

    /// "일하는 중 2 · 내 답 기다림 1 · …" as items, so a line never breaks inside one; zero counts drop out.
    static func counts(_ members: [Member]) -> [OfficeCount] {
        let counts = MemberStatusInfo.summaryCounts(members)
        return ["working", "waiting", "blocked", "error", "idle", "offline", "asleep", "unknown"].compactMap { status in
            let count = counts[status, default: 0]
            return count > 0 ? OfficeCount(status: status, label: officeStateLabel(status), count: count) : nil
        }
    }

    private func cycle() async {
        #if DEBUG
        // Review hook: read-only sample data only, never in release builds, never sent anywhere.
        guard store.isDemo, ProcessInfo.processInfo.arguments.contains("--office-cycle") else { return }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(6))
            if Task.isCancelled { return }
            cycleWorking.toggle()
        }
        #endif
    }
}

/// A highlighted area of the scene, in sprite pixels.
private struct OfficeMark: Identifiable {
    let id: String
    let rect: CGRect
    let strong: Bool
}

/// Where a desk's nameplate goes (sprite pixels).
private struct OfficePlateKey: LayoutValueKey {
    static let defaultValue = OfficePlateSlot(center: 0, minX: 0, maxX: 0, y: 0, above: false)
}

/// Lays out the nameplates. The plates of one row (same line, same bounds) are packed like map labels: each wants to
/// sit centred on its desk; where neighbours would overlap, they slide apart just enough (as a group, keeping their
/// order), staying within the row's bounds. Only when a row's names cannot fit side by side are they truncated, each
/// in proportion to its length.
private struct OfficePlateLayout: Layout {
    let pixel: CGFloat
    /// Space between two neighbouring plates (points).
    private let gap: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        // Rows: plates sharing a line and its bounds.
        var rows: [String: [Int]] = [:]
        var order: [String] = []
        for (i, subview) in subviews.enumerated() {
            let slot = subview[OfficePlateKey.self]
            let key = "\(slot.y)|\(slot.above)|\(slot.minX)|\(slot.maxX)"
            if rows[key] == nil { order.append(key) }
            rows[key, default: []].append(i)
        }
        for key in order {
            let members = (rows[key] ?? []).sorted { subviews[$0][OfficePlateKey.self].center < subviews[$1][OfficePlateKey.self].center }
            guard let first = members.first else { continue }
            let slot = subviews[first][OfficePlateKey.self]
            let lo = slot.minX * pixel, hi = slot.maxX * pixel
            let span = max(0, hi - lo)
            var sizes = members.map { subviews[$0].sizeThatFits(ProposedViewSize(width: span, height: nil)) }
            let total = sizes.map(\.width).reduce(0, +) + gap * CGFloat(max(0, members.count - 1))
            if total > span, total > 0 {
                // Too many names for the row: shrink each in proportion, then measure again (truncated).
                let room = span - gap * CGFloat(max(0, members.count - 1))
                let natural = sizes.map(\.width).reduce(0, +)
                sizes = zip(members, sizes).map { i, size in
                    subviews[i].sizeThatFits(ProposedViewSize(width: (size.width * room / max(natural, 1)).rounded(.down), height: nil))
                }
            }
            let widths = sizes.map { min($0.width, span) }
            let lefts = Self.pack(centers: members.map { subviews[$0][OfficePlateKey.self].center * pixel }, widths: widths,
                                  gap: gap, lo: lo, hi: hi)
            for (k, i) in members.enumerated() {
                let plate = subviews[i][OfficePlateKey.self]
                let y = plate.above ? plate.y * pixel - sizes[k].height : plate.y * pixel
                subviews[i].place(at: CGPoint(x: bounds.minX + lefts[k].rounded(), y: bounds.minY + y.rounded()), anchor: .topLeading,
                                  proposal: ProposedViewSize(width: widths[k], height: sizes[k].height))
            }
        }
    }

    /// Left edges for boxes that want to be centred on `centers`, in order, without overlapping, within [lo, hi]:
    /// overlapping neighbours merge into a cluster placed at the mean of what its members want.
    static func pack(centers: [CGFloat], widths: [CGFloat], gap: CGFloat, lo: CGFloat, hi: CGFloat) -> [CGFloat] {
        struct Cluster { var first: Int; var last: Int; var left: CGFloat; var width: CGFloat; var want: CGFloat; var count: CGFloat }
        var clusters: [Cluster] = []
        for i in centers.indices {
            let want = centers[i] - widths[i] / 2
            clusters.append(Cluster(first: i, last: i, left: want, width: widths[i], want: want, count: 1))
            while clusters.count > 1 {
                var b = clusters.removeLast()
                var a = clusters.removeLast()
                b.left = min(max(b.left, lo), max(lo, hi - b.width))
                a.left = min(max(a.left, lo), max(lo, hi - a.width))
                if a.left + a.width + gap <= b.left {
                    clusters.append(a)
                    clusters.append(b)
                    break
                }
                // Merge: `want` sums each member's wished left edge minus its offset inside the cluster.
                let offset = a.width + gap
                var merged = Cluster(first: a.first, last: b.last, left: 0, width: a.width + gap + b.width,
                                     want: a.want + b.want - offset * b.count, count: a.count + b.count)
                merged.left = merged.want / merged.count
                merged.left = min(max(merged.left, lo), max(lo, hi - merged.width))
                a = merged
                clusters.append(a)
            }
            if var only = clusters.last, clusters.count == 1 {
                only.left = min(max(only.left, lo), max(lo, hi - only.width))
                clusters[0] = only
            }
        }
        var lefts = [CGFloat](repeating: 0, count: centers.count)
        for cluster in clusters {
            var x = min(max(cluster.left, lo), max(lo, hi - cluster.width))
            for i in cluster.first...cluster.last {
                lefts[i] = x
                x += widths[i] + gap
            }
        }
        return lefts
    }
}

/// Pauses the moving layer while the office is scrolled out of view.
private struct OfficeScrollVisibility: ViewModifier {
    @Binding var visible: Bool
    func body(content: Content) -> some View {
        if #available(macOS 15.0, iOS 18.0, *) {
            content.onScrollVisibilityChange(threshold: 0.02) { visible = $0 }
        } else {
            // macOS 14 / iOS 17: compare the frame with the visible bounds of the enclosing scroll view.
            content.onGeometryChange(for: Bool.self) { proxy in
                guard let bounds = proxy.bounds(of: .scrollView) else { return true }
                return bounds.intersects(CGRect(origin: .zero, size: proxy.size))
            } action: { visible = $0 }
        }
    }
}

private struct OfficeHitStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.contentShape(Rectangle())
    }
}

/// The floor: the plate's quiet dot grid, one dot every 8 sprite pixels.
private struct OfficeFloorDots: View {
    let step: CGFloat
    let origin: CGPoint

    var body: some View {
        Canvas { ctx, size in
            guard step >= 6 else { return }
            var dots = Path()
            let radius: CGFloat = isMac ? 0.9 : 0.85
            let startX = origin.x.truncatingRemainder(dividingBy: step) + step / 2
            var y = origin.y + step / 2
            while y < size.height {
                var x = startX
                while x < size.width {
                    dots.addEllipse(in: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2))
                    x += step
                }
                y += step
            }
            ctx.fill(dots, with: .color(Color.white.opacity(0.045)))
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The desks and chairs. Redrawn only when the map changes.
private struct OfficeStaticLayer: View, Equatable {
    let map: OfficeMap
    let revision: Int
    let pixel: CGFloat

    nonisolated static func == (a: OfficeStaticLayer, b: OfficeStaticLayer) -> Bool {
        a.revision == b.revision && a.pixel == b.pixel
    }

    var body: some View {
        Canvas { ctx, _ in
            ctx.scaleBy(x: pixel, y: pixel)
            OfficeRenderer.drawStatic(&ctx, map: map)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

// MARK: - Nameplate

/// The session name on the outer side of its desk's row, with the state dot and, while decisions wait for the CEO,
/// their count at the trailing end. An asleep or absent member's plate recedes; the count never does.
private struct OfficeNameplate: View {
    let member: Member?
    var decisions = 0
    var delivery: MemberDeliverySummary? = nil

    var body: some View {
        // Never below the web's smallest word size (11.5-12px): name 12, marks 10, about 20pt tall.
        let shape = RoundedRectangle(cornerRadius: 6, style: .continuous)
        let away = member.map { officeDim($0.status) } ?? true
        let counted = member != nil && decisions > 0
        HStack(spacing: 5) {
            if let member {
                HStack(spacing: 5) {
                    dot(officeStateKey(member))
                    // iPhone: four desks share a row, so a name may take two short lines rather than end in "…".
                    Text(member.name).font(.system(size: isMac ? 12 : 11.5, weight: .semibold)).foregroundStyle(away ? CE.ink2 : CE.ink)
                        .lineLimit(isMac ? 1 : 2).truncationMode(.tail)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if member.kind != "worker", !member.name.contains(rankName(member.kind)) {
                        Text(rankName(member.kind)).font(.system(size: 10, weight: .bold)).foregroundStyle(CE.accent)
                            .padding(.horizontal, 4).padding(.vertical, 1)
                            .background(CE.accent.opacity(0.18), in: RoundedRectangle(cornerRadius: 3.5, style: .continuous))
                            .fixedSize()
                    }
                }
                .opacity(away ? 0.78 : 1)
                if let delivery, delivery.needsOwnerCount > 0 {
                    if isMac {
                        ViewThatFits(in: .horizontal) {
                            Text("전달 확인 \(DeliveryInfo.badgeCount(delivery.needsOwnerCount))")
                                .font(.system(size: 10, weight: .bold)).foregroundStyle(CE.attention).fixedSize()
                            Image(systemName: "exclamationmark.circle").font(.system(size: 10, weight: .bold)).foregroundStyle(CE.attention)
                        }
                    } else {
                        Image(systemName: "exclamationmark.circle").font(.system(size: 10, weight: .bold)).foregroundStyle(CE.attention)
                    }
                }
                if counted && isMac { count }
            } else {
                Text("새 팀장 자리").font(.system(size: 12, weight: .semibold)).foregroundStyle(CE.ink3).lineLimit(1)
                    .opacity(0.78)
            }
        }
        // The count capsule sits as far in from the trailing edge as from the top and bottom.
        .padding(.leading, 6).padding(.trailing, counted && isMac ? 3 : 6).padding(.vertical, 3)
        .background(Color(hex: 0x0E0A1F).opacity(away ? 0.25 : 0.5), in: shape)
        .overlay {
            if member == nil {
                shape.strokeBorder(Color.white.opacity(0.125), style: StrokeStyle(lineWidth: 1, dash: [2, 2]))
            } else {
                shape.strokeBorder(Color.white.opacity(away ? 0.04 : 0.09), lineWidth: 1)
            }
        }
        .overlay(alignment: .topTrailing) {
            if counted && !isMac { count.offset(x: 5, y: -6) }
        }
    }

    /// Decisions waiting for the CEO (결재): an app-style count capsule in the attention colour.
    private var count: some View {
        Text(decisions > 9 ? "9+" : "\(decisions)")
            .font(.system(size: 10, weight: .bold)).monospacedDigit()
            .foregroundStyle(Color(hex: 0x2B1708))
            .padding(.horizontal, 4)
            .frame(minWidth: 14, minHeight: 14)
            .background(CE.attention, in: Capsule())
            .fixedSize()
    }

    private func dot(_ status: String) -> some View {
        OfficeStateDot(status: status, size: 6)
    }
}

private struct OfficeContextPreview: View {
    let member: Member

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                OfficeStateDot(status: officeStateKey(member), size: 8)
                    .alignmentGuide(.firstTextBaseline) { $0.height / 2 + 5 }
                Text(member.name).font(CEFont.rowTitle).foregroundStyle(CE.ink).lineLimit(1)
                Text(officeStateLabel(member)).font(CEFont.meta.weight(.semibold))
                    .foregroundStyle(member.status == "idle" ? CE.ink3 : MemberStatusInfo(member).tone.color)
                    .lineLimit(1).fixedSize()
            }
            Text(officeDetail(member)).font(CEFont.note).foregroundStyle(member.status == "error" ? CE.danger : CE.ink2)
                .lineSpacing(CELeading.note).lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(width: 300, alignment: .leading)
        .background(CE.plateRaisedSolid)
    }
}

// MARK: - Bench

/// Members without a desk (past `OfficeSeating.workerDesks`, the longest unused): one quiet row of small plates under the
/// scene, most recently active first, each opening the member's detail. Working again brings a member back to a desk.
private struct OfficeBench: View {
    let members: [Member]
    let decisions: [String: Int]
    let open: (String) -> Void

    private static let explanation = "오래 쉬어 책상을 비운 직원입니다. 일을 맡기면 다시 자리에 앉습니다."

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            HStack(spacing: 5) {
                Text("자리 비움").font(.system(size: 12.5, weight: .semibold)).foregroundStyle(CE.ink2)
                Text("\(members.count)").font(.system(size: 12.5)).foregroundStyle(CE.ink3).monospacedDigit()
            }
            .fixedSize()
            .help(Self.explanation)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("자리 비움 \(members.count)명. " + Self.explanation)
            TeamWrapLayout(spacing: 8, lineSpacing: 8) {
                ForEach(members) { member in plate(member) }
            }
        }
        .padding(.horizontal, isMac ? 2 : 4)
    }

    private func plate(_ member: Member) -> some View {
        let shape = RoundedRectangle(cornerRadius: 8, style: .continuous)
        let count = decisions[member.id] ?? 0
        let when = member.lastActiveAt.map { relativeTime($0) }
        return Button { open(member.id) } label: {
            HStack(spacing: 6) {
                OfficeStateDot(status: officeStateKey(member), size: 6)
                Text(member.name).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(CE.ink2).lineLimit(1)
                if let when, !when.isEmpty {
                    Text(when).font(.system(size: 11.5)).foregroundStyle(CE.ink3).monospacedDigit().lineLimit(1)
                }
                if count > 0 {
                    Text(count > 9 ? "9+" : "\(count)")
                        .font(.system(size: 10, weight: .bold)).monospacedDigit()
                        .foregroundStyle(Color(hex: 0x2B1708))
                        .padding(.horizontal, 4)
                        .frame(minWidth: 14, minHeight: 14)
                        .background(CE.attention, in: Capsule())
                }
            }
            .fixedSize()
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(Color(hex: 0x0E0A1F).opacity(0.3), in: shape)
            .overlay { shape.strokeBorder(Color.white.opacity(0.07), lineWidth: 1) }
            .frame(minHeight: isMac ? nil : 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("\(member.name) · \(officeStateLabel(member))" + (when.map { " · 마지막 작업 \($0)" } ?? "") + "\n" + Self.explanation)
        .accessibilityLabel([member.name, officeStateLabel(member), when.map { "마지막 작업 \($0)" }, count > 0 ? "결재 \(count)건" : nil]
            .compactMap { $0 }.joined(separator: ", "))
        .accessibilityHint("대화방 정보 보기")
    }
}

// MARK: - Message box

/// A flat plate under the scene: name · state, then what the member is doing (one line on Mac, two on iPhone).
/// Hovered, else selected, else it cycles every ~6s through who needs the CEO, then who works. Tapping it opens
/// that member's detail.
private struct OfficeMessageBox: View {
    let subject: Member?
    let queue: [Member]
    let decisions: [String: Int]
    let compactAt: Int
    let still: Bool
    let open: (String) -> Void

    /// Hovered or selected, else whoever needs the CEO most. It does not rotate: a line that changes while it is
    /// being read (every 6 s before) is worse than one that waits for a hover or a click.
    private var member: Member? { subject ?? queue.first }

    var body: some View {
        let member = member
        let line = member.map(officeDetail) ?? "모두 쉬는 중입니다."
        let key = (member?.id ?? "-") + "|" + (member?.status ?? "") + "|" + line
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        Button {
            if let member { open(member.id) }
        } label: {
            ZStack(alignment: .leading) {
                content(member, line: line)
                    .id(key)
                    .transition(.opacity)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14).padding(.vertical, 10)
            .frame(minHeight: isMac ? 44 : 52)
            .background(Color.white.opacity(0.04), in: shape)
            .overlay { shape.strokeBorder(Color.white.opacity(0.07), lineWidth: 1) }
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .disabled(member == nil)
        .animation(still ? nil : .easeInOut(duration: 0.18), value: key)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(member.map { "\($0.name), \(officeStateLabel($0)), \(line)" } ?? line)
        .accessibilityHint(member == nil ? "" : "대화방 정보 보기")
    }

    @ViewBuilder private func content(_ member: Member?, line: String) -> some View {
        // Web member card: name 15.5/650, state pill 12.5/600, what it does 14/1.45 ink-1 (here ink2 under the name).
        let detail = Text(line)
            .font(.system(size: isMac ? 13.5 : 14))
            .foregroundStyle(member == nil ? CE.ink3 : (member?.status == "error" ? CE.danger : CE.ink2))
            .lineSpacing(isMac ? 0 : CELeading.spacing(14, 1.45))
            .lineLimit(isMac ? 1 : 2)
            .truncationMode(.tail)
        if let member {
            let count = decisions[member.id] ?? 0
            let due: Int? = member.contextPct.flatMap { pct in
                let value = Int(min(max(pct, 0), 100).rounded())
                return value >= compactAt ? value : nil
            }
            let time = relativeTime(member.nowAt)
            #if os(macOS)
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    title(member, extra: extras(count: count, due: due, long: true)); detail; Spacer(minLength: 0); stamp(time)
                }
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    title(member, extra: extras(count: count, due: due, long: false)); detail; Spacer(minLength: 0); stamp(time)
                }
            }
            #else
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    ViewThatFits(in: .horizontal) {
                        title(member, extra: extras(count: count, due: due, long: true))
                        title(member, extra: extras(count: count, due: due, long: false))
                        title(member, extra: nil)
                    }
                    Spacer(minLength: 0)
                    stamp(time)
                }
                detail.fixedSize(horizontal: false, vertical: true)
            }
            #endif
        } else {
            detail
        }
    }

    /// When the member last reported (the web card's time), quiet at the trailing edge.
    @ViewBuilder private func stamp(_ time: String) -> some View {
        if !time.isEmpty {
            Text(time).font(.system(size: 12)).foregroundStyle(CE.ink3).monospacedDigit().lineLimit(1).fixedSize()
        }
    }

    private func title(_ member: Member, extra: String?) -> some View {
        let info = MemberStatusInfo(member)
        return HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(member.name).font(.system(size: isMac ? 14 : 15, weight: .semibold)).foregroundStyle(CE.ink).lineLimit(1)
            Text("·").font(.system(size: 13)).foregroundStyle(CE.ink3)
            Text(officeStateLabel(member)).font(.system(size: isMac ? 12.5 : 13, weight: .semibold))
                .foregroundStyle(member.status == "idle" ? CE.ink3 : info.tone.color)
                .lineLimit(1).fixedSize()
            if let extra {
                Text(extra).font(.system(size: isMac ? 12.5 : 13, weight: .semibold)).foregroundStyle(CE.attention).lineLimit(1).fixedSize()
                    .padding(.leading, 4)
            }
        }
        .fixedSize(horizontal: true, vertical: false)
    }

    private func extras(count: Int, due: Int?, long: Bool) -> String? {
        var parts: [String] = []
        if count > 0 { parts.append("결재 \(count)건") }
        if let due { parts.append(long ? "문맥 \(due)% 사용 · 압축 권장" : "문맥 \(due)%") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

// MARK: - 지금 list

/// Everyone awake, one row each, under the message box: what the web's member cards showed at once (who, what it is
/// doing, open decisions, when it last reported). Mac: one line (dot · name · what · 결재 · time); iPhone: the name line,
/// then up to two lines of what. Hovering a row lights that member's desk; a row opens the member's detail.
private struct OfficeNowList: View {
    let members: [Member]
    let decisions: [String: Int]
    let selected: String?
    let hover: (String, Bool) -> Void
    let open: (String) -> Void
    @ScaledMetric(relativeTo: .subheadline) private var nameWidth: CGFloat = 120

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("지금 하는 일").font(CEFont.meta.weight(.semibold)).foregroundStyle(CE.ink2)
                Text("\(members.count)").font(CEFont.meta).foregroundStyle(CE.ink3).monospacedDigit()
            }
            .padding(.horizontal, isMac ? 2 : 4)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("지금 하는 일, \(members.count)명")
            .accessibilityAddTraits(.isHeader)
            VStack(spacing: 0) {
                ForEach(Array(members.enumerated()), id: \.element.id) { index, member in
                    if index > 0 { Rectangle().fill(CE.line).frame(height: 1).padding(.horizontal, 10) }
                    row(member)
                }
            }
            // Row text lines up with the header text; the hover fill reaches a little past it.
            .padding(.horizontal, isMac ? -8 : -6)
        }
    }

    private func row(_ member: Member) -> some View {
        let info = MemberStatusInfo(member)
        let count = decisions[member.id] ?? 0
        let time = relativeTime(member.nowAt)
        let detail = officeDetail(member)
        let quiet = ["idle", "offline"].contains(member.status)
        let urgent = ["waiting", "blocked", "error"].contains(member.status)
        // Who needs the CEO says so before what it is doing; the error itself is the line for a failed session.
        let lead = urgent && member.status != "error" ? Text("\(officeStateLabel(member)) · ").foregroundStyle(info.tone.color).fontWeight(.semibold) : Text("")
        let what = lead + Text(detail).foregroundStyle(member.status == "error" ? CE.danger : (quiet ? CE.ink3 : CE.ink2))
        return Button { open(member.id) } label: {
            Group {
                if isMac {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        OfficeStateDot(status: officeStateKey(member), size: 8)
                            .frame(width: 8)
                            .alignmentGuide(.firstTextBaseline) { $0.height / 2 + 5 }
                        Text(member.name).font(CEFont.rowTitle).foregroundStyle(CE.ink).lineLimit(1)
                            .frame(width: nameWidth, alignment: .leading)
                        what.font(CEFont.note).lineLimit(1).truncationMode(.tail)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if count > 0 { decisionMark(count) }
                        if !time.isEmpty { stamp(time) }
                    }
                } else {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        OfficeStateDot(status: officeStateKey(member), size: 8)
                            .frame(width: 8)
                            .alignmentGuide(.firstTextBaseline) { $0.height / 2 + 5 }
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(member.name).font(CEFont.rowTitle).foregroundStyle(CE.ink).lineLimit(1)
                                if count > 0 { decisionMark(count) }
                                Spacer(minLength: 8)
                                if !time.isEmpty { stamp(time) }
                            }
                            what.font(CEFont.note).lineSpacing(CELeading.note).lineLimit(2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowButtonStyle(selected: selected == member.id, radius: CERadius.row))
        .contextMenu { TeamSessionMenu(member: member) }
        .onHover { hover(member.id, $0) }
        .help(info.explanation)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([member.name, officeStateLabel(member), detail, count > 0 ? "결재 \(count)건" : "", time]
            .filter { !$0.isEmpty }.joined(separator: ", "))
        .accessibilityHint("대화방 정보 보기")
        .accessibilityAddTraits(selected == member.id ? [.isSelected] : [])
    }

    private func decisionMark(_ count: Int) -> some View {
        Text("결재 \(count)").font(CEFont.meta.weight(.semibold)).foregroundStyle(CE.attention).monospacedDigit()
            .lineLimit(1).fixedSize()
    }

    private func stamp(_ time: String) -> some View {
        Text(time).font(CEFont.caption).foregroundStyle(CE.ink3).monospacedDigit().lineLimit(1).fixedSize()
    }
}

// MARK: - Header

struct OfficeCount: Hashable {
    let status: String
    let label: String
    let count: Int
}

private struct OfficeHeader: View {
    let counts: [OfficeCount]
    let showsAdd: Bool
    let canAdd: Bool
    let help: String
    let add: () -> Void

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: 12) {
                title
                if !counts.isEmpty { summary.fixedSize() }
                Spacer(minLength: 8)
                addButton
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .center, spacing: 10) {
                    title
                    Spacer(minLength: 8)
                    addButton
                }
                if !counts.isEmpty { summary }
            }
        }
    }

    private var title: some View {
        Text("사무실").font(CEFont.section).foregroundStyle(CE.ink2).accessibilityAddTraits(.isHeader)
    }

    /// Quiet counts with the same state dots as the nameplates (Home's team line: label ink3, number ink2); wraps
    /// between items, never inside one.
    private var summary: some View {
        TeamWrapLayout(spacing: 14, lineSpacing: 6) {
            ForEach(counts, id: \.self) { item in
                HStack(spacing: 5) {
                    OfficeStateDot(status: item.status, size: 7)
                    Text(item.label).foregroundStyle(CE.ink3)
                    Text("\(item.count)").monospacedDigit().fontWeight(.semibold).foregroundStyle(CE.ink2)
                }
                .font(CEFont.secondary)
                .lineLimit(1)
                .fixedSize()
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(counts.map { "\($0.label) \($0.count)" }.joined(separator: ", "))
    }

    /// Web 직원 추가 is a glass button; in this card header it takes the dense size (32pt, 13.5 semibold, web gbtn--s).
    @ViewBuilder private var addButton: some View {
        if showsAdd {
            Button(action: add) { Label("팀장 추가", systemImage: "plus") }
                .ceSecondaryButton()
                .controlSize(.small)
                .disabled(!canAdd)
                .help(help)
        }
    }
}

// MARK: - Debug hooks

#if DEBUG
/// Review hooks for the read-only sample workspace (`--demo`), never in release builds:
/// `--office-members N` shows the first N sample members (1 = the lead alone), or pads the sample team with extra
/// work-named sessions up to N (for example 20). `--office-flip` swaps the two seats of every band column, which
/// puts the sample's attention members (waiting, blocked, error) in the bottom row. `--office-pixel P` draws a sprite
/// pixel as P points (for example 2.5, a Retina Mac's size, on a 1x screen). `--office-scale S` lays the office out as
/// on a screen of S device pixels per point (for example 2: a Retina Mac's layout, drawn on a 1x screen).
private enum OfficeDebug {
    static let count: Int? = {
        guard LaunchOptions.demo, let raw = LaunchOptions.value(after: "--office-members") else { return nil }
        return Int(raw)
    }()
    static let flip = LaunchOptions.demo && LaunchOptions.arguments.contains("--office-flip")
    static let pixel: CGFloat? = {
        guard LaunchOptions.demo, let raw = LaunchOptions.value(after: "--office-pixel"), let value = Double(raw),
              value >= 1, value <= 4 else { return nil }
        return CGFloat(value)
    }()
    static let scale: CGFloat? = {
        guard LaunchOptions.demo, let raw = LaunchOptions.value(after: "--office-scale"), let value = Double(raw),
              value >= 1, value <= 3 else { return nil }
        return CGFloat(value)
    }()

    static func members(_ list: [Member]) -> [Member] {
        let padded = pad(list)
        guard flip else { return padded }
        // Swap each top seat with the bottom seat facing it (workers only; the lead stays first).
        let leads = padded.filter { $0.kind != "worker" }
        var workers = padded.filter { $0.kind == "worker" }
        var i = 0
        while i + 1 < workers.count {
            workers.swapAt(i, i + 1)
            i += 2
        }
        return leads + workers
    }

    private static func pad(_ list: [Member]) -> [Member] {
        guard let count, count > 0, !list.isEmpty else { return list }
        if count <= list.count { return Array(list.prefix(count)) }
        let extra: [(String, String, String)] = [
            ("쿠폰 적용", "working", "할인 쿠폰 적용 순서 정리"), ("환불 처리", "idle", "부분 환불 흐름 점검"),
            ("배송비 계산", "working", "지역별 배송비 표 반영"), ("포인트 적립", "asleep", "적립 규칙 초안"),
            ("주문 내역", "waiting", "주문 내역 화면 필터"), ("알림 발송", "working", "결제 완료 알림 문구"),
            ("로그 분석", "idle", "결제 실패 로그 묶기"), ("보안 점검", "blocked", "키 보관 방식 확인"),
            ("속도 개선", "asleep", "결제 페이지 첫 화면 속도"), ("문서 정리", "idle", "연동 문서 목차"),
            ("접근성 점검", "working", "결제 버튼 읽기 순서"), ("가격 표시", "working", "세금 포함 가격 표시"),
            ("영수증 양식", "error", "영수증 PDF 양식"),
        ]
        var result = list
        var k = 0
        while result.count < count {
            let item = extra[k % extra.count]
            let suffix = k >= extra.count ? " \(k / extra.count + 1)" : ""
            result.append(Member(id: "m-extra-\(k)", projectId: list[0].projectId, handle: "extra\(k)", name: item.0 + suffix,
                                 role: item.0, cli: k.isMultiple(of: 2) ? "claude" : "codex", status: item.1, now: item.2,
                                 contextPct: k == 4 ? 84 : Double(10 + k * 5)))
            k += 1
        }
        return result
    }
}
#endif

/// Shared session shortcuts; refusals retain the server's ownership and delivery checks.
private struct TeamSessionMenu: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    #if os(macOS)
    @Environment(\.openWindow) private var openWindow
    #endif
    let member: Member
    private var busy: Bool { store.pendingActions.contains("member:\(member.id)") }
    var body: some View {
        if TerminalAvailability.supportsTerminal(member) {
            Button("터미널 열기", systemImage: "terminal") {
                #if os(macOS)
                openWindow(id: "terminal", value: member.id)
                #else
                router.openTerminal(member.id)
                #endif
            }.disabled(!store.canOpenTerminal(member))
            if ["asleep", "offline"].contains(member.status) {
                Button("깨우기", systemImage: "sunrise") { Task { _ = await store.memberAction(member, action: "resume") } }
                    .disabled(!store.canWrite || busy || store.terminalWake.members.contains(member.id))
            } else {
                Button("재우기", systemImage: "moon") { Task { _ = await store.sleepMember(member) } }
                    .disabled(!store.canWrite || busy)
                Button("문맥 압축", systemImage: "arrow.down.right.and.arrow.up.left") {
                    Task { _ = await store.memberAction(member, action: "compact") }
                }.disabled(!store.canWrite || busy)
            }
        }
    }
}

#if os(macOS)
/// Observe the containing window, never NSApp.keyWindow (which may be the terminal).
enum OfficeAnimationVisibility {
    static func allowsAnimation(isKeyWindow: Bool, occlusionState: NSWindow.OcclusionState) -> Bool {
        isKeyWindow && occlusionState.contains(.visible)
    }
}

private struct OfficeAnimationWindowReader: NSViewRepresentable {
    let changed: (Bool) -> Void

    func makeNSView(context: Context) -> OfficeAnimationWindowView {
        let view = OfficeAnimationWindowView()
        view.changed = changed
        return view
    }
    func updateNSView(_ view: OfficeAnimationWindowView, context: Context) { view.changed = changed }
}

private final class OfficeAnimationWindowView: NSView {
    var changed: ((Bool) -> Void)?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        NotificationCenter.default.removeObserver(self)
        if let window {
            for name in [NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification,
                         NSWindow.didChangeOcclusionStateNotification] {
                // Selector observers are automatically removed when this view is deallocated.
                NotificationCenter.default.addObserver(self, selector: #selector(windowChanged), name: name, object: window)
            }
        }
        publishVisibility()
    }

    @objc private func windowChanged(_ notification: Notification) { publishVisibility() }

    private func publishVisibility() {
        // Moving into a window can happen during a SwiftUI update; publish on the next actor turn.
        // Read the current window then so a late notification cannot restart a detached office.
        Task { @MainActor [weak self] in
            guard let self else { return }
            changed?(window.map {
                OfficeAnimationVisibility.allowsAnimation(isKeyWindow: $0.isKeyWindow, occlusionState: $0.occlusionState)
            } ?? false)
        }
    }
}
#endif
