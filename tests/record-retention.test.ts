// E4: 안쪽 기록의 보존 기한(보낸 글 사본 30일, 끝난 실행·생명주기 기록과 영수증 90일)과 살아 있는 것만 찾는 색인.
// 대화·결재·할 일·자료·전달 행은 어떤 경우에도 지우지 않는다. 색인은 이주 판 번호를 올리지 않아 이전 판 서버도 DB 를 연다.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { ensureLiveIndexes, LIVE_INDEXES, MIGRATIONS, openDb } from "../server/db.ts";
import { RECORD_RETENTION_MS, StorageMaintenance, WIRE_TEXT_RETENTION_MS } from "../server/storage-maintenance.ts";
import { Store } from "../server/store.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-13T00:00:00.000Z");
const ago = (days: number, extraMs = 0) => new Date(NOW - days * DAY + extraMs).toISOString();
const closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

function freshStore(path = ":memory:") {
  const db = openDb(path); closers.push(() => db.close());
  const store = new Store(db, new Bus());
  const project = store.createProject({ name: "retention", cwd: "/private/tmp/iamceo-retention-work" });
  const member = (handle: string) => store.createMember({ projectId: project.id, handle, name: handle, cli: "claude", kind: "worker", backend: "core", paneId: `t-${handle}`, sessionId: `s-${handle}` });
  return { db, store, project, member };
}

function indexNames(db: ReturnType<typeof openDb>): string[] {
  return (db.query("SELECT name FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL ORDER BY name").all() as { name: string }[]).map(r => r.name);
}

