import SwiftUI
import ImageIO
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#endif
#if os(iOS)
import PhotosUI
import UIKit
import AVFoundation
#endif

/// A local acceptance, as distinct from an old/other-device `mine` row appearing in history.
struct ComposerAcceptedMessage {
    static let notification = Notification.Name("IAMCEO.composerAcceptedMessage")
    let namespace: String
    let projectID: String
    let targetMemberID: String?
    let messageID: String

    @MainActor func open(in router: Router) {
        router.memberID = nil
        router.openChat(targetMemberID)
        router.chatMessageID = messageID
    }
}

/// The one instruction surface (web Composer): a dark glass panel with a meta row (target chip, attachment chips,
/// hints), an error line, and the input row (paperclip, text, round send button).
/// Used docked under every destination (Mac, iPhone) and inline in 대화.
/// Drafts and attachments are keyed by project + target, so switching either never sends a draft to someone else.
struct ComposerBar: View {
    @Environment(AppStore.self) private var store
    @Environment(DraftStore.self) private var drafts
    @Environment(Router.self) private var router
    #if os(macOS)
    @Environment(MacAttachmentIntake.self) private var attachmentIntake
    #endif
    @Binding var target: String?
    var showsTargetPicker = true
    /// iPhone dock: the recipient chip appears only while typing, so the bar at rest is one row on every tab.
    var targetPickerOnFocus = false
    /// The placeholder names the lead ("총괄에게 지시나 질문") where no recipient chips are on screen.
    var namesLead = false
    /// iPhone keeps a composer on every tab: only the one on screen takes a "지시" focus request.
    var respondsToFocusRequests = true
    var autoFocus = false
    /// Called after the daemon accepted the message (saved). Delivery is shown in Chat, never here.
    var onSent: (() -> Void)? = nil
    var onOpenChat: (() -> Void)? = nil
    /// iPhone: a downward swipe on the composer. nil = lower the keyboard.
    var onSwipeDown: (() -> Void)? = nil
    @State private var importing = false
    @State private var importContext: ComposerUploadContext?
    #if os(iOS)
    @State private var choosingPhotos = false
    @State private var photoSelection: [PhotosPickerItem] = []
    @State private var photoContext: ComposerUploadContext?
    @State private var takingPhoto = false
    @State private var cameraContext: ComposerUploadContext?
    #endif
    /// Recipient of the last accepted send, shown for a few seconds.
    @State private var acceptedMessage: ComposerAcceptedMessage?
    @State private var sentTo: String?
    @State private var sentToken = UUID()
    @State private var dropTargeted = false
    /// Mac: the recipient list (web .cmp-menu) is open.
    @State private var showTargets = false
    #if os(macOS)
    @State private var focused = false
    @State private var attachmentReceiverID = UUID()
    #else
    @State private var focused = false
    /// The clipboard holds an image or a file (type check only; see ComposerPasteIntake).
    @State private var clipboardHasAttachment = false
    #endif

    private var key: String { DraftStore.key(project: store.selectedProjectID, target: target) }
    private var recipient: Member? { target.flatMap { id in store.members.first { $0.id == id } } }
    /// The target is no longer on the roster (closed, or reached through an old link). Never relabel it as the lead:
    /// the request would still carry the old id.
    private var missingTarget: Bool { target != nil && store.state != nil && recipient == nil }
    /// The project lead (총괄, or 본사 AI on HQ) receives messages with no explicit target.
    private var leadName: String { store.leadRankName }
    private var recipientName: String { missingTarget ? "명부에 없는 대상" : recipient?.name ?? leadName }
    private var sending: Bool { store.selectedProjectID.map { store.isSending(projectID: $0, targetMemberID: target) } ?? false }
    private var draftText: String { drafts.text(for: key) }
    private var files: [Attachment] { drafts.files(for: key) }
    private var pendingUploads: [ComposerUpload] { store.composerUploads.pending(for: key, drafts: drafts) }
    private var missingUploads: [DraftUploadFailure] { drafts.uploadFailures(for: key) }
    private var attempt: MessageSubmission? {
        Self.pendingAttempt(in: store, key: key)
    }
    @MainActor private static func pendingAttempt(in store: AppStore, key: String) -> MessageSubmission? {
        store.submissions?.messages(namespace: store.drafts.namespace).first {
            $0.draft.key == key && $0.status != .refused && $0.failureDisposition != .retained
                && $0.failureDisposition != .dismissed && $0.failureDisposition != .restored
                && ($0.status != .accepted || !$0.draftConsumed)
        }
    }
    private var failures: [MessageSubmission] {
        store.submissions?.failureNotices(namespace: drafts.namespace, key: key, drafts: drafts) ?? []
    }
    private var checkingAttempt: Bool {
        attempt?.status == .checking || attempt?.status == .accepted || failures.contains { $0.status == .checking }
    }
    private var editedAttempt: Bool {
        attempt.map {
            let expected = $0.restoredDraft ?? $0.draft
            return expected.revision != drafts.revision(for: key)
        } ?? false
    }
    private var text: Binding<String> {
        let draftKey = key
        let connection = drafts.connectionGeneration
        return Binding(get: { drafts.text(for: draftKey) }, set: {
            guard drafts.connectionGeneration == connection else { return }
            drafts.setText($0, for: draftKey)
        })
    }
    private var canAttach: Bool { ComposerAttachmentUploads.blockedReason(in: store, target: target) == nil && !missingTarget }
    private var canSend: Bool { Self.sendBlockReason(in: store, targetMemberID: target) == nil }

    /// Shared by the button, Return and native-editor regression tests. Read current store state
    /// at submission time rather than relying on an earlier SwiftUI render's enabled state.
    @MainActor static func sendBlockReason(in store: AppStore, targetMemberID: String?) -> String? {
        let drafts = store.drafts
        let key = DraftStore.key(project: store.selectedProjectID, target: targetMemberID)
        guard store.canWrite else { return store.writeBlockedReason ?? "최신 상태를 확인한 뒤 보내 주세요." }
        guard let project = store.selectedProjectID else { return "프로젝트를 고른 뒤 보내 주세요." }
        if store.isSending(projectID: project, targetMemberID: targetMemberID) { return "앞선 글을 보내는 중입니다. 끝난 뒤 다시 보내 주세요." }
        let attempt = pendingAttempt(in: store, key: key)
        let failures = store.submissions?.failureNotices(namespace: drafts.namespace, key: key, drafts: drafts) ?? []
        if attempt?.status == .checking || attempt?.status == .accepted || failures.contains(where: { $0.status == .checking }) {
            return "접수 확인 중입니다. 결과를 확인한 뒤 다시 보내 주세요."
        }
        if let attempt, (attempt.restoredDraft ?? attempt.draft).revision != drafts.revision(for: key) {
            return "이전 글의 접수 결과를 확인하고 편집한 글 사용을 눌러 주세요."
        }
        if !store.composerUploads.pending(for: key, drafts: drafts).isEmpty { return "첨부를 올리는 중입니다. 끝난 뒤 보내 주세요." }
        if !drafts.uploadFailures(for: key).isEmpty { return "올리지 못한 첨부를 확인하거나 빼고 보내 주세요." }
        if let error = drafts.persistenceError { return "초안을 저장하지 못했습니다: \(error)" }
        if let targetMemberID, !store.members.contains(where: { $0.id == targetMemberID }) { return "명부에서 빠진 대상입니다. 보낼 대상을 바꿔 주세요." }
        // A refused restoration is proven absent. A refreshed runner-down hint must not turn
        // Return into a no-op: the reachable server can give the new send its definitive result.
        let restoredRefusal = store.submissions?.messages(namespace: drafts.namespace).contains {
            $0.draft.key == key && $0.failureDisposition == .restored
                && ($0.status == .refused || $0.status == .notAccepted)
                && $0.restoredDraft.map(drafts.isCurrentGeneration) == true
        } == true
        if !store.uiCanWrite && !restoredRefusal { return store.writeBlockedReason ?? "프로젝트의 실행 연결을 확인해 주세요." }
        if drafts.text(for: key).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && drafts.files(for: key).isEmpty {
            return "보낼 글이나 첨부를 넣어 주세요."
        }
        return nil
    }

