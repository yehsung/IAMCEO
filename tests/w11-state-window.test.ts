// 0.2.10 묶음(payload): 상태 묶음의 lite 가 본문을 읽지 않는 것, 창 묶음(window=1)과 끝난 항목 쪽 받기,
// 보관 상태 lite, 실시간 사건을 한 번만 직렬화하는 것. 출시 앱(0.2.2~0.2.9)이 받는 기본 응답은 예전과 같아야 한다.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb, REVISION_INDEXES } from "../server/db.ts";
import { liteFile, startServer, windowWorkEvent, withCursor } from "../server/http.ts";
import type { OrchestratorApi } from "../server/orchestrator-api.ts";
import { STATE_WINDOW_DONE, Store } from "../server/store.ts";
import type { FileDoc, ProjectState, Todo, WorkItem, WsEvent } from "../shared/types.ts";

const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

function freshStore() {
  const db = openDb(":memory:"); closers.push(() => db.close());
  const store = new Store(db, new Bus());
  const project = store.createProject({ name: "창 묶음", cwd: "/private/tmp/iamceo-w11-window" });
  return { db, store, project };
}

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const DAY = 86_400_000;

/** 예전 Store.listFiles(판 갈이 열을 목록 조회에서 같이 읽던 것)와 같은 결과: 같은 순서로 getFile(바뀌지 않은 단건 조회)을 부른다. */
function legacyListFiles(store: Store, projectId: string): FileDoc[] {
  return (store.db.query("SELECT id FROM files WHERE project_id = ? ORDER BY sort_order DESC, rowid DESC").all(projectId) as { id: string }[])
    .map(r => store.getFile(r.id)!);
}
/** 예전 listFilesWithVersions 를 그대로 옮긴 것. */
function legacyListFilesWithVersions(store: Store, projectId: string): FileDoc[] {
  const files = legacyListFiles(store, projectId);
  const byId = new Map(files.map((file) => [file.id, file]));
  return files.map((file) => {
    if (file.replacedBy && byId.has(file.replacedBy)) return file;
    let versions = 1;
    const seen = new Set([file.id]);
    for (let previous = file.replaces; previous && byId.has(previous) && !seen.has(previous); previous = byId.get(previous)!.replaces) {
      seen.add(previous);
      versions++;
    }
    return versions > 1 ? { ...file, versions } : file;
  });
}

/** 자료 묶음: 판 갈이(큰 html 뒤에 붙은 열), kind 가 없는 예전 자료(본문 있음·없음·첨부), 다른 프로젝트의 자료. */
function seedFiles(store: Store, projectId: string) {
  const big = "<html>" + "x".repeat(200_000) + "</html>";
  const v1 = store.createFile({ projectId, title: "덱 v1", body: "첫 판 본문", kind: "artifact", html: big });
  const v2 = store.createFile({ projectId, title: "덱 v2", body: "둘째 판 본문", kind: "artifact", html: big, replaces: v1.id });
  const v3 = store.createFile({ projectId, title: "덱 v3", body: "셋째 판 본문", kind: "artifact", html: big, replaces: v2.id });
  const plain = store.createFile({ projectId, title: "보고서", body: "본문 ".repeat(3000), summary: "요약" });
  const legacyBody = store.createFile({ projectId, title: "예전 문서", body: "예전 본문" });
  const legacyEmpty = store.createFile({ projectId, title: "예전 빈 자료", body: "" });
  const legacyImage = store.createFile({ projectId, title: "예전 그림 문서", body: "그림 설명",
    attachments: [{ id: "a_img", name: "x.png", mime: "image/png", size: 3, url: "/files/a_img/x.png", path: "/tmp/x.png", isImage: true }] });
  // 예전 자료는 kind 가 없다(0.2.x 이전 행).
  store.db.query("UPDATE files SET kind = NULL WHERE id IN (?, ?, ?)").run(legacyBody.id, legacyEmpty.id, legacyImage.id);
  const other = store.createProject({ name: "다른 곳", cwd: "/private/tmp/iamceo-w11-other" });
  store.createFile({ projectId: other.id, title: "남의 자료", body: "남의 본문" });
  return { v1, v2, v3, plain, legacyBody, legacyEmpty, legacyImage, other };
}

