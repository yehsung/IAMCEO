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

    private var selectable: Bool { !loading && !newFolder && (legacy ? !manualPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty : listing.map { $0.path != $0.home } == true) }
    var body: some View {
        CESheet("폴더 고르기", icon: "folder", width: 560, scrolls: false, onClose: { if !creating { dismiss() } }) {
            VStack(alignment: .leading, spacing: 12) {
                if legacy {
                    Text("이 서버에서는 경로를 직접 입력해 주세요.").font(CEFont.secondary).foregroundStyle(CE.ink3)
                    TextField("~/code/project", text: $manualPath).font(CEFont.mono).textFieldStyle(.plain)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                    Spacer(minLength: 0)
                } else {
                    HStack(spacing: 10) {
                        if let listing { breadcrumbBar(listing) } else { Spacer() }
                        Spacer(minLength: 8)
                        if loading { ProgressView().controlSize(.small) }
                        Button("새 폴더", systemImage: "folder.badge.plus") { newFolder = true; nameFocused = true }
                            .ceSecondaryButton().controlSize(.small).disabled(loading || store.isDemo || !store.canWrite)
                    }
                    let shape = RoundedRectangle(cornerRadius: CERadius.control, style: .continuous)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 2) {
                            if newFolder { creationRow }
                            if let listing {
                                if listing.entries.isEmpty && !loading && !newFolder {
                                    VStack(spacing: 6) {
                                        Image(systemName: "folder").font(.system(size: 20)).foregroundStyle(CE.ink3)
                                        Text("하위 폴더가 없습니다").font(CEFont.secondary).foregroundStyle(CE.ink3)
                                        Text("이 폴더를 그대로 쓰거나 새 폴더를 만드세요").font(CEFont.meta).foregroundStyle(CE.ink3)
                                    }.frame(maxWidth: .infinity).padding(.vertical, 40)
                                }
                                ForEach(listing.entries) { folder in
                                    Button { Task { await navigate(folder.path) } } label: {
                                        HStack(spacing: 10) {
                                            Image(systemName: "folder.fill").foregroundStyle(CE.accent.opacity(0.85))
                                            Text(folder.name).font(CEFont.body).foregroundStyle(CE.ink).lineLimit(1)
                                            Spacer(minLength: 0)
                                            Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(CE.ink3)
                                        }.padding(.horizontal, 10).padding(.vertical, 9).contentShape(Rectangle())
                                    }.buttonStyle(RowButtonStyle(radius: 8)).disabled(loading)
                                }
                                if listing.truncated == true {
                                    Text("처음 500개만 보입니다").font(CEFont.meta).foregroundStyle(CE.ink3).padding(.horizontal, 10).padding(.vertical, 8)
                                }
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
                    }
                    .background(Color.white.opacity(0.025), in: shape)
                    .overlay { shape.strokeBorder(CE.line) }
                }
                if let error {
                    Text(error).font(CEFont.secondary).foregroundStyle(CE.danger)
                    Button("다시 시도") { Task { await start() } }.ceSecondaryButton().disabled(loading)
                }
            }
            #if os(macOS)
            .frame(height: 350)
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
                    if index > 0 { Text("/").foregroundStyle(CE.ink3) }
                    crumbButton(crumb)
                }
            }.fixedSize()
            HStack(spacing: 5) {
                if let home = crumbs.first { crumbButton(home).fixedSize() }
                if crumbs.count > 2 {
                    Text("/").foregroundStyle(CE.ink3)
                    Menu("…") {
                        ForEach(Array(crumbs.dropFirst().dropLast())) { crumb in
                            Button(crumb.name) { Task { await navigate(crumb.path) } }
                        }
                    }.font(CEFont.mono).fixedSize().disabled(loading)
                }
                if crumbs.count > 1, let current = crumbs.last {
                    Text("/").foregroundStyle(CE.ink3)
                    crumbButton(current)
                }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Color.black.opacity(0.22), in: Capsule())
        .overlay { Capsule().strokeBorder(CE.line) }
        .accessibilityLabel("현재 폴더: " + listing.path)
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
        }.buttonStyle(.plain).font(CEFont.mono).foregroundStyle(CE.accent).disabled(loading)
    }
    private var creationRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: "folder.badge.plus").foregroundStyle(CE.accent)
                TextField("새 폴더 이름", text: $newName, prompt: Text("새 폴더 이름")).labelsHidden().font(CEFont.body).focused($nameFocused)
                    .onSubmit { Task { await createFolder() } }.autocorrectionDisabled()
                    .ceField()
                Button("만들기") { Task { await createFolder() } }.ceSecondaryButton().disabled(loading || newName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button { newFolder = false; nameError = nil } label: { Image(systemName: "xmark") }.buttonStyle(.plain).accessibilityLabel("새 폴더 취소").disabled(loading)
            }
            if let nameError { Text(nameError).font(CEFont.meta).foregroundStyle(CE.danger).padding(.leading, 26) }
        }.padding(.horizontal, 8).padding(.vertical, 8)
    }
    private func start() async {
        loading = true; error = nil
        defer { loading = false }
        do {
            switch try await store.preferredFolder() {
            case .legacy: legacy = true; manualPath = initialPath ?? store.recentProjectParent ?? ""
            case .listing(let start):
                listing = start
                if let initialPath, let initial = try? await store.folderContents(path: initialPath) { listing = initial }
            }
        } catch { self.error = error.localizedDescription }
    }
    private func navigate(_ path: String) async {
        guard !loading else { return }
        loading = true; error = nil
        defer { loading = false }
        do { listing = try await store.folderContents(path: path); newFolder = false; newName = ""; nameError = nil }
        catch { self.error = error.localizedDescription }
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
        } catch { nameError = error.localizedDescription }
    }
}