    @MainActor @discardableResult static func submit(in store: AppStore, targetMemberID: String?, contextFileID: String? = nil) async -> Bool {
        let key = DraftStore.key(project: store.selectedProjectID, target: targetMemberID)
        store.drafts.commitEditors(for: key)
        if let reason = sendBlockReason(in: store, targetMemberID: targetMemberID) {
            store.explainMessageSendBlock(reason, targetMemberID: targetMemberID)
            return false
        }
        let snapshot = store.drafts.snapshot(for: key)
        return await store.sendMessage(text: snapshot.text, targetMemberID: targetMemberID,
                                       attachmentIDs: snapshot.attachments.map(\.id), contextFileID: contextFileID)
    }

    /// Web placeholders.
    private var placeholder: String {
        if missingTarget { return "명부에 없는 대상에게는 보낼 수 없습니다" }
        if let recipient { return "\(recipient.name)에게 직접 지시" }
        if store.state?.project.isHq == true { return "본사 AI에게 — 새 프로젝트 만들기 등" }
        return namesLead ? "\(leadName)에게 지시나 질문" : "지시나 질문"
    }

    private var blockedReason: (text: String, tone: Tone)? {
        guard !canSend, let reason = store.writeBlockedReason else { return nil }
        return (friendlyError(reason), store.isDemo ? .dim : .attention)
    }

    @State private var omittedContextFileID: String?
    private var contextFile: FileDoc? {
        guard let id = FileLinks.viewedFileID(router: router), id != omittedContextFileID else { return nil }
        return store.files.first { $0.id == id && $0.projectId == store.selectedProjectID }
    }

    private var hasMetaRow: Bool {
        contextFile != nil || targetPickerShown || fixedRecipientShown || !files.isEmpty || !pendingUploads.isEmpty || dropTargeted || sentTo != nil
            || quietBlock != nil || (isMac && focused) || !missingUploads.isEmpty
    }

    private var hasDraftContent: Bool {
        !draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty || !pendingUploads.isEmpty
    }

    /// The placeholder names the recipient only while the field is empty: once there is a draft the chip stays,
    /// focused or not, so a draft left on 홈 never hides who it goes to.
    private var targetPickerShown: Bool { showsTargetPicker || (targetPickerOnFocus && (focused || hasDraftContent)) }

    /// A dock whose recipient the screen fixes (a worker's page on 팀) has no chip to show; it names the recipient
    /// in words once a draft hides the placeholder.
    private var fixedRecipientShown: Bool { namesLead && !targetPickerShown && hasDraftContent }

