// 0.2.10: 쌓인 전달 이력 전체를 읽지 않고 살아 있는 것만 읽는 길(전달 알림·펌프 울타리·대화 쪽·고아 보고 점검·결과 보고 누락 안내 등)이
// 예전 길과 같은 답을 내는지, 드문 상태를 고루 섞은 같은 고정물에서 예전 알고리즘(이 파일에 그대로 옮겨 둔 것)과 맞대 본다.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { DeliveryRecovery } from "../server/delivery-recovery.ts";
import { Store } from "../server/store.ts";
import type { DeliveryInspection, DeliveryProbe, RunnerMember } from "../server/runner/types.ts";
import type { Delivery, DeliveryNoticeItem, Member, Message } from "../shared/types.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

/** status, hold_reason, phase, reason. phase 'none' 은 사유가 언제나 NULL 이다(코드의 불변식, LIVE_DELIVERIES_SQL 주석). */
const STATES: [string, string | null, string, string | null][] = [
  ["queued", null, "none", null], ["held", "delivery_unknown", "none", null], ["held", "asleep", "none", null], ["delivering", null, "none", null],
  ["held", "delivery_unknown", "checking", "inflight_unsettled"], ["held", "input_busy", "waiting", "input_busy"], ["held", "delivery_unknown", "waiting", "busy"],
  ["held", "delivery_unknown", "retry_wait", "not_received"], ["held", "delivery_unknown", "needs_owner", "log_missing"], ["held", "stale_instruction", "needs_owner", "stale_instruction"],
  ["failed", null, "needs_owner", "retry_exhausted"], ["failed", null, "resolved", "not_received"], ["failed", null, "stopped", null], ["failed", null, "none", null],
  ["queued", null, "resolved", "not_received"], ["held", null, "resolved", "not_received"], ["delivered", null, "needs_owner", "duplicate_draft"],
  ["delivered", null, "waiting", "duplicate_draft"], ["delivered", null, "checking", "duplicate_draft"], ["delivered", null, "resolved", null],
  ["delivered", null, "stopped", null], ["delivered", null, "none", null], ["delivered", null, "resolved", "duplicate_draft"],
];

