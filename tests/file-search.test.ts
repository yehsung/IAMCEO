import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { MIGRATIONS, openDb } from "../server/db.ts";
import { startServer } from "../server/http.ts";
import type { OrchestratorApi } from "../server/orchestrator-api.ts";
import { fileSearchMigration, refreshFileSearchIndex, scheduleFileSearchBackfill, Store } from "../server/store.ts";
import type { FileSearchResult } from "../shared/types.ts";

const cleanups: (() => void | Promise<void>)[] = [];
// 벽시계 상한은 기준 장비에서만 판정한다(bun run test:perf). 평소에는 수치만 남기고 결정적 단언만 본다.
const strictPerf = process.env.IAMCEO_PERF_STRICT === "1";
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture(disk = false) {
  const dir = mkdtempSync("/private/tmp/iamceo-file-search-");
  cleanups.push(() => rmSync(dir, { recursive: true }));
  const db = openDb(disk ? join(dir, "search.db") : ":memory:");
  cleanups.push(() => db.close());
  const bus = new Bus(), store = new Store(db, bus);
  const project = store.createProject({ name: "검색 시험", cwd: dir });
  const add = (input: Parameters<Store["createFile"]>[0]) => store.createFile(input);
  return { db, store, project, bus, dir, add };
}

describe("file search projection", () => {
  test("Korean substrings match title, path, summary, markdown, CSV and HTML text with ranked excerpts", () => {
    const { store, project, add } = fixture();
    const body = add({ projectId: project.id, title: "문서", kind: "document", body: "앞부분 ".repeat(20) + "결제 실패 화면 문구 뒷부분" });
    const title = add({ projectId: project.id, title: "결제 실패 화면 문구", kind: "document" });
    const path = add({ projectId: project.id, title: "경로", path: "/자료/결제 실패.md", kind: "document" });
    const summary = add({ projectId: project.id, title: "요약", summary: "결제 실패 화면", kind: "document" });
    const csv = add({ projectId: project.id, title: "CSV", kind: "table", body: '상태,문구\n실패,"결제 실패 화면 문구"' });
    const html = add({ projectId: project.id, title: "HTML", kind: "artifact", html: '<p data-secret="숨긴속성">결제 <b>실패</b> 화면 &amp; &#47928;구</p><script>숨긴스크립트</script><style>숨긴스타일</style>' });
    add({ projectId: store.createProject({ name: "다른 프로젝트", cwd: project.cwd }).id, title: "결제 실패" });
    const found = store.searchFiles(project.id, "결제 실패");
    expect(found.map(result => result.id).sort()).toEqual([body, title, path, summary, csv, html].map(file => file.id).sort());
    expect(found[0]).toMatchObject({ id: title.id, match: "title", rank: 1 });
    expect(found.find(result => result.id === path.id)?.match).toBe("title");
    expect(found.find(result => result.id === summary.id)?.match).toBe("title");
    for (const file of [body, csv, html]) {
      expect(found.find(result => result.id === file.id)?.match).toBe("body");
      expect(found.find(result => result.id === file.id)?.excerpt).toContain("결제 실패");
    }
    expect(store.searchFiles(project.id, "문구").map(result => result.id)).toContain(html.id);
    for (const query of ["숨긴속성", "숨긴스크립트", "숨긴스타일"]) expect(store.searchFiles(project.id, query)).toEqual([]);
    expect(store.searchFiles(project.id, "결").length).toBe(6);
    expect(store.searchFiles(project.id, "실패").length).toBe(6);
    expect(store.searchFiles(project.id, "결제 실패".normalize("NFD")).length).toBe(6);
  });

  test("literal FTS punctuation, case folding, empty input and strict limit behavior", () => {
    const { store, project, add } = fixture();
    for (let i = 0; i < 205; i++) add({ projectId: project.id, title: `자료 ${i}`, kind: "document", body: 'literal "quoted" 100% _ A AND B MixedCase' });
    for (const query of ['"quoted"', "100%", "_", "A AND B", "mixedcase"]) expect(store.searchFiles(project.id, query, 1)).toHaveLength(1);
    expect(store.searchFiles(project.id, "자료", 500)).toHaveLength(200);
    expect(store.searchFiles(project.id, "자료", 3).map(result => result.rank)).toEqual([1, 2, 3]);
    expect(store.searchFiles(project.id, " ")).toEqual([]);
    expect(store.searchFiles(project.id, "자료", 0)).toEqual([]);
    expect(store.searchFiles(project.id, "자료", -1)).toEqual([]);
    for (const limit of [1.5, NaN, Infinity]) expect(() => store.searchFiles(project.id, "자료", limit)).toThrow();
    expect(() => store.searchFiles(project.id, "a".repeat(513))).toThrow();
    expect(() => store.searchFiles(project.id, "a\0b")).toThrow();
  });

  test("insert, update, delete, rollback, archive and project cascade never return stale files", () => {
    const { db, store, project, add } = fixture();
    const file = add({ projectId: project.id, title: "최초", kind: "document", body: "첫 검색어" });
    expect(store.searchFiles(project.id, "첫 검색어")).toHaveLength(1);
    db.query("UPDATE files SET body=?,title=? WHERE id=?").run("바뀐 검색어", "새 제목", file.id);
    expect(store.searchFiles(project.id, "첫 검색어")).toEqual([]);
    expect(store.searchFiles(project.id, "바뀐 검색어")).toHaveLength(1);
    expect(store.searchFiles(project.id, "새 제목")).toHaveLength(1);
    expect(() => store.transaction(() => { add({ projectId: project.id, title: "롤백 검색어" }); throw new Error("rollback"); })).toThrow("rollback");
    expect(store.searchFiles(project.id, "롤백 검색어")).toEqual([]);
    store.patchProject(project.id, { archived: true });
    expect(() => store.searchFiles(project.id, "검색어")).toThrow();
    expect(store.searchFiles(project.id, "검색어", 50, true)).toHaveLength(1);
    expect(db.query("SELECT archived FROM file_search_documents WHERE file_id=?").get(file.id)).toEqual({ archived: 1 });
    store.patchProject(project.id, { archived: false });
    expect(() => store.searchFiles(project.id, "검색어", 50, true)).toThrow();
    db.query("DELETE FROM files WHERE id=?").run(file.id);
    expect(store.searchFiles(project.id, "검색어")).toEqual([]);
    add({ projectId: project.id, title: "프로젝트 삭제" });
    db.query("DELETE FROM projects WHERE id=?").run(project.id);
    expect(db.query("SELECT COUNT(*) AS n FROM file_search_documents").get()).toEqual({ n: 0 });
    db.exec("INSERT INTO file_search_fts(file_search_fts,rank) VALUES('integrity-check',1)");
  });

  test("body cap and binary/image/PDF metadata only; plain legacy documents still searchable", () => {
    const { store, project, add } = fixture();
    add({ projectId: project.id, title: "큰 본문", kind: "document", body: "앞머리" + "가".repeat(65536) + "색인밖꼬리" });
    expect(store.searchFiles(project.id, "앞머리")).toHaveLength(1);
    expect(store.searchFiles(project.id, "색인밖꼬리")).toEqual([]);
    const emoji = add({ projectId: project.id, title: "이모지 본문", kind: "document", body: "😀".repeat(65530) + "경계검색어" });
    const excerpt = store.searchFiles(project.id, "경계검색어").find(result => result.id === emoji.id)?.excerpt ?? "";
    expect(excerpt).toContain("경계검색어");
    expect(excerpt.isWellFormed()).toBe(true);
    for (const kind of ["file", "image", "pdf", "audio", "video"] as const) {
      add({ projectId: project.id, title: "제목검색 " + kind, path: `/경로검색/a.${kind === "file" ? "zip" : kind}`, kind, summary: "바이너리요약", body: "바이너리본문" });
    }
    expect(store.searchFiles(project.id, "바이너리본문")).toEqual([]);
    expect(store.searchFiles(project.id, "바이너리요약")).toEqual([]);
    expect(store.searchFiles(project.id, "제목검색")).toHaveLength(5);
    expect(store.searchFiles(project.id, "경로검색")).toHaveLength(5);
    const legacy = add({ projectId: project.id, title: "예전 문서", body: "예전본문검색" });
    expect(store.searchFiles(project.id, "예전본문검색")[0].id).toBe(legacy.id);
  });
});

