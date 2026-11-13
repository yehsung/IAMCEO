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
                VStack(alignment: .leading, spacing: 4) {
                    Label(info.label, systemImage: info.icon)
                        .font(CEFont.section).foregroundStyle(info.tone.color)
                        .accessibilityLabel(info.explanation)
                    Text(info.explanation).font(CEFont.secondary).foregroundStyle(CE.ink2)
                        .ceLineHeight(13, 1.5)
                        .fixedSize(horizontal: false, vertical: true)
                }
                DeliveryWaitReasonView(summary: summary)
                if let error {
                    Text(error).font(CEFont.note).foregroundStyle(CE.danger)
                        .lineSpacing(CELeading.note)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(items) { item in
                    DeliveryNoticeRow(item: item, canWrite: canWrite,
                                      pending: pendingIDs.contains(item.deliveryId ?? item.id),
                                      onOpenMessage: onOpenMessage, onOpenReference: onOpenReference, onAction: onAction)
                }
                if isLoading { ProgressView().controlSize(.small).accessibilityLabel("전달 안내 불러오는 중") }
                if hasOlder, let onLoadOlder {
                    // A "load more" link (web .gbtn--ghost, size s).
                    Button("이전 전달 안내", action: onLoadOlder)
                        .ceGhostButton().controlSize(.small).disabled(isLoading)
                }
            }
        }
    }
}

/// One notice in three blocks, 12 apart: what (the state and the quoted message), why (explanation, evidence,
/// recommendation and one check-time line), and one wrapping row of actions.
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
        VStack(alignment: .leading, spacing: CESpace.m) {
            // A single 1pt hairline like every other divider (a Divider plus an overlay drew two).
            Rectangle().fill(CE.line).frame(height: 1)
            VStack(alignment: .leading, spacing: 6) {
                Label(info.label, systemImage: info.icon).font(CEFont.rowTitle).foregroundStyle(info.tone.color)
                if let preview = item.preview, !preview.isEmpty {
                    quoted(preview)
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(info.explanation).font(CEFont.secondary).foregroundStyle(CE.ink2)
                    .ceLineHeight(13, 1.5)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(Array((item.evidence ?? []).enumerated()), id: \.offset) { _, evidence in
                    let evidenceInfo = DeliveryEvidenceInfo(evidence)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(evidenceInfo.sourceLabel) · \(evidenceInfo.label)").font(CEFont.meta.weight(.semibold))
                        Text(evidenceInfo.detail).font(CEFont.secondary)
                            .ceLineHeight(13, 1.5)
                            .fixedSize(horizontal: false, vertical: true)
                        if let checked = parseISODate(evidence.checkedAt) {
                            Text("확인 \(deliveryShortTime(checked))").font(CEFont.meta).foregroundStyle(CE.ink3)
                                .help("확인 시각 · \(koDateTime(checked))")
                        }
                    }
                    .foregroundStyle(CE.ink2)
                    .padding(.top, 4)
                    // location/code may contain host paths or raw diagnostics; never render them.
                }
                if let recommendation = item.recommendation {
                    Text("추천 · \(recommendation.text)").font(CEFont.secondary).foregroundStyle(CE.ink2)
                        .ceLineHeight(13, 1.5)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let label = waitReasonLabel(item.waitReason, since: item.waitingSince, used: item.runLimit?.used, limit: item.runLimit?.limit) {
                    Text(label).font(CEFont.meta).foregroundStyle(waitReasonTone(item.waitReason).color)
                }
                checkLine
                if pending {
                    Label("작업 결과 확인 중", systemImage: "clock").font(CEFont.meta).foregroundStyle(CE.ink2)
                }
            }
            if hasActions {
                TeamWrapLayout(spacing: 8, lineSpacing: 8) {
                    if let id = item.messageId, let onOpenMessage {
                        Button("원문 보기") { onOpenMessage(id) }.ceSecondaryButton()
                    }
                    if let ref = item.ref, let onOpenReference {
                        Button("관련 항목 보기") { onOpenReference(ref) }.ceSecondaryButton()
                    }
                    actions
                }
                .controlSize(.small)
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

    private var hasActions: Bool {
        (item.messageId != nil && onOpenMessage != nil) || (item.ref != nil && onOpenReference != nil)
            || !deliveryPanelActions(item).isEmpty
    }

    /// The message as a quoted well (at most four lines; the full text is in 원문 보기).
    private func quoted(_ text: String) -> some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        return Text(text).font(CEFont.body).foregroundStyle(CE.ink)
            .lineLimit(4)
            .ceLineHeight(14.5, 1.55)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 12).padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(CE.bgDeep.opacity(0.5), in: shape)
            .overlay { shape.strokeBorder(CE.line) }
    }

    /// "마지막 확인 3분 전 · 다음 확인 14:20" on one line; the full dates are the tooltip.
    @ViewBuilder private var checkLine: some View {
        let last = parseISODate(item.lastCheckedAt)
        let next = parseISODate(item.nextCheckAt)
        if last != nil || next != nil {
            MetaText([last.map { _ in String(localized: "마지막 확인 \(relativeTime(item.lastCheckedAt))") },
                      next.map { String(localized: "다음 확인 \(deliveryShortTime($0))") }])
                .help([last.map { String(localized: "마지막 확인 · \(koDateTime($0))") }, next.map { String(localized: "다음 확인 · \(koDateTime($0))") }]
                    .compactMap { $0 }.joined(separator: "\n"))
        }
    }

    @ViewBuilder private var actions: some View {
        ForEach(deliveryPanelActions(item), id: \.rawValue) { action in
            Button(actionName(action)) {
                if action == .retryWithRisk { confirmingRisk = true }
                else { onAction(item, action, false) }
            }
            .ceSecondaryButton().disabled(!canWrite || pending)
        }
    }

    private func actionName(_ action: DeliveryRecoveryAction) -> String {
        switch action {
        case .recheck: String(localized: "다시 확인")
        case .retryWithRisk: String(localized: "위험 동의 후 재전송")
        case .stopRetry: String(localized: "delivery.action.stop_retry", defaultValue: "추가 전달 중지")
        case .unknown: String(localized: "지원하지 않는 행동")
        }
    }
}

