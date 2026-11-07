import SwiftUI
import WebKit
import PDFKit
import QuickLook
import ImageIO
#if os(macOS)
import AppKit
#else
import UIKit
#endif

// 자료 (web Files): wide (Mac, iPad regular) = a 300pt list beside the reader, both on glass plates and scrolling on
// their own; iPhone = list → pushed reader. Rows stay short (glyph · title · who · time); the summary, links and the
// original path live in the reader.
// Binaries always come through APIClient (Bearer header, same origin only); artifacts render in a locked-down WKWebView.

// MARK: - Kind names (shared with Home, Inbox, Chat)

/// Server FileKind → the same Korean words the web uses.
func fileKindName(_ kind: String) -> String {
    switch kind {
    case "document": "문서"
    case "artifact": "아티팩트"
    case "image": "이미지"
    case "table": "표"
    case "pdf": "PDF"
    case "code": "코드"
    case "video": "영상"
    case "audio": "오디오"
    default: "파일"
    }
}

func fileKindIcon(_ kind: String) -> String {
    switch kind {
    case "document": "doc.text"
    case "artifact": "macwindow"
    case "image": "photo"
    case "table": "tablecells"
    case "pdf": "doc.richtext"
    case "code": "chevron.left.forwardslash.chevron.right"
    case "video": "film"
    case "audio": "waveform"
    default: "doc"
    }
}

/// Filter chip order (web KIND_ORDER).
private let fileKindOrder = ["document", "artifact", "image", "table", "pdf", "code", "video", "audio", "file"]

// MARK: - Files screen

