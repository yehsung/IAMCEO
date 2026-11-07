import SwiftUI
import UniformTypeIdentifiers

/// One file being uploaded into a draft (shown as an "올리는 중" chip under its own draft key).
private struct ComposerUpload: Identifiable {
    let id = UUID()
    let name: String
    let token: DraftUploadToken
}

private struct ComposerUploadFailure: Identifiable {
    let id = UUID()
    let token: DraftUploadToken
    let name: String
    let url: URL
    let detail: String
}

private struct ComposerUploadContext {
    let projectID: String
    let targetMemberID: String?
    let token: DraftUploadToken
}

/// A local acceptance, as distinct from an old/other-device `mine` row appearing in history.
struct ComposerAcceptedMessage {
    static let notification = Notification.Name("IAMCEO.composerAcceptedMessage")
    let namespace: String
    let projectID: String
    let targetMemberID: String?
    let messageID: String
}

/// The one instruction surface (web Composer): a dark glass panel with a meta row (target chip, attachment chips,
/// hints), an error line, and the input row (paperclip, text, round send button).
/// Used docked under every Mac destination, inline in Chat, and in the iPhone quick-compose sheet.
/// Drafts and attachments are keyed by project + target, so switching either never sends a draft to someone else.
struct ComposerBar: View {
    @Environment(AppStore.self) private var store
    @Environment(DraftStore.self) private var drafts
    @Environment(Router.self) private var router
    @Binding var target: String?
    var showsTargetPicker = true
    var autoFocus = false
    /// Called after the daemon accepted the message (saved). Delivery is shown in Chat, never here.
    var onSent: (() -> Void)? = nil
    var onOpenChat: (() -> Void)? = nil
    @State private var importing = false
    @State private var importContext: ComposerUploadContext?
    @State private var uploads: [ComposerUpload] = []
    @State private var failedUploads: [ComposerUploadFailure] = []
    @State private var uploadError: String?
    /// Why the last send failed; the text stays in the draft.
    @State private var sendError: String?
    /// Recipient of the last accepted send, shown for a few seconds.
    @State private var sentTo: String?
    @State private var sentToken = UUID()
    @State private var dropTargeted = false
    @State private var sendingLocally = false
    @FocusState private var focused: Bool

    private var key: String { DraftStore.key(project: store.selectedProjectID, target: target) }
    private var recipient: Member? { target.flatMap { id in store.members.first { $0.id == id } } }
    /// The target is no longer on the roster (closed, or reached through an old link). Never relabel it as the lead:
    /// the request would still carry the old id.
    private var missingTarget: Bool { target != nil && store.state != nil && recipient == nil }
    /// The project lead (총괄, or 본사 AI on HQ) receives messages with no explicit target.
    private var leadName: String { store.leadRankName }
    private var recipientName: String { missingTarget ? "명부에 없는 대상" : recipient?.name ?? leadName }
    private var sending: Bool { sendingLocally || store.pendingActions.contains { $0.hasPrefix("send:") } }
    private var draftText: String { drafts.text(for: key) }
    private var files: [Attachment] { drafts.files(for: key) }
    private var pendingUploads: [ComposerUpload] {
        uploads.filter { $0.token.key == key && $0.token.namespace == drafts.namespace
            && $0.token.connectionGeneration == drafts.connectionGeneration
            && $0.token.draftGeneration == drafts.snapshot(for: key).generation }
    }
    private var missingUploads: [ComposerUploadFailure] {
        failedUploads.filter { $0.token.key == key && $0.token.namespace == drafts.namespace
            && $0.token.connectionGeneration == drafts.connectionGeneration
            && $0.token.draftGeneration == drafts.snapshot(for: key).generation }
    }
    private var attempt: MessageSubmission? {
        store.submissions?.messages(namespace: drafts.namespace).first {
            $0.draft.key == key && $0.status != .refused && ($0.status != .accepted || !$0.draftConsumed)
        }
    }
    private var checkingAttempt: Bool { attempt?.status == .checking || attempt?.status == .accepted }
    private var editedAttempt: Bool { attempt.map { $0.draft.revision != drafts.revision(for: key) } ?? false }
    private var text: Binding<String> { Binding(get: { drafts.text(for: key) }, set: { drafts.setText($0, for: key) }) }
    private var canAttach: Bool { store.uiCanWrite && !missingTarget }
    private var canSend: Bool {
        store.uiCanWrite && !sending && !checkingAttempt && !editedAttempt && pendingUploads.isEmpty
            && missingUploads.isEmpty && uploadError == nil
            && drafts.persistenceError == nil && !missingTarget
            && (!draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty)
    }