    /// Why sending is off (sample, offline, runner connection), shown quietly beside the target chip. Errors and a
    /// removed target take their own line instead.
    private var quietBlock: (text: String, tone: Tone)? {
        blockedReason
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
        // web .cmp__panel: meta row, error line and input row stack with no gap of their own.
        return VStack(alignment: .leading, spacing: 0) {
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
        #if os(iOS)
        // A downward swipe anywhere on the panel (also over the text field) puts the composer away: the keyboard goes
        // down. Simultaneous, so typing, selecting and tapping keep working.
        .simultaneousGesture(DragGesture(minimumDistance: 12).onEnded { value in
            guard value.translation.height > 28, value.translation.height > abs(value.translation.width) * 1.2 else { return }
            focused = false
            onSwipeDown?()
        })
        #endif
        #if os(iOS)
        .dropDestination(for: URL.self) { urls, _ in
            let local = urls.filter(\.isFileURL)
            guard !local.isEmpty, let context = uploadContext() else { return false }
            store.composerUploads.upload(local, context: context, store: store)
            return true
        } isTargeted: { dropTargeted = $0 && canAttach }
        #endif
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls):
                if let context = importContext { store.composerUploads.upload(urls, context: context, store: store) }
                else if !urls.isEmpty { recordUploadError("파일을 받을 초안을 확인하지 못했습니다") }
            case .failure(let error): recordUploadError(friendlyLoadError(error, what: "첨부", verb: "받지"), context: importContext)
            }
        }
        #if os(iOS)
        .photosPicker(isPresented: $choosingPhotos, selection: $photoSelection, maxSelectionCount: 10,
                      selectionBehavior: .ordered, matching: .any(of: [.images, .videos]),
                      preferredItemEncoding: .current)
        .onChange(of: photoSelection) { _, items in
            guard !items.isEmpty else { return }
            photoSelection = []
            guard let context = photoContext else { recordUploadError("사진을 받을 초안을 확인하지 못했습니다"); return }
            loadPhotos(items, context: context)
        }
        .fullScreenCover(isPresented: $takingPhoto) {
            ComposerCameraPicker { result in
                takingPhoto = false
                guard let result, let context = cameraContext else { return }
                loadCameraPhoto(result, context: context)
            }
            .ignoresSafeArea()
        }
        #endif
        #if os(iOS)
        .onAppear { clipboardHasAttachment = ComposerPasteIntake.clipboardHasAttachment }
        .onReceive(NotificationCenter.default.publisher(for: UIPasteboard.changedNotification)) { _ in
            withAnimation(.easeOut(duration: 0.15)) { clipboardHasAttachment = ComposerPasteIntake.clipboardHasAttachment }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            clipboardHasAttachment = ComposerPasteIntake.clipboardHasAttachment
        }
        #endif
        .onAppear {
            if autoFocus { focusSoon() }
            #if os(macOS)
            installAttachmentReceiver()
            #endif
        }
        #if os(macOS)
        .onDisappear { attachmentIntake.remove(owner: attachmentReceiverID) }
        .onChange(of: key) { _, _ in installAttachmentReceiver() }
        .onChange(of: drafts.connectionGeneration) { _, _ in installAttachmentReceiver() }
        #endif
        .onChange(of: router.focusComposer) { _, _ in if respondsToFocusRequests { focusSoon() } }
        .onChange(of: key) { _, _ in sentTo = nil }
        .onChange(of: store.selectedProjectID) { _, _ in showTargets = false; omittedContextFileID = nil }
        .onChange(of: FileLinks.viewedFileID(router: router)) { _, _ in omittedContextFileID = nil }
        .onChange(of: drafts.connectionGeneration) { _, _ in sentTo = nil }
        .onChange(of: draftText) { old, new in
            if new.count > old.count { sentTo = nil }
        }
        .onChange(of: canSend) { _, ready in
            if ready { store.clearBlockedSendNotice(targetMemberID: target) }
        }
    }

    // MARK: Meta row

    private var metaRow: some View {
        HStack(spacing: 6) {
            if targetPickerShown { targetChip }
            if let contextFile { ViewedFileContextChip(file: contextFile) { omittedContextFileID = contextFile.id } }
            if fixedRecipientShown {
                Text("\(recipientName)에게").font(hintFont.weight(.semibold)).foregroundStyle(CE.ink2)
                    .lineLimit(1).padding(.leading, 6)
                    .accessibilityLabel("보낼 대상: \(recipientName)")
            }
            if !files.isEmpty || !pendingUploads.isEmpty || !missingUploads.isEmpty {
                // Many attachments scroll inside the row instead of growing the panel.
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(files) { fileChip($0) }
                        ForEach(pendingUploads) { uploadingChip($0) }
                        ForEach(missingUploads) { failedUploadChip($0) }
                    }
                }
                .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            }
            if let block = quietBlock {
                HStack(spacing: 5) {
                    Image(systemName: store.isDemo ? "eye" : "wifi.exclamationmark").font(.system(size: 10.5, weight: .semibold))
                    Text(block.text).lineLimit(1).truncationMode(.tail)
                }
                .font(hintFont).foregroundStyle(block.tone.color)
                .padding(.leading, 4)
                .help(block.text)
                .accessibilityElement(children: .combine)
            } else if dropTargeted {
                Text("놓으면 첨부됩니다").font(hintFont).foregroundStyle(CE.ink2).lineLimit(1).layoutPriority(1)
            } else if let sentTo {
                sentHint(sentTo).layoutPriority(1)
            }
            if files.isEmpty && pendingUploads.isEmpty { Spacer(minLength: 0) }
            #if os(macOS)
            if focused && quietBlock == nil && sentTo == nil {
                Text("↩ 보내기 · ⇧↩ 줄바꿈").font(hintFont).foregroundStyle(CE.ink3).lineLimit(1)
            }
            #endif
        }
        // web .cmp__meta: padding 2 4, so chips sit 10pt in from the panel edge in a 32pt row.
        .padding(.horizontal, 4).padding(.vertical, 2)
        .frame(minHeight: 32)
    }

    /// web .cmp__hint: 12.5px.
    private var hintFont: Font { CEFont.meta }

    /// The recipients of the target list (web .cmp-menu): the lead first ("기본"), then every worker with
    /// "@handle · role" and its status.
    private var targetEntries: [ComposerTargetEntry] {
        let lead = store.members.first { $0.kind == "conductor" || $0.kind == "root" }
        let workers = store.members.filter { $0.kind == "worker" }
        return [ComposerTargetEntry(memberID: nil, name: leadName, sub: "기본", status: lead?.status)]
            + workers.map { member in
                let sub = [member.handle.isEmpty ? nil : "@\(member.handle)", member.role.isEmpty ? nil : member.role]
                    .compactMap { $0 }.joined(separator: " · ")
                return ComposerTargetEntry(memberID: member.id, name: member.name, sub: sub, status: member.status)
            }
    }

    /// Web target chip: "총괄"/"본사 AI" quiet; a worker is "@이름" in white on violet. Mac opens the web's recipient
    /// list (name, @handle · role, status); iPhone keeps the system menu with the same lines.
    @ViewBuilder private var targetChip: some View {
        let direct = recipient != nil && !missingTarget
        let label = missingTarget ? "명부에 없는 대상" : recipient.map { "@\($0.name)" } ?? leadName
        #if os(macOS)
        Button { showTargets.toggle() } label: {
            HStack(spacing: 5) {
                if missingTarget { StatusDot(tone: .danger, size: 6) }
                Text(label).font(CEFont.meta.weight(.semibold)).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 8.5, weight: .bold))
            }
        }
        .buttonStyle(TargetChipStyle(direct: direct, missing: missingTarget))
        .fixedSize()
        .popover(isPresented: $showTargets, arrowEdge: .top) {
            ComposerTargetMenu(entries: targetEntries, current: missingTarget ? nil : target) { picked in
                target = picked
                showTargets = false
                focusSoon()
            }
        }
        .help("보낼 대상 바꾸기")
        .accessibilityLabel("보낼 대상: \(recipientName). 눌러서 바꾸기")
        #else
        Menu {
            ForEach(Array(targetEntries.enumerated()), id: \.element.id) { position, entry in
                if position == 1 { Divider() }
                Button { target = entry.memberID } label: {
                    Label {
                        Text(entry.name)
                        Text(([entry.sub.isEmpty ? nil : entry.sub] + [entry.status.map { MemberStatusInfo($0).label }]).compactMap { $0 }.joined(separator: " · "))
                    } icon: {
                        if !missingTarget && target == entry.memberID { Image(systemName: "checkmark") }
                    }
                }
            }
        } label: {
            HStack(spacing: 5) {
                if missingTarget { StatusDot(tone: .danger, size: 6) }
                Text(label).font(CEFont.meta.weight(.semibold)).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 8.5, weight: .bold))
            }
            .foregroundStyle(direct ? Color.white : missingTarget ? CE.danger : CE.ink2)
            .padding(.horizontal, 10).frame(height: 28)
            .background(direct ? CE.violet.opacity(0.42) : Color.white.opacity(0.08), in: Capsule())
            .overlay { Capsule().strokeBorder(direct ? CE.violet.opacity(0.95) : missingTarget ? CE.danger.opacity(0.6) : Color.white.opacity(0.1)) }
            .frame(maxWidth: 220)
            .frame(height: 44)
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("보낼 대상 바꾸기")
        .accessibilityLabel("보낼 대상: \(recipientName). 눌러서 바꾸기")
        #endif
    }

    /// web .cmp-chip--file: 28 tall, 12.5/500, an image shows a 20pt round thumbnail at −5, max 260 wide, and the
    /// 28pt round × sits flush at the trailing end.
    private func fileChip(_ file: Attachment) -> some View {
        HStack(spacing: 6) {
            if file.isImage {
                ComposerChipThumb(file: file).padding(.leading, -5)
            } else {
                Image(systemName: "doc").font(.system(size: 10.5, weight: .semibold)).foregroundStyle(CE.ink2)
            }
            Text(file.name).lineLimit(1).truncationMode(.middle).frame(maxWidth: 200, alignment: .leading)
            Button { drafts.removeFile(file.id, for: key) } label: {
                Image(systemName: "xmark").font(.system(size: 8.5, weight: .bold))
            }
            .buttonStyle(ChipRemoveStyle())
            .accessibilityLabel("\(file.name) 빼기")
        }
        .font(CEFont.meta.weight(.medium))
        .foregroundStyle(CE.ink)
        .padding(.leading, 9).frame(height: 28)
        .background(Color.white.opacity(0.08), in: Capsule())
        .overlay { Capsule().strokeBorder(Color.white.opacity(0.1)) }
        .help(file.name)
    }

    private func uploadingChip(_ upload: ComposerUpload) -> some View {
        HStack(spacing: 6) {
            ProgressView().controlSize(.mini)
            Text(upload.name).lineLimit(1).truncationMode(.middle).frame(maxWidth: 160, alignment: .leading)
            // web .cmp-chip__state: regular weight, ink-2.
            Text(upload.waiting ? "연결 뒤 올림" : upload.progress.map { "\(Int($0 * 100))%" } ?? "준비 중")
                .fontWeight(.regular).foregroundStyle(CE.ink2)
            Button { store.composerUploads.cancel(upload.id, drafts: drafts) } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(ChipRemoveStyle()).accessibilityLabel("\(upload.name) 올리기 취소")
        }
        .font(CEFont.meta.weight(.medium))
        .foregroundStyle(CE.ink)
        .padding(.horizontal, 9).frame(height: 28)
        .background(Color.white.opacity(0.08), in: Capsule())
        .overlay { Capsule().strokeBorder(Color.white.opacity(0.1)) }
        .accessibilityElement(children: .combine)
    }

    private func failedUploadChip(_ failure: DraftUploadFailure) -> some View {
        HStack(spacing: 6) {
            Text(failure.name).lineLimit(1).truncationMode(.middle)
            Text("실패").foregroundStyle(CE.danger)
            if store.composerUploads.canRetry(failure.id, store: store) {
                Button("다시 올리기") { store.composerUploads.retry(failure.id, store: store) }
                    .buttonStyle(.plain).foregroundStyle(CE.accent)
            }
            Button { store.composerUploads.cancel(failure.id, drafts: drafts) } label: { Image(systemName: "xmark") }
                .buttonStyle(ChipRemoveStyle()).accessibilityLabel("\(failure.name) 빼기")
        }
        .font(CEFont.meta).padding(.leading, 9).frame(height: 28)
        .background(Color.white.opacity(0.08), in: Capsule())
        .help(friendlyLoadError(APIError(status: 0, message: failure.detail), what: "첨부", verb: "올리지"))
    }

    /// "{대상}에게 보냈습니다 · 대화에서 보기". Sent = the server accepted it; whether the CLI received it is the
    /// delivery state in 대화 (전달 대기 · 받음), never claimed here.
    private func sentHint(_ name: String) -> some View {
        HStack(spacing: 4) {
            Text("\(name)에게 보냈습니다").lineLimit(1).truncationMode(.middle)
            if onOpenChat != nil, let acceptedMessage {
                Text("·").foregroundStyle(CE.ink3)
                Button {
                    acceptedMessage.open(in: router)
                } label: {
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
        ForEach(failures) { failure in failureNotice(failure) }
        // 보낼 수 없던 사정을 알린 안내는 사정이 풀리면 더 보이지 않는다.
        if let reason = store.messageSendNotice(targetMemberID: target),
           !(canSend && store.messageSendNoticeEndsWithBlock(targetMemberID: target)) {
            notice(reason, icon: "exclamationmark.circle", color: CE.attention)
        }
        if checkingAttempt {
            notice("접수 확인 중 · 글과 첨부는 보관했습니다", icon: "clock", color: CE.attention,
                   actionTitle: "접수 확인", action: { Task { await store.recoverWrites() } })
        } else if let error = drafts.persistenceError {
            notice(friendlyLoadError(APIError(status: 0, message: error), what: "초안", verb: "저장하지"), icon: "exclamationmark.circle", color: CE.danger)
        } else if pendingUploads.isEmpty, let missing = missingUploads.first {
            notice("첨부 \(missingUploads.count)개를 확인하지 못했습니다: \(missing.name): \(friendlyLoadError(APIError(status: 0, message: missing.detail), what: "첨부", verb: "올리지"))", icon: "exclamationmark.circle", color: CE.danger,
                   actionTitle: "빠진 첨부 빼기", action: {
                       for failure in missingUploads { store.composerUploads.cancel(failure.id, drafts: drafts) }
                       drafts.dismissUploadFailures(for: key)
                   })
        } else if let attempt, editedAttempt {
            notice("이전 글은 접수되지 않았습니다. 편집한 글과 첨부는 남아 있습니다.", icon: "clock", color: CE.attention,
                   actionTitle: "편집한 글 사용", action: {
                       guard attempt.status == .notAccepted || attempt.status == .prepared else { return }
                       do { try store.submissions?.refuseMessage(id: attempt.id) }
                       catch { store.errorMessage = friendlyLoadError(error, what: "이전 전송", verb: "정리하지") }
                   })
        } else if let intakeNotice = store.composerUploads.notice {
            notice(intakeNotice, icon: "paperclip", color: CE.attention)
        } else if missingTarget {
            notice("명부에서 빠진 대상입니다. 쓰던 글은 그대로 있습니다.", icon: "person.crop.circle.badge.xmark", color: CE.attention,
                   actionTitle: "\(leadName)에게 보내기로 바꾸기", action: { target = nil })
        }
    }

    /// A refused send. Restored into an empty composer: one red line, like the other send errors.
    /// Kept beside newer text: what was not sent, why, and three actions on their own row.
    private func failureNotice(_ failure: MessageSubmission) -> some View {
        let retained = failure.failureDisposition == .retained
        let reason = friendlyError(failure.failureReason ?? "서버가 접수하지 않았습니다")
        return HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "exclamationmark.circle")
                .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(CE.danger)
            VStack(alignment: .leading, spacing: 3) {
                if retained {
                    Text("보내지 못한 글 · \(failure.failurePreview)")
                        .fontWeight(.semibold).foregroundStyle(CE.ink)
                        .lineLimit(1).truncationMode(.tail)
                    Text(reason).foregroundStyle(CE.ink2)
                        .lineLimit(isMac ? 1 : 2).truncationMode(.tail)
                    HStack(spacing: 16) {
                        failureAction("다시 보내기", disabled: !store.canWrite || sending || checkingAttempt || missingTarget) {
                            Task { await store.retryFailedMessage(id: failure.id) }
                        }
                        failureAction("입력칸에 넣기", disabled: sending || checkingAttempt) {
                            do { try store.submissions?.insertFailedMessage(id: failure.id, drafts: drafts) }
                            catch { store.errorMessage = friendlyLoadError(error, what: "글", verb: "되돌리지") }
                        }
                        failureAction("버리기", color: CE.ink2, disabled: sending || checkingAttempt) {
                            do { try store.submissions?.dismissMessageFailure(id: failure.id) }
                            catch { store.errorMessage = friendlyLoadError(error, what: "글", verb: "정리하지") }
                        }
                    }
                    .padding(.top, 1)
                } else {
                    Text("보내지 못했습니다: \(reason)"
                         + (failure.failureDisposition == .restored ? (reason.hasSuffix(".") ? " " : ". ") + "글은 입력칸에 되돌려 두었습니다" : ""))
                        .foregroundStyle(CE.danger)
                        .lineLimit(isMac ? 1 : 3).truncationMode(.tail)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(CEFont.secondary)
        .lineSpacing(CELeading.spacing(13, 1.4))
        .padding(.horizontal, 8).padding(.vertical, 4)
        .help(retained ? "\(failure.draft.text)\n\n\(reason)" : failure.failureText)
    }

    /// Same weight and tint as the single action of `notice`; 44pt tall on iPhone.
    private func failureAction(_ title: String, color: Color = CE.accent, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).fontWeight(.semibold).foregroundStyle(color)
                .frame(minHeight: isMac ? nil : 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .disabled(disabled)
        .opacity(disabled ? 0.45 : 1)
    }

    /// One line on Mac (full text in the tooltip): this panel sits in a bar outside any scroll view.
    /// web .cmp__error: padding 4 8, 13px at line-height 1.4.
    private func notice(_ text: String, icon: String, color: Color, actionTitle: String? = nil, action: (() -> Void)? = nil) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: icon).font(.system(size: 11.5, weight: .semibold))
            Text(text).lineLimit(isMac ? 1 : 3).truncationMode(.tail)
                .lineSpacing(CELeading.spacing(13, 1.4))
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
        .padding(.horizontal, 8).padding(.vertical, 4)
        .help(text)
        .accessibilityElement(children: .combine)
    }

    // MARK: Input row

    private var inputRow: some View {
        let draftKey = key
        return HStack(alignment: .bottom, spacing: 2) {
            attachmentButton
            #if os(iOS)
            // Only while the clipboard holds an image or a file: a standing grey paste button beside the paperclip
            // was clutter on every tab. A small round one appears when pasting would attach something.
            if clipboardHasAttachment {
                PasteButton(supportedContentTypes: ComposerPasteIntake.contentTypes) { providers in
                    guard let context = uploadContext() else { return }
                    ComposerPasteIntake.receive(providers, context: context, store: store)
                }
                .labelStyle(.iconOnly)
                .buttonBorderShape(.circle)
                .tint(CE.violet)
                .controlSize(.small)
                .frame(width: 44, height: 44)
                .disabled(!canAttach)
                .transition(.scale.combined(with: .opacity))
                .accessibilityLabel("복사한 이미지나 파일 붙여넣기")
            }
            #endif

            #if os(macOS)
            MacComposerTextView(text: text, focused: Binding(get: { focused }, set: { focused = $0 }),
                                placeholder: "\(recipientName)에게 보낼 글", intake: attachmentIntake,
                                canReceive: { macAttachmentPolicy.canAccept && attachmentIntake.receive != nil && store.selectedProjectID != nil },
                                receive: { attachmentIntake.accept($0, policy: macAttachmentPolicy) },
                                submit: { Task { await send() } },
                                rejectionReason: { macAttachmentPolicy.reason ?? "입력칸을 준비 중이라 첨부하지 못했습니다" },
                                textRevision: { drafts.revision(for: draftKey) }, drafts: drafts, draftKey: draftKey)
                .id([drafts.namespace, draftKey])
                .overlay(alignment: .topLeading) {
                    if draftText.isEmpty {
                        Text(placeholder).font(.system(size: 15)).foregroundStyle(CE.ink2)
                            .allowsHitTesting(false)
                    }
                }
                .padding(.horizontal, 6).padding(.vertical, 11)
                .frame(maxWidth: .infinity, minHeight: 44)
                .disabled(store.isDemo)
            #else
            IOSComposerTextView(text: text, focused: Binding(get: { focused }, set: { focused = $0 }),
                                placeholder: "\(recipientName)에게 보낼 글",
                                textRevision: { drafts.revision(for: draftKey) }, drafts: drafts, draftKey: draftKey)
                .id([drafts.namespace, draftKey])
                .overlay(alignment: .topLeading) {
                    if draftText.isEmpty {
                        Text(placeholder).font(CEFont.body).foregroundStyle(CE.ink2).allowsHitTesting(false)
                    }
                }
                .padding(.horizontal, 6).padding(.vertical, 11)
                .frame(minHeight: 44)
                .disabled(store.isDemo && !LaunchOptions.reviewTyping)
            #endif

            Button { Task { await send() } } label: {
                Group {
                    if sending { ProgressView().controlSize(.small).tint(.white) }
                    else { Image(systemName: "arrow.up").font(.system(size: 16, weight: .bold)) }
                }
            }
            .buttonStyle(ComposerSendStyle(active: canSend || sending))
            .disabled(!canSend)
            .help(isMac ? "보내기 (↩) · 줄바꿈 ⇧↩" : "보내기")
            .accessibilityLabel("\(recipientName)에게 보내기")
        }
    }

    // MARK: Actions

    private var attachmentIcon: some View {
        Image(systemName: "paperclip").font(.system(size: 17)).frame(width: 44, height: 44)
    }

    @ViewBuilder private var attachmentButton: some View {
        #if os(iOS)
        Menu {
            Button {
                photoContext = uploadContext()
                choosingPhotos = photoContext != nil
            } label: { Label("사진 보관함", systemImage: "photo.on.rectangle") }
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button { openCamera() } label: { Label("사진 찍기", systemImage: "camera") }
            }
            Button { importContext = uploadContext(); importing = importContext != nil } label: {
                Label("파일", systemImage: "folder")
            }
        } label: { attachmentIcon }
        .menuStyle(.button)
        .menuOrder(.fixed)
        .menuIndicator(.hidden)
        .buttonStyle(ComposerGhostStyle())
        .disabled(!canAttach)
        .help("첨부 (50MB까지)")
        .accessibilityLabel("첨부")
        #else
        Button { importContext = uploadContext(); importing = importContext != nil } label: { attachmentIcon }
            .buttonStyle(ComposerGhostStyle())
            .disabled(!canAttach)
            .help("첨부 (50MB까지)")
            .accessibilityLabel("첨부")
        #endif
    }

    #if os(iOS)
    private func openCamera() {
        guard let context = uploadContext() else { return }
        Task {
            let allowed = await AVCaptureDevice.requestAccess(for: .video)
            guard allowed else {
                recordUploadError("설정에서 카메라 접근을 허용해 주세요", context: context)
                return
            }
            guard uploadIsCurrent(context) else { return }
            cameraContext = context
            takingPhoto = true
        }
    }

    private func loadPhotos(_ items: [PhotosPickerItem], context: ComposerUploadContext) {
        let date = Date()
        let names = items.enumerated().map { index, item in
            PhotoAttachment.filename(date: date, index: index + 1, extension: item.supportedContentTypes.contains {
                $0.conforms(to: .movie)
            } ? "mov" : "jpg", video: item.supportedContentTypes.contains { $0.conforms(to: .movie) })
        }
        loadMedia(names: names, context: context) { index in
            guard let media = try await items[index].loadTransferable(type: ComposerPickedMedia.self) else {
                throw PhotoAttachmentError.unavailable
            }
            defer { media.file.cleanup() }
            return try await Task.detached(priority: .userInitiated) {
                [try PhotoAttachment.prepare(source: media.file.url, video: media.video, date: date, index: index + 1)]
            }.value
        }
    }

    private func loadCameraPhoto(_ result: Result<Data, Error>, context: ComposerUploadContext) {
        let date = Date()
        loadMedia(names: [PhotoAttachment.filename(date: date, index: 1, extension: "jpg")], context: context) { _ in
            let data = try result.get()
            return try await Task.detached(priority: .userInitiated) {
                let original = try PhotoAttachmentFile.write(data, filename: "capture.jpg")
                defer { original.cleanup() }
                return [try PhotoAttachment.prepare(source: original.url, video: false, date: date, index: 1, forceJPEG: true)]
            }.value
        }
    }

    #endif

    private func loadMedia(names: [String], context: ComposerUploadContext,
                           load: @escaping @MainActor (Int) async throws -> [PhotoAttachmentFile]) {
        store.composerUploads.loadMedia(names: names, context: context, store: store, load: load)
    }

    private func recordUploadError(_ detail: String, context: ComposerUploadContext? = nil) {
        store.composerUploads.reportRejection(detail)
    }

    #if os(macOS)
    private var macAttachmentPolicy: MacAttachmentPolicy {
        MacAttachmentPolicy(archived: store.isArchive || store.state?.project.archived == true,
                            demo: store.isDemo, connected: store.connectionStatus == .connected,
                            writable: canAttach && store.selectedProjectID != nil,
                            missingTarget: missingTarget, composerCovered: router.memberID != nil)
    }

    private func installAttachmentReceiver() {
        let uploads = store.composerUploads
        attachmentIntake.install(owner: attachmentReceiverID, canReceive: { uploadContext() != nil }, receive: receiveMacAttachments) { detail in
            uploads.reportRejection(detail)
        }
    }

    private func receiveMacAttachments(_ items: [MacAttachmentItem]) -> Bool {
        guard router.memberID == nil else {
            recordUploadError("구성원 상세를 닫은 뒤 첨부해 주세요")
            return false
        }
        guard let context = uploadContext() else { return false }
        return store.composerUploads.receive(items, context: context, store: store)
    }
    #endif

    /// Focus now, and once more after a sheet that asked for it (member detail on Mac) has finished closing.
    private func focusSoon() {
        focused = true
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(400))
            focused = true
        }
    }

    private func send() async {
        drafts.commitEditors(for: key)
        let snapshot = drafts.snapshot(for: key)
        let connection = drafts.connectionGeneration
        let project = store.selectedProjectID
        let sendingTarget = target
        let name = recipientName
        sentTo = nil
        acceptedMessage = nil
        let ok = await Self.submit(in: store, targetMemberID: sendingTarget, contextFileID: contextFile?.id)
        guard connection == drafts.connectionGeneration, drafts.namespace == snapshot.namespace,
              project == store.selectedProjectID, key == snapshot.key else { return }
        guard ok else { return }
        // The submitted draft was detached before POST. Success leaves the next draft untouched.
        if let accepted = store.submissions?.messages(namespace: snapshot.namespace).first(where: {
            let sentDraft = $0.handoffDraft ?? $0.draft
            return sentDraft.key == snapshot.key && sentDraft.generation == snapshot.generation
                && sentDraft.revision == snapshot.revision && $0.status == .accepted
        }), let project {
            let message = ComposerAcceptedMessage(namespace: snapshot.namespace, projectID: project,
                                                  targetMemberID: sendingTarget, messageID: accepted.id)
            acceptedMessage = message
            NotificationCenter.default.post(name: ComposerAcceptedMessage.notification, object: message)
        }
        let token = UUID()
        sentToken = token
        sentTo = name
        onSent?()
        try? await Task.sleep(for: .seconds(5))
        if sentToken == token { sentTo = nil }
    }

    private func uploadContext() -> ComposerUploadContext? {
        if let reason = ComposerAttachmentUploads.blockedReason(in: store, target: target) {
            recordUploadError(reason)
            return nil
        }
        guard let project = store.selectedProjectID else {
            recordUploadError("프로젝트를 고른 뒤 첨부해 주세요")
            return nil
        }
        return ComposerUploadContext(projectID: project, targetMemberID: target, token: drafts.uploadToken(for: key))
    }

    private func uploadIsCurrent(_ context: ComposerUploadContext) -> Bool {
        if let reason = context.invalidationReason(in: store) {
            recordUploadError(reason, context: context)
            return false
        }
        return true
    }

}