struct FilesView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.ceWide) private var wide
    @State private var search = ""
    @State private var kind: String?

    /// Newest first: server order desc, then creation time desc.
    private var allFiles: [FileDoc] {
        store.files.sorted { $0.order != $1.order ? $0.order > $1.order : $0.createdAt > $1.createdAt }
    }
    /// A kind filter whose files disappeared falls back to 전체.
    private var activeKind: String? {
        guard let kind, store.files.contains(where: { $0.kind == kind }) else { return nil }
        return kind
    }
    private var query: String { search.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var shown: [FileDoc] {
        allFiles.filter { file in
            (activeKind == nil || file.kind == activeKind)
                && (query.isEmpty || [file.title, file.summary, file.who].contains { $0.localizedStandardContains(query) })
        }
    }
    private var kindCounts: [String: Int] { store.files.reduce(into: [:]) { $0[$1.kind, default: 0] += 1 } }
    /// Kinds present, in chip order; unknown future kinds go last.
    private var presentKinds: [String] {
        let kinds = Set(store.files.map(\.kind))
        return fileKindOrder.filter(kinds.contains) + kinds.subtracting(fileKindOrder).sorted()
    }
    /// Filtering by kind only helps when there are two kinds to tell apart (web rule).
    private var showsChips: Bool { presentKinds.count >= 2 }
    /// The web has no search. It appears once the list is long enough to need one, and stays while it holds text.
    private var showsSearch: Bool { store.files.count >= 8 || !search.isEmpty }
    /// A linked file opens regardless of the filter; with nothing linked the first visible file is shown.
    private var selectedFile: FileDoc? {
        if let id = router.fileID { return allFiles.first { $0.id == id } }
        return shown.first
    }
    private var openDecisionsByFile: [String: Int] {
        var counts: [String: Int] = [:]
        for decision in store.decisions where decision.status == "open" {
            if let fileId = decision.fileId { counts[fileId, default: 0] += 1 }
        }
        return counts
    }

    var body: some View {
        @Bindable var router = router
        Group {
            if store.state == nil {
                placeholder
            } else if store.files.isEmpty {
                emptyLibrary
            } else if wide {
                desk
            } else {
                phoneList
            }
        }
        // A search or kind typed in one project must not hide the next project's files.
        .onChange(of: store.selectedProjectID) { _, _ in search = ""; kind = nil }
        #if os(iOS)
        .navigationDestination(item: wide ? .constant(nil) : $router.fileID) { id in FileDetailScreen(fileID: id).ceStatusStrips() }
        #endif
    }

    // MARK: States

    private var placeholder: some View {
        ScrollView {
            Group {
                if store.isLoading {
                    EmptyTile(loading: true, title: "자료를 불러오는 중입니다")
                } else {
                    EmptyTile(icon: "folder", title: "열린 프로젝트가 없습니다", detail: "연결과 프로젝트를 확인한 뒤 다시 동기화하세요.")
                }
            }
            .modifier(EmptyColumn(wide: wide))
        }
    }

    private var emptyLibrary: some View {
        ScrollView {
            EmptyTile(icon: "folder", title: "아직 올린 자료가 없습니다", detail: "직원이 자료를 올리면 여기에 모입니다.")
                .modifier(EmptyColumn(wide: wide))
        }
        #if os(iOS)
        .refreshable { await store.refresh() }
        #endif
    }

    private var outerPadding: CGFloat { isMac ? CESpace.xl : CESpace.l }

    // MARK: Wide: 300pt list + reader

    private var desk: some View {
        HStack(alignment: .top, spacing: CESpace.m) {
            listPane.frame(width: 300)
            readerPane
        }
        .frame(maxWidth: 1180)
        .padding(.horizontal, outerPadding)
        .padding(.top, CESpace.m)
        .padding(.bottom, isMac ? CESpace.xs : CESpace.l)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private var listPane: some View {
        let selectedID = selectedFile?.id
        let counts = openDecisionsByFile
        return Plate(padding: 0) {
            VStack(spacing: 0) {
                if showsSearch || showsChips {
                    VStack(alignment: .leading, spacing: CESpace.s) {
                        if showsSearch { searchField }
                        if showsChips {
                            // The list is narrow: chips wrap so every kind stays in view (web .fl-chips).
                            ChipFlow(spacing: 6) { chipButtons }
                                .accessibilityElement(children: .contain)
                                .accessibilityLabel("종류로 거르기")
                        }
                    }
                    .padding(.horizontal, 10).padding(.top, 10).padding(.bottom, CESpace.s)
                    Rectangle().fill(CE.line).frame(height: 1)
                }
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 2) {
                            ForEach(shown) { file in
                                let selected = file.id == selectedID
                                Button { router.fileID = file.id } label: {
                                    FileRow(file: file, openDecisions: counts[file.id] ?? 0, selected: selected)
                                }
                                .buttonStyle(FileRowStyle(selected: selected))
                                .id(file.id)
                            }
                        }
                        .padding(6)
                        if shown.isEmpty { noMatch.padding(.horizontal, CESpace.m) }
                    }
                    .onAppear { if let id = router.fileID { proxy.scrollTo(id, anchor: .center) } }
                    .onChange(of: router.fileID) { _, id in
                        if let id { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(id) } }
                    }
                }
            }
            .frame(maxHeight: .infinity, alignment: .top)
        }
        .clipShape(RoundedRectangle(cornerRadius: CERadius.plate, style: .continuous))
    }

    private var readerPane: some View {
        Plate(padding: 0) {
            Group {
                if let file = selectedFile {
                    FileReader(file: file)
                } else {
                    // Nothing to read: a quiet note in the middle of the pane, not a line stuck in its corner.
                    Group {
                        if router.fileID != nil {
                            EmptyTile(icon: "questionmark.folder", title: "찾을 수 없는 자료입니다", detail: "목록에서 다시 골라 주세요.", framed: false)
                        } else {
                            EmptyTile(icon: "doc.text.magnifyingglass", title: "고른 자료가 없습니다", detail: "왼쪽 목록에서 자료를 고르세요.", framed: false)
                        }
                    }
                    .frame(maxWidth: 360)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .clipShape(RoundedRectangle(cornerRadius: CERadius.plate, style: .continuous))
    }

    // MARK: iPhone: list, reader is pushed

    private var phoneList: some View {
        let counts = openDecisionsByFile
        return ScrollView {
            VStack(alignment: .leading, spacing: CESpace.m) {
                if showsSearch { searchField }
                if showsChips { kindChips }
                if shown.isEmpty {
                    noMatch
                } else {
                    Plate(padding: 0) {
                        LazyVStack(spacing: 0) {
                            ForEach(Array(shown.enumerated()), id: \.element.id) { index, file in
                                if index > 0 { RowDivider(inset: 14 + FileGlyph.phoneSize + 12) }
                                Button { router.fileID = file.id } label: {
                                    FileRow(file: file, openDecisions: counts[file.id] ?? 0, chevron: true)
                                }
                                .buttonStyle(FileRowStyle(radius: 0))
                            }
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: CERadius.plate, style: .continuous))
                }
            }
            .padding(.horizontal, CESpace.l).padding(.vertical, CESpace.m)
        }
        #if os(iOS)
        .refreshable { await store.refresh() }
        #endif
    }

    // MARK: Pieces

    private var searchField: some View {
        HStack(spacing: 7) {
            Image(systemName: "magnifyingglass").font(CEFont.meta).foregroundStyle(CE.ink3)
            TextField("제목·요약·작성자 검색", text: $search)
                .font(CEFont.secondary)
                .autocorrectionDisabled()
            if !search.isEmpty {
                Button { search = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(CE.ink3) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("검색 지우기")
            }
        }
        .ceField()
    }

    /// Phone: one horizontally scrolling line (web behaviour); a second row would push the files down.
    private var kindChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) { chipButtons }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("종류로 거르기")
    }

    @ViewBuilder private var chipButtons: some View {
        let counts = kindCounts
        chip(nil, title: "전체", count: store.files.count)
        ForEach(presentKinds, id: \.self) { value in
            chip(value, title: fileKindName(value), count: counts[value] ?? 0)
        }
    }

    /// Web .fl-chip: quiet capsule; the chosen one is a violet drop with white text.
    private func chip(_ value: String?, title: String, count: Int) -> some View {
        let on = activeKind == value
        return Button { kind = value } label: {
            HStack(spacing: 4) {
                Text(title)
                Text("\(count)").monospacedDigit().opacity(0.8)
            }
            .font(isMac ? .system(size: 12.5, weight: .medium) : CEFont.secondary.weight(.medium))
            .foregroundStyle(on ? Color.white : CE.ink2)
            .padding(.horizontal, isMac ? 10 : 13)
            .frame(height: isMac ? 26 : 34)
            .background(on ? CE.violet.opacity(0.42) : Color.white.opacity(0.05), in: Capsule())
            .overlay { Capsule().strokeBorder(on ? Color.white.opacity(0.16) : CE.line) }
            // iPhone: 44pt touch target around the 34pt capsule.
            .padding(.vertical, isMac ? 0 : 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title) \(count)개")
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private var noMatch: some View {
        CompactEmpty(icon: "magnifyingglass", title: "맞는 자료가 없습니다", detail: "검색어나 종류를 바꿔 보세요.")
    }
}

/// The column an empty or loading 자료 screen draws in: the same centred 880 column and paddings as 결재함, so the
/// note sits in the middle of the screen instead of at the left of a wide area.
private struct EmptyColumn: ViewModifier {
    let wide: Bool
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, wide ? 24 : CESpace.l)
            .padding(.top, CESpace.m)
            .padding(.bottom, wide ? 24 : 28)
            .frame(maxWidth: 880)
            .frame(maxWidth: .infinity)
    }
}

// MARK: - List row

/// glyph · title · "who · time". Kind is told by the glyph (violet for artifacts, like the web tag); the summary is
/// read in the reader. An open decision that cites the file is the one extra fact a row carries.
private struct FileRow: View {
    let file: FileDoc
    var openDecisions = 0
    var selected = false
    var chevron = false

    var body: some View {
        HStack(spacing: 12) {
            FileGlyph(file: file, size: isMac ? FileGlyph.macSize : FileGlyph.phoneSize)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.title.isEmpty ? "제목 없는 자료" : file.title)
                    .font(CEFont.rowTitle).foregroundStyle(CE.ink)
                    .lineLimit(2).multilineTextAlignment(.leading)
                HStack(spacing: 6) {
                    Text([file.who, relativeTime(file.createdAt)].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(CEFont.meta).foregroundStyle(selected ? CE.ink2 : CE.ink3).lineLimit(1)
                    if openDecisions > 0 { Tag("결재 \(openDecisions)", tone: .attention) }
                }
            }
            Spacer(minLength: 0)
            if chevron {
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(CE.ink3)
            }
        }
        .padding(.horizontal, chevron ? 14 : 10)
        .padding(.vertical, chevron ? 10 : 8)
        .frame(maxWidth: .infinity, minHeight: isMac ? 0 : 56, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var accessibilityText: String {
        var parts = [fileKindName(file.kind), file.title.isEmpty ? "제목 없는 자료" : file.title, file.who, relativeTime(file.createdAt)]
        if openDecisions > 0 { parts.append("결재 \(openDecisions)건 대기") }
        return parts.filter { !$0.isEmpty }.joined(separator: ", ")
    }
}

/// Leading tile: the first image attachment as a thumbnail (web .fl-row__thumb), otherwise the kind icon.
private struct FileGlyph: View {
    static let macSize: CGFloat = 30
    static let phoneSize: CGFloat = 36
    @Environment(AppStore.self) private var store
    let file: FileDoc
    var size: CGFloat
    @State private var thumb: Image?

    private var imageAttachment: Attachment? { file.attachments.first(where: \.isImage) }
    private var isArtifact: Bool { file.kind == "artifact" }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
        ZStack {
            if let thumb {
                thumb.resizable().scaledToFill()
            } else {
                shape.fill(isArtifact ? CE.violet.opacity(0.45) : Color.white.opacity(0.07))
                Image(systemName: fileKindIcon(file.kind))
                    .font(.system(size: size * 0.4, weight: .medium))
                    .foregroundStyle(isArtifact ? Color.white : CE.ink2)
            }
        }
        .frame(width: size, height: size)
        .clipShape(shape)
        .overlay { shape.strokeBorder(Color.white.opacity(0.1)) }
        .help(fileKindName(file.kind))
        .task(id: imageAttachment?.id) { await loadThumb() }
        .accessibilityHidden(true)
    }

    private func loadThumb() async {
        guard let attachment = imageAttachment else { thumb = nil; return }
        if let cached = rowThumbCache[attachment.id] { thumb = cached; return }
        guard let api = store.api, !store.isDemo,
              let data = try? await api.attachmentData(attachment),
              let decoded = decodePreviewImage(data, maxPixel: 160) else { return }
        if rowThumbCache.count > 300 { rowThumbCache.removeAll() }
        rowThumbCache[attachment.id] = decoded.image
        thumb = decoded.image
    }
}

/// Small decoded thumbnails by attachment id, so scrolling the list does not fetch them again.
@MainActor private var rowThumbCache: [String: Image] = [:]

/// Web .fl-row: hover lightens; the selected row is a violet gradient with a bright top edge.
private struct FileRowStyle: ButtonStyle {
    var selected = false
    var radius: CGFloat = CERadius.row
    func makeBody(configuration: Configuration) -> some View {
        RowBody(configuration: configuration, selected: selected, radius: radius)
    }
    private struct RowBody: View {
        let configuration: ButtonStyleConfiguration
        let selected: Bool
        let radius: CGFloat
        @State private var hovering = false
        var body: some View {
            let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
            configuration.label
                .contentShape(shape)
                .background {
                    if selected {
                        shape.fill(LinearGradient(colors: [CE.violet.opacity(0.34), CE.violet.opacity(0.22)], startPoint: .top, endPoint: .bottom))
                            .overlay {
                                shape.strokeBorder(LinearGradient(colors: [Color.white.opacity(0.24), Color.white.opacity(0.05)], startPoint: .top, endPoint: .bottom), lineWidth: 1)
                            }
                    } else {
                        shape.fill(Color.white.opacity(configuration.isPressed ? 0.09 : hovering ? 0.06 : 0))
                    }
                }
                .onHover { hovering = $0 }
        }
    }
}

#if os(iOS)
/// iPhone push target. Looks the file up live so polling updates (and removals) show.
private struct FileDetailScreen: View {
    @Environment(AppStore.self) private var store
    let fileID: String
    var body: some View {
        let file = store.files.first { $0.id == fileID }
        Group {
            if let file {
                FileReader(file: file)
            } else {
                ScrollView {
                    EmptyTile(icon: "questionmark.folder", title: "찾을 수 없는 자료입니다", detail: "목록에서 다시 골라 주세요.")
                        .modifier(EmptyColumn(wide: false))
                }
            }
        }
        .background { AmbientBackground() }
        // The reader shows the full, selectable title itself; the bar names the kind so it is not said twice.
        .navigationTitle(file.map { fileKindName($0.kind) } ?? "자료")
        .navigationBarTitleDisplayMode(.inline)
    }
}
#endif

// MARK: - Reader

/// One file, read top to bottom. Embeddable (Files reader pane, Inbox evidence panel, iPhone push):
/// it scrolls by itself and has no NavigationStack, so do not wrap it in another vertical ScrollView.
struct FileReader: View {
    let file: FileDoc
    init(file: FileDoc) { self.file = file }
    var body: some View {
        // A different file starts from the top with fresh viewer state (gate, loaded originals, sort).
        FileReaderContent(file: file).id(file.id)
    }
}

/// Web .fl-doc: meta (kind tag · who · time), title 22 (artifact 19), summary 15, links, path box, then the viewer.
private struct FileReaderContent: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.ceWide) private var wide
    let file: FileDoc
    @State private var copiedPath = false

    /// Attachments that are the file itself (web `split`); `file` kind owns all of them.
    private var mainAttachments: [Attachment] {
        file.kind == "file" ? file.attachments : file.attachments.filter { attachmentMatches($0, kind: file.kind) }
    }
    private var extraAttachments: [Attachment] {
        switch file.kind {
        case "file": []
        case "artifact": file.attachments.filter { !attachmentMatches($0, kind: "artifact") }
        default: file.attachments.filter { !attachmentMatches($0, kind: file.kind) }
        }
    }
    private var relatedDecisions: [Decision] { newestFirst(store.decisions.filter { $0.fileId == file.id }) }
    private var relatedMessages: [Message] { Array(store.messages.filter { $0.fileId == file.id }.suffix(3).reversed()) }
    private var author: Member? { file.memberId.flatMap { id in store.members.first { $0.id == id } } }
    private var isArtifact: Bool { file.kind == "artifact" }
    private var path: String? { file.path.flatMap { $0.isEmpty ? nil : $0 } }
    private var hasContent: Bool {
        let text = ["code", "table"].contains(file.kind) ? file.body : markdownBody
        return isArtifact || !text.isEmpty || !file.attachments.isEmpty
    }
    /// Markdown `body` without a leading `# heading` that only repeats the reader title above it.
    private var markdownBody: String {
        let body = file.body
        let title = file.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, let start = body.firstIndex(where: { !$0.isWhitespace }), body[start...].hasPrefix("# ") else { return body }
        let lineEnd = body[start...].firstIndex(where: \.isNewline) ?? body.endIndex
        guard body[start..<lineEnd].dropFirst(2).trimmingCharacters(in: .whitespaces) == title else { return body }
        return String(body[lineEnd...].drop(while: \.isWhitespace))
    }
    /// Prose stays at a reading width; pages, tables and pictures use the whole pane.
    private var readingWidth: CGFloat { ["artifact", "table", "image", "pdf", "video"].contains(file.kind) ? .infinity : 860 }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: CESpace.m) {
                header
                if !relatedDecisions.isEmpty || !relatedMessages.isEmpty { related }
                if let path, !isArtifact { pathBox(path) }
                content
                // An artifact leads with its page (web hides the path); where it lives on the host comes last.
                if let path, isArtifact { pathBox(path) }
            }
            .frame(maxWidth: readingWidth, alignment: .leading)
            .padding(.horizontal, wide ? 26 : CESpace.l)
            .padding(.top, wide ? 22 : CESpace.m)
            .padding(.bottom, wide ? 28 : CESpace.xl)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: CESpace.s) {
            HStack(spacing: CESpace.s) {
                KindTag(kind: file.kind)
                whoLabel
                Text(relativeTime(file.createdAt)).font(CEFont.meta).foregroundStyle(CE.ink3).lineLimit(1)
                    .help(parseISODate(file.createdAt).map(koDateTime) ?? "")
                Spacer(minLength: 0)
            }
            Text(file.title.isEmpty ? "제목 없는 자료" : file.title)
                .font(titleFont).tracking(-0.3).foregroundStyle(CE.ink)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if !file.summary.isEmpty {
                Text(file.summary)
                    .font(summaryFont).foregroundStyle(CE.ink2).lineSpacing(3)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var titleFont: Font {
        #if os(macOS)
        .system(size: isArtifact ? 19 : 22, weight: .bold)
        #else
        isArtifact ? .title3.weight(.bold) : .title2.weight(.bold)
        #endif
    }

    private var summaryFont: Font {
        #if os(macOS)
        .system(size: 15)
        #else
        .subheadline
        #endif
    }

    /// Who uploaded it. When that session is on the team, the name opens it (one fact, one place).
    @ViewBuilder private var whoLabel: some View {
        let name = file.who.isEmpty ? author?.name ?? "" : file.who
        if let author {
            Button { router.openMember(author.id) } label: {
                Text(name).font(CEFont.meta.weight(.semibold)).foregroundStyle(CE.ink).lineLimit(1)
                    // iPhone: a 44pt touch target without making the meta line taller.
                    .padding(.vertical, isMac ? 0 : 12).contentShape(Rectangle()).padding(.vertical, isMac ? 0 : -12)
            }
            .buttonStyle(.plain)
            .help("팀에서 보기")
            .accessibilityHint("팀에서 엽니다")
        } else if !name.isEmpty {
            Text(name).font(CEFont.meta.weight(.semibold)).foregroundStyle(CE.ink).lineLimit(1)
        }
    }

    // MARK: Links — the decisions that cite this file and the posts that carried it

    private var related: some View {
        ChipFlow(spacing: 6) {
            ForEach(relatedDecisions) { decision in
                let state = DecisionStateInfo(decision)
                let open = decision.status == "open"
                let action = open ? "결재함에서 답하기" : decision.status == "closed" ? "닫힌 결재 보기" : "답한 결재 보기"
                LinkChip(dot: state.tone, label: "결재", title: decision.title, highlighted: open, help: "\(state.label) · \(action)") {
                    router.openDecision(decision.id)
                }
            }
            ForEach(relatedMessages) { message in
                LinkChip(icon: "bubble.left", label: message.kind.isEmpty ? "대화" : message.kind, title: messageHeadline(message), help: "대화 보기") {
                    router.openChat(chatTarget(for: message))
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("관련")
    }

    /// Workers have their own thread; the conductor/root and the CEO's own posts live in the project conversation.
    private func chatTarget(for message: Message) -> String? {
        guard let id = message.mine ? message.targetMemberId : message.memberId,
              store.members.first(where: { $0.id == id })?.kind == "worker" else { return nil }
        return id
    }

    private func messageHeadline(_ message: Message) -> String {
        if !message.title.isEmpty { return message.title }
        return message.body.split(separator: "\n").first.map(String.init) ?? message.kind
    }

    // MARK: Path (web .fl-path)

    private func pathBox(_ path: String) -> some View {
        HStack(spacing: 4) {
            Text(path)
                .font(CEFont.mono).foregroundStyle(CE.ink2)
                .textSelection(.enabled).lineLimit(2).truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 8)
                .help(path)
            Button {
                copyToPasteboard(path)
                copiedPath = true
                Task { try? await Task.sleep(for: .seconds(2)); copiedPath = false }
            } label: {
                Text(copiedPath ? "복사됨" : "복사")
                    .font(CEFont.meta.weight(.semibold))
                    .foregroundStyle(copiedPath ? CE.success : CE.ink)
                    .padding(.horizontal, 10)
                    .frame(minHeight: isMac ? 28 : 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(copiedPath ? "원본 경로를 복사함" : "원본 경로 복사")
        }
        .padding(.leading, 12).padding(.trailing, 2)
        .recessed()
    }

    // MARK: Body by kind

    @ViewBuilder private var content: some View {
        switch file.kind {
        case "document":
            // Documents keep their attachments above the text (web order).
            attachmentList(file.attachments)
            prose
        case "artifact":
            ArtifactViewer(file: file)
            attachmentList(extraAttachments)
            prose
        case "code":
            if !file.body.isEmpty || !mainAttachments.isEmpty {
                RawTextSource(file: file, attachment: mainAttachments.first, loadingText: "내용을 불러오는 중입니다") { text, truncated in
                    CodeBlock(file: file, text: text, truncated: truncated)
                }
            }
            attachmentList(mainAttachments + extraAttachments)
        case "table":
            if !file.body.isEmpty || !mainAttachments.isEmpty {
                RawTextSource(file: file, attachment: mainAttachments.first, loadingText: "표를 불러오는 중입니다") { text, truncated in
                    TableBlock(text: text, truncated: truncated, tabSeparated: isTabSeparated)
                }
            }
            attachmentList(mainAttachments + extraAttachments)
        case "image":
            if mainAttachments.count == 1, let only = mainAttachments.first {
                AttachmentView(attachment: only, large: true)
            } else if mainAttachments.count > 1 {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: wide ? 170 : 150), spacing: CESpace.s, alignment: .top)], alignment: .leading, spacing: CESpace.s) {
                    ForEach(mainAttachments) { AttachmentView(attachment: $0, large: false) }
                }
            }
            attachmentList(extraAttachments)
            prose
        default:
            // pdf, video, audio, file and kinds this build does not know yet.
            attachmentList(mainAttachments + extraAttachments)
            prose
        }
        if !hasContent {
            CompactEmpty(icon: fileKindIcon(file.kind),
                         title: ["document", "code", "table"].contains(file.kind) ? "본문이 없는 자료입니다" : "원본을 찾을 수 없습니다",
                         detail: emptyDetail)
        }
    }

    private var emptyDetail: String {
        if store.isDemo { return "샘플 자료에는 원본 파일이 없습니다." }
        if let path { return "실행 호스트의 원본 위치: \(path)" }
        return "올린 직원에게 원본을 다시 올려 달라고 요청할 수 있습니다."
    }

    private var isTabSeparated: Bool {
        let name = mainAttachments.first?.name ?? file.path ?? file.title
        return name.lowercased().hasSuffix(".tsv")
    }

    /// Markdown body for document, artifact, image and attachment kinds (never code or table source), set off by a
    /// hairline like the web .fl-doc__body.
    @ViewBuilder private var prose: some View {
        let text = markdownBody
        if !text.isEmpty {
            MarkdownText(text: text)
                .padding(.top, CESpace.l)
                .overlay(alignment: .top) { Rectangle().fill(CE.line).frame(height: 1) }
                .padding(.top, 2)
        }
    }

    @ViewBuilder private func attachmentList(_ items: [Attachment]) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: CESpace.s) {
                ForEach(items) { AttachmentView(attachment: $0, large: true) }
            }
        }
    }
}

