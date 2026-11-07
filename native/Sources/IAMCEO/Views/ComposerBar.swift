import SwiftUI
import ImageIO
import UniformTypeIdentifiers
#if os(iOS)
import PhotosUI
import UIKit
import AVFoundation
#endif

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
    /// iPhone: a downward swipe on the composer. nil = lower the keyboard; the quick-compose sheet closes itself.
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
    /// Mac: the recipient list (web .cmp-menu) is open.
    @State private var showTargets = false
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
        // down, and the quick-compose sheet closes. Simultaneous, so typing, selecting and tapping keep working.
        .simultaneousGesture(DragGesture(minimumDistance: 12).onEnded { value in
            guard value.translation.height > 28, value.translation.height > abs(value.translation.width) * 1.2 else { return }
            focused = false
            onSwipeDown?()
        })
        #endif
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
        #if os(iOS)
        .photosPicker(isPresented: $choosingPhotos, selection: $photoSelection, maxSelectionCount: 10,
                      selectionBehavior: .ordered, matching: .any(of: [.images, .videos]),
                      preferredItemEncoding: .current)
        .onChange(of: photoSelection) { _, items in
            guard !items.isEmpty, let context = photoContext else { return }
            photoSelection = []
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
        .onAppear { if autoFocus { focusSoon() } }
        .onChange(of: router.focusComposer) { _, _ in focusSoon() }
        .onChange(of: key) { _, _ in uploadError = nil; sendError = nil; sentTo = nil }
        .onChange(of: store.selectedProjectID) { _, _ in showTargets = false }
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
            Text("올리는 중").fontWeight(.regular).foregroundStyle(CE.ink2)
        }
        .font(CEFont.meta.weight(.medium))
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
        HStack(alignment: .bottom, spacing: 2) {
            attachmentButton

            TextField("\(recipientName)에게 보낼 글", text: text, prompt: Text(placeholder).foregroundStyle(CE.ink2), axis: .vertical)
                .textFieldStyle(.plain)
                .font(isMac ? .system(size: 15) : CEFont.body)
                // web .cmp__input: 22pt lines (15px text + 4pt leading); 7 lines ≈ the web's 168pt cap.
                .lineSpacing(4)
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
                if key == context.token.key { uploadError = "설정에서 카메라 접근을 허용해 주세요" }
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
                try PhotoAttachment.prepare(source: media.file.url, video: media.video, date: date, index: index + 1)
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
                return try PhotoAttachment.prepare(source: original.url, video: false, date: date, index: 1, forceJPEG: true)
            }.value
        }
    }

    /// Register every load before the first suspension, keeping send disabled throughout import and upload.
    private func loadMedia(names: [String], context: ComposerUploadContext,
                           load: @escaping @MainActor (Int) async throws -> PhotoAttachmentFile) {
        let batch = names.map { ComposerUpload(name: $0, token: context.token) }
        let placeholders = batch.map {
            FileManager.default.temporaryDirectory.appendingPathComponent("iamceo-load-\($0.id)").appendingPathComponent($0.name)
        }
        uploads.append(contentsOf: batch)
        if key == context.token.key { uploadError = nil }
        for url in placeholders { failUpload(url, token: context.token, detail: "아직 첨부하지 못했습니다") }
        Task {
            defer { uploads.removeAll { item in batch.contains { $0.id == item.id } } }
            for index in names.indices {
                defer { uploads.removeAll { $0.id == batch[index].id } }
                guard uploadIsCurrent(context) else { return }
                do {
                    let file = try await load(index)
                    defer { file.cleanup() }
                    guard uploadIsCurrent(context), store.api != nil else { return }
                    // The existing upload path takes over both the success chip and failure bookkeeping.
                    failedUploads.removeAll { $0.url == placeholders[index] }
                    uploads.removeAll { $0.id == batch[index].id }
                    await upload([file.url], context: context)
                } catch {
                    guard uploadIsCurrent(context) else { return }
                    failUpload(placeholders[index], token: context.token, detail: error.localizedDescription)
                }
            }
        }
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

    private func uploadIsCurrent(_ context: ComposerUploadContext) -> Bool {
        let token = context.token
        return store.canWrite && context.projectID == store.selectedProjectID
            && token.namespace == drafts.namespace && token.connectionGeneration == drafts.connectionGeneration
            && token.draftGeneration == drafts.snapshot(for: token.key).generation
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
                try PhotoAttachment.validateSize(url)
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
