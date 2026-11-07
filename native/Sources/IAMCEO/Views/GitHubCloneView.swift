import SwiftUI

struct GitHubCloneView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    var onClone: (String, String) -> Void
    @State private var repositories: GitHubRepositories?
    @State private var search = ""
    @State private var selectedRepo: String?
    @State private var address = ""
    @State private var parent = ""
    @State private var showLocationPicker = false
    @State private var loading = true
    @State private var cloning = false
    @State private var error: String?
    @State private var jobID: String?
    @State private var cloneServerKey: String?
    @State private var cloneTask: Task<Void, Never>?
    @FocusState private var focus: Field?

    private enum Field: Hashable { case search, address }

    private var serverKey: String { store.endpoint + "|" + (store.serverID ?? "") }
    private var repo: String? {
        let input = address.trimmingCharacters(in: .whitespacesAndNewlines)
        return ServerFolderPaths.repository(input.isEmpty ? selectedRepo ?? "" : input)
    }
    private var repoName: String { repo?.split(separator: "/").last.map(String.init) ?? "" }
    private var preview: String { repoName.isEmpty || parent.isEmpty ? "" : ServerFolderPaths.appending(repoName, to: parent) }
    private var canClone: Bool { !cloning && !loading && store.canWrite && repo != nil && !parent.isEmpty }
    private var filtered: [GitHubRepository] {
        (repositories?.repos ?? []).filter { search.isEmpty || $0.nameWithOwner.localizedCaseInsensitiveContains(search) }
    }
    var body: some View {
        CESheet("GitHub에서 가져오기", subtitle: "저장소를 서버 컴퓨터에 받아 그 폴더로 프로젝트를 만듭니다.", icon: "arrow.down.circle",
                width: 580, maxBodyHeight: 600, onClose: { if !cloning { dismiss() } }) {
            VStack(alignment: .leading, spacing: 18) {
                repositorySection
                addressSection
                destinationSection
                if cloning {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("저장소를 받는 중입니다").font(CEFont.note).foregroundStyle(CE.ink2)
                    }
                    .accessibilityIdentifier(jobID ?? "clone")
                }
                if store.isDemo { Text("샘플 저장소 · 읽기 전용").font(CEFont.meta).foregroundStyle(CE.ink2) }
                if let error {
                    // web .form__error 13.5 danger.
                    Label(error, systemImage: "exclamationmark.circle").font(CEFont.note).foregroundStyle(CE.danger)
                        .lineSpacing(CELeading.note)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }.disabled(cloning || jobID != nil)
        } footer: {
            Button("취소") { dismiss() }.ceSecondaryButton().disabled(cloning)
            Button(jobID == nil ? "가져오기" : "결과 확인") { cloneTask = Task { await clone() } }
                .ceProminentButton().keyboardShortcut(.defaultAction).disabled(!canClone)
        }
        .interactiveDismissDisabled(cloning)
        .sheet(isPresented: $showLocationPicker) { FolderPickerView(initialPath: parent.isEmpty ? nil : parent) { parent = $0 } }
        .task { await load() }
        .onDisappear { cloneTask?.cancel() }
    }

    /// My repositories: a search field and a bordered list; the chosen row is lit and ticked.
    @ViewBuilder private var repositorySection: some View {
        SetupField("내 저장소") {
            if loading && repositories == nil {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("저장소 목록을 불러오는 중입니다").font(CEFont.note).foregroundStyle(CE.ink2)
                }.padding(.vertical, 10)
            } else if repositories?.available == true {
                VStack(alignment: .leading, spacing: 8) {
                    // web .input: the search well with its glass, focus ring and all.
                    HStack(spacing: 9) {
                        Image(systemName: "magnifyingglass").font(.system(size: 13, weight: .medium)).foregroundStyle(CE.ink3)
                            .accessibilityHidden(true)
                        TextField("검색", text: $search, prompt: Text("저장소 이름으로 찾기"))
                            .labelsHidden().font(SetupFont.input).autocorrectionDisabled()
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            #endif
                            .focused($focus, equals: .search)
                    }
                    .ceField(focused: focus == .search)
                    let shape = RoundedRectangle(cornerRadius: CERadius.control, style: .continuous)
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 3) {
                            ForEach(filtered) { repository in repoRow(repository) }
                            if filtered.isEmpty {
                                Text(search.isEmpty ? "저장소가 없습니다" : "‘\(search)’에 맞는 저장소가 없습니다")
                                    .font(CEFont.note).foregroundStyle(CE.ink2)
                                    .multilineTextAlignment(.center)
                                    .frame(maxWidth: .infinity).padding(.vertical, 28)
                            }
                        }.padding(5)
                    }
                    .frame(height: isMac ? 300 : 280)
                    .background(Color.white.opacity(0.025), in: shape)
                    .overlay { shape.strokeBorder(CE.line) }
                }
            } else {
                InlineNotice(tone: .accent, icon: "info.circle", title: "내 저장소 목록을 볼 수 없습니다",
                             detail: "서버 컴퓨터에서 GitHub CLI(gh)로 로그인하면 여기에 목록이 보입니다. 아래에 주소를 직접 넣어 가져올 수 있습니다.")
            }
        }
    }

    /// A repository that is not in the list (any public one): owner/name or its github.com address.
    private var addressSection: some View {
        let invalid = !address.isEmpty && repo == nil
        return SetupField(repositories?.available == true ? "목록에 없는 저장소" : "저장소 주소",
                          hint: invalid ? "GitHub 저장소 주소 형식이 아닙니다" : nil, hintTone: CE.danger) {
            TextField("저장소 주소", text: $address, prompt: Text(verbatim: "owner/name 또는 https://github.com/owner/name").font(SetupFont.input))
                .labelsHidden().font(SetupFont.codeInput).autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
                .focused($focus, equals: .address)
                .ceField(focused: focus == .address)
        }
    }

    /// Where it lands: the final folder path as a tile, with the place to change it.
    private var destinationSection: some View {
        let shape = RoundedRectangle(cornerRadius: 13, style: .continuous)
        return SetupField("받을 위치") {
            HStack(spacing: 12) {
                Image(systemName: "folder.fill").font(.system(size: 14, weight: .semibold)).foregroundStyle(CE.accent)
                    .frame(width: 30, height: 30)
                    .background(CE.violet.opacity(0.16), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(preview.isEmpty ? (parent.isEmpty ? "받을 위치를 골라 주세요" : parent) : preview)
                        .font(SetupFont.codeInput).foregroundStyle(parent.isEmpty ? CE.ink3 : CE.ink)
                        .lineLimit(1).truncationMode(.middle)
                    if preview.isEmpty && !parent.isEmpty {
                        Text("저장소를 고르면 이 폴더 아래에 저장소 이름으로 만들어집니다").font(SetupFont.hint).foregroundStyle(CE.ink2)
                            .lineSpacing(SetupFont.hintLeading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 8)
                Button("바꾸기") { showLocationPicker = true }
                    .ceSecondaryButton()
                    .controlSize(.small)
                    .fixedSize()
                    .disabled(cloning || loading)
            }
            .padding(.leading, 12).padding(.trailing, 10).padding(.vertical, 10)
            .background(Color.white.opacity(0.04), in: shape)
            .overlay { shape.strokeBorder(Color.white.opacity(0.1)) }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(preview.isEmpty ? "받을 위치: \(parent)" : "최종 폴더: " + preview)
        }
    }

    /// The picked repository looks like a picked choice (web .choice[data-on]: violet .24, 1.5pt violet ring).
    private func repoRow(_ repository: GitHubRepository) -> some View {
        let selected = selectedRepo == repository.nameWithOwner && address.isEmpty
        return Button { selectedRepo = repository.nameWithOwner; address = "" } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: selected ? "checkmark.circle.fill" : "book.closed")
                    .font(.system(size: 14, weight: .medium)).foregroundStyle(selected ? CE.accent : CE.ink3)
                    .frame(width: 18).padding(.top, 1)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 7) {
                        Text(repository.nameWithOwner).font(CEFont.rowTitle).foregroundStyle(CE.ink).lineLimit(1)
                        if repository.visibility == "PRIVATE" { Tag("비공개", icon: "lock") }
                    }
                    if let description = repository.description, !description.isEmpty {
                        Text(description).font(CEFont.secondary).foregroundStyle(CE.ink2).lineLimit(2)
                            .lineSpacing(CELeading.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 8)
                Text(relativeTime(repository.updatedAt)).font(CEFont.meta).foregroundStyle(CE.ink3).fixedSize()
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(RepoRowStyle(selected: selected))
        .accessibilityLabel("\(repository.nameWithOwner)\(repository.visibility == "PRIVATE" ? ", 비공개" : "")")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
    private func load() async {
        loading = true; error = nil
        defer { loading = false }
        do { repositories = try await store.githubRepositories() }
        catch let issue as APIError where issue.status == 404 { repositories = GitHubRepositories(available: false) }
        catch { repositories = GitHubRepositories(available: false); self.error = error.localizedDescription }
        do {
            switch try await store.preferredFolder(forClone: true) {
            case .listing(let location): parent = location.path
            case .legacy: parent = store.recentProjectParent ?? "~/code"
            }
        } catch { self.error = error.localizedDescription }
    }
    private func clone() async {
        guard canClone, let repo, let client = store.api else { return }
        let name = repoName
        cloning = true; error = nil
        defer { cloning = false }
        do {
            if jobID == nil {
                cloneServerKey = serverKey
                jobID = try await store.startRepositoryClone(repo: repo, parent: parent)
            }
            guard cloneServerKey == serverKey else { throw APIError(status: 0, message: "원래 서버에 다시 연결한 뒤 결과를 확인해 주세요.") }
            guard let jobID else { return }
            while true {
                try Task.checkCancellation()
                guard cloneServerKey == serverKey, store.api === client else { throw APIError(status: 0, message: "서버 연결이 바뀌었습니다. 원래 서버에서 가져오기 결과를 확인해 주세요.") }
                let job = try await client.cloneJob(jobID)
                try Task.checkCancellation()
                guard cloneServerKey == serverKey, store.api === client else { throw APIError(status: 0, message: "서버 연결이 바뀌었습니다.") }
                switch job.status {
                case .running: try await Task.sleep(for: .seconds(1))
                case .done:
                    guard let path = job.path else { throw APIError(status: 0, message: "서버가 폴더 경로를 보내지 않았습니다.") }
                    onClone(path, name); dismiss(); return
                case .failed:
                    self.jobID = nil
                    throw APIError(status: 0, message: job.error ?? "저장소를 가져오지 못했습니다.")
                }
            }
        } catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
}

/// A repository in the list: a plain row (white .06 on hover); the picked one is drawn as a picked choice
/// (web .choice[data-on]: violet .24 with a 1.5pt violet .9 ring).
private struct RepoRowStyle: ButtonStyle {
    var selected = false
    func makeBody(configuration: Configuration) -> some View { RowBody(configuration: configuration, selected: selected) }
    private struct RowBody: View {
        let configuration: ButtonStyleConfiguration
        let selected: Bool
        @State private var hovering = false
        var body: some View {
            let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
            configuration.label
                .contentShape(shape)
                .background {
                    if selected {
                        shape.fill(CE.violet.opacity(configuration.isPressed ? 0.3 : 0.24))
                            .overlay { shape.strokeBorder(CE.violet.opacity(0.9), lineWidth: 1.5) }
                    } else {
                        shape.fill(Color.white.opacity(configuration.isPressed ? 0.09 : hovering ? 0.06 : 0))
                    }
                }
                .onHover { hovering = $0 }
        }
    }
}
