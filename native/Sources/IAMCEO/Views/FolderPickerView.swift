import SwiftUI

struct FolderPickerView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    var initialPath: String? = nil
    var onSelect: (String) -> Void
    @State private var listing: FolderListing?
    @State private var loading = true
    @State private var creating = false
    @State private var legacy = false
    @State private var manualPath = ""
    @State private var error: String?
    @State private var newFolder = false
    @State private var newName = ""
    @State private var nameError: String?
    @FocusState private var nameFocused: Bool
    @FocusState private var pathFocused: Bool

    private var selectable: Bool { !loading && !newFolder && (legacy ? !manualPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty : listing.map { $0.path != $0.home } == true) }
    var body: some View {
        CESheet("폴더 고르기", icon: "folder", width: 560, scrolls: false, onClose: { if !creating { dismiss() } }) {
            VStack(alignment: .leading, spacing: 12) {
                if legacy {
                    // An older server cannot list folders: the path is typed in the app's ordinary input well.
                    SetupField("폴더 경로", hint: "이 서버에서는 경로를 직접 입력해 주세요. 서버 컴퓨터의 폴더입니다.") {
                        TextField("폴더 경로", text: $manualPath, prompt: Text(verbatim: "~/code/project"))
                            .labelsHidden()
                            .font(SetupFont.codeInput)
                            .autocorrectionDisabled()
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            #endif
                            .focused($pathFocused)
                            .ceField(focused: pathFocused)
                    }
                    Spacer(minLength: 0)
                } else {
                    HStack(spacing: 10) {
                        if let listing { breadcrumbBar(listing) } else { Spacer() }
                        Spacer(minLength: 8)
                        if loading { ProgressView().controlSize(.small) }
                        Button("새 폴더", systemImage: "folder.badge.plus") { newFolder = true; nameFocused = true }
                            .ceSecondaryButton().controlSize(.small).fixedSize().disabled(loading || store.isDemo || !store.canWrite)
                    }
                    let shape = RoundedRectangle(cornerRadius: CERadius.control, style: .continuous)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 2) {
                            if newFolder { creationRow }
                            if let listing {
                                if listing.entries.isEmpty && !loading && !newFolder {
                                    VStack(spacing: 6) {
                                        Image(systemName: "folder").font(.system(size: 22)).foregroundStyle(CE.ink3)
                                            .frame(height: 26)
                                            .accessibilityHidden(true)
                                        Text("하위 폴더가 없습니다").font(CEFont.rowTitle).foregroundStyle(CE.ink2)
                                        Text("이 폴더를 그대로 쓰거나 새 폴더를 만드세요").font(CEFont.meta).foregroundStyle(CE.ink3)
                                            .multilineTextAlignment(.center)
                                    }.frame(maxWidth: .infinity).padding(.vertical, 48)
                                }
                                ForEach(listing.rows) { row in
                                    let folder = row.folder
                                    Button { Task { await navigate(folder.path) } } label: {
                                        HStack(spacing: 11) {
                                            Image(systemName: "folder.fill").font(.system(size: 14)).foregroundStyle(CE.accent.opacity(0.85))
                                                .frame(width: 18)
                                            Text(folder.name).font(CEFont.body).foregroundStyle(CE.ink).lineLimit(1)
                                            Spacer(minLength: 0)
                                            Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(CE.ink3)
                                        }.padding(.horizontal, 12).padding(.vertical, 10).contentShape(Rectangle())
                                    }.buttonStyle(RowButtonStyle(radius: 9)).disabled(loading)
                                }
                                if listing.truncated == true {
                                    Text("처음 500개만 보입니다").font(CEFont.meta).foregroundStyle(CE.ink2).padding(.horizontal, 12).padding(.vertical, 8)
                                }
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(5)
                    }
                    .background(Color.white.opacity(0.025), in: shape)
                    .overlay { shape.strokeBorder(CE.line) }
                }
                if let error {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Label(error, systemImage: "exclamationmark.circle")
                            .font(CEFont.note).foregroundStyle(CE.danger)
                            .lineSpacing(CELeading.note)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 8)
                        Button("다시 시도") { Task { await start() } }.ceSecondaryButton().controlSize(.small).fixedSize().disabled(loading)
                    }
                }
            }
            #if os(macOS)
            .frame(height: 420)
            #endif
        } footer: {
            footerNote.frame(maxWidth: .infinity, alignment: .leading)
            Button("취소") { dismiss() }.ceSecondaryButton().disabled(creating)
            Button("이 폴더로") {
                guard selectable else { return }
                if let path = legacy ? manualPath.trimmingCharacters(in: .whitespacesAndNewlines) : listing?.path { onSelect(path); dismiss() }
            }.ceProminentButton().keyboardShortcut(.defaultAction).disabled(!selectable)
                .help(listing?.path == listing?.home ? "홈 폴더 바로는 프로젝트로 쓸 수 없습니다" : "현재 폴더 선택")
        }
        .interactiveDismissDisabled(creating)
        .task { await start() }
    }
    private func breadcrumbBar(_ listing: FolderListing) -> some View {
        let crumbs = ServerFolderPaths.breadcrumbs(path: listing.path, home: listing.home)
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: 5) {
                ForEach(Array(crumbs.enumerated()), id: \.element.id) { index, crumb in
                    if index > 0 { separator }
                    crumbButton(crumb)
                }
            }.fixedSize()
            HStack(spacing: 5) {
                if let home = crumbs.first { crumbButton(home).fixedSize() }
                if crumbs.count > 2 {
                    separator
                    Menu("…") {
                        ForEach(Array(crumbs.dropFirst().dropLast())) { crumb in
                            Button(crumb.name) { Task { await navigate(crumb.path) } }
                        }
                    }.font(CEFont.mono).fixedSize().disabled(loading)
                }
                if crumbs.count > 1, let current = crumbs.last {
                    separator
                    crumbButton(current)
                }
            }
        }
        // As tall as the 새 폴더 button beside it.
        .padding(.horizontal, 12)
        .frame(minHeight: 32)
        .background(CE.bgDeep.opacity(0.45), in: Capsule())
        .overlay { Capsule().strokeBorder(Color.white.opacity(0.1)) }
        .accessibilityLabel("현재 폴더: " + listing.path)
    }

    /// The "/" between crumbs, in the crumbs' own face.
    private var separator: some View {
        Text("/").font(CEFont.mono).foregroundStyle(CE.ink3).accessibilityHidden(true)
    }

    /// Left of the footer buttons: what "이 폴더로" will pick, or why it cannot.
    @ViewBuilder private var footerNote: some View {
        if store.isDemo {
            Text("샘플 폴더 · 읽기 전용").font(CEFont.meta).foregroundStyle(CE.ink3)
        } else if let listing, listing.path == listing.home {
            Text("홈 폴더 바로는 프로젝트로 쓸 수 없습니다").font(CEFont.meta).foregroundStyle(CE.ink3)
        } else if let listing, !legacy {
            Text(listing.path).font(CEFont.mono).foregroundStyle(CE.ink2).lineLimit(1).truncationMode(.head)
                .help(listing.path)
        }
    }
    private func crumbButton(_ crumb: FolderCrumb) -> some View {
        Button { Task { await navigate(crumb.path) } } label: {
            Text(crumb.name).lineLimit(1).truncationMode(.middle)
        }.buttonStyle(CrumbStyle()).font(CEFont.mono).disabled(loading)
    }
    private var creationRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Image(systemName: "folder.badge.plus").font(.system(size: 15)).foregroundStyle(CE.accent).frame(width: 20)
                    .accessibilityHidden(true)
                TextField("새 폴더 이름", text: $newName, prompt: Text("새 폴더 이름")).labelsHidden().font(SetupFont.input).focused($nameFocused)
                    .onSubmit { Task { await createFolder() } }.autocorrectionDisabled()
                    .ceField(focused: nameFocused)
                // As tall as the field (web .input + .gbtn--m, both 44).
                Button("만들기") { Task { await createFolder() } }.ceSecondaryButton().controlSize(.regular).fixedSize()
                    .disabled(loading || newName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button { newFolder = false; nameError = nil } label: {
                    Image(systemName: "xmark").font(.system(size: 10, weight: .bold))
                }
                .buttonStyle(RoundQuietStyle())
                .help("새 폴더 취소")
                .accessibilityLabel("새 폴더 취소").disabled(loading)
            }
            if let nameError {
                Text(nameError).font(CEFont.note).foregroundStyle(CE.danger)
                    .lineSpacing(CELeading.note)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 30)
            }
        }.padding(.horizontal, 8).padding(.vertical, 8)
    }
    private func start() async {
        loading = true; error = nil
        defer { loading = false }
        do {
            switch try await store.preferredFolder() {
            case .legacy:
                legacy = true; manualPath = initialPath ?? store.recentProjectParent ?? ""
                #if os(macOS)
                pathFocused = true
                #endif
            case .listing(let start):
                listing = start
                if let initialPath, let initial = try? await store.folderContents(path: initialPath) { listing = initial }
            }
        } catch { self.error = friendlyLoadError(error, what: "폴더", verb: "읽지") }
    }
    private func navigate(_ path: String) async {
        guard !loading else { return }
        loading = true; error = nil
        defer { loading = false }
        do { listing = try await store.folderContents(path: path); newFolder = false; newName = ""; nameError = nil }
        catch { self.error = friendlyLoadError(error, what: "폴더", verb: "읽지") }
    }
    private func createFolder() async {
        guard !loading, let listing, !store.isDemo else { return }
        if let issue = ServerFolderPaths.nameError(newName) { nameError = issue; return }
        loading = true; creating = true; nameError = nil
        defer { loading = false; creating = false }
        do {
            let created = try await store.createServerFolder(parent: listing.path, name: newName)
            self.listing = try await store.folderContents(path: created.path)
            newFolder = false; newName = ""
        } catch { nameError = friendlyLoadError(error, what: "폴더", verb: "읽지") }
    }
}

