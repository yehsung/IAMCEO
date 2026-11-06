import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

// Connection, Settings and New project share the web's setup look (web/src/styles/setup.css): glass panels with a
// 16pt title, labelled dark input wells, choice tiles with a violet ring, and a sticky glass save bar.

// MARK: - Shared setup pieces

private enum SetupFont {
    #if os(macOS)
    static let brand: Font = .system(size: 13, weight: .bold)
    static let title: Font = .system(size: 24, weight: .bold)
    static let sheetTitle: Font = .system(size: 18, weight: .bold)
    static let lead: Font = .system(size: 14)
    static let label: Font = .system(size: 12.5, weight: .semibold)
    static let choice: Font = .system(size: 14, weight: .semibold)
    static let input: Font = .system(size: 13.5)
    static let hint: Font = .system(size: 12)
    #else
    static let brand: Font = .footnote.weight(.bold)
    static let title: Font = .title2.weight(.bold)
    static let sheetTitle: Font = .headline
    static let lead: Font = .subheadline
    static let label: Font = .footnote.weight(.semibold)
    static let choice: Font = .subheadline.weight(.semibold)
    static let input: Font = .subheadline
    static let hint: Font = .caption
    #endif
}

private enum SetupMetrics {
    #if os(macOS)
    static let inputHeight: CGFloat = 34
    #else
    static let inputHeight: CGFloat = 44
    #endif
}

private extension View {
    /// Web `.input`: dark well, 12pt radius, faint inner ring (accent ring while focused).
    func setupInput(active: Bool = false) -> some View {
        let shape = RoundedRectangle(cornerRadius: CERadius.control, style: .continuous)
        return self.textFieldStyle(.plain)
            .padding(.horizontal, 12).padding(.vertical, 7)
            .frame(minHeight: SetupMetrics.inputHeight)
            .background(CE.bgDeep.opacity(0.5), in: shape)
            .overlay { shape.strokeBorder(active ? CE.accent.opacity(0.75) : Color.white.opacity(0.12), lineWidth: active ? 1.5 : 1) }
    }
}

/// Web `.st-panel`: a glass card with its title and an optional trailing control.
private struct SetupPanel<Accessory: View, Content: View>: View {
    let title: String
    let accessory: Accessory
    let content: Content
    init(_ title: String, @ViewBuilder accessory: () -> Accessory, @ViewBuilder content: () -> Content) {
        self.title = title
        self.accessory = accessory()
        self.content = content()
    }
    var body: some View {
        Plate(padding: isMac ? 18 : 16) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    Text(title).font(CEFont.title).foregroundStyle(CE.ink).lineLimit(1)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 8)
                    accessory
                }
                .frame(minHeight: 24)
                content
            }
        }
    }
}

extension SetupPanel where Accessory == EmptyView {
    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.init(title, accessory: { EmptyView() }, content: content)
    }
}

/// Web `.field`: label above, control, optional quiet hint below.
private struct SetupField<Control: View>: View {
    let label: String
    let hint: String?
    let control: Control
    init(_ label: String, hint: String? = nil, @ViewBuilder control: () -> Control) {
        self.label = label
        self.hint = hint
        self.control = control()
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(SetupFont.label).foregroundStyle(CE.ink2)
            control
            if let hint {
                Text(hint).font(SetupFont.hint).foregroundStyle(CE.ink3).fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The face of a web `select`: current value and a chevron in an input well.
private struct SetupSelectLabel: View {
    let text: String
    var mono = false
    @Environment(\.isEnabled) private var isEnabled
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: CERadius.control, style: .continuous)
        HStack(spacing: 6) {
            Text(text).font(mono ? CEFont.mono : SetupFont.input).foregroundStyle(isEnabled ? CE.ink : CE.ink3).lineLimit(1)
            Spacer(minLength: 4)
            Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(isEnabled ? CE.ink2 : CE.ink3)
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, minHeight: SetupMetrics.inputHeight)
        .background(CE.bgDeep.opacity(0.5), in: shape)
        .overlay { shape.strokeBorder(Color.white.opacity(0.12)) }
        .contentShape(shape)
    }
}

/// A web-style select: a menu of checkable items behind `SetupSelectLabel`.
private struct SetupMenu<Items: View>: View {
    let text: String
    let mono: Bool
    let label: String
    let items: Items
    init(_ text: String, mono: Bool = false, label: String, @ViewBuilder items: () -> Items) {
        self.text = text
        self.mono = mono
        self.label = label
        self.items = items()
    }
    var body: some View {
        Menu { items } label: { SetupSelectLabel(text: text, mono: mono) }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .frame(maxWidth: .infinity)
            .accessibilityLabel(label)
            .accessibilityValue(text)
    }
}

/// Menu items are toggles so each platform draws its own checkmark.
@MainActor private func menuCheck(_ selected: Bool, _ action: @escaping () -> Void) -> Binding<Bool> {
    Binding(get: { selected }, set: { _ in action() })
}

/// Web `.choice`: quiet tile, violet fill and ring when chosen.
private struct ChoiceTile: View {
    let title: String
    let detail: String
    var badge: String? = nil
    let selected: Bool
    let action: () -> Void
    @Environment(\.isEnabled) private var isEnabled
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 13, style: .continuous)
        Button(action: action) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 7) {
                    Text(title).font(SetupFont.choice).foregroundStyle(isEnabled ? CE.ink : CE.ink3)
                    if let badge { Tag(badge) }
                }
                Text(detail).font(SetupFont.hint).foregroundStyle(isEnabled ? CE.ink2 : CE.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 13).padding(.vertical, 11)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(selected ? CE.violet.opacity(0.24) : Color.white.opacity(0.04), in: shape)
            .overlay { shape.strokeBorder(selected ? CE.violet.opacity(0.9) : Color.white.opacity(0.1), lineWidth: selected ? 1.5 : 1) }
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

/// Web `.st-facts` cell. Mac: label above value in a grid; iPhone: label left, value right.
private struct FactCell<Value: View>: View {
    let label: String
    let value: Value
    init(_ label: String, @ViewBuilder value: () -> Value) {
        self.label = label
        self.value = value()
    }
    var body: some View {
        #if os(macOS)
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(SetupFont.label).foregroundStyle(CE.ink3)
            value.font(CEFont.secondary).foregroundStyle(CE.ink)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        #else
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label).font(SetupFont.label).foregroundStyle(CE.ink3)
            Spacer(minLength: 8)
            value.font(CEFont.secondary).foregroundStyle(CE.ink).multilineTextAlignment(.trailing)
        }
        .accessibilityElement(children: .combine)
        #endif
    }
}