/// Web .fl-kind: small rounded label; artifacts are violet.
private struct KindTag: View {
    let kind: String
    var body: some View {
        Text(fileKindName(kind))
            .font(CEFont.micro)
            .foregroundStyle(kind == "artifact" ? Color.white : CE.ink)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(kind == "artifact" ? CE.violet.opacity(0.45) : Color.white.opacity(0.1), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .fixedSize()
    }
}

/// One link out of the reader: "● 결재 제목 ›" / "대화 제목 ›". An open decision is the highlighted (violet) one.
private struct LinkChip: View {
    var dot: Tone? = nil
    var icon: String? = nil
    let label: String
    let title: String
    var highlighted = false
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let dot {
                    StatusDot(tone: dot, size: 6)
                } else if let icon {
                    Image(systemName: icon).font(.system(size: 10, weight: .semibold)).foregroundStyle(CE.ink3)
                }
                Text(label).foregroundStyle(highlighted ? CE.accent : CE.ink3)
                Text(shortTitle).foregroundStyle(CE.ink).lineLimit(1)
                Image(systemName: "chevron.right").font(.system(size: 8, weight: .bold)).foregroundStyle(CE.ink3)
            }
            .font(isMac ? .system(size: 12, weight: .medium) : CEFont.secondary.weight(.medium))
            .padding(.horizontal, 10)
            .frame(height: isMac ? 26 : 34)
            .background(highlighted ? CE.violet.opacity(0.28) : Color.white.opacity(0.05), in: Capsule())
            .overlay { Capsule().strokeBorder(highlighted ? CE.violet.opacity(0.55) : CE.line) }
            .padding(.vertical, isMac ? 0 : 5)
            .contentShape(Rectangle())
            .fixedSize()
        }
        .buttonStyle(.plain)
        .help("\(help) · \(title)")
        .accessibilityLabel("\(label) \(title)")
        .accessibilityHint(help)
    }

    /// Chips sit in a wrapping row, so long titles are cut by length (the full title is in the tooltip).
    private var shortTitle: String {
        let value = title.isEmpty ? "제목 없음" : title
        return value.count > 26 ? String(value.prefix(25)) + "…" : value
    }
}