function fixture() {
  const db = openDb(":memory:");
  cleanup.push(() => db.close());
  const store = new Store(db, new Bus());
  const project = store.createProject({ name: "전달 이력", cwd: "/private/tmp/iamceo-live-reads" });
  const other = store.createProject({ name: "다른 프로젝트", cwd: "/private/tmp/iamceo-live-reads-other" });
  const make = (projectId: string, handle: string, kind: "conductor" | "worker") =>
    store.createMember({ projectId, handle, name: handle, kind, backend: "core", paneId: `t-${handle}`, sessionId: `s-${handle}` });
  const lead = make(project.id, "lead", "conductor"), pay = make(project.id, "pay", "worker"), ship = make(project.id, "ship", "worker");
  const far = make(other.id, "far", "worker");
  const service = new DeliveryRecovery({ store, runner: () => null, now: () => NOW });
  let seq = 0;
  const at = () => iso(NOW - 3_600_000 + (++seq) * 1000);
  const ownerMessage = (target: Member, delivery = "delivered") => {
    const m = store.createMessage({ projectId: target.projectId, who: "대표", kind: "나", mine: true, body: `대표 지시 ${++seq}`, targetMemberId: target.id, at: at() });
    db.query("UPDATE messages SET delivery = ? WHERE id = ?").run(delivery, m.id);
    return m;
  };
  const report = (author: Member, kind: "완료" | "진행" | "막힘" | "알림" = "완료") =>
    store.createMessage({ projectId: author.projectId, memberId: author.id, who: author.name, kind, body: `보고 ${++seq}`, at: at() });
  const deliver = (target: Member, state: (typeof STATES)[number], ref?: { type: "message" | "decision" | "todo"; id: string }, kind: Delivery["kind"] = ref?.type === "message" ? "user_message" : "instruction", revision: string | null = null) => {
    const d = store.enqueue({ projectId: target.projectId, memberId: target.id, kind, text: `전달 ${++seq}`, refType: ref?.type ?? null, refId: ref?.id ?? null, sourceRevision: revision });
    const [status, hold, phase, reason] = state;
    db.query("UPDATE deliveries SET status = ?, hold_reason = ?, attempts = ? WHERE id = ?").run(status, hold, seq % 2, d.id);
    db.query("UPDATE delivery_recovery SET phase = ?, reason = ?, next_check_at = ?, last_checked_at = ? WHERE delivery_id = ?")
      .run(phase, reason, phase === "none" ? null : iso(NOW - 1000), iso(NOW - 30_000), d.id);
    return store.requireDelivery(d.id);
  };
  const dispatch = (target: Member, state: string, items: Delivery[]) => {
    const id = `dp_${++seq}`, wire = `봉투 ${id}`;
    const identity = JSON.stringify({ terminalId: target.paneId, sessionId: target.sessionId, sessionGeneration: store.memberRevisions(target.id).sessionGeneration, process: null });
    db.query(`INSERT INTO delivery_dispatches (id, project_id, member_id, bundle_marker, cli, backend, generation, native_session_id, terminal_identity_json, baseline_json, wire_text, wire_sha256, transport_state, submit_attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'claude', 'core', ?, ?, ?, '{}', ?, ?, ?, 0, ?, ?)`).run(id, target.projectId, target.id, `#b_${id}`, store.memberRevisions(target.id).sessionGeneration, target.sessionId, identity, wire,
      createHash("sha256").update(wire).digest("hex"), state, at(), at());
    items.forEach((d, i) => db.query("INSERT INTO delivery_dispatch_items (dispatch_id, delivery_id, ordinal, source_revision) VALUES (?, ?, ?, 'r')").run(id, d.id, i));
    return id;
  };
  const refs = (source: Message, corrects: Message | null, sequence: number) => db.query(`INSERT INTO report_references (source_message_id, project_id, file_ids_json, decision_ids_json, authored_at, sequence, corrects_message_id)
    VALUES (?, ?, '[]', '[]', ?, ?, ?)`).run(source.id, source.projectId, source.at, sequence, corrects?.id ?? null);

  // 모든 상태를 팀장마다, 원문 있음/없음으로 고루 만든다.
  const all: Delivery[] = [];
  for (const target of [lead, pay, ship, far]) for (const [i, state] of STATES.entries()) {
    const ref = i % 3 === 0 ? { type: "message" as const, id: ownerMessage(target).id } : undefined;
    all.push(deliver(target, state, ref));
  }
  // 같은 팀장·같은 원문·같은 판을 다시 보낸 전달: 앞선 '확정 미전달' 실패는 알림에서 숨는다. 다른 판·다른 팀장은 숨지 않는다.
  const resent = ownerMessage(pay, "failed");
  const firstFail = deliver(pay, ["failed", null, "needs_owner", "retry_exhausted"], { type: "message", id: resent.id }, "user_message", "rev-1");
  const sameRev = deliver(pay, ["queued", null, "none", null], { type: "message", id: resent.id }, "user_message", "rev-1");
  const otherRev = deliver(pay, ["failed", null, "needs_owner", "retry_exhausted"], { type: "message", id: resent.id }, "user_message", "rev-2");
  const lastFail = deliver(pay, ["failed", null, "none", null], { type: "message", id: resent.id }, "user_message", "rev-3");
  const otherMember = deliver(ship, ["failed", null, "needs_owner", "retry_exhausted"], { type: "message", id: resent.id }, "user_message", "rev-1");
  all.push(firstFail, sameRev, otherRev, lastFail, otherMember);
  // 받는 이가 바뀌어 여러 번 생긴 대표 글 전달(마지막 것이 답 상태의 근거).
  const handed = ownerMessage(ship);
  all.push(deliver(ship, ["delivered", null, "none", null], { type: "message", id: handed.id }), deliver(lead, ["queued", null, "none", null], { type: "message", id: handed.id }));
  // 정체 표시: 풀린 것과 안 풀린 것.
  for (const [i, d] of all.filter(d => ["queued", "held", "delivering"].includes(d.status)).entries()) {
    db.query("INSERT OR REPLACE INTO delivery_stalls (delivery_id, detected_at, resolved_at) VALUES (?, ?, ?)").run(d.id, iso(NOW - 300_000), i % 2 ? iso(NOW - 60_000) : null);
  }
  // 봉투: 오래된 것은 끝났고, 몇 개는 쓰기 결과를 모른다(prepared·write_started·unknown).
  const states = ["accepted", "rejected", "prepared", "accepted", "write_started", "accepted", "unknown", "accepted"];
  for (const target of [lead, pay, ship]) {
    const own = all.filter(d => d.memberId === target.id);
    own.forEach((d, i) => dispatch(target, states[i % states.length]!, [d]));
    dispatch(target, "accepted", own.slice(0, 3));
    dispatch(target, "unknown", own.slice(3, 5));
  }
  // 전달 기록이 없는 실패한 대표 글(가상 알림).
  ownerMessage(lead, "failed"); ownerMessage(pay, "failed");
  // 보고 출처와 정정 사슬(같은 글을 두 번 정정한 것 포함).
  const original = report(pay), fix1 = report(pay), fix2 = report(pay), plain = report(ship);
  refs(original, null, 1); refs(fix1, original, 2); refs(fix2, original, 3); refs(plain, null, 4);
  report(lead, "진행"); report(ship, "막힘"); report(pay, "알림");
  return { db, store, service, project, other, lead, pay, ship, far, all, firstFail, sameRev, otherRev, lastFail, otherMember, resent, handed, original, fix1, fix2, ownerMessage, report, deliver, dispatch };
}

