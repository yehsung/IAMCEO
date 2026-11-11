import Foundation

/// The sample workspace (`--demo` on Mac, "샘플로 둘러보기" on iPhone). It never connects or mutates the daemon.
/// It shows a team that is running well: people working in parallel, one waiting on the owner's answer, finished
/// reports, resting and sleeping members, and a couple of decisions waiting (the heart of the product). It holds no
/// errors, stuck approval windows or failed deliveries: a first look must not read as an unstable system.
enum DemoFixtures {
    static func workspace(now: Date = Date()) -> (Bootstrap, ProjectState) {
        let formatter = ISO8601DateFormatter()
        func ago(_ minutes: Double) -> String { formatter.string(from: now.addingTimeInterval(-minutes * 60)) }
        let connection = ProjectConnection(ok: true)
        let pid = "demo-pay"
        let project = Project(id: pid, name: "결제 페이지 개편", cwd: "~/Projects/shop-web", runnerEnabled: true,
                              now: "**자료 조사**가 결제 방식 비교표를 올렸고, **카드 결제 구현**은 결제 화면을 만들고 있습니다. PG사와 완료 문구 결정 2건이 대표의 답을 기다립니다.",
                              nowAt: ago(6), createdAt: ago(60 * 26), updatedAt: ago(6), connection: connection)

        let members = [
            Member(id: "m-chief", projectId: pid, handle: "chief", name: "결제 총괄", role: "프로젝트 총괄", kind: "conductor", cli: "claude", appliedModel: "opus", status: "working",
                   now: "PG 연동 결과와 문구 결정을 묶어 다음 지시를 정리하는 중", next: "결재 답이 오면 구현 팀장에게 전달", cwd: "~/Projects/shop-web", contextPct: 38, updatedAt: ago(1)),
            Member(id: "m-pg", projectId: pid, handle: "pg", name: "결제 연동", role: "PG 시험 연동 · 실패 코드", cli: "codex", appliedModel: "gpt-6-astra", status: "waiting",
                   now: "PG 시험 연동 — 실패 응답 코드 정리", next: "완료 문구가 정해지면 화면에 반영", cwd: "~/Projects/shop-web", contextPct: 22, updatedAt: ago(9)),
            Member(id: "m-copy", projectId: pid, handle: "copy", name: "화면 문구", role: "완료·실패 화면 문구", cli: "claude", appliedModel: "sonnet", status: "working",
                   now: "완료 화면 문구를 다듬는 중", next: "실패 화면 문구", cwd: "~/Projects/shop-web", contextPct: 51, subagents: 2, updatedAt: ago(0.5)),
            Member(id: "m-card", projectId: pid, handle: "card", name: "카드 결제 구현", role: "카드 결제 화면", cli: "codex", appliedModel: "gpt-6-astra", status: "working",
                   now: "카드 결제 화면 구현 — 결제 버튼과 입력 검증을 잇는 중", next: "시험 통과 후 결과 보고", cwd: "~/Projects/shop-web", contextPct: 44, subagents: 1, updatedAt: ago(2)),
            Member(id: "m-research", projectId: pid, handle: "research", name: "자료 조사", role: "PG 비교 · 계약 조건", cli: "claude", appliedModel: "sonnet", status: "idle",
                   now: "결제 방식 비교표를 정리했다고 보고", next: "PG 결정 뒤 계약 조건 요약", cwd: "~/Projects/shop-web", contextPct: 17, updatedAt: ago(20)),
            Member(id: "m-funnel", projectId: pid, handle: "funnel", name: "이탈률 측정", role: "결제 단계별 이벤트", cli: "codex", appliedModel: "gpt-6-astra", status: "idle",
                   now: "결제 단계별 이탈 이벤트 이름을 정리했다고 보고", next: "구현이 끝나면 이벤트 심기", cwd: "~/Projects/shop-web", contextPct: 28, updatedAt: ago(5)),
            Member(id: "m-qa", projectId: pid, handle: "qa", name: "결제 QA", role: "회귀 시험", cli: "claude", status: "asleep",
                   now: "", next: "구현이 끝나면 결제 회귀 시험", cwd: "~/Projects/shop-web", updatedAt: ago(90)),
            Member(id: "m-mail", projectId: pid, handle: "mail", name: "영수증 메일", role: "결제 완료 메일", cli: "claude", appliedModel: "sonnet", status: "idle",
                   now: "영수증 메일 템플릿 초안을 올렸다고 보고", next: "", cwd: "~/Projects/shop-web", contextPct: 12, updatedAt: ago(30)),
            Member(id: "m-settle", projectId: pid, handle: "settle", name: "정산 리포트", role: "일별 정산 요약", cli: "codex", status: "asleep",
                   now: "지난주 정산 요약을 보고", next: "", cwd: "~/Projects/shop-web", updatedAt: ago(60 * 20))
        ].map { member in
            var member = member
            member.backend = "core"
            member.nowAt = member.now.isEmpty ? nil : member.updatedAt
            member.statusObservation = StatusObservation(source: "core", observedAt: ago(0), freshness: "fresh",
                                                         ownership: "verified", consecutiveFailures: 0)
            member.subagentState = SubagentState(quality: "exact", count: member.subagents, observedAt: ago(0), sessionGeneration: 1)
            return member
        }

        let fee = FileDoc(id: "f-fee", kind: "document", projectId: pid, title: "결제 수단별 수수료 비교", who: "자료 조사", memberId: "m-research",
                          summary: "토스페이먼츠·KG이니시스의 수수료, 정산 주기, 연동 난이도를 비교했습니다.",
                          body: "# 결제 수단별 수수료 비교\n\n## 요약\n토스페이먼츠가 연동 문서와 정산 주기에서 앞서고, KG이니시스는 수수료가 0.2%p 낮습니다.\n\n## 비교\n| PG사 | 수수료 | 정산 | 연동 |\n|---|---:|:-:|---|\n| 토스페이먼츠 | 2.9% | D+2 | 시험 키 즉시 발급, `sandbox` 제공 |\n| KG이니시스 | 2.7% | D+3 | 기존 계약 있음, 시험 키는 2~3일 |\n\n> 결제 금액 1만~5만 원 구간이 전체 결제의 70%입니다.\n\n## 남은 확인\n- [x] 정산 주기 확인\n- [ ] 간편결제 수수료 별도 여부\n- [ ] 해지 위약금",
                          createdAt: ago(20))
        let files = [
            fee,
            FileDoc(id: "f-copy", kind: "artifact", projectId: pid, title: "완료·실패 화면 시안", who: "화면 문구", memberId: "m-copy", summary: "완료 화면 2안, 실패 화면 2안을 나란히 비교하는 HTML 시안", createdAt: ago(4)),
            FileDoc(id: "f-config", kind: "code", projectId: pid, title: "payment-config.ts", who: "카드 결제 구현", memberId: "m-card", summary: "PG 키와 결제 수단 설정", body: "export const payment = {\n  provider: process.env.PG_PROVIDER ?? \"toss\",\n  methods: [\"card\", \"transfer\", \"easy-pay\"],\n  retry: { max: 2, backoffMs: 800 },\n}", path: "src/payment/payment-config.ts", createdAt: ago(35)),
            FileDoc(id: "f-funnel", kind: "table", projectId: pid, title: "결제 단계별 이탈률", who: "이탈률 측정", memberId: "m-funnel", summary: "지난 4주 결제 단계별 이탈률", body: "단계,방문,이탈률\n장바구니,12840,18%\n주문서,10529,24%\n결제 수단 선택,8002,31%\n결제 완료,5521,-", createdAt: ago(60 * 22)),
            FileDoc(id: "f-shot", kind: "image", projectId: pid, title: "현재 결제 버튼 캡처", who: "카드 결제 구현", memberId: "m-card", summary: "모바일 결제 버튼 현재 상태", createdAt: ago(60 * 25))
        ]

        let decisions = [
            Decision(id: "d-pg", projectId: pid, memberId: "m-research", who: "자료 조사", title: "PG사를 어디로 할지 정해 주세요",
                     detail: "결제 연동을 시작하려면 PG사를 하나 정해야 합니다. 비교표를 자료에 올렸습니다.\n\n- 고객 문의 1위가 '결제됐나요?'라서 정산·알림이 빠른 쪽이 유리합니다\n- 기존 KG이니시스 계약은 내년 3월에 끝납니다",
                     options: [DecisionOption(k: "a", label: "토스페이먼츠", desc: "수수료 2.9%, 정산 D+2. 연동 문서가 가장 좋아 구현이 이틀 빠릅니다."),
                               DecisionOption(k: "b", label: "KG이니시스", desc: "수수료 2.7%, 정산 D+3. 기존 계약을 그대로 씁니다."),
                               DecisionOption(k: "c", label: "둘 다 붙이고 비교", desc: "구현이 3일 늘고, 2주 뒤 전환율로 고릅니다.")],
                     rec: "a", fileId: fee.id, createdAt: ago(25), updatedAt: ago(25)),
            Decision(id: "d-done-copy", projectId: pid, memberId: "m-pg", who: "결제 연동", title: "결제 완료 문구를 골라 주세요", detail: "완료 화면 첫 줄입니다. 사용자가 결제 성공을 바로 알아야 합니다.",
                     options: [DecisionOption(k: "a", label: "결제가 끝났습니다", desc: "결과를 바로 말합니다. 영수증 링크를 아래에 둡니다."), DecisionOption(k: "b", label: "감사합니다", desc: "친근하지만 성공 여부가 덜 분명합니다.")],
                     rec: "a", createdAt: ago(12), updatedAt: ago(12)),
            Decision(id: "d-fail-copy", projectId: pid, memberId: "m-copy", who: "화면 문구", title: "실패 문구를 골라 주세요", detail: "실패 화면 첫 줄입니다. 가장 흔한 실패 원인은 카드 한도와 인증 취소입니다.",
                     options: [DecisionOption(k: "a", label: "다시 시도해 주세요", desc: "원인을 말하지 않아 같은 실패가 반복될 수 있습니다."), DecisionOption(k: "b", label: "카드를 확인해 주세요", desc: "가장 흔한 원인을 바로 안내합니다.")],
                     rec: "b", status: "delivered", choice: "b", note: "고객센터 번호도 함께 보여 주세요.",
                     createdAt: ago(55), updatedAt: ago(9), answeredAt: ago(9), deliveredAt: ago(8)),
            Decision(id: "d-button", projectId: pid, memberId: "m-card", who: "카드 결제 구현", title: "결제 버튼 색을 정해 주세요", detail: "브랜드 보라와 기본 파랑 중 하나입니다.",
                     options: [DecisionOption(k: "a", label: "기본 파랑"), DecisionOption(k: "b", label: "브랜드 보라")], rec: "a", status: "delivered", choice: "a", note: "접근성 대비 기준을 지켜 주세요.",
                     createdAt: ago(60 * 3), updatedAt: ago(60 * 2), answeredAt: ago(60 * 2), deliveredAt: ago(60 * 2 - 1)),
            Decision(id: "d-receipt", projectId: pid, memberId: "m-pg", who: "결제 연동", title: "영수증 메일을 보낼까요?", detail: "결제 완료 직후 영수증 메일을 자동 발송할지 정해 주세요.",
                     options: [DecisionOption(k: "a", label: "보낸다"), DecisionOption(k: "b", label: "보내지 않는다")], status: "delivered", choice: "a",
                     createdAt: ago(50), updatedAt: ago(32), answeredAt: ago(32), deliveredAt: ago(31)),
            Decision(id: "d-old", projectId: pid, memberId: "m-research", who: "자료 조사", title: "비교 대상에 페이팔을 넣을까요?", detail: "해외 결제가 필요하면 넣습니다.", status: "closed",
                     createdAt: ago(60 * 5), updatedAt: ago(60 * 4), closeKind: "decided", closeReason: "대화에서 국내 결제만 한다고 정했습니다.", closeQuote: "해외 결제는 이번엔 빼죠", closedBy: "자료 조사", closedAt: ago(60 * 4))
        ]

        let todos = [
            Todo(id: "t-key", projectId: pid, memberId: "m-card", who: "카드 결제 구현", title: "PG 시험 계정 만들어 주기", detail: "토스페이먼츠 개발자센터에서 시험 키 발급이 필요합니다. 발급 뒤 키를 대화로 보내 주세요.", createdAt: ago(30)),
            Todo(id: "t-logo", projectId: pid, memberId: "m-pg", who: "결제 연동", title: "로고 원본 파일 보내기", detail: "완료 화면에 넣을 로고가 필요합니다.\n- SVG면 좋습니다\n- 없으면 PNG", createdAt: ago(18)),
            Todo(id: "t-policy", projectId: pid, memberId: "m-research", who: "자료 조사", title: "개인정보 처리방침 확인", detail: "결제 정보 보관 기간 문구를 법무 기준으로 확인해 주세요.", createdAt: ago(60 * 2)),
            Todo(id: "t-done", projectId: pid, who: "결제 총괄", title: "PG 담당자 연락처 전달", done: true, doneAt: ago(60 * 3), createdAt: ago(60 * 5))
        ]

        let work = [
            WorkItem(id: "w1", projectId: pid, sec: "doing", title: "PG 시험 연동", detail: "실패 응답 코드 표 정리", who: "결제 연동", order: 1),
            WorkItem(id: "w2", projectId: pid, sec: "doing", title: "완료·실패 화면 문구", who: "화면 문구", order: 2),
            WorkItem(id: "w3", projectId: pid, sec: "doing", title: "카드 결제 화면 구현", detail: "결제 버튼·입력 검증 연결", who: "카드 결제 구현", order: 3),
            WorkItem(id: "w4", projectId: pid, sec: "next", title: "이탈률 측정 넣기", who: "이탈률 측정", order: 4),
            WorkItem(id: "w5", projectId: pid, sec: "next", title: "결제 회귀 시험", who: "결제 QA", order: 5),
            WorkItem(id: "w6", projectId: pid, sec: "hold", title: "간편결제 추가", detail: "PG 결정 뒤 재개", who: "결제 총괄", order: 6),
            WorkItem(id: "w7", projectId: pid, sec: "done", title: "결제 방식 비교표", who: "자료 조사", order: 7, doneAt: ago(20)),
            WorkItem(id: "w8", projectId: pid, sec: "done", title: "영수증 메일 템플릿", who: "영수증 메일", order: 8, doneAt: ago(30)),
            WorkItem(id: "w9", projectId: pid, sec: "done", title: "결제 수단 목록 정리", who: "결제 총괄", order: 9, doneAt: ago(60 * 26))
        ]

        let messages = [
            Message(id: "x1", projectId: pid, at: ago(40), memberId: "m-chief", who: "결제 총괄", kind: "진행", title: "오늘 계획", body: "1. PG사 결정 받기\n2. 완료·실패 문구 확정\n3. 카드 결제 화면 시험 통과"),
            Message(id: "x2", projectId: pid, at: ago(38), mine: true, who: "나", kind: "나", body: "PG 연동은 이번 주 안에 끝내 주세요.", delivery: "delivered"),
            Message(id: "x3", projectId: pid, at: ago(20), memberId: "m-research", who: "자료 조사", kind: "완료", title: "결제 방식 비교표를 올렸습니다", body: "수수료·정산 주기·연동 난이도를 비교했습니다. PG사 결정은 결재함에 올렸습니다.", fileId: fee.id),
            Message(id: "x4", projectId: pid, at: ago(14), memberId: "m-card", who: "카드 결제 구현", kind: "진행", title: "카드 결제 화면 1차 구현", body: "- 카드 번호·유효기간 입력 검증\n- 결제 버튼 상태(대기·진행·완료)\n- 다음: 결제 버튼과 PG 시험 연동 잇기"),
            Message(id: "x5", projectId: pid, at: ago(12), memberId: "m-pg", who: "결제 연동", kind: "질문", title: "결제 완료 문구 결정 요청", body: "두 안 중 하나를 골라 주세요.", decisionId: "d-done-copy"),
            Message(id: "x6", projectId: pid, at: ago(8), mine: true, who: "나", kind: "나", body: "실패 화면에는 고객센터 번호도 넣어 주세요.", targetMemberId: "m-copy", targetName: "화면 문구", delivery: "delivered"),
            Message(id: "x7", projectId: pid, at: ago(7), mine: true, who: "나", kind: "나", body: "이탈 이벤트 이름부터 정리해 주세요.", targetMemberId: "m-funnel", targetName: "이탈률 측정", delivery: "delivered"),
            Message(id: "x11", projectId: pid, at: ago(5), memberId: "m-funnel", who: "이탈률 측정", kind: "완료", title: "이탈 이벤트 이름을 정리했습니다", body: "장바구니 → 주문서 → 결제 수단 선택 → 결제 완료, 네 단계의 이벤트 이름과 속성을 정했습니다. 지난 4주 이탈률 표는 자료에 있습니다.", fileId: "f-funnel"),
            Message(id: "x8", projectId: pid, at: ago(4), memberId: "m-copy", who: "화면 문구", kind: "진행", title: "완료 화면 문구 초안", body: "- 짧게 한 줄\n- 다음 행동 안내 한 줄\n- 영수증 링크는 버튼으로"),
            Message(id: "x9", projectId: pid, at: ago(2), mine: true, who: "나", kind: "나", body: "결제 버튼은 화면 아래에 고정해 주세요.", targetMemberId: "m-card", targetName: "카드 결제 구현", delivery: "delivered"),
            Message(id: "x10", projectId: pid, at: ago(1), mine: true, who: "나", kind: "나", body: "문구 결정은 오늘 오후에 할게요.", delivery: "delivered")
        ]

        let summaries = [
            ProjectSummary(id: "demo-hq", name: "본사", isHq: true, cwd: "~", now: "새 프로젝트 요청을 기다립니다.", runnerEnabled: true, connection: connection, memberCount: 1),
            ProjectSummary(id: pid, name: project.name, cwd: project.cwd, now: "PG사·완료 문구 결정 2건 대기", runnerEnabled: true, connection: connection,
                           decisionCount: 2, todoCount: 3, inboxCount: 5, workingCount: 3, memberCount: members.count),
            ProjectSummary(id: "demo-ir", name: "투자 IR 자료", cwd: "~/Projects/ir", now: "재무 요약 슬라이드 작성 중", runnerEnabled: true, connection: connection,
                           decisionCount: 1, todoCount: 0, inboxCount: 1, workingCount: 1, memberCount: 3)
        ]
        let bootstrap = Bootstrap(version: "sample", settings: Settings(backend: "core"), projects: summaries)
        // Every instruction arrived: nothing undelivered, nothing for the owner to chase.
        let deliveryNotices = DeliveryNotices(version: 2, members: [],
                                              unassigned: UnassignedDeliverySummary(undeliveredCount: 0, unknownCount: 0, needsOwnerCount: 0))
        let state = ProjectState(project: project, members: members, decisions: decisions, doneDecisionCount: 4, todos: todos, work: work, messages: messages, files: files, deliveryNotices: deliveryNotices)
        return (bootstrap, state)
    }
}
