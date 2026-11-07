import SwiftUI
import WebKit
import PDFKit
import QuickLook
import ImageIO
import AVKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

// 자료 (web Files): wide (Mac, iPad regular) = a 300pt list beside the reader, both on glass plates and scrolling on
// their own; iPhone = list → pushed reader on a glass panel. Rows follow the web .fl-row: title, two lines of summary,
// kind tag · who · time, and the first picture as a thumbnail on the right. Links and the original path live in the
// reader; each kind has its own viewer (code, table, pictures, PDF, video/audio, file cards).
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
    @FocusState private var searchFocused: Bool
    #if os(macOS)
    /// The list takes ↑/↓ once a row was clicked (Mail-style paging through the reader).
    @FocusState private var listFocused: Bool
    #endif

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
            .ceContentColumn()
        }
    }

    private var emptyLibrary: some View {
        ScrollView {
            EmptyTile(icon: "folder", title: "아직 올린 자료가 없습니다", detail: "직원이 자료를 올리면 여기에 모입니다.")
                .ceContentColumn()
        }
        #if os(iOS)
        .refreshable { await store.refresh() }
        #endif
    }

    // MARK: Wide: 300pt list + reader

    /// Web .shell__column around .fl--desk: 24 at the sides inside a 1180 cap (1480 while an artifact is open, so only
    /// the reader grows), and the panels stop well clear of the docked composer.
    private var desk: some View {
        HStack(alignment: .top, spacing: 12) {
            listPane.frame(width: 300)
            readerPane
        }
        .padding(.horizontal, isMac ? 24 : CESpace.l)
        .frame(maxWidth: selectedFile?.kind == "artifact" ? 1480 : 1180)
        .padding(.top, CESpace.m)
        .padding(.bottom, isMac ? 24 : CESpace.l)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private var listPane: some View {
        let selectedID = selectedFile?.id
        let counts = openDecisionsByFile
        return Plate(padding: 0) {
            VStack(spacing: 0) {
                if showsSearch || showsChips {
                    // web .fl-chips: 10 at the top and sides, 4 below; the list's own 6 makes the gap to the first row.
                    VStack(alignment: .leading, spacing: CESpace.s) {
                        if showsSearch { searchField }
                        if showsChips {
                            // The list is narrow: chips wrap so every kind stays in view (web .fl-chips).
                            ChipFlow(spacing: 6) { chipButtons }
                                .accessibilityElement(children: .contain)
                                .accessibilityLabel("종류로 거르기")
                        }
                    }
                    .padding(.horizontal, 10).padding(.top, 10).padding(.bottom, 4)
                }
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(shown) { file in
                                let selected = file.id == selectedID
                                Button {
                                    router.fileID = file.id
                                    #if os(macOS)
                                    listFocused = true
                                    #endif
                                } label: {
                                    FileRow(file: file, openDecisions: counts[file.id] ?? 0, selected: selected)
                                }
                                // web .fl-row: radius 15, hover white .06, the selected row is the rail's violet drop.
                                .buttonStyle(RowButtonStyle(selected: selected, radius: 15))
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
                    #if os(macOS)
                    .focusable()
                    .focusEffectDisabled()
                    .focused($listFocused)
                    .onKeyPress(.upArrow) { step(-1) }
                    .onKeyPress(.downArrow) { step(1) }
                    #endif
                }
            }
            .frame(maxHeight: .infinity, alignment: .top)
        }
        .clipShape(RoundedRectangle(cornerRadius: CERadius.plate, style: .continuous))
    }

    #if os(macOS)
    /// ↑/↓ in the focused list: the previous or next visible file (the list scrolls to it through `router.fileID`).
    private func step(_ delta: Int) -> KeyPress.Result {
        let ids = shown.map(\.id)
        guard !ids.isEmpty else { return .ignored }
        let current = selectedFile.flatMap { file in ids.firstIndex(of: file.id) }
        let next = current.map { min(max($0 + delta, 0), ids.count - 1) } ?? 0
        if next != current { router.fileID = ids[next] }
        return .handled
    }
    #endif

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
                                if index > 0 { RowDivider(inset: 14) }
                                Button { router.fileID = file.id } label: {
                                    FileRow(file: file, openDecisions: counts[file.id] ?? 0, chevron: true)
                                }
                                .buttonStyle(RowButtonStyle(radius: 0))
                            }
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: CERadius.plate, style: .continuous))
                }
            }
            .ceContentColumn(top: CESpace.s)
        }
        #if os(iOS)
        .refreshable { await store.refresh() }
        #endif
    }

    // MARK: Pieces

    /// Web .input (the shared field: 44 tall, 15pt, accent ring while typing).
    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").font(.system(size: 13, weight: .medium)).foregroundStyle(CE.ink3)
            TextField("제목·요약·작성자 검색", text: $search)
                .focused($searchFocused)
                .autocorrectionDisabled()
            if !search.isEmpty {
                Button { search = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(CE.ink3) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("검색 지우기")
            }
        }
        .ceField(focused: searchFocused)
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

    /// Web .fl-chip: quiet capsule that lightens on hover; the chosen one is a violet drop with white text.
    private func chip(_ value: String?, title: String, count: Int) -> some View {
        let on = activeKind == value
        return Button { kind = value } label: {
            HStack(spacing: 5) {
                Text(title)
                Text("\(count)").monospacedDigit().opacity(0.85)
            }
        }
        .buttonStyle(FilterChipStyle(on: on))
        .accessibilityLabel("\(title) \(count)개")
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private var noMatch: some View {
        CompactEmpty(icon: "magnifyingglass", title: "맞는 자료가 없습니다", detail: "검색어나 종류를 바꿔 보세요.")
    }
}

// MARK: - List row

/// Web .fl-row: title (14.5/600 at 1.35), up to two lines of summary (13 at 1.45, ink-2), then the kind tag · who ·
/// time; the first picture sits on the right as a 52pt thumbnail. An open decision that cites the file is the one
/// extra fact a row carries.
private struct FileRow: View {
    let file: FileDoc
    var openDecisions = 0
    var selected = false
    var chevron = false

    private var title: String { file.title.isEmpty ? "제목 없는 자료" : file.title }
    private var imageAttachment: Attachment? { file.attachments.first(where: \.isImage) }
    private var byline: String { [file.who, fileTime(file.createdAt)].filter { !$0.isEmpty }.joined(separator: " · ") }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(CEFont.rowTitle).tracking(-0.15).foregroundStyle(CE.ink)
                        .lineSpacing(CELeading.spacing(14.5, 1.35))
                        .lineLimit(2).multilineTextAlignment(.leading)
                    if !file.summary.isEmpty {
                        Text(file.summary)
                            .font(CEFont.secondary).foregroundStyle(CE.ink2)
                            .lineSpacing(CELeading.secondary)
                            .lineLimit(2).multilineTextAlignment(.leading)
                    }
                    // web .fl-row__meta: wraps under the tag when the name and time do not fit beside it.
                    ChipFlow(spacing: 7, lineSpacing: 3) {
                        KindTag(kind: file.kind)
                        Text(byline).font(CEFont.meta).foregroundStyle(CE.ink2).lineLimit(1)
                        if openDecisions > 0 { Tag("결재 \(openDecisions)", tone: .attention) }
                    }
                    .padding(.top, 2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if let imageAttachment { RowThumb(attachment: imageAttachment) }
            }
            if chevron {
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(CE.ink3)
            }
        }
        .padding(.horizontal, chevron ? 14 : 12)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var accessibilityText: String {
        var parts = [fileKindName(file.kind), title, file.summary, file.who, relativeTime(file.createdAt)]
        if openDecisions > 0 { parts.append("결재 \(openDecisions)건 대기") }
        return parts.filter { !$0.isEmpty }.joined(separator: ", ")
    }
}

