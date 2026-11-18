import SwiftUI

// 0.2.8: AI 계정 — 이 Mac 의 Claude Code·Codex 가 쓰는 계정을 보고, 어느 기기에서나 다른 계정으로 로그인하거나 다시 로그인한다.
// 서버가 Mac 에서 CLI 의 로그인 명령을 띄우고(server/cli-login.ts), 이 화면은 로그인 페이지를 이 기기에서 열고 코드를 돌려준다.
// - Claude Code: 페이지에서 로그인하면 코드가 나온다. 복사해 붙여넣으면 서버가 CLI 에 넣는다. 서버가 도는 Mac 에서는 코드 없이 끝난다.
// - Codex: 페이지에 이 화면의 일회용 코드를 넣으면 CLI 가 스스로 끝낸다.
// 옛 서버(404·501)면 묶음과 단추를 그리지 않는다.

// MARK: - Models

struct CLIAccount: Decodable, Sendable, Equatable, Identifiable {
    let cli: String
    let installed: Bool
    let loggedIn: Bool?
    let email: String?
    let organization: String?
    let plan: String?
    let method: String?
    let checkedAt: String
    let problem: String?
    var id: String { cli }
}

struct CLILoginApplied: Decodable, Sendable, Equatable {
    let reopenedNow: Int
    let atNextTurn: Int
}

struct CLILoginFailure: Decodable, Sendable, Equatable {
    let code: String
    let message: String
}

struct CLILogin: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let cli: String
    /// paste_code(Claude) · device_code(Codex).
    let flow: String
    let phase: String
    let startedAt: String
    let expiresAt: String
    let endedAt: String?
    let url: String?
    let localUrl: String?
    let userCode: String?
    let error: CLILoginFailure?
    let account: CLIAccount?
    let accountChanged: Bool?
    let applied: CLILoginApplied?
    var active: Bool { ["starting", "waiting", "verifying"].contains(phase) }
    var pastesCode: Bool { flow == "paste_code" }
}

struct CLIAccountsResponse: Decodable, Sendable {
    let accounts: [CLIAccount]
    let logins: [CLILogin]
}

extension APIClient {
    func cliAccounts(refresh: Bool = false) async throws -> CLIAccountsResponse {
        try await request("/api/cli-accounts" + (refresh ? "?refresh=1" : ""))
    }
    func startCLILogin(cli: String, restart: Bool = false) async throws -> CLILogin {
        struct Body: Encodable, Sendable { let cli: String; let restart: Bool? }
        return try await send("/api/cli-login", body: Body(cli: cli, restart: restart ? true : nil))
    }
    func cliLogin(id: String) async throws -> CLILogin {
        try await request("/api/cli-login/\(Self.segment(id))")
    }
    func submitCLILoginCode(id: String, code: String) async throws -> CLILogin {
        struct Body: Encodable, Sendable { let code: String }
        return try await send("/api/cli-login/\(Self.segment(id))/code", body: Body(code: code))
    }
    func cancelCLILogin(id: String) async throws -> CLILogin {
        try await request("/api/cli-login/\(Self.segment(id))", method: "DELETE")
    }
}

// MARK: - Text

enum CLIAccountText {
    static func name(_ cli: String) -> String { cli == "codex" ? "Codex" : "Claude Code" }

    /// CLI 가 준 요금제 이름을 읽기 좋게(모르는 값은 그대로).
    static func plan(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        switch raw.lowercased() {
        case "max": return "Max"
        case "pro": return "Pro"
        case "prolite", "pro_lite": return "Pro Lite"
        case "plus": return "Plus"
        case "team": return "Team"
        case "business": return "Business"
        case "enterprise": return "Enterprise"
        case "edu": return "Edu"
        case "free": return "Free"
        default: return raw
        }
    }