describe("lite: 자료 본문을 DB 에서 읽지 않는다", () => {
  test("목록은 예전 조회와 같고(판 갈이 포함), lite 는 본문만 빈 글자다(kind 가 없는 예전 자료의 종류도 같다)", () => {
    const { store, project } = freshStore();
    const seeded = seedFiles(store, project.id);
    const legacy = legacyListFiles(store, project.id);
    expect(store.listFiles(project.id)).toEqual(legacy);
    expect(store.listFiles(project.id, { lite: true })).toEqual(legacy.map(file => ({ ...file, body: "" })));
    expect(store.listFilesWithVersions(project.id)).toEqual(legacyListFilesWithVersions(store, project.id));
    expect(store.listFilesWithVersions(project.id, { lite: true })).toEqual(legacyListFilesWithVersions(store, project.id).map(file => ({ ...file, body: "" })));
    const kinds = Object.fromEntries(store.listFiles(project.id, { lite: true }).map(file => [file.id, file.kind]));
    expect([kinds[seeded.legacyBody.id], kinds[seeded.legacyEmpty.id], kinds[seeded.legacyImage.id]]).toEqual(["document", "file", "document"]);
    expect(store.listFiles(project.id).find(file => file.id === seeded.v2.id)).toMatchObject({ replaces: seeded.v1.id, replacedBy: seeded.v3.id });
  });

  test("projectState·archiveState 의 lite 는 예전 응답에서 본문 칸만 뺀 것과 글자까지 같다", () => {
    const { store, project } = freshStore();
    seedFiles(store, project.id);
    store.createTodo({ projectId: project.id, title: "할 일" });
    const full = store.projectState(project.id);
    const lite = store.projectState(project.id, { lite: true });
    expect(JSON.stringify({ ...lite, files: lite.files.map(liteFile) })).toBe(JSON.stringify({ ...full, files: full.files.map(liteFile) }));
    expect(full.files.some(file => file.body.length > 0)).toBe(true);
    expect(full).not.toHaveProperty("window");
    store.db.query("UPDATE projects SET archived = 1 WHERE id = ?").run(project.id);
    const archivedFull = store.archiveState(project.id);
    const archivedLite = store.archiveState(project.id, { lite: true });
    expect(JSON.stringify({ ...archivedLite, files: archivedLite.files.map(liteFile) })).toBe(JSON.stringify({ ...archivedFull, files: archivedFull.files.map(liteFile) }));
  });

  test("판 갈이 열은 부분 색인만 읽는다(처음 여는 DB 에도 색인이 생긴다)", () => {
    const { db } = freshStore();
    const names = (db.query("SELECT name FROM sqlite_schema WHERE type='index'").all() as { name: string }[]).map(r => r.name);
    for (const sql of REVISION_INDEXES) expect(names).toContain(/INDEX IF NOT EXISTS (\S+)/.exec(sql)![1]!);
    const source = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "..", "server", "store.ts"), "utf8") as string;
    const sql = "SELECT id, replaces, replaced_by FROM files WHERE project_id = ? AND (replaces IS NOT NULL OR replaced_by IS NOT NULL)";
    expect(source).toContain(sql);
    const plan = (db.query(`EXPLAIN QUERY PLAN ${sql}`).all("p") as { detail: string }[]).map(r => r.detail).join(" | ");
    expect(plan).toContain("COVERING INDEX files_revisions");
  });
});