    /// Web placeholders.
    private var placeholder: String {
        if missingTarget { return "명부에 없는 대상에게는 보낼 수 없습니다" }
        if let recipient { return "\(recipient.name)에게 직접 지시" }
        if store.state?.project.isHq == true { return "본사 AI에게 — 새 프로젝트 만들기 등" }
        return "지시나 질문"
    }

    private var blockedReason: (text: String, tone: Tone)? {
        if store.isDemo { return ("샘플 데이터 · 읽기 전용", .dim) }
        if store.connectionStatus != .connected { return ("서버 연결이 끊겨 보낼 수 없습니다 · 쓴 글은 남아 있습니다", .attention) }
        if let connection = store.state?.project.connection, !connection.ok {
            return (connection.ownerDetail ?? "이 프로젝트의 실행 연결에 문제가 있어 보낼 수 없습니다", .attention)
        }
        return nil
    }

    private var hasMetaRow: Bool {
        showsTargetPicker || !files.isEmpty || !pendingUploads.isEmpty || dropTargeted || sentTo != nil || quietBlock != nil
    }

    /// Why sending is off (sample, offline, runner connection), shown quietly beside the target chip. Errors and a
    /// removed target take their own line instead.
    private var quietBlock: (text: String, tone: Tone)? {
        guard uploadError == nil, sendError == nil, !missingTarget else { return nil }
        return blockedReason
    }

    var body: some View {
        if store.isArchive || store.state?.project.archived == true {
            Text("보관한 대화 · 읽기 전용").font(CEFont.meta).foregroundStyle(CE.ink3)
        } else {
            panel
        }
    }