#if os(iOS)
/// UIKit owns IME and selection. Only a genuinely different external value moves the caret.
struct IOSComposerTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    let placeholder: String
    let textRevision: () -> Int
    var drafts: DraftStore? = nil
    var draftKey: String? = nil

    /// Web .cmp__input: 15px text with 22pt lines (4pt extra leading).
    static func attributes(_ font: UIFont?) -> [NSAttributedString.Key: Any] {
        let style = NSMutableParagraphStyle()
        style.lineSpacing = 4
        return [.font: font ?? UIFont.preferredFont(forTextStyle: .subheadline), .foregroundColor: UIColor(CE.ink), .paragraphStyle: style]
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> UITextView {
        let view = Editor()
        view.textChanged = { [weak coordinator = context.coordinator, weak view] in
            guard let view else { return }
            coordinator?.textViewDidChange(view)
        }
        view.backgroundColor = .clear
        // Same size as the placeholder and the former TextField (CEFont.body = .subheadline on iOS).
        view.font = .preferredFont(forTextStyle: .subheadline)
        view.adjustsFontForContentSizeCategory = true
        view.textColor = UIColor(CE.ink)
        view.tintColor = UIColor(CE.accent)
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.typingAttributes = Self.attributes(view.font)
        view.delegate = context.coordinator
        context.coordinator.connect(view)
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.connect(view)
        view.isEditable = context.environment.isEnabled
        view.isSelectable = context.environment.isEnabled
        view.accessibilityLabel = placeholder
        context.coordinator.synchronize(view, text: text, revision: textRevision())
        if focused, !view.isFirstResponder {
            DispatchQueue.main.async { [weak view, weak coordinator = context.coordinator] in
                guard coordinator?.parent.focused == true else { return }
                view?.becomeFirstResponder()
            }
        } else if !focused, view.isFirstResponder { view.resignFirstResponder() }
    }
    static func dismantleUIView(_ view: UITextView, coordinator: Coordinator) {
        coordinator.parent.drafts?.unregisterEditor(id: coordinator.editorID)
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let proposedWidth = proposal.width ?? 300
        let width = proposedWidth.isFinite ? max(1, proposedWidth) : 300
        let height = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        return CGSize(width: width, height: min((uiView.font?.lineHeight ?? 22) * 7 + 24, max(22, height)))
    }
    @MainActor final class Coordinator: NSObject, UITextViewDelegate {
        let editorID = UUID()
        var parent: IOSComposerTextView
        private var lastRevision: Int?
        private var lastObservedText: String?
        init(_ parent: IOSComposerTextView) { self.parent = parent }
        func connect(_ view: UITextView) {
            guard let drafts = parent.drafts, let key = parent.draftKey else { return }
            drafts.registerEditor(id: editorID, key: key, canRestore: { [weak view] in
                guard let view else { return true }
                return view.text.isEmpty && view.markedTextRange == nil && (view as? Editor)?.isHandlingInput != true
            }, commit: { [weak self, weak view] in
                guard let view else { return }
                view.unmarkText()
                self?.textViewDidChange(view)
            }, synchronize: { [weak self, weak view] snapshot in
                guard let view else { return }
                self?.synchronize(view, text: snapshot.text, revision: snapshot.revision)
            }, moveCaretToEnd: { [weak view] in
                guard let view else { return }
                view.selectedRange = NSRange(location: view.text.utf16.count, length: 0)
            })
        }
        func synchronize(_ view: UITextView, text: String, revision: Int) {
            guard view.markedTextRange == nil, (view as? Editor)?.isHandlingInput != true else { return }
            if let lastRevision, revision <= lastRevision { return }
            lastRevision = revision
            lastObservedText = text
            guard !view.text.utf8.elementsEqual(text.utf8) else { return }
            // Plain `text =` drops the paragraph style, so restored drafts would lose the 4pt line spacing.
            let attributes = IOSComposerTextView.attributes(view.font)
            view.attributedText = NSAttributedString(string: text, attributes: attributes)
            view.typingAttributes = attributes
            view.selectedRange = NSRange(location: text.utf16.count, length: 0)
            view.undoManager?.removeAllActions()
        }
        func textViewDidChange(_ view: UITextView) {
            guard (view as? Editor)?.isHandlingInput != true else { return }
            let revision = parent.textRevision()
            if let lastRevision, revision > lastRevision, !parent.text.utf8.elementsEqual(view.text.utf8),
               lastObservedText.map({ parent.text.utf8.elementsEqual($0.utf8) }) != true {
                synchronize(view, text: parent.text, revision: revision)
                return
            }
            if !parent.text.utf8.elementsEqual(view.text.utf8) { parent.text = view.text }
            lastObservedText = view.text
            lastRevision = max(lastRevision ?? 0, parent.textRevision())
        }
        func textViewDidBeginEditing(_ view: UITextView) { parent.focused = true }
        func textViewDidEndEditing(_ view: UITextView) { parent.focused = false }
    }
    final class Editor: UITextView {
        var textChanged: (() -> Void)?
        private var inputDepth = 0
        var isHandlingInput: Bool { inputDepth > 0 }
        private func finishInput() {
            inputDepth -= 1
            if inputDepth == 0 { textChanged?() }
        }
        override func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
            inputDepth += 1
            defer { finishInput() }
            super.setMarkedText(markedText, selectedRange: selectedRange)
        }
        override func insertText(_ text: String) {
            inputDepth += 1
            defer { finishInput() }
            super.insertText(text)
        }
        override func unmarkText() {
            inputDepth += 1
            defer { finishInput() }
            super.unmarkText()
        }
    }
}
#endif