/** 끝난 할 일·업무를 시각을 정해 넣는다(같은 시각 여러 개로 정렬의 동점도 본다). */
function seedTodos(store: Store, projectId: string, done: number, open: number, recent = 0) {
  const ids: string[] = [];
  for (let i = 0; i < done; i++) {
    const todo = store.createTodo({ projectId, title: `끝난 할 일 ${i}` });
    // 셋씩 같은 끝낸 시각(동점은 id 로 가른다). 오래된 것부터.
    const at = i < recent ? iso(60_000 + i) : iso(3 * DAY + Math.floor(i / 3) * 60_000);
    store.db.query("UPDATE todos SET done = 1, outcome = 'done', done_at = ?, created_at = ? WHERE id = ?").run(at, iso(10 * DAY - i * 1000), todo.id);
    ids.push(todo.id);
  }
  for (let i = 0; i < open; i++) store.createTodo({ projectId, title: `열린 할 일 ${i}` });
  return ids;
}
function seedWork(store: Store, projectId: string, done: number, open: number, recent = 0) {
  for (let i = 0; i < done; i++) {
    const item = store.upsertWork({ projectId, sec: "done", title: `끝난 일 ${i}` });
    const at = i < recent ? iso(60_000 + i) : iso(3 * DAY + Math.floor(i / 3) * 60_000);
    store.db.query("UPDATE work SET done_at = ? WHERE id = ?").run(i % 7 === 0 ? null : at, item.id);
    if (i % 7 === 0) store.db.query("UPDATE work SET updated_at = ? WHERE id = ?").run(at, item.id);
  }
  for (let i = 0; i < open; i++) store.upsertWork({ projectId, sec: (["doing", "next", "hold"] as const)[i % 3]!, title: `열린 일 ${i}` });
}
const todoKey = (t: Todo) => t.doneAt ?? t.createdAt;
const workKey = (w: WorkItem) => w.doneAt ?? w.updatedAt ?? w.createdAt;
const byDoneDesc = <T extends { id: string }>(key: (x: T) => string) => (a: T, b: T) => key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;