test("empty backfill schedules no timer and leaves total_changes unchanged after opening", async () => {
  const db = openDb(":memory:");
  cleanups.push(() => db.close());
  expect(db.query("SELECT COUNT(*) AS n FROM file_search_pending").get()).toEqual({ n: 0 });
  const before = db.query("SELECT total_changes() AS n").get();
  const timer = spyOn(globalThis, "setTimeout");
  try {
    scheduleFileSearchBackfill(db);
    expect(timer).not.toHaveBeenCalled();
  } finally { timer.mockRestore(); }
  expect(refreshFileSearchIndex(db)).toBe(0);
  await Bun.sleep(50);
  expect(db.query("SELECT total_changes() AS n").get()).toEqual(before);
  expect(db.query("SELECT completed_at FROM file_search_migration_audit").get()).toEqual({ completed_at: null });
});

test("schema backfill audits once and keeps failed projections pending without failing searches", () => {
  const db = new Database(":memory:");
  cleanups.push(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  for (const sql of MIGRATIONS.slice(0, MIGRATIONS.indexOf(fileSearchMigration()))) db.exec(sql);
  const store = new Store(db, new Bus());
  const project = store.createProject({ name: "이주 전 자료", cwd: "/fixture" });
  const file = store.createFile({ projectId: project.id, title: "기존 자료", kind: "document", body: "기존 결제 실패 화면 문구" });
  store.createFile({ projectId: project.id, title: "두 번째 기존 자료", kind: "document", body: "별도 본문" });
  db.exec(fileSearchMigration());
  expect(refreshFileSearchIndex(db, { limit: 1 })).toBe(1);
  expect(db.query("SELECT completed_at FROM file_search_migration_audit").get()).toEqual({ completed_at: null });
  // A filtered refresh that processes nothing must not complete the audit either.
  expect(refreshFileSearchIndex(db, { fileId: "missing" })).toBe(0);
  expect(db.query("SELECT completed_at FROM file_search_migration_audit").get()).toEqual({ completed_at: null });
  expect(refreshFileSearchIndex(db, { limit: 1 })).toBe(1);
  expect(store.searchFiles(project.id, "결제 실패").map(result => result.id)).toEqual([file.id]);
  const audit = db.query("SELECT * FROM file_search_migration_audit").get();
  expect(audit).toMatchObject({ indexed_files: 2, body_limit: 65536, completed_at: expect.any(String) });
  const changes = db.query("SELECT total_changes() AS n").get();
  refreshFileSearchIndex(db);
  expect(db.query("SELECT total_changes() AS n").get()).toEqual(changes);
  expect(db.query("SELECT * FROM file_search_migration_audit").get()).toEqual(audit);
  db.query("UPDATE files SET body='롤백 이후 본문' WHERE id=?").run(file.id);
  db.exec("CREATE TRIGGER reject_file_search BEFORE INSERT ON file_search_documents BEGIN SELECT RAISE(ABORT,'index failure'); END");
  expect(store.searchFiles(project.id, "롤백 이후")).toEqual([]);
  expect(db.query("SELECT file_id FROM file_search_pending").all()).toEqual([{ file_id: file.id }]);
  db.exec("DROP TRIGGER reject_file_search");
  expect(store.searchFiles(project.id, "롤백 이후")).toHaveLength(1);
});

test("versioned migration backfills once with backup and audit, then reopens without rebuilding", () => {
  const dir = mkdtempSync("/private/tmp/iamceo-search-migration-");
  cleanups.push(() => rmSync(dir, { recursive: true }));
  const path = join(dir, "old.db");
  const stage = MIGRATIONS.findIndex(sql => sql.includes("CREATE TABLE file_search_documents"));
  expect(stage).toBeGreaterThan(0);
  const old = new Database(path);
  for (let v = 0; v < stage; v++) { old.exec(MIGRATIONS[v]); old.exec(`PRAGMA user_version=${v + 1}`); }
  old.exec(`INSERT INTO projects(id,name,cwd,runner_enabled,created_at,updated_at)
    VALUES('legacy','예전','/fixture',0,'now','now');
    INSERT INTO files(id,project_id,title,body,kind,html,created_at,sort_order) VALUES
    ('old','legacy','예전 자료','기존 결제 실패 화면 문구','document',NULL,'now',1),
    ('html','legacy','예전 HTML','','artifact','<p>기존 <b>결제 실패</b> 화면 문구</p>','now',2);`);
  old.close();
  const db = openDb(path), store = new Store(db, new Bus());
  expect(store.searchFiles("legacy", "결제 실패")).toHaveLength(2);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
  const audit = db.query("SELECT * FROM file_search_migration_audit").get();
  expect(audit).toMatchObject({ indexed_files: 2, body_limit: 65536 });
  const backups = readdirSync(dir).filter(name => name.includes(".pre-v"));
  expect(backups).toHaveLength(1);
  const backup = new Database(join(dir, backups[0]), { readonly: true });
  expect(backup.query("PRAGMA user_version").get()).toEqual({ user_version: stage });
  expect(backup.query("SELECT COUNT(*) AS n FROM files").get()).toEqual({ n: 2 });
  backup.close(); db.close();
  const again = openDb(path);
  expect(again.query("SELECT * FROM file_search_migration_audit").get()).toEqual(audit);
  expect(readdirSync(dir).filter(name => name.includes(".pre-v"))).toEqual(backups);
  again.close();
});

test("HTTP authentication, v2 query validation, project isolation and archive routes", async () => {
  const { store, project, bus, dir, add } = fixture();
  add({ projectId: project.id, title: "결제 실패" });
  const member = store.createMember({ projectId: project.id, handle: "searcher", name: "검색 직원", kind: "worker" });
  const config = loadConfig({ IAMCEO_HOME: dir, IAMCEO_PORT: "0" });
  const server = await startServer({ config, store, bus, orch: {} as OrchestratorApi, detectHosts: () => [] });
  cleanups.push(() => server.stop());
  expect(server.port).not.toBe(7878);
  const base = `http://127.0.0.1:${server.port}`;
  const path = `/api/projects/${project.id}/files/search`;
  const get = (suffix: string, token = config.accessCode, contract = "2") => {
    if (server.port === 7878) throw new Error("live port forbidden");
    return fetch(base + suffix, { headers: { Authorization: `Bearer ${token}`, "X-IAMCEO-Contract": contract }, redirect: "error" });
  };
  expect((await get(path + "?q=결제", "wrong")).status).toBe(401);
  expect((await get(path + "?q=결제", store.getMemberToken(member.id))).status).toBe(401);
  const response = await get(path + "?q=결제&limit=1");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toHaveLength(1);
  for (const query of ["", "?q=a&limit=0", "?q=a&limit=201", "?q=a&limit=1.5", "?q=a&limit=NaN", "?q=a&q=b", "?q=a&unknown=1"]) expect((await get(path + query)).status).toBe(400);
  expect((await get(path + "?q=a", config.accessCode, "3")).status).toBe(400);
  expect((await get("/api/projects/missing/files/search?q=결제")).status).toBe(404);
  expect((await get(`/api/projects/${project.id}/archive/files/search?q=결제`)).status).toBe(404);
  store.patchProject(project.id, { archived: true });
  expect((await get(path + "?q=결제")).status).toBe(404);
  const archived = await get(`/api/projects/${project.id}/archive/files/search?q=결제`);
  expect(archived.status).toBe(200);
  expect(await archived.json()).toHaveLength(1);
});

test("bad source rows degrade to metadata, warn once each and do not block later rows", () => {
  const { db, store, project } = fixture();
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const insert = db.query("INSERT INTO files(id,project_id,title,path,body,kind,attachments,created_at,sort_order) VALUES(?,?,?,?,?,?,?,'now',1)");
    insert.run("bad-json", project.id, "깨진자료제목", "/깨진자료경로.md", "숨겨질본문", "document", "invalid json");
    insert.run("binary", project.id, "바이너리제목", "/binary.md", new Uint8Array([0, 255, 1, 2]), "document", "[]");
    insert.run("controls", project.id, "제어문자제목", "/control.md", "\u0001숨겨질본문", "document", "[]");
    insert.run("good", project.id, "정상자료", null, "정상검색본문", "document", "[]");
    refreshFileSearchIndex(db);
    expect(store.searchFiles(project.id, "깨진자료제목").map(row => row.id)).toEqual(["bad-json"]);
    expect(store.searchFiles(project.id, "깨진자료경로").map(row => row.id)).toEqual(["bad-json"]);
    expect(store.searchFiles(project.id, "숨겨질본문")).toEqual([]);
    expect(store.searchFiles(project.id, "정상검색본문").map(row => row.id)).toEqual(["good"]);
    expect(warnings).toHaveBeenCalledTimes(3);
    for (const [line] of warnings.mock.calls) expect(line).not.toContain("\n");
    expect(db.query("SELECT COUNT(*) AS n FROM file_search_pending").get()).toEqual({ n: 0 });
  } finally { warnings.mockRestore(); }
});

