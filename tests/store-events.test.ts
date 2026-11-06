import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { PushEventRecorder } from "../server/push/events.ts";
import { PushStore } from "../server/push/store.ts";
import type { DomainRecorder } from "../server/service-contracts.ts";
import { Store } from "../server/store.ts";
import { DEFAULT_PUSH_BUNDLE_ID } from "../shared/push.ts";
import type { Member, WsEvent } from "../shared/types.ts";
import { createIsolatedRuntime, type IsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const connections = new Set<Database>();
const runtimes: IsolatedRuntime[] = [];
afterEach(async () => {
  for (const db of connections) db.close();
  connections.clear();
  for (const runtime of runtimes.splice(0)) await runtime.stop();
});

function fixture(persistent = false, record = true) {
  const runtime = persistent ? createIsolatedRuntime() : null;
  if (runtime) runtimes.push(runtime);
  const path = runtime ? join(runtime.paths.iamceoHome, "store-events.db") : ":memory:";
  let db = openDb(path);
  connections.add(db);
  let now = Date.parse("2026-11-07T00:00:00.000Z");
  const options = { now: () => now, providers: () => [{ environment: "sandbox" as const, bundleId: DEFAULT_PUSH_BUNDLE_ID, state: "ready" as const, lastError: null }] };
  let push = new PushStore(db, options);
  const bus = new Bus();
  const broadcasts: WsEvent[] = [];
  const transactionStates: boolean[] = [];
  bus.subscribe((event) => { broadcasts.push(event); transactionStates.push(db.inTransaction); });
  let store = new Store(db, bus, record ? new PushEventRecorder(push) : undefined);
  const project = store.createProject({ name: "시험", cwd: runtime?.paths.work ?? "/fixture", runnerEnabled: false });
  const member = store.createMember({ projectId: project.id, handle: "worker", name: "직원", kind: "worker" });
  function enabled(token = "ab") {
    const device = push.registerDevice(randomUUID(), { expectedRevision: null, platform: "ios", bundleId: DEFAULT_PUSH_BUNDLE_ID,
      environment: "sandbox", deviceToken: token, authorization: "authorized" });
    return push.patchDevice(device.id, { expectedRevision: device.revision, enabled: true });
  }
  function restart() {
    if (persistent) { connections.delete(db); db.close(); db = openDb(path); connections.add(db); }
    push = new PushStore(db, options);
    store = new Store(db, bus, new PushEventRecorder(push));
  }
  return { get db() { return db; }, get store() { return store; }, get push() { return push; }, bus, project, member,
    broadcasts, transactionStates, enabled, restart, advance: (ms: number) => { now += ms; },
    ask: (options = false) => store.createDecision({ projectId: project.id, memberId: member.id, who: member.name,
      title: "private ask", options: options ? [{ k: "a", label: "선택" }] : [] }),
    report: (id: string, memberId = member.id, projectId = project.id) => store.createMessage({ id, projectId, memberId, kind: "완료", body: "private report" }),
    groups: () => db.query<{ id: string }, []>("SELECT id FROM push_report_groups ORDER BY rowid").all().map((r) => push.getReportGroup(r.id)!),
  };
}

describe("Store domain recorder integration", () => {
  test("recorder remains optional; only new domain writes invoke it within the transaction", () => {
    const f = fixture(false, false);
    f.ask(); f.report("old"); f.store.patchMember(f.member.id, { status: "error" });
    expect(f.push.listEvents()).toEqual([]);
    expect(f.groups()).toEqual([]);
    const calls: string[] = [];
    const recorder: DomainRecorder = {
      decision: (before, after) => { expect(f.db.inTransaction).toBe(true); calls.push(before ? after.status : "ask"); },
      member: () => { expect(f.db.inTransaction).toBe(true); calls.push("member"); },
      message: () => { expect(f.db.inTransaction).toBe(true); calls.push("message"); },
    };
    const store = new Store(f.db, f.bus, recorder);
    const ask = store.createDecision({ projectId: f.project.id, who: "직원", title: "질문" });
    store.answerDecision(ask.id, { note: "답" });
    store.answerDecision(ask.id, { note: "답" });
    store.patchMember(f.member.id, { now: "진행" });
    store.createMessage({ id: "new", projectId: f.project.id, kind: "완료", memberId: f.member.id });
    store.createMessage({ id: "new", projectId: f.project.id, kind: "완료", memberId: f.member.id });
    expect(calls).toEqual(["ask", "answered", "member", "message"]);
    expect(f.transactionStates.every((active) => !active)).toBe(true);
  });

  test("option/free-answer asks emit once; question text, rebroadcasts and open reapplication do not create events", () => {
    const f = fixture(); f.enabled();
    const option = f.ask(true); const free = f.ask();
    f.store.createMessage({ projectId: f.project.id, memberId: f.member.id, kind: "질문", decisionId: free.id });
    f.bus.emit({ type: "decision", decision: option });
    expect(f.push.listEvents().map((event) => event.kind)).toEqual(["decision", "decision"]);
    f.store.answerDecision(option.id, { choice: "a" });
    expect(f.push.listDeliveries()[0].state).toBe("cancelled");
    const reopened = f.store.reopenDecision(option.id);
    f.store.reopenDecision(option.id);
    expect(f.push.listEvents()).toHaveLength(3);
    expect(f.push.listEvents()[2].sourceKey).toBe(`ask:${option.id}:${reopened.updatedAt}`);
    expect(JSON.stringify(f.push.listEvents())).not.toContain("private ask");
  });

  test("all decision closing paths invalidate pending notifications; closed-to-open records a new incident", () => {
    const f = fixture(); f.enabled();
    const closed = f.ask();
    f.store.closeDecision(closed.id, { kind: "obsolete", reason: "해결", by: "직원" });
    expect(f.push.listDeliveries()[0].state).toBe("cancelled");
    f.store.reopenDecision(closed.id);
    expect(f.push.listEvents()).toHaveLength(2);
    for (const status of ["answered", "delivered", "closed"] as const) {
      const ask = f.ask();
      const event = f.push.listEvents().at(-1)!;
      f.store.setDecisionStatus(ask.id, status);
      expect(f.push.listDeliveries(event.id)[0].state).toBe("cancelled");
    }
  });

  test("only confirmed permission contributes to approval events and blocked totals", () => {
    const f = fixture(); f.enabled();
    for (const reason of ["status_unknown", "setup", "selection", null] as const) {
      f.store.patchMember(f.member.id, { status: "blocked", blockedReason: reason });
      expect(f.store.projectSummaries().find((p) => p.id === f.project.id)!.blockedCount).toBe(0);
    }
    expect(f.push.listEvents()).toEqual([]);
    f.store.patchMember(f.member.id, { blockedReason: "permission" });
    expect(f.store.projectSummaries().find((p) => p.id === f.project.id)!.blockedCount).toBe(1);
    f.store.patchMember(f.member.id, { status: "blocked", contextPct: 10, now: "승인 대기" });
    expect(f.push.listEvents().map((event) => event.kind)).toEqual(["approval_wait"]);
    f.store.patchMember(f.member.id, { status: "idle" });
    expect(f.store.requireMember(f.member.id).blockedReason).toBeNull();
    expect(f.push.listDeliveries()[0].state).toBe("cancelled");
    expect(f.store.patchMember(f.member.id, { status: "blocked" }).blockedReason).toBe("status_unknown");
    f.store.patchMember(f.member.id, { blockedReason: "permission" });
    expect(f.push.getEpisode(f.member.id)?.blockedGeneration).toBe(2);
    const lastSummary = f.broadcasts.filter((event) => event.type === "projects").at(-1)!;
    expect(lastSummary.type === "projects" && lastSummary.projects.find((p) => p.id === f.project.id)?.blockedCount).toBe(1);
  });

  test("error-to-idle retains an incident while lastError remains, including after DB reopen", () => {
    const f = fixture(true); f.enabled();
    f.store.patchMember(f.member.id, { status: "error", lastError: " quota   exceeded " });
    f.store.patchMember(f.member.id, { status: "idle" });
    f.store.patchMember(f.member.id, { lastError: "quota exceeded", contextPct: 20 });
    f.restart();
    f.store.patchMember(f.member.id, { status: "idle" });
    expect(f.push.listEvents()).toHaveLength(1);
    expect(f.push.listDeliveries()[0].state).toBe("queued");
    f.store.patchMember(f.member.id, { lastError: "different error" });
    expect(f.push.listEvents()).toHaveLength(2);
    expect(f.push.listDeliveries()[0].state).toBe("cancelled");
    f.store.patchMember(f.member.id, { lastError: null });
    expect(f.push.getEpisode(f.member.id)?.errorActive).toBe(false);
    f.store.patchMember(f.member.id, { status: "error" });
    f.store.patchMember(f.member.id, { status: "error", contextPct: 30 });
    expect(f.push.listEvents()).toHaveLength(3);
    f.store.patchMember(f.member.id, { status: "offline" });
    expect(f.push.getEpisode(f.member.id)?.errorActive).toBe(false);
    expect(f.push.listEvents()).toHaveLength(3);
  });

  test("initial baselines and restart never backfill existing errors, approvals, asks or reports", () => {
    const f = fixture(true, false);
    f.store.patchMember(f.member.id, { status: "blocked", blockedReason: "permission", lastError: "old error" });
    f.ask(); f.report("old-report");
    f.restart(); f.enabled();
    f.store.patchMember(f.member.id, { status: "blocked", lastError: "old error" });
    expect(f.push.listEvents()).toEqual([]);
    expect(f.groups()).toEqual([]);
    expect(f.push.getEpisode(f.member.id)).toMatchObject({ blockedGeneration: 0, errorGeneration: 0, blockedActive: true, errorActive: true });
    f.store.patchMember(f.member.id, { status: "idle", lastError: null });
    f.store.patchMember(f.member.id, { status: "blocked", blockedReason: "permission", lastError: "old error" });
    f.restart();
    f.store.patchMember(f.member.id, { now: "같은 상태" });
    expect(f.push.listEvents().map((event) => event.kind)).toEqual(["approval_wait", "error"]);
  });

  test("completion groups are fixed to 120 seconds, idempotent and durable with original recipients", () => {
    const f = fixture(true); const first = f.enabled("aa");
    for (const kind of ["알림", "막힘", "답변", "질문", "시스템"] as const) f.store.createMessage({ projectId: f.project.id, memberId: f.member.id, kind });
    f.store.createMessage({ projectId: f.project.id, memberId: f.member.id, kind: "완료", mine: true });
    f.store.createMessage({ projectId: f.project.id, kind: "완료" });
    expect(f.groups()).toEqual([]);
    f.report("first");
    const group = f.groups()[0];
    f.advance(119_999); f.enabled("bb"); f.report("second"); f.report("second"); f.restart();
    expect(f.groups()[0]).toMatchObject({ id: group.id, closesAt: group.closesAt, reportIds: ["first", "second"], lastMessageId: "second" });
    f.advance(1); f.report("third");
    f.push.closeDueGroups(f.push.timestamp()); f.restart(); f.push.closeDueGroups(f.push.timestamp());
    expect(f.push.listEvents()).toHaveLength(1);
    expect(f.push.listDeliveries().map((delivery) => delivery.deviceId)).toEqual([first.id]);
    expect(f.push.eventTarget(f.push.listEvents()[0].id)).toMatchObject({ target: { messageId: "second", groupId: group.id } });
    expect(f.groups()).toHaveLength(2);
  });

  test("different projects and staff have separate report groups; late archived reports still persist", () => {
    const f = fixture(); f.enabled();
    const lead = f.store.createMember({ projectId: f.project.id, handle: "lead", name: "총괄", kind: "conductor" });
    const other = f.store.createProject({ name: "다른 프로젝트", cwd: "/fixture", runnerEnabled: false });
    const worker = f.store.createMember({ projectId: other.id, handle: "other", name: "다른 직원", kind: "worker" });
    f.report("worker"); f.report("lead", lead.id); f.report("other", worker.id, other.id);
    expect(f.groups()).toHaveLength(3);
    f.store.patchProject(f.project.id, { archived: true });
    expect(f.report("late").id).toBe("late");
    expect(f.groups().flatMap((group) => group.reportIds)).not.toContain("late");
    f.push.closeDueGroups(new Date(Date.parse(f.push.timestamp()) + 120_000).toISOString());
    expect(f.groups().filter((group) => group.projectId === f.project.id).every((group) => group.state === "cancelled")).toBe(true);
  });

  test("outer rollback drops source, push rows, episodes, groups, delivery intents, broadcasts and wake", () => {
    const f = fixture(); f.enabled();
    f.broadcasts.length = 0;
    let wakes = 0;
    expect(() => f.store.transaction(() => {
      f.store.withDeliveryIntents(() => f.ask(), (decision) => [{ projectId: f.project.id, memberId: f.member.id,
        kind: "answer", text: "답", refType: "decision", refId: decision.id }], () => { wakes++; });
      f.store.patchMember(f.member.id, { status: "error", lastError: "rollback" });
      f.report("rollback");
      expect(f.broadcasts).toEqual([]); expect(wakes).toBe(0);
      expect(f.push.listEvents()).toHaveLength(2);
      throw new Error("outer rollback");
    })).toThrow("outer rollback");
    expect(f.store.listDecisions(f.project.id)).toEqual([]);
    expect(f.store.getMessage("rollback")).toBeNull();
    expect(f.store.listPending(f.member.id)).toEqual([]);
    expect(f.store.requireMember(f.member.id).status).toBe("idle");
    expect(f.push.getEpisode(f.member.id)).toBeNull();
    expect(f.push.listEvents()).toEqual([]); expect(f.push.listDeliveries()).toEqual([]);
    expect(f.groups()).toEqual([]); expect(f.broadcasts).toEqual([]); expect(wakes).toBe(0);
  });

  test("a caught inner rollback discards only that savepoint and commit effects run after outer commit", () => {
    const f = fixture(); f.enabled(); f.broadcasts.length = 0;
    let wakes = 0;
    f.store.db.transaction(() => {
      f.report("kept");
      expect(() => f.store.transaction(() => {
        f.ask(); f.report("discarded"); f.store.patchMember(f.member.id, { status: "error" });
        f.store.afterCommit(() => { wakes += 100; });
        throw new Error("savepoint");
      })).toThrow("savepoint");
      f.store.withDeliveryIntents(() => f.ask(), (decision) => [{ projectId: f.project.id, memberId: f.member.id,
        kind: "answer", text: "답", refType: "decision", refId: decision.id }], () => { expect(f.db.inTransaction).toBe(false); wakes++; });
      expect(f.broadcasts).toEqual([]); expect(wakes).toBe(0);
    })();
    expect(f.groups()[0].reportIds).toEqual(["kept"]);
    expect(f.store.getMessage("discarded")).toBeNull();
    expect(f.push.listEvents().map((event) => event.kind)).toEqual(["decision"]);
    expect(wakes).toBe(1); expect(f.broadcasts.length).toBeGreaterThan(0);
    expect(f.transactionStates.every((active) => !active)).toBe(true);
  });

  test("push outbox insertion failure rolls back ask/member sources and all commit effects", () => {
    const f = fixture(); f.enabled(); f.broadcasts.length = 0;
    f.db.exec("CREATE TEMP TRIGGER fail_outbox BEFORE INSERT ON push_deliveries BEGIN SELECT RAISE(ABORT,'outbox full'); END");
    expect(() => f.ask()).toThrow("outbox full");
    expect(() => f.store.patchMember(f.member.id, { status: "blocked", blockedReason: "permission" })).toThrow("outbox full");
    expect(() => f.store.patchMember(f.member.id, { lastError: "failure" })).toThrow("outbox full");
    expect(f.store.listDecisions(f.project.id)).toEqual([]);
    expect(f.store.requireMember(f.member.id)).toMatchObject({ status: "idle", lastError: null, blockedReason: null });
    expect(f.push.getEpisode(f.member.id)).toBeNull();
    expect(f.push.listEvents()).toEqual([]); expect(f.broadcasts).toEqual([]);
  });

  test("report group storage failure rolls back its source; deadline closure also rolls back with the new report", () => {
    const f = fixture(); f.enabled(); f.report("first"); f.advance(120_000); f.broadcasts.length = 0;
    f.db.exec("CREATE TEMP TRIGGER fail_report BEFORE INSERT ON push_report_group_reports BEGIN SELECT RAISE(ABORT,'report full'); END");
    expect(() => f.report("failed")).toThrow("report full");
    expect(f.store.getMessage("failed")).toBeNull();
    expect(f.groups()).toHaveLength(1);
    expect(f.groups()[0]).toMatchObject({ state: "open", reportIds: ["first"], lastMessageId: "first" });
    expect(f.push.listEvents()).toEqual([]); expect(f.push.listDeliveries()).toEqual([]); expect(f.broadcasts).toEqual([]);
  });

  test("decision cancellation storage failure preserves both open source and pending outbox", () => {
    const f = fixture(); f.enabled(); const ask = f.ask(); f.broadcasts.length = 0;
    f.db.exec("CREATE TEMP TRIGGER fail_cancel BEFORE UPDATE OF state ON push_deliveries WHEN NEW.state='cancelled' BEGIN SELECT RAISE(ABORT,'cancel full'); END");
    expect(() => f.store.answerDecision(ask.id, { note: "答" })).toThrow("cancel full");
    expect(() => f.store.closeDecision(ask.id, { kind: "obsolete", reason: "완료", by: "직원" })).toThrow("cancel full");
    expect(f.store.requireDecision(ask.id)).toEqual(ask);
    expect(f.push.listDeliveries()[0].state).toBe("queued"); expect(f.broadcasts).toEqual([]);
  });

  test("observation, subagent and report metadata round-trip without inventing activity or erasing next", () => {
    const f = fixture();
    const observation: NonNullable<Member["statusObservation"]> = { source: "core", observedAt: "2026-11-07T01:00:00Z",
      freshness: "stale", ownership: "conflict", consecutiveFailures: 2, error: { code: "unavailable", note: "확인 불가" } };
    const subagents: NonNullable<Member["subagentState"]> = { quality: "unknown", count: null, observedAt: null, sessionGeneration: 1 };
    f.store.patchMember(f.member.id, { now: "마지막 보고", next: "다음 일", nowAt: "2026-11-07T00:00:00Z", statusObservation: observation, subagentState: subagents });
    const member = f.store.patchMember(f.member.id, { contextPct: 25 });
    expect(member).toMatchObject({ nowAt: "2026-11-07T00:00:00Z", next: "다음 일", statusObservation: observation, subagentState: subagents, manualActivityAt: null });
    expect(f.store.listMembers(f.project.id)[0]).toEqual(member);
    expect(f.store.getMemberByToken(f.store.getMemberToken(member.id))).toEqual(member);
    const reported = f.store.patchMember(member.id, { now: "새 보고" });
    expect(reported.nowAt).toBe(reported.updatedAt);
    expect(reported.next).toBe("다음 일");
    const cleared = f.store.patchMember(member.id, { statusObservation: null, subagentState: null });
    expect(cleared.statusObservation).toBeNull(); expect(cleared.subagentState).toBeNull();
    const manual = f.store.createMember({ projectId: f.project.id, handle: "manual", name: "수동 직원", kind: "worker", origin: "manual" });
    expect(f.store.patchMember(manual.id, { name: "새 수동 직원" }).manualActivityAt).toBeNull();
    f.store.touchMember(manual.id);
    const active = f.store.requireMember(manual.id);
    expect(active.manualActivityAt).toBe(active.updatedAt);
    f.store.patchMember(manual.id, { role: "새 역할" });
    expect(f.store.requireMember(manual.id).manualActivityAt).toBe(active.manualActivityAt);
    f.store.touchMember(member.id);
    expect(f.store.requireMember(member.id).manualActivityAt).toBeNull();
  });

  test("a recorder attached to a different database fails the source write instead of silently losing its event", () => {
    const f = fixture(); const other = fixture();
    const store = new Store(f.db, f.bus, new PushEventRecorder(other.push));
    expect(() => store.createDecision({ projectId: f.project.id, who: "직원", title: "질문" })).toThrow("domain transaction");
    expect(f.store.listDecisions(f.project.id)).toEqual([]);
    expect(f.push.listEvents()).toEqual([]); expect(other.push.listEvents()).toEqual([]);
  });
});
