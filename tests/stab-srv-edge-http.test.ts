// 스냅샷의 선택 장식(전달 알림)이 실패해도 /api/sync·/state 는 읽힌다. 전용 조회는 오류를 숨기지 않는다.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { DeliveryRecovery } from "../server/delivery-recovery.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import type { OrchestratorApi } from "../server/orchestrator-api.ts";
import { Store } from "../server/store.ts";
import type { ProjectState, SyncSnapshot } from "../shared/types.ts";

const home = mkdtempSync(join(process.env.TMPDIR ?? "/private/tmp/", "iamceo-stab-http-"));
const code = "stab-http-fixture";
const auth = { Authorization: `Bearer ${code}` };
let store: Store;
let recovery: DeliveryRecovery;
let server: RunningServer;
let base: string;
let projectId: string;
let deliveryId: string;
const get = (path: string) => fetch(base + path, { headers: auth });

beforeAll(async () => {
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: code, hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  store = new Store(openDb(config.dbPath), bus);
  projectId = store.createProject({ name: "스냅샷", cwd: home }).id;
  const member = store.createMember({ projectId, handle: "worker", name: "직원", kind: "worker", sessionId: "fixture-session", paneId: "fixture-terminal" });
  deliveryId = store.enqueue({ projectId, memberId: member.id, kind: "instruction", text: "전달 하나" }).id;
  recovery = new DeliveryRecovery({ store, runner: () => { throw new Error("HTTP read must not observe runner"); } });
  const orch = {
    herdrInfo: async () => ({ installed: false, running: false, version: null, protocol: null, compatible: false, warning: null }),
  } as unknown as OrchestratorApi;
  server = await startServer({ config, store, bus, orch, delivery: recovery });
  while (server.port === 7878) { await server.stop(); server = await startServer({ config, store, bus, orch, delivery: recovery }); }
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => { await recovery?.shutdown(); await server?.stop(); store?.db.close(); rmSync(home, { recursive: true }); });

test("n-models-3: 전달 알림 계산이 실패해도 sync·state 는 200 이고 deliveryNotices 만 빠진다", async () => {
  const healthy = await (await get(`/api/sync?projectId=${projectId}`)).json() as SyncSnapshot;
  expect(healthy.state?.deliveryNotices?.version).toBe(2);

  // 복구 행 하나가 사라진 DB: 전달 알림 집계가 409 를 던진다.
  expect(store.db.query("DELETE FROM delivery_recovery WHERE delivery_id = ?").run(deliveryId).changes).toBe(1);
  // 캐시된 이전 세대 스냅샷이 아니라 새로 만든 것을 받도록 이벤트를 하나 낸다.
  store.createMessage({ projectId, who: "시스템", kind: "시스템", body: "세대 바꾸기" });
  const errors: string[] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => { errors.push(values.join(" ")); };
  try {
    const dedicated = await get(`/api/projects/${projectId}/delivery-notices`);
    expect(dedicated.status).toBe(409);

    for (const lite of ["", "&lite=1"]) {
      const response = await get(`/api/sync?projectId=${projectId}${lite}`);
      expect(response.status).toBe(200);
      const snapshot = await response.json() as SyncSnapshot;
      expect(snapshot.projectStatus).toBe("ok");
      expect(snapshot.state!.project.id).toBe(projectId);
      expect(snapshot.state!.members).toHaveLength(1);
      expect(snapshot.state!.messages.some(message => message.body === "세대 바꾸기")).toBe(true);
      expect("deliveryNotices" in snapshot.state!).toBe(false);
    }
    const stateResponse = await get(`/api/projects/${projectId}/state`);
    expect(stateResponse.status).toBe(200);
    const state = await stateResponse.json() as ProjectState;
    expect(state.members).toHaveLength(1);
    expect("deliveryNotices" in state).toBe(false);
  } finally { console.error = original; }
  // 조용히 삼키지 않는다: 원인이 서버 로그에 남는다.
  expect(errors.some(line => line.includes("전달 알림 계산 실패") && line.includes(projectId))).toBe(true);
});

test("store-7: 디스크 가득·저장소 I/O 오류는 분류한 코드와 안내로 답하고 SQLite 원문을 내보내지 않는다", async () => {
  const original = store.listMessagePage;
  const errors: unknown[][] = [], log = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    store.listMessagePage = () => { throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL", errno: 13 }); };
    const full = await get(`/api/projects/${projectId}/messages/page`);
    expect(full.status).toBe(507);
    const body = await full.json() as { error: string; code?: string };
    expect(body.code).toBe("storage_full");
    expect(body.error).toContain("저장 공간이 부족");
    expect(body.error).not.toContain("database or disk");
    store.listMessagePage = () => { throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" }); };
    const io = await get(`/api/projects/${projectId}/messages/page`);
    expect(io.status).toBe(500);
    expect(await io.json()).toMatchObject({ code: "storage_io" });
    store.listMessagePage = () => { throw new Error("그 밖의 오류"); };
    const other = await get(`/api/projects/${projectId}/messages/page`);
    expect(other.status).toBe(500);
    expect(await other.json()).toEqual({ error: "그 밖의 오류" });
  } finally { store.listMessagePage = original; console.error = log; }
  expect(errors.some(args => args.includes("storage_full"))).toBe(true);
});