// MARK: - Raw text (code, table)

private struct FetchedText { let text: String; let truncated: Bool }

/// Raw source for code/table: `body` when the server included it (≤1 MB, UTF-8),
/// otherwise the first 512 KB of the original, decoded like the web (UTF-16 BOM → UTF-8 → CP949).
private struct RawTextSource<Content: View>: View {
    @Environment(AppStore.self) private var store
    let file: FileDoc
    let attachment: Attachment?
    let loadingText: String
    @ViewBuilder let content: (String, Bool) -> Content
    @State private var fetched: FetchedText?
    @State private var failure: String?

    /// U+FFFD in body means the server misread a CP949 file; re-read the original when there is one.
    private var direct: Bool { !file.body.isEmpty && (attachment == nil || !file.body.contains("\u{FFFD}")) }

    var body: some View {
        if direct {
            content(file.body, false)
        } else if let fetched {
            content(fetched.text, fetched.truncated)
        } else if let failure {
            Label(failure, systemImage: "exclamationmark.circle").font(CEFont.secondary).foregroundStyle(CE.attention)
        } else {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(loadingText).font(CEFont.meta).foregroundStyle(CE.ink3)
            }
            .task { await fetch() }
        }
    }

    private func fetch() async {
        guard let attachment else { failure = "원본을 찾을 수 없습니다"; return }
        guard let api = store.api else {
            failure = store.isDemo ? "샘플 자료에는 원본 파일이 없습니다." : "서버에 연결되면 원본을 불러올 수 있습니다."
            return
        }
        do {
            let data = try await api.attachmentData(attachment)
            let limit = 512 * 1024
            let truncated = data.count > limit
            fetched = FetchedText(text: decodeText(truncated ? data.prefix(limit) : data, truncated: truncated), truncated: truncated)
        } catch {
            failure = "원본을 받지 못했습니다. \(error.localizedDescription)"
        }
    }
}

private func decodeText(_ data: Data, truncated: Bool) -> String {
    let bytes = Data(data)
    if bytes.starts(with: [0xFF, 0xFE]) { return String(data: bytes.dropFirst(2), encoding: .utf16LittleEndian) ?? "" }
    if bytes.starts(with: [0xFE, 0xFF]) { return String(data: bytes.dropFirst(2), encoding: .utf16BigEndian) ?? "" }
    // A cut head can end inside a UTF-8 sequence; drop up to three trailing bytes before giving up on UTF-8.
    for cut in 0...(truncated ? 3 : 0) where bytes.count >= cut {
        if let text = String(data: bytes.dropLast(cut), encoding: .utf8) { return text }
    }
    let cp949 = String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.dosKorean.rawValue)))
    return String(data: bytes, encoding: cp949) ?? String(decoding: bytes, as: UTF8.self)
}

// MARK: Code

private let codeLineLimit = 5000

private struct CodeLines {
    let lines: [String]
    let total: Int
    let digits: Int
    init(_ text: String) {
        var all = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        if all.count > 1, all.last == "" { all.removeLast() }
        total = all.count
        lines = Array(all.prefix(codeLineLimit))
        digits = String(lines.count).count
    }
    /// Padded so every chunk's number column has the same width.
    func number(_ index: Int) -> String {
        let value = String(index + 1)
        return String(repeating: " ", count: max(0, digits - value.count)) + value
    }
    /// Very tall single Text views render poorly; draw in chunks.
    var chunks: [Range<Int>] { stride(from: 0, to: lines.count, by: 200).map { $0..<min($0 + 200, lines.count) } }
}

private struct CodeBlock: View {
    @Environment(\.ceWide) private var wide
    let file: FileDoc
    let text: String
    let truncated: Bool
    @State private var wrapChoice: Bool?
    @State private var copied = false
    @State private var prepared: CodeLines?

