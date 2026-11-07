import SwiftUI

/// Shared Mac drawer / iPhone detail content. The caller owns loading, routing and durable operations.
struct DeliveryNoticeView: View {
    let summary: MemberDeliverySummary
    var items: [DeliveryNoticeItem] = []
    var canWrite = false
    var pendingIDs: Set<String> = []
    var error: String? = nil
    var hasOlder = false
    var isLoading = false
    var onLoadOlder: (() -> Void)? = nil
    var onOpenMessage: ((String) -> Void)? = nil
    var onOpenReference: ((DeliveryReference) -> Void)? = nil
    var onAction: (DeliveryNoticeItem, DeliveryRecoveryAction, Bool) -> Void

    var body: some View {
        let info = DeliveryInfo(summary)
        Plate {
            VStack(alignment: .leading, spacing: CESpace.m) {
                Label(info.label, systemImage: info.icon)
                    .font(CEFont.section).foregroundStyle(info.tone.color)
                    .accessibilityLabel(info.explanation)
                Text(info.explanation).font(CEFont.secondary).foregroundStyle(CE.ink2)
                if let error {
                    Text(error).font(CEFont.secondary).foregroundStyle(CE.danger)
                }
                ForEach(items) { item in
                    DeliveryNoticeRow(item: item, canWrite: canWrite,
                                      pending: pendingIDs.contains(item.deliveryId ?? item.id),
                                      onOpenMessage: onOpenMessage, onOpenReference: onOpenReference, onAction: onAction)
                }
                if isLoading { ProgressView().accessibilityLabel("전달 안내 불러오는 중") }
                if hasOlder, let onLoadOlder {
                    Button("이전 전달 안내", action: onLoadOlder)
                        .buttonStyle(CEQuietButtonStyle()).disabled(isLoading)
                }
            }
        }
    }
}

private struct DeliveryNoticeRow: View {
    let item: DeliveryNoticeItem
    let canWrite: Bool
    let pending: Bool
    let onOpenMessage: ((String) -> Void)?
    let onOpenReference: ((DeliveryReference) -> Void)?
    let onAction: (DeliveryNoticeItem, DeliveryRecoveryAction, Bool) -> Void
    @State private var confirmingRisk = false

    var body: some View {
        let info = DeliveryInfo(item)
        VStack(alignment: .leading, spacing: CESpace.s) {
            Divider().overlay(CE.line)
            Label(info.label, systemImage: info.icon).font(CEFont.rowTitle).foregroundStyle(info.tone.color)
            if let preview = item.preview, !preview.isEmpty {
                Text(preview).font(CEFont.body).foregroundStyle(CE.ink).textSelection(.enabled)
            }
            Text(info.explanation).font(CEFont.secondary).foregroundStyle(CE.ink2)
            if let id = item.messageId, let onOpenMessage {
                Button("원문 보기") { onOpenMessage(id) }.buttonStyle(CEQuietButtonStyle())
            }
            if let ref = item.ref, let onOpenReference {
                Button("관련 항목 보기") { onOpenReference(ref) }.buttonStyle(CEQuietButtonStyle())
            }
            ForEach(Array((item.evidence ?? []).enumerated()), id: \.offset) { _, evidence in
                let evidenceInfo = DeliveryEvidenceInfo(evidence)
                VStack(alignment: .leading, spacing: CESpace.xs) {
                    Text("\(evidenceInfo.sourceLabel) · \(evidenceInfo.label)").font(CEFont.meta.weight(.semibold))
                    Text(evidenceInfo.detail).font(CEFont.secondary)
                    timestamp("확인 시각", evidence.checkedAt)
                }
                .foregroundStyle(CE.ink2)
                // location/code may contain host paths or raw diagnostics; never render them.
            }
            timestamp("마지막 확인", item.lastCheckedAt)
            timestamp("다음 확인", item.nextCheckAt)
            if let recommendation = item.recommendation {
                Text("추천 · \(recommendation.text)").font(CEFont.secondary).foregroundStyle(CE.ink2)
            }
            if pending {
                Label("작업 결과 확인 중", systemImage: "clock").font(CEFont.meta).foregroundStyle(CE.ink2)
            }
            ViewThatFits(in: .horizontal) {
                HStack { actions }
                VStack(alignment: .leading) { actions }
            }
        }
        .confirmationDialog("중복 전달 위험을 감수하고 다시 보낼까요?", isPresented: $confirmingRisk, titleVisibility: .visible) {
            Button("위험을 감수하고 한 번 재전송", role: .destructive) {
                // Re-evaluate the latest row value after an open confirmation receives an update.
                if canWrite && !pending && deliveryPanelActions(item).contains(.retryWithRisk) {
                    onAction(item, .retryWithRisk, true)
                }
            }
            Button("취소", role: .cancel) {}
        } message: {
            Text("과거 수신 여부는 확정할 수 없습니다. 같은 지시가 두 번 실행될 수 있으며, 서버가 최신 안전 조건을 다시 검사합니다.")
        }
        .onChange(of: item.version) { _, _ in confirmingRisk = false }
        .onChange(of: canWrite) { _, writable in if !writable { confirmingRisk = false } }
    }

    @ViewBuilder private var actions: some View {
        ForEach(deliveryPanelActions(item), id: \.rawValue) { action in
            Button(actionName(action)) {
                if action == .retryWithRisk { confirmingRisk = true }
                else { onAction(item, action, false) }
            }
            .buttonStyle(CEQuietButtonStyle()).disabled(!canWrite || pending)
        }
    }

    @ViewBuilder private func timestamp(_ label: String, _ value: String?) -> some View {
        if let date = parseISODate(value) {
            Text("\(label) · \(koDateTime(date))").font(CEFont.meta).foregroundStyle(CE.ink3)
        }
    }

    private func actionName(_ action: DeliveryRecoveryAction) -> String {
        switch action {
        case .recheck: "다시 확인"
        case .retryWithRisk: "위험 동의 후 재전송"
        case .stopRetry: "추가 전달 중지"
        case .unknown: "지원하지 않는 행동"
        }
    }
}