    /// 계정 줄 아래 작은 글: 메일 · 조직 · 요금제, 또는 왜 모르는지.
    static func hint(_ account: CLIAccount) -> String {
        if !account.installed { return String(localized: "이 Mac에 설치되어 있지 않습니다") }
        switch account.loggedIn {
        case .some(true):
            let parts = [account.email, account.organization, plan(account.plan)].compactMap { $0 }.filter { !$0.isEmpty }
            // '·' 는 앞 낱말에 붙여 줄 첫머리에 오지 않게 한다(좁은 iPhone 에서 꺾일 때).
            return parts.isEmpty ? String(localized: "로그인되어 있습니다") : parts.joined(separator: "\u{00A0}· ")
        case .some(false): return String(localized: "로그인되어 있지 않습니다")
        case .none: return String(localized: "계정을 확인하지 못했습니다")
        }
    }

    static func failure(_ failure: CLILoginFailure) -> String {
        ServerErrorText.display(failure.message, code: failure.code)
    }

    /// 로그인이 끝난 뒤 떠 있는 팀장에게 한 일.
    static func applied(_ login: CLILogin) -> String? {
        let name = name(login.cli)
        let now = login.applied?.reopenedNow ?? 0, later = login.applied?.atNextTurn ?? 0
        var lines: [String] = []
        if login.accountChanged == true {
            lines.append(String(localized: "이제 이 Mac의 \(name) 팀장들이 새 계정을 씁니다."))
            if now > 0 { lines.append(String(localized: "멈춰 있던 팀장 \(now)명은 같은 대화로 다시 열어 하던 일을 이어 가게 합니다.")) }
            if later > 0 { lines.append(String(localized: "다른 팀장 \(later)명은 하던 일을 마치는 대로 같은 대화를 새 계정으로 다시 엽니다.")) }
        } else {
            if login.accountChanged == false { lines.append(String(localized: "로그인 전과 같은 계정입니다.")) }
            if now > 0 { lines.append(String(localized: "로그인 오류로 멈춘 팀장 \(now)명을 같은 대화로 다시 열어 하던 일을 이어 가게 합니다.")) }
        }
        return lines.isEmpty ? nil : lines.joined(separator: " ")
    }
}

// MARK: - State

/// 설정·한도 카드가 함께 쓰는 계정 상태. 연결이 바뀌면 앞 서버의 값을 지운다.
@MainActor @Observable final class CLIAccountsPanel {
    private(set) var accounts: [CLIAccount] = []
    private(set) var logins: [CLILogin] = []
    /// 서버가 AI 계정 로그인을 모른다(옛 서버). 이때 묶음·단추를 보이지 않는다.
    private(set) var unsupported = false
    /// 한 번이라도 읽었다(단추를 보일지 정할 수 있다).
    private(set) var known = false
    private(set) var loading = false
    private(set) var error: String?
    private var token = 0
    private var owner: ObjectIdentifier?

    var supported: Bool { known && !unsupported }
    /// 사용 한도 카드가 연 로그인. 카드 안이 아니라 앱 바탕(AppShell)이 시트를 띄운다: 로그인에 성공해 카드가 닫혀도 시트가 남는다.
    var requestedLogin: CLILoginTarget?
    func account(_ cli: String) -> CLIAccount? { accounts.first { $0.cli == cli } }
    func activeLogin(_ cli: String) -> CLILogin? { logins.first { $0.cli == cli && $0.active } }

    func attach(_ api: APIClient?, refresh: Bool = false) async {
        let id = api.map { ObjectIdentifier($0) }
        if id != owner { reset(); owner = id }
        await load(api, refresh: refresh)
    }

    func reset() {
        token &+= 1
        accounts = []; logins = []; unsupported = false; known = false; loading = false; error = nil
    }

