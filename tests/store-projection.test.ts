import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import type { LifecycleJournal } from "../server/service-contracts.ts";
import { Store, type ExecutionJournal } from "../server/store.ts";
import type { Member, MemberExecutionState, MemberLifecycleState } from "../shared/types.ts";

const at = "2026-11-07T00:00:00.000Z";
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture(path = ":memory:") {
  const db = openDb(path);
  cleanups.push(() => db.close());
  const bus = new Bus();
  const store = new Store(db, bus);
  const project = store.createProject({ name: "투영 시험", cwd: "/private/tmp" });
  const member = store.createMember({ projectId: project.id, handle: "worker", name: "직원", kind: "worker", status: "idle", backend: "core", sessionId: "session", paneId: "terminal" });
  function lifecycle(patch: Partial<LifecycleJournal> = {}): LifecycleJournal {
    return { operationId: "operation", memberId: member.id, projectId: project.id, intent: "start", phase: "prepared", identity: { terminalId: member.paneId, sessionId: member.sessionId, sessionGeneration: 0, process: null }, runId: null, deliveryIds: [], baseline: null, reason: null, exitCode: null, createdAt: at, updatedAt: at, ...patch };
  }
  function execution(patch: Partial<ExecutionJournal> = {}): ExecutionJournal {
    return { runId: "run", memberId: member.id, projectId: project.id, identity: lifecycle().identity, turn: null, deliveryIds: [], phase: "starting", inputReceivedAt: null, startedAt: null, lastProgressAt: null, endedAt: null, result: null, reason: null, exitCode: null, interruptionNotifiedAt: null, reportRequestedAt: null, createdAt: at, updatedAt: at, ...patch };
  }
  return { db, bus, store, project, member, lifecycle, execution };
}