/// Web .fl-row__thumb: the file's first picture, 52pt square, cover, on a dark well.
private struct RowThumb: View {
    @Environment(AppStore.self) private var store
    let attachment: Attachment
    @State private var thumb: Image?

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        shape.fill(CE.bgDeep.opacity(0.5))
            .frame(width: 52, height: 52)
            .overlay {
                if let thumb {
                    thumb.resizable().scaledToFill()
                } else {
                    Image(systemName: "photo").font(.system(size: 15)).foregroundStyle(CE.ink3)
                }
            }
            .clipShape(shape)
            .task(id: attachment.id) { await loadThumb() }
            .accessibilityHidden(true)
    }

    private func loadThumb() async {
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

#if os(iOS)
/// iPhone push target. Looks the file up live so polling updates (and removals) show.
private struct FileDetailScreen: View {
    @Environment(AppStore.self) private var store
    let fileID: String
    var body: some View {
        let file = store.files.first { $0.id == fileID }
        Group {
            if let file {
                // web .fl-panel--phone: the reader sits on a glass panel, not straight on the aurora.
                FileReader(file: file, framed: true)
            } else {
                ScrollView {
                    EmptyTile(icon: "questionmark.folder", title: "찾을 수 없는 자료입니다", detail: "목록에서 다시 골라 주세요.")
                        .ceContentColumn()
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
    /// iPhone: the reader draws its own glass panel (web .fl-panel--phone); the desk puts it in the reader plate.
    var framed = false
    init(file: FileDoc, framed: Bool = false) { self.file = file; self.framed = framed }
    var body: some View {
        // A different file starts from the top with fresh viewer state (gate, loaded originals, sort).
        FileReaderContent(file: file, framed: framed).id(file.id)
    }
}

/// Visible height of the reader, for the viewers' height caps (the web's vh limits on pictures, tables, PDF, video).
private struct ReaderViewportKey: EnvironmentKey { static let defaultValue: CGFloat = 0 }
private extension EnvironmentValues {
    var readerViewport: CGFloat {
        get { self[ReaderViewportKey.self] }
        set { self[ReaderViewportKey.self] = newValue }
    }
}

/// `fraction` of the reader's visible height, kept between `floor` and `cap` (web min(Nvh, cap)).
private func viewportLimit(_ viewport: CGFloat, _ fraction: CGFloat, cap: CGFloat, floor: CGFloat = 240) -> CGFloat {
    min(cap, max(floor, (viewport > 0 ? viewport : 760) * fraction))
}

/// Web .fl-doc: meta (kind tag · who · time), title 22 (artifact 19), summary 15, links, path box, then the viewer,
/// every block 12 apart (artifact 8, with a tighter frame so the page gets the width).
private struct FileReaderContent: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.ceWide) private var wide
    let file: FileDoc
    var framed = false
    @State private var copiedPath = false
    /// The protected artifact preview once opened. The reader holds it so 크게 보기 can sit beside the title (web
    /// .afr-bar); it is only ever set together with the compiled block rule (see `ArtifactViewer.load`).
    @State private var artifact: LoadedArtifact?
    @State private var enlarged = false
    @State private var viewport: CGFloat = 0

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
            if framed {
                Plate(padding: 0) { column }
                    .padding(.horizontal, 14).padding(.top, 6).padding(.bottom, 28)
            } else {
                column
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewport = $0 }
        .environment(\.readerViewport, viewport)
    }

    private var column: some View {
        VStack(alignment: .leading, spacing: isArtifact ? 8 : 12) {
            header
            if !relatedDecisions.isEmpty || !relatedMessages.isEmpty { related.padding(.horizontal, isArtifact ? 6 : 0) }
            if let path, !isArtifact { pathBox(path) }
            content
            // An artifact leads with its page (web hides the path); where it lives on the host comes last.
            if let path, isArtifact { pathBox(path) }
        }
        .frame(maxWidth: readingWidth, alignment: .leading)
        .padding(.horizontal, horizontalPadding)
        .padding(.top, topPadding)
        .padding(.bottom, bottomPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // web .fl-doc 22 26 28 (artifact 16 14 16); phone 18 16 22 (artifact 14 8 10).
    private var horizontalPadding: CGFloat { isArtifact ? (wide ? 14 : 8) : (wide ? 26 : 16) }
    private var topPadding: CGFloat { isArtifact ? (wide ? 16 : 14) : (wide ? 22 : 18) }
    private var bottomPadding: CGFloat { isArtifact ? (wide ? 16 : 10) : (wide ? 28 : 22) }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: isArtifact ? 8 : 12) {
            HStack(spacing: 8) {
                KindTag(kind: file.kind)
                whoLabel
                timeLabel
                Spacer(minLength: 0)
            }
            .padding(.trailing, enlargeReserve)
            Text(file.title.isEmpty ? "제목 없는 자료" : file.title)
                .font(titleFont).tracking(isArtifact ? -0.34 : -0.4).foregroundStyle(CE.ink)
                .lineSpacing(CELeading.spacing(isArtifact ? 19 : 22, 1.3))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.trailing, enlargeReserve)
                .accessibilityAddTraits(.isHeader)
            if !file.summary.isEmpty {
                Text(file.summary)
                    .font(summaryFont).foregroundStyle(CE.ink).lineSpacing(CELeading.spacing(15, 1.6))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, isArtifact ? 6 : 0)
        .overlay(alignment: .topTrailing) {
            // web .afr-bar: the open page's 크게 보기 sits at the top right, beside the meta line and title.
            if isArtifact, artifact != nil {
                Button { enlarged = true } label: {
                    Label("크게 보기", systemImage: "arrow.up.left.and.arrow.down.right")
                }
                .buttonStyle(ViewerButtonStyle())
                .help("보호된 미리보기 · 스크립트와 외부 연결을 끈 채로 그렸습니다")
                .accessibilityHint("보호된 미리보기를 크게 엽니다")
                .offset(y: isMac ? -4 : -8)
            }
        }
    }

    /// Room beside the meta line and title for the 크게 보기 button (web padding-right 112).
    private var enlargeReserve: CGFloat { isArtifact && artifact != nil ? 106 : 0 }

    private var metaFont: Font { isMac ? .system(size: 13) : CEFont.secondary }

    /// web Time: "14:20", "11월 4일 14:20", tabular, the full date on hover.
    @ViewBuilder private var timeLabel: some View {
        let text = fileTime(file.createdAt)
        if !text.isEmpty {
            Text(text).font(metaFont).foregroundStyle(CE.ink2).monospacedDigit().lineLimit(1)
                .help(parseISODate(file.createdAt).map(koDateTime) ?? "")
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
                Text(name).font(metaFont.weight(.semibold)).foregroundStyle(CE.ink).lineLimit(1)
                    // iPhone: a 44pt touch target without making the meta line taller.
                    .padding(.vertical, isMac ? 0 : 12).contentShape(Rectangle()).padding(.vertical, isMac ? 0 : -12)
            }
            .buttonStyle(.plain)
            .help("팀에서 보기")
            .accessibilityHint("팀에서 엽니다")
        } else if !name.isEmpty {
            Text(name).font(metaFont.weight(.semibold)).foregroundStyle(CE.ink).lineLimit(1)
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

    /// Web .fl-path: the whole path wraps (12.5 mono at 1.45) beside a 복사 button that lightens on hover.
    private func pathBox(_ path: String) -> some View {
        HStack(spacing: 4) {
            Text(path)
                .font(CEFont.mono).foregroundStyle(CE.ink2)
                .lineSpacing(CELeading.spacing(12.5, 1.45))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 7)
                .help(path)
            Button {
                copyToPasteboard(path)
                copiedPath = true
                Task { try? await Task.sleep(for: .seconds(2)); copiedPath = false }
            } label: {
                Text(copiedPath ? "복사됨" : "복사")
                    .font(isMac ? .system(size: 13, weight: .semibold) : CEFont.secondary.weight(.semibold))
                    .foregroundStyle(copiedPath ? CE.success : CE.ink)
                    .padding(.horizontal, 8)
                    .frame(minWidth: 52, minHeight: isMac ? 36 : 44)
            }
            .buttonStyle(HoverFillStyle(radius: 10, hover: 0.08))
            .accessibilityLabel(copiedPath ? "원본 경로를 복사함" : "원본 경로 복사")
        }
        .padding(.leading, 12).padding(.trailing, 4)
        .recessed()
    }

    // MARK: Body by kind

    @ViewBuilder private var content: some View {
        switch file.kind {
        case "document":
            // Documents keep their attachments above the text (web order).
            AttachmentGroup(items: file.attachments)
            prose
        case "artifact":
            ArtifactViewer(file: file, loaded: $artifact, enlarged: $enlarged)
                // web: the frame sits 4 below the block above (10 under a summary).
                .padding(.top, artifact == nil ? 0 : file.summary.isEmpty ? 4 : 10)
            AttachmentGroup(items: extraAttachments)
            prose
        case "code":
            if !file.body.isEmpty || !mainAttachments.isEmpty {
                RawTextSource(file: file, attachment: mainAttachments.first, loadingText: "내용을 불러오는 중입니다") { text, truncated in
                    CodeBlock(file: file, attachment: mainAttachments.first, text: text, truncated: truncated)
                }
            }
            // The original is the viewer above (받기 is in its bar); only the other attachments follow.
            AttachmentGroup(items: extraAttachments)
        case "table":
            if !file.body.isEmpty || !mainAttachments.isEmpty {
                RawTextSource(file: file, attachment: mainAttachments.first, loadingText: "표를 불러오는 중입니다") { text, truncated in
                    TableBlock(file: file, attachment: mainAttachments.first, text: text, truncated: truncated, tabSeparated: isTabSeparated)
                }
            }
            AttachmentGroup(items: extraAttachments)
        case "image":
            if mainAttachments.count == 1, let only = mainAttachments.first {
                SingleImage(attachment: only)
            } else if mainAttachments.count > 1 {
                ImageGallery(attachments: mainAttachments)
            }
            AttachmentGroup(items: extraAttachments)
            prose
        case "pdf":
            ForEach(mainAttachments) { PDFBlock(attachment: $0) }
            AttachmentGroup(items: extraAttachments)
            prose
        case "video", "audio":
            ForEach(mainAttachments) { MediaBlock(attachment: $0, video: file.kind == "video") }
            AttachmentGroup(items: extraAttachments)
            prose
        default:
            // file and kinds this build does not know yet: one card per original (web .vw-card).
            ForEach(mainAttachments + extraAttachments) { FileCard(attachment: $0) }
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
    /// hairline like the web .fl-doc__body (18 below the block above: gap 12 + margin 6, then 16 to the text).
    @ViewBuilder private var prose: some View {
        let text = markdownBody
        if !text.isEmpty {
            MarkdownText(text: text)
                .padding(.top, CESpace.l)
                .overlay(alignment: .top) { Rectangle().fill(CE.line).frame(height: 1) }
                .padding(.top, 6)
        }
    }
}

/// Web .fl-kind: 11.5/600 label on a 6pt rounded fill, about 19 tall; artifacts are violet.
private struct KindTag: View {
    let kind: String
    var body: some View {
        Text(fileKindName(kind))
            .font(isMac ? .system(size: 11.5, weight: .semibold) : .caption2.weight(.semibold))
            .foregroundStyle(kind == "artifact" ? Color.white : CE.ink)
            .padding(.horizontal, 7)
            .frame(minHeight: 19)
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
            ViewerNote(text: failure, bad: true)
        } else {
            ViewerNote(text: loadingText, loading: true)
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
        // At least three digits wide, like the web's 5ch gutter.
        digits = max(3, String(lines.count).count)
    }
    /// Padded so every chunk's number column has the same width.
    func number(_ index: Int) -> String {
        let value = String(index + 1)
        return String(repeating: " ", count: max(0, digits - value.count)) + value
    }
    /// Very tall single Text views render poorly; draw in chunks.
    var chunks: [Range<Int>] { stride(from: 0, to: lines.count, by: 200).map { $0..<min($0 + 200, lines.count) } }
    /// One chunk's code. A chunk ending in an empty line keeps that line's height (a Text drops a trailing newline).
    func text(_ range: Range<Int>) -> String {
        let joined = lines[range].joined(separator: "\n")
        return lines[range].last?.isEmpty == true ? joined + " " : joined
    }
}

/// web .vw-code ol: 12.5 mono at line-height 1.6.
private let codeLeading = CELeading.spacing(12.5, 1.6)
/// web .vw-code li::before: the line-number column's own dark strip.
private let codeGutterFill = Color(hex: 0x0A0817)

/// Web CodeViewer: a bar (line count · 줄바꿈 · 복사 · 받기), then the source with a fixed line-number column.
private struct CodeBlock: View {
    @Environment(\.ceWide) private var wide
    let file: FileDoc
    let attachment: Attachment?
    let text: String
    let truncated: Bool
    @State private var wrapChoice: Bool?
    @State private var copied = false
    @State private var prepared: CodeLines?
    /// Height of each drawn code chunk, so the fixed number column stays level with it.
    @State private var chunkHeights: [Int: CGFloat] = [:]
    /// Width of the number column in the wrapped layout (for its dark strip).
    @State private var gutterWidth: CGFloat = 0

    /// Phone wraps by default; desk scrolls sideways.
    private var wrap: Bool { wrapChoice ?? !wide }

    var body: some View {
        let model = prepared ?? (text.utf8.count <= 200_000 ? CodeLines(text) : nil)
        VStack(alignment: .leading, spacing: 8) {
            ViewerBar(text: model.map(countLine) ?? "") {
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
                SaveButton(attachment: attachment, text: attachment == nil ? text : nil, name: saveName, label: saveLabel(model))
            }
            Group {
                if let model {
                    if wrap { wrapped(model) } else { scrolling(model) }
                } else {
                    ViewerNote(text: "내용을 정리하는 중입니다", loading: true).padding(.horizontal, 12)
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

    /// The original's name, or the title as a .txt when the source came only as text (web saveText).
    private var saveName: String {
        if let attachment, !attachment.name.isEmpty { return attachment.name }
        let title = file.title.isEmpty ? "코드" : file.title
        return title.replacing(#/[\\/:*?"<>|]/#, with: " ") + ".txt"
    }

    private func saveLabel(_ model: CodeLines?) -> String {
        guard let attachment else { return "받기" }
        let cut = truncated || (model.map { $0.total > $0.lines.count } ?? false)
        return cut ? "전체 받기 (\(fileSizeText(attachment.size)))" : "받기"
    }

    /// Sideways scrolling; the number column stays put beside it (web: a sticky column).
    private func scrolling(_ model: CodeLines) -> some View {
        HStack(alignment: .top, spacing: 0) {
            VStack(alignment: .trailing, spacing: codeLeading) {
                ForEach(model.chunks, id: \.lowerBound) { range in
                    Text(range.map(model.number).joined(separator: "\n"))
                        .lineSpacing(codeLeading)
                        .frame(height: chunkHeights[range.lowerBound], alignment: .top)
                }
            }
            .foregroundStyle(CE.ink3)
            .padding(.leading, 6).padding(.trailing, 9).padding(.vertical, 10)
            .frame(maxHeight: .infinity, alignment: .top)
            .background(codeGutterFill)
            .accessibilityHidden(true)
            ScrollView(.horizontal) {
                VStack(alignment: .leading, spacing: codeLeading) {
                    ForEach(model.chunks, id: \.lowerBound) { range in
                        Text(model.text(range))
                            .lineSpacing(codeLeading)
                            .foregroundStyle(CE.ink)
                            .textSelection(.enabled)
                            .fixedSize()
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                                if abs((chunkHeights[range.lowerBound] ?? 0) - height) > 0.5 { chunkHeights[range.lowerBound] = height }
                            }
                    }
                }
                .padding(.leading, 4).padding(.trailing, 14).padding(.vertical, 10)
            }
        }
        .font(CEFont.mono)
    }

    private func wrapped(_ model: CodeLines) -> some View {
        LazyVStack(alignment: .leading, spacing: codeLeading) {
            ForEach(Array(model.lines.enumerated()), id: \.offset) { index, line in
                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    Text(model.number(index)).foregroundStyle(CE.ink3)
                        .padding(.leading, 6).padding(.trailing, 9)
                        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
                            if abs(gutterWidth - width) > 0.5 { gutterWidth = width }
                        }
                        .accessibilityHidden(true)
                    Text(line.isEmpty ? " " : line)
                        .foregroundStyle(CE.ink)
                        .lineSpacing(codeLeading)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.leading, 4).padding(.trailing, 14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .font(CEFont.mono)
        .textSelection(.enabled)
        .padding(.vertical, 10)
        .background(alignment: .leading) { codeGutterFill.frame(width: gutterWidth) }
    }
}

// MARK: Table (csv / tsv)

private let tableColumnLimit = 30
/// Rows drawn at once (web TABLE_ROW_LIMIT). Sorting uses every row read, then draws the first of them.
private let tableRowLimit = 500

private struct ParsedTable {
    var header: [String]
    var rows: [[String]]
    var hiddenColumns: Int
    var numeric: [Bool]
}

/// web .vw-table: 13.5 cells at 1.45, 13/650 header. iPhone follows the text size setting.
@MainActor private var tableCellSize: CGFloat {
    #if os(macOS)
    13.5
    #else
    UIFontMetrics(forTextStyle: .footnote).scaledValue(for: 13.5)
    #endif
}
@MainActor private var tableHeadSize: CGFloat {
    #if os(macOS)
    13
    #else
    UIFontMetrics(forTextStyle: .footnote).scaledValue(for: 13)
    #endif
}

/// Web TableViewer: a bar (rows · columns · 받기), then a bounded scroll box whose header row stays in view. Columns
/// are as wide as their text up to 420 (longer text wraps); numbers line up on the right in tabular digits.
private struct TableBlock: View {
    @Environment(\.readerViewport) private var viewport
    let file: FileDoc
    let attachment: Attachment?
    let text: String
    let truncated: Bool
    let tabSeparated: Bool
    @State private var parsed: ParsedTable?
    @State private var sort: (column: Int, ascending: Bool)?
    @State private var sortedRows: [[String]]?
    /// Column widths measured from the header and the first rows.
    @State private var widths: [CGFloat]?
    @State private var boxWidth: CGFloat = 0
    /// Taller than its cap: the box scrolls vertically too and the header row stays pinned.
    @State private var tall = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let table = parsed {
                ViewerBar(text: summary(table)) {
                    if let attachment {
                        SaveButton(attachment: attachment, name: attachment.name,
                                   label: cut(table) ? "전체 받기 (\(fileSizeText(attachment.size)))" : "받기")
                    }
                }
                if table.header.isEmpty {
                    ViewerNote(text: "비어 있는 표입니다")
                } else if let widths {
                    grid(table, widths: fill(widths))
                } else {
                    ViewerNote(text: "표를 정리하는 중입니다", loading: true)
                }
            }
        }
        .task(id: text.utf8.count) { await prepare() }
    }

    private func prepare() async {
        let table = parsed ?? parseTable(text, tab: tabSeparated, truncated: truncated)
        parsed = table
        tall = table.rows.count > 40
        guard widths == nil, !table.header.isEmpty else { return }
        let header = table.header, numeric = table.numeric
        let sample = Array(table.rows.prefix(1500))
        let cellSize = tableCellSize, headSize = tableHeadSize
        if sample.count * header.count <= 4000 {
            widths = measureTableColumns(header: header, rows: sample, numeric: numeric, cellSize: cellSize, headSize: headSize)
        } else {
            widths = await Task.detached(priority: .userInitiated) {
                measureTableColumns(header: header, rows: sample, numeric: numeric, cellSize: cellSize, headSize: headSize)
            }.value
        }
    }

    private func summary(_ table: ParsedTable) -> String {
        var line = truncated ? "앞부분 \(table.rows.count.formatted())행" : "\(table.rows.count.formatted())행"
        line += " · \(table.header.count)열"
        if table.rows.count > tableRowLimit { line += " · 앞 \(tableRowLimit.formatted())행만 표시" }
        if table.hiddenColumns > 0 { line += " · 전체 \(table.header.count + table.hiddenColumns)열 중 앞 \(table.header.count)열만 표시" }
        return line
    }

    private func cut(_ table: ParsedTable) -> Bool { truncated || table.rows.count > tableRowLimit || table.hiddenColumns > 0 }

    /// A narrow table still spans the box (web min-width 100%): the spare width is shared out by column width.
    private func fill(_ widths: [CGFloat]) -> [CGFloat] {
        let total = widths.reduce(0, +)
        let room = boxWidth - 2
        guard total > 0, room > total else { return widths }
        return widths.map { ($0 * room / total).rounded(.down) }
    }

    private func grid(_ table: ParsedTable, widths: [CGFloat]) -> some View {
        let rows = Array((sortedRows ?? table.rows).prefix(tableRowLimit))
        // web max-height min(72vh, 780px).
        let cap = viewportLimit(viewport, 0.9, cap: 780, floor: 260)
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        let cellSize = tableCellSize
        return ScrollView(tall ? [.horizontal, .vertical] : .horizontal) {
            // Pinned only while the box scrolls itself (web th sticky inside .vw-table__scroll).
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: tall ? [.sectionHeaders] : []) {
                Section {
                    ForEach(rows.indices, id: \.self) { index in
                        TableRowView(cells: rows[index], widths: widths, numeric: table.numeric,
                                     last: index == rows.count - 1, cellSize: cellSize)
                    }
                } header: {
                    headerRow(table, widths: widths)
                }
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                if height > cap + 1, !tall { tall = true }
            }
        }
        .frame(height: tall ? cap : nil)
        .scrollBounceBehavior(.basedOnSize)
        .background(CE.bgDeep.opacity(0.5))
        .clipShape(shape)
        .overlay { shape.strokeBorder(CE.line) }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
            if abs(boxWidth - width) > 0.5 { boxWidth = width }
        }
    }

    /// web th button: 13/650 ink-1 on #1a1533, a hairline below, and an always-reserved slot for the sort arrow so
    /// the column does not jump when it is sorted.
    private func headerRow(_ table: ParsedTable, widths: [CGFloat]) -> some View {
        HStack(spacing: 0) {
            ForEach(table.header.indices, id: \.self) { index in
                let title = table.header[index].isEmpty ? "열 \(index + 1)" : table.header[index]
                let numeric = table.numeric[index]
                let sorted = sort?.column == index ? sort?.ascending : nil
                Button { toggleSort(index, table: table) } label: {
                    HStack(spacing: 5) {
                        if numeric { Spacer(minLength: 0) }
                        Text(title).lineLimit(1)
                        Image(systemName: sorted == false ? "arrow.down" : "arrow.up")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(CE.accent)
                            .opacity(sorted == nil ? 0 : 1)
                            .frame(width: 13)
                        if !numeric { Spacer(minLength: 0) }
                    }
                    .font(.system(size: tableHeadSize, weight: .semibold))
                    .foregroundStyle(CE.ink)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .frame(width: widths[index])
                    .frame(minHeight: isMac ? 40 : 44)
                }
                .buttonStyle(HoverFillStyle(radius: 0, hover: 0.06))
                .help("눌러서 정렬")
                .accessibilityLabel("\(title) 열 정렬")
                .accessibilityValue(sorted == nil ? "" : sorted == true ? "오름차순" : "내림차순")
            }
        }
        .background(Color(hex: 0x1A1533))
        .overlay(alignment: .bottom) { Rectangle().fill(Color.white.opacity(0.14)).frame(height: 1) }
    }

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

/// One table row (web td: padding 8 12, top-aligned, wraps; numbers right-aligned in tabular digits; row hover .03).
private struct TableRowView: View {
    let cells: [String]
    let widths: [CGFloat]
    let numeric: [Bool]
    let last: Bool
    let cellSize: CGFloat
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(widths.indices, id: \.self) { column in
                let number = column < numeric.count && numeric[column]
                cell(column < cells.count ? cells[column] : "", number: number)
                    .frame(width: widths[column], alignment: number ? .topTrailing : .topLeading)
            }
        }
        .background(Color.white.opacity(hovering ? 0.03 : 0))
        .overlay(alignment: .bottom) { if !last { Rectangle().fill(CE.line).frame(height: 1) } }
        .onHover { hovering = $0 }
    }

    private func cell(_ value: String, number: Bool) -> some View {
        (number ? Text(value).monospacedDigit() : Text(value))
            .font(.system(size: cellSize))
            .foregroundStyle(CE.ink)
            .lineSpacing(CELeading.spacing(cellSize, 1.45))
            .multilineTextAlignment(number ? .trailing : .leading)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            .padding(.horizontal, 12).padding(.vertical, 8)
    }
}

#if os(macOS)
private typealias PlatformFont = NSFont
#else
private typealias PlatformFont = UIFont
#endif

/// Column widths like the web's auto table layout: the widest line of each column (text columns capped at 420,
/// numbers never wrap) or its header with the sort slot, whichever is wider. Pure, so it can run off the main thread.
private func measureTableColumns(header: [String], rows: [[String]], numeric: [Bool], cellSize: CGFloat, headSize: CGFloat) -> [CGFloat] {
    let textFont = PlatformFont.systemFont(ofSize: cellSize)
    let digitFont = PlatformFont.monospacedDigitSystemFont(ofSize: cellSize, weight: .regular)
    let headFont = PlatformFont.systemFont(ofSize: headSize, weight: .semibold)
    func width(_ value: String, _ font: PlatformFont) -> CGFloat {
        var widest: CGFloat = 0
        for line in value.split(whereSeparator: \.isNewline) {
            widest = max(widest, (String(line) as NSString).size(withAttributes: [.font: font]).width)
        }
        return widest.rounded(.up) + 2
    }
    return header.indices.map { column in
        let number = column < numeric.count && numeric[column]
        let title = header[column].isEmpty ? "열 \(column + 1)" : header[column]
        // label · 5 · 13 arrow slot · 12 + 12 padding
        let head = width(title, headFont) + 5 + 13 + 24
        var widest: CGFloat = 0
        for row in rows where column < row.count {
            widest = max(widest, width(row[column], number ? digitFont : textFont))
            if !number && widest >= 396 { break }
        }
        let body = number ? widest + 24 : min(widest + 24, 420)
        return max(head, body, 56)
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

private struct ArtifactViewer: View {
    @Environment(AppStore.self) private var store
    let file: FileDoc
    /// Set only together with the compiled network block rule, so a preview never renders without it. The reader owns
    /// it so its header can offer 크게 보기.
    @Binding var loaded: LoadedArtifact?
    @Binding var enlarged: Bool
    @State private var loading = false
    @State private var error: String?
    /// The page height reported by the fitted preview (0 until measured).
    @State private var pageHeight: CGFloat = 0

    private var unavailableReason: String? {
        if store.isDemo { return "샘플 자료에는 연결된 실행 호스트가 없습니다." }
        if store.api == nil { return "서버에 연결되면 미리보기를 열 수 있습니다." }
        return nil
    }

    var body: some View {
        Group {
            if let loaded { preview(loaded) }
            else if error == nil && unavailableReason == nil { placeholder }
            else { gate }
        }
        // Opens by itself, as on the web: the page is always drawn protected (no script, no network, no navigation),
        // so there is nothing to confirm first. The gate stays only for a failure (다시 시도) or no host.
        .task(id: file.id) { if loaded == nil { await load() } }
        .sheet(isPresented: $enlarged) {
            if let loaded { ArtifactFullView(title: file.title, artifact: loaded) }
        }
    }

    /// While the page loads: a quiet frame of the preview's size, so the reader does not jump when it appears.
    private var placeholder: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text("페이지를 불러오는 중입니다").font(CEFont.note).foregroundStyle(CE.ink2)
        }
        .frame(maxWidth: .infinity, minHeight: 200)
        .background(CE.bg.opacity(0.6), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(CE.line) }
        .accessibilityElement(children: .combine)
    }

    /// Shown only when the page cannot be drawn: no host (sample data, offline) or a failed load, with 다시 시도.
    private var gate: some View {
        VStack(alignment: .leading, spacing: CESpace.m) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "lock.shield").font(.system(size: 17, weight: .medium)).foregroundStyle(CE.accent)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 4) {
                    Text("직원이 만든 페이지입니다").font(CEFont.rowTitle).foregroundStyle(CE.ink)
                    Text("스크립트와 외부 연결을 끈 보호된 미리보기로 엽니다.")
                        .font(gateNoteFont).foregroundStyle(CE.ink2)
                        .lineSpacing(CELeading.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            HStack(spacing: CESpace.m) {
                Button { Task { await load() } } label: {
                    Text(loading ? "불러오는 중입니다" : error == nil ? "미리보기 열기" : "다시 시도")
                }
                .ceProminentButton()
                .controlSize(.regular)
                .disabled(loading || unavailableReason != nil)
                if loading { ProgressView().controlSize(.small) }
                if let reason = unavailableReason {
                    Text(reason).font(gateNoteFont).foregroundStyle(CE.ink2)
                        .lineSpacing(CELeading.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.leading, 32)
            if let error {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(CEFont.note).foregroundStyle(CE.danger)
                    .lineSpacing(CELeading.note)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 32)
            }
        }
        .padding(CESpace.l)
        // Height follows the notice; only the loaded preview reserves a tall frame.
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .recessed(radius: 14)
    }

    private var gateNoteFont: Font { isMac ? .system(size: 13) : CEFont.secondary }

    /// The page alone (web .afr-stage): 크게 보기 lives in the reader header, so the frame starts right under the summary.
    private func preview(_ artifact: LoadedArtifact) -> some View {
        // As tall as the page once measured (the web's frame grows the same way); 520 until then.
        SandboxedHTML(html: artifact.html, rule: artifact.rule, title: file.title, height: $pageHeight)
            .frame(maxWidth: .infinity)
            .frame(height: pageHeight > 0 ? max(pageHeight, 120) : 520)
            .background(CE.bg)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(CE.line) }
            .accessibilityLabel("\(file.title) 미리보기")
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
            SandboxedHTML(html: artifact.html, rule: artifact.rule, title: title)
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
/// `compact` is the web chat look (.atv): a 208×148 cover thumbnail for a picture, a name · size chip for anything else.
struct AttachmentPreview: View {
    let attachment: Attachment
    var compact = false
    init(attachment: Attachment, compact: Bool = false) { self.attachment = attachment; self.compact = compact }
    var body: some View {
        if compact {
            if attachment.isImage {
                AttachmentThumb(attachment: attachment, height: 148).frame(maxWidth: 208)
            } else {
                AttachmentChip(attachment: attachment)
            }
        } else {
            AttachmentView(attachment: attachment)
        }
    }
}

/// The captioned card a message or decision shows (the reader uses `AttachmentGroup`, `FileCard` and the viewers).
private struct AttachmentView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.displayScale) private var displayScale
    let attachment: Attachment
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
    private var displayName: String { attachment.name.isEmpty ? "이름 없는 첨부" : attachment.name }

    var body: some View {
        Group {
            if attachment.isImage { imageTile } else { fileCard }
        }
        .quickLookPreview($quickLook)
        .task(id: attachment.id) { if attachment.isImage { await load() } }
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
        .frame(maxWidth: 420, alignment: .leading)
    }

    @ViewBuilder private var imageArea: some View {
        let shape = RoundedRectangle(cornerRadius: 6, style: .continuous)
        if let image {
            let scale = max(displayScale, 1)
            image.resizable().scaledToFit()
                .frame(maxWidth: pixelSize.width / scale, maxHeight: min(pixelSize.height / scale, 260))
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
            .frame(height: 120)
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
        .frame(maxWidth: 420, alignment: .leading)
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
            let destination = try writeTemporaryFile(result, name: attachment.name)
            if attachment.isImage, let decoded = decodePreviewImage(result, maxPixel: 1400) {
                image = decoded.image; pixelSize = decoded.size
            }
            data = result; fileURL = destination; error = nil
        } catch { self.error = error.localizedDescription }
    }
}

// MARK: - Reader viewers (web components/viewers)

private extension Attachment {
    var displayName: String { name.isEmpty ? "이름 없는 첨부" : name }
}

/// The original into a private temporary folder, under its own file name (Quick Look and sharing need a real file).
private func writeTemporaryFile(_ data: Data, name: String) throws -> URL {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("IAMCEO-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let file = name.isEmpty ? "attachment" : URL(fileURLWithPath: name).lastPathComponent
    let destination = folder.appendingPathComponent(file)
    try data.write(to: destination)
    return destination
}

/// One attachment's original, fetched through the connected daemon (access code in a header, same origin only) into a
/// temporary file; pictures are also decoded at preview size.
@MainActor @Observable private final class AttachmentFile {
    let attachment: Attachment
    private(set) var url: URL?
    private(set) var image: Image?
    private(set) var pixelSize: CGSize = .zero
    private(set) var loading = false
    var error: String?

    init(_ attachment: Attachment) { self.attachment = attachment }

    func load(_ store: AppStore, maxPixel: Int = 1400) async {
        guard url == nil, !loading else { return }
        guard let api = store.api else {
            error = store.isDemo ? "샘플에는 원본 파일이 없습니다." : "서버 연결 후 원본을 불러올 수 있습니다."
            return
        }
        loading = true; defer { loading = false }
        do {
            let data = try await api.attachmentData(attachment)
            let destination = try writeTemporaryFile(data, name: attachment.name)
            if attachment.isImage, let decoded = decodePreviewImage(data, maxPixel: maxPixel) {
                image = decoded.image; pixelSize = decoded.size
            }
            url = destination; error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Pictures shown together: Quick Look pages through all of them with the arrow keys (web ImageViewer 이전/다음).
@MainActor @Observable private final class GalleryState {
    var urls: [String: URL] = [:]
    var selected: URL?
}

/// Web .atv[data-large] (a document's attachments, the extras under other viewers): pictures as 320×220 cover tiles
/// (two to a row on iPhone, one alone at full width), every other file as a name · size chip.
private struct AttachmentGroup: View {
    @Environment(\.ceWide) private var wide
    let items: [Attachment]
    @State private var gallery = GalleryState()

    var body: some View {
        let images = items.filter(\.isImage)
        let files = items.filter { !$0.isImage }
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                if !images.isEmpty {
                    LazyVGrid(columns: columns(images.count), alignment: .leading, spacing: 8) {
                        ForEach(images) { image in
                            AttachmentThumb(attachment: image, height: tileHeight(images.count), gallery: gallery)
                        }
                    }
                }
                if !files.isEmpty {
                    ChipFlow(spacing: 8) {
                        ForEach(files) { AttachmentChip(attachment: $0) }
                    }
                }
            }
            .quickLookPreview($gallery.selected, in: images.compactMap { gallery.urls[$0.id] })
        }
    }

    private func columns(_ count: Int) -> [GridItem] {
        if wide { return [GridItem(.adaptive(minimum: 240, maximum: 320), spacing: 8, alignment: .top)] }
        return count == 1 ? [GridItem(.flexible())] : [GridItem(.flexible(), spacing: 8), GridItem(.flexible())]
    }

    private func tileHeight(_ count: Int) -> CGFloat { wide ? 220 : count == 1 ? 200 : 124 }
}

/// Web .atv-thumb / .vw-gallery__item: a cover-cropped picture on a dark well, radius 12, a ring that brightens on
/// hover. A click opens Quick Look.
private struct AttachmentThumb: View {
    @Environment(AppStore.self) private var store
    let attachment: Attachment
    /// Fixed tile height; nil = the web gallery's 4:3 tile.
    var height: CGFloat?
    /// Shared with the other pictures so Quick Look pages through them; nil = this picture alone.
    var gallery: GalleryState?
    @State private var source: AttachmentFile
    @State private var preview: URL?
    @State private var hovering = false

    init(attachment: Attachment, height: CGFloat?, gallery: GalleryState? = nil) {
        self.attachment = attachment
        self.height = height
        self.gallery = gallery
        _source = State(initialValue: AttachmentFile(attachment))
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        Button { open() } label: {
            well(shape)
                .overlay {
                    if let image = source.image {
                        image.resizable().scaledToFill()
                    } else if source.loading {
                        ProgressView().controlSize(.small)
                    } else {
                        VStack(spacing: 4) {
                            Image(systemName: "photo").foregroundStyle(CE.ink3)
                            Text(source.error ?? attachment.displayName)
                                .font(CEFont.caption).foregroundStyle(CE.ink2)
                                .lineSpacing(CELeading.spacing(12, 1.35))
                                .lineLimit(2).multilineTextAlignment(.center)
                        }
                        .padding(10)
                    }
                }
                .clipShape(shape)
                .overlay { shape.strokeBorder(Color.white.opacity(hovering ? 0.28 : 0.1)) }
                .contentShape(shape)
                .animation(.linear(duration: 0.12), value: hovering)
        }
        .buttonStyle(.plain)
        .disabled(source.loading)
        .onHover { hovering = $0 }
        .help(attachment.displayName)
        .accessibilityLabel(source.url == nil ? "\(attachment.displayName) 불러오기" : "\(attachment.displayName) 크게 보기")
        .quickLookPreview($preview)
        .contextMenu {
            if let url = source.url {
                ShareLink(item: url) { Label("공유·저장", systemImage: "square.and.arrow.up") }
            }
        }
        .task(id: attachment.id) { await fetch() }
    }

    @ViewBuilder private func well(_ shape: RoundedRectangle) -> some View {
        if let height {
            shape.fill(CE.bgDeep.opacity(0.5)).frame(maxWidth: .infinity).frame(height: height)
        } else {
            shape.fill(CE.bgDeep.opacity(0.5)).aspectRatio(4 / 3, contentMode: .fit).frame(maxWidth: .infinity)
        }
    }

    private func fetch() async {
        await source.load(store, maxPixel: 1000)
        if let url = source.url { gallery?.urls[attachment.id] = url }
    }

    private func open() {
        guard let url = source.url else { Task { await fetch() }; return }
        if let gallery { gallery.selected = url } else { preview = url }
    }
}

/// Web .atv-file: name and size on a quiet rounded chip that lightens on hover. A click opens the original in Quick
/// Look; the context menu saves or shares it.
private struct AttachmentChip: View {
    @Environment(AppStore.self) private var store
    let attachment: Attachment
    @State private var source: AttachmentFile
    @State private var preview: URL?
    @State private var hovering = false

    init(attachment: Attachment) {
        self.attachment = attachment
        _source = State(initialValue: AttachmentFile(attachment))
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        Button { Task { await open() } } label: {
            HStack(spacing: 10) {
                Image(systemName: fileKindIcon(attachmentKind(attachment)))
                    .font(.system(size: 12, weight: .medium)).foregroundStyle(CE.ink3)
                Text(attachment.displayName)
                    .font(isMac ? .system(size: 13.5, weight: .medium) : CEFont.note.weight(.medium))
                    .foregroundStyle(CE.ink).lineLimit(1).truncationMode(.middle)
                if source.loading {
                    ProgressView().controlSize(.mini)
                } else if source.error != nil {
                    Text("받지 못함").font(sizeFont).foregroundStyle(CE.danger)
                } else {
                    Text(fileSizeText(attachment.size)).font(sizeFont).foregroundStyle(CE.ink2).monospacedDigit()
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 6)
            .frame(minHeight: isMac ? 36 : 44)
            .background(Color.white.opacity(hovering ? 0.13 : 0.07), in: shape)
            .overlay { shape.strokeBorder(Color.white.opacity(0.1)) }
            .contentShape(shape)
            .animation(.linear(duration: 0.12), value: hovering)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(source.error ?? "\(attachment.displayName) 미리 보기")
        .accessibilityLabel("\(attachment.displayName) \(fileSizeText(attachment.size)) 열기")
        .quickLookPreview($preview)
        .contextMenu {
            if let url = source.url {
                ShareLink(item: url) { Label("공유·저장", systemImage: "square.and.arrow.up") }
            }
        }
    }

    private var sizeFont: Font { isMac ? .system(size: 12.5) : CEFont.meta }

    private func open() async {
        await source.load(store)
        if let url = source.url { preview = url }
    }
}

/// Web .vw-gallery: several pictures in a grid of 4:3 cover tiles (170 minimum), paged through in Quick Look.
private struct ImageGallery: View {
    @Environment(\.ceWide) private var wide
    let attachments: [Attachment]
    @State private var gallery = GalleryState()

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: wide ? 170 : 140), spacing: 8, alignment: .top)], alignment: .leading, spacing: 8) {
            ForEach(attachments) { AttachmentThumb(attachment: $0, height: nil, gallery: gallery) }
        }
        .quickLookPreview($gallery.selected, in: attachments.compactMap { gallery.urls[$0.id] })
    }
}

/// Web .vw-gallery[data-single]: one picture centred on a dark full-width tile, up to about 68% of the view tall, then
/// a bar with its name · size and 받기 / 공유.
private struct SingleImage: View {
    @Environment(AppStore.self) private var store
    @Environment(\.readerViewport) private var viewport
    @Environment(\.displayScale) private var displayScale
    let attachment: Attachment
    @State private var source: AttachmentFile
    @State private var preview: URL?
    @State private var hovering = false
    @State private var width: CGFloat = 0

    init(attachment: Attachment) {
        self.attachment = attachment
        _source = State(initialValue: AttachmentFile(attachment))
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        VStack(alignment: .leading, spacing: 8) {
            Button {
                if let url = source.url { preview = url } else { Task { await source.load(store, maxPixel: 2400) } }
            } label: {
                ZStack {
                    if let image = source.image {
                        let size = fitted
                        image.resizable().scaledToFit().frame(width: size.width, height: size.height)
                    } else if source.loading {
                        ProgressView().controlSize(.small)
                    } else {
                        VStack(spacing: 6) {
                            Image(systemName: "photo").font(.system(size: 18)).foregroundStyle(CE.ink3)
                            if let error = source.error {
                                Text(error).font(CEFont.note).foregroundStyle(CE.ink2).lineSpacing(CELeading.note)
                                    .multilineTextAlignment(.center)
                                    .fixedSize(horizontal: false, vertical: true)
                                if store.api != nil { Text("눌러서 다시 불러오기").font(CEFont.note.weight(.semibold)).foregroundStyle(CE.accent) }
                            }
                        }
                        .padding(CESpace.l)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 120)
                .background(CE.bgDeep.opacity(0.5))
                .clipShape(shape)
                .overlay { shape.strokeBorder(Color.white.opacity(hovering ? 0.28 : 0.1)) }
                .contentShape(shape)
                .animation(.linear(duration: 0.12), value: hovering)
            }
            .buttonStyle(.plain)
            .disabled(source.loading)
            .onHover { hovering = $0 }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { value in
                if abs(width - value) > 0.5 { width = value }
            }
            .help(source.url == nil ? "" : "크게 보기")
            .accessibilityLabel(source.url == nil ? "\(attachment.displayName) 불러오기" : "\(attachment.displayName) 크게 보기")
            ViewerBar(text: "\(attachment.displayName) · \(fileSizeText(attachment.size))") {
                SaveButton(attachment: attachment, name: attachment.name)
                if let url = source.url {
                    ShareLink(item: url) { Text("공유") }
                        .buttonStyle(ViewerButtonStyle())
                        .accessibilityLabel("\(attachment.displayName) 공유")
                }
            }
        }
        .quickLookPreview($preview)
        .task(id: attachment.id) { await source.load(store, maxPixel: 2400) }
    }

    /// Natural size (never upscaled), narrowed to the tile and capped at min(68% of the view, 720).
    private var fitted: CGSize {
        let scale = max(displayScale, 1)
        let natural = CGSize(width: source.pixelSize.width / scale, height: source.pixelSize.height / scale)
        guard natural.width > 0, natural.height > 0 else { return .zero }
        let cap = viewportLimit(viewport, 0.85, cap: 720)
        var w = width > 0 ? min(natural.width, width) : natural.width
        var h = w * natural.height / natural.width
        if h > cap { h = cap; w = h * natural.width / natural.height }
        return CGSize(width: w, height: h)
    }
}

/// Web .vw-card: name (wraps to two lines) and size · type on a quiet card, the actions on the right as .vw-btn.
private struct FileCard: View {
    @Environment(AppStore.self) private var store
    let attachment: Attachment
    @State private var source: AttachmentFile
    @State private var preview: URL?
    @State private var text: String?
    @State private var showText = false

    init(attachment: Attachment) {
        self.attachment = attachment
        _source = State(initialValue: AttachmentFile(attachment))
    }

    private var isTextual: Bool { attachment.mime.hasPrefix("text/") || attachment.mime.contains("json") }
    private var meta: String {
        let mime = attachment.mime.isEmpty || attachment.mime == "application/octet-stream" ? nil : attachment.mime
        return [fileSizeText(attachment.size), mime].compactMap { $0 }.joined(separator: " · ")
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(attachment.displayName)
                        .font(CEFont.rowTitle).foregroundStyle(CE.ink)
                        .lineSpacing(CELeading.spacing(14.5, 1.35))
                        .lineLimit(2).truncationMode(.middle)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(meta).font(CEFont.meta).foregroundStyle(CE.ink2).monospacedDigit().lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if source.loading { ProgressView().controlSize(.small) }
                HStack(spacing: 6) {
                    if isTextual {
                        Button(showText ? "접기" : "텍스트 보기") { Task { await toggleText() } }
                            .buttonStyle(ViewerButtonStyle(on: showText))
                    }
                    Button("열기") { Task { await open() } }
                        .buttonStyle(ViewerButtonStyle())
                        .help("원본을 받아 미리 봅니다")
                        .accessibilityLabel("\(attachment.displayName) 열기")
                    #if os(macOS)
                    SaveButton(attachment: attachment, name: attachment.name)
                    #endif
                    if let url = source.url {
                        ShareLink(item: url) { Text("공유") }
                            .buttonStyle(ViewerButtonStyle())
                            .help("공유·저장")
                            .accessibilityLabel("\(attachment.displayName) 공유·저장")
                    }
                }
                .fixedSize()
                .disabled(source.loading)
            }
            if showText, let text {
                Text(text)
                    .font(CEFont.mono).foregroundStyle(CE.ink2)
                    .lineSpacing(CELeading.spacing(12.5, 1.5))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .recessed(radius: 10, opacity: 0.55)
            }
            if let error = source.error {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(CEFont.note).foregroundStyle(CE.danger)
                    .lineSpacing(CELeading.note)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(Color.white.opacity(0.05), in: shape)
        .overlay { shape.strokeBorder(CE.line) }
        .quickLookPreview($preview)
    }

    private func open() async {
        await source.load(store)
        if let url = source.url { preview = url }
    }

    private func toggleText() async {
        if showText { showText = false; return }
        await source.load(store)
        if text == nil, let url = source.url, let data = try? Data(contentsOf: url) {
            text = String(String(decoding: data, as: UTF8.self).prefix(100_000))
        }
        showText = text != nil
    }
}

/// Web PdfViewer: a bar (name · size, 열기, 받기), then the pages in a frame min(78% of the view, 900) tall on #2a2838.
private struct PDFBlock: View {
    @Environment(AppStore.self) private var store
    @Environment(\.readerViewport) private var viewport
    let attachment: Attachment
    @State private var source: AttachmentFile
    @State private var preview: URL?

    init(attachment: Attachment) {
        self.attachment = attachment
        _source = State(initialValue: AttachmentFile(attachment))
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        VStack(alignment: .leading, spacing: 8) {
            ViewerBar(text: "\(attachment.displayName) · \(fileSizeText(attachment.size))") {
                if let url = source.url {
                    Button("열기") { preview = url }
                        .buttonStyle(ViewerButtonStyle())
                        .help("Quick Look으로 엽니다")
                }
                SaveButton(attachment: attachment, name: attachment.name)
            }
            if let url = source.url {
                PDFPreview(url: url)
                    .frame(maxWidth: .infinity)
                    .frame(height: viewportLimit(viewport, 0.95, cap: 900, floor: 360))
                    .background(Color(hex: 0x2A2838))
                    .clipShape(shape)
                    .overlay { shape.strokeBorder(CE.line) }
                    .accessibilityLabel("\(attachment.displayName) 미리보기")
            } else if let error = source.error {
                HStack(spacing: 10) {
                    ViewerNote(text: error, bad: true)
                    if store.api != nil {
                        Button("다시 시도") { Task { await source.load(store) } }.buttonStyle(ViewerButtonStyle())
                    }
                }
            } else {
                ViewerNote(text: "PDF를 불러오는 중입니다", loading: true)
            }
        }
        .quickLookPreview($preview)
        .task(id: attachment.id) { await source.load(store) }
    }
}

/// Web MediaViewer: video full width up to min(68% of the view, 720) on black, or an audio strip, then a bar with the
/// name · size and 받기.
private struct MediaBlock: View {
    @Environment(AppStore.self) private var store
    @Environment(\.readerViewport) private var viewport
    let attachment: Attachment
    let video: Bool
    @State private var source: AttachmentFile
    @State private var player: AVPlayer?
    @State private var audio: AudioModel?
    @State private var aspect: CGFloat = 16 / 9
    @State private var unplayable = false
    @State private var width: CGFloat = 0

    init(attachment: Attachment, video: Bool) {
        self.attachment = attachment
        self.video = video
        _source = State(initialValue: AttachmentFile(attachment))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if unplayable {
                ViewerNote(text: "여기서 재생할 수 없는 형식입니다. 받아서 열어 주세요.", bad: true)
            } else if let player, video {
                VideoPlayer(player: player)
                    .frame(maxWidth: .infinity)
                    .frame(height: videoHeight)
                    .background(Color.black)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .accessibilityLabel("\(attachment.displayName) 영상")
            } else if let audio {
                AudioStrip(model: audio, name: attachment.displayName)
            } else if let error = source.error {
                HStack(spacing: 10) {
                    ViewerNote(text: error, bad: true)
                    if store.api != nil {
                        Button("다시 시도") { Task { await prepare() } }.buttonStyle(ViewerButtonStyle())
                    }
                }
            } else {
                ViewerNote(text: video ? "영상을 불러오는 중입니다" : "오디오를 불러오는 중입니다", loading: true)
            }
            ViewerBar(text: "\(attachment.displayName) · \(fileSizeText(attachment.size))") {
                SaveButton(attachment: attachment, name: attachment.name)
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { value in
            if abs(width - value) > 0.5 { width = value }
        }
        .task(id: attachment.id) { await prepare() }
        .onDisappear { player?.pause(); audio?.stop() }
    }

    private var videoHeight: CGFloat {
        let cap = viewportLimit(viewport, 0.85, cap: 720)
        guard width > 0, aspect > 0 else { return min(cap, 360) }
        return min(cap, width / aspect)
    }

    private func prepare() async {
        await source.load(store)
        guard let url = source.url else { return }
        let asset = AVURLAsset(url: url)
        if let playable = try? await asset.load(.isPlayable), !playable { unplayable = true; return }
        if video {
            if let track = try? await asset.loadTracks(withMediaType: .video).first,
               let loaded = try? await track.load(.naturalSize, .preferredTransform) {
                let rect = CGRect(origin: .zero, size: loaded.0).applying(loaded.1)
                if rect.width != 0, rect.height != 0 { aspect = abs(rect.width / rect.height) }
            }
            if player == nil { player = AVPlayer(url: url) }
        } else if audio == nil {
            audio = AudioModel(url: url)
        }
    }
}

/// Inline audio player state (play/pause, position, length).
@MainActor @Observable private final class AudioModel {
    let player: AVPlayer
    var playing = false
    var position: Double = 0
    var duration: Double = 0
    @ObservationIgnored private var observer: Any?

    init(url: URL) {
        player = AVPlayer(url: url)
        // Also fires when playback starts, stops or jumps, so `playing` follows the end of the track.
        observer = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] time in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.position = time.seconds.isFinite ? time.seconds : 0
                self.playing = self.player.rate != 0
            }
        }
        Task { [weak self] in
            let seconds = (try? await AVURLAsset(url: url).load(.duration))?.seconds ?? 0
            self?.duration = seconds.isFinite ? seconds : 0
        }
    }

    func toggle() {
        if playing {
            player.pause()
            playing = false
        } else {
            if duration > 0, position >= duration - 0.05 { seek(to: 0) }
            player.play()
            playing = true
        }
    }

    func seek(to seconds: Double) {
        player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600))
        position = seconds
    }

    func stop() {
        player.pause()
        playing = false
    }
}

