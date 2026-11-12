import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { MessageScope, WsEvent } from "../shared/types.ts";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { ApiError, Store } from "../server/store.ts";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), "iamceo-page-")), "fixture.db");
  const db = openDb(path);
  databases.push(db);
  const bus = new Bus();
  const events: WsEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const store = new Store(db, bus);
  const project = store.createProject({ name: "이력", cwd: "/fixture", runnerEnabled: false });
  events.length = 0;
  return { path, db, bus, store, projectId: project.id, events };
}
function status(fn: () => unknown, expected: number, code?: string) {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(expected);
    if (code) expect((error as ApiError).code as string).toBe(code);
    return;
  }
  throw new Error(`Expected ApiError ${expected}`);
}
const cursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("Store message keyset paging", () => {
  for (const count of [0, 1, 199, 200, 201, 500, 501, 1205]) {
    test(`${count}개: SQL 전체 순서와 순회가 같고 마지막 커서가 없다`, () => {
      const { store, db, projectId, events } = fixture();
      const insert = db.query("INSERT INTO messages (id, project_id, at, kind) VALUES (?, ?, ?, '알림')");
      db.transaction(() => { for (let i = 0; i < count; i++) insert.run(`m_${String(count - i).padStart(5, "0")}`, projectId, "2026-11-07T00:00:00.000Z"); })();
      const expected = db.query<{ id: string }, [string]>("SELECT id FROM messages WHERE project_id = ? ORDER BY at COLLATE BINARY, id COLLATE BINARY").all(projectId).map((r) => r.id);
      let page = store.listMessagePage(projectId);
      expect(page.items.length).toBe(Math.min(count, 200));
      const seen = page.items.map((m) => m.id);
      while (page.hasOlder) {
        expect(page.nextCursor).not.toBeNull();
        page = store.listMessagePage(projectId, { cursor: page.nextCursor!, limit: 100 });
        seen.unshift(...page.items.map((m) => m.id));
      }
      expect(page.nextCursor).toBeNull();
      expect(seen).toEqual(expected);
      expect(new Set(seen).size).toBe(count);
      expect(events).toEqual([]);
    });
  }

  test("Unicode BINARY tie와 삭제한 경계, 재시작, 새 tail, 전달 수정", () => {
    const { store, db, path, projectId } = fixture();
    for (const id of ["😀", "\uE000", "가", "é", "e\u0301", "a", "z"]) store.createMessage({ id, projectId, at: "same", kind: "알림" });
    const expected = db.query<{ id: string }, [string]>("SELECT id FROM messages WHERE project_id = ? ORDER BY at COLLATE BINARY, id COLLATE BINARY").all(projectId).map((r) => r.id);
    const first = store.listMessagePage(projectId, { limit: 3 });
    const boundary = first.items[0]!;
    store.setMessageDelivery(first.items[1]!.id, "delivered");
    store.createMessage({ id: "tail", projectId, at: "zzz", kind: "완료" });
    db.query("DELETE FROM messages WHERE id = ?").run(boundary.id);
    const reopenedDb = openDb(path);
    databases.push(reopenedDb);
    const reopened = new Store(reopenedDb, new Bus());
    const next = reopened.listMessagePage(projectId, { cursor: first.nextCursor!, limit: 100 });
    expect(next.items.map((m) => m.id)).toEqual(expected.slice(0, -3));
    expect(next.hasOlder).toBe(false);
    expect(reopened.listMessagePage(projectId, { cursor: first.nextCursor!, limit: 100 })).toEqual(next);
  });

  test("직원 작성/대상 UNION은 중복 없이 깊은 이력을 읽고 총괄은 전체로 정규화", () => {
    const { store, projectId } = fixture();
    const worker = store.createMember({ projectId, name: "직원", handle: "worker", kind: "worker" });
    const lead = store.createMember({ projectId, name: "총괄", handle: "lead", kind: "conductor" });
    for (const [id, memberId, targetMemberId] of [["a", worker.id, null], ["b", null, worker.id], ["c", worker.id, worker.id]] as const) store.createMessage({ id, projectId, memberId, targetMemberId, at: "a", kind: "진행" });
    for (let i = 0; i < 230; i++) store.createMessage({ projectId, at: "z", kind: "시스템" });
    const scope: MessageScope = { kind: "member", memberId: worker.id };
    const page = store.listMessagePage(projectId, { scope, limit: 2 });
    expect(page.items.map((m) => m.id)).toEqual(["b", "c"]);
    expect(store.listMessagePage(projectId, { scope, cursor: page.nextCursor! }).items.map((m) => m.id)).toEqual(["a"]);
    expect(store.listMessagePage(projectId, { scope: { kind: "member", memberId: lead.id } }).scope).toEqual({ kind: "project" });
    store.removeMember(worker.id);
    expect(store.listMessagePage(projectId, { scope }).items.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(store.listMessagePage(projectId, { scope: { kind: "member", memberId: "unknown" } }).items).toEqual([]);
    const foreign = store.createProject({ name: "타 프로젝트", cwd: "/fixture" });
    expect(store.listMessagePage(foreign.id, { scope }).items).toEqual([]);
  });

  test("커서의 모양/프로젝트/범위/정규화 변경과 limit 검증", () => {
    const { store, projectId } = fixture();
    for (const limit of [0, -1, 1.2, NaN, Infinity, 501]) status(() => store.listMessagePage(projectId, { limit }), 400, "INVALID_MESSAGE_PAGE_QUERY");
    const valid = { v: 1, projectId, scope: { kind: "project" }, before: { at: "at", id: "id" } };
    for (const value of ["", "%", "a".repeat(4097), "eyJ", cursor({}), cursor({ ...valid, v: 2 }), cursor({ ...valid, extra: true }), cursor({ ...valid, projectId: "hq" }), cursor({ ...valid, before: { at: "x".repeat(129), id: "id" } })]) status(() => store.listMessagePage(projectId, { cursor: value }), 400, "INVALID_MESSAGE_CURSOR");
    status(() => store.listMessagePage(projectId, { scope: { kind: "member", memberId: "" } }), 400);
    status(() => store.listMessagePage(projectId, { scope: { kind: "member", memberId: "b" }, cursor: cursor({ ...valid, scope: { kind: "member", memberId: "a" } }) }), 400);
    const lead = store.createMember({ projectId, name: "총괄", handle: "lead", kind: "conductor" });
    status(() => store.listMessagePage(projectId, { scope: { kind: "member", memberId: lead.id }, cursor: cursor({ ...valid, scope: { kind: "member", memberId: lead.id } }) }), 409, "MESSAGE_SCOPE_CHANGED");
  });

  test("archive 읽기·around·단건은 부작용이 없고 legacy rowid 순서는 유지", () => {
    const { store, projectId, events } = fixture();
    for (let i = 204; i >= 0; i--) store.createMessage({ id: `m${String(i).padStart(3, "0")}`, projectId, at: "at", kind: "알림" });
    expect(store.listMessages(projectId, { limit: 2 }).map((m) => m.id)).toEqual(["m001", "m000"]);
    expect(store.projectState(projectId).messages).toHaveLength(200);
    expect(store.listMessagePage(projectId, { limit: 2 }).items.map((m) => m.id)).toEqual(["m203", "m204"]);
    expect(store.listMessagesAround(projectId, "m100", 5).map((m) => m.id)).toEqual(["m098", "m099", "m100", "m101", "m102"]);
    status(() => store.listMessagesAround("hq", "m100"), 404);
    status(() => store.listMessagesAround(projectId, "missing"), 404);
    status(() => store.archiveState(projectId), 404);
    store.patchProject(projectId, { archived: true });
    events.length = 0;
    expect(store.archiveState(projectId).project.archived).toBe(true);
    expect(store.listArchiveMessagePage(projectId).items).toHaveLength(200);
    expect(store.requireMessage("m000").projectId).toBe(projectId);
    status(() => store.listMessagePage(projectId), 404);
    status(() => store.listArchiveMessagePage("hq"), 404);
    expect(events).toEqual([]);
  });

  test("100,000개에서 첫/깊은 페이지 모두 project/member/target 인덱스 seek", () => {
    const { store, db, projectId } = fixture();
    const insert = db.query("INSERT INTO messages (id, project_id, at, kind, member_id, target_member_id) VALUES (?, ?, ?, '알림', ?, ?)");
    db.transaction(() => { for (let i = 0; i < 100_000; i++) insert.run(`m${String(i).padStart(6, "0")}`, projectId, "same", i % 100 === 0 ? "sparse" : null, i % 151 === 0 ? "sparse" : null); })();
    const query = spyOn(db, "query");
    const scope: MessageScope = { kind: "member", memberId: "sparse" };
    const first = store.listMessagePage(projectId, { scope, limit: 10 });
    const second = store.listMessagePage(projectId, { scope, limit: 10, cursor: first.nextCursor! });
    store.listMessagePage(projectId, { limit: 10 });
    store.listMessagePage(projectId, { limit: 10, cursor: first.nextCursor ? cursor({ v: 1, projectId, scope: { kind: "project" }, before: { at: "same", id: "m090000" } }) : undefined });
    const sql = query.mock.calls.map((args) => args[0]).filter((sql) => sql.includes("LIMIT $limit"));
    query.mockRestore();
    expect(sql).toHaveLength(4);
    for (const statement of sql) {
      const params = { $project: projectId, $limit: 11, ...(statement.includes("$member") ? { $member: "sparse" } : {}), ...(statement.includes("$at") ? { $at: "same", $id: "m090000" } : {}) };
      const plan = db.query<{ detail: string }, typeof params>(`EXPLAIN QUERY PLAN ${statement}`).all(params).map((r) => r.detail).join("\n");
      if (statement.includes("$member")) {
        expect(plan).toContain("messages_member_page");
        expect(plan).toContain("messages_target_page");
      } else expect(plan).toContain("messages_project_page");
      if (statement.includes("$at")) expect(plan).toContain("(at,id)<(?,?)");
    }
    expect(first.items).toHaveLength(10);
    expect(second.items).toHaveLength(10);
    expect(new Set([...first.items, ...second.items].map((m) => m.id)).size).toBe(20);
  });
});