describe("창 묶음(window=1)", () => {
  test("할 일: 안 끝난 것 전부 + 최근 끝낸 50개, 순서는 예전과 같고, 쪽 받기로 나머지를 빠짐·겹침 없이 받는다", () => {
    const { store, project } = freshStore();
    seedTodos(store, project.id, 130, 4);
    const all = store.listTodos(project.id);
    const state = store.projectState(project.id, { window: true });
    const expectedDone = all.filter(t => t.done).sort(byDoneDesc(todoKey));
    const keep = new Set([...all.filter(t => !t.done).map(t => t.id), ...expectedDone.slice(0, STATE_WINDOW_DONE).map(t => t.id)]);
    // 같은 행을 예전 순서(만든 순) 그대로 싣는다.
    expect(state.todos).toEqual(all.filter(t => keep.has(t.id)));
    expect(state.window).toMatchObject({ doneTodos: 130 });
    // '필요 없음'으로 정리한 할 일은 창·쪽에는 실리지만(앱이 가린다) 완료 수에서는 뺀다.
    store.db.query("UPDATE todos SET outcome = 'dropped' WHERE id = ?").run(expectedDone[0]!.id);
    expect(store.projectState(project.id, { window: true }).window!.doneTodos).toBe(129);
    store.db.query("UPDATE todos SET outcome = 'done' WHERE id = ?").run(expectedDone[0]!.id);
    const paged: Todo[] = [];
    for (let cursor = state.window!.todosCursor; cursor;) {
      const page = store.listDoneTodosPage(project.id, { cursor, limit: 37 });
      paged.push(...page.items);
      cursor = page.nextCursor;
    }
    expect([...expectedDone.slice(0, STATE_WINDOW_DONE), ...paged].map(t => t.id)).toEqual(expectedDone.map(t => t.id));
    // 처음부터 받으면 창과 같은 앞부분이다.
    expect(store.listDoneTodosPage(project.id).items.map(t => t.id)).toEqual(expectedDone.slice(0, STATE_WINDOW_DONE).map(t => t.id));
  });

  test("24시간 안에 끝낸 것이 50개보다 많으면 그것 전부를 싣는다. 끝난 것이 적으면 쪽 위치가 없다", () => {
    const { store, project } = freshStore();
    seedTodos(store, project.id, 80, 0, 70);
    const state = store.projectState(project.id, { window: true });
    expect(state.todos.filter(t => t.done)).toHaveLength(70);
    expect(state.window!.todosCursor).not.toBeNull();
    const small = freshStore();
    seedTodos(small.store, small.project.id, 10, 2);
    const smallState = small.store.projectState(small.project.id, { window: true });
    expect(smallState.todos).toEqual(small.store.listTodos(small.project.id));
    expect(smallState.window).toEqual({ doneTodos: 10, doneWork: 0, olderFileVersions: 0, todosCursor: null, workCursor: null });
  });

  test("업무: 끝나지 않은 칸 전부 + 완료 칸의 창(끝낸 시각이 없으면 고친 시각), 순서는 예전과 같다", () => {
    const { store, project } = freshStore();
    seedWork(store, project.id, 120, 6);
    const all = store.listWork(project.id);
    const state = store.projectState(project.id, { window: true });
    const expectedDone = all.filter(w => w.sec === "done").sort(byDoneDesc(workKey));
    const keep = new Set([...all.filter(w => w.sec !== "done").map(w => w.id), ...expectedDone.slice(0, STATE_WINDOW_DONE).map(w => w.id)]);
    expect(state.work).toEqual(all.filter(w => keep.has(w.id)));
    expect(state.window!.doneWork).toBe(120);
    const paged: WorkItem[] = [];
    for (let cursor = state.window!.workCursor; cursor;) {
      const page = store.listDoneWorkPage(project.id, { cursor });
      paged.push(...page.items);
      cursor = page.nextCursor;
    }
    expect([...expectedDone.slice(0, STATE_WINDOW_DONE), ...paged].map(w => w.id)).toEqual(expectedDone.map(w => w.id));
    // 실시간 창 묶음 소켓의 work 사건도 같은 규칙이다.
    const event = windowWorkEvent({ type: "work", projectId: project.id, work: all });
    expect(event.work).toEqual(state.work);
    expect(event.doneWork).toBe(120);
  });

  test("자료: 새 판이 목록에 있는 옛 판만 빼고 수를 센다. 나머지 칸은 예전 묶음과 같다", () => {
    const { store, project } = freshStore();
    const seeded = seedFiles(store, project.id);
    const legacy = store.projectState(project.id, { lite: true });
    const windowed = store.projectState(project.id, { lite: true, window: true });
    expect(windowed.files.map(f => f.id)).toEqual(legacy.files.filter(f => !(f.replacedBy && legacy.files.some(g => g.id === f.replacedBy))).map(f => f.id));
    expect(windowed.files.find(f => f.id === seeded.v3.id)?.versions).toBe(3);
    expect(windowed.window!.olderFileVersions).toBe(2);
    const { window: _w, files: _f, todos: _t, work: _k, ...rest } = windowed;
    const { files: _lf, todos: _lt, work: _lk, ...legacyRest } = legacy;
    expect(rest).toEqual(legacyRest);
  });

  test("쪽 받기: 잘못된 위치·개수는 400, 보관한 프로젝트는 404", () => {
    const { store, project } = freshStore();
    seedTodos(store, project.id, 3, 0);
    for (const cursor of ["", "!!", Buffer.from("[1,2]").toString("base64url"), Buffer.from("{}").toString("base64url"), "x".repeat(2000)]) {
      expect(() => store.listDoneTodosPage(project.id, { cursor })).toThrow(expect.objectContaining({ status: 400, code: "invalid_query" }));
    }
    for (const limit of [0, 201, 1.5]) expect(() => store.listDoneWorkPage(project.id, { limit })).toThrow(expect.objectContaining({ status: 400, code: "invalid_limit" }));
    store.db.query("UPDATE projects SET archived = 1 WHERE id = ?").run(project.id);
    expect(() => store.listDoneTodosPage(project.id)).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe("실시간 사건 직렬화", () => {
  test("순번을 이어 붙인 글자는 예전 JSON.stringify({...event, ...cursor}) 와 같다", () => {
    const cursor = Object.freeze({ epoch: "e-1", seq: 42 });
    const events: WsEvent[] = [
      { type: "work", projectId: "p", work: [{ id: "w", projectId: "p", sec: "done", title: "따옴표 \" 와 줄\n바꿈", detail: "", who: "", order: 1, doneAt: null, createdAt: "c", updatedAt: "u" }] },
      { type: "projects", projects: [] },
      { type: "member_removed", projectId: "p", memberId: "m" },
      { type: "settings", settings: { notifyMac: true } as never },
    ];
    for (const event of events) expect(withCursor(JSON.stringify(event), event, cursor)).toBe(JSON.stringify({ ...event, ...cursor }));
    // epoch·seq 칸이 있는 사건은 덮어써야 하므로 예전처럼 다시 직렬화한다.
    const odd = { type: "hello", seq: 1 } as const;
    expect(withCursor(JSON.stringify(odd), odd, cursor)).toBe(JSON.stringify({ ...odd, ...cursor }));
  });
});

// ---- HTTP·WS ----
const CODE = "w11-window-code";
const auth = { Authorization: `Bearer ${CODE}` };

async function server() {
  const home = mkdtempSync("/private/tmp/iamceo-w11-window-");
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: CODE, hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  const orch = new Proxy({ cliCommand: () => "fixture-cli", engineStatus: () => null }, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      return () => { throw new Error(`Unexpected orchestrator call: ${String(key)}`); };
    },
  }) as unknown as OrchestratorApi;
  let running = await startServer({ config, store, bus, orch });
  while (running.port === 7878) { await running.stop(); running = await startServer({ config, store, bus, orch }); }
  const base = `http://127.0.0.1:${running.port}`;
  closers.push(async () => { await Bun.sleep(0); await running.stop(); store.db.close(); rmSync(home, { recursive: true }); });
  const get = (path: string) => fetch(base + path, { headers: auth });
  return { store, bus, base, get, port: running.port };
}

describe("HTTP", () => {
  test("기본(출시 앱) 응답은 그대로이고 window=1 에만 창 묶음을 싣는다", async () => {
    const { store, get } = await server();
    const project = store.createProject({ name: "앱", cwd: "/private/tmp/iamceo-w11-app" });
    seedFiles(store, project.id);
    seedTodos(store, project.id, 60, 2);
    seedWork(store, project.id, 55, 3);
    const legacy = await (await get(`/api/sync?projectId=${project.id}&lite=1`)).json();
    expect(legacy.state).not.toHaveProperty("window");
    expect(legacy.state.todos).toHaveLength(62);
    expect(legacy.state.files.every((f: object) => !("body" in f))).toBe(true);
    // lite 의 자료는 전체 상태에서 본문만 뺀 것과 같다.
    const full: ProjectState = await (await get(`/api/projects/${project.id}/state`)).json();
    expect(legacy.state.files).toEqual(full.files.map(liteFile));
    expect(full.files.some(f => f.body)).toBe(true);
    const windowed = await (await get(`/api/sync?projectId=${project.id}&lite=1&window=1`)).json();
    expect(windowed.state.window).toMatchObject({ doneTodos: 60, doneWork: 55, olderFileVersions: 2 });
    expect(windowed.state.todos).toHaveLength(52);
    expect(windowed.revisions.todos).toEqual(legacy.revisions.todos); // 쓰기에 쓰는 판 번호는 창 밖 할 일까지 그대로 싣는다
    const state = await (await get(`/api/projects/${project.id}/state?lite=1&window=1`)).json();
    expect(state.window).toEqual(windowed.state.window);
    expect((await get(`/api/sync?projectId=${project.id}&window=2`)).status).toBe(400);
    const page = await (await get(`/api/projects/${project.id}/todos/done?cursor=${windowed.state.window.todosCursor}&limit=5`)).json();
    expect(page.items).toHaveLength(5);
    expect(typeof page.nextCursor).toBe("string");
    expect((await get(`/api/projects/${project.id}/work/done?cursor=bad!`)).status).toBe(400);
    expect((await get(`/api/projects/${project.id}/work/done?limit=500`)).status).toBe(400);
    expect((await get(`/api/projects/${project.id}/work/done?other=1`)).status).toBe(400);
    const capabilities = await (await get("/api/capabilities")).json();
    expect(capabilities.capabilities).toMatchObject({ windowedState: true, archiveLite: true, revisions: true });
  });

  test("보관 상태 lite 는 본문을 빼고, 값이 잘못되면 400 이다", async () => {
    const { store, get } = await server();
    const project = store.createProject({ name: "보관", cwd: "/private/tmp/iamceo-w11-archive" });
    seedFiles(store, project.id);
    store.db.query("UPDATE projects SET archived = 1 WHERE id = ?").run(project.id);
    const full = await (await get(`/api/projects/${project.id}/archive/state`)).json();
    const lite = await (await get(`/api/projects/${project.id}/archive/state?lite=1`)).json();
    expect(full.files.some((f: FileDoc) => f.body)).toBe(true);
    expect(lite).toEqual({ ...full, files: full.files.map(liteFile) });
    expect((await get(`/api/projects/${project.id}/archive/state?lite=yes`)).status).toBe(400);
    expect((await get(`/api/projects/${project.id}/archive/state?window=1`)).status).toBe(400);
    expect((await get(`/api/projects/${project.id}/todos/done`)).status).toBe(404);
  });

  test("창 묶음 소켓은 work 를 줄여 받고, 다른 소켓은 예전처럼 전체를 받는다", async () => {
    const { store, port } = await server();
    const project = store.createProject({ name: "소켓", cwd: "/private/tmp/iamceo-w11-ws" });
    seedWork(store, project.id, 70, 2);
    const Socket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    const open = async (query: string) => {
      const ws = new Socket(`ws://127.0.0.1:${port}/ws${query}`, { headers: auth });
      const frames: string[] = [];
      ws.onmessage = (m) => frames.push(String(m.data));
      await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("refused")); });
      closers.push(() => ws.close());
      return frames;
    };
    const windowFrames = await open("?v=2&lite=1&window=1");
    const liteFrames = await open("?v=2&lite=1");
    const v1Frames = await open("");
    await Bun.sleep(50);
    store.upsertWork({ projectId: project.id, sec: "doing", title: "새 일" });
    for (let i = 0; i < 50 && !(windowFrames.some(f => f.includes('"work"')) && liteFrames.some(f => f.includes('"work"')) && v1Frames.some(f => f.includes('"work"'))); i++) await Bun.sleep(20);
    const work = (frames: string[]) => JSON.parse(frames.find(f => JSON.parse(f).type === "work")!);
    const all = store.listWork(project.id);
    expect(work(liteFrames).work).toEqual(all);
    expect(work(v1Frames)).toEqual({ type: "work", projectId: project.id, work: all });
    const windowed = work(windowFrames);
    expect(windowed.doneWork).toBe(70);
    expect(windowed.work).toEqual(store.projectState(project.id, { window: true }).work);
    expect(windowed.seq).toBe(work(liteFrames).seq);
    // window 는 v2·lite 와 함께일 때만.
    for (const query of ["?window=1", "?v=2&window=1", "?lite=1&window=1", "?v=2&lite=1&window=yes"]) {
      const response = await fetch(`http://127.0.0.1:${port}/ws${query}`, { headers: { ...auth, Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } });
      expect(response.status).toBe(400);
    }
  });
});
