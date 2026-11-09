import SwiftUI
import PDFKit
import WebKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

private struct LocalFileSelection: Identifiable {
    let path: String
    let projectID: String
    var id: String { projectID + ":" + path }
}

/// Each markdown surface owns its presentation, including markdown already inside another sheet.
struct LocalFilePresentation: ViewModifier {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var selection: LocalFileSelection?
    func body(content: Content) -> some View {
        content.environment(\.openURL, OpenURLAction { url in
            if let id = FileLinks.fileID(url, projectID: store.selectedProjectID, files: store.files) { router.openFile(id); return .handled }
            guard let path = LocalFileLinks.path(url) else { return .systemAction }
            guard let projectID = store.selectedProjectID else { return .handled }
            selection = LocalFileSelection(path: path, projectID: projectID)
            return .handled
        })
        .sheet(item: $selection) { item in LocalFileView(path: item.path, projectID: item.projectID) }
        .onChange(of: store.selectedProjectID) { _, _ in selection = nil }
    }
}

struct LocalFileView: View {
    let path: String
    let projectID: String
    /// Sample content for the review hook (`--sheet localfile:<kind>`); nil = read the file from the server.
    var sample: LocalFilePreview? = nil
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var preview: LocalFilePreview?
    @State private var failure: String?
    @State private var publishing = false
    @State private var copied = false
    @State private var host: FileHostConnection?
    @State private var html: String?
    @State private var rule: WKContentRuleList?
    @State private var reusedFileID: String?
    private var existingPath: Bool {
        let resolved = preview?.info.path ?? path
        return store.files.contains { $0.path == resolved || $0.path == path }
    }

