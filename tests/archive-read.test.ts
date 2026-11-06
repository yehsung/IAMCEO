import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import type { OrchestratorApi } from "../server/orchestrator-api.ts";
import { Store } from "../server/store.ts";
import type { ArchiveProjectState, Message, MessagePage, Project } from "../shared/types.ts";

const CODE = "archive-fixture-code";
let home: string;
let store: Store;
let bus: Bus;
let server: RunningServer;
let base: string;
let projectId: string;
let workerId: string;
let leadId: string;
let first: Message;
const calls: string[] = [];
const events: string[] = [];
const headers = { Authorization: `Bearer ${CODE}` };
const get = (path: string) => fetch(base + path, { headers });

beforeAll(async () => {
  home = mkdtempSync("/private/tmp/iamceo-archive-read-");
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: CODE, hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  bus = new Bus();
  store = new Store(openDb(config.dbPath), bus);
  const orch = new Proxy({}, { get: (_target, key) => () => { calls.push(String(key)); throw new Error(`Archive GET invoked ${String(key)}`); } }) as OrchestratorApi;
  server = await startServer({ config, store, bus, orch });
  while (server.port === 7878) { await server.stop(); server = await startServer({ config, store, bus, orch }); }
  base = `http://127.0.0.1:${server.port}`;
  projectId = store.createProject({ name: "보관 기록", cwd: home, runnerEnabled: false }).id;
  workerId = store.createMember({ projectId, handle: "manual", name: "직접 직원", kind: "worker", origin: "manual" }).id;
  leadId = store.createMember({ projectId, handle: "lead", name: "총괄", kind: "conductor" }).id;
  first = store.createMessage({ id: "archive_first", projectId, memberId: workerId, kind: "완료", body: "오래된 기록", at: "2020" });
  for (let i = 0; i < 205; i++) store.createMessage({ id: `archive_${String(i).padStart(3, "0")}`, projectId, kind: "알림", at: "2021" });
  store.createDecision({ projectId, memberId: workerId, who: "직접 직원", title: "결재 기록" });
  store.createTodo({ projectId, title: "업무 기록" });
  store.createFile({ projectId, title: "자료 기록", kind: "document", body: "자료 원문" });
  store.patchProject(projectId, { archived: true });
  bus.subscribe((event) => events.push(event.type));
});

afterAll(async () => { await server.stop(); store.db.close(); rmSync(home, { recursive: true }); });

describe("archive read HTTP", () => {
  test("목록·상태·page·단건·around는 원본을 읽고 runner/pump/이벤트가 0회다", async () => {
    const seq = bus.seq;
    const total = store.db.query("SELECT total_changes() AS n").get();
    const list = await get("/api/projects/archived");
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect((await list.json() as Project[]).map((p) => p.id)).toEqual([projectId]);
    const response = await get(`/api/projects/${projectId}/archive/state`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const state = await response.json() as ArchiveProjectState;
    expect(state.project).toMatchObject({ id: projectId, archived: true, connection: { reason: "archived" } });
    expect(state.members).toHaveLength(2);
    expect(state.decisions[0]!.title).toBe("결재 기록");
    expect(state.todos[0]!.title).toBe("업무 기록");
    expect(state.files[0]!.title).toBe("자료 기록");
    expect(state.messages).toHaveLength(200);
    expect(JSON.stringify(state)).not.toContain(store.getMemberToken(workerId));
    const path = `/api/projects/${projectId}/archive/messages/page`;
    const page = await (await get(path)).json() as MessagePage;
    expect(page.items).toHaveLength(200);
    expect(page.hasOlder).toBe(true);
    const older = await (await get(`${path}?cursor=${page.nextCursor}&limit=100`)).json() as MessagePage;
    expect(older.items).toHaveLength(6);
    expect(older.items[0]).toEqual(first);
    expect(older.nextCursor).toBeNull();
    expect((await (await get(`${path}?scope=member&memberId=${workerId}`)).json() as MessagePage).items).toEqual([first]);
    expect((await (await get(`${path}?scope=member&memberId=${leadId}`)).json() as MessagePage).scope).toEqual({ kind: "project" });
    expect(await (await get(`/api/messages/${first.id}`)).json()).toEqual(first);
    expect((await (await get(`/api/projects/${projectId}/messages?around=${first.id}&limit=1`)).json())).toEqual([first]);
    expect(calls).toEqual([]);
    expect(events).toEqual([]);
    expect(bus.seq).toBe(seq);
    expect(store.db.query("SELECT total_changes() AS n").get()).toEqual(total);
  });

  test("없는/활성 archive는 404·일반 state/page는 보관 404·구형 messages는 유지", async () => {
    for (const id of ["missing", "hq"]) for (const suffix of ["archive/state", "archive/messages/page"]) {
      const response = await get(`/api/projects/${id}/${suffix}`);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    for (const suffix of ["state", "messages/page"]) expect((await get(`/api/projects/${projectId}/${suffix}`)).status).toBe(404);
    expect((await get(`/api/projects/${projectId}/messages`)).status).toBe(200);
    expect(calls).toEqual([]);
  });

  test("archive page도 strict query·code·인증 경계를 적용한다", async () => {
    const path = `/api/projects/${projectId}/archive/messages/page`;
    for (const query of ["limit=0", "limit=501", "limit=1e2", "before=x", "scope=member", "memberId=x", "limit=1&limit=2", "scope=project&memberId=x"]) {
      const response = await get(`${path}?${query}`);
      expect([query, response.status]).toEqual([query, 400]);
      expect(await response.json()).toMatchObject({ code: "INVALID_MESSAGE_PAGE_QUERY" });
    }
    const badCursor = await get(`${path}?cursor=`);
    expect(badCursor.status).toBe(400);
    expect(await badCursor.json()).toMatchObject({ code: "INVALID_MESSAGE_CURSOR" });
    expect((await get(`/api/projects/${projectId}/archive/state?extra=1`)).status).toBe(400);
    for (const suffix of ["archive/state", "archive/messages/page"]) {
      for (const init of [{}, { headers: { Authorization: `Bearer ${store.getMemberToken(workerId)}` } }]) {
        const response = await fetch(`${base}/api/projects/${projectId}/${suffix}?t=${CODE}`, init);
        expect(response.status).toBe(401);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
    }
    expect(calls).toEqual([]);
  });

  test("보관 뒤 늦은 manual 기록도 조회하며 GET은 새 실행을 만들지 않는다", async () => {
    const late = store.createMessage({ projectId, memberId: workerId, kind: "진행", body: "늦은 보고" });
    events.length = 0;
    const seq = bus.seq;
    const response = await get(`/api/projects/${projectId}/archive/state`);
    expect((await response.json() as ArchiveProjectState).messages.at(-1)).toEqual(late);
    const page = await (await get(`/api/projects/${projectId}/archive/messages/page`)).json() as MessagePage;
    expect(page.items.at(-1)).toEqual(late);
    expect(calls).toEqual([]);
    expect(events).toEqual([]);
    expect(bus.seq).toBe(seq);
  });
});