/// Web <audio controls>: one 48pt strip with play/pause, the position and the time.
private struct AudioStrip: View {
    let model: AudioModel
    let name: String

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        HStack(spacing: 10) {
            Button { model.toggle() } label: {
                Image(systemName: model.playing ? "pause.fill" : "play.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(CE.ink)
                    .frame(width: 32, height: 32)
                    .background(Color.white.opacity(0.1), in: Circle())
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(model.playing ? "\(name) 일시 정지" : "\(name) 재생")
            Slider(value: Binding(get: { model.position }, set: { model.seek(to: $0) }), in: 0...max(model.duration, 0.1))
                .tint(CE.accent)
                .controlSize(.small)
                .accessibilityLabel("재생 위치")
            Text("\(clock(model.position)) / \(clock(model.duration))")
                .font(isMac ? .system(size: 13) : CEFont.secondary).foregroundStyle(CE.ink2).monospacedDigit()
                .fixedSize()
        }
        .padding(.leading, 2).padding(.trailing, 14)
        .frame(minHeight: 48)
        .background(Color.white.opacity(0.05), in: shape)
        .overlay { shape.strokeBorder(CE.line) }
    }

    private func clock(_ seconds: Double) -> String {
        let total = Int(seconds.rounded(.down))
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

/// 받기 (web DownloadLink): the original fetched with the access code in a header, then the Mac save panel (iPhone:
/// Quick Look, whose share sheet saves to Files). Without an attachment it saves the given text instead.
private struct SaveButton: View {
    @Environment(AppStore.self) private var store
    let attachment: Attachment?
    var text: String? = nil
    let name: String
    var label = "받기"
    @State private var busy = false
    @State private var failure: String?
    @State private var preview: URL?

    var body: some View {
        Button { Task { await save() } } label: { Text(busy ? "받는 중" : label) }
            .buttonStyle(ViewerButtonStyle())
            .disabled(busy || unavailable != nil)
            .help(unavailable ?? (isMac ? "원본을 내려받아 저장합니다" : "원본을 열어 저장하거나 공유합니다"))
            .accessibilityLabel("\(name) \(label)")
            .quickLookPreview($preview)
            .alert("받지 못했습니다", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
                Button("확인", role: .cancel) {}
            } message: {
                Text(failure ?? "")
            }
    }

    private var unavailable: String? {
        guard attachment != nil, store.api == nil else { return nil }
        return store.isDemo ? "샘플에는 원본 파일이 없습니다." : "서버에 연결되면 받을 수 있습니다."
    }

    private func save() async {
        busy = true
        defer { busy = false }
        do {
            let data: Data
            if let attachment {
                guard let api = store.api else { return }
                data = try await api.attachmentData(attachment)
            } else {
                data = Data((text ?? "").utf8)
            }
            #if os(macOS)
            try await saveWithPanel(data, name: name)
            #else
            preview = try writeTemporaryFile(data, name: name)
            #endif
        } catch {
            failure = error.localizedDescription
        }
    }
}

#if os(macOS)
/// Mac 받기: the save panel, like a browser download.
@MainActor private func saveWithPanel(_ data: Data, name: String) async throws {
    let panel = NSSavePanel()
    panel.nameFieldStringValue = name.isEmpty ? "attachment" : URL(fileURLWithPath: name).lastPathComponent
    panel.canCreateDirectories = true
    let response = await withCheckedContinuation { (continuation: CheckedContinuation<NSApplication.ModalResponse, Never>) in
        panel.begin { continuation.resume(returning: $0) }
    }
    guard response == .OK, let url = panel.url else { return }
    try data.write(to: url, options: .atomic)
}
#endif

/// Web .vw-bar: the viewer's facts on the left (13 at 1.4, ink-2, tabular), its .vw-btn actions on the right; when
/// both do not fit on one line the actions wrap under the text (gap 6 12).
private struct ViewerBar<Actions: View>: View {
    let text: String
    @ViewBuilder var actions: Actions

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: 12) {
                label.fixedSize()
                Spacer(minLength: 0)
                HStack(spacing: 6) { actions }.fixedSize()
            }
            VStack(alignment: .leading, spacing: 6) {
                label.fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) { actions }.fixedSize()
            }
        }
    }

    private var label: some View {
        Text(text)
            .font(isMac ? .system(size: 13) : CEFont.secondary).foregroundStyle(CE.ink2).monospacedDigit()
            .lineSpacing(CELeading.spacing(13, 1.4))
    }
}