/// Web ghost icon button (paperclip, .gbtn--ghost): ink-2 and no fill; ink-1 on white .07 when hovered.
private struct ComposerGhostStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { GhostBody(configuration: configuration) }
    private struct GhostBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var isEnabled
        @State private var hovering = false
        var body: some View {
            let lit = isEnabled && (hovering || configuration.isPressed)
            configuration.label
                .foregroundStyle(!isEnabled ? CE.ink3.opacity(0.6) : lit ? CE.ink : CE.ink2)
                .background {
                    Circle().fill(Color.white.opacity(!isEnabled ? 0 : configuration.isPressed ? 0.11 : hovering ? 0.07 : 0))
                }
                .animation(.linear(duration: 0.16), value: lit)
                .contentShape(Circle())
                .onHover { hovering = $0 }
        }
    }
}

/// Web primary 44pt round send button (.gbtn--primary): violet gradient, a glossy top half, a lilac glow along the
/// bottom, a deep violet shadow and a dark arrow shadow; hover brightens, press shrinks to .97. Nothing to send: the
/// same violet circle at 40%, so it keeps its identity (web :disabled opacity .4).
private struct ComposerSendStyle: ButtonStyle {
    let active: Bool
    func makeBody(configuration: Configuration) -> some View { SendBody(configuration: configuration, active: active) }
    private struct SendBody: View {
        let configuration: ButtonStyleConfiguration
        let active: Bool
        @State private var hovering = false
        var body: some View {
            configuration.label
                .foregroundStyle(Color.white)
                .shadow(color: Color(red: 28 / 255, green: 8 / 255, blue: 92 / 255).opacity(0.45), radius: 0.5, y: 1)
                .frame(width: 44, height: 44)
                .background {
                    Circle().fill(CE.primaryGradient)
                        .overlay {
                            Circle().fill(LinearGradient(stops: [
                                .init(color: .white.opacity(0.14), location: 0), .init(color: .white.opacity(0.025), location: 0.44),
                                .init(color: .clear, location: 0.52),
                            ], startPoint: .top, endPoint: .bottom))
                        }
                        .overlay {
                            Circle().fill(LinearGradient(colors: [.clear, Color(red: 222 / 255, green: 208 / 255, blue: 1).opacity(0.35)],
                                                         startPoint: .center, endPoint: .bottom))
                        }
                        .overlay { GlassRim(shape: Circle()) }
                        .shadow(color: CE.violet.opacity(active ? 0.6 : 0), radius: 12, y: 8)
                        .shadow(color: Color(red: 16 / 255, green: 6 / 255, blue: 52 / 255).opacity(active ? 0.55 : 0), radius: 3, y: 2)
                }
                .brightness(active && hovering && !configuration.isPressed ? 0.06 : 0)
                .opacity(active ? 1 : 0.4)
                .scaleEffect(configuration.isPressed ? 0.97 : 1)
                .animation(.spring(response: 0.3, dampingFraction: 0.55), value: configuration.isPressed)
                .animation(.linear(duration: 0.16), value: active)
                .contentShape(Circle())
                .onHover { hovering = $0 }
        }
    }
}