    private var panel: some View {
        let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
        return VStack(alignment: .leading, spacing: 2) {
            if hasMetaRow { metaRow }
            noticeLine
            inputRow
        }
        .padding(6)
        .glassPanel(shape)
        .overlay {
            // Focus belongs to the whole panel (web): violet outline; a dashed one while a file is dragged over it.
            if dropTargeted {
                shape.strokeBorder(CE.accent, style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
            } else if focused {
                shape.strokeBorder(CE.violet.opacity(0.85), lineWidth: 1.5)
            }
        }
        .animation(.easeOut(duration: 0.12), value: focused)
        .dropDestination(for: URL.self) { urls, _ in
            let local = urls.filter(\.isFileURL)
            guard !local.isEmpty, let context = uploadContext() else { return false }
            Task { await upload(local, context: context) }
            return true
        } isTargeted: { dropTargeted = $0 && canAttach }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls):
                if let context = importContext { Task { await upload(urls, context: context) } }
            case .failure(let error): uploadError = error.localizedDescription
            }
        }
        .onAppear { if autoFocus { focusSoon() } }
        .onChange(of: router.focusComposer) { _, _ in focusSoon() }
        .onChange(of: key) { _, _ in uploadError = nil; sendError = nil; sentTo = nil }
        .onChange(of: drafts.connectionGeneration) { _, _ in uploadError = nil; sendError = nil; sentTo = nil }
        .onChange(of: draftText) { old, new in
            sendError = nil
            if new.count > old.count { sentTo = nil }
        }
    }

    // MARK: Meta row

    private var metaRow: some View {
        HStack(spacing: 6) {
            if showsTargetPicker { targetChip }
            if !files.isEmpty || !pendingUploads.isEmpty {
                // Many attachments scroll inside the row instead of growing the panel.
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(files) { fileChip($0) }
                        ForEach(pendingUploads) { uploadingChip($0) }
                    }
                }
                .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            }
            if dropTargeted {
                Text("놓으면 첨부됩니다").font(hintFont).foregroundStyle(CE.ink2).lineLimit(1).layoutPriority(1)
            } else if let sentTo {
                sentHint(sentTo).layoutPriority(1)
            } else if let block = quietBlock {
                HStack(spacing: 5) {
                    Image(systemName: store.isDemo ? "eye" : "wifi.exclamationmark").font(.system(size: 10.5, weight: .semibold))
                    Text(block.text).lineLimit(isMac ? 1 : 2).truncationMode(.tail)
                }
                .font(hintFont).foregroundStyle(block.tone.color)
                .padding(.leading, 4)
                .help(block.text)
                .accessibilityElement(children: .combine)
            }
            if files.isEmpty && pendingUploads.isEmpty { Spacer(minLength: 0) }
        }
        .padding(.horizontal, 2)
        .frame(minHeight: 30)
    }

    private var hintFont: Font { isMac ? .system(size: 12.5) : CEFont.meta }

    /// Web target chip: "총괄"/"본사 AI" quiet; a worker is "@이름" in white on violet.
    private var targetChip: some View {
        let direct = recipient != nil && !missingTarget
        let label = missingTarget ? "명부에 없는 대상" : recipient.map { "@\($0.name)" } ?? leadName
        return Menu {
            menuItem("\(leadName) · 기본", selected: target == nil) { target = nil }
            let workers = store.members.filter { $0.kind == "worker" }
            if !workers.isEmpty {
                Divider()
                ForEach(workers) { member in
                    menuItem("\(member.name) · \(MemberStatusInfo(member.status).label)", selected: target == member.id) { target = member.id }
                }
            }
        } label: {
            HStack(spacing: 5) {
                if missingTarget { StatusDot(tone: .danger, size: 6) }
                Text(label).font(isMac ? .system(size: 12.5, weight: .semibold) : CEFont.meta.weight(.semibold)).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 8.5, weight: .bold))
            }
            .foregroundStyle(direct ? Color.white : missingTarget ? CE.danger : CE.ink2)
            .padding(.horizontal, 10).frame(height: 28)
            .background(direct ? CE.violet.opacity(0.42) : Color.white.opacity(0.08), in: Capsule())
            .overlay { Capsule().strokeBorder(direct ? CE.violet.opacity(0.95) : missingTarget ? CE.danger.opacity(0.6) : Color.white.opacity(0.1)) }
            .frame(maxWidth: 220)
            .frame(height: isMac ? 28 : 44)
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("보낼 대상 바꾸기")
        .accessibilityLabel("보낼 대상: \(recipientName). 눌러서 바꾸기")
    }

    @ViewBuilder private func menuItem(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        if selected {
            Button(action: action) { Label(title, systemImage: "checkmark") }
        } else {
            Button(title, action: action)
        }
    }

    private func fileChip(_ file: Attachment) -> some View {
        HStack(spacing: 5) {
            Image(systemName: file.isImage ? "photo" : "doc").font(.system(size: 10.5, weight: .semibold)).foregroundStyle(CE.ink2)
            Text(file.name).lineLimit(1).truncationMode(.middle).frame(maxWidth: 180, alignment: .leading)
            Button { drafts.removeFile(file.id, for: key) } label: {
                Image(systemName: "xmark").font(.system(size: 8.5, weight: .bold)).foregroundStyle(CE.ink2)
                    .frame(width: 24, height: 24).contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(file.name) 빼기")
        }
        .font(isMac ? .system(size: 12.5, weight: .medium) : CEFont.meta.weight(.medium))
        .foregroundStyle(CE.ink)
        .padding(.leading, 9).padding(.trailing, 2).frame(height: 28)
        .background(Color.white.opacity(0.08), in: Capsule())
        .overlay { Capsule().strokeBorder(Color.white.opacity(0.1)) }
        .help(file.name)
    }

    private func uploadingChip(_ upload: ComposerUpload) -> some View {
        HStack(spacing: 6) {
            ProgressView().controlSize(.mini)
            Text(upload.name).lineLimit(1).truncationMode(.middle).frame(maxWidth: 160, alignment: .leading)
            Text("올리는 중").foregroundStyle(CE.ink2)
        }
        .font(isMac ? .system(size: 12.5, weight: .medium) : CEFont.meta.weight(.medium))
        .foregroundStyle(CE.ink)
        .padding(.horizontal, 9).frame(height: 28)
        .background(Color.white.opacity(0.08), in: Capsule())
        .overlay { Capsule().strokeBorder(Color.white.opacity(0.1)) }
        .accessibilityElement(children: .combine)
    }

    /// "{대상}에게 보냈습니다 · 대화에서 보기". Sent = the server accepted it; whether the CLI received it is the
    /// delivery state in 대화 (전달 대기 · 받음), never claimed here.
    private func sentHint(_ name: String) -> some View {
        HStack(spacing: 4) {
            Text("\(name)에게 보냈습니다").lineLimit(1).truncationMode(.middle)
            if let onOpenChat {
                Text("·").foregroundStyle(CE.ink3)
                Button(action: onOpenChat) {
                    Text("대화에서 보기").underline().foregroundStyle(CE.accent)
                        .frame(minHeight: isMac ? nil : 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .fixedSize()
            }
        }
        .font(hintFont).foregroundStyle(CE.ink2)
        .help("서버가 받았습니다. CLI에 들어갔는지는 대화의 전달 상태로 확인하세요.")
        .accessibilityElement(children: .combine)
    }

    // MARK: Notice line

    @ViewBuilder private var noticeLine: some View {
        if checkingAttempt {
            notice("접수 확인 중 · 글과 첨부는 보관했습니다", icon: "clock", color: CE.attention,
                   actionTitle: "접수 확인", action: { Task { await store.recoverWrites() } })
        } else if let error = drafts.persistenceError {
            notice("초안을 저장하지 못했습니다: \(error)", icon: "exclamationmark.circle", color: CE.danger)
        } else if pendingUploads.isEmpty, let missing = missingUploads.first {
            notice("첨부 \(missingUploads.count)개를 확인하지 못했습니다: \(missing.detail)", icon: "exclamationmark.circle", color: CE.danger,
                   actionTitle: "빠진 첨부 빼기", action: {
                       let ids = Set(missingUploads.map(\.id))
                       failedUploads.removeAll { ids.contains($0.id) }
                   })
        } else if let uploadError {
            notice(uploadError + " · 첨부를 다시 골라 주세요", icon: "exclamationmark.circle", color: CE.danger,
                   actionTitle: "첨부 없이 보내기", action: { self.uploadError = nil })
        } else if let attempt, editedAttempt {
            notice("이전 글은 접수되지 않았습니다. 편집한 글과 첨부는 남아 있습니다.", icon: "clock", color: CE.attention,
                   actionTitle: "편집한 글 사용", action: {
                       guard attempt.status == .notAccepted || attempt.status == .prepared else { return }
                       do { try store.submissions?.refuseMessage(id: attempt.id) }
                       catch { sendError = "이전 전송을 정리하지 못했습니다: \(error.localizedDescription)" }
                   })
        } else if attempt?.status == .notAccepted {
            notice("접수되지 않았습니다. 같은 전송으로 다시 보낼 수 있습니다.", icon: "arrow.clockwise", color: CE.attention)
        } else if let sendError {
            notice(sendError, icon: "exclamationmark.circle", color: CE.danger)
        } else if missingTarget {
            notice("명부에서 빠진 대상입니다. 쓰던 글은 그대로 있습니다.", icon: "person.crop.circle.badge.xmark", color: CE.attention,
                   actionTitle: "\(leadName)에게 보내기로 바꾸기", action: { target = nil })
        }
    }

    /// One line on Mac (full text in the tooltip): this panel sits in a bar outside any scroll view.
    private func notice(_ text: String, icon: String, color: Color, actionTitle: String? = nil, action: (() -> Void)? = nil) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: icon).font(.system(size: 11, weight: .semibold))
            Text(text).lineLimit(isMac ? 1 : 3).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let actionTitle, let action {
                Button(action: action) {
                    Text(actionTitle).fontWeight(.semibold).foregroundStyle(CE.accent)
                        .frame(minHeight: isMac ? nil : 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .fixedSize()
            }
        }
        .font(CEFont.secondary)
        .foregroundStyle(color)
        .padding(.horizontal, 8).padding(.top, 2).padding(.bottom, 1)
        .help(text)
        .accessibilityElement(children: .combine)
    }

    // MARK: Input row

    private var inputRow: some View {
        HStack(alignment: .bottom, spacing: 2) {
            Button { importContext = uploadContext(); importing = importContext != nil } label: {
                Image(systemName: "paperclip").font(.system(size: 17))
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(ComposerGhostStyle())
            .disabled(!canAttach)
            .help("첨부 (50MB까지)")
            .accessibilityLabel("첨부")

            TextField("\(recipientName)에게 보낼 글", text: text, prompt: Text(placeholder).foregroundStyle(CE.ink2), axis: .vertical)
                .textFieldStyle(.plain)
                .font(isMac ? .system(size: 15) : CEFont.body)
                .lineLimit(1...7)
                .focused($focused)
                .padding(.horizontal, 6).padding(.vertical, 11)
                .frame(minHeight: 44)
                .disabled(store.isDemo)
                #if os(macOS)
                .onSubmit { Task { await send() } }
                #endif

            Button { Task { await send() } } label: {
                Group {
                    if sending { ProgressView().controlSize(.small).tint(.white) }
                    else { Image(systemName: "arrow.up").font(.system(size: 16, weight: .bold)) }
                }
            }
            .buttonStyle(ComposerSendStyle(active: canSend || sending))
            .disabled(!canSend)
            // Only while this field has focus: a window-wide ⌘↩ would send this draft while the CEO is typing a
            // decision memo, a model name or a search somewhere else.
            .keyboardShortcut(focused ? KeyboardShortcut(.return, modifiers: .command) : nil)
            .help("보내기 (⌘↩)")
            .accessibilityLabel("\(recipientName)에게 보내기")
        }
    }

    // MARK: Actions

    /// Focus now, and once more after a sheet that asked for it (member detail on Mac) has finished closing.
    private func focusSoon() {
        focused = true
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(400))
            focused = true
        }
    }

    private func send() async {
        guard canSend else { return }
        let snapshot = drafts.snapshot(for: key)
        let connection = drafts.connectionGeneration
        let project = store.selectedProjectID
        let sendingTarget = target
        let name = recipientName
        sendingLocally = true
        defer { sendingLocally = false }
        sendError = nil
        sentTo = nil
        let ok = await store.sendMessage(text: snapshot.text, targetMemberID: sendingTarget, attachmentIDs: snapshot.attachments.map(\.id))
        guard connection == drafts.connectionGeneration, drafts.namespace == snapshot.namespace,
              project == store.selectedProjectID, key == snapshot.key else { return }
        guard ok else {
            if checkingAttempt { return }
            let detail = store.errorMessage?.trimmingCharacters(in: CharacterSet(charactersIn: ". ")) ?? ""
            sendError = (detail.isEmpty ? "보내지 못했습니다" : "보내지 못했습니다: \(detail)") + ". 글은 그대로 두었습니다"
            // Said once, here, next to the kept text (not again in the status strip). A 401 leaves the app, so keep it.
            if store.bootstrap != nil, !detail.isEmpty { store.errorMessage = nil }
            return
        }
        // AppStore consumes the accepted attempt's captured revision. Never consume the current draft again here.
        if let accepted = store.submissions?.messages(namespace: snapshot.namespace).first(where: {
            $0.draft.key == snapshot.key && $0.draft.generation == snapshot.generation
                && $0.draft.revision == snapshot.revision && $0.status == .accepted
        }), let project {
            NotificationCenter.default.post(name: ComposerAcceptedMessage.notification,
                object: ComposerAcceptedMessage(namespace: snapshot.namespace, projectID: project,
                                                targetMemberID: sendingTarget, messageID: accepted.id))
        }
        let token = UUID()
        sentToken = token
        sentTo = name
        onSent?()
        sendingLocally = false
        try? await Task.sleep(for: .seconds(5))
        if sentToken == token { sentTo = nil }
    }

    private func uploadContext() -> ComposerUploadContext? {
        guard canAttach, let project = store.selectedProjectID else { return nil }
        return ComposerUploadContext(projectID: project, targetMemberID: target, token: drafts.uploadToken(for: key))
    }

    private func upload(_ urls: [URL], context: ComposerUploadContext) async {
        let token = context.token
        let project = context.projectID
        let uploadTarget = context.targetMemberID
        guard store.api != nil, store.canWrite, project == store.selectedProjectID,
              token.namespace == drafts.namespace, token.connectionGeneration == drafts.connectionGeneration,
              token.draftGeneration == drafts.snapshot(for: token.key).generation else { return }
        if key == token.key { uploadError = nil }
        // Register the whole batch before the first await, so the draft cannot be sent between files.
        let batch = urls.map { ComposerUpload(name: $0.lastPathComponent, token: token) }
        uploads.append(contentsOf: batch)
        for url in urls { failUpload(url, token: token, detail: "아직 첨부하지 못했습니다") }
        defer { uploads.removeAll { item in batch.contains { $0.id == item.id } } }
        for url in urls {
            guard token.namespace == drafts.namespace, token.connectionGeneration == drafts.connectionGeneration,
                  token.draftGeneration == drafts.snapshot(for: token.key).generation,
                  project == store.selectedProjectID, store.canWrite else { return }
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            do {
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size <= 50 * 1024 * 1024 else {
                    failUpload(url, token: token, detail: "파일은 50MB까지 올릴 수 있습니다")
                    continue
                }
                let data = try Data(contentsOf: url, options: .mappedIfSafe)
                let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                // AppStore checks connection/project and deletion generations and persists the completed attachment.
                let attachment = await store.upload(data: data, filename: url.lastPathComponent, mime: mime, targetMemberID: uploadTarget)
                guard token.namespace == drafts.namespace, token.connectionGeneration == drafts.connectionGeneration,
                      token.draftGeneration == drafts.snapshot(for: token.key).generation,
                      project == store.selectedProjectID else { return }
                if attachment == nil { failUpload(url, token: token, detail: "첨부를 확인하지 못했습니다") }
                else {
                    failedUploads.removeAll { $0.token.namespace == token.namespace && $0.token.key == token.key
                        && $0.token.draftGeneration == token.draftGeneration && $0.url == url }
                }
            } catch {
                guard token.namespace == drafts.namespace, token.connectionGeneration == drafts.connectionGeneration,
                      token.draftGeneration == drafts.snapshot(for: token.key).generation else { return }
                failUpload(url, token: token, detail: error.localizedDescription)
            }
        }
    }

    private func failUpload(_ url: URL, token: DraftUploadToken, detail: String) {
        failedUploads.removeAll { $0.token.namespace == token.namespace && $0.token.key == token.key
            && $0.token.draftGeneration == token.draftGeneration && $0.url == url }
        failedUploads.append(ComposerUploadFailure(token: token, name: url.lastPathComponent,
                                                  url: url,
                                                  detail: "\(url.lastPathComponent): \(detail)"))
    }
}