/// Short Korean time for check lines, past or future: "14:20", "어제 14:20", "내일 14:20", "11월 4일 14:20",
/// and the full date in another year.
private func deliveryShortTime(_ date: Date, now: Date = Date()) -> String {
    let calendar = Calendar.current
    let time = koTime(date)
    if calendar.isDateInToday(date) { return time }
    if calendar.isDateInYesterday(date) { return String(localized: "어제 \(time)") }
    if calendar.isDateInTomorrow(date) { return String(localized: "내일 \(time)") }
    guard calendar.component(.year, from: date) == calendar.component(.year, from: now) else { return koDateTime(date) }
    if AppLanguage.current == .en { return "\(appFormatted(date, ko: "", en: "MMMd")) \(time)" }
    let parts = calendar.dateComponents([.month, .day], from: date)
    return "\(parts.month ?? 0)월 \(parts.day ?? 0)일 \(time)"
}

/// Uses the same copy and tones as chat and employee detail; supports old servers without waitReasons.
struct DeliveryWaitReasonView: View {
    let summary: MemberDeliverySummary?

    var body: some View {
        if let reasons = summary?.waitReasons, !reasons.isEmpty {
            ForEach(Array(reasons.enumerated()), id: \.offset) { _, reason in
                if let label = waitReasonLabel(reason.waitReason, since: reason.waitingSince,
                                              used: reason.runLimit?.used, limit: reason.runLimit?.limit) {
                    Text(label + (reason.count > 1 ? String(localized: " · \(reason.count)건") : ""))
                        .font(CEFont.meta).foregroundStyle(waitReasonTone(reason.waitReason).color)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        } else if let summary, let label = waitReasonLabel(summary.waitReason, since: summary.waitingSince,
                                                          used: summary.runLimit?.used, limit: summary.runLimit?.limit) {
            Text(label).font(CEFont.meta).foregroundStyle(waitReasonTone(summary.waitReason).color)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
