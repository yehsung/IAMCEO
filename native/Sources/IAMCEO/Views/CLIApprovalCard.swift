import SwiftUI

/// The existing inbox option tiles and confirmation bar, backed by the CLI approval API.
struct CLIApprovalCard: View {
    @Environment(AppStore.self) private var store
    let member: Member
    @State private var prompt: CLIApprovalPrompt?
    @State private var picked: Int?
    @State private var busy = false
    @State private var error: String?
    @State private var sent = false

    var body: some View {
        Group {
            if member.canReadCLIApproval {
                VStack(alignment: .leading, spacing: 8) {
                    if let prompt, !sent {
                        Text(prompt.title).font(CEFont.rowTitle).foregroundStyle(CE.ink)
                        Text(prompt.body).font(CEFont.secondary).foregroundStyle(CE.ink2).textSelection(.enabled)
                        Text(prompt.question).font(CEFont.secondary).foregroundStyle(CE.ink)
                        ForEach(prompt.options) { option in
                            OptionTile(option: DecisionOption(k: String(option.n), label: option.label), recommended: false,
                                       picked: picked == option.n, somethingPicked: picked != nil, wasLastChoice: false) {
                                picked = picked == option.n ? nil : option.n
                            }
                            .disabled(busy || !store.canWrite)
                        }
                        if let option = prompt.options.first(where: { $0.n == picked }) {
                            ConfirmBar(quoted: option.label, verb: " 선택 보내기", hint: nil, busy: busy,
                                       disabled: !store.canWrite, stretch: !isMac, shiftedAt: .distantPast,
                                       onConfirm: { Task { await answer(prompt, option: option.n) } }, onCancel: { picked = nil })
                        }
                    } else if sent {
                        Text("선택을 보냈습니다. 세션 상태를 확인하고 있습니다.").font(CEFont.secondary).foregroundStyle(CE.ink2)
                    }
                    if let error { Text(error).font(CEFont.secondary).foregroundStyle(CE.danger) }
                    if prompt == nil && !sent {
                        Button("승인 창 다시 읽기") { Task { await read() } }.ceSecondaryButton().disabled(busy || !store.canWrite)
                    }
                }
                .task(id: "\(store.writeNamespace)|\(member.id)|\(member.statusObservation?.observedAt ?? "")") { await read() }
            }
        }
    }

    @MainActor private func read() async {
        let namespace = store.writeNamespace
        do {
            let next = try await store.readCLIApproval(member)
            guard !Task.isCancelled, namespace == store.writeNamespace else { return }
            if next?.fingerprint != prompt?.fingerprint {
                picked = nil
                if next != nil { sent = false }
            }
            prompt = next
        } catch {
            guard !Task.isCancelled, namespace == store.writeNamespace else { return }
            prompt = nil; picked = nil; self.error = error.localizedDescription
        }
    }

    @MainActor private func answer(_ prompt: CLIApprovalPrompt, option: Int) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        if await store.answerCLIApproval(member, prompt: prompt, option: option) {
            sent = true; self.prompt = nil; picked = nil
        } else {
            error = store.errorMessage ?? "선택 결과를 확인하지 못했습니다. 창을 다시 확인하세요."
            picked = nil
            await read()
        }
    }
}