/// Web .vw-note: a loading or failure line in a viewer (14 at 1.5, ink-2; failures in the danger colour).
private struct ViewerNote: View {
    let text: String
    var bad = false
    var loading = false

    var body: some View {
        HStack(spacing: 8) {
            if loading { ProgressView().controlSize(.small) }
            Text(text)
                .font(isMac ? .system(size: 14) : CEFont.note)
                .foregroundStyle(bad ? CE.danger : CE.ink2)
                .lineSpacing(CELeading.spacing(14, 1.5))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 14).padding(.horizontal, 2)
        .accessibilityElement(children: .combine)
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

/// When a file was posted (web Time / formatTime): 방금 · N분 전 · N시간 전 within six hours, then 14:20 · 어제 14:20 ·
/// 11월 4일 14:20 · 2025년 3월 2일 14:20 — the clock never drops off an older date.
private func fileTime(_ iso: String, now: Date = Date()) -> String {
    guard let date = parseISODate(iso) else { return "" }
    if now.timeIntervalSince(date) < 6 * 3600 { return relativeTime(iso, now: now) }
    let calendar = Calendar.current
    let clock = koTime(date)
    if calendar.isDateInToday(date) { return clock }
    if calendar.isDateInYesterday(date) { return "어제 \(clock)" }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "ko_KR")
    formatter.dateFormat = calendar.component(.year, from: date) == calendar.component(.year, from: now) ? "M월 d일" : "yyyy년 M월 d일"
    return "\(formatter.string(from: date)) \(clock)"
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

/// Wrapping row (web flex-wrap with align-items center): items keep their size, move to the next line when they do
/// not fit, sit centred on their line, and an item wider than the line is narrowed to it (a one-line label truncates).
private struct ChipFlow: Layout {
    var spacing: CGFloat = 6
    /// Between lines; `spacing` when nil.
    var lineSpacing: CGFloat? = nil

    private struct Line { var items: [(index: Int, size: CGSize)] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func lines(_ limit: CGFloat, _ subviews: Subviews) -> [Line] {
        var lines = [Line()]
        for (index, view) in subviews.enumerated() {
            var size = view.sizeThatFits(.unspecified)
            if size.width > limit {
                size = view.sizeThatFits(ProposedViewSize(width: limit, height: nil))
                size.width = min(size.width, limit)
            }
            if !lines[lines.count - 1].items.isEmpty, lines[lines.count - 1].width + spacing + size.width > limit {
                lines.append(Line())
            }
            var line = lines[lines.count - 1]
            line.width += (line.items.isEmpty ? 0 : spacing) + size.width
            line.height = max(line.height, size.height)
            line.items.append((index, size))
            lines[lines.count - 1] = line
        }
        return lines
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let all = lines(proposal.width ?? .infinity, subviews)
        let height = all.reduce(0) { $0 + $1.height } + (lineSpacing ?? spacing) * CGFloat(max(0, all.count - 1))
        return CGSize(width: proposal.width ?? all.map(\.width).max() ?? 0, height: all.first?.items.isEmpty == true ? 0 : height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for line in lines(bounds.width, subviews) {
            var x = bounds.minX
            for item in line.items {
                subviews[item.index].place(at: CGPoint(x: x, y: y + (line.height - item.size.height) / 2), proposal: ProposedViewSize(item.size))
                x += item.size.width + spacing
            }
            y += line.height + (lineSpacing ?? spacing)
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

/// Web .vw-btn: rounded button in a viewer bar (Mac 34 tall, 13.5/600, radius 11, white .07 → .13 on hover);
/// `on` draws a toggle that is on as a violet drop.
private struct ViewerButtonStyle: ButtonStyle {
    var on = false
    func makeBody(configuration: Configuration) -> some View { ViewerBody(configuration: configuration, on: on) }
    private struct ViewerBody: View {
        let configuration: ButtonStyleConfiguration
        let on: Bool
        @Environment(\.isEnabled) private var isEnabled
        @State private var hovering = false
        var body: some View {
            let shape = RoundedRectangle(cornerRadius: 11, style: .continuous)
            configuration.label
                .font(isMac ? .system(size: 13.5, weight: .semibold) : CEFont.secondary.weight(.semibold))
                .lineLimit(1)
                .foregroundStyle(!isEnabled ? CE.ink3 : on ? Color.white : CE.ink)
                .padding(.horizontal, 13)
                .frame(height: 34)
                .background(on ? CE.violet.opacity(0.42) : Color.white.opacity(fill), in: shape)
                .overlay { shape.strokeBorder(Color.white.opacity(0.1)) }
                // iPhone: 44pt touch target around the 34pt button.
                .padding(.vertical, isMac ? 0 : 5)
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
                .animation(.linear(duration: 0.12), value: hovering)
        }
        private var fill: Double {
            guard isEnabled else { return 0.04 }
            return configuration.isPressed ? 0.16 : hovering ? 0.13 : 0.07
        }
    }
}

/// Web .fl-chip: Mac 36 tall (web 44), 13.5/550, quiet capsule that lightens on hover (white .10, ink-1); the chosen
/// one is a violet drop with white text and a white .16 ring.
private struct FilterChipStyle: ButtonStyle {
    let on: Bool
    func makeBody(configuration: Configuration) -> some View { ChipBody(configuration: configuration, on: on) }
    private struct ChipBody: View {
        let configuration: ButtonStyleConfiguration
        let on: Bool
        @State private var hovering = false
        var body: some View {
            configuration.label
                .font(isMac ? .system(size: 13.5, weight: .medium) : CEFont.note.weight(.medium))
                .foregroundStyle(on ? Color.white : hovering ? CE.ink : CE.ink2)
                .padding(.horizontal, 13)
                .frame(height: isMac ? 36 : 34)
                .background(on ? CE.violet.opacity(0.42) : Color.white.opacity(configuration.isPressed ? 0.13 : hovering ? 0.10 : 0.05), in: Capsule())
                .overlay { Capsule().strokeBorder(on ? Color.white.opacity(0.16) : CE.line) }
                // iPhone: 44pt touch target around the 34pt capsule.
                .padding(.vertical, isMac ? 0 : 5)
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
                .animation(.linear(duration: 0.12), value: hovering)
        }
    }
}

/// The reader's link chips (결재 · 대화): Mac 30 tall capsules that lighten on hover; an open decision is violet.
private struct LinkChipStyle: ButtonStyle {
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

/// Text-only control that gets a faint rounded fill on hover (web .fl-path__copy, table header buttons).
private struct HoverFillStyle: ButtonStyle {
    var radius: CGFloat = 10
    var hover: Double = 0.08
    func makeBody(configuration: Configuration) -> some View { HoverBody(configuration: configuration, radius: radius, hover: hover) }
    private struct HoverBody: View {
        let configuration: ButtonStyleConfiguration
        let radius: CGFloat
        let hover: Double
        @State private var hovering = false
        var body: some View {
            let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
            configuration.label
                .background(Color.white.opacity(configuration.isPressed ? hover + 0.05 : hovering ? hover : 0), in: shape)
                .contentShape(shape)
                .onHover { hovering = $0 }
        }
    }
}

#if os(macOS)
private struct PDFPreview: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.backgroundColor = .clear
        view.document = PDFDocument(url: url)
        return view
    }
    func updateNSView(_ nsView: PDFView, context: Context) {}
}
#else
private struct PDFPreview: UIViewRepresentable {
    let url: URL
    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.backgroundColor = .clear
        view.document = PDFDocument(url: url)
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
    /// Reports the page's content height (fitted previews only).
    var onHeight: ((CGFloat) -> Void)?
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let allow = artifactAllowsNavigation(firstAction: firstAction, url: navigationAction.request.url,
            mainFrame: navigationAction.targetFrame?.isMainFrame == true, type: navigationAction.navigationType)
        firstAction = false
        decisionHandler(allow ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { measure(webView) }

    /// The page height as the web measures it (the body's scroll height plus its margins), read from the app's own
    /// isolated script world: page scripts stay off, and nothing the page defines can answer for it.
    func measure(_ webView: WKWebView) {
        guard let onHeight else { return }
        let script = "(function(){var b=document.body;if(!b)return 0;var c=getComputedStyle(b);return Math.ceil(b.scrollHeight+(parseFloat(c.marginTop)||0)+(parseFloat(c.marginBottom)||0))})()"
        webView.evaluateJavaScript(script, in: nil, in: .defaultClient) { result in
            if case .success(let value) = result, let height = (value as? NSNumber)?.doubleValue, height > 0 {
                onHeight(CGFloat(height))
            }
        }
    }
}

/// The artifact web view. A fitted preview is as tall as its page, like the web's frame: it re-measures when its width
/// changes, and on Mac hands vertical scrolling to the page around it (a sideways swipe still scrolls a wide table).
private final class ArtifactWebView: WKWebView {
    var fitted = false
    weak var measurer: ArtifactNavigationDelegate?
    private var measuredWidth: CGFloat = -1

    #if os(macOS)
    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        widthChanged(newSize.width)
    }
    override func scrollWheel(with event: NSEvent) {
        if fitted && abs(event.scrollingDeltaY) >= abs(event.scrollingDeltaX) { nextResponder?.scrollWheel(with: event) }
        else { super.scrollWheel(with: event) }
    }
    #else
    override func layoutSubviews() {
        super.layoutSubviews()
        widthChanged(bounds.width)
    }
    #endif

    private func widthChanged(_ width: CGFloat) {
        guard fitted, abs(width - measuredWidth) > 0.5 else { return }
        measuredWidth = width
        // After WebKit has laid the page out at the new width.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self, !self.isLoading else { return }
            self.measurer?.measure(self)
        }
    }
}

/// Requires the compiled block layer before loading any artifact HTML. The page gets the web's artifact kit (dark page,
/// type scale, cards, grids, callouts) under the same protected policy; page scripts stay off.
@MainActor
private func makeArtifactWebView(html: String, title: String?, rule: WKContentRuleList, delegate: ArtifactNavigationDelegate,
                                 fitted: Bool) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.defaultWebpagePreferences.allowsContentJavaScript = false
    configuration.userContentController.add(rule)
    let view = ArtifactWebView(frame: .zero, configuration: configuration)
    view.fitted = fitted
    view.measurer = delegate
    view.navigationDelegate = delegate
    view.uiDelegate = delegate
    // No white flash before the kit's dark page paints.
    #if os(macOS)
    view.setValue(false, forKey: "drawsBackground")
    #else
    view.isOpaque = false
    view.backgroundColor = .clear
    view.scrollView.backgroundColor = .clear
    if fitted { view.scrollView.isScrollEnabled = false }
    #endif
    view.loadHTMLString(ArtifactKit.document(html, title: title), baseURL: nil)
    return view
}
#if os(macOS)
private struct SandboxedHTML: NSViewRepresentable {
    let html: String
    let rule: WKContentRuleList
    var title: String? = nil
    /// Fitted: as tall as the page (reported here); otherwise the page scrolls inside the view.
    var height: Binding<CGFloat>? = nil
    func makeCoordinator() -> ArtifactNavigationDelegate { ArtifactNavigationDelegate() }
    func makeNSView(context: Context) -> WKWebView {
        if let height { context.coordinator.onHeight = { value in if abs(height.wrappedValue - value) > 0.5 { height.wrappedValue = value } } }
        return makeArtifactWebView(html: html, title: title, rule: rule, delegate: context.coordinator, fitted: height != nil)
    }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
#else
private struct SandboxedHTML: UIViewRepresentable {
    let html: String
    let rule: WKContentRuleList
    var title: String? = nil
    var height: Binding<CGFloat>? = nil
    func makeCoordinator() -> ArtifactNavigationDelegate { ArtifactNavigationDelegate() }
    func makeUIView(context: Context) -> WKWebView {
        if let height { context.coordinator.onHeight = { value in if abs(height.wrappedValue - value) > 0.5 { height.wrappedValue = value } } }
        return makeArtifactWebView(html: html, title: title, rule: rule, delegate: context.coordinator, fitted: height != nil)
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
#endif