describe("살아 있는 것만 찾는 색인", () => {
  test("열 때마다 IF NOT EXISTS 로 만들고 이주 판 번호(user_version)는 올리지 않는다", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-retention-")));
    const path = join(home, "iamceo.db");
    const first = openDb(path);
    expect(first.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(MIGRATIONS.length);
    const names = LIVE_INDEXES.map(sql => /INDEX IF NOT EXISTS (\S+)/.exec(sql)![1]!);
    for (const name of names) expect(indexNames(first)).toContain(name);
    const tables = first.query("SELECT name, sql FROM sqlite_schema WHERE type='table' ORDER BY name").all();
    first.close();
    // 다시 열어도(이전 판이 만든 DB 를 새 판이 여는 것과 같은 길) 그대로이고, 표·열은 바뀌지 않는다.
    const again = openDb(path); closers.push(() => again.close());
    expect(again.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(MIGRATIONS.length);
    expect(again.query("SELECT name, sql FROM sqlite_schema WHERE type='table' ORDER BY name").all()).toEqual(tables);
    expect(ensureLiveIndexes(again)).toEqual([]);
    expect(LIVE_INDEXES.every(sql => sql.startsWith("CREATE INDEX IF NOT EXISTS "))).toBe(true);
  });

  test("색인 하나가 실패해도 DB 는 열린다", () => {
    const { db } = freshStore();
    db.exec("DROP INDEX deliveries_project");
    db.exec("CREATE TABLE deliveries_project (x)"); // 같은 이름의 표가 있으면 색인을 만들 수 없다
    const warn = console.warn; const lines: string[] = []; console.warn = (line: string) => { lines.push(line); };
    try { expect(ensureLiveIndexes(db)).toEqual(["deliveries_project"]); } finally { console.warn = warn; }
    expect(lines[0]).toContain("deliveries_project");
  });

  // store.ts 의 쿼리 글자가 바뀌면 부분 색인이 조용히 쓰이지 않게 된다. 쿼리 원문과 계획을 함께 본다.
  const plans: [string, string, string][] = [
    ["실행 중인 실행", "SELECT run_id FROM execution_journal WHERE phase NOT IN ('ended','interrupted') ORDER BY created_at, rowid", "execution_journal_open"],
    ["쓰기 전 봉투", "SELECT id FROM delivery_dispatches WHERE transport_state = 'prepared' ORDER BY created_at, rowid", "delivery_dispatches_prepared"],
    ["결과 모르는 영수증", "SELECT operation_id FROM operation_receipts WHERE status = 'pending' ORDER BY created_at, rowid", "operation_receipts_pending"],
    ["프로젝트의 전달", "SELECT * FROM deliveries WHERE project_id = ? ORDER BY rowid", "deliveries_project"],
    ["직원별 마지막 시작 실행", "SELECT member_id, MAX(rowid) AS last_run FROM execution_journal WHERE project_id = ? AND started_at IS NOT NULL GROUP BY member_id", "execution_journal_project"],
    ["세대별 마지막 실행", "SELECT j.rowid FROM execution_journal j\n    WHERE j.member_id = m.id AND j.project_id = m.project_id AND j.generation = m.session_generation\n    ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1", "execution_journal_member_recent"],
  ];
  const source = readFileSync(join(import.meta.dir, "..", "server", "store.ts"), "utf8");
  test.each(plans)("%s: store.ts 쿼리가 그대로이고 새 색인을 탄다", (_name, sql, index) => {
    expect(source).toContain(sql);
    const { db } = freshStore();
    const query = sql.includes("m.id") ? `SELECT m.id, (${sql}) FROM members m` : sql;
    const detail = (db.query(`EXPLAIN QUERY PLAN ${query}`).all(...(query.includes("?") ? ["p"] : [])) as { detail: string }[]).map(r => r.detail).join(" | ");
    expect(detail).toContain(index);
  });
});

/** 시험용 행. 시각을 마음대로 정하려고 SQL 로 직접 넣는다. */
function seed() {
  const ctx = freshStore();
  const { db, store, project } = ctx;
  const m = ctx.member("worker"), n = ctx.member("helper"), p = ctx.member("third");
  const gen = (id: string) => store.memberRevisions(id).sessionGeneration;
  const identity = (id: string) => JSON.stringify({ terminalId: `t-${id}`, sessionId: `s-${id}`, sessionGeneration: gen(id), process: null });
  let seq = 0;
  const delivery = (memberId: string, status: string, phase = "resolved", recoveryAt = ago(40)) => {
    const d = store.enqueue({ projectId: project.id, memberId, kind: "instruction", text: `지시 ${++seq}` });
    db.query("UPDATE deliveries SET status = ? WHERE id = ?").run(status, d.id);
    db.query("UPDATE delivery_recovery SET phase = ?, updated_at = ? WHERE delivery_id = ?").run(phase, recoveryAt, d.id);
    return d.id;
  };
  const dispatch = (id: string, memberId: string, state: string, updatedAt: string, deliveries: string[]) => {
    const wire = `보낸 글 ${id}`;
    db.query(`INSERT INTO delivery_dispatches (id, project_id, member_id, bundle_marker, cli, backend, generation, native_session_id, terminal_identity_json, baseline_json, wire_text, wire_sha256, transport_state, submit_attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'claude', 'core', ?, ?, ?, '{}', ?, ?, ?, 0, ?, ?)`).run(id, project.id, memberId, `#b_${id}`, gen(memberId), `s-${memberId}`, identity(memberId), wire,
      createHash("sha256").update(wire).digest("hex"), state, updatedAt, updatedAt);
    deliveries.forEach((d, i) => db.query("INSERT INTO delivery_dispatch_items (dispatch_id, delivery_id, ordinal, source_revision) VALUES (?, ?, ?, 'r')").run(id, d, i));
  };
  const run = (runId: string, memberId: string, generation: number, phase: string, createdAt: string, options: { started?: boolean; input?: boolean } = {}) => {
    const started = options.started ?? true;
    db.query(`INSERT INTO execution_journal (run_id, member_id, project_id, generation, terminal_identity_json, delivery_ids_json, phase, input_received_at, started_at, ended_at, result, created_at, updated_at)
      VALUES (?, ?, ?, ?, '{}', '[]', ?, ?, ?, ?, ?, ?, ?)`).run(runId, memberId, project.id, generation, phase, options.input ?? started ? createdAt : null, started ? createdAt : null,
      ["ended", "interrupted"].includes(phase) ? createdAt : null, phase === "ended" ? "success" : phase === "interrupted" ? "interrupted" : null, createdAt, createdAt);
  };
  const lifecycle = (id: string, memberId: string, phase: string, at: string) => db.query(`INSERT INTO lifecycle_journal (operation_id, member_id, project_id, intent, phase, generation, terminal_identity_json, created_at, updated_at)
    VALUES (?, ?, ?, 'start', ?, ?, '{}', ?, ?)`).run(id, memberId, project.id, phase, gen(memberId), at, at);
  const receipt = (id: string, status: "pending" | "applied" | "refused", at: string) => db.query(`INSERT INTO operation_receipts (operation_id, kind, project_id, member_id, status, request_json, result_json, code, error, created_at, updated_at)
    VALUES (?, 'settings', ?, NULL, ?, '{}', ?, ?, ?, ?, ?)`).run(id, project.id, status, status === "applied" ? "{}" : null, status === "refused" ? "c" : null, status === "refused" ? "e" : null, at, at);
  return { ...ctx, m, n, p, gen, delivery, dispatch, run, lifecycle, receipt };
}

describe("보존 기한 정리(Store.pruneInternalRecords)", () => {
  test("보낸 글 사본은 전송과 전달이 모두 끝난 지 30일이 지난 봉투만 비운다. 봉투 행과 해시는 남는다", () => {
    const s = seed();
    s.dispatch("old-done", s.m.id, "accepted", ago(40), [s.delivery(s.m.id, "delivered")]);
    s.dispatch("old-stopped", s.m.id, "rejected", ago(40), [s.delivery(s.m.id, "failed", "stopped")]);
    s.dispatch("old-waiting", s.m.id, "accepted", ago(40), [s.delivery(s.m.id, "queued", "none")]);
    s.dispatch("old-owner", s.m.id, "accepted", ago(40), [s.delivery(s.m.id, "delivered", "needs_owner")]);
    s.dispatch("old-recheck", s.m.id, "accepted", ago(40), [s.delivery(s.m.id, "delivered", "resolved", ago(10))]);
    s.dispatch("old-mixed", s.m.id, "accepted", ago(40), [s.delivery(s.m.id, "delivered"), s.delivery(s.m.id, "held", "checking")]);
    s.dispatch("old-unknown", s.m.id, "unknown", ago(40), [s.delivery(s.m.id, "delivered")]);
    s.dispatch("old-writing", s.m.id, "write_started", ago(40), [s.delivery(s.m.id, "delivered")]);
    s.dispatch("recent", s.m.id, "accepted", ago(20), [s.delivery(s.m.id, "delivered", "resolved", ago(20))]);
    const before = new Map(s.store.listDispatches(s.m.id).map(d => [d.dispatchId, d]));
    const result = s.store.pruneInternalRecords({ now: NOW });
    expect(result).toMatchObject({ wireTexts: 2, complete: true });
    const after = new Map(s.store.listDispatches(s.m.id).map(d => [d.dispatchId, d]));
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [id, d] of after) {
      const cleared = ["old-done", "old-stopped"].includes(id);
      expect([id, d.wireText]).toEqual([id, cleared ? "" : before.get(id)!.wireText]);
      expect({ ...d, wireText: "" }).toEqual({ ...before.get(id)!, wireText: "" });
    }
    expect(s.store.pruneInternalRecords({ now: NOW }).wireTexts).toBe(0);
  });

  test("실행 기록은 끝난 지 90일이 지난 것만 지우고, 상태·대기 판정이 읽는 행은 남긴다", () => {
    const s = seed();
    const g = s.gen(s.m.id);
    s.run("old-0", s.m.id, g - 1 >= 0 ? g - 1 : g + 100, "ended", ago(300));     // 다른 세대의 마지막 행
    s.run("m-old-1", s.m.id, g, "ended", ago(120));
    s.run("m-old-2", s.m.id, g, "interrupted", ago(100));
    s.run("m-report", s.m.id, g, "ended", ago(110));                            // 결과 보고 누락 안내가 걸린 실행
    s.db.query("INSERT INTO messages (id, project_id, at, who, kind, body) VALUES ('msg_missing_report_m-report', ?, ?, '시스템', '시스템', '결과 보고 누락')").run(s.project.id, ago(110));
    s.run("m-stuck", s.m.id, g, "running", ago(150));                           // 끝나지 않은 실행
    s.run("m-recent", s.m.id, g, "ended", ago(10));                             // 세대의 마지막 행
    // helper: 마지막 행이 시작 전에 끝났다(입력 없음). 시각이 가장 늦은 시작 실행은 사용 한도 판정(lastWrittenExecution)이,
    // rowid 가 가장 큰 시작 실행(n-older, 늦게 적혔다)은 전달 대기 판정(startedRuns)이 읽는다. 둘 다 남는다.
    s.run("n-started", s.n.id, s.gen(s.n.id), "ended", ago(130));
    s.run("n-unwritten", s.n.id, s.gen(s.n.id), "ended", ago(95), { started: false, input: false });
    s.run("n-older", s.n.id, s.gen(s.n.id), "ended", ago(200));
    // third: 시각이 앞선 행이 rowid 는 가장 크다. 표의 최대 rowid 는 남겨 다음 rowid 가 줄지 않게 한다.
    s.run("p-newer", s.p.id, s.gen(s.p.id), "ended", ago(95));
    s.run("p-maxrow", s.p.id, s.gen(s.p.id), "ended", ago(99));
    const members = () => s.store.listMembers(s.project.id).map(m => JSON.stringify(m));
    const before = { members: members(), written: [s.m, s.n, s.p].map(x => s.store.lastWrittenExecution(x.id, s.gen(x.id))?.runId),
      started: s.db.query("SELECT member_id, MAX(rowid) AS r FROM execution_journal WHERE project_id = ? AND started_at IS NOT NULL GROUP BY member_id ORDER BY member_id").all(s.project.id),
      notices: s.store.listMissingReportNotices(s.project.id) };
    const result = s.store.pruneInternalRecords({ now: NOW });
    expect(result.executions).toBe(2);
    const left = (s.db.query("SELECT run_id FROM execution_journal ORDER BY run_id").all() as { run_id: string }[]).map(r => r.run_id);
    expect(left).toEqual(["m-recent", "m-report", "m-stuck", "n-older", "n-started", "n-unwritten", "old-0", "p-maxrow", "p-newer"]);
    expect(members()).toEqual(before.members);
    expect([s.m, s.n, s.p].map(x => s.store.lastWrittenExecution(x.id, s.gen(x.id))?.runId)).toEqual(before.written);
    expect(s.db.query("SELECT member_id, MAX(rowid) AS r FROM execution_journal WHERE project_id = ? AND started_at IS NOT NULL GROUP BY member_id ORDER BY member_id").all(s.project.id)).toEqual(before.started);
    expect(s.store.listMissingReportNotices(s.project.id)).toEqual(before.notices);
    expect(s.store.listPendingExecutions().map(r => r.runId)).toEqual(["m-stuck"]);
  });

  test("생명주기 기록은 세대의 마지막 행과 끝나지 않은 행을 남긴다", () => {
    const s = seed();
    s.lifecycle("l-old", s.m.id, "confirmed", ago(150));
    s.lifecycle("l-refused", s.m.id, "refused", ago(120));
    s.lifecycle("l-unknown", s.m.id, "unknown", ago(130));
    s.lifecycle("l-last", s.m.id, "confirmed", ago(100));
    s.lifecycle("l-recent", s.n.id, "confirmed", ago(5));
    const members = s.store.listMembers(s.project.id).map(m => JSON.stringify(m));
    expect(s.store.pruneInternalRecords({ now: NOW }).lifecycles).toBe(2);
    expect((s.db.query("SELECT operation_id FROM lifecycle_journal ORDER BY operation_id").all() as { operation_id: string }[]).map(r => r.operation_id)).toEqual(["l-last", "l-recent", "l-unknown"]);
    expect(s.store.listMembers(s.project.id).map(m => JSON.stringify(m))).toEqual(members);
  });

  test("영수증은 끝난 지 90일이 지난 것만 지우고, 결과를 모르는(pending) 것은 남긴다", () => {
    const s = seed();
    s.receipt("r-applied", "applied", ago(100));
    s.receipt("r-refused", "refused", ago(91));
    s.receipt("r-pending", "pending", ago(200));
    s.receipt("r-recent", "applied", ago(80));
    const d = s.delivery(s.m.id, "delivered");
    for (const [id, at] of [["a-old", ago(100)], ["a-new", ago(5)]] as const) {
      s.db.query("INSERT INTO agent_operation_receipts (operation_id, member_id, project_id, tool_name, request_json, result_json, created_at) VALUES (?, ?, ?, 'post', '{}', '{}', ?)").run(id, s.m.id, s.project.id, at);
      s.db.query("INSERT INTO delivery_recovery_operations (operation_id, delivery_id, request_json, result_json, created_at) VALUES (?, ?, '{}', '{}', ?)").run(`o-${id}`, d, at);
    }
    expect(s.store.pruneInternalRecords({ now: NOW })).toMatchObject({ receipts: 2, agentReceipts: 1, recoveryOperations: 1, complete: true });
    expect((s.db.query("SELECT operation_id FROM operation_receipts ORDER BY operation_id").all() as { operation_id: string }[]).map(r => r.operation_id)).toEqual(["r-pending", "r-recent"]);
    expect(s.store.getOperation("r-pending")?.status).toBe("pending");
    expect(s.store.getOperation("r-applied")).toBeNull();
    expect(s.db.query("SELECT operation_id FROM agent_operation_receipts").all()).toEqual([{ operation_id: "a-new" }]);
  });

  test("대화·결재·할 일·자료·전달·활동은 아무리 오래돼도 지우지 않는다", () => {
    const s = seed();
    const d = s.delivery(s.m.id, "delivered", "resolved", ago(400));
    const text = s.store.getDelivery(d)!.text;
    s.dispatch("ancient", s.m.id, "accepted", ago(400), [d]);
    s.run("ancient-run", s.m.id, s.gen(s.m.id), "ended", ago(400));
    s.run("ancient-run-2", s.m.id, s.gen(s.m.id), "ended", ago(390));
    s.db.query("INSERT INTO messages (id, project_id, at, who, kind, body) VALUES ('msg_old', ?, ?, '대표', '지시', '아주 오래된 대화')").run(s.project.id, ago(400));
    s.db.query("INSERT INTO decisions (id, project_id, member_id, who, title, status, created_at) VALUES ('dec_old', ?, ?, 'w', '오래된 결재', 'delivered', ?)").run(s.project.id, s.m.id, ago(400));
    s.db.query("INSERT INTO todos (id, project_id, title, done, created_at) VALUES ('todo_old', ?, '오래된 할 일', 1, ?)").run(s.project.id, ago(400));
    s.db.query("INSERT INTO files (id, project_id, title, created_at, sort_order) VALUES ('file_old', ?, '오래된 자료', ?, 0)").run(s.project.id, ago(400));
    s.store.appendActivity(s.m.id, "system", "오래된 활동");
    const tables = ["messages", "decisions", "todos", "files", "deliveries", "delivery_recovery", "delivery_dispatches", "delivery_dispatch_items", "activity", "report_references", "members", "projects"];
    const count = () => Object.fromEntries(tables.map(t => [t, (s.db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));
    const before = count();
    const bodies = s.db.query("SELECT id, body FROM messages ORDER BY id").all();
    s.store.pruneInternalRecords({ now: NOW + 3650 * DAY });
    expect(count()).toEqual(before);
    expect(s.db.query("SELECT id, body FROM messages ORDER BY id").all()).toEqual(bodies);
    // 전달 행의 원문은 그대로다(봉투의 보낸 글 사본만 비었다).
    expect(s.store.getDelivery(d)?.text).toBe(text);
    expect(s.store.getDispatch("ancient")?.wireText).toBe("");
  });

  test("한 번에 batch 행씩, 시간 예산을 넘기면 멈추고 다음 정리 때 이어 한다", () => {
    const s = seed();
    for (let i = 0; i < 7; i++) s.receipt(`r-${i}`, "applied", ago(100 + i));
    let t = 0;
    const first = s.store.pruneInternalRecords({ now: NOW, batch: 2, budgetMs: 6, clock: () => (t += 1) });
    expect(first.complete).toBe(false);
    expect(first.receipts).toBeGreaterThan(0);
    expect(first.receipts).toBeLessThan(7);
    const rest = s.store.pruneInternalRecords({ now: NOW, batch: 2 });
    expect(rest.complete).toBe(true);
    expect(first.receipts + rest.receipts).toBe(7);
  });

  test("잘못된 시각·기한은 거절한다", () => {
    const { store } = freshStore();
    expect(() => store.pruneInternalRecords({ now: Number.NaN })).toThrow();
    expect(() => store.pruneInternalRecords({ now: NOW, recordMs: 0 })).toThrow();
    expect(() => store.pruneInternalRecords({ now: NOW, wireTextMs: -1 })).toThrow();
  });
});

describe("storage-maintenance 의 시간당 정리에 붙는다", () => {
  function maintenance(records?: Pick<Store, "pruneInternalRecords">) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-retention-sweep-")));
    for (const d of ["uploads", "inbox", "backups"]) mkdirSync(join(root, d));
    return new StorageMaintenance({ uploadsDir: join(root, "uploads"), inboxDir: join(root, "inbox"), backupDir: join(root, "backups"),
      references: { isReferenced: () => true }, ...(records ? { records } : {}) });
  }
  test("기본 기한은 30일과 90일이다", () => {
    expect(WIRE_TEXT_RETENTION_MS).toBe(30 * DAY);
    expect(RECORD_RETENTION_MS).toBe(90 * DAY);
  });
  test("sweep 이 기록 정리를 함께 하고 결과를 싣는다. 기록 정리가 없으면 예전 결과 모양 그대로다", () => {
    const s = seed();
    s.receipt("r-old", "applied", ago(100));
    const calls: unknown[] = [];
    const info = console.info; console.info = () => undefined;
    try {
      const result = maintenance({ pruneInternalRecords: options => { calls.push(options); return s.store.pruneInternalRecords(options); } }).sweep(NOW);
      expect(result.records).toMatchObject({ receipts: 1, complete: true });
      expect(calls).toEqual([{ now: NOW, wireTextMs: WIRE_TEXT_RETENTION_MS, recordMs: RECORD_RETENTION_MS, budgetMs: 250 }]);
    } finally { console.info = info; }
    expect(maintenance().sweep(NOW)).toEqual({ quarantined: [], removed: [], retained: [], errors: [] });
  });
  test("기록 정리가 실패해도 파일 정리는 이어 가고 오류로 남는다", () => {
    const result = maintenance({ pruneInternalRecords: () => { throw new Error("디스크 가득"); } }).sweep(NOW);
    expect(result.errors).toEqual(["records"]);
    expect(result.records).toBeUndefined();
  });
});