private struct DotValue: View {
    let tone: Tone
    let text: String
    var body: some View {
        HStack(spacing: 6) {
            StatusDot(tone: tone, size: 6)
            Text(text).foregroundStyle(tone == .danger || tone == .attention ? tone.color : CE.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Only used inside scroll views (it may wrap).
private struct SetupError: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Label(text, systemImage: "exclamationmark.circle")
            .font(CEFont.secondary).foregroundStyle(CE.danger)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct SetupBrand: View {
    var body: some View {
        HStack(spacing: 8) {
            Capsule()
                .fill(LinearGradient(colors: [CE.ink, CE.accent, CE.violet], startPoint: .leading, endPoint: .trailing))
                .frame(width: 18, height: 10)
            Text("IAMCEO").font(SetupFont.brand).tracking(1.2).foregroundStyle(CE.ink2)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("IAMCEO")
    }
}

@MainActor private func setupCopy(_ text: String) {
    #if os(macOS)
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
    #else
    UIPasteboard.general.string = text
    #endif
}

private func settingsTrim(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines) }

// MARK: - Connection (full window until a daemon is connected)

/// First screen without a connection (web Setup): one centred glass card. Never shows sample-like data.
struct ConnectionView: View {
    @Environment(AppStore.self) private var store
    @State private var revealCode = false
    /// iPhone: manual address + code entry is a fallback behind the QR flow.
    @State private var showManual = false
    @State private var copiedCommand = false
    @State private var copyTick = 0
    @FocusState private var focus: Field?
    #if os(macOS)
    @State private var localHost = LocalHostService()
    @State private var localStartError: String?
    #endif

    private enum Field: Hashable { case endpoint, code }

    /// Prints the server's addresses and access code on the server computer.
    private static let accessCommand = "iamceo open"

    private var connecting: Bool { store.connectionStatus == .connecting }
    private var localHostBusy: Bool {
        #if os(macOS)
        localHost.isStarting
        #else
        false
        #endif
    }
    /// Access codes are ASCII. A Korean IME left on is the usual cause of a code that never matches.
    private var codeHasNonASCII: Bool { store.accessCode.unicodeScalars.contains { !$0.isASCII } }
    private var canConnect: Bool {
        !connecting && !localHostBusy && !codeHasNonASCII
            && !settingsTrim(store.endpoint).isEmpty && !settingsTrim(store.accessCode).isEmpty
    }
    private var connectionError: String? {
        guard !connecting, let raw = store.errorMessage, !raw.isEmpty else { return nil }
        return friendlyConnectionError(raw)
    }
    private var endpointHint: String? {
        #if os(macOS)
        nil
        #else
        "Mac의 Tailscale 주소(100.x 또는 HTTPS)입니다. iPhone의 127.0.0.1은 Mac이 아닙니다."
        #endif
    }

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                card
                    .frame(maxWidth: 420)
                    .padding(.horizontal, CESpace.l)
                    .padding(.vertical, isMac ? 36 : CESpace.xxl)
                    .frame(maxWidth: .infinity, minHeight: proxy.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
            #if os(iOS)
            .scrollDismissesKeyboard(.interactively)
            #endif
        }
        .background { localLight }
        #if os(macOS)
        .onAppear {
            guard !connecting, store.accessCode.isEmpty else { return }
            focus = store.endpoint.isEmpty ? .endpoint : .code
        }
        #endif
    }

    /// Web Setup LocalLight: violet glow above the card, orchid low right.
    private var localLight: some View {
        GeometryReader { geo in
            let width = min(1000, geo.size.width * 1.5)
            ZStack {
                Rectangle()
                    .fill(EllipticalGradient(colors: [CE.violet.opacity(0.36), CE.violet.opacity(0.12), .clear]))
                    .frame(width: width, height: width * 0.6)
                    .position(x: geo.size.width * 0.5, y: geo.size.height * 0.24)
                Rectangle()
                    .fill(EllipticalGradient(colors: [CE.orchid.opacity(0.22), CE.orchid.opacity(0.07), .clear]))
                    .frame(width: width * 0.8, height: width * 0.48)
                    .position(x: geo.size.width * 0.72, y: geo.size.height * 0.88)
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private var card: some View {
        @Bindable var store = store
        return Plate(padding: 0) {
            VStack(alignment: .leading, spacing: 12) {
                SetupBrand()
                VStack(alignment: .leading, spacing: 6) {
                    Text(isMac ? "AI 팀에 연결" : "Mac과 연결").font(SetupFont.title).foregroundStyle(CE.ink)
                        .accessibilityAddTraits(.isHeader)
                    Text(isMac ? "접속 코드는 이 기기에 저장되어 다음부터는 묻지 않습니다." : "한 번 연결하면 다음부터는 자동으로 연결합니다.")
                        .font(SetupFont.lead).foregroundStyle(CE.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.bottom, 4)
                #if os(iOS)
                PhonePairingSection()
                Button { withAnimation(.snappy) { showManual.toggle() } } label: {
                    HStack(spacing: 5) {
                        Text("주소와 접속 코드를 직접 입력")
                        Image(systemName: showManual ? "chevron.up" : "chevron.down").font(.system(size: 10, weight: .semibold))
                    }
                    .font(CEFont.meta).foregroundStyle(CE.ink3)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if showManual { manualFields }
                #else
                manualFields
                #endif
                #if os(macOS)
                orDivider
                localStart
                #endif
                foot
            }
            .padding(.horizontal, 22).padding(.top, 26).padding(.bottom, 20)
        }
    }

    @ViewBuilder private var manualFields: some View {
        @Bindable var store = store
                SetupField("서버 주소", hint: endpointHint) {
                    TextField("서버 주소", text: $store.endpoint, prompt: Text(isMac ? "http://127.0.0.1:7878" : "https://your-mac.tailnet.ts.net"))
                        .labelsHidden()
                        .font(SetupFont.input)
                        .focused($focus, equals: .endpoint)
                        .onSubmit { focus = .code }
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .textContentType(.URL)
                        #endif
                        .setupInput(active: focus == .endpoint)
                }
                SetupField("접속 코드") {
                    HStack(spacing: 6) {
                        Group {
                            if revealCode {
                                TextField("접속 코드", text: $store.accessCode, prompt: Text("서버 컴퓨터의 접속 코드"))
                            } else {
                                SecureField("접속 코드", text: $store.accessCode, prompt: Text("서버 컴퓨터의 접속 코드"))
                            }
                        }
                        .labelsHidden()
                        .font(SetupFont.input)
                        .focused($focus, equals: .code)
                        .onSubmit { connect() }
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                        Button { revealCode.toggle() } label: {
                            Image(systemName: revealCode ? "eye.slash" : "eye")
                                .frame(width: 26, height: 26)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(CE.ink3)
                        .help(revealCode ? "접속 코드 숨기기" : "접속 코드 보기")
                        .accessibilityLabel(revealCode ? "접속 코드 숨기기" : "접속 코드 보기")
                    }
                    .setupInput(active: focus == .code)
                }
                if codeHasNonASCII {
                    SetupError("접속 코드는 영문·숫자로 되어 있습니다. 한글 입력 상태인지 확인해 주세요.")
                } else if let connectionError {
                    SetupError(connectionError)
                }
                Button { connect() } label: {
                    HStack(spacing: 7) {
                        if connecting { ProgressView().controlSize(.small).tint(.white) }
                        Text(connecting ? "연결하는 중" : "연결하기")
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, isMac ? 4 : 5)
                }
                .ceProminentButton()
                .controlSize(.large)
                .disabled(!canConnect)
                .padding(.top, 2)
    }

    #if os(macOS)
    private var orDivider: some View {
        HStack(spacing: 10) {
            Rectangle().fill(CE.line).frame(height: 1)
            Text("또는").font(CEFont.meta).foregroundStyle(CE.ink3)
            Rectangle().fill(CE.line).frame(height: 1)
        }
        .padding(.vertical, 2)
        .accessibilityHidden(true)
    }

    private var localStart: some View {
        VStack(spacing: 7) {
            Button { startLocal() } label: {
                HStack(spacing: 7) {
                    if localHost.isStarting {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "desktopcomputer")
                    }
                    Text(localHost.isStarting ? "준비하는 중" : "이 Mac에서 시작")
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
            }
            .ceSecondaryButton()
            .controlSize(.large)
            .disabled(localHost.isStarting || connecting)
            Text(localHost.isStarting && !localHost.statusText.isEmpty ? localHost.statusText : "이 Mac의 서버를 찾아 바로 연결합니다. 없으면 새로 준비합니다.")
                .font(SetupFont.hint).foregroundStyle(CE.ink3)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .fixedSize(horizontal: false, vertical: true)
            if let localStartError { SetupError(localStartError) }
        }
    }

    /// Same flow as before the redesign: explicit start, then connect with the local config's code.
    private func startLocal() {
        Task {
            localStartError = nil
            do {
                let connection = try await localHost.start()
                store.endpoint = connection.url.absoluteString
                store.accessCode = connection.accessCode
                await store.connect()
            } catch { localStartError = error.localizedDescription }
        }
    }
    #endif

    /// Web `.su-foot`: where the code comes from, with the command as a chip so it never breaks in half.
    private var foot: some View {
        VStack(spacing: 8) {
            Text("주소와 접속 코드는 서버 컴퓨터에서 확인합니다.")
                .font(SetupFont.hint).foregroundStyle(CE.ink2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button { copyAccessCommand() } label: {
                HStack(spacing: 7) {
                    Image(systemName: "terminal").font(.system(size: 10, weight: .semibold)).foregroundStyle(CE.ink3)
                    Text(Self.accessCommand).font(CEFont.mono).foregroundStyle(CE.ink).lineLimit(1)
                    Text(copiedCommand ? "복사함" : "복사").font(CEFont.meta.weight(.semibold))
                        .foregroundStyle(copiedCommand ? CE.success : CE.accent)
                }
                .padding(.horizontal, 11).padding(.vertical, 6)
                .background(Color.white.opacity(0.07), in: Capsule())
                .overlay { Capsule().strokeBorder(CE.line) }
                .frame(minHeight: isMac ? nil : 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .fixedSize()
            .help("서버 컴퓨터의 터미널에서 실행하면 주소와 접속 코드를 보여 줍니다")
            .accessibilityLabel(copiedCommand ? "iamceo open 명령 복사함" : "iamceo open 명령 복사")
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 4)
    }

    private func copyAccessCommand() {
        setupCopy(Self.accessCommand)
        copiedCommand = true
        copyTick += 1
        let tick = copyTick
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.6))
            if copyTick == tick { copiedCommand = false }
        }
    }

    private func connect() {
        guard canConnect else { return }
        Task { await store.connect() }
    }

    /// The server's 401 text says nothing about what to do next.
    private func friendlyConnectionError(_ raw: String) -> String {
        if raw == "인증이 필요합니다" { return "접속 코드가 맞지 않거나 바뀌었습니다. 서버 컴퓨터에서 iamceo\u{00A0}open 으로 확인해 다시 넣어 주세요." }
        return raw
    }
}

// MARK: - Settings (macOS Settings scene content / iOS sheet)

struct SettingsView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(DraftStore.self) private var drafts
    @Environment(\.dismiss) private var dismiss
    /// What the screen edits. `base` is the server value the edits are measured against.
    @State private var draft = Settings()
    @State private var base = Settings()
    @State private var loaded = false
    /// Ranks switched to "직접 입력"; kept apart so an emptied field stays open (web `custom`).
    @State private var customRanks: Set<String> = []
    @State private var saveError: String?
    @State private var savedNotice = false
    @State private var noticeTask: Task<Void, Never>?
    @State private var busy: Busy?
    @State private var syncError: String?
    @State private var runtimeError: String?
    @State private var confirmLeave = false
    @State private var confirmDiscard = false

    private enum Busy { case sync, runtime }

    private struct PermissionChoice: Identifiable {
        let id: String
        let title: String
        let detail: String
        let badge: String?
    }
    private static let permissionChoices = [
        PermissionChoice(id: "bypassPermissions", title: "바이패스", detail: "직원이 승인 없이 명령을 실행합니다", badge: "기본"),
        PermissionChoice(id: "auto", title: "오토", detail: "위험해 보이는 작업만 멈춥니다", badge: nil),
        PermissionChoice(id: "default", title: "모두 승인", detail: "도구를 쓸 때마다 승인을 기다립니다", badge: nil)
    ]

    private struct RankRow: Identifiable {
        let id: String
        let title: String
        let scope: String
        /// bootstrap.rankOverrides only counts manager and lead.
        let countsOverrides: Bool
    }
    private static let rankRows = [
        RankRow(id: "manager", title: "부장", scope: "총괄·본사 AI", countsOverrides: true),
        RankRow(id: "lead", title: "팀장", scope: "직원 세션", countsOverrides: true),
        RankRow(id: "staff", title: "직원", scope: "서브에이전트", countsOverrides: false)
    ]
    private static let efforts = ["low", "medium", "high", "xhigh", "max"]
    private static let modelSuggestions = ["fable", "opus", "sonnet", "haiku"]
    private static let tidyChoices = [0, 3, 6, 12, 24]

    // MARK: State

    private var editable: Bool { store.canWrite && store.bootstrap != nil }
    private var saving: Bool { store.pendingActions.contains("settings") }
    /// A rank switched to "직접 입력" with nothing typed yet counts as an unsaved (and invalid) change, as on the web.
    private var pendingEmptyCustom: Bool { Self.rankRows.contains { customRanks.contains($0.id) && model(of: $0.id).isEmpty } }
    private var isDirty: Bool { loaded && (Self.signature(draft) != Self.signature(base) || pendingEmptyCustom) }
    private var firstModelError: String? { Self.rankRows.lazy.compactMap { modelError(for: $0) }.first }
    private var canSave: Bool { editable && isDirty && firstModelError == nil && !saving }
    private var serverSignature: String { store.bootstrap.map { Self.signature($0.settings) } ?? "" }

    private var lockNotice: (title: String, detail: String)? {
        if store.isDemo { return ("샘플 설정입니다", "샘플은 읽기 전용이라 바꿀 수 없습니다. 실제 Mac에 연결하면 바꿀 수 있습니다.") }
        if store.connectionStatus != .connected { return ("서버에 연결되지 않았습니다", "보이는 값은 마지막 동기화 기준이며 지금은 바꿀 수 없습니다.") }
        return nil
    }

    var body: some View {
        #if os(macOS)
        content
            .navigationTitle("설정")
            .frame(width: 700, height: 760)
        #else
        NavigationStack {
            content
                .navigationTitle("설정")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("완료") { close() } }
                }
        }
        .interactiveDismissDisabled(isDirty)
        .confirmationDialog("저장하지 않은 변경이 있습니다", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("저장하지 않고 닫기", role: .destructive) { revert(); dismiss() }
            Button("계속 고치기", role: .cancel) {}
        }
        #endif
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: CESpace.m) {
                if store.bootstrap != nil {
                    if let lockNotice {
                        InlineNotice(tone: store.isDemo ? .accent : .attention, icon: store.isDemo ? "eye" : "wifi.slash", title: lockNotice.title, detail: lockNotice.detail)
                    }
                    runtimePanel
                    permissionPanel.disabled(!editable || saving)
                    rankPanel.disabled(!editable || saving)
                    SettingsProjectsPanel(editable: editable)
                    operationPanel.disabled(!editable || saving)
                }
                connectionPanel
            }
            .frame(maxWidth: 880)
            .padding(.horizontal, isMac ? 20 : 16)
            .padding(.top, isMac ? 16 : 12)
            .padding(.bottom, 20)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        #if os(iOS)
        .scrollDismissesKeyboard(.interactively)
        #endif
        .background { AmbientBackground() }
        .ceBar(.bottom) {
            VStack(spacing: 0) { saveBar }
                .animation(.snappy(duration: 0.24), value: isDirty || savedNotice)
        }
        .onAppear { syncFromStore() }
        .onChange(of: serverSignature) { _, _ in syncFromStore() }
        .onChange(of: Self.signature(draft)) { _, _ in saveError = nil }
        .confirmationDialog("이 기기에서 나갈까요?", isPresented: $confirmLeave, titleVisibility: .visible) {
            Button("나가기", role: .destructive) { leave() }
            Button("취소", role: .cancel) {}
        } message: {
            Text(leaveMessage)
        }
    }

    // MARK: 실행 환경

    private var runtimePanel: some View {
        let runtime = store.runtime
        let needsSetup = runtime != nil && (runtime?.core.available != true || runtime?.providers.values.contains { !$0.installed } == true)
        return SetupPanel("실행 환경") {
            if !store.isDemo {
                Button { Task { await refresh(.runtime) } } label: {
                    HStack(spacing: 6) {
                        if busy == .runtime { ProgressView().controlSize(.small) }
                        Text(busy == .runtime ? "확인하는 중" : "다시 확인")
                    }
                }
                .ceSecondaryButton()
                .ceCompactControl()
                .fixedSize()
                .disabled(store.connectionStatus != .connected || store.isLoading || busy != nil)
            }
        } content: {
            factGrid(columns: 3) {
                FactCell("herdr-core") { stateValue(coreState(runtime)) }
                    .help("모든 AI 직원은 herdr-core에서 실행됩니다. 직원마다 Claude Code 또는 Codex를 고릅니다.")
                FactCell("Claude Code") { stateValue(providerState(runtime, "claude")) }
                FactCell("Codex CLI") { stateValue(providerState(runtime, "codex")) }
            }
            if let detail = runtime?.core.detail, !detail.isEmpty {
                Text(detail).font(CEFont.mono).foregroundStyle(CE.ink3).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if store.isDemo {
                hint("샘플에는 연결된 실행 환경이 없습니다.")
            } else if needsSetup {
                Text("서버 컴퓨터의 IAMCEO 저장소에서 `bun\u{00A0}run\u{00A0}setup:core`로 실행 환경을 준비한 뒤 다시 확인하세요.")
                    .font(SetupFont.hint).foregroundStyle(CE.attention)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let runtimeError { SetupError("진단을 읽지 못했습니다. \(runtimeError)") }
        }
    }

    private struct RuntimeState { let tone: Tone; let text: String }

    private func stateValue(_ state: RuntimeState) -> some View { DotValue(tone: state.tone, text: state.text) }

    private func coreState(_ runtime: RuntimeDiagnostics?) -> RuntimeState {
        guard let core = runtime?.core else { return RuntimeState(tone: .neutral, text: "확인 전") }
        if core.available { return RuntimeState(tone: .success, text: core.version.map { "사용 가능 · \($0)" } ?? "사용 가능") }
        if core.installed { return RuntimeState(tone: .danger, text: "설치됨 · 사용할 수 없음") }
        return RuntimeState(tone: .attention, text: "설치 필요")
    }

    /// The daemon only reports whether the CLI is installed; login is checked when a session starts.
    private func providerState(_ runtime: RuntimeDiagnostics?, _ cli: String) -> RuntimeState {
        guard let provider = runtime?.providers[cli] else { return RuntimeState(tone: .neutral, text: "확인 전") }
        return provider.installed ? RuntimeState(tone: .success, text: "설치됨 · 로그인은 실행 때 확인") : RuntimeState(tone: .attention, text: "설치 필요")
    }

    // MARK: 권한

    private var permissionPanel: some View {
        SetupPanel("권한") {
            #if os(macOS)
            HStack(alignment: .top, spacing: 8) { permissionTiles }
                .fixedSize(horizontal: false, vertical: true)
            #else
            VStack(spacing: 8) { permissionTiles }
            #endif
            hint("세션은 이 Mac 사용자 권한으로 실행되며 샌드박스가 아닙니다. 새로 여는 세션부터 적용됩니다.")
        }
    }

    private var permissionTiles: some View {
        ForEach(Self.permissionChoices) { choice in
            ChoiceTile(title: choice.title, detail: choice.detail, badge: choice.badge, selected: draft.permissionMode == choice.id) {
                draft.permissionMode = choice.id
            }
        }
    }

    // MARK: 직급별 모델·effort

    private var rankPanel: some View {
        SetupPanel("직급별 모델·effort") {
            VStack(alignment: .leading, spacing: 0) {
                #if os(macOS)
                HStack(spacing: 10) {
                    Text("직급").frame(width: 150, alignment: .leading)
                    Text("모델").frame(maxWidth: .infinity, alignment: .leading)
                    Text("effort").frame(width: 150, alignment: .leading)
                }
                .font(SetupFont.label).foregroundStyle(CE.ink3)
                .padding(.bottom, 4)
                .accessibilityHidden(true)
                #endif
                ForEach(Array(Self.rankRows.enumerated()), id: \.element.id) { index, rank in
                    if index > 0 { RowDivider(inset: 0) }
                    rankRow(rank).padding(.vertical, isMac ? 8 : 10)
                }
            }
            hint("직원별로 지정한 값이 먼저입니다. 바꾼 값은 세션을 다시 열 때 적용됩니다.")
        }
    }

    private func rankRow(_ rank: RankRow) -> some View {
        let overrides = rank.countsOverrides ? (store.bootstrap?.rankOverrides[rank.id] ?? 0) : 0
        let custom = isCustom(rank.id)
        let invalid = modelError(for: rank)
        #if os(macOS)
        return HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text(rank.title).font(SetupFont.choice).foregroundStyle(CE.ink)
                Text(rank.scope).font(SetupFont.hint).foregroundStyle(CE.ink2)
                if overrides > 0 { Text("직원별 지정 \(overrides)명").font(SetupFont.hint).foregroundStyle(CE.ink3) }
            }
            .frame(width: 150, alignment: .leading)
            .frame(minHeight: SetupMetrics.inputHeight)
            VStack(alignment: .leading, spacing: 6) {
                modelMenu(rank)
                if custom { customModelField(rank) }
                if let invalid { Text(invalid).font(SetupFont.hint).foregroundStyle(CE.danger).fixedSize(horizontal: false, vertical: true) }
            }
            .frame(maxWidth: .infinity)
            effortMenu(rank).frame(width: 150)
        }
        #else
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(rank.title).font(SetupFont.choice).foregroundStyle(CE.ink)
                Text(rank.scope).font(SetupFont.hint).foregroundStyle(CE.ink2)
                Spacer(minLength: 6)
                if overrides > 0 { Text("직원별 지정 \(overrides)명").font(SetupFont.hint).foregroundStyle(CE.ink3) }
            }
            HStack(spacing: 8) {
                modelMenu(rank)
                effortMenu(rank).frame(width: 118)
            }
            if custom { customModelField(rank) }
            if let invalid { Text(invalid).font(SetupFont.hint).foregroundStyle(CE.danger).fixedSize(horizontal: false, vertical: true) }
        }
        #endif
    }

    private func model(of rank: String) -> String { settingsTrim(draft.ranks[rank]?.model ?? "") }

    private func isCustom(_ rank: String) -> Bool {
        let value = model(of: rank)
        return customRanks.contains(rank) || (!value.isEmpty && !Self.modelSuggestions.contains(value))
    }

    private func modelMenu(_ rank: RankRow) -> some View {
        let value = model(of: rank.id)
        let custom = isCustom(rank.id)
        return SetupMenu(custom ? "직접 입력" : (value.isEmpty ? "CLI 기본" : value), mono: !custom && !value.isEmpty, label: "\(rank.title) 모델") {
            Toggle("CLI 기본", isOn: menuCheck(!custom && value.isEmpty) { customRanks.remove(rank.id); setModel(nil, for: rank.id) })
            Divider()
            ForEach(Self.modelSuggestions, id: \.self) { name in
                Toggle(name, isOn: menuCheck(!custom && value == name) { customRanks.remove(rank.id); setModel(name, for: rank.id) })
            }
            Divider()
            // Starts from the current name so a variant ("opus[1m]") is one edit away.
            Toggle("직접 입력", isOn: menuCheck(custom) { customRanks.insert(rank.id) })
        }
    }

    private func customModelField(_ rank: RankRow) -> some View {
        TextField("\(rank.title) 모델 이름", text: Binding(get: { draft.ranks[rank.id]?.model ?? "" }, set: { value in
            customRanks.insert(rank.id)
            setModel(value.isEmpty ? nil : value, for: rank.id)
        }), prompt: Text("모델 이름"))
            .labelsHidden()
            .font(CEFont.mono)
            .autocorrectionDisabled()
            #if os(iOS)
            .textInputAutocapitalization(.never)
            #endif
            .onSubmit { Task { await save() } }
            .setupInput()
    }

    private func effortMenu(_ rank: RankRow) -> some View {
        let current = draft.ranks[rank.id]?.effort
        let options = Self.efforts + (current.map { Self.efforts.contains($0) ? [] : [$0] } ?? [])
        return SetupMenu(current ?? "기본", label: "\(rank.title) effort") {
            Toggle("기본", isOn: menuCheck(current == nil) { setEffort(nil, for: rank.id) })
            Divider()
            ForEach(options, id: \.self) { effort in
                Toggle(effort, isOn: menuCheck(current == effort) { setEffort(effort, for: rank.id) })
            }
        }
    }

    private func setModel(_ value: String?, for rank: String) {
        var config = draft.ranks[rank] ?? RankConfig()
        config.model = value
        draft.ranks[rank] = config
    }

    private func setEffort(_ value: String?, for rank: String) {
        var config = draft.ranks[rank] ?? RankConfig()
        config.effort = value
        draft.ranks[rank] = config
    }

    /// Same rule as the daemon: the name goes straight after `--model`, so no flags or spaces.
    private func modelError(for rank: RankRow) -> String? {
        let value = model(of: rank.id)
        guard !value.isEmpty else { return customRanks.contains(rank.id) ? "\(rank.title) 모델 이름을 넣어 주세요" : nil }
        if value.range(of: #"^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,127}$"#, options: .regularExpression) == nil {
            return "\(rank.title) 모델 이름이 잘못되었습니다. 영문·숫자와 . _ : - [ ] 만 씁니다."
        }
        return nil
    }

    // MARK: 운영

    private var operationPanel: some View {
        SetupPanel("운영") {
            factGrid(columns: 2, spacing: 14) {
                numberField("동시 턴", unit: "개", hint: "넘치면 차례를 기다립니다", value: $draft.maxConcurrentTurns, range: 1...64)
                numberField("팀장 상한", unit: "명", hint: "넘으면 총괄에게 잠재울 후보를 알립니다", value: $draft.maxAwakeWorkers, range: 1...256)
                numberField("문맥 표시 기준", unit: "%", hint: "팀 화면의 문맥 표시 기준입니다. 자동 압축은 없으니 터미널에서 /compact를 쓰세요.", value: $draft.compactAtPct, range: 1...100, step: 5)
                SetupField("판 정리 주기", hint: "총괄이 쉬는 중이고 바뀐 게 있을 때만 판을 지금 상태로 맞춥니다") {
                    let current = Int(draft.boardTidyHours.rounded())
                    SetupMenu(tidyLabel(current), label: "판 정리 주기") {
                        ForEach(tidyOptions, id: \.self) { hours in
                            Toggle(tidyLabel(hours), isOn: menuCheck(current == hours) { draft.boardTidyHours = Double(hours) })
                        }
                    }
                }
            }
            notifyCheck
        }
    }

    /// Web `.su-check`: the toggle and its sentence in one quiet tile.
    private var notifyCheck: some View {
        let shape = RoundedRectangle(cornerRadius: 13, style: .continuous)
        return Toggle(isOn: $draft.notifyMac) {
            VStack(alignment: .leading, spacing: 2) {
                Text("맥 알림").font(SetupFont.choice).foregroundStyle(CE.ink)
                Text("결재나 내 할 일이 올라오면 서버 컴퓨터(맥)에 알림을 띄웁니다")
                    .font(SetupFont.hint).foregroundStyle(CE.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        #if os(macOS)
        .toggleStyle(.checkbox)
        #endif
        .tint(CE.violet)
        .padding(.horizontal, 13).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.04), in: shape)
        .overlay { shape.strokeBorder(Color.white.opacity(0.1)) }
    }

    /// Fixed choices plus any custom value the server holds, so it is shown instead of silently replaced.
    private var tidyOptions: [Int] {
        Array(Set(Self.tidyChoices + [Int(base.boardTidyHours.rounded()), Int(draft.boardTidyHours.rounded())])).sorted()
    }

    private func tidyLabel(_ hours: Int) -> String { hours == 0 ? "끔" : hours == 24 ? "매일" : "\(hours)시간" }

    private func numberField(_ title: String, unit: String, hint: String, value: Binding<Int>, range: ClosedRange<Int>, step: Int = 1) -> some View {
        let clamped = Binding<Int>(get: { value.wrappedValue }, set: { value.wrappedValue = min(max($0, range.lowerBound), range.upperBound) })
        return SetupField(title, hint: hint) {
            HStack(spacing: 8) {
                TextField(title, value: clamped, format: .number)
                    .labelsHidden()
                    .font(SetupFont.input)
                    .monospacedDigit()
                    #if os(iOS)
                    .keyboardType(.numberPad)
                    #endif
                    .onSubmit { Task { await save() } }
                    .setupInput()
                Text(unit).font(SetupFont.input).foregroundStyle(CE.ink2)
                Stepper(title, value: clamped, in: range, step: step).labelsHidden()
            }
        }
    }

    // MARK: 접속

    private var connectionPanel: some View {
        SetupPanel("접속") {
            factGrid(columns: 2) {
                TimelineView(.periodic(from: .now, by: 5)) { context in
                    let summary = connectionSummary(now: context.date)
                    FactCell("상태") { DotValue(tone: summary.tone, text: summary.text) }
                }
                if store.bootstrap != nil, !store.isDemo {
                    FactCell("서버 주소") {
                        Text(store.endpoint).font(CEFont.mono).textSelection(.enabled).lineLimit(2)
                    }
                    if let urls = store.bootstrap?.urls, !urls.isEmpty {
                        FactCell("들어올 주소") {
                            VStack(alignment: isMac ? .leading : .trailing, spacing: 2) {
                                ForEach(urls, id: \.self) { Text($0).font(CEFont.mono).textSelection(.enabled).lineLimit(1).truncationMode(.middle) }
                            }
                        }
                    }
                    if let version = store.bootstrap?.version, !version.isEmpty {
                        FactCell("버전") { Text(version).font(CEFont.mono) }
                    }
                }
            }
            if store.bootstrap == nil, !store.isDemo {
                hint(isMac ? "메인 창에서 서버에 연결하세요." : "서버에 연결하면 설정을 볼 수 있습니다.")
            }
            if !store.isDemo {
                hint("접속 코드는 이 기기의 키체인에 저장됩니다. iPhone은 'iPhone 연결'의 QR을 찍으면 Tailscale로 연결됩니다.")
                #if os(macOS)
                Button { router.showPairing = true } label: { Label("iPhone 연결", systemImage: "qrcode") }
                    .ceSecondaryButton()
                    .ceCompactControl()
                    .disabled(store.connectionStatus != .connected)
                #endif
                HStack(spacing: CESpace.s) {
                    if store.bootstrap != nil {
                        Button { Task { await refresh(.sync) } } label: {
                            HStack(spacing: 6) {
                                if busy == .sync { ProgressView().controlSize(.small) }
                                Text("지금 동기화")
                            }
                        }
                        .ceSecondaryButton()
                        .ceCompactControl()
                        .disabled(store.connectionStatus != .connected || store.isLoading || busy != nil)
                    }
                    Spacer(minLength: CESpace.s)
                    if canLeave {
                        Button { confirmLeave = true } label: {
                            Text("이 기기에서 나가기").foregroundStyle(CE.danger)
                        }
                        .ceSecondaryButton()
                        .ceCompactControl()
                    }
                }
                if let syncError { SetupError(syncError) }
            }
        }
    }

    private var canLeave: Bool { !store.isDemo && (store.bootstrap != nil || !store.accessCode.isEmpty || drafts.pendingCount > 0) }

    private var leaveMessage: String {
        let count = drafts.pendingCount
        let what = count > 0 ? "접속 코드와 쓰던 초안·메모 \(count)건을" : "접속 코드를"
        return "이 기기의 \(what) 지웁니다. 다시 들어오려면 서버 컴퓨터에서 iamceo\u{00A0}open 으로 코드를 확인해야 합니다."
    }

    private func connectionSummary(now: Date) -> (tone: Tone, text: String) {
        if store.isDemo { return (.accent, "샘플 · 읽기 전용") }
        switch store.connectionStatus {
        case .connecting: return (.live, "연결하는 중")
        case .connected:
            if let updated = store.lastUpdated, now.timeIntervalSince(updated) > 20 { return (.attention, "연결됨 · 동기화가 늦어지고 있습니다") }
            return (.success, "연결됨 · 3초마다 동기화")
        case .failed: return (.danger, "연결 실패")
        case .disconnected, .demo: return (.danger, "연결 끊김")
        }
    }

    // MARK: Layout helpers

    /// Mac: a grid of `columns`; iPhone: one column.
    private func factGrid<Cells: View>(columns: Int, spacing: CGFloat = 12, @ViewBuilder _ cells: () -> Cells) -> some View {
        let count = isMac ? columns : 1
        return LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 16, alignment: .topLeading), count: count), alignment: .leading, spacing: spacing) {
            cells()
        }
    }

    private func hint(_ text: String) -> some View {
        Text(text).font(SetupFont.hint).foregroundStyle(CE.ink3).fixedSize(horizontal: false, vertical: true)
    }

    // MARK: Save bar (sticky glass, only when there is something to say)

    @ViewBuilder private var saveBar: some View {
        if isDirty || savedNotice {
            HStack(spacing: 10) {
                if isDirty {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("저장하지 않은 변경이 있습니다").font(CEFont.rowTitle).foregroundStyle(CE.ink).lineLimit(1)
                        if let problem = saveError ?? firstModelError {
                            Text(problem).font(CEFont.meta).foregroundStyle(CE.danger).lineLimit(2)
                        } else if let lockNotice {
                            Text(lockNotice.title).font(CEFont.meta).foregroundStyle(CE.ink3).lineLimit(1)
                        }
                    }
                    Spacer(minLength: CESpace.s)
                    Button("되돌리기") { revert() }
                        .ceSecondaryButton()
                        .disabled(saving)
                        .fixedSize()
                    Button { Task { await save() } } label: {
                        HStack(spacing: 6) {
                            if saving { ProgressView().controlSize(.small).tint(.white) }
                            Text(saving ? "저장하는 중" : "저장")
                        }
                    }
                    .ceProminentButton()
                    .keyboardShortcut("s", modifiers: .command)
                    .disabled(!canSave)
                    .fixedSize()
                } else {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(CE.success)
                    Text("저장했습니다. 모델·effort는 다음 실행에 적용됩니다.")
                        .font(CEFont.secondary).foregroundStyle(CE.success).lineLimit(2)
                    Spacer(minLength: 0)
                }
            }
            .padding(.leading, 16).padding(.trailing, 8).padding(.vertical, 8)
            .frame(minHeight: 52)
            .glassChrome(RoundedRectangle(cornerRadius: CERadius.plate, style: .continuous), tint: Color(red: 16 / 255, green: 11 / 255, blue: 38 / 255).opacity(0.86))
            .frame(maxWidth: 880)
            .padding(.horizontal, isMac ? 20 : 16).padding(.top, CESpace.s).padding(.bottom, CESpace.m)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    // MARK: Actions

    /// Adopt the server's values unless the person is mid-edit; then only move the baseline.
    private func syncFromStore() {
        guard let server = store.bootstrap?.settings else { return }
        if !loaded || !isDirty { draft = server }
        base = server
        loaded = true
    }

    private func revert() {
        draft = base
        customRanks = []
        saveError = nil
    }

    private func save() async {
        guard canSave else { return }
        saveError = nil
        var next = draft
        // This screen never chooses the runner. Omitting the key leaves the daemon's value untouched.
        next.backend = nil
        for (key, config) in next.ranks {
            var cleaned = config
            let model = settingsTrim(config.model ?? "")
            cleaned.model = model.isEmpty ? nil : model
            next.ranks[key] = cleaned
        }
        if await store.updateSettings(next) {
            let saved = store.bootstrap?.settings ?? next
            base = saved
            draft = saved
            customRanks = []
            noticeTask?.cancel()
            savedNotice = true
            noticeTask = Task {
                try? await Task.sleep(for: .seconds(6))
                if !Task.isCancelled { savedNotice = false }
            }
        } else {
            saveError = store.errorMessage ?? "저장하지 못했습니다."
        }
    }

    /// Both buttons re-read bootstrap, which carries the runtime diagnostics.
    private func refresh(_ kind: Busy) async {
        busy = kind
        if kind == .sync { syncError = nil } else { runtimeError = nil }
        defer { busy = nil }
        let before = store.lastUpdated
        await store.refresh()
        guard store.lastUpdated == before, let error = store.errorMessage else { return }
        if kind == .sync { syncError = error } else { runtimeError = error }
    }

    private func leave() {
        drafts.removeAll()
        store.disconnect()
        dismiss()
    }

    #if os(iOS)
    private func close() {
        if isDirty { confirmDiscard = true } else { dismiss() }
    }
    #endif

    /// Compares only what this screen edits, with model names normalized the way they are saved.
    private static func signature(_ settings: Settings) -> String {
        var parts = [settings.permissionMode, "\(settings.maxConcurrentTurns)", "\(settings.compactAtPct)", "\(settings.maxAwakeWorkers)", "\(settings.notifyMac)", "\(Int(settings.boardTidyHours.rounded()))"]
        for rank in rankRows {
            let config = settings.ranks[rank.id]
            parts.append("\(rank.id)=\(settingsTrim(config?.model ?? ""))/\(config?.effort ?? "")")
        }
        return parts.joined(separator: "|")
    }
}

// MARK: - 프로젝트 (rename, archive, restore)

/// `PATCH /api/projects/:id` accepts only these keys; nil keys are left out of the body.
private struct ProjectPatch: Encodable, Sendable {
    var name: String? = nil
    var cwd: String? = nil
    var archived: Bool? = nil
}

/// Web Settings "프로젝트": each row renames in place or archives (HQ cannot be archived); the 보관함 restores.
/// The store has no project-admin calls yet, so this talks to the connected client directly and lets the store
/// refresh afterwards (a 401 is handed to the store by that refresh).
private struct SettingsProjectsPanel: View {
    @Environment(AppStore.self) private var store
    let editable: Bool
    @State private var editingID: String?
    @State private var editName = ""
    @State private var editCwd = ""
    @State private var busyID: String?
    @State private var error: String?
    @State private var archiveTarget: ProjectSummary?
    @State private var archived: [Project] = []

    private var reloadKey: String { store.projects.map(\.id).joined(separator: ",") + "|\(store.canWrite)" }

    var body: some View {
        SetupPanel("프로젝트") {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(store.projects.enumerated()), id: \.element.id) { index, project in
                    if index > 0 { RowDivider(inset: 0) }
                    if editingID == project.id { editForm(project) } else { row(project) }
                }
            }
            if !archived.isEmpty {
                Text("보관함").font(SetupFont.label).foregroundStyle(CE.ink2).padding(.top, 2)
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(archived.enumerated()), id: \.element.id) { index, project in
                        if index > 0 { RowDivider(inset: 0) }
                        archivedRow(project)
                    }
                }
            }
            if let error { SetupError(error) }
        }
        .task(id: reloadKey) { await loadArchived() }
        .confirmationDialog(archiveTarget.map { "\($0.name) 보관" } ?? "보관",
                            isPresented: Binding(get: { archiveTarget != nil }, set: { if !$0 { archiveTarget = nil } }),
                            titleVisibility: .visible, presenting: archiveTarget) { project in
            Button("보관", role: .destructive) { Task { await archive(project) } }
            Button("취소", role: .cancel) {}
        } message: { _ in
            Text("목록에서 사라지고 깨어 있는 세션은 잠듭니다. 데이터는 남고, 설정의 보관함에서 다시 꺼낼 수 있습니다.")
        }
    }

    private func names(_ name: String, _ cwd: String, dim: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(name).font(SetupFont.choice).foregroundStyle(dim ? CE.ink2 : CE.ink).lineLimit(1)
            Text(cwd).font(CEFont.mono).foregroundStyle(CE.ink3).lineLimit(1).truncationMode(.middle).help(cwd)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func row(_ project: ProjectSummary) -> some View {
        HStack(spacing: 10) {
            names(project.name, project.cwd)
            Button("고치기") {
                editName = project.name
                editCwd = project.cwd
                error = nil
                editingID = project.id
            }
            .ceSecondaryButton().ceCompactControl().fixedSize()
            .accessibilityLabel("\(project.name) 고치기")
            if !project.isHq {
                Button(busyID == project.id ? "보관하는 중" : "보관") { error = nil; archiveTarget = project }
                    .ceSecondaryButton().ceCompactControl().fixedSize()
                    .accessibilityLabel("\(project.name) 보관하기")
            }
        }
        .disabled(!editable || busyID != nil)
        .padding(.vertical, 9)
    }

    private func editForm(_ project: ProjectSummary) -> some View {
        let saving = busyID == project.id
        return VStack(alignment: .leading, spacing: 10) {
            SetupField("이름") {
                TextField("이름", text: $editName).labelsHidden().font(SetupFont.input).setupInput()
                    .onSubmit { Task { await saveEdit(project) } }
            }
            SetupField("폴더", hint: "새로 뜨는 직원부터 적용됩니다") {
                TextField("폴더", text: $editCwd).labelsHidden().font(CEFont.mono)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                    .setupInput()
                    .onSubmit { Task { await saveEdit(project) } }
            }
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                Button("취소") { editingID = nil; error = nil }
                    .ceSecondaryButton().ceCompactControl().disabled(saving)
                Button(saving ? "저장하는 중" : "저장") { Task { await saveEdit(project) } }
                    .ceProminentButton().ceCompactControl()
                    .disabled(saving || !editable || settingsTrim(editName).isEmpty || settingsTrim(editCwd).isEmpty)
            }
        }
        .disabled(!editable)
        .padding(.vertical, 10)
    }

    private func archivedRow(_ project: Project) -> some View {
        HStack(spacing: 10) {
            names(project.name, project.cwd, dim: true)
            Button(busyID == project.id ? "꺼내는 중" : "꺼내기") { Task { await restore(project) } }
                .ceSecondaryButton().ceCompactControl().fixedSize()
                .disabled(!editable || busyID != nil)
                .accessibilityLabel("\(project.name) 다시 꺼내기")
        }
        .padding(.vertical, 9)
    }

    private func saveEdit(_ project: ProjectSummary) async {
        let name = settingsTrim(editName), cwd = settingsTrim(editCwd)
        guard !name.isEmpty, !cwd.isEmpty else { error = "이름과 폴더를 넣어 주세요"; return }
        let patch = ProjectPatch(name: name != project.name ? name : nil, cwd: cwd != project.cwd ? cwd : nil)
        guard patch.name != nil || patch.cwd != nil else { editingID = nil; return }
        if await send(project.id, patch) { editingID = nil }
    }

    private func archive(_ project: ProjectSummary) async {
        if await send(project.id, ProjectPatch(archived: true)) { await loadArchived() }
    }

    private func restore(_ project: Project) async {
        if await send(project.id, ProjectPatch(archived: false)) { await loadArchived() }
    }

    private func send(_ id: String, _ patch: ProjectPatch) async -> Bool {
        guard store.canWrite, let api = store.api else {
            error = store.isDemo ? "샘플은 읽기 전용입니다. 실제 Mac에 연결하면 바꿀 수 있습니다." : "서버에 연결된 뒤에 바꿀 수 있습니다."
            return false
        }
        guard busyID == nil else { return false }
        busyID = id
        error = nil
        defer { busyID = nil }
        do {
            // Archiving puts the project's sessions to sleep, so allow the daemon's slow-call time.
            let _: Project = try await api.send("/api/projects/\(APIClient.segment(id))", method: "PATCH", body: patch, timeout: 150)
            await store.refresh()
            return true
        } catch let failure {
            error = failure.localizedDescription
            if (failure as? APIError)?.status == 401 { await store.refresh() }
            return false
        }
    }

    private func loadArchived() async {
        guard !store.isDemo, store.canWrite, let api = store.api else { return }
        do {
            let rows: [Project] = try await api.request("/api/projects/archived")
            archived = rows
        } catch {
            // Keep the last list; the next change reloads it.
        }
    }
}