    /// Phone wraps by default; desk scrolls sideways.
    private var wrap: Bool { wrapChoice ?? !wide }

    var body: some View {
        let model = prepared ?? (text.utf8.count <= 200_000 ? CodeLines(text) : nil)
        VStack(alignment: .leading, spacing: CESpace.s) {
            HStack(spacing: 10) {
                if let model {
                    Text(countLine(model)).font(CEFont.meta).foregroundStyle(CE.ink3).monospacedDigit()
                }
                Spacer(minLength: 6)
                // Web .vw-btn: quiet rounded buttons; 줄바꿈 is a toggle drawn as a violet drop when on.
                Button("줄바꿈") { wrapChoice = !wrap }
                    .buttonStyle(ViewerButtonStyle(on: wrap))
                    .accessibilityAddTraits(wrap ? .isSelected : [])
                Button {
                    copyToPasteboard(text)
                    copied = true
                    Task { try? await Task.sleep(for: .seconds(2)); copied = false }
                } label: {
                    Text(copied ? "복사됨" : truncated ? "보이는 만큼 복사" : "복사")
                }
                .buttonStyle(ViewerButtonStyle())
            }
            Group {
                if let model {
                    if wrap { wrapped(model) } else { scrolling(model) }
                } else {
                    HStack(spacing: 8) { ProgressView().controlSize(.small); Text("내용을 정리하는 중입니다").font(CEFont.meta).foregroundStyle(CE.ink3) }
                        .padding(CESpace.m)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .recessed(opacity: 0.55)
        }
        .task(id: text.utf8.count) { if prepared == nil { prepared = CodeLines(text) } }
    }

    private func countLine(_ model: CodeLines) -> String {
        var line = "\(truncated ? "앞부분 " : "")\(model.total.formatted())줄"
        if model.total > model.lines.count { line += " · 앞 \(model.lines.count.formatted())줄만 표시" }
        return line
    }

    private func scrolling(_ model: CodeLines) -> some View {
        ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(model.chunks, id: \.lowerBound) { range in
                    HStack(alignment: .top, spacing: 14) {
                        Text(range.map(model.number).joined(separator: "\n"))
                            .foregroundStyle(CE.ink3.opacity(0.75))
                            .accessibilityHidden(true)
                        Text(model.lines[range].joined(separator: "\n"))
                            .foregroundStyle(CE.ink)
                            .textSelection(.enabled)
                    }
                }
            }
            .font(CEFont.mono)
            .padding(CESpace.m)
        }
    }

    private func wrapped(_ model: CodeLines) -> some View {
        LazyVStack(alignment: .leading, spacing: 1) {
            ForEach(Array(model.lines.enumerated()), id: \.offset) { index, line in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(model.number(index)).foregroundStyle(CE.ink3.opacity(0.75)).accessibilityHidden(true)
                    Text(line.isEmpty ? " " : line)
                        .foregroundStyle(CE.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .font(CEFont.mono)
        .textSelection(.enabled)
        .padding(CESpace.m)
    }
}

// MARK: Table (csv / tsv)

private let tableColumnLimit = 30
private let tableRowLimit = 200

private struct ParsedTable {
    var header: [String]
    var rows: [[String]]
    var hiddenColumns: Int
    var numeric: [Bool]
}

private struct TableBlock: View {
    let text: String
    let truncated: Bool
    let tabSeparated: Bool
    @State private var parsed: ParsedTable?
    @State private var sort: (column: Int, ascending: Bool)?
    @State private var sortedRows: [[String]]?

    var body: some View {
        let table = parsed ?? (text.utf8.count <= 100_000 ? parseTable(text, tab: tabSeparated, truncated: truncated) : nil)
        VStack(alignment: .leading, spacing: CESpace.s) {
            if let table {
                if table.header.isEmpty {
                    Text("비어 있는 표입니다").font(CEFont.secondary).foregroundStyle(CE.ink3)
                } else {
                    Text(summary(table)).font(CEFont.meta).foregroundStyle(CE.ink3).monospacedDigit()
                    grid(table, rows: Array((sortedRows ?? table.rows).prefix(tableRowLimit)))
                }
            } else {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("표를 정리하는 중입니다").font(CEFont.meta).foregroundStyle(CE.ink3) }
            }
        }
        .task(id: text.utf8.count) { if parsed == nil { parsed = parseTable(text, tab: tabSeparated, truncated: truncated) } }
    }

    private func summary(_ table: ParsedTable) -> String {
        var line = truncated ? "앞부분 \(table.rows.count.formatted())행" : "\(table.rows.count.formatted())행"
        line += " · \(table.header.count)열"
        if table.rows.count > tableRowLimit { line += " · 앞 \(tableRowLimit)행만 표시" }
        if table.hiddenColumns > 0 { line += " · 전체 \(table.header.count + table.hiddenColumns)열 중 앞 \(table.header.count)열만 표시" }
        return line
    }

    private func grid(_ table: ParsedTable, rows: [[String]]) -> some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(table.header.enumerated()), id: \.offset) { index, title in
                        Button { toggleSort(index, table: table) } label: {
                            HStack(spacing: 3) {
                                Text(title.isEmpty ? "열 \(index + 1)" : clipped(title)).lineLimit(1)
                                if let sort, sort.column == index {
                                    Image(systemName: sort.ascending ? "arrow.up" : "arrow.down").font(.system(size: 8, weight: .bold))
                                }
                            }
                            .font(CEFont.meta.weight(.semibold))
                            .foregroundStyle(sort?.column == index ? CE.accent : CE.ink)
                            .padding(.horizontal, 12).padding(.vertical, isMac ? 8 : 11)
                            .frame(maxWidth: .infinity, alignment: table.numeric[index] ? .trailing : .leading)
                            .background(Color(hex: 0x1A1533))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help("눌러서 정렬")
                        .accessibilityLabel("\(title.isEmpty ? "열 \(index + 1)" : title) 열 정렬")
                        .gridColumnAlignment(table.numeric[index] ? .trailing : .leading)
                    }
                }
                Divider().overlay(CE.lineStrong).gridCellUnsizedAxes(.horizontal)
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    if index > 0 { Divider().overlay(CE.line).gridCellUnsizedAxes(.horizontal) }
                    GridRow {
                        ForEach(0..<table.header.count, id: \.self) { column in
                            let value = column < row.count ? row[column] : ""
                            Text(clipped(value))
                                .font(CEFont.secondary).foregroundStyle(CE.ink)
                                .monospacedDigit()
                                .lineLimit(1)
                                .padding(.horizontal, 12).padding(.vertical, isMac ? 7 : 9)
                                .help(value.count > 60 ? value : "")
                        }
                    }
                }
            }
            .textSelection(.enabled)
            // The surface hugs the table; a wide table scrolls sideways inside the reader.
            .background(CE.bgDeep.opacity(0.5))
            .clipShape(RoundedRectangle(cornerRadius: CERadius.control, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: CERadius.control, style: .continuous).strokeBorder(CE.line) }
        }
    }

    private func clipped(_ value: String) -> String { value.count > 60 ? String(value.prefix(58)) + "…" : value }

    /// Header tap cycles ascending → descending → original order. Empty cells always sink.
    private func toggleSort(_ column: Int, table: ParsedTable) {
        if let sort, sort.column == column {
            self.sort = sort.ascending ? (column, false) : nil
        } else {
            sort = (column, true)
        }
        guard let sort else { sortedRows = nil; return }
        let numeric = table.numeric[column]
        let indexed = Array(table.rows.enumerated())
        sortedRows = indexed.sorted { a, b in
            let x = column < a.element.count ? a.element[column].trimmingCharacters(in: .whitespaces) : ""
            let y = column < b.element.count ? b.element[column].trimmingCharacters(in: .whitespaces) : ""
            if x.isEmpty || y.isEmpty { return x.isEmpty == y.isEmpty ? a.offset < b.offset : !x.isEmpty }
            let order: ComparisonResult
            if numeric, let nx = cellNumber(x), let ny = cellNumber(y) {
                order = nx == ny ? .orderedSame : nx < ny ? .orderedAscending : .orderedDescending
            } else {
                order = x.localizedStandardCompare(y)
            }
            if order == .orderedSame { return a.offset < b.offset }
            return sort.ascending ? order == .orderedAscending : order == .orderedDescending
        }
        .map(\.element)
    }
}