/// Web .cmp-chip--target: 28pt capsule. Quiet: ink-2 on white .08, ink-1 on white .13 when hovered. A worker:
/// white on violet .42 with a violet ring. A removed target: danger text and ring.
private struct TargetChipStyle: ButtonStyle {
    let direct: Bool
    let missing: Bool
    func makeBody(configuration: Configuration) -> some View {
        TargetChipBody(configuration: configuration, direct: direct, missing: missing)
    }
    private struct TargetChipBody: View {
        let configuration: ButtonStyleConfiguration
        let direct: Bool
        let missing: Bool
        @Environment(\.isEnabled) private var isEnabled
        @State private var hovering = false
        var body: some View {
            let lit = isEnabled && (hovering || configuration.isPressed)
            configuration.label
                .foregroundStyle(direct ? Color.white : missing ? CE.danger : lit ? CE.ink : CE.ink2)
                .padding(.horizontal, 10).frame(height: 28)
                .background(direct ? CE.violet.opacity(lit ? 0.52 : 0.42) : Color.white.opacity(lit ? 0.13 : 0.08), in: Capsule())
                .overlay {
                    Capsule().strokeBorder(direct ? CE.violet.opacity(0.95) : missing ? CE.danger.opacity(0.6) : Color.white.opacity(0.1))
                }
                .frame(maxWidth: 220)
                .animation(.linear(duration: 0.12), value: lit)
                .contentShape(Capsule())
                .onHover { hovering = $0 }
        }
    }
}