test("HTML parser exceptions and FTS write failures preserve source writes and use metadata fallback", () => {
  const { db, store, project, add } = fixture();
  const runtime = globalThis as typeof globalThis & { HTMLRewriter: typeof HTMLRewriter };
  const original = runtime.HTMLRewriter;
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  try {
    runtime.HTMLRewriter = class extends original { on(): never { throw new Error("parser failure\nsource secret"); } };
    const file = add({ projectId: project.id, title: "추출실패제목", path: "/추출실패경로.html", kind: "artifact", html: "<p>숨겨질본문</p>" });
    expect(store.searchFiles(project.id, "추출실패제목").map(row => row.id)).toEqual([file.id]);
    expect(store.searchFiles(project.id, "추출실패경로")).toHaveLength(1);
    expect(store.searchFiles(project.id, "숨겨질본문")).toEqual([]);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings.mock.calls[0][0]).not.toContain("source secret");
    db.exec("CREATE TRIGGER reject_search_body BEFORE INSERT ON file_search_documents WHEN NEW.body<>'' BEGIN SELECT RAISE(ABORT,'FTS failure'); END");
    const failed = add({ projectId: project.id, title: "색인실패제목", kind: "document", body: "실패본문" });
    expect(store.getFile(failed.id)?.body).toBe("실패본문");
    expect(store.searchFiles(project.id, "색인실패제목").map(row => row.id)).toEqual([failed.id]);
    expect(store.searchFiles(project.id, "실패본문")).toEqual([]);
    expect(warnings).toHaveBeenCalledTimes(2);
    db.exec("CREATE TRIGGER reject_search_row BEFORE INSERT ON file_search_documents WHEN NEW.title='전체색인실패제목' BEGIN SELECT RAISE(ABORT,'all projection writes fail'); END");
    const pending = add({ projectId: project.id, title: "전체색인실패제목", kind: "document", body: "재시도본문" });
    expect(store.getFile(pending.id)?.body).toBe("재시도본문");
    expect(db.query("SELECT file_id FROM file_search_pending").all()).toEqual([{ file_id: pending.id }]);
    expect(warnings).toHaveBeenCalledTimes(3);
    db.exec("DROP TRIGGER reject_search_row; DROP TRIGGER reject_search_body");
    expect(store.searchFiles(project.id, "재시도본문").map(row => row.id)).toEqual([pending.id]);
  } finally { runtime.HTMLRewriter = original; warnings.mockRestore(); }
});

