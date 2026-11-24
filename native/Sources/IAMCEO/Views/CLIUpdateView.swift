import SwiftUI

// 0.2.11: 설정 › AI 모델 › 실행 환경의 Claude Code·Codex·Gemini 줄 아래에 붙는 새 판·업데이트 줄(CLIUpdateModels.swift).
// 새 판이 있으면 판과 확인 여부, 서버가 돌릴 수 있는 설치면 '업데이트' 단추 → 확인 창 → POST /api/cli-updates/:cli.
// 도는 동안은 단계(내려받는 중·설치 중·확인 중), 끝나면 올린 판과 '적용 중: N명 남음', 실패하면 까닭과 직접 할 명령.
// 서버가 돌릴 수 없는 설치는 직접 할 명령만 안내한다.

struct CLIUpdateLine: View {
    let info: CLIUpdateInfo
    let panel: CLIUpdatesPanel
    @Environment(AppStore.self) private var store
    @State private var confirming: CLIUpdateInfo?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            status
            if info.available, info.run?.active != true {
                line(CLIUpdateText.newVersion(info), tone: info.latestVerified ? CE.ink2 : CE.attention)
                if info.oneClick { button } else { line(CLIUpdateText.manual(info), tone: CE.ink2) }
            }
            if let error = panel.errors[info.cli] { line(error, tone: CE.danger) }
        }
        .padding(.top, 2)
        // 0.2.11: 새 판 띠의 '업데이트'나 CLI 새 판 알림으로 열렸으면 이 CLI 의 확인 창을 바로 띄운다.
        .onAppear { openRequestedConfirmation() }
        .onChange(of: SettingsNavigation.shared.revision) { _, _ in openRequestedConfirmation() }
        .confirmationDialog(confirming.map(CLIUpdateText.confirmTitle) ?? "",
                            isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
                            titleVisibility: .visible, presenting: confirming) { target in
            Button("업데이트") { Task { await panel.start(target, api: store.api) } }
            Button("취소", role: .cancel) {}
        } message: { target in
            Text(CLIUpdateText.confirmMessage(target))
        }
    }

    private func openRequestedConfirmation() {
        guard SettingsNavigation.shared.takeUpdate(cli: info.cli), info.canStart, store.connectionStatus == .connected else { return }
        confirming = info
    }

    @ViewBuilder private var status: some View {
        if let run = info.run {
            if run.active {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    line(CLIUpdateText.phase(run), tone: CE.ink2)
                }
                .accessibilityElement(children: .combine)
            } else if run.succeeded, !info.available {
                line(CLIUpdateText.done(run, pendingReopen: info.pendingReopen), tone: CE.success)
            } else if run.failed {
                line(CLIUpdateText.failure(run), tone: CE.danger)
                if let command = run.manualCommand ?? info.manualCommand, !command.isEmpty {
                    line(CLIUpdateText.manualCommand(command), tone: CE.ink2, mono: true)
                }
            }
        }
    }

    private var button: some View {
        let busy = panel.starting.contains(info.cli)
        return Button { confirming = info } label: {
            HStack(spacing: 6) {
                if busy { ProgressView().controlSize(.small) }
                Text("업데이트")
            }
        }
        .ceSecondaryButton().controlSize(.small)
        .disabled(busy || !info.canStart || store.connectionStatus != .connected)
        .accessibilityLabel("\(CLIUpdateText.name(info.cli)) \(info.latest ?? "")")
        .accessibilityHint(Text("업데이트"))
    }

    /// 점검표 줄의 작은 글과 같은 글자(SetupFont.hint, 명령은 SettingsRow 의 monoHint 와 같은 CEFont.mono).
    @ViewBuilder private func line(_ text: String, tone: Color, mono: Bool = false) -> some View {
        if mono {
            Text(text).font(CEFont.mono).foregroundStyle(tone)
                .ceLineHeight(12.5, 1.45)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        } else {
            Text(text).font(SetupFont.hint).foregroundStyle(tone)
                .lineSpacing(SetupFont.hintLeading)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }
}