/// Web .cmp-chip__x: a 28pt round × in ink-2; ink-1 on white .10 when hovered.
private struct ChipRemoveStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { RemoveBody(configuration: configuration) }
    private struct RemoveBody: View {
        let configuration: ButtonStyleConfiguration
        @State private var hovering = false
        var body: some View {
            let lit = hovering || configuration.isPressed
            configuration.label
                .foregroundStyle(lit ? CE.ink : CE.ink2)
                .frame(width: 28, height: 28)
                .background(Color.white.opacity(configuration.isPressed ? 0.14 : hovering ? 0.1 : 0), in: Circle())
                .contentShape(Circle())
                .onHover { hovering = $0 }
        }
    }
}

/// One recipient in the composer's target list.
private struct ComposerTargetEntry: Identifiable {
    /// nil = the project lead (총괄 / 본사 AI), the default recipient.
    let memberID: String?
    let name: String
    let sub: String
    let status: String?
    var id: String { memberID ?? "lead" }
}

#if os(macOS)
/// Web .cmp-menu: a dark list (rgb 18 14 38 / .98, padding 6) of 48pt rows, radius 12: name 14.5/600, "@handle ·
/// role" 12.5 ink-2, status dot and label on the right; the hovered or keyboard row is violet .3. ↑↓ move,
/// Return/Tab pick, Esc closes. Scrolls past 292pt.
private struct ComposerTargetMenu: View {
    let entries: [ComposerTargetEntry]
    let current: String?
    let onPick: (String?) -> Void
    @State private var active = 0
    @FocusState private var focused: Bool