/// RFC 4180 (quotes, doubled quotes, newlines inside quotes). A cut file drops its unfinished last line.
private func parseTable(_ input: String, tab: Bool, truncated: Bool) -> ParsedTable {
    let scalars = Array((input.hasPrefix("\u{FEFF}") ? String(input.dropFirst()) : input).unicodeScalars)
    let delimiter: Unicode.Scalar = tab ? "\t" : sniffDelimiter(scalars)
    var rows: [[String]] = []
    var row: [String] = []
    var cell = String.UnicodeScalarView()
    var quoted = false
    var cells = 0
    var maxCells = 0
    func endCell() {
        if cells < tableColumnLimit { row.append(String(cell)) }
        cells += 1
        cell = String.UnicodeScalarView()
    }
    func endRow() {
        endCell()
        maxCells = max(maxCells, cells)
        cells = 0
        if row.count > 1 || row.first != "" { rows.append(row) }
        row = []
    }
    var index = 0
    while index < scalars.count {
        let c = scalars[index]
        if quoted {
            if c == "\"" {
                if index + 1 < scalars.count, scalars[index + 1] == "\"" { cell.append("\""); index += 2; continue }
                quoted = false
            } else {
                cell.append(c)
            }
            index += 1
            continue
        }
        if c == "\"" && cell.isEmpty { quoted = true }
        else if c == delimiter { endCell() }
        else if c == "\n" || c == "\r" {
            if c == "\r", index + 1 < scalars.count, scalars[index + 1] == "\n" { index += 1 }
            endRow()
        } else { cell.append(c) }
        index += 1
    }
    if !truncated && (!cell.isEmpty || !row.isEmpty) { endRow() }
    var header = rows.isEmpty ? [] : rows.removeFirst()
    let width = min(maxCells, tableColumnLimit)
    while header.count < width { header.append("") }
    if header.count > width { header = Array(header.prefix(width)) }
    let numeric = (0..<header.count).map { column in isNumericColumn(rows, column) }
    return ParsedTable(header: header, rows: rows, hiddenColumns: max(0, maxCells - width), numeric: numeric)
}

/// The delimiter seen most often on the first unquoted line (Excel's ; csv included).
private func sniffDelimiter(_ scalars: [Unicode.Scalar]) -> Unicode.Scalar {
    var counts: [Unicode.Scalar: Int] = [",": 0, "\t": 0, ";": 0]
    var quoted = false
    for c in scalars.prefix(8192) {
        if c == "\"" { quoted.toggle() }
        else if !quoted && (c == "\n" || c == "\r") { break }
        else if !quoted, counts[c] != nil { counts[c, default: 0] += 1 }
    }
    let candidates: [Unicode.Scalar] = [",", "\t", ";"]
    let best = candidates.max { (counts[$0] ?? 0) < (counts[$1] ?? 0) } ?? ","
    return (counts[best] ?? 0) > 0 ? best : ","
}