const mixedHTML = [
  "<p>결제<br>실패<img src='hidden-image'> 화면<hr>문구<meta charset='utf-8'><link href='hidden-link'><input value='hidden-input'></p>",
  "<p>결제 실패 <b broken='x'<i>깨진 태그</p>",
  "<div><p>결제 실패 닫히지 않은 태그",
  "<p>결제 실패</p><script>숨긴스크립트</script><style>숨긴스타일</style><template>숨긴템플릿</template><noscript>숨긴대체</noscript>",
  "<p>결제 실패 아주 긴 HTML</p>" + "<div>긴 본문</div>".repeat(100_000) + "색인밖꼬리",
  "<p>결제 실패</p><script>닫히지않은스크립트",
  "<p>결제 실패</p><style>닫히지않은스타일",
  "<svg><path /></svg><p>결제 실패 외부요소</p>",
];

// Both a fresh schema and the supervisor's real starting version must survive heterogeneous sources.
for (const version of [0, 31]) test(`v${version} mixed HTML/binary migration starts HTTP and completes deferred backfill`, async () => {
  const dir = mkdtempSync("/private/tmp/iamceo-search-mixed-");
  cleanups.push(() => rmSync(dir, { recursive: true }));
  const path = join(dir, "mixed.db");
  const stage = MIGRATIONS.findIndex(sql => sql.includes("CREATE TABLE file_search_documents"));
  expect(stage).toBe(31);
  const seed = (db: Database) => {
    db.exec("INSERT INTO projects(id,name,cwd,runner_enabled,created_at,updated_at) VALUES('p','자료 혼합','/fixture',0,'now','now')");
    const insert = db.query("INSERT INTO files(id,project_id,title,path,body,html,kind,attachments,created_at,sort_order) VALUES(?,'p',?,?,?,?,?,?,'now',1)");
    db.transaction(() => {
      mixedHTML.forEach((html, i) => insert.run(`html-${i}`, `HTML자료 ${i}`, `/html-${i}.html`, "", html, "artifact", "[]"));
      insert.run("binary", "바이너리자료", "/binary.md", new Uint8Array([255, 0, 1, 2]), null, "document", "[]");
      insert.run("bad-json", "깨진첨부자료", "/bad.md", "본문", null, null, "broken json");
      insert.run("text", "텍스트자료", "/text.md", "결제 실패 일반 문서", null, "document", "[]");
    })();
  };
  if (version) {
    const old = new Database(path);
    for (let v = 0; v < version; v++) { old.exec(MIGRATIONS[v]); old.exec(`PRAGMA user_version=${v + 1}`); }
    seed(old); old.close();
  }
  let db = openDb(path);
  if (!version) {
    // Startup schedules only existing pending work; seed before the tested reopen.
    seed(db); db.close(); db = openDb(path);
  }
  cleanups.push(() => db.close());
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
  expect(db.query("SELECT COUNT(*) AS n FROM file_search_documents").get()).toEqual({ n: 0 });
  expect(db.query("SELECT completed_at FROM file_search_migration_audit").get()).toEqual({ completed_at: null });
  const bus = new Bus(), store = new Store(db, bus);
  const config = loadConfig({ IAMCEO_HOME: dir, IAMCEO_PORT: "0" });
  const server = await startServer({ config, store, bus, orch: {} as OrchestratorApi, detectHosts: () => [] });
  cleanups.push(() => server.stop());
  if (server.port === 7878) throw new Error("live port forbidden");
  const get = (path: string) => fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { Authorization: `Bearer ${config.accessCode}` }, redirect: "error" });
  expect((await get("/api/health")).status).toBe(200);
  // Wait for the actual startup scheduler, without invoking refresh/search to do the backfill.
  const deadline = performance.now() + 5000;
  while (db.query("SELECT 1 FROM file_search_pending LIMIT 1").get() && performance.now() < deadline) await Bun.sleep(10);
  expect(db.query("SELECT COUNT(*) AS n FROM file_search_pending").get()).toEqual({ n: 0 });
  expect(db.query("SELECT * FROM file_search_migration_audit").get()).toMatchObject({ indexed_files: mixedHTML.length + 3, body_limit: 65536, completed_at: expect.any(String) });
  const response = await get("/api/projects/p/files/search?q=" + encodeURIComponent("결제 실패"));
  expect(response.status).toBe(200);
  expect((await response.json() as FileSearchResult[]).map(row => row.id).sort()).toEqual([...mixedHTML.map((_, i) => `html-${i}`), "text"].sort());
  for (const term of ["숨긴스크립트", "숨긴스타일", "숨긴템플릿", "숨긴대체", "닫히지않은스크립트", "닫히지않은스타일", "hidden-image", "색인밖꼬리"]) expect(store.searchFiles("p", term)).toEqual([]);
  expect(store.searchFiles("p", "바이너리자료")).toHaveLength(1);
  expect(store.searchFiles("p", "깨진첨부자료")).toHaveLength(1);
  expect(readdirSync(dir).filter(name => name.includes(".pre-v"))).toHaveLength(version ? 1 : 0);
});