/// A crumb of the folder path: accent text that lights up under the pointer.
private struct CrumbStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { CrumbBody(configuration: configuration) }
    private struct CrumbBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var isEnabled
        @State private var hovering = false
        var body: some View {
            configuration.label
                .foregroundStyle(!isEnabled ? CE.ink3 : hovering ? CE.ink : CE.accent)
                .opacity(configuration.isPressed ? 0.7 : 1)
                .frame(minHeight: isMac ? nil : 44)
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
        }
    }
}

/// The round quiet × of an inline form (the sheet's close button look: 26pt white-tint circle), without its Esc key.
private struct RoundQuietStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { RoundBody(configuration: configuration) }
    private struct RoundBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var isEnabled
        @State private var hovering = false
        var body: some View {
            configuration.label
                .foregroundStyle(!isEnabled ? CE.ink3 : hovering ? CE.ink : CE.ink2)
                .frame(width: 26, height: 26)
                .background(Color.white.opacity(configuration.isPressed ? 0.14 : hovering && isEnabled ? 0.1 : 0.06), in: Circle())
                .overlay { Circle().strokeBorder(Color.white.opacity(0.07)) }
                .frame(minWidth: isMac ? nil : 44, minHeight: isMac ? nil : 44)
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
        }
    }
}