/// 1,234 · -3.5 · 12% count as numbers; long numbers starting with 0 (phone numbers) do not.
private func cellNumber(_ cell: String) -> Double? {
    let s = cell.trimmingCharacters(in: .whitespaces)
    guard s.wholeMatch(of: #/^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?%?$/#) != nil, s.contains(where: \.isNumber) else { return nil }
    if s.wholeMatch(of: #/^[-+]?0\d.*/#) != nil { return nil }
    return Double(s.replacingOccurrences(of: ",", with: "").replacingOccurrences(of: "%", with: ""))
}

private func isNumericColumn(_ rows: [[String]], _ column: Int) -> Bool {
    var seen = false
    for row in rows {
        let value = column < row.count ? row[column] : ""
        if value.trimmingCharacters(in: .whitespaces).isEmpty { continue }
        if cellNumber(value) == nil { return false }
        seen = true
    }
    return seen
}

// MARK: - Artifact

/// Artifacts the person chose to preview during this app session; reopening them skips the gate.
@MainActor private var openedArtifactIDs = Set<String>()

private struct ArtifactViewer: View {
    @Environment(AppStore.self) private var store
    @Environment(\.ceWide) private var wide
    let file: FileDoc
    /// Set only together with the compiled network block rule, so a preview never renders without it.
    @State private var loaded: LoadedArtifact?
    @State private var loading = false
    @State private var error: String?
    @State private var enlarged = false

    private var unavailableReason: String? {
        if store.isDemo { return "샘플 자료에는 연결된 실행 호스트가 없습니다." }
        if store.api == nil { return "서버에 연결되면 미리보기를 열 수 있습니다." }
        return nil
    }

    var body: some View {
        Group {
            if let loaded { preview(loaded) } else { gate }
        }
        .task(id: file.id) { if loaded == nil, openedArtifactIDs.contains(file.id) { await load() } }
        .sheet(isPresented: $enlarged) {
            if let loaded { ArtifactFullView(title: file.title, artifact: loaded) }
        }
    }

    /// Web run gate, shortened: what it is, one line on how it opens, one action.
    private var gate: some View {
        VStack(alignment: .leading, spacing: CESpace.m) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "lock.shield").font(.system(size: 17, weight: .medium)).foregroundStyle(CE.accent)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 3) {
                    Text("직원이 만든 페이지입니다").font(CEFont.rowTitle).foregroundStyle(CE.ink)
                    Text("스크립트와 외부 연결을 끈 보호된 미리보기로 엽니다.")
                        .font(CEFont.meta).foregroundStyle(CE.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            HStack(spacing: CESpace.m) {
                Button { Task { await load() } } label: {
                    Text(loading ? "불러오는 중입니다" : error == nil ? "미리보기 열기" : "다시 시도")
                }
                .ceProminentButton()
                .disabled(loading || unavailableReason != nil)
                if loading { ProgressView().controlSize(.small) }
                if let reason = unavailableReason {
                    Text(reason).font(CEFont.meta).foregroundStyle(CE.ink3).fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.leading, 32)
            if let error {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(CEFont.meta).foregroundStyle(CE.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 32)
            }
        }
        .padding(CESpace.l)
        // Height follows the notice; only the loaded preview reserves a tall frame.
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .recessed(radius: 14)
    }

    private func preview(_ artifact: LoadedArtifact) -> some View {
        VStack(alignment: .leading, spacing: CESpace.s) {
            HStack(spacing: CESpace.s) {
                Label("보호된 미리보기", systemImage: "lock.shield")
                    .font(CEFont.meta).foregroundStyle(CE.ink3).lineLimit(1)
                    .help("스크립트와 외부 연결을 끈 채로 그렸습니다.")
                Spacer(minLength: 8)
                Button { enlarged = true } label: {
                    Label("크게 보기", systemImage: "arrow.up.left.and.arrow.down.right")
                }
                .buttonStyle(ViewerButtonStyle())
            }
            SandboxedHTML(html: artifact.html, rule: artifact.rule)
                .frame(maxWidth: .infinity, minHeight: 520, idealHeight: wide ? 640 : 520)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay { RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(CE.line) }
                .accessibilityLabel("\(file.title) 미리보기")
        }
    }

    private func load() async {
        guard let api = store.api, !store.isDemo, !loading else { return }
        loading = true; error = nil
        defer { loading = false }
        // Fail closed: without the block rule the page is not fetched or shown at all.
        guard let rule = await artifactBlockRule() else {
            error = "보호 규칙을 준비하지 못해 미리보기를 열지 않았습니다."
            return
        }
        do {
            let html = try await api.artifact(fileID: file.id)
            loaded = LoadedArtifact(html: html, rule: rule)
            openedArtifactIDs.insert(file.id)
        } catch {
            self.error = "아티팩트를 불러오지 못했습니다. \(error.localizedDescription)"
        }
    }
}

private struct LoadedArtifact {
    let html: String
    let rule: WKContentRuleList
}

/// 크게 보기: the same protected preview in a large popup (CESheet frame, the page fills the body).
/// Mac: opens at 1180 × 840, fitted inside a smaller display; the CESheet frame follows the sheet's size. (A Mac sheet
/// opens at its minimum width, so the large width is the minimum; the height starts at its ideal and can change.)
private struct ArtifactFullView: View {
    let title: String
    let artifact: LoadedArtifact
    var body: some View {
        #if os(macOS)
        GeometryReader { proxy in sheet(width: proxy.size.width) }
            .frame(minWidth: Self.ideal.width, maxWidth: .infinity,
                   minHeight: 420, idealHeight: Self.ideal.height, maxHeight: .infinity)
        #else
        sheet(width: 520)
        #endif
    }

    private func sheet(width: CGFloat) -> some View {
        CESheet(title.isEmpty ? "제목 없는 자료" : title, icon: "macwindow", width: width, scrolls: false) {
            SandboxedHTML(html: artifact.html, rule: artifact.rule)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay { RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(CE.line) }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                #if os(iOS)
                .padding(.bottom, CESpace.l)
                #endif
                .accessibilityLabel("\(title) 미리보기")
        }
    }

    #if os(macOS)
    /// The old large size, kept inside the screen the sheet opens on.
    private static var ideal: CGSize {
        let visible = NSScreen.main?.visibleFrame.size ?? CGSize(width: 1440, height: 900)
        return CGSize(width: min(1180, visible.width - 80), height: min(840, visible.height - 60))
    }
    #endif
}

// MARK: - Attachments

/// One attachment in a message, decision or file. Loads only through the connected daemon with the access code in a header.
struct AttachmentPreview: View {
    let attachment: Attachment
    init(attachment: Attachment) { self.attachment = attachment }
    var body: some View { AttachmentView(attachment: attachment, large: false) }
}

private struct AttachmentView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.displayScale) private var displayScale
    let attachment: Attachment
    var large = false
    @State private var data: Data?
    @State private var fileURL: URL?
    @State private var image: Image?
    @State private var pixelSize: CGSize = .zero
    @State private var loading = false
    @State private var error: String?
    @State private var showText = false
    @State private var quickLook: URL?

    private var kind: String { attachmentKind(attachment) }
    private var isTextual: Bool { attachment.mime.hasPrefix("text/") || attachment.mime.contains("json") }
    private var inlinePDF: Bool { large && kind == "pdf" }
    private var displayName: String { attachment.name.isEmpty ? "이름 없는 첨부" : attachment.name }

    var body: some View {
        Group {
            if attachment.isImage { imageTile } else { fileCard }
        }
        .quickLookPreview($quickLook)
        .task(id: attachment.id) { if attachment.isImage || inlinePDF { await load() } }
    }

    // MARK: Image

    private var imageTile: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                if let fileURL { quickLook = fileURL } else { Task { await load() } }
            } label: { imageArea }
                .buttonStyle(.plain)
                .disabled(loading)
                .help(fileURL == nil ? "" : "크게 보기")
                .accessibilityLabel(fileURL == nil ? "\(displayName) 불러오기" : "\(displayName) 크게 보기")
            HStack(spacing: 6) {
                Text(displayName).lineLimit(1).truncationMode(.middle)
                Text(fileSizeText(attachment.size)).monospacedDigit().layoutPriority(1)
                Spacer(minLength: 4)
                if let fileURL {
                    ShareLink(item: fileURL) { Image(systemName: "square.and.arrow.up") }
                        .buttonStyle(.plain).foregroundStyle(CE.ink2)
                        .help("공유·저장")
                        .accessibilityLabel("\(displayName) 공유·저장")
                }
            }
            .font(CEFont.meta).foregroundStyle(CE.ink3)
            .padding(.horizontal, 2)
        }
        .padding(6)
        .fileInset()
        .frame(maxWidth: large ? .infinity : 420, alignment: .leading)
    }

    @ViewBuilder private var imageArea: some View {
        let shape = RoundedRectangle(cornerRadius: 6, style: .continuous)
        if let image {
            let scale = max(displayScale, 1)
            image.resizable().scaledToFit()
                .frame(maxWidth: pixelSize.width / scale, maxHeight: min(pixelSize.height / scale, large ? 560 : 260))
                .clipShape(shape)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        } else {
            ZStack {
                shape.fill(Color.white.opacity(0.04))
                if loading {
                    ProgressView().controlSize(.small)
                } else if let error {
                    VStack(spacing: 4) {
                        Image(systemName: "photo").foregroundStyle(CE.ink3)
                        Text(error).font(CEFont.meta).foregroundStyle(CE.ink3).multilineTextAlignment(.center)
                        if store.api != nil { Text("눌러서 다시 불러오기").font(CEFont.meta.weight(.semibold)).foregroundStyle(CE.accent) }
                    }
                    .padding(CESpace.m)
                } else if data != nil {
                    VStack(spacing: 4) {
                        Image(systemName: "photo").foregroundStyle(CE.ink3)
                        Text("여기서 그릴 수 없는 형식입니다 · 눌러서 열기").font(CEFont.meta).foregroundStyle(CE.ink3)
                    }
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: large ? 200 : 120)
            .contentShape(Rectangle())
        }
    }

    // MARK: Other files

    private var fileCard: some View {
        VStack(alignment: .leading, spacing: CESpace.s) {
            HStack(spacing: 10) {
                Image(systemName: fileKindIcon(kind)).font(CEFont.rowTitle).foregroundStyle(CE.ink3).frame(width: 20)
                VStack(alignment: .leading, spacing: 2) {
                    Text(displayName).font(CEFont.rowTitle).foregroundStyle(CE.ink).lineLimit(1).truncationMode(.middle)
                    MetaText([fileSizeText(attachment.size), attachment.mime.isEmpty || attachment.mime == "application/octet-stream" ? nil : attachment.mime])
                }
                Spacer(minLength: 6)
                actions
            }
            if inlinePDF, let data {
                PDFPreview(data: data)
                    .frame(maxWidth: .infinity, minHeight: 480, idealHeight: 640)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .accessibilityLabel("\(displayName) 미리보기")
            }
            if showText, let data, let content = String(data: data, encoding: .utf8) {
                Text(String(content.prefix(100_000)))
                    .font(CEFont.mono).foregroundStyle(CE.ink2)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(Color.black.opacity(0.25), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
            if let error {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(CEFont.meta).foregroundStyle(CE.attention)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(10)
        .fileInset()
        .frame(maxWidth: large ? .infinity : 420, alignment: .leading)
    }

    @ViewBuilder private var actions: some View {
        if loading {
            ProgressView().controlSize(.small)
        } else {
            HStack(spacing: 12) {
                if isTextual {
                    Button(showText ? "접기" : "텍스트 보기") {
                        if data == nil { Task { await load(); showText = data != nil } } else { showText.toggle() }
                    }
                }
                Button {
                    Task {
                        await load()
                        if let fileURL { quickLook = fileURL }
                    }
                } label: { Text("열기") }
                .help("원본을 받아 미리 봅니다")
                .accessibilityLabel("\(displayName) 열기")
                if let fileURL {
                    ShareLink(item: fileURL) { Image(systemName: "square.and.arrow.up") }
                        .help("공유·저장")
                        .accessibilityLabel("\(displayName) 공유·저장")
                }
            }
            .buttonStyle(.plain)
            .font(CEFont.meta.weight(.semibold))
            .foregroundStyle(CE.accent)
        }
    }

    // MARK: Loading (authenticated, same origin only)

    private func load() async {
        guard data == nil, !loading else { return }
        guard let api = store.api else {
            error = store.isDemo ? "샘플에는 원본 파일이 없습니다." : "서버 연결 후 원본을 불러올 수 있습니다."
            return
        }
        loading = true; defer { loading = false }
        do {
            let result = try await api.attachmentData(attachment)
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("IAMCEO-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let name = attachment.name.isEmpty ? "attachment" : URL(fileURLWithPath: attachment.name).lastPathComponent
            let destination = folder.appendingPathComponent(name)
            try result.write(to: destination)
            if attachment.isImage, let decoded = decodePreviewImage(result, maxPixel: large ? 2400 : 1400) {
                image = decoded.image; pixelSize = decoded.size
            }
            data = result; fileURL = destination; error = nil
        } catch { self.error = error.localizedDescription }
    }
}

/// Mirrors the server's fileKindOf for an attachment name/mime.
private func attachmentKind(_ attachment: Attachment) -> String {
    let ext = (attachment.name as NSString).pathExtension.lowercased()
    let mime = attachment.mime.lowercased()
    if ["md", "markdown"].contains(ext) { return "document" }
    if ["html", "htm"].contains(ext) { return "artifact" }
    if ext == "pdf" || mime == "application/pdf" { return "pdf" }
    if ["csv", "tsv"].contains(ext) { return "table" }
    if codeExtensions.contains(ext) { return "code" }
    if ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "heif", "tif", "tiff"].contains(ext) || mime.hasPrefix("image/") { return "image" }
    if ["mp4", "mov", "webm", "m4v", "mkv", "avi"].contains(ext) || mime.hasPrefix("video/") { return "video" }
    if ["mp3", "wav", "m4a", "aac", "ogg", "flac", "opus"].contains(ext) || mime.hasPrefix("audio/") { return "audio" }
    if mime == "text/html" { return "artifact" }
    if mime == "text/csv" || mime == "text/tab-separated-values" { return "table" }
    if mime.hasPrefix("text/") || mime == "application/json" { return "code" }
    return "file"
}

private let codeExtensions: Set<String> = ["json", "jsonl", "ndjson", "txt", "log", "yaml", "yml", "toml", "xml", "ini", "conf", "sh", "bash", "zsh", "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sql", "css", "scss", "diff", "patch"]

/// The attachment is the file itself (web `matches`): images by flag, everything else by name/mime.
private func attachmentMatches(_ attachment: Attachment, kind: String) -> Bool {
    kind == "image" ? attachment.isImage : attachmentKind(attachment) == kind
}

private func fileSizeText(_ size: Int) -> String {
    if size < 1024 { return "\(size) B" }
    if size < 1024 * 1024 { return "\(Int((Double(size) / 1024).rounded())) KB" }
    return String(format: "%.1f MB", Double(size) / (1024 * 1024))
}

/// Downsampled decode so a thread full of screenshots does not hold full-size bitmaps.
private func decodePreviewImage(_ data: Data, maxPixel: Int) -> (image: Image, size: CGSize)? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: maxPixel
    ]
    guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
    return (Image(decorative: cgImage, scale: 1), CGSize(width: cgImage.width, height: cgImage.height))
}

@MainActor private func copyToPasteboard(_ text: String) {
    #if os(macOS)
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
    #else
    UIPasteboard.general.string = text
    #endif
}

/// Wrapping row of chips for narrow panes.
private struct ChipFlow: Layout {
    var spacing: CGFloat = 6
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let limit = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > limit { y += rowHeight + spacing; x = 0; rowHeight = 0 }
            widest = max(widest, x + size.width)
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: proposal.width ?? widest, height: y + rowHeight)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX { y += rowHeight + spacing; x = bounds.minX; rowHeight = 0 }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

private extension View {
    /// Quiet surface for attachment tiles and cards (shared with Chat and Inbox). Not glass.
    func fileInset(radius: CGFloat = CERadius.control) -> some View {
        background(Color.black.opacity(0.2), in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(CE.line) }
    }

    /// Deep well for source-like blocks in the reader (web .fl-path, .vw-code__scroll: rgb(5 4 11 / .5)). Not glass.
    func recessed(radius: CGFloat = CERadius.control, opacity: Double = 0.5) -> some View {
        background(CE.bgDeep.opacity(opacity), in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(CE.line) }
    }
}

/// Web .vw-btn: small rounded button in a viewer bar; `on` draws a toggle that is on as a violet drop.
private struct ViewerButtonStyle: ButtonStyle {
    var on = false
    func makeBody(configuration: Configuration) -> some View { ViewerBody(configuration: configuration, on: on) }
    private struct ViewerBody: View {
        let configuration: ButtonStyleConfiguration
        let on: Bool
        @Environment(\.isEnabled) private var isEnabled
        @State private var hovering = false
        var body: some View {
            let shape = RoundedRectangle(cornerRadius: isMac ? 8 : 11, style: .continuous)
            configuration.label
                .font(isMac ? .system(size: 12, weight: .semibold) : CEFont.secondary.weight(.semibold))
                .lineLimit(1)
                .foregroundStyle(!isEnabled ? CE.ink3 : on ? Color.white : CE.ink)
                .padding(.horizontal, isMac ? 10 : 13)
                .frame(height: isMac ? 26 : 34)
                .background(on ? CE.violet.opacity(0.42) : Color.white.opacity(configuration.isPressed ? 0.14 : hovering ? 0.11 : 0.07), in: shape)
                .overlay { shape.strokeBorder(Color.white.opacity(0.1)) }
                // iPhone: 44pt touch target around the 34pt button.
                .padding(.vertical, isMac ? 0 : 5)
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
        }
    }
}

#if os(macOS)
private struct PDFPreview: NSViewRepresentable {
    let data: Data
    func makeNSView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.backgroundColor = .clear
        view.document = PDFDocument(data: data)
        return view
    }
    func updateNSView(_ nsView: PDFView, context: Context) {}
}
#else
private struct PDFPreview: UIViewRepresentable {
    let data: Data
    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.backgroundColor = .clear
        view.document = PDFDocument(data: data)
        return view
    }
    func updateUIView(_ uiView: PDFView, context: Context) {}
}
#endif