test("whole backfill failure does not prevent startup/version commit; pending resumes on reopen", async () => {
  const dir = mkdtempSync("/private/tmp/iamceo-search-failure-");
  cleanups.push(() => rmSync(dir, { recursive: true }));
  const path = join(dir, "old.db");
  const stage = MIGRATIONS.findIndex(sql => sql.includes("CREATE TABLE file_search_documents"));
  const old = new Database(path);
  for (let v = 0; v < stage; v++) { old.exec(MIGRATIONS[v]); old.exec(`PRAGMA user_version=${v + 1}`); }
  old.exec("INSERT INTO projects(id,name,cwd,runner_enabled,created_at,updated_at) VALUES('p','예전','/fixture',0,'now','now'); INSERT INTO files(id,project_id,title,body,kind,created_at,sort_order) VALUES('f','p','자료','결제 실패','document','now',1)");
  old.close();
  const migration = MIGRATIONS[stage];
  let db: Database;
  try {
    // Fail the whole batch's final audit write, after it has indexed individual rows.
    MIGRATIONS[stage] += "; CREATE TRIGGER reject_search_audit BEFORE UPDATE ON file_search_migration_audit BEGIN SELECT RAISE(ABORT,'audit failure'); END";
    db = openDb(path);
  } finally { MIGRATIONS[stage] = migration; }
  cleanups.push(() => db.close());
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const bus = new Bus(), store = new Store(db, bus);
    const config = loadConfig({ IAMCEO_HOME: dir, IAMCEO_PORT: "0" });
    const server = await startServer({ config, store, bus, orch: {} as OrchestratorApi, detectHosts: () => [] });
    cleanups.push(() => server.stop());
    if (server.port === 7878) throw new Error("live port forbidden");
    await Bun.sleep(40);
    expect((await fetch(`http://127.0.0.1:${server.port}/api/health`, { redirect: "error" })).status).toBe(200);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
    expect(db.query("SELECT file_id FROM file_search_pending").all()).toEqual([{ file_id: "f" }]);
    expect(db.query("SELECT COUNT(*) AS n FROM file_search_documents").get()).toEqual({ n: 0 });
    expect(db.query("SELECT completed_at FROM file_search_migration_audit").get()).toEqual({ completed_at: null });
    expect(warnings).toHaveBeenCalledTimes(1);
    db.exec("DROP TRIGGER reject_search_audit");
    await server.stop(); db.close();
    const reopened = openDb(path);
    cleanups.push(() => reopened.close());
    await Bun.sleep(40);
    expect(reopened.query("SELECT file_id FROM file_search_documents").all()).toEqual([{ file_id: "f" }]);
    expect(new Store(reopened, new Bus()).searchFiles("p", "결제 실패")).toHaveLength(1);
    expect(readdirSync(dir).filter(name => name.includes(".pre-v"))).toHaveLength(1);
  } finally { warnings.mockRestore(); }
});