    private static let rowHeight: CGFloat = 48
    private static let maxHeight: CGFloat = 292

    var body: some View {
        let height = CGFloat(entries.count) * Self.rowHeight + 12
        Group {
            if height > Self.maxHeight {
                ScrollViewReader { reader in
                    ScrollView { list }
                        .frame(height: Self.maxHeight)
                        .onChange(of: active) { _, row in reader.scrollTo(row) }
                }
            } else {
                list
            }
        }
        .frame(width: 340)
        .background(Color(red: 18 / 255, green: 14 / 255, blue: 38 / 255).opacity(0.98))
        .focusable()
        .focused($focused)
        .focusEffectDisabled()
        .onKeyPress(.upArrow) { move(-1); return .handled }
        .onKeyPress(.downArrow) { move(1); return .handled }
        .onKeyPress(.return) { pick(active); return .handled }
        .onKeyPress(.tab) { pick(active); return .handled }
        .onAppear {
            active = entries.firstIndex { $0.memberID == current } ?? 0
            focused = true
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("보낼 대상")
    }

    private var list: some View {
        VStack(spacing: 0) {
            ForEach(Array(entries.enumerated()), id: \.element.id) { position, entry in row(entry, position: position).id(position) }
        }
        .padding(6)
    }

    private func row(_ entry: ComposerTargetEntry, position: Int) -> some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        let selected = entry.memberID == current
        let info = entry.status.map { MemberStatusInfo($0) }
        return Button { onPick(entry.memberID) } label: {
            HStack(spacing: 12) {
                // web: name and sub at line-height 1.3, 1px apart.
                VStack(alignment: .leading, spacing: 3) {
                    Text(entry.name).font(.system(size: 14.5, weight: .semibold)).foregroundStyle(CE.ink).lineLimit(1)
                    if !entry.sub.isEmpty {
                        Text(entry.sub).font(CEFont.meta).foregroundStyle(CE.ink2).lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                if let info {
                    HStack(spacing: 6) {
                        StatusDot(tone: info.tone, pulsing: info.live, size: 8)
                        Text(info.label).font(CEFont.meta).foregroundStyle(info.tone.color).lineLimit(1)
                    }
                    .fixedSize()
                }
                Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(CE.accent)
                    .frame(width: 12)
                    .opacity(selected ? 1 : 0)
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
            .frame(maxWidth: .infinity, minHeight: Self.rowHeight, alignment: .leading)
            .background(position == active ? CE.violet.opacity(0.3) : Color.clear, in: shape)
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .onHover { if $0 { active = position } }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([entry.name, entry.sub.isEmpty ? nil : entry.sub, info?.label].compactMap { $0 }.joined(separator: ", "))
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    private func move(_ step: Int) {
        guard !entries.isEmpty else { return }
        active = (active + step + entries.count) % entries.count
    }

    private func pick(_ position: Int) {
        guard entries.indices.contains(position) else { return }
        onPick(entries[position].memberID)
    }
}
#endif

/// An image attachment's 20pt round thumbnail in its chip (web .cmp-chip__thumb). Read once per attachment and kept
/// small; very large files and the sample keep the photo glyph.
private struct ComposerChipThumb: View {
    @Environment(AppStore.self) private var store
    let file: Attachment
    @State private var image: Image?

    var body: some View {
        ZStack {
            if let image {
                image.resizable().scaledToFill()
            } else {
                Circle().fill(Color.white.opacity(0.1))
                Image(systemName: "photo").font(.system(size: 9, weight: .semibold)).foregroundStyle(CE.ink2)
            }
        }
        .frame(width: 20, height: 20)
        .clipShape(Circle())
        .task(id: file.id) { await load() }
        .accessibilityHidden(true)
    }

    private func load() async {
        if let cached = composerThumbCache[file.id] { image = cached; return }
        guard !store.isDemo, file.size <= 20 * 1024 * 1024, let api = store.api,
              let data = try? await api.attachmentData(file),
              let source = CGImageSourceCreateWithData(data as CFData, nil) else { return }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 60,
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return }
        let thumb = Image(decorative: cgImage, scale: 1)
        if composerThumbCache.count > 100 { composerThumbCache.removeAll() }
        composerThumbCache[file.id] = thumb
        image = thumb
    }
}

@MainActor private var composerThumbCache: [String: Image] = [:]
