import SwiftUI

/// Report and home cards use the reader's existing chip and the Router's return-preserving file route.
struct FileChips: View {
    let fileIDs: [String]
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    var body: some View {
        ChipFlow(spacing: 6) {
            ForEach(FileLinks.unique(fileIDs), id: \.self) { id in
                let file = store.files.first { $0.id == id }
                LinkChip(icon: fileKindIcon(file?.kind ?? "file"), label: String(localized: "자료"),
                         title: file?.title ?? String(localized: "자료 열기"), help: String(localized: "자료 열기")) {
                    router.openFile(id)
                }
            }
        }
    }
}

enum FileLinks {
    static func unique(_ ids: [String]) -> [String] {
        var seen = Set<String>()
        return ids.filter { !$0.isEmpty && seen.insert($0).inserted }
    }
    /// Old report hash links are internal only after both project and file membership have been checked.
    static func fileID(_ url: URL, projectID: String?, files: [FileDoc]) -> String? {
        guard let fragment = URLComponents(url: url, resolvingAgainstBaseURL: false)?.fragment else { return nil }
        let parts = fragment.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 5, parts[0].isEmpty, parts[1] == "p", parts[3] == "files",
              let project = String(parts[2]).removingPercentEncoding, project == projectID,
              let id = String(parts[4]).removingPercentEncoding,
              files.contains(where: { $0.id == id && $0.projectId == project }) else { return nil }
        return id
    }
    @MainActor static func viewedFileID(router: Router) -> String? {
        if router.usesPhoneNavigation {
            if case .file(let id) = router.phonePaths[router.destination]?.last { return id }
            return nil
        }
        return router.destination == .files ? router.fileID : nil
    }
    @MainActor static func openRelated(_ message: Message, router: Router) {
        router.openChat(message.mine ? message.targetMemberId : message.memberId)
        router.chatMessageID = message.id
    }
    static func pinnedSelection(current: String?, visibleIDs: [String]) -> String? { current ?? visibleIDs.first }
    static func matches(_ file: FileDoc, body: String?, query: String) -> Bool {
        query.isEmpty || [file.title, file.summary, file.who, body ?? file.body].contains { $0.localizedStandardContains(query) }
    }
}

/// Selection is pinned before a subsequent snapshot can replace the newest row.
struct FileListArrivalState {
    private(set) var known: Set<String>?
    private(set) var unseen = Set<String>()
    mutating func update(_ ids: [String]) {
        let next = Set(ids)
        if known == nil && next.isEmpty { return }
        if let known { unseen.formUnion(next.subtracting(known)) }
        unseen.formIntersection(next)
        known = next
    }
    mutating func acknowledge() { unseen.removeAll() }
}

/// One link out of the reader: "● 결재 제목 ›" / "대화 제목 ›". An open decision is the highlighted (violet) one.
struct LinkChip: View {
    var dot: Tone? = nil
    var icon: String? = nil
    let label: String
    let title: String
    var highlighted = false
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let dot {
                    StatusDot(tone: dot, size: 7)
                } else if let icon {
                    Image(systemName: icon).font(.system(size: 11, weight: .semibold)).foregroundStyle(CE.ink3)
                }
                Text(label).foregroundStyle(highlighted ? CE.accent : CE.ink2)
                Text(shortTitle).foregroundStyle(CE.ink).lineLimit(1)
                Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold)).foregroundStyle(CE.ink3)
            }
            .font(isMac ? .system(size: 13, weight: .medium) : CEFont.secondary.weight(.medium))
            .padding(.horizontal, 12)
        }
        // Same family as the filter chips and viewer buttons on this screen: 30 tall, lightens on hover.
        .buttonStyle(LinkChipStyle(highlighted: highlighted))
        .fixedSize()
        .help("\(help) · \(title)")
        .accessibilityLabel("\(label) \(title)")
        .accessibilityHint(help)
    }

    /// Chips sit in a wrapping row, so long titles are cut by length (the full title is in the tooltip).
    private var shortTitle: String {
        let value = title.isEmpty ? String(localized: "제목 없음") : title
        return value.count > 26 ? String(value.prefix(25)) + "…" : value
    }
}

/// The reader's link chips (결재 · 대화): Mac 30 tall capsules that lighten on hover; an open decision is violet.
struct LinkChipStyle: ButtonStyle {
    let highlighted: Bool
    func makeBody(configuration: Configuration) -> some View { LinkBody(configuration: configuration, highlighted: highlighted) }
    private struct LinkBody: View {
        let configuration: ButtonStyleConfiguration
        let highlighted: Bool
        @State private var hovering = false
        var body: some View {
            configuration.label
                .frame(height: isMac ? 30 : 34)
                .background(fill, in: Capsule())
                .overlay { Capsule().strokeBorder(highlighted ? CE.violet.opacity(0.55) : CE.line) }
                .padding(.vertical, isMac ? 0 : 5)
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
                .animation(.linear(duration: 0.12), value: hovering)
        }
        private var fill: Color {
            if highlighted { return CE.violet.opacity(configuration.isPressed ? 0.42 : hovering ? 0.36 : 0.28) }
            return Color.white.opacity(configuration.isPressed ? 0.13 : hovering ? 0.10 : 0.05)
        }
    }
}



struct ViewedFileContextChip: View {
    let file: FileDoc
    let remove: () -> Void
    var body: some View {
        HStack(spacing: 5) {
            Text(String(localized: "보던 자료: ") + (file.title.isEmpty ? String(localized: "제목 없는 자료") : file.title)).lineLimit(1)
            Button(action: remove) { Image(systemName: "xmark.circle.fill") }
                .buttonStyle(.plain).accessibilityLabel("보던 자료 빼기")
        }
        .font(CEFont.meta).foregroundStyle(CE.ink2).padding(.horizontal, 8).padding(.vertical, 5)
        .background(CE.accent.opacity(0.1), in: Capsule())
    }
}