    var body: some View {
        CESheet((path as NSString).lastPathComponent, subtitle: path, icon: "doc.text.magnifyingglass", width: 760) {
            VStack(alignment: .leading, spacing: 14) {
                if let failure {
                    InlineNotice(title: "파일을 열 수 없습니다", detail: failure)
                }
                if let preview {
                    MetaText([kindLabel(preview.info), fileSize(preview.info.size), modified(preview.info.modifiedAt)])
                    content(preview)
                } else if failure == nil {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("불러오는 중").font(CEFont.meta).foregroundStyle(CE.ink2)
                    }
                    .padding(.vertical, 6)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } footer: {
            HStack(spacing: 8) {
                if let text = preview?.info.content {
                    Button(copied ? "복사됨" : "내용 복사") { copy(text) }.ceSecondaryButton()
                }
                #if os(macOS)
                if let resolved = preview?.info.path, host?.localURL(resolved, current: store.api) != nil {
                    Button("Finder에서 보기") { Task { await openLocal(reveal: true) } }.ceSecondaryButton()
                }
                #endif
                Spacer()
                // iPhone closes from the navigation bar.
                if isMac { Button("닫기") { dismiss() }.ceSecondaryButton() }
                Button(publishing ? "올리는 중…" : existingPath ? "새 판으로 올리기" : "자료에 올리기") { Task { await publish() } }
                    .ceProminentButton()
                    .keyboardShortcut(.defaultAction)
                    .disabled(preview == nil || publishing || !store.canWrite || store.selectedProjectID != projectID)
                    .help("자료에 올려 두면 어느 기기에서든 보고 받을 수 있습니다")
            }
        }
        .task(id: "\(projectID):\(path):\(store.api.map { String(describing: ObjectIdentifier($0)) } ?? "")") {
            preview = nil; html = nil; rule = nil; host = nil; failure = nil
            if let sample { preview = sample; return }
            guard let api = store.api else { failure = "서버에 연결된 뒤에 열 수 있습니다"; return }
            host = await FileHostConnection.current(api)
            do {
                let loaded = try await api.localFile(projectID: projectID, path: path)
                guard store.api === api, store.selectedProjectID == projectID, !Task.isCancelled else { return }
                preview = loaded
                if loaded.info.kind == "html" {
                    guard let compiled = await artifactBlockRule() else { throw APIError(status: 0, message: "안전한 미리보기를 준비하지 못했습니다") }
                    let rendered = try await api.localFileHTML(projectID: projectID, path: path)
                    guard store.api === api, store.selectedProjectID == projectID, !Task.isCancelled else { return }
                    rule = compiled; html = rendered
                }
            } catch { if store.api === api, !Task.isCancelled { failure = friendlyLoadError(error, what: "파일", verb: "읽지") } }
        }
        .alert("바뀐 내용이 없어 기존 자료를 엽니다", isPresented: Binding(get: { reusedFileID != nil }, set: { if !$0 { reusedFileID = nil } })) {
            Button("자료 열기") { if let id = reusedFileID { dismiss(); router.openFile(id) }; reusedFileID = nil }
            Button("취소", role: .cancel) { reusedFileID = nil }
        }
    }
    @ViewBuilder private func content(_ preview: LocalFilePreview) -> some View {
        if preview.info.kind == "html" {
            if let html, let rule { SandboxedHTML(html: html, rule: rule, title: preview.info.name).frame(height: 520) }
            else if failure == nil { ProgressView("안전한 미리보기를 준비하는 중입니다") }
        } else if preview.info.kind == "csv", let rows = preview.info.rows {
            ScrollView([.horizontal, .vertical]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(rows.prefix(1000).enumerated()), id: \.offset) { _, row in
                        HStack(alignment: .top, spacing: 0) {
                            ForEach(Array(row.prefix(50).enumerated()), id: \.offset) { _, cell in
                                Text(cell).font(CEFont.meta).textSelection(.enabled)
                                    .frame(width: 180, alignment: .leading).padding(8)
                                    .overlay { Rectangle().stroke(CE.line) }
                            }
                        }
                    }
                }
            }.frame(maxHeight: 520)
            if rows.count > 1000 || rows.contains(where: { $0.count > 50 }) { MetaText(["미리보기는 1,000행·50열까지 표시합니다"]) }
        } else if let data = preview.pdfData {
            LocalPDFPreview(data: data).frame(height: 520)
        } else if preview.info.kind == "xlsx" || preview.info.previewAvailable == false {
            CompactEmpty(icon: "tablecells", title: "미리보기 불가", detail: preview.info.previewNote ?? "파일을 열어 내용을 확인해 주세요")
            Button("열기") { Task { await openOriginal() } }.ceSecondaryButton().disabled(publishing)
        } else if let text = preview.info.content {
            if ["md", "markdown"].contains((preview.info.name as NSString).pathExtension.lowercased()) {
                MarkdownText(text: text)
            } else {
                // Web .vw-code: mono 12.5 / 1.6 in a deep well.
                ScrollView(.horizontal) {
                    Text(text)
                        .font(CEFont.mono).foregroundStyle(CE.ink)
                        .lineSpacing(CELeading.spacing(12.5, 1.6))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: true)
                        .padding(.horizontal, 14).padding(.vertical, 12)
                }
                .scrollIndicators(.automatic)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(CE.bgDeep.opacity(0.5), in: RoundedRectangle(cornerRadius: CERadius.control, style: .continuous))
                .overlay { RoundedRectangle(cornerRadius: CERadius.control, style: .continuous).strokeBorder(CE.line) }
            }
        } else if let data = preview.imageData, let image = platformImage(data) {
            image.resizable().scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: 520)
                .padding(10)
                .background(CE.bgDeep.opacity(0.5), in: RoundedRectangle(cornerRadius: CERadius.control, style: .continuous))
                .overlay { RoundedRectangle(cornerRadius: CERadius.control, style: .continuous).strokeBorder(CE.line) }
        } else {
            CompactEmpty(icon: preview.imageData == nil ? "doc" : "photo",
                         title: preview.imageData == nil ? "여기서는 미리 볼 수 없는 형식입니다" : "이미지를 표시할 수 없습니다",
                         detail: "자료에 올리면 자료 화면에서 열거나 받을 수 있습니다")
        }
    }

    private func platformImage(_ data: Data) -> Image? {
        #if os(macOS)
        NSImage(data: data).map { Image(nsImage: $0) }
        #else
        UIImage(data: data).map { Image(uiImage: $0) }
        #endif
    }

    private func kindLabel(_ info: LocalFileInfo) -> String? {
        let ext = (info.name as NSString).pathExtension
        return ext.isEmpty ? nil : ext.uppercased()
    }

    private func fileSize(_ size: Int64) -> String {
        if size < 1024 { return "\(size) B" }
        if size < 1024 * 1024 { return "\(Int((Double(size) / 1024).rounded())) KB" }
        return String(format: "%.1f MB", Double(size) / (1024 * 1024))
    }

    private func modified(_ value: String) -> String? {
        let text = relativeTime(value)
        return text.isEmpty ? nil : "수정 \(text)"
    }

    private func copy(_ text: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
        copied = true
        Task { try? await Task.sleep(for: .seconds(1.6)); copied = false }
    }

    @MainActor private func openOriginal() async {
        #if os(macOS)
        if let host, host.localURL(preview?.info.path ?? path, current: store.api) != nil {
            await openLocal(reveal: false); return
        }
        #endif
        await publish()
    }

    #if os(macOS)
    @MainActor private func openLocal(reveal: Bool) async {
        guard let host, store.api === host.api else { return }
        do {
            guard let url = try await host.validatedURL(path: preview?.info.path ?? path, projectID: projectID),
                  store.api === host.api, store.selectedProjectID == projectID else { return }
            if reveal { NSWorkspace.shared.activateFileViewerSelecting([url]) }
            else { NSWorkspace.shared.open(url) }
        } catch { failure = friendlyLoadError(error, what: "파일", verb: "읽지") }
    }
    #endif

    @MainActor private func publish() async {
        guard !publishing, store.canWrite, store.selectedProjectID == projectID, let api = store.api else { return }
        publishing = true
        defer { publishing = false }
        do {
            let file = try await api.publishLocalFile(projectID: projectID, path: path)
            await store.refresh()
            guard store.selectedProjectID == projectID, store.api === api else { return }
            if file.reused == true { reusedFileID = file.id }
            else { dismiss(); router.openFile(file.id) }
        } catch { if store.api === api, store.selectedProjectID == projectID { failure = friendlyLoadError(error, what: "자료", verb: "올리지") } }
    }
}