// MARK: - Sandboxed artifact web view (security settings must not change)

/// WebKit's URL-filter regex subset does not support disjunction. Keep each scheme family separate.
/// CSP still limits resources to inline styles and data images/fonts; these rules also block FTP(S).
func artifactBlockRuleJSON() -> String {
    #"""
    [
        {"trigger":{"url-filter":"^https?:"},"action":{"type":"block"}},
        {"trigger":{"url-filter":"^wss?:"},"action":{"type":"block"}},
        {"trigger":{"url-filter":"^file:"},"action":{"type":"block"}},
        {"trigger":{"url-filter":"^ftps?:"},"action":{"type":"block"}}
    ]
    """#
}

/// Compiled once per app run. Stays nil when WebKit refuses the rule, and then no artifact is shown.
@MainActor private var compiledArtifactRule: WKContentRuleList?

/// The HTTP(S)/WS(S)/file/FTP(S) block layer. nil means compilation failed: callers must not render.
@MainActor
private func artifactBlockRule() async -> WKContentRuleList? {
    if let compiledArtifactRule { return compiledArtifactRule }
    let rules = artifactBlockRuleJSON()
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "IAMCEOIsolatedArtifact", encodedContentRuleList: rules) { rule, error in
            if let error {
                NSLog("[IAMCEO] Artifact content rule compilation failed: %@", error as NSError)
            } else if rule == nil {
                NSLog("[IAMCEO] Artifact content rule compilation returned neither a rule nor an error")
            }
            if let rule { compiledArtifactRule = rule }
            continuation.resume()
        }
    }
    return compiledArtifactRule
}

/// Only loadHTMLString's first main-frame document may navigate. No URL is opened by this policy.
func artifactAllowsNavigation(firstAction: Bool, url: URL?, mainFrame: Bool, type: WKNavigationType) -> Bool {
    firstAction && mainFrame && type == .other && url?.absoluteString == "about:blank"
}

@MainActor
private final class ArtifactNavigationDelegate: NSObject, WKNavigationDelegate, WKUIDelegate {
    private var firstAction = true
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let allow = artifactAllowsNavigation(firstAction: firstAction, url: navigationAction.request.url,
            mainFrame: navigationAction.targetFrame?.isMainFrame == true, type: navigationAction.navigationType)
        firstAction = false
        decisionHandler(allow ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
}

/// Requires the compiled block layer before loading any artifact HTML.
@MainActor
private func makeArtifactWebView(html: String, rule: WKContentRuleList, delegate: ArtifactNavigationDelegate) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.defaultWebpagePreferences.allowsContentJavaScript = false
    configuration.userContentController.add(rule)
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = delegate
    view.uiDelegate = delegate
    let policy = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'\">"
    view.loadHTMLString(policy + html, baseURL: nil)
    return view
}
#if os(macOS)
private struct SandboxedHTML: NSViewRepresentable {
    let html: String
    let rule: WKContentRuleList
    func makeCoordinator() -> ArtifactNavigationDelegate { ArtifactNavigationDelegate() }
    func makeNSView(context: Context) -> WKWebView { makeArtifactWebView(html: html, rule: rule, delegate: context.coordinator) }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
#else
private struct SandboxedHTML: UIViewRepresentable {
    let html: String
    let rule: WKContentRuleList
    func makeCoordinator() -> ArtifactNavigationDelegate { ArtifactNavigationDelegate() }
    func makeUIView(context: Context) -> WKWebView { makeArtifactWebView(html: html, rule: rule, delegate: context.coordinator) }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
#endif
