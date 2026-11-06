import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { PushEventRecorder, pushErrorDigest } from "../server/push/events.ts";
import { PushStore } from "../server/push/store.ts";
import { Store } from "../server/store.ts";
import { DEFAULT_PUSH_BUNDLE_ID } from "../shared/push.ts";
import type { Member, MessageKind, WsEvent } from "../shared/types.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";
import type { IsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const connections: Database[] = [];
const runtimes: IsolatedRuntime[] = [];
const start = Date.parse("2026-11-07T00:00:00.123Z");
afterEach(async () => {
  for (const db of connections.splice(0)) db.close();
  for (const runtime of runtimes.splice(0)) await runtime.stop();
});
function fixture(persistent = false) {
  const runtime = persistent ? createIsolatedRuntime() : null;
  if (runtime) runtimes.push(runtime);
  const path = runtime ? join(runtime.paths.iamceoHome, "events.db") : ":memory:";
  let db = openDb(path); connections.push(db);
  const bus = new Bus();
  const broadcasts: WsEvent[] = [];
  bus.subscribe((event) => broadcasts.push(event));
  let store = new Store(db, bus);
  const project = store.createProject({ name: "fixture", cwd: runtime?.paths.work ?? "/fixture", runnerEnabled: false });
  const member = store.createMember({ projectId: project.id, handle: "worker", name: "직원", kind: "worker" });
  let now = start;
  const options = { now: () => now, providers: () => [{ environment: "sandbox" as const, bundleId: DEFAULT_PUSH_BUNDLE_ID, state: "ready" as const, lastError: null }] };
  let push = new PushStore(db, options);
  let recorder = new PushEventRecorder(push);
  function enabled(token = "ab") {
    const value = push.registerDevice(randomUUID(), { expectedRevision: null, platform: "ios", bundleId: DEFAULT_PUSH_BUNDLE_ID,
      environment: "sandbox", deviceToken: token, authorization: "authorized" });
    return push.patchDevice(value.id, { expectedRevision: value.revision, enabled: true });
  }
  function transition(patch: Partial<Pick<Member, "status" | "lastError" | "blockedReason">>, id = member.id) {
    return store.transaction(() => {
      const before = { ...store.requireMember(id), blockedReason: db.query<{ blocked_reason: Member["blockedReason"] }, [string]>("SELECT blocked_reason FROM members WHERE id=?").get(id)!.blocked_reason };
      const after = { ...before, ...patch };
      db.query("UPDATE members SET status=?,last_error=?,blocked_reason=? WHERE id=?").run(after.status, after.lastError, after.blockedReason ?? null, id);
      recorder.member(before, after);
      return after;
    });
  }
  function report(id: string = randomUUID(), memberId = member.id, projectId = project.id, kind: MessageKind = "완료", mine = false) {
    return store.transaction(() => {
      const message = store.createMessage({ id, projectId, memberId, kind, mine, at: new Date(now).toISOString(), body: "secret canary" });
      recorder.message(message);
      return message;
    });
  }
  function ask(options = false) {
    return store.transaction(() => {
      const value = store.createDecision({ projectId: project.id, memberId: member.id, who: "직원", title: "secret canary", options: options ? [{ k: "a", label: "a" }] : [] });
      recorder.decision(null, value);
      return value;
    });
  }
  return { get db() { return db; }, get store() { return store; }, get push() { return push; }, get recorder() { return recorder; },
    project, member, enabled, transition, report, ask, broadcasts, advance: (ms: number) => { now += ms; },
    restart: () => {
      if (persistent) { connections.splice(connections.indexOf(db), 1); db.close(); db = openDb(path); connections.push(db); store = new Store(db, bus); }
      push = new PushStore(db, options); recorder = new PushEventRecorder(push);
    } };
}

describe("domain recorder", () => {
  test("recorder refuses writes outside the domain transaction", () => {
    const f = fixture();
    const decision = f.store.createDecision({ projectId: f.project.id, who: "worker", title: "fixture" });
    const message = f.store.createMessage({ projectId: f.project.id, memberId: f.member.id, kind: "완료" });
    expect(() => f.recorder.decision(null, decision)).toThrow("domain transaction");
    expect(() => f.recorder.message(message)).toThrow("domain transaction");
    expect(() => f.recorder.member(f.member, { ...f.member, status: "error" })).toThrow("domain transaction");
    expect(f.push.listEvents()).toEqual([]);
  });
  test("option and free-answer asks each create one decision; associated question and rebroadcast do not duplicate", () => {
    const f = fixture(); f.enabled();
    const a = f.ask(true); const b = f.ask(false);
    f.report("question", f.member.id, f.project.id, "질문");
    f.store.transaction(() => {
      f.recorder.decision(null, a); f.recorder.decision(a, { ...a, updatedAt: "later" });
      f.recorder.decision(null, b);
    });
    expect(f.push.listEvents().map((e) => e.kind)).toEqual(["decision", "decision"]);
    expect(f.push.listDeliveries()).toHaveLength(2);
    expect(JSON.stringify(f.push.listEvents())).not.toContain("secret canary");
  });
  test("answer cancels pending; reopen creates one new version and no backfill on baseline", () => {
    const f = fixture(); f.enabled();
    const first = f.ask();
    f.store.transaction(() => {
      f.db.query("UPDATE decisions SET status='answered',updated_at='answer' WHERE id=?").run(first.id);
      f.recorder.decision(first, { ...first, status: "answered", updatedAt: "answer" });
    });
    expect(f.push.listDeliveries()[0].state).toBe("cancelled");
    const reopened = { ...first, updatedAt: "reopen" };
    f.store.transaction(() => {
      f.db.query("UPDATE decisions SET status='open',updated_at='reopen' WHERE id=?").run(first.id);
      f.recorder.decision({ ...first, status: "answered" }, reopened);
      f.recorder.decision(reopened, reopened);
    });
    expect(f.push.listEvents()).toHaveLength(2);
    expect(f.push.listDeliveries().map((d) => d.state)).toEqual(["cancelled", "queued"]);
    f.restart(); expect(f.push.listEvents()).toHaveLength(2);
    expect(f.push.eventTarget(f.push.listEvents()[0].id).target.screen).toBe("inbox");
  });
  test("only explicit member completion posts group; role is irrelevant", () => {
    const f = fixture(); f.enabled();
    for (const kind of ["질문", "답변", "알림", "막힘"] as const) f.report(randomUUID(), f.member.id, f.project.id, kind);
    f.report("mine", f.member.id, f.project.id, "완료", true);
    const system = f.store.createMessage({ projectId: f.project.id, kind: "완료" }); f.recorder.message(system);
    f.transition({ status: "working" }); f.transition({ status: "idle" });
    expect(f.push.listEvents()).toEqual([]);
    const root = f.store.createMember({ projectId: "hq", handle: "root", name: "root", kind: "root" });
    f.report("worker-report"); f.report("root-report", root.id, "hq");
    f.advance(120_000); f.push.closeDueGroups(f.push.timestamp());
    expect(f.push.listEvents().map((e) => e.kind)).toEqual(["report_complete", "report_complete"]);
  });
  test("only verified approval is an episode; ticks, context updates and restart do not repeat", () => {
    const f = fixture(true); f.enabled();
    for (const blockedReason of [undefined, "setup", "status_unknown", "selection"] as const) f.transition({ status: "blocked", blockedReason });
    expect(f.push.listEvents()).toEqual([]);
    const blocked = f.transition({ status: "blocked", blockedReason: "permission" });
    f.store.transaction(() => f.recorder.member(blocked, { ...blocked, contextPct: 20 }));
    f.restart(); f.transition({ status: "blocked", blockedReason: "permission" });
    expect(f.push.listEvents().map((e) => e.sourceKey)).toEqual([`blocked:${f.member.id}:1`]);
    f.transition({ status: "idle" });
    expect(f.push.listDeliveries()[0].state).toBe("cancelled");
    f.transition({ status: "blocked", blockedReason: "permission" });
    expect(f.push.getEpisode(f.member.id)?.blockedGeneration).toBe(2);
    expect(f.push.listEvents()).toHaveLength(2);
  });
  test("lastError-only failure, normalized digest, changed errors and error→idle latch", () => {
    const f = fixture(); f.enabled();
    f.transition({ lastError: "  quota\n limit " });
    f.transition({ status: "error", lastError: "quota limit" });
    f.transition({ status: "idle" }); f.restart(); f.transition({ status: "idle" });
    expect(f.push.listEvents()).toHaveLength(1);
    expect(f.push.getEpisode(f.member.id)).toMatchObject({ errorActive: true, errorGeneration: 1, errorDigest: pushErrorDigest("quota limit") });
    f.transition({ lastError: "auth failed" });
    expect(f.push.listEvents()).toHaveLength(2);
    expect(f.push.listDeliveries().map((d) => d.state)).toEqual(["cancelled", "queued"]);
    f.transition({ lastError: null }); f.transition({ status: "error" });
    f.transition({ status: "error" });
    expect(f.push.listEvents()).toHaveLength(3);
    f.transition({ status: "offline", lastError: null });
    expect(f.push.listDeliveries().every((d) => d.state === "cancelled")).toBe(true);
    f.transition({ status: "offline" }); expect(f.push.listEvents()).toHaveLength(3);
  });
  test("per-kind preferences filter fanout and cancel only matching pending deliveries", () => {
    const f = fixture(); const a = f.enabled("aa"); const b = f.enabled("bb");
    const selective = f.push.patchDevice(a.id, { expectedRevision: a.revision, preferences: { error: false } });
    f.ask(); f.transition({ status: "error" });
    const askEvent = f.push.listEvents().find((event) => event.kind === "decision")!;
    const errorEvent = f.push.listEvents().find((event) => event.kind === "error")!;
    expect(f.push.listDeliveries(askEvent.id)).toHaveLength(2);
    expect(f.push.listDeliveries(errorEvent.id).map((delivery) => delivery.deviceId)).toEqual([b.id]);
    f.push.patchDevice(a.id, { expectedRevision: selective.revision, preferences: { decision: false, error: true } });
    expect(f.push.listDeliveries(askEvent.id).find((delivery) => delivery.deviceId === a.id)?.state).toBe("cancelled");
    expect(f.push.listDeliveries(errorEvent.id)).toHaveLength(1);
  });
  test("migration baseline emits no old blocked/errors/asks/reports, but recovery followed by recurrence does", () => {
    const f = fixture();
    f.db.exec("DELETE FROM push_episodes");
    f.db.query("UPDATE members SET status='blocked',blocked_reason='permission',last_error='old secret' WHERE id=?").run(f.member.id);
    f.store.createDecision({ projectId: f.project.id, who: "worker", title: "old ask" });
    f.store.createMessage({ projectId: f.project.id, memberId: f.member.id, kind: "완료" });
    f.restart(); f.enabled();
    f.transition({ status: "blocked", blockedReason: "permission", lastError: "old secret" });
    expect(f.push.listEvents()).toEqual([]);
    f.transition({ status: "idle", lastError: null });
    f.transition({ status: "blocked", blockedReason: "permission", lastError: "old secret" });
    expect(f.push.listEvents().map((e) => e.kind)).toEqual(["approval_wait", "error"]);
  });
  test("outbox failure rolls back domain and episode changes; outer rollback rolls back nested recording", () => {
    const f = fixture(); f.enabled();
    f.broadcasts.length = 0;
    f.db.exec("CREATE TEMP TRIGGER fail_push BEFORE INSERT ON push_deliveries BEGIN SELECT RAISE(ABORT,'injected storage failure'); END");
    expect(() => f.ask()).toThrow("injected storage failure");
    expect(f.store.listDecisions(f.project.id)).toHaveLength(0);
    expect(f.push.listEvents()).toEqual([]);
    expect(() => f.transition({ status: "error", lastError: "error" })).toThrow();
    expect(f.store.requireMember(f.member.id).status).toBe("idle");
    expect(f.push.getEpisode(f.member.id)?.errorGeneration).toBe(0);
    f.db.exec("DROP TRIGGER fail_push");
    expect(() => f.store.transaction(() => { f.ask(); f.report("rolled-back"); throw new Error("rollback"); })).toThrow("rollback");
    expect(f.push.listEvents()).toEqual([]);
    expect(f.store.getMessage("rolled-back")).toBeNull();
    expect(f.db.query("SELECT * FROM push_report_groups").all()).toEqual([]);
    expect(f.broadcasts).toEqual([]);
  });
  test("archive, deleted project/member/report and answered/resolved source cancel pending work", () => {
    const f = fixture(); f.enabled(); f.ask(); f.transition({ status: "error" }); f.report();
    f.db.query("UPDATE projects SET archived=1 WHERE id=?").run(f.project.id);
    f.push.cancelInvalidPending();
    expect(f.push.listDeliveries().every((d) => d.state === "cancelled")).toBe(true);
    expect(f.db.query("SELECT state FROM push_report_groups").get()).toEqual({ state: "cancelled" });
    expect(() => f.push.eventTarget(f.push.listEvents()[0].id)).toThrow();
    f.db.query("UPDATE projects SET archived=0 WHERE id=?").run(f.project.id);
    f.report("delete-report"); f.db.query("DELETE FROM messages WHERE id='delete-report'").run();
    f.push.cancelInvalidPending();
    expect(f.db.query("SELECT state FROM push_report_groups WHERE last_message_id='delete-report'").get()).toEqual({ state: "cancelled" });
    f.db.query("DELETE FROM members WHERE id=?").run(f.member.id); f.push.cancelInvalidPending();
    f.db.query("DELETE FROM projects WHERE id=?").run(f.project.id); f.push.cancelInvalidPending();
    expect(f.push.listDeliveries().every((d) => d.state === "cancelled")).toBe(true);
  });
});

describe("fixed report window", () => {
  test("120-second deadline, ordered reports and last anchor survive DB reopen; exact boundary starts a new group", () => {
    const f = fixture(true); f.enabled();
    f.report("first");
    const groupId = f.db.query<{ id: string }, []>("SELECT id FROM push_report_groups").get()!.id;
    const initial = f.push.getReportGroup(groupId)!;
    expect(Date.parse(initial.closesAt) - Date.parse(initial.openedAt)).toBe(120_000);
    f.advance(119_999); f.report("second"); f.report("second"); f.restart();
    expect(f.push.getReportGroup(groupId)).toMatchObject({ closesAt: initial.closesAt, reportIds: ["first", "second"], lastMessageId: "second" });
    f.push.closeDueGroups(f.push.timestamp()); expect(f.push.listEvents()).toEqual([]);
    f.advance(1); f.report("third");
    f.push.closeDueGroups(f.push.timestamp()); f.restart(); f.push.closeDueGroups(f.push.timestamp());
    expect(f.push.listEvents()).toHaveLength(1); expect(f.push.listDeliveries()).toHaveLength(1);
    const saved = f.push.listEvents()[0];
    expect(f.push.eventTarget(saved.id)).toMatchObject({ target: { screen: "chat", groupId, messageId: "second" }, reportGroup: { reportIds: ["first", "second"] } });
    expect(f.db.query("SELECT COUNT(*) n FROM push_report_groups").get()).toEqual({ n: 2 });
    f.advance(120_000); f.push.closeDueGroups(f.push.timestamp()); expect(f.push.listEvents()).toHaveLength(2);
  });
  test("first eligible recipients are fixed; opt-out/re-enable and later installs never backfill", () => {
    const f = fixture(); const a = f.enabled("aa"); const b = f.enabled("bb");
    f.report("one");
    const id = f.db.query<{ id: string }, []>("SELECT id FROM push_report_groups").get()!.id;
    f.advance(10_000);
    const disabled = f.push.patchDevice(a.id, { expectedRevision: a.revision, preferences: { report_complete: false } });
    f.push.patchDevice(a.id, { expectedRevision: disabled.revision, preferences: { report_complete: true } });
    f.enabled("cc"); f.report("two"); f.advance(110_000); f.push.closeDueGroups(f.push.timestamp());
    expect(f.push.getReportGroup(id)?.recipients).toHaveLength(2);
    expect(f.push.getReportGroup(id)?.recipients[0].cancelledAt).not.toBeNull();
    expect(f.push.listDeliveries().map((d) => d.deviceId)).toEqual([b.id]);
  });
  test("renewal retains group recipient, revocation cancels it permanently", () => {
    const f = fixture(); const current = f.enabled(); f.report("one");
    const renewed = f.push.registerDevice(current.id, { expectedRevision: current.revision, platform: "ios", environment: "sandbox",
      bundleId: DEFAULT_PUSH_BUNDLE_ID, deviceToken: "ef", authorization: "authorized" });
    f.advance(120_000); f.push.closeDueGroups(f.push.timestamp());
    expect(f.push.listDeliveries()[0].registrationGeneration).toBe(2);
    f.report("two"); f.push.revokeDevice(current.id, renewed.revision);
    const active = f.push.registerDevice(current.id, { expectedRevision: renewed.revision + 1, platform: "ios", environment: "sandbox",
      bundleId: DEFAULT_PUSH_BUNDLE_ID, deviceToken: "ef", authorization: "authorized" });
    f.push.patchDevice(active.id, { expectedRevision: active.revision, enabled: true });
    f.advance(120_000); f.push.closeDueGroups(f.push.timestamp());
    expect(f.push.listEvents()).toHaveLength(1);
    expect(f.db.query("SELECT state FROM push_report_groups WHERE last_message_id='two'").get()).toEqual({ state: "cancelled" });
  });
  test("different project/member pairs are separate, and empty recipient snapshots stay empty", () => {
    const f = fixture(); f.report("no-recipients"); f.enabled();
    const worker = f.store.createMember({ projectId: f.project.id, handle: "other", name: "other", kind: "worker" });
    f.report("other-member", worker.id);
    const other = f.store.createProject({ name: "other", cwd: "/fixture", runnerEnabled: false });
    const otherWorker = f.store.createMember({ projectId: other.id, handle: "worker", name: "other", kind: "worker" });
    f.report("other-project", otherWorker.id, other.id);
    f.advance(120_000); f.push.closeDueGroups(f.push.timestamp());
    expect(f.push.listEvents()).toHaveLength(3); expect(f.push.listDeliveries()).toHaveLength(2);
  });
  test("domain and group writes roll back together; overdue restart respects notification TTL", () => {
    const f = fixture(true); f.enabled(); f.report("one");
    f.db.exec("CREATE TEMP TRIGGER fail_group BEFORE INSERT ON push_events BEGIN SELECT RAISE(ABORT,'group failure'); END");
    f.advance(120_000); expect(() => f.push.closeDueGroups(f.push.timestamp())).toThrow("group failure");
    expect(f.db.query("SELECT state,event_id FROM push_report_groups").get()).toEqual({ state: "open", event_id: null });
    f.db.exec("DROP TRIGGER fail_group");
    f.advance(3_600_000); f.restart(); f.push.closeDueGroups(f.push.timestamp());
    expect(f.push.listEvents()).toHaveLength(1); expect(f.push.listDeliveries()).toEqual([]);
  });
});