    func load(_ api: APIClient?, refresh: Bool = false) async {
        guard let api else { return }
        token &+= 1
        let mine = token
        loading = true
        defer { if mine == token { loading = false } }
        do {
            let result = try await api.cliAccounts(refresh: refresh)
            guard mine == token else { return }
            accounts = result.accounts; logins = result.logins; unsupported = false; known = true; error = nil
        } catch let failure as APIError where [404, 405, 501].contains(failure.status) {
            guard mine == token else { return }
            accounts = []; logins = []; unsupported = true; known = true; error = nil
        } catch is CancellationError {
        } catch {
            guard mine == token, !Task.isCancelled else { return }
            if let failure = error as? APIError, !failure.message.isEmpty { self.error = failure.localizedDescription }
            else if error is URLError { self.error = String(localized: "서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.") }
            else { self.error = String(localized: "계정을 읽지 못했습니다.") }
        }
    }
}

/// 로그인 시트를 띄울 CLI.
struct CLILoginTarget: Identifiable, Hashable {
    let cli: String
    var id: String { cli }
}

// MARK: - Settings group

/// 설정 → AI 모델의 'AI 계정' 묶음(Mac·iPhone 같은 모양, 설정의 다른 묶음과 같은 부품).
struct CLIAccountsGroup: View {
    @Environment(AppStore.self) private var store
    @State private var target: CLILoginTarget?

    private var panel: CLIAccountsPanel { store.cliAccounts }

    var body: some View {
        content
            .task(id: store.api.map { ObjectIdentifier($0) }) { await panel.attach(store.api) }
            .sheet(item: $target, onDismiss: { Task { await panel.load(store.api, refresh: true) } }) { target in
                CLILoginSheet(cli: target.cli)
            }
    }

    @ViewBuilder private var content: some View {
        if !store.isDemo, store.api != nil, !panel.unsupported {
            SettingsGroup(String(localized: "AI 계정"), footnote: panel.error ?? String(localized: "다른 계정으로 로그인하면 이 Mac에서 그 CLI를 쓰는 팀장 모두가 새 계정을 씁니다. 로그인 페이지는 지금 쓰는 이 기기에서 열립니다."),
                          footnoteTone: panel.error == nil ? CE.ink2 : CE.danger, accessory: {
                SettingsRefreshButton(label: String(localized: "계정 다시 확인"), busy: panel.loading) { Task { await panel.load(store.api, refresh: true) } }
                    .disabled(store.connectionStatus != .connected)
            }) {
                let accounts = panel.accounts
                if accounts.isEmpty {
                    SettingsRow(String(localized: "계정"), hint: panel.loading ? String(localized: "불러오는 중") : String(localized: "연결한 뒤 볼 수 있습니다")) {
                        if panel.loading { ProgressView().controlSize(.small) }
                    }
                } else {
                    ForEach(Array(accounts.enumerated()), id: \.element.id) { index, account in
                        if index > 0 { RowDivider(inset: 0) }
                        row(account)
                    }
                }
            }
        }
    }

    private func row(_ account: CLIAccount) -> some View {
        let pending = panel.activeLogin(account.cli) != nil
        // 줄 오른쪽 단추라 짧게(영어 iPhone 에서 'Sign in with another account' 가 잘렸다). 사용 한도 카드의 단추는 넓어 '다른 계정으로 로그인'.
        let title = pending ? String(localized: "로그인 이어 하기") : account.loggedIn == true ? String(localized: "계정 바꾸기") : String(localized: "로그인")
        return SettingsRow(CLIAccountText.name(account.cli), hint: CLIAccountText.hint(account),
                           hintTone: account.loggedIn == false || (account.installed && account.loggedIn == nil) ? CE.attention : CE.ink2, stacksOnPhone: false) {
            Button(title) { target = CLILoginTarget(cli: account.cli) }
                .ceSecondaryButton().controlSize(.small)
                .disabled(!account.installed || store.connectionStatus != .connected)
                .accessibilityLabel("\(CLIAccountText.name(account.cli)) \(title)")
        }
    }
}

// MARK: - Login sheet

struct CLILoginSheet: View {
    let cli: String
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var login: CLILogin?
    @State private var code = ""
    @State private var working = false
    @State private var error: String?
    @State private var opened = false
    @State private var copied = false
    @FocusState private var codeFocused: Bool

    private var name: String { CLIAccountText.name(cli) }

