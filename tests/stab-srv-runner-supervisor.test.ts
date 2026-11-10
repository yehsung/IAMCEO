import { expect, test } from "bun:test";
import { CoreSupervisor, type CoreSupervisorObservation } from "../server/core-supervisor.ts";
import type { RunnerMember, RunnerReattachResult } from "../server/runner/types.ts";
import { CoreError } from "../server/runner/core-client.ts";

const member = (extra: Partial<RunnerMember> = {}): RunnerMember => ({ id: "lead", projectId: "project", sessionGeneration: 1, handle: "lead", name: "Lead", cwd: "/private/tmp", sessionId: null, paneId: "existing", model: null, effort: null, subagentModel: null, permissionMode: "default", kind: "worker", ...extra });

test("재관측이 도는 중에 같은 세대의 watch 가 다시 와도 그 결과를 버리지 않는다", async () => {
  // 상태 점검은 몇 초마다 모든 직원에 watch 를 다시 부른다. 그때 돌고 있던(명부 맨 앞) 직원의 관측이 매번 버려졌다.
  let resolve!: (result: RunnerReattachResult) => void;
  const seen: RunnerMember[] = [], observed: CoreSupervisorObservation[] = [];
  const supervisor = new CoreSupervisor({ now: () => 1000, pollMs: 10, retryMs: 10, presence: async () => "owned", startOwned: async () => {},
    reattachOwned: (watched) => { seen.push(watched); return new Promise(r => { resolve = r; }); }, observed: state => observed.push(state) });
  supervisor.watch(member());
  const tick = supervisor.tick();
  for (let i = 0; i < 50 && !seen.length; i++) await Promise.resolve();
  expect(seen).toHaveLength(1);
  supervisor.watch(member({ sessionId: "native", model: "opus" }));
  resolve({ outcome: "rejoined", started: { sessionId: "native", paneId: "existing", rejoined: true } });
  await tick;
  expect(observed).toMatchObject([{ memberId: "lead", outcome: "rejoined", failures: 0, lastObservedAt: 1000 }]);
  expect(supervisor.observations()[0]).toMatchObject({ outcome: "rejoined", lastObservedAt: 1000 });
  // watch 로 받은 새 정보는 그 자리에 반영된다.
  expect(seen[0]).toMatchObject({ sessionId: "native", model: "opus" });
  await supervisor.shutdown();
});

test("세대가 바뀐 watch 는 지금처럼 늦은 결과를 버린다", async () => {
  let resolve!: (result: RunnerReattachResult) => void;
  const observed: CoreSupervisorObservation[] = [];
  let reads = 0;
  const supervisor = new CoreSupervisor({ now: () => 1000, pollMs: 10, retryMs: 10, presence: async () => "owned", startOwned: async () => {},
    reattachOwned: () => { reads++; return new Promise(r => { resolve = r; }); }, observed: state => observed.push(state) });
  supervisor.watch(member());
  const tick = supervisor.tick();
  for (let i = 0; i < 50 && !reads; i++) await Promise.resolve();
  supervisor.watch(member({ sessionGeneration: 2 }));
  resolve({ outcome: "rejoined", started: { sessionId: "old", paneId: "old" } });
  await tick;
  expect(observed).toEqual([]);
  expect(supervisor.observations()[0]).toMatchObject({ outcome: "unknown", lastObservedAt: null });
  await supervisor.shutdown();
});

// runner-core-8: 세 번 실패하거나 한 번 결과를 모르면 서비스를 다시 시작할 때까지 core 를 다시 띄우지 않았다.
function starter(startOwned: () => Promise<void>) {
  let now = 0; const lines: string[] = [];
  let presence: "owned" | "absent" | "unknown" = "absent";
  const supervisor = new CoreSupervisor({ now: () => now, pollMs: 10, retryMs: 10, slowRetryMs: 60_000, log: line => lines.push(line),
    presence: async () => presence, startOwned, reattachOwned: async () => ({ outcome: "unknown", code: "down" }) });
  return { supervisor, lines, at: (value: number) => { now = value; }, presence: (value: typeof presence) => { presence = value; } };
}

test("after the fast burst the core is still started again, one to five minutes apart", async () => {
  let starts = 0;
  const f = starter(async () => { starts++; throw new CoreError("unavailable", "exited with code 1"); });
  for (let at = 0; at <= 1_000; at += 10) { f.at(at); await f.supervisor.tick(); }
  expect(starts).toBe(3);
  f.at(59_000); await f.supervisor.tick(); expect(starts).toBe(3);
  f.at(61_000); await f.supervisor.tick(); expect(starts).toBe(4);
  f.at(61_000 + 119_000); await f.supervisor.tick(); expect(starts).toBe(4);
  f.at(61_000 + 121_000); await f.supervisor.tick(); expect(starts).toBe(5);
  // 간격은 4분을 거쳐 5분에서 멈춘다.
  let at = 61_000 + 121_000;
  at += 239_000; f.at(at); await f.supervisor.tick(); expect(starts).toBe(5);
  at += 2_000; f.at(at); await f.supervisor.tick(); expect(starts).toBe(6);
  for (let i = 0; i < 3; i++) {
    at += 299_000; f.at(at); await f.supervisor.tick(); expect(starts).toBe(6 + i);
    at += 2_000; f.at(at); await f.supervisor.tick(); expect(starts).toBe(7 + i);
  }
  expect(f.lines.some(line => line.includes("1~5분 간격으로 계속 시도"))).toBe(true);
  // 다시 응답하면 처음부터 센다.
  f.presence("owned"); await f.supervisor.tick();
  f.presence("absent"); at += 10; f.at(at); await f.supervisor.tick();
  expect(starts).toBe(10);
  await f.supervisor.shutdown();
});

test("an unknown start is re-armed only after the socket stayed verifiably empty for a whole slow interval", async () => {
  let starts = 0;
  const f = starter(async () => { starts++; throw new CoreError("timeout", "late daemon", true); });
  await f.supervisor.tick(); expect(starts).toBe(1);
  f.at(30_000); await f.supervisor.tick(); expect(starts).toBe(1);
  // 그 사이 한 번이라도 판단할 수 없었으면(연결 거부·시간 초과) 비어 있던 시간을 처음부터 다시 잰다.
  f.presence("unknown"); f.at(40_000); await f.supervisor.tick();
  f.presence("absent"); f.at(50_000); await f.supervisor.tick();
  f.at(100_000); await f.supervisor.tick(); expect(starts).toBe(1);
  f.at(111_000); await f.supervisor.tick(); expect(starts).toBe(2);
  await f.supervisor.shutdown();
});