test("v31 startup defers 2,000 HTML bodies and yields between bounded backfill batches", async () => {
  const dir = mkdtempSync("/private/tmp/iamceo-search-startup-");
  cleanups.push(() => rmSync(dir, { recursive: true }));
  const path = join(dir, "large.db"), old = new Database(path);
  const stage = MIGRATIONS.findIndex(sql => sql.includes("CREATE TABLE file_search_documents"));
  for (let v = 0; v < stage; v++) { old.exec(MIGRATIONS[v]); old.exec(`PRAGMA user_version=${v + 1}`); }
  old.exec("INSERT INTO projects(id,name,cwd,runner_enabled,created_at,updated_at) VALUES('p','많은 자료','/fixture',0,'now','now')");
  const html = "<p>결제<br>실패<img src='hidden'> 화면 문구</p>" + "<div>일반 자료 본문입니다.</div>".repeat(180);
  const insert = old.query("INSERT INTO files(id,project_id,title,html,kind,created_at,sort_order) VALUES(?,'p',?,?,'artifact','now',1)");
  old.transaction(() => { for (let i = 0; i < 2000; i++) insert.run(`f-${i}`, `자료 ${i}`, html); })();
  old.close();
  const started = performance.now(), db = openDb(path), opened = performance.now() - started;
  cleanups.push(() => db.close());
  expect(db.query("SELECT COUNT(*) AS n FROM file_search_documents").get()).toEqual({ n: 0 });
  const bus = new Bus(), store = new Store(db, bus), config = loadConfig({ IAMCEO_HOME: dir, IAMCEO_PORT: "0" });
  const server = await startServer({ config, store, bus, orch: {} as OrchestratorApi, detectHosts: () => [] });
  cleanups.push(() => server.stop());
  const listening = performance.now() - started;
  if (server.port === 7878) throw new Error("live port forbidden");
  const beforeHealth = performance.now();
  expect((await fetch(`http://127.0.0.1:${server.port}/api/health`, { redirect: "error" })).status).toBe(200);
  const health = performance.now() - beforeHealth;
  // Search must not synchronously drain all the remaining bodies either.
  const beforeSearch = performance.now();
  const response = await fetch(`http://127.0.0.1:${server.port}/api/projects/p/files/search?q=${encodeURIComponent("결제 실패")}&limit=5`, { headers: { Authorization: `Bearer ${config.accessCode}` }, redirect: "error" });
  expect(response.status).toBe(200);
  expect(await response.json()).toHaveLength(5);
  const firstSearch = performance.now() - beforeSearch;
  const left = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM file_search_pending").get()!.n;
  expect(left).toBeGreaterThan(1900);
  if (strictPerf) {
    expect(opened).toBeLessThan(3000);
    expect(listening).toBeLessThan(3000);
  }
  const deadline = performance.now() + 60_000;
  let yields = 0;
  while (db.query("SELECT 1 FROM file_search_pending LIMIT 1").get() && performance.now() < deadline) { await Bun.sleep(10); yields++; }
  expect(db.query("SELECT COUNT(*) AS n FROM file_search_pending").get()).toEqual({ n: 0 });
  expect(yields).toBeGreaterThan(1);
  console.info(JSON.stringify({ scenario: "v31 HTML deferred backfill", files: 2000, htmlCharacters: html.length, openDbMs: opened, listeningMs: listening, healthMs: health, firstSearchMs: firstSearch, pendingAfterSearch: left, backfillMs: performance.now() - started, yields }));
}, 90_000);