// MARK: - New project (sheet)

struct NewProjectView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var cwd = ""
    @State private var goal = ""
    @State private var provider = "claude"
    @State private var working = false
    @State private var error: String?
    /// The daemon keeps a project whose conductor failed to start; retrying "만들기" would make a second one.
    @State private var partial: Partial?
    @FocusState private var focus: Field?

    private enum Field: Hashable { case name, cwd, goal }
    private struct Partial { let id: String; var detail: String }

    private var canCreate: Bool {
        store.canWrite && !working && partial == nil && !settingsTrim(name).isEmpty && !settingsTrim(cwd).isEmpty
    }
    private var lockNotice: (title: String, detail: String)? {
        if store.isDemo { return ("샘플은 읽기 전용입니다", "실제 Mac에 연결하면 프로젝트를 만들 수 있습니다.") }
        if !store.canWrite { return ("서버에 연결되지 않았습니다", "연결된 뒤에 만들 수 있습니다. 적은 내용은 이 창을 닫기 전까지 남아 있습니다.") }
        return nil
    }
    private var coreUnavailable: CoreRuntime? {
        guard let core = store.runtime?.core, !core.available else { return nil }
        return core
    }

    var body: some View {
        #if os(macOS)
        VStack(spacing: 0) {
            Text("새 프로젝트").font(SetupFont.sheetTitle).foregroundStyle(CE.ink).lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 22).padding(.top, 20).padding(.bottom, 4)
                .accessibilityAddTraits(.isHeader)
            ScrollView {
                form.padding(.horizontal, 22).padding(.vertical, 12)
            }
            .scrollBounceBehavior(.basedOnSize)
            Rectangle().fill(CE.line).frame(height: 1)
            footer.padding(.horizontal, 22).padding(.vertical, 14)
        }
        .background { AmbientBackground() }
        .ceSheetSize(width: 520, height: 600)
        .interactiveDismissDisabled(working)
        .onAppear { if store.canWrite { focus = .name } }
        #else
        NavigationStack {
            ScrollView {
                form.padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
            .background { AmbientBackground() }
            .navigationTitle("새 프로젝트")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(partial == nil ? "취소" : "닫기") { dismiss() }.disabled(working)
                }
                ToolbarItem(placement: .confirmationAction) { confirmButton }
            }
        }
        .interactiveDismissDisabled(working)
        #endif
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let lockNotice {
                InlineNotice(tone: store.isDemo ? .accent : .attention, icon: store.isDemo ? "eye" : "wifi.slash", title: lockNotice.title, detail: lockNotice.detail)
            }
            Group {
                SetupField("이름") {
                    TextField("이름", text: $name, prompt: Text("랜딩 리뉴얼"))
                        .labelsHidden()
                        .font(SetupFont.input)
                        .focused($focus, equals: .name)
                        .onSubmit { focus = .cwd }
                        .setupInput(active: focus == .name)
                }
                SetupField("폴더", hint: "서버 컴퓨터에 이미 있는 폴더입니다. ~/ 로 시작해도 됩니다.") {
                    TextField("폴더", text: $cwd, prompt: Text("~/code/landing"))
                        .labelsHidden()
                        .font(CEFont.mono)
                        .focused($focus, equals: .cwd)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                        .onSubmit { Task { await create() } }
                        .setupInput(active: focus == .cwd)
                }
                SetupField("목표", hint: "적으면 지금 상황에 남기고 총괄에게 프로젝트 목표로 전합니다.") {
                    TextField("목표", text: $goal, prompt: Text("선택 · 이루려는 결과와 끝났다고 볼 기준"), axis: .vertical)
                        .labelsHidden()
                        .font(SetupFont.input)
                        .lineLimit(3...6)
                        .focused($focus, equals: .goal)
                        .setupInput(active: focus == .goal)
                }
                SetupField("총괄 AI CLI", hint: "만들면 이 CLI로 총괄 세션을 바로 엽니다.") {
                    SetupMenu(providerLabel(provider), label: "총괄 AI CLI") {
                        ForEach(["claude", "codex"], id: \.self) { cli in
                            Toggle(providerLabel(cli), isOn: menuCheck(provider == cli) { provider = cli })
                        }
                    }
                }
            }
            .disabled(partial != nil || working)
            if let core = coreUnavailable, partial == nil {
                InlineNotice(tone: .attention, icon: "exclamationmark.triangle",
                             title: core.installed ? "herdr-core를 쓸 수 없습니다" : "herdr-core가 설치되지 않았습니다",
                             detail: [core.detail, "지금 만들면 프로젝트만 생기고 총괄은 뜨지 않을 수 있습니다. 설정의 실행 환경을 확인하세요."].compactMap { $0 }.joined(separator: " "))
            }
            if let partial {
                InlineNotice(tone: .danger, icon: "exclamationmark.triangle", title: "프로젝트는 만들었지만 총괄을 띄우지 못했습니다",
                             detail: partial.detail + " 다시 시도하면 같은 프로젝트에 총괄만 다시 띄웁니다.",
                             actionTitle: "프로젝트로 가기", action: { Task { await openPartial() } }, actionDisabled: working)
            }
            if let error { SetupError(error) }
        }
    }

    #if os(macOS)
    /// Web `.form__actions`: quiet cancel, primary create, bottom right.
    private var footer: some View {
        HStack(spacing: 8) {
            Spacer(minLength: 0)
            Button(partial == nil ? "취소" : "닫기") { dismiss() }
                .ceSecondaryButton()
                .keyboardShortcut(.cancelAction)
                .disabled(working)
            if partial != nil {
                Button { Task { await retryConductor() } } label: { busyLabel(working ? "띄우는 중" : "다시 시도") }
                    .ceProminentButton()
                    .keyboardShortcut(.defaultAction)
                    .disabled(working || !store.canWrite)
            } else {
                Button { Task { await create() } } label: { busyLabel(working ? "만드는 중" : "만들기") }
                    .ceProminentButton()
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canCreate)
            }
        }
    }
    #endif

    private func busyLabel(_ text: String) -> some View {
        HStack(spacing: 6) {
            if working { ProgressView().controlSize(.small).tint(.white) }
            Text(text)
        }
    }

    @ViewBuilder private var confirmButton: some View {
        if working {
            Button {} label: {
                HStack(spacing: 6) { ProgressView().controlSize(.small); Text(partial == nil ? "만드는 중" : "띄우는 중") }
            }
            .disabled(true)
        } else if partial != nil {
            Button("다시 시도") { Task { await retryConductor() } }
                .disabled(!store.canWrite)
        } else {
            Button("만들기") { Task { await create() } }
                .disabled(!canCreate)
        }
    }

    private func providerLabel(_ cli: String) -> String {
        providerFullName(cli) + (store.runtime?.providers[cli]?.installed == false ? " · 설치 필요" : "")
    }

    private func create() async {
        guard canCreate else { return }
        let projectName = settingsTrim(name)
        error = nil
        working = true
        defer { working = false }
        let before = Set(store.projects.map(\.id))
        if await store.createProject(name: projectName, cwd: settingsTrim(cwd), goal: settingsTrim(goal), provider: provider) {
            router.go(.team)
            dismiss()
            return
        }
        let message = store.errorMessage ?? "프로젝트를 만들지 못했습니다."
        await store.refresh()
        if let created = store.projects.first(where: { !before.contains($0.id) && $0.name == projectName }) {
            partial = Partial(id: created.id, detail: message)
        } else {
            error = message
        }
    }

    private func retryConductor() async {
        guard let target = partial else { return }
        working = true
        defer { working = false }
        if store.selectedProjectID != target.id { await store.selectProject(id: target.id) }
        if await store.startConductor() {
            router.go(.team)
            dismiss()
        } else {
            partial?.detail = store.errorMessage ?? "총괄을 띄우지 못했습니다."
        }
    }

    private func openPartial() async {
        guard let target = partial else { return }
        if store.selectedProjectID != target.id { await store.selectProject(id: target.id) }
        router.go(.team)
        dismiss()
    }
}