// ---- 예전 알고리즘(0.2.9 그대로). 비교 기준이다. ----
type Svc = { item(d: Delivery, previews: Map<string, string>): DeliveryNoticeItem | null; definitelyAbsent(d: Delivery): boolean; virtual(m: Message): DeliveryNoticeItem;
  summarize(memberId: string, items: DeliveryNoticeItem[]): unknown; logicalFence(d: Delivery): boolean; items(projectId: string, includePreviews?: boolean): DeliveryNoticeItem[] };
function legacyItems(f: ReturnType<typeof fixture>, projectId: string, includePreviews: boolean): DeliveryNoticeItem[] {
  const svc = f.service as unknown as Svc;
  return f.store.withDeliveryRead(projectId, () => {
    const deliveries = f.store.listDeliveries(projectId);
    const previews = includePreviews ? f.store.deliveryNoticePreviews(projectId) : new Map<string, string>();
    const last = new Map<string, string>();
    const key = (d: Delivery) => { const revision = f.store.getDeliveryRetry(d.id).sourceRevision; return d.refType && d.refId && revision ? JSON.stringify([d.memberId, d.refType, d.refId, revision]) : null; };
    for (const d of deliveries) { const k = key(d); if (k) last.set(k, d.id); }
    const items: DeliveryNoticeItem[] = [];
    for (const d of deliveries) {
      const k = key(d);
      if (d.status === "failed" && svc.definitelyAbsent(d) && k && last.get(k) !== d.id) continue;
      const item = svc.item(d, previews);
      if (item) items.push(item);
    }
    for (const m of f.store.listUnlinkedFailedMessages(projectId)) items.push(svc.virtual(m));
    return items;
  });
}
function legacyNotices(f: ReturnType<typeof fixture>, projectId: string) {
  const svc = f.service as unknown as Svc;
  const items = legacyItems(f, projectId, false);
  const unassigned = svc.summarize("", items) as { undeliveredCount: number; unknownCount: number; needsOwnerCount: number };
  return { version: 2, unassignedItems: items.filter(item => item.memberId === ""), reportNotices: f.store.listMissingReportNotices(projectId),
    members: f.store.listMembers(projectId).map(m => svc.summarize(m.id, items)), unassigned: { undeliveredCount: unassigned.undeliveredCount, unknownCount: unassigned.unknownCount, needsOwnerCount: unassigned.needsOwnerCount } };
}
const LEGACY_CANDIDATES = `SELECT d.* FROM deliveries d JOIN delivery_recovery r ON r.delivery_id = d.id
  WHERE r.phase NOT IN ('none','resolved','stopped') OR d.status IN ('failed','delivering')
    OR (d.status = 'held' AND d.hold_reason = 'delivery_unknown')
    OR EXISTS (SELECT 1 FROM delivery_dispatch_items i JOIN delivery_dispatches p ON p.id = i.dispatch_id
      WHERE i.delivery_id = d.id AND p.transport_state IN ('prepared','write_started','unknown'))
  ORDER BY d.rowid`;
const LEGACY_ATTENTION = `SELECT 1 FROM delivery_recovery r JOIN deliveries d ON d.id = r.delivery_id
  WHERE d.project_id = ? AND (r.phase = 'needs_owner' OR (r.phase IN ('none','resolved')
    AND EXISTS (SELECT 1 FROM delivery_stalls s WHERE s.delivery_id = d.id AND s.resolved_at IS NULL))) LIMIT 1`;