/// Web ghost icon button (paperclip): no fill until hovered or pressed.
private struct ComposerGhostStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { GhostBody(configuration: configuration) }
    private struct GhostBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var isEnabled
        @State private var hovering = false
        var body: some View {
            configuration.label
                .foregroundStyle(isEnabled ? CE.ink2 : CE.ink3.opacity(0.6))
                .background {
                    Circle().fill(Color.white.opacity(configuration.isPressed ? 0.12 : hovering && isEnabled ? 0.08 : 0))
                }
                .contentShape(Circle())
                .onHover { hovering = $0 }
        }
    }
}

/// Web primary 44pt round send button: violet gradient with rim and glow; a quiet ring when there is nothing to send.
private struct ComposerSendStyle: ButtonStyle {
    let active: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(active ? Color.white : CE.ink3)
            .frame(width: 44, height: 44)
            .background {
                if active {
                    Circle().fill(CE.primaryGradient).opacity(configuration.isPressed ? 0.8 : 1)
                        .overlay { GlassRim(shape: Circle()) }
                        .shadow(color: CE.violet.opacity(0.45), radius: 10, y: 4)
                } else {
                    Circle().fill(Color.white.opacity(0.07)).overlay { Circle().strokeBorder(CE.line) }
                }
            }
            .contentShape(Circle())
    }
}