#if os(macOS)
private struct LocalPDFPreview: NSViewRepresentable {
    let data: Data
    func makeNSView(context: Context) -> PDFView {
        let view = PDFView(); view.autoScales = true; view.displayMode = .singlePageContinuous
        view.document = PDFDocument(data: data); return view
    }
    func updateNSView(_ view: PDFView, context: Context) {}
}
#else
private struct LocalPDFPreview: UIViewRepresentable {
    let data: Data
    func makeUIView(context: Context) -> PDFView {
        let view = PDFView(); view.autoScales = true; view.displayMode = .singlePageContinuous
        view.document = PDFDocument(data: data); return view
    }
    func updateUIView(_ view: PDFView, context: Context) {}
}
#endif

#if DEBUG
/// Sample content for `--sheet localfile:md|code|image|other` (review hook; no file is read).
struct LocalFileSample: Identifiable {
    let kind: String
    var id: String { kind }
    var path: String {
        switch kind {
        case "code": "~/Aingo/scripts/sync_rows.py"
        case "image": "~/Aingo/output/screens/home@2x.png"
        case "other": "~/Aingo/output/결과보고서.docx"
        default: "~/Aingo/docs/리포트/주간-진행-보고.md"
        }
    }
    var preview: LocalFilePreview {
        let name = (path as NSString).lastPathComponent
        let modified = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-42 * 60))
        switch kind {
        case "code":
            let text = """
            import json, sys
            from pathlib import Path

            def load_rows(path: Path) -> list[dict]:
                \"\"\"Read the exported rows and drop the empty ones.\"\"\"
                rows = json.loads(path.read_text(encoding="utf-8"))
                return [row for row in rows if row.get("title")]

            if __name__ == "__main__":
                rows = load_rows(Path(sys.argv[1]))
                print(f"{len(rows)} rows ready", file=sys.stderr)
            """
            return LocalFilePreview(info: LocalFileInfo(name: name, path: path, size: Int64(text.utf8.count), modifiedAt: modified, mime: "text/x-python", kind: "code", content: text))
        case "image":
            return LocalFilePreview(info: LocalFileInfo(name: name, path: path, size: 482_113, modifiedAt: modified, mime: "image/png", kind: "image", content: nil), imageData: Self.sampleImage)
        case "other":
            return LocalFilePreview(info: LocalFileInfo(name: name, path: path, size: 1_284_551, modifiedAt: modified, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "file", content: nil))
        default:
            let text = """
            # 주간 진행 보고

            이번 주에는 **결제 연동**과 홈 화면 개편을 끝냈습니다. 남은 일은 아래 표와 같습니다.

            | 안 | 내용 | 작업량 | 동결과 | DB |
            |---|---|---|---|---|
            | ① 그대로 | 버튼만 넣는다 | 추가 없음 | 영향 없음 | 필요 없음 |
            | ② 잠금만 풀기 (권장) | 요청 연습 칸은 첫 자리에 그대로 두고 언제든 누를 수 있는 칸으로 바꾼다. 첫 레슨이 '현재' 칸이 된다 | 작음. `prompt-lab-path.ts` 몇 줄과 시험 1~2개 | 동결 전 넉넉함 | 필요 없음(앱만) |
            | ③ 순서 바꾸기 | 신규는 첫 레슨부터 하고 요청 연습은 다음 칸에 둔다 | 작음~중간 | ②보다 빠듯함 | 필요 없음 |

            ## 다음 주

            - 결제 영수증 메일 보내기
            - 홈 화면 속도 측정 (`output/perf.json`)
            """
            return LocalFilePreview(info: LocalFileInfo(name: name, path: path, size: Int64(text.utf8.count), modifiedAt: modified, mime: "text/markdown", kind: "markdown", content: text))
        }
    }
    private static var sampleImage: Data? {
        #if os(macOS)
        let image = NSImage(size: NSSize(width: 640, height: 400), flipped: false) { rect in
            NSGradient(colors: [NSColor(CE.violet), NSColor(CE.accent)])?.draw(in: rect, angle: 35)
            return true
        }
        guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
        #else
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 640, height: 400))
        return renderer.pngData { context in
            UIColor(CE.violet).setFill(); context.fill(CGRect(x: 0, y: 0, width: 640, height: 400))
            UIColor(CE.accent).setFill(); context.fill(CGRect(x: 0, y: 260, width: 640, height: 140))
        }
        #endif
    }
}
#endif
