import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// F1(4차 S): 연결되면 보낼 글. 입력칸 아래 '연결되면 보낼 글 n개 · 보기'에서 연다.
/// 아직 한 번도 보내지 않은 글만 있다. 위에서부터 하나씩 보내고, 보내기 전까지는 고치거나 지울 수 있다.
/// 앞선 글이 접수되지 않으면 나머지를 멈추고 까닭과 '이어서 보내기'를 보인다.
/// 다른 시트처럼 CESheet 의 틀(머리·본문·바닥 버튼)과 Setup 입력칸을 쓴다. 팝업 안에 카드를 겹치지 않는다.
/// V(0.2.5): 쓴 지 하루가 넘은 글은 '확인 필요'로 두고 글마다 보내기·고치기·지우기를 고른다. 지우기 전 마지막 7일은 '곧 지워짐'.
/// 다른 서버에 보내려던 글은 맨 아래 따로(서버 주소별로) 보이고 읽기·복사·지우기만 된다.
struct OutboxSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    /// 고치는 중인 글과 그 글.
    @State private var editingID: String?
    @State private var editText = ""
    @FocusState private var editorFocused: Bool
    @State private var confirmDelete: QueuedMessage?
    @State private var error: String?
    /// V: 방금 복사한 다른 서버 몫의 글(단추가 잠깐 '복사됨').
    @State private var copiedID: String?

    private var items: [QueuedMessage] { store.queuedMessages }
    /// 보관했거나 지운 프로젝트에 둔 글. 보낼 곳이 없어 읽고 지우기만 한다(4차 리뷰 data-5).
    private var orphans: [QueuedMessage] { store.orphanQueuedMessages }
    /// V: 다른 서버에 보내려던 글. 보내지 않고 읽기·복사·지우기만 한다.
    private var elsewhere: [QueuedMessage] { store.otherServerQueuedMessages }

    var body: some View {
        CESheet(String(localized: "연결되면 보낼 글"), subtitle: store.currentProjectName, icon: "clock", width: 540,
                onClose: { dismiss() }) {
            VStack(alignment: .leading, spacing: 14) {
                Text("서버에 연결되면 위에서부터 하나씩 보냅니다. 보내기 전까지는 고치거나 지울 수 있습니다. 첨부는 연결된 뒤에 붙여 보내 주세요.")
                    .font(CEFont.note).foregroundStyle(CE.ink2)
                    .lineSpacing(CELeading.note)
                    .fixedSize(horizontal: false, vertical: true)
                stateNotice
                if items.isEmpty {
                    CompactEmpty(icon: "tray", title: String(localized: "보낼 글이 없습니다"))
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                            if index > 0 { RowDivider(inset: 0) }
                            row(item, position: index + 1)
                        }
                    }
                }
                if store.queuedElsewhereCount > 0 {
                    Text("다른 프로젝트에 보낼 글 \(store.queuedElsewhereCount)개는 그 프로젝트를 열면 보냅니다.")
                        .font(CEFont.meta).foregroundStyle(CE.ink3)
                }
                if !orphans.isEmpty { orphanSection }
                if !elsewhere.isEmpty { otherServerSection }
                if let error { InlineNotice(tone: .danger, title: error) }
            }
        } footer: {
            Button("닫기") { dismiss() }
                .ceSecondaryButton()
                .keyboardShortcut(.cancelAction)
        }
        .confirmationDialog(String(localized: "이 글을 지울까요?"), isPresented: Binding(get: { confirmDelete != nil },
                                                                                   set: { if !$0 { confirmDelete = nil } }),
                            titleVisibility: .visible, presenting: confirmDelete) { item in
            Button("지우기", role: .destructive) { delete(item) }
            Button("취소", role: .cancel) {}
        } message: { _ in
            Text("아직 보내지 않은 글이라 서버에는 아무것도 가지 않습니다.")
        }
        // 다른 서버로 바뀌면 이 목록은 그 서버 것이 아니다.
        .onChange(of: store.writeNamespace) { _, _ in dismiss() }
        // 고치던 글이 그 사이 보내졌거나 지워졌다.
        .onChange(of: items.map(\.id)) { _, ids in
            if let editingID, !ids.contains(editingID) { self.editingID = nil }
        }
    }

    /// 멈춤, 보내는 중, 앞선 글의 접수 확인 중. 연결을 기다리는 동안은 따로 말하지 않는다(맨 위 줄이 말한다).
    @ViewBuilder private var stateNotice: some View {
        if let reason = store.outboxPausedReason, !items.isEmpty {
            InlineNotice(tone: .attention, icon: "pause.circle", title: String(localized: "보내기를 멈췄습니다"), detail: reason,
                         actionTitle: String(localized: "이어서 보내기"), action: { store.resumeOutbox() },
                         actionDisabled: !store.canWrite)
        } else if !store.queuedNeedingReview.isEmpty {
            // V: 쓴 지 하루가 넘은 글은 저절로 보내지 않는다. 순서를 지켜 그 글 뒤의 글도 기다린다.
            InlineNotice(tone: .attention, icon: "hand.raised", title: String(localized: "쓴 지 하루가 지난 글은 저절로 보내지 않습니다"),
                         detail: String(localized: "지금 상황에 맞는지 보고 글마다 보내기·고치기·지우기를 골라 주세요. 뒤의 글은 앞의 글을 정한 다음 순서대로 보냅니다."))
        } else if store.outboxFlushing {
            InlineNotice(tone: .live, icon: "arrow.up.circle", title: String(localized: "보내는 중입니다"))
        } else if !store.waitsForConnection, store.outboxAwaitingResult {
            InlineNotice(tone: .attention, icon: "clock", title: String(localized: "앞서 보낸 글의 접수를 확인하는 중입니다"),
                         detail: String(localized: "확인이 끝나면 이어서 보냅니다. 같은 글을 다시 보내지 않습니다."))
        }
    }

    private func row(_ item: QueuedMessage, position: Int) -> some View {
        let editing = editingID == item.id
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(recipientLine(item)).font(CEFont.rowTitle).foregroundStyle(CE.ink)
                    .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 8)
                meta(item, review: item.needsReview())
            }
            if editing {
                TextField(String(localized: "보낼 글"), text: $editText, axis: .vertical)
                    .labelsHidden()
                    .font(SetupFont.input)
                    .lineLimit(3...10)
                    .focused($editorFocused)
                    .ceField(focused: editorFocused)
                HStack(spacing: 16) {
                    action(String(localized: "저장"), disabled: editText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) { save(item) }
                    action(String(localized: "취소"), color: CE.ink2) { editingID = nil }
                }
            } else {
                Text(item.text).font(CEFont.body).foregroundStyle(CE.ink)
                    .lineSpacing(CELeading.body)
                    .lineLimit(6).truncationMode(.tail)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                HStack(spacing: 16) {
                    // V: 하루가 넘은 글은 대표가 보내기를 골라야 보낸다(연결 전이면 연결되면 보낸다).
                    if item.needsReview() {
                        action(store.canWrite ? String(localized: "보내기") : String(localized: "연결되면 보내기")) { confirm(item) }
                    }
                    action(String(localized: "고치기")) {
                        editText = item.text; error = nil; editingID = item.id; editorFocused = true
                    }
                    action(String(localized: "지우기"), color: CE.danger) { confirmDelete = item }
                }
            }
        }
        .padding(.vertical, 12)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(String(localized: "\(position)번째로 보낼 글, \(recipientLine(item))"))
    }

    /// 쓴 때(고친 글은 '· 고침'). V: 하루가 넘었으면 앞에 '확인 필요', 지우기 전 마지막 7일이면 뒤에 '곧 지워짐'.
    private func meta(_ item: QueuedMessage, review: Bool = false) -> some View {
        let soon = item.expiresSoon()
        return HStack(spacing: 0) {
            if review {
                Text("확인 필요").fontWeight(.semibold).foregroundStyle(CE.attention)
                Text(verbatim: " · ").foregroundStyle(CE.ink3)
            }
            Text(timeLine(item)).foregroundStyle(CE.ink3)
            if soon {
                Text(verbatim: " · ").foregroundStyle(CE.ink3)
                Text("곧 지워짐").foregroundStyle(CE.attention)
            }
        }
        .font(CEFont.meta).lineLimit(1)
        .accessibilityElement(children: .combine)
    }

    /// V: 다른 서버에 보내려던 글. 서버(주소)별로 묶어 쓴 순서대로 보이고, 읽기·복사·지우기만 된다.
    private var otherServerSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("다른 서버에 보내려던 글 \(elsewhere.count)개").font(CEFont.rowTitle).foregroundStyle(CE.ink)
            Text("지금 서버로는 보내지 않습니다. 그 서버에 다시 연결하면 순서대로 보냅니다. 쓴 지 30일이 지나면 지워지니 필요한 내용은 복사해 두세요.")
                .font(CEFont.meta).foregroundStyle(CE.ink3)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(elsewhereGroups, id: \.key) { group in
                VStack(alignment: .leading, spacing: 0) {
                    Label { Text(group.label).lineLimit(1).truncationMode(.middle) } icon: { Image(systemName: "server.rack") }
                        .font(CEFont.meta).foregroundStyle(CE.ink2)
                        .padding(.top, 8)
                        .help(group.address)
                    ForEach(Array(group.items.enumerated()), id: \.element.id) { index, item in
                        if index > 0 { RowDivider(inset: 0) }
                        elsewhereRow(item)
                    }
                }
            }
        }
        .padding(.top, 4)
    }

    private func elsewhereRow(_ item: QueuedMessage) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(item.targetName.map { String(localized: "@\($0)에게") } ?? String(localized: "\(store.leadRankName)에게"))
                    .font(CEFont.rowTitle).foregroundStyle(CE.ink2)
                    .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 8)
                meta(item)
            }
            Text(item.text).font(CEFont.body).foregroundStyle(CE.ink2)
                .lineSpacing(CELeading.body)
                .lineLimit(6).truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            HStack(spacing: 16) {
                action(copiedID == item.id ? String(localized: "복사됨") : String(localized: "복사")) { copy(item) }
                action(String(localized: "지우기"), color: CE.danger) { confirmDelete = item }
            }
        }
        .padding(.vertical, 12)
        .accessibilityElement(children: .contain)
    }

    /// 쓴 서버(주소·서버 ID·데이터 폴더)별 묶음. 처음 나온 순서대로.
    private var elsewhereGroups: [(key: String, address: String, label: String, items: [QueuedMessage])] {
        var order: [String] = [], grouped: [String: [QueuedMessage]] = [:]
        for item in elsewhere {
            let key = item.namespace + "\n" + (item.serverID ?? "") + "\n" + (item.owner?.home ?? "")
            if grouped[key] == nil { order.append(key) }
            grouped[key, default: []].append(item)
        }
        return order.compactMap { key in
            guard let items = grouped[key], let first = items.first else { return nil }
            let address = first.namespace
            // 같은 주소에 지금은 다른 서버가 돈다(다시 설치했거나 다른 데이터 폴더로 띄운 서버).
            let label = address == store.writeNamespace ? String(localized: "\(address) · 같은 주소의 이전 서버") : address
            return (key, address, label, items)
        }
    }

    private func copy(_ item: QueuedMessage) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(item.text, forType: .string)
        #else
        UIPasteboard.general.string = item.text
        #endif
        copiedID = item.id
        let id = item.id
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            if copiedID == id { copiedID = nil }
        }
    }

    private func confirm(_ item: QueuedMessage) {
        if let failure = store.confirmQueuedMessage(id: item.id) { error = failure } else { error = nil }
    }

    /// 보관했거나 지운 프로젝트의 글: 같은 줄 모양에서 '고치기' 없이 '지우기'만. 글은 골라 복사할 수 있다.
    private var orphanSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("보관했거나 지운 프로젝트의 글").font(CEFont.rowTitle).foregroundStyle(CE.ink)
            Text("보낼 프로젝트가 없어 보내지 않습니다. 필요한 내용은 복사해 두고 지워 주세요.")
                .font(CEFont.meta).foregroundStyle(CE.ink3)
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(orphans.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { RowDivider(inset: 0) }
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(item.targetName.map { String(localized: "@\($0)에게") } ?? String(localized: "\(store.leadRankName)에게"))
                                .font(CEFont.rowTitle).foregroundStyle(CE.ink2)
                                .lineLimit(1).truncationMode(.tail)
                            Spacer(minLength: 8)
                            meta(item)
                        }
                        Text(item.text).font(CEFont.body).foregroundStyle(CE.ink2)
                            .lineSpacing(CELeading.body)
                            .lineLimit(6).truncationMode(.tail)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                        action(String(localized: "지우기"), color: CE.danger) { confirmDelete = item }
                    }
                    .padding(.vertical, 12)
                    .accessibilityElement(children: .contain)
                }
            }
        }
        .padding(.top, 4)
    }

    /// '총괄에게' · '@결제 연동에게'. 그 사이 명부에서 빠졌으면 이름만 남은 대로.
    private func recipientLine(_ item: QueuedMessage) -> String {
        guard let target = item.targetMemberID else { return String(localized: "\(store.leadRankName)에게") }
        let name = store.members.first { $0.id == target }?.name ?? item.targetName ?? String(localized: "명부에 없는 대상")
        return String(localized: "@\(name)에게")
    }

    private func timeLine(_ item: QueuedMessage) -> String {
        _ = MinuteClock.shared.minute
        let formatter = ISO8601DateFormatter()
        let written = relativeTime(formatter.string(from: item.createdAt))
        return item.editedAt == nil ? written : String(localized: "\(written) · 고침")
    }

    /// 입력칸의 '다시 보내기·입력칸에 넣기'와 같은 굵기·색의 글자 버튼(iPhone 은 44pt).
    private func action(_ title: String, color: Color = CE.accent, disabled: Bool = false, perform: @escaping () -> Void) -> some View {
        Button(action: perform) {
            Text(title).font(CEFont.secondary.weight(.semibold)).foregroundStyle(color)
                .frame(minHeight: isMac ? nil : 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .disabled(disabled)
        .opacity(disabled ? 0.45 : 1)
    }

    private func save(_ item: QueuedMessage) {
        if let failure = store.editQueuedMessage(id: item.id, text: editText) { error = failure; return }
        error = nil; editingID = nil
    }

    private func delete(_ item: QueuedMessage) {
        if editingID == item.id { editingID = nil }
        if let failure = store.deleteQueuedMessage(id: item.id) { error = failure } else { error = nil }
        confirmDelete = nil
    }
}

/// 화면 읽기 프로그램에 짧게 알린다(입력칸이 글을 대기열에 넣었을 때).
@MainActor func outboxAnnounce(_ text: String) {
    #if os(macOS)
    NSAccessibility.post(element: NSApp as Any, notification: .announcementRequested,
                         userInfo: [.announcement: text, .priority: NSAccessibilityPriorityLevel.medium.rawValue])
    #else
    UIAccessibility.post(notification: .announcement, argument: text)
    #endif
}