    var body: some View {
        CESheet(String(localized: "\(name) 로그인"), icon: "person.crop.circle.badge.checkmark", width: 520, onClose: { dismiss() }) {
            VStack(alignment: .leading, spacing: 16) {
                content
                if let error { SheetError(text: error) }
            }
        } footer: {
            footer
        }
        .interactiveDismissDisabled(working)
        .task { await begin(restart: false) }
        .task(id: login?.id) { await poll() }
        .onChange(of: scenePhase) { _, phase in
            // 로그인 페이지에서 돌아왔다: 기다리지 않고 바로 다시 본다.
            if phase == .active, login?.active == true { Task { await refresh() } }
        }
    }

    // MARK: Content

    @ViewBuilder private var content: some View {
        if let login {
            switch login.phase {
            case "waiting":
                if login.pastesCode { pasteSteps(login) } else { deviceSteps(login) }
            case "starting":
                progress(String(localized: "Mac에서 로그인을 준비하는 중입니다…"))
            case "verifying":
                progress(String(localized: "로그인을 확인하는 중입니다…"))
            case "succeeded":
                succeeded(login)
            default:
                ended(login)
            }
        } else if error == nil {
            progress(String(localized: "Mac에서 로그인을 준비하는 중입니다…"))
        }
    }

    private func progress(_ text: String) -> some View {
        HStack(spacing: 10) {
            ProgressView().controlSize(.small)
            Text(text).font(CEFont.note).foregroundStyle(CE.ink2)
        }
        .padding(.vertical, 6)
    }