test("performance: 2,000 files including text bodies, store and authenticated HTTP latency", async () => {
  const { store, project, bus, dir, add } = fixture(true);
  const body = "일반 문서 내용과 화면 안내입니다. ".repeat(220);
  store.transaction(() => {
    for (let i = 0; i < 2000; i++) add({ projectId: project.id, title: `문서 ${i}`, kind: "document", body: body + (i % 20 === 0 ? "결제 실패 화면 문구" : "다른 화면") });
  });
  const firstStart = performance.now();
  expect(store.searchFiles(project.id, "결제 실패", 50)).toHaveLength(50);
  const first = performance.now() - firstStart;
  const times: number[] = [];
  for (let i = 0; i < 30; i++) {
    const start = performance.now(); store.searchFiles(project.id, "결제 실패", 50); times.push(performance.now() - start);
  }
  const config = loadConfig({ IAMCEO_HOME: dir, IAMCEO_PORT: "0" });
  const server = await startServer({ config, store, bus, orch: {} as OrchestratorApi, detectHosts: () => [] });
  cleanups.push(() => server.stop());
  if (server.port === 7878) throw new Error("live port forbidden");
  const http: number[] = [];
  for (let i = 0; i < 30; i++) {
    const start = performance.now();
    const response = await fetch(`http://127.0.0.1:${server.port}/api/projects/${project.id}/files/search?q=${encodeURIComponent("결제 실패")}&limit=50`, { headers: { Authorization: `Bearer ${config.accessCode}` }, redirect: "error" });
    expect(response.status).toBe(200);
    expect((await response.json() as FileSearchResult[]).length).toBe(50);
    http.push(performance.now() - start);
  }
  times.sort((a, b) => a - b); http.sort((a, b) => a - b);
  console.info(JSON.stringify({ files: 2000, bodyCharacters: body.length, bodyBytes: Buffer.byteLength(body), query: "결제 실패", limit: 50, firstMs: first,
    storeMedianMs: times[15], storeP95Ms: times[28], httpMedianMs: http[15], httpP95Ms: http[28], httpMaxMs: http[29] }));
  // Loose regression ceiling: report observed latency instead of a flaky 50 ms CI assertion.
  if (strictPerf) expect(times[28]).toBeLessThan(250);
}, 60_000);
