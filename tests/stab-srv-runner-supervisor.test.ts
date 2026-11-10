import { expect, test } from "bun:test";
import { CoreSupervisor, type CoreSupervisorObservation } from "../server/core-supervisor.ts";
import type { RunnerMember, RunnerReattachResult } from "../server/runner/types.ts";

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