    private func lead(_ text: String) -> some View {
        Text(text).font(CEFont.note).foregroundStyle(CE.ink2)
            .lineSpacing(CELeading.note)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func step(_ number: Int, _ title: String, _ detail: String? = nil) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("\(number)").font(CEFont.micro).foregroundStyle(CE.ink)
                .frame(width: 20, height: 20)
                .background(CE.violet.opacity(0.22), in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(CEFont.rowTitle).foregroundStyle(CE.ink).fixedSize(horizontal: false, vertical: true)
                if let detail { lead(detail) }
            }
        }
    }

    /// 서버가 도는 Mac 의 앱이면 코드 없이 끝나는 자동 주소를 연다.
    private func openTarget(_ login: CLILogin) -> URL? {
        if isMac, store.serverIsThisMac, let local = login.localUrl, let url = URL(string: local) { return url }
        return login.url.flatMap(URL.init(string:))
    }

    private var onThisMac: Bool { isMac && store.serverIsThisMac }

    /// 무엇이 바뀌는지 한 줄(단계가 할 일을 말한다).
    private var consequence: some View {
        lead(String(localized: "로그인한 계정을 이 Mac의 \(name) 팀장 모두가 씁니다."))
    }

    @ViewBuilder private func pasteSteps(_ login: CLILogin) -> some View {
        let local = onThisMac && login.localUrl != nil
        consequence
        step(1, String(localized: "브라우저에서 바꿀 계정으로 로그인"),
             local ? String(localized: "허용을 누르면 바로 끝납니다. 다른 계정이 이미 로그인되어 있으면 그 페이지에서 계정을 바꾸세요.")
                   : String(localized: "다른 계정이 이미 로그인되어 있으면 그 페이지에서 계정을 바꾸세요."))
        openButton(login)
        step(2, local ? String(localized: "코드가 나오면 붙여넣기") : String(localized: "페이지에 나온 코드 붙여넣기"),
             local ? String(localized: "페이지에 코드가 나왔을 때만 복사해 붙여넣으세요.")
                   : String(localized: "로그인을 마치면 페이지에 긴 코드가 나옵니다. 복사 단추로 복사해 붙여넣으세요."))
        HStack(spacing: 8) {
            TextField(String(localized: "코드"), text: $code)
                .font(SetupFont.codeInput)
                .focused($codeFocused)
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                .keyboardType(.asciiCapable)
                #endif
                .submitLabel(.done)
                .onSubmit { Task { await submit() } }
                .padding(.horizontal, 12)
                .frame(minHeight: 44)
                .background(CE.bgDeep.opacity(0.5), in: RoundedRectangle(cornerRadius: CERadius.control, style: .continuous))
                .overlay { RoundedRectangle(cornerRadius: CERadius.control, style: .continuous).strokeBorder(codeFocused ? CE.accent.opacity(0.85) : Color.white.opacity(0.12)) }
                .disabled(working)
                .accessibilityLabel(String(localized: "로그인 코드"))
            #if os(iOS)
            // 복사한 코드를 한 번에 붙여넣고 바로 보낸다(붙여넣기 허락 창 없이).
            PasteButton(payloadType: String.self) { strings in
                guard let text = strings.first else { return }
                Task { @MainActor in code = text; await submit() }
            }
            .labelStyle(.titleAndIcon)
            .buttonBorderShape(.capsule)
            .tint(CE.violet)
            .frame(minHeight: 44)
            .disabled(working)
            #endif
        }
    }

    @ViewBuilder private func deviceSteps(_ login: CLILogin) -> some View {
        consequence
        step(1, String(localized: "브라우저에서 바꿀 계정으로 로그인"), String(localized: "다른 계정이 이미 로그인되어 있으면 그 페이지에서 계정을 바꾸세요."))
        openButton(login)
        step(2, String(localized: "페이지에 이 일회용 코드 넣기"), String(localized: "로그인 페이지를 열 때 코드도 복사됩니다. 15분 동안 쓸 수 있습니다."))
        if let userCode = login.userCode {
            HStack(spacing: 12) {
                Text(userCode)
                    .font(.system(size: isMac ? 26 : 24, weight: .semibold, design: .monospaced))
                    .tracking(2)
                    .foregroundStyle(CE.ink)
                    .textSelection(.enabled)
                    .accessibilityLabel(String(localized: "일회용 코드 \(userCode)"))
                Spacer(minLength: 8)
                Button(copied ? String(localized: "복사함") : String(localized: "코드 복사")) { copy(userCode) }
                    .ceSecondaryButton().controlSize(.small)
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
            .background(CE.bgDeep.opacity(0.5), in: RoundedRectangle(cornerRadius: CERadius.control, style: .continuous))
        }
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(String(localized: "코드를 넣으면 이 화면이 저절로 바뀝니다")).font(CEFont.meta).foregroundStyle(CE.ink2)
        }
    }

    private func openButton(_ login: CLILogin) -> some View {
        Button {
            guard let url = openTarget(login) else { return }
            opened = true
            if login.cli == "codex", let userCode = login.userCode { copy(userCode) }
            openURL(url)
            if login.pastesCode { codeFocused = true }
        } label: {
            Label(opened ? String(localized: "로그인 페이지 다시 열기") : String(localized: "로그인 페이지 열기"), systemImage: "safari")
        }
        .ceProminentButton()
        .disabled(openTarget(login) == nil)
    }

    private func succeeded(_ login: CLILogin) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            InlineNotice(tone: .success, icon: "checkmark.circle", title: String(localized: "\(name)에 로그인했습니다"),
                         detail: login.account.map(CLIAccountText.hint))
            if let applied = CLIAccountText.applied(login) { lead(applied) }
        }
    }

    private func ended(_ login: CLILogin) -> some View {
        let text: String = login.error.map(CLIAccountText.failure)
            ?? (login.phase == "cancelled" ? String(localized: "로그인을 그만뒀습니다.") : String(localized: "로그인하지 못했습니다."))
        return InlineNotice(tone: login.phase == "cancelled" ? .neutral : .attention, icon: "exclamationmark.circle", title: text)
    }

    @ViewBuilder private var footer: some View {
        // 닫아도 로그인은 Mac 에서 15분까지 기다린다(다시 열면 이어 한다). 그만두려면 이 단추로. 확인 중(verifying)에는 CLI 가 이미 끝났을 수 있어 보이지 않는다.
        if let login, ["starting", "waiting"].contains(login.phase) {
            Button(String(localized: "그만두기")) { Task { await cancel() } }
                .ceSecondaryButton().disabled(working)
        }
        if let login, login.phase == "succeeded" {
            Button(String(localized: "완료")) { dismiss() }
                .ceProminentButton().keyboardShortcut(.defaultAction)
        } else if let login, !login.active {
            Button { Task { await begin(restart: true) } } label: {
                HStack(spacing: 6) {
                    if working { ProgressView().controlSize(.small).tint(.white) }
                    Text(String(localized: "처음부터 다시"))
                }
            }
            .ceProminentButton().disabled(working)
        } else if let login, login.phase == "waiting", login.pastesCode {
            Button { Task { await submit() } } label: {
                HStack(spacing: 6) {
                    if working { ProgressView().controlSize(.small).tint(.white) }
                    Text(String(localized: "로그인 마치기"))
                }
            }
            .ceProminentButton().keyboardShortcut(.defaultAction)
            .disabled(working || code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } else if login == nil, error != nil {
            Button(String(localized: "다시 시도")) { Task { await begin(restart: false) } }
                .ceProminentButton().disabled(working)
        }
    }

    // MARK: Actions

    private func copy(_ text: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
        copied = true
    }

    private func describe(_ failure: Error) -> String {
        if let api = failure as? APIError {
            if [404, 405, 501].contains(api.status) && api.code != "cli_login_not_found" {
                return String(localized: "연결된 Mac의 서버가 AI 계정 로그인을 지원하지 않습니다. Mac의 IAMCEO를 최신 버전으로 올려 주세요.")
            }
            if !api.message.isEmpty { return api.localizedDescription }
        }
        if failure is URLError { return String(localized: "서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.") }
        return String(localized: "로그인을 시작하지 못했습니다.")
    }

    private func begin(restart: Bool) async {
        guard let api = store.api, !working else { return }
        working = true; error = nil; code = ""; opened = false; copied = false
        defer { working = false }
        do { login = try await api.startCLILogin(cli: cli, restart: restart) }
        catch is CancellationError {}
        catch { self.error = describe(error) }
    }

    private func refresh() async {
        guard let api = store.api, let id = login?.id else { return }
        do {
            let next = try await api.cliLogin(id: id)
            if next != login { login = next }
        } catch let failure as APIError where failure.status == 404 {
            // 서버가 다시 떠 로그인을 잃었다: 묻기를 멈추고 '다시 시도'를 보인다.
            login = nil
            error = describe(failure)
        } catch {}
    }

    /// 진행 중인 동안 1.5초마다 다시 본다(끝나면 멈춘다).
    private func poll() async {
        while !Task.isCancelled, login?.active == true {
            try? await Task.sleep(for: .milliseconds(1500))
            guard !Task.isCancelled else { return }
            await refresh()
        }
        if login?.phase == "succeeded" { await store.cliAccounts.load(store.api, refresh: true) }
    }

    private func submit() async {
        guard let api = store.api, let id = login?.id, !working else { return }
        let value = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        working = true; error = nil
        defer { working = false }
        do { login = try await api.submitCLILoginCode(id: id, code: value) }
        catch is CancellationError {}
        catch { self.error = describe(error) }
    }

    /// 진행 중인 로그인을 그만둔다(Mac 에 띄운 CLI 를 끝낸다).
    private func cancel() async {
        guard let api = store.api, let id = login?.id, !working else { return }
        working = true
        defer { working = false }
        do { login = try await api.cancelCLILogin(id: id) }
        catch is CancellationError {}
        catch { self.error = describe(error) }
    }
}

/// 시트 안 오류 한 줄(설정 화면의 오류 줄과 같은 모양).
private struct SheetError: View {
    let text: String
    var body: some View {
        Label(text, systemImage: "exclamationmark.circle")
            .font(CEFont.note).foregroundStyle(CE.danger)
            .lineSpacing(CELeading.note)
            .fixedSize(horizontal: false, vertical: true)
    }
}