describe("Member journal 상태 투영", () => {
  test("journal이 없으면 기존 상태나 오류 문구에서 확정 상태를 만들지 않는다", () => {
    const f = fixture();
    for (const status of ["idle", "working", "asleep", "offline", "error"] as const) {
      expect(f.store.patchMember(f.member.id, { status, lastError: "starting_unknown: timeout" })).toMatchObject({ status, lifecycleState: null, executionState: null });
    }
    expect(f.store.getMember("missing")).toBeNull();
  });

  const lifecycleCases: Array<[LifecycleJournal["intent"], LifecycleJournal["phase"], MemberLifecycleState["phase"]]> = [
    ["start", "prepared", "starting"], ["start", "started", "starting"],
    ["start", "unknown", "starting_unknown"], ["start", "confirmed", "started_confirmed"],
    ["start", "refused", "refused"],
    ...(["sleep", "close", "archive", "fresh_session"] as const).flatMap((intent): Array<[LifecycleJournal["intent"], LifecycleJournal["phase"], MemberLifecycleState["phase"]]> => [
      [intent, "prepared", intent === "close" ? "closing" : "stopping"],
      [intent, "started", intent === "close" ? "closing" : "stopping"],
      [intent, "unknown", "stopping_unknown"], [intent, "confirmed", "stopped_confirmed"], [intent, "refused", "refused"],
    ]),
  ];
  test.each(lifecycleCases)("%s / %s → %s", (intent, phase, projected) => {
    const f = fixture();
    f.store.saveLifecycleJournal(f.lifecycle({ intent, phase, reason: "run_response_lost", exitCode: 17 }));
    expect(f.store.requireMember(f.member.id).lifecycleState).toEqual({ operationId: "operation", sessionGeneration: 0, intent, phase: projected, reason: "run_response_lost", exitCode: 17, updatedAt: at });
    expect(f.store.requireMember(f.member.id).status).toBe("idle");
  });

  test.each(["received", "starting", "running", "ended", "interrupted", "unknown"] as const)("실행 %s와 원래 증거를 그대로 투영한다", phase => {
    const f = fixture();
    const run = f.execution({ phase, turn: 0, deliveryIds: ["d1", "d2"], inputReceivedAt: at, startedAt: at, lastProgressAt: at, endedAt: phase === "ended" || phase === "interrupted" ? at : null, result: phase === "ended" ? "error" : phase === "interrupted" ? "interrupted" : null, reason: "exit_before_resume", exitCode: 0 });
    f.store.saveExecutionJournal(run);
    expect(f.store.requireMember(f.member.id).executionState).toEqual({ runId: run.runId, sessionGeneration: 0, turn: 0, deliveryIds: ["d1", "d2"], phase, inputReceivedAt: at, startedAt: at, lastProgressAt: at, endedAt: run.endedAt, result: run.result, reason: "exit_before_resume", exitCode: 0 });
  });

  test("수신 ACK와 결과 불명은 실행 시작이나 성공으로 승격하지 않는다", () => {
    const f = fixture();
    f.store.saveExecutionJournal(f.execution({ phase: "received", inputReceivedAt: at }));
    expect(f.store.requireMember(f.member.id).executionState).toMatchObject({ phase: "received", startedAt: null, lastProgressAt: null, endedAt: null, result: null, turn: null, exitCode: null });
    f.store.saveExecutionJournal(f.execution({ phase: "unknown", inputReceivedAt: at, reason: "timeout" }));
    expect(f.store.requireMember(f.member.id).executionState).toMatchObject({ phase: "unknown", startedAt: null, endedAt: null, result: null });
  });

  test("현재 프로젝트·직원·세대에 맞는 journal만 읽는다", () => {
    const f = fixture();
    const other = f.store.createProject({ name: "다른 프로젝트", cwd: "/private/tmp" });
    f.store.saveLifecycleJournal(f.lifecycle({ phase: "unknown" }));
    f.store.saveExecutionJournal(f.execution({ phase: "unknown" }));
    f.db.query("UPDATE members SET session_generation = 1 WHERE id = ?").run(f.member.id);
    expect(f.store.requireMember(f.member.id)).toMatchObject({ lifecycleState: null, executionState: null });
    for (const [id, memberId, projectId, sessionGeneration] of [
      ["other-project", f.member.id, other.id, 1],
      ["other-member", "absent-member", f.project.id, 1],
      ["future", f.member.id, f.project.id, 2],
    ] as const) {
      const identity = { ...f.lifecycle().identity, sessionGeneration };
      f.store.saveLifecycleJournal(f.lifecycle({ operationId: id, memberId, projectId, identity }));
      f.store.saveExecutionJournal(f.execution({ runId: id, memberId, projectId, identity }));
    }
    expect(f.store.requireMember(f.member.id)).toMatchObject({ lifecycleState: null, executionState: null });
    const identity = { ...f.lifecycle().identity, sessionGeneration: 1 };
    f.store.saveLifecycleJournal(f.lifecycle({ operationId: "current", identity }));
    f.store.saveExecutionJournal(f.execution({ runId: "current", identity }));
    expect(f.store.requireMember(f.member.id)).toMatchObject({ lifecycleState: { operationId: "current", sessionGeneration: 1 }, executionState: { runId: "current", sessionGeneration: 1 } });
  });

  test("생성 순서로 최신 작업을 고르고 이전 작업의 늦은 갱신을 무시한다", () => {
    const f = fixture();
    f.store.saveLifecycleJournal(f.lifecycle());
    f.store.saveExecutionJournal(f.execution());
    f.store.saveLifecycleJournal(f.lifecycle({ operationId: "new-operation", phase: "unknown" }));
    f.store.saveExecutionJournal(f.execution({ runId: "new-run", phase: "unknown" }));
    const later = "2026-11-07T01:00:00.000Z";
    f.store.saveLifecycleJournal(f.lifecycle({ phase: "confirmed", updatedAt: later }));
    f.store.saveExecutionJournal(f.execution({ phase: "ended", result: "success", endedAt: later, updatedAt: later }));
    // backfill은 나중에 INSERT되어도 더 오래된 작업이다.
    f.store.saveLifecycleJournal(f.lifecycle({ operationId: "backfill", createdAt: "2026-11-06T00:00:00.000Z", updatedAt: later }));
    f.store.saveExecutionJournal(f.execution({ runId: "backfill", createdAt: "2026-11-06T00:00:00.000Z", updatedAt: later }));
    expect(f.store.requireMember(f.member.id)).toMatchObject({ lifecycleState: { operationId: "new-operation", phase: "starting_unknown" }, executionState: { runId: "new-run", phase: "unknown", result: null } });
    expect(f.store.listMembers(f.project.id).filter(m => m.id === f.member.id)).toHaveLength(1);
  });

  test("단건·목록·인증·snapshot·방송의 Member가 같은 상태를 제공하고 내부 신원은 노출하지 않는다", () => {
    const f = fixture();
    const conductor = f.store.createMember({ projectId: f.project.id, handle: "lead", name: "총괄", kind: "conductor" });
    for (const member of [f.member, conductor]) {
      f.store.saveLifecycleJournal(f.lifecycle({ operationId: member.id, memberId: member.id, phase: "unknown" }));
      f.store.saveExecutionJournal(f.execution({ runId: member.id, memberId: member.id, phase: "unknown" }));
    }
    const expected = f.store.requireMember(f.member.id);
    const reads = [
      f.store.getMember(f.member.id), f.store.getMemberByToken(f.store.getMemberToken(f.member.id)),
      f.store.getMemberByHandle(f.project.id, f.member.handle), f.store.findMember(f.project.id, f.member.name),
      f.store.listMembers(f.project.id).find(m => m.id === f.member.id),
      f.store.listAllMembers().find(m => m.id === f.member.id),
      f.store.projectState(f.project.id).members.find(m => m.id === f.member.id),
    ];
    for (const member of reads) expect(member).toEqual(expected);
    expect(f.store.getConductor(f.project.id)?.lifecycleState?.operationId).toBe(conductor.id);
    const broadcast: Member[] = [];
    f.bus.subscribe(event => { if (event.type === "member") broadcast.push(event.member); });
    f.store.patchMember(f.member.id, { now: "마지막 보고" });
    expect(broadcast.at(-1)?.executionState).toEqual(expected.executionState);
    expect(broadcast.at(-1)?.lifecycleState).toEqual(expected.lifecycleState);
    f.store.patchProject(f.project.id, { archived: true });
    expect(f.store.archiveState(f.project.id).members.find(m => m.id === f.member.id)?.executionState).toEqual(expected.executionState);
    const serialized = JSON.stringify(expected);
    expect(serialized).not.toContain(f.store.getMemberToken(f.member.id));
    expect(serialized).not.toContain("terminalIdentity");
    expect(serialized).not.toContain("interruptionNotifiedAt");
    expect(serialized).not.toContain("baseline");
  });

  test.each(["unknown", "confirmed"] as const)("재오픈 후 %s 결과를 보존하고 조회는 DB나 방송을 바꾸지 않는다", phase => {
    const dir = mkdtempSync("/private/tmp/iamceo-projection-");
    cleanups.push(() => { for (const file of readdirSync(dir)) unlinkSync(join(dir, file)); rmdirSync(dir); });
    const f = fixture(join(dir, "test.db"));
    f.store.saveLifecycleJournal(f.lifecycle({ intent: "sleep", phase, reason: "recovery_evidence", exitCode: 23 }));
    f.store.saveExecutionJournal(f.execution({ phase: phase === "confirmed" ? "interrupted" : "unknown", result: phase === "confirmed" ? "interrupted" : null, reason: "recovery_evidence", endedAt: phase === "confirmed" ? at : null, exitCode: 23 }));
    const expected = f.store.requireMember(f.member.id);
    f.db.close();
    const reopened = openDb(join(dir, "test.db"));
    cleanups.push(() => reopened.close());
    const bus = new Bus();
    const store = new Store(reopened, bus);
    let events = 0;
    bus.subscribe(() => events++);
    const before = reopened.query("SELECT total_changes() AS n").get();
    expect(store.requireMember(f.member.id)).toEqual(expected);
    expect(store.requireMember(f.member.id).lifecycleState?.phase).toBe(phase === "confirmed" ? "stopped_confirmed" : "stopping_unknown");
    expect(store.requireMember(f.member.id).executionState?.result).toBe(phase === "confirmed" ? "interrupted" : null);
    store.listAllMembers();
    expect(reopened.query("SELECT total_changes() AS n").get()).toEqual(before);
    expect(events).toBe(0);
    // optional 계약은 기존 Member 객체를 계속 허용한다.
    const { lifecycleState: _lifecycle, executionState: _execution, ...legacy } = expected;
    const compatible: Member = legacy;
    expect(compatible.lifecycleState).toBeUndefined();
    const execution: MemberExecutionState | null | undefined = expected.executionState;
    expect(execution?.exitCode).toBe(23);
  });
});