const LEGACY_UNLINKED = `SELECT m.id FROM messages m WHERE m.project_id = ? AND m.mine = 1 AND m.delivery = 'failed'
  AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.project_id = m.project_id AND d.ref_type = 'message' AND d.ref_id = m.id)
  ORDER BY m.at DESC, m.id DESC`;

describe("살아 있는 전달만 읽어도 예전과 같은 답 (0.2.10)", () => {
  test("전달 알림(notices·items·대표 판단 수)은 이력 전체를 돌던 예전 계산과 같다", () => {
    const f = fixture();
    const svc = f.service as unknown as Svc;
    for (const p of [f.project, f.other]) {
      expect(svc.items(p.id, false)).toEqual(legacyItems(f, p.id, false));
      expect(svc.items(p.id, true)).toEqual(legacyItems(f, p.id, true));
      expect(f.service.notices(p.id)).toEqual(legacyNotices(f, p.id) as never);
    }
    const ids = svc.items(f.project.id).map(item => item.deliveryId);
    // 같은 팀장·같은 원문·같은 판을 뒤에 다시 보낸 확정 미전달 실패는 숨고, 다른 판·다른 팀장의 실패와 옛 실패(phase none)는 남는다.
    expect(ids).not.toContain(f.firstFail.id);
    expect(ids).toEqual(expect.arrayContaining([f.otherRev.id, f.lastFail.id, f.otherMember.id, f.sameRev.id]));
    // 전달됐지만 확인이 끝나지 않은 중복 초안도 알림이다(살아 있는 전달에 든다).
    expect(svc.items(f.project.id).some(item => item.status === "delivered" && item.reason === "duplicate_draft")).toBe(true);
    // 홈 요약의 대표 판단 수(needsCount)도 같은 알림에서 센다.
    const summary = f.store.projectSummaries().find(p => p.id === f.project.id)!;
    expect(summary.needsCount).toBeGreaterThan(0);
  });

  test("알림이 될 수 있는 전달은 모두 살아 있는 전달에 들고, 미리보기는 그 전달들에 대해 예전과 같다", () => {
    const f = fixture();
    const svc = f.service as unknown as Svc;
    for (const p of [f.project, f.other]) f.store.withDeliveryRead(p.id, () => {
      const live = new Set(f.store.listLiveDeliveries(p.id).map(d => d.id));
      const full = f.store.deliveryNoticePreviews(p.id), narrow = f.store.deliveryNoticePreviews(p.id, f.store.listLiveDeliveries(p.id));
      for (const d of f.store.listDeliveries(p.id)) {
        if (svc.item(d, new Map())) expect(live.has(d.id)).toBe(true);
        if (live.has(d.id) && d.refType && d.refId) expect(narrow.get(`${d.refType}:${d.refId}`)).toBe(full.get(`${d.refType}:${d.refId}`));
      }
    });
  });

  test("펌프 울타리(fenced)와 수리 전 울타리 후보는 이력 전체에서 찾던 것과 같다", () => {
    const f = fixture();
    const svc = f.service as unknown as Svc & { settleProvenDispatches(memberId: string): void };
    for (const m of [f.lead, f.pay, f.ship, f.far]) {
      svc.settleProvenDispatches(m.id);
      const legacy = f.store.listDeliveries(m.projectId).filter(d => d.memberId === m.id && svc.logicalFence(d)).map(d => d.id);
      const candidates = f.store.listFenceCandidates(m.id);
      expect(candidates.filter(d => svc.logicalFence(d)).map(d => d.id)).toEqual(legacy);
      const state = f.store.inputState(m.id);
      const old = !!state.lease || state.unresolvedDispatches.some(d => ["prepared", "write_started", "unknown"].includes(d.transportState)) || legacy.length > 0;
      expect(f.service.fenced(m.id)).toBe(old);
    }
  });

  test("봉투 조회(풀리지 않은 것·마지막·이 전달의 것·쓰기 결과 모름·마지막 봉투)는 이력 전체를 거른 것과 같다", () => {
    const f = fixture();
    for (const m of [f.lead, f.pay, f.ship, f.far]) {
      const all = f.store.listDispatches(m.id);
      const legacyUnresolved = all.filter(d => ["prepared", "write_started", "unknown"].includes(d.transportState) || d.items.some(item => {
        const r = f.store.getDeliveryRecovery(item.deliveryId);
        return r !== null && !(r.phase === "waiting" && r.reason === "input_busy" || r.phase === "needs_owner" && r.reason === "stale_instruction") && !["none", "resolved", "stopped"].includes(r.phase);
      }));
      expect(f.store.inputState(m.id).unresolvedDispatches).toEqual(legacyUnresolved);
      expect(f.store.listPhysicalDispatches(m.id)).toEqual(all.filter(d => ["prepared", "write_started", "unknown"].includes(d.transportState)));
      expect(f.store.lastDispatch(m.id)).toEqual(all.length ? { dispatchId: all.at(-1)!.dispatchId, createdAt: all.at(-1)!.createdAt } : null);
      const ids = f.all.map(d => d.id);
      const touching = f.store.listDispatchesTouching(m.id, ids.slice(0, 7));
      expect(touching).toEqual(all.filter(d => ["prepared", "write_started", "unknown"].includes(d.transportState) || d.items.some(i => ids.slice(0, 7).includes(i.deliveryId))));
      for (const d of f.all) {
        const legacy = all.filter(x => x.items.some(i => i.deliveryId === d.id));
        expect(f.store.listDispatchesFor(m.id, d.id)).toEqual(legacy);
        expect(f.store.latestDispatchFor(m.id, d.id)).toEqual(legacy.at(-1) ?? null);
      }
    }
  });

  test("전달 확인 후보·attention·전달 없는 실패 글·원문별 전달·뒤에 다시 보낸 같은 판은 예전 쿼리와 같다", () => {
    const f = fixture();
    expect(f.store.listDeliveryRecoveryCandidates().map(d => d.id)).toEqual((f.db.query(LEGACY_CANDIDATES).all() as { id: string }[]).map(r => r.id));
    for (const p of [f.project, f.other]) {
      expect(f.store.hasDeliveryAttention(p.id)).toBe(!!f.db.query(LEGACY_ATTENTION).get(p.id));
      expect(f.store.listUnlinkedFailedMessages(p.id).map(m => m.id)).toEqual((f.db.query(LEGACY_UNLINKED).all(p.id) as { id: string }[]).map(r => r.id));
      const deliveries = f.store.listDeliveries(p.id);
      for (const d of deliveries) {
        if (d.refType && d.refId) expect(f.store.listDeliveriesByRef(d.refType, d.refId, p.id)).toEqual(deliveries.filter(x => x.refType === d.refType && x.refId === d.refId));
        const revision = f.store.getDeliveryRetry(d.id).sourceRevision;
        const later = !!(d.refType && d.refId && revision) && deliveries.slice(deliveries.findIndex(x => x.id === d.id) + 1)
          .some(x => x.memberId === d.memberId && x.refType === d.refType && x.refId === d.refId && f.store.getDeliveryRetry(x.id).sourceRevision === revision);
        expect(f.store.hasLaterSameSource(d)).toBe(later);
      }
    }
    expect(f.store.listDeliveriesByRef("message", f.resent.id).map(d => d.id)).toEqual(f.store.listDeliveries().filter(d => d.refType === "message" && d.refId === f.resent.id).map(d => d.id));
    // 대표 판단 수의 빠른 길(전달 복구가 붙지 않은 저장소)도 phase 색인으로 같은 수를 센다.
    const plain = new Store(f.db, new Bus());
    const count = (f.db.query("SELECT COUNT(*) AS n FROM delivery_recovery r JOIN deliveries d ON d.id = r.delivery_id WHERE d.project_id = ? AND r.phase = 'needs_owner'").get(f.project.id) as { n: number }).n;
    const summary = plain.projectSummaries().find(p => p.id === f.project.id)!;
    expect(summary.needsCount! - summary.decisionCount - summary.todoCount).toBe(count);
  });

  test("대화 쪽의 글(정정·보고 출처·대표 글 전달·답 상태)은 묶음 밖에서 글마다 읽은 것과 같다", () => {
    const f = fixture();
    for (const p of [f.project, f.other]) for (const scope of [{ kind: "project" as const }, ...f.store.listMembers(p.id).map(m => ({ kind: "member" as const, memberId: m.id }))]) {
      let cursor: string | undefined;
      do {
        const page = f.store.listMessagePage(p.id, { limit: 7, cursor, scope });
        for (const item of page.items) expect(item).toEqual(f.store.getMessage(item.id)!);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    }
    const state = f.store.projectState(f.project.id);
    for (const item of state.messages) expect(item).toEqual(f.store.getMessage(item.id)!);
    const original = state.messages.find(m => m.id === f.original.id)!;
    // 두 번 정정한 글은 마지막 정정(sequence 가 큰 것)을 가리킨다.
    expect(original.supersededBy).toBe(f.fix2.id);
    expect(state.messages.find(m => m.id === f.fix1.id)!.supersedes).toBe(f.original.id);
  });

  test("인용 대조의 대화 읽기는 같은 쪽·같은 경계(같은 시각)의 본문을 조립 없이 준다", () => {
    const f = fixture();
    const sameAt = iso(NOW - 10_000);
    for (let i = 0; i < 5; i++) f.store.createMessage({ projectId: f.project.id, who: "대표", kind: "나", mine: true, body: `같은 시각 ${i}`, at: sameAt });
    for (const limit of [1, 3, 7, 500]) {
      let before: string | undefined;
      for (let page = 0; page < 20; page++) {
        const old = f.store.listMessages(f.project.id, { before, limit }).map(m => ({ id: m.id, at: m.at, body: m.body, mine: m.mine }));
        expect(f.store.listMessageBodies(f.project.id, { before, limit })).toEqual(old);
        if (old.length < limit) break;
        before = old[0]!.at;
      }
    }
  });
});

describe("30초 틱의 고아 보고 점검 (0.2.10)", () => {
  const legacy = (f: ReturnType<typeof fixture>) => {
    const lead = f.store.getConductor(f.project.id)!;
    return f.store.listReportsMissingDeliveries(f.project.id).filter(m => { const a = m.memberId ? f.store.getMember(m.memberId) : null; return a?.kind === "worker" && a.id !== lead.id; });
  };
  const tick = (f: ReturnType<typeof fixture>) => f.store.transaction(() => {
    const lead = f.store.getConductor(f.project.id)!;
    const found = f.store.listWorkerReportsMissingDeliveries(f.project.id, lead.id);
    for (const m of found) f.store.enqueue({ projectId: f.project.id, memberId: lead.id, kind: "report", text: m.body, refType: "message", refId: m.id });
    return found.map(m => m.id);
  });

  test("직원 보고만 골라 조립하고, 넘긴 뒤에는 새 보고만 본다. 총괄 자신의 보고는 고르지 않는다", () => {
    const f = fixture();
    const expected = legacy(f).map(m => m.id);
    expect(expected.length).toBeGreaterThan(0);
    expect(f.store.listWorkerReportsMissingDeliveries(f.project.id, f.lead.id)).toEqual(legacy(f));
    expect(tick(f)).toEqual(expected);
    expect(tick(f)).toEqual([]);
    expect(legacy(f)).toEqual([]);
    const fresh = f.report(f.ship, "진행");
    f.report(f.lead, "완료");
    expect(tick(f)).toEqual([fresh.id]);
    expect(tick(f)).toEqual([]);
  });

  test("총괄을 지워 넘김이 함께 지워지면 물높이를 버리고 새 총괄에게 다시 넘긴다(예전과 같다)", () => {
    const f = fixture();
    tick(f);
    expect(tick(f)).toEqual([]);
    f.store.removeMember(f.lead.id);
    const next = f.store.createMember({ projectId: f.project.id, handle: "lead2", name: "새 총괄", kind: "conductor", backend: "core", paneId: "t-lead2", sessionId: "s-lead2" });
    const again = legacy(f).map(m => m.id);
    expect(again.length).toBeGreaterThan(0);
    expect(f.store.listWorkerReportsMissingDeliveries(f.project.id, next.id).map(m => m.id)).toEqual(again);
    expect(tick(f)).toEqual(again);
    expect(tick(f)).toEqual([]);
  });

  test("되돌려진 점검은 물높이를 옮기지 않는다", () => {
    const f = fixture();
    const expected = legacy(f).map(m => m.id);
    expect(() => f.store.transaction(() => { tick(f); throw new Error("rollback"); })).toThrow("rollback");
    expect(f.store.listWorkerReportsMissingDeliveries(f.project.id, f.lead.id).map(m => m.id)).toEqual(expected);
  });
});

describe("결과 보고 누락 안내의 판정 기억 (0.2.10)", () => {
  function notice(f: ReturnType<typeof fixture>, member: Member, minutesAgo: number) {
    const runId = `run_${member.handle}_${minutesAgo}`;
    const created = iso(NOW - minutesAgo * 60_000);
    f.db.query(`INSERT INTO execution_journal (run_id, member_id, project_id, generation, terminal_identity_json, delivery_ids_json, phase, input_received_at, started_at, ended_at, result, created_at, updated_at)
      VALUES (?, ?, ?, ?, '{}', '[]', 'ended', ?, ?, ?, 'success', ?, ?)`).run(runId, member.id, member.projectId, f.store.memberRevisions(member.id).sessionGeneration, created, created, created, created, created);
    f.store.createMessage({ id: `msg_missing_report_${runId}`, projectId: member.projectId, who: "시스템", kind: "시스템", body: "결과 보고 누락", at: iso(NOW - minutesAgo * 60_000 + 1000) });
    return runId;
  }
  const legacy = (f: ReturnType<typeof fixture>) => (f.db.query(`SELECT e.run_id FROM execution_journal e JOIN messages m ON m.id = 'msg_missing_report_' || e.run_id
    WHERE e.project_id = ? ORDER BY m.at, m.id`).all(f.project.id) as { run_id: string }[]).map(r => r.run_id).filter(id => !f.store.hasExecutionReport(f.store.getExecutionJournal(id)!));

  test("글로 해결된 안내는 다시 판정하지 않고, 열린 결재로 가려진 안내는 결재를 닫으면 다시 보인다. 되돌려진 트랜잭션은 기억하지 않는다", () => {
    const f = fixture();
    const a = notice(f, f.pay, 50), b = notice(f, f.ship, 40), c = notice(f, f.pay, 30);
    expect(f.store.listMissingReportNotices(f.project.id).map(n => n.runId)).toEqual(legacy(f));
    expect(legacy(f)).toEqual([a, b, c]);
    // 되돌려진 트랜잭션 안에서 본 보고는 없던 것이다.
    expect(() => f.store.transaction(() => {
      f.store.createMessage({ projectId: f.project.id, memberId: f.ship.id, who: f.ship.name, kind: "완료", body: "되돌릴 보고" });
      expect(f.store.listMissingReportNotices(f.project.id).map(n => n.runId)).toEqual([a, c]);
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(f.store.listMissingReportNotices(f.project.id).map(n => n.runId)).toEqual([a, b, c]);
    // 직원 ship 의 보고 → b 해결(기억). pay 의 열린 결재 → a·c 가려짐(기억하지 않음).
    f.store.createMessage({ projectId: f.project.id, memberId: f.ship.id, who: f.ship.name, kind: "완료", body: "결과 보고" });
    const decision = f.store.createDecision({ projectId: f.project.id, memberId: f.pay.id, who: f.pay.name, title: "물어볼 것", detail: "", options: [{ k: "a", label: "예" }] as never });
    expect(f.store.listMissingReportNotices(f.project.id).map(n => n.runId)).toEqual(legacy(f));
    expect(legacy(f)).toEqual([]);
    f.db.query("UPDATE decisions SET status = 'closed' WHERE id = ?").run(decision.id);
    expect(f.store.listMissingReportNotices(f.project.id).map(n => n.runId)).toEqual(legacy(f));
    expect(legacy(f)).toEqual([a, c]);
    // 같은 판정을 다시 해도 같다(기억한 b 는 그대로 해결).
    expect(f.store.listMissingReportNotices(f.project.id).map(n => n.runId)).toEqual([a, c]);
    expect(new Store(f.db, new Bus()).listMissingReportNotices(f.project.id).map(n => n.runId)).toEqual([a, c]);
  });
});

describe("수신 확인이 쓰기 결과를 모르는 봉투만 돌아도 조작권을 보는 때는 같다 (0.2.10)", () => {
  function setup() {
    const db = openDb(":memory:");
    cleanup.push(() => db.close());
    const store = new Store(db, new Bus());
    const project = store.createProject({ name: "조작권", cwd: "/private/tmp/iamceo-live-reads-lease" });
    const member = store.createMember({ projectId: project.id, handle: "pay", name: "결제 연동", kind: "worker", backend: "core", paneId: "t-pay", sessionId: "s-pay" });
    let time = NOW;
    const inspected: string[] = [];
    let onInspect = (_query: DeliveryProbe) => {};
    const observation = (query: DeliveryProbe): DeliveryInspection => ({ finding: "unknown", receivedDeliveryIds: [], quiescence: "unresolved",
      evidence: [{ source: "claude_log", verdict: "unknown", location: "none", code: "partial_log", complete: false, checkedAt: new Date(time).toISOString() }],
      snapshot: { identity: query.identity, observedAt: new Date(time).toISOString(), turn: 1, inputEpoch: 1, ownership: "verified", status: "idle", blockedReason: null, leaseActive: false, mutation: "none", composer: "empty", originalWrite: "unresolved", externalInput: false } });
    const runner = { inspectDelivery: async (_m: RunnerMember, query: DeliveryProbe) => { inspected.push(query.dispatchId); onInspect(query); return observation(query); } };
    const service = new DeliveryRecovery({ store, runner: () => runner, now: () => time });
    const identity = () => ({ terminalId: "t-pay", sessionId: "s-pay", sessionGeneration: store.memberRevisions(member.id).sessionGeneration, process: null });
    const baseline = () => ({ serverEpoch: "test-epoch", turn: 0, inputEpoch: 0, logs: [], capturedAt: new Date(time).toISOString() });
    const sent = (text: string) => {
      const d = store.enqueue({ projectId: project.id, memberId: member.id, kind: "instruction", text });
      const dispatch = service.prepareDispatch([d.id], identity(), baseline());
      service.recordResult(dispatch.dispatchId, { ok: true, started: true, receipt: { dispatchId: dispatch.dispatchId, receivedAt: new Date(time).toISOString(), source: "transport" } });
      time += 1000;
      return { d, dispatch };
    };
    const lease = () => store.saveLease({ memberId: member.id, claimId: "claim", leaseId: "lease", identity: identity(), expiresAt: Date.now() + 60_000, lastInputSequence: 0 });
    const checking = (id: string) => {
      db.query("UPDATE deliveries SET status = 'held', hold_reason = 'delivery_unknown' WHERE id = ?").run(id);
      db.query("UPDATE delivery_recovery SET phase = 'checking', reason = 'inflight_unsettled', next_check_at = ? WHERE delivery_id = ?").run(iso(time - 1000), id);
    };
    return { db, store, service, member, sent, lease, checking, inspected, set onInspect(fn: (query: DeliveryProbe) => void) { onInspect = fn; }, get time() { return time; } };
  }

  test("끝난 봉투만 있는 팀장에게 조작권이 있으면 확인하지 않고 돌아간다(대기로 적지 않는다)", async () => {
    const f = setup();
    const { d } = f.sent("지시");
    f.checking(d.id);
    f.lease();
    await f.service.tick();
    expect(f.inspected).toEqual([]);
    expect(f.store.getDeliveryRecovery(d.id)).toMatchObject({ phase: "checking", reason: "inflight_unsettled" });
  });

  test("봉투가 하나도 없는 팀장에게 조작권이 있으면 예전처럼 '직접 조작 중' 대기로 적는다", async () => {
    const f = setup();
    const d = f.store.enqueue({ projectId: f.member.projectId, memberId: f.member.id, kind: "instruction", text: "옛 지시" });
    f.checking(d.id);
    f.lease();
    await f.service.tick();
    expect(f.store.getDeliveryRecovery(d.id)).toMatchObject({ phase: "waiting", reason: "manual_control" });
  });

  test("앞선 봉투를 확인하는 사이 조작권이 생기면, 뒤에 끝난 봉투만 남아도 거기서 돌아간다", async () => {
    const f = setup();
    const older = f.sent("앞 지시"), newer = f.sent("뒤 지시");
    // 앞 봉투는 쓰기 결과를 모르고(이미 확인을 마친 전달), 뒤 봉투는 끝났지만 그 전달은 확인 중이다.
    f.db.query("UPDATE delivery_dispatches SET transport_state = 'unknown' WHERE id = ?").run(older.dispatch.dispatchId);
    f.db.query("UPDATE delivery_recovery SET phase = 'resolved', last_checked_at = ? WHERE delivery_id = ?").run(iso(f.time), older.d.id);
    f.checking(newer.d.id);
    f.onInspect = () => f.lease();
    await f.service.tick();
    expect(f.inspected).toEqual([older.dispatch.dispatchId]);
    expect(f.store.getDeliveryRecovery(newer.d.id)).toMatchObject({ phase: "checking", reason: "inflight_unsettled" });
  });
});
