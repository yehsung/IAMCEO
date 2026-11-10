import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { createStorageReferences } from "../server/storage-maintenance.ts";
import { Store } from "../server/store.ts";
import { createIsolatedRuntime, type IsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const fixtures: { runtime: IsolatedRuntime; db: Database }[] = [];
afterEach(async () => {
  for (const { runtime, db } of fixtures.splice(0)) { db.close(); await runtime.stop(); }
});

// 실제로 실행된 문장을 센다. Store는 매번 db.query를 다시 읽으므로 원본 연결에 걸어 둔다.
function setup() {
  const runtime = createIsolatedRuntime();
  const db = openDb(join(runtime.paths.iamceoHome, "iamceo.db"));
  fixtures.push({ runtime, db });
  const executed: string[] = [];
  const query = db.query.bind(db);
  db.query = ((...args: Parameters<Database["query"]>) => {
    const statement = query(...args);
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (!["get", "all", "run"].includes(String(key))) return typeof value === "function" ? value.bind(target) : value;
      return (...params: unknown[]) => { executed.push(String(args[0])); return value.apply(target, params); };
    } });
  }) as Database["query"];
  const store = new Store(db, new Bus());
  // 운영에서는 오케스트레이터가 실행 상황을 준다. 없으면 전달마다 실행 기록을 따로 센다.
  store.setDeliveryWaitContext(() => ({ busy: false, waking: false, used: 0 }), () => {});
  const project = store.createProject({ name: "읽기 시험", cwd: runtime.paths.work });
  const member = store.createMember({ projectId: project.id, name: "직원", handle: "worker", kind: "worker", origin: "manual" });
  const measure = <T>(read: () => T): { result: T; sql: string[] } => {
    executed.length = 0;
    const result = read();
    return { result, sql: executed.splice(0) };
  };
  return { runtime, db, store, project, member, measure };
}

function seedMessages(f: ReturnType<typeof setup>, count: number, file?: { id: string }): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const body = file && i % 7 === 0 ? `자료 [보기](#/p/${f.project.id}/files/${file.id})` : `글 ${i}`;
    const message = f.store.createMessage({ projectId: f.project.id, who: "대표", kind: "나", mine: true, body, targetMemberId: f.member.id, delivery: "queued" });
    // 전달 대기 중인 글은 글마다 대기 사유까지 계산한다.
    if (i % 5 === 0) f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "user_message", text: body, refType: "message", refId: message.id });
    ids.push(message.id);
  }
  return ids;
}

test("대화 페이지·목록·주변 조회는 글 수가 늘어도 쿼리 수가 늘지 않는다", () => {
  const f = setup();
  const file = f.store.createFile({ projectId: f.project.id, title: "자료", body: "본문" });
  const ids = seedMessages(f, 60, file);
  const page30 = f.measure(() => f.store.listMessagePage(f.project.id, { limit: 30 }));
  const page60 = f.measure(() => f.store.listMessagePage(f.project.id, { limit: 60 }));
  expect(page60.result.items).toHaveLength(60);
  // 글마다 묻는 것은 본문 속 자료 링크의 소속 확인뿐이다(링크가 있는 글에만).
  const links = (sql: string[]) => sql.filter(text => text === "SELECT project_id FROM files WHERE id = ?").length;
  expect(page60.sql.length - links(page60.sql)).toBe(page30.sql.length - links(page30.sql));
  expect(page60.sql.length).toBeLessThan(40);
  expect(page60.sql.some(text => text.includes("FROM report_references WHERE project_id = ? AND corrects_message_id"))).toBe(false);
  expect(page60.sql.some(text => text.includes("FROM deliveries WHERE ref_type = 'message' AND ref_id = ?"))).toBe(false);

  const list = f.measure(() => f.store.listMessages(f.project.id, { limit: 60 }));
  expect(list.sql.length).toBeLessThan(40);
  const around = f.measure(() => f.store.listMessagesAround(f.project.id, ids[30]!, 41));
  expect(around.result.map(message => message.id)).toEqual(ids.slice(10, 51));
  expect(around.sql.length).toBeLessThan(40);

  // 스냅샷 안팎의 결과는 같아야 한다(단건 조회는 스냅샷을 쓰지 않는다).
  const single = ids.map(id => f.store.getMessage(id)!);
  expect(page60.result.items).toEqual(single);
  expect(list.result).toEqual(single);
  expect(around.result).toEqual(single.slice(10, 51));
  expect(single.filter(message => message.deliveryInfo?.length)).toHaveLength(12);
  expect(single.filter(message => message.fileIds?.includes(file.id))).toHaveLength(9);
});

test("빈 대화와 몇 건뿐인 대화도 단건 조회와 같은 결과를 낸다", () => {
  const f = setup();
  const empty = f.measure(() => f.store.listMessagePage(f.project.id, { limit: 5 }));
  expect(empty.result).toMatchObject({ items: [], hasOlder: false, nextCursor: null });
  expect(empty.sql.some(text => text.includes("FROM deliveries WHERE project_id"))).toBe(false);
  const ids = seedMessages(f, 5);
  const page = f.store.listMessagePage(f.project.id, { limit: 3 });
  expect(page.items).toEqual(ids.slice(2).map(id => f.store.getMessage(id)!));
  expect(page.hasOlder).toBe(true);
  expect(f.store.listMessages(f.project.id, { limit: 2 })).toEqual(ids.slice(3).map(id => f.store.getMessage(id)!));
  // 스냅샷 안에서 쓰기를 막는 보호가 조회 뒤에 남지 않는다.
  expect(f.store.createMessage({ projectId: f.project.id, who: "대표", kind: "나", mine: true, body: "다음 글" }).body).toBe("다음 글");
});

test("자료 목록·단건·상태 조회는 아티팩트 원본(html)을 읽지 않는다", () => {
  const f = setup();
  const html = `<p>${"원본".repeat(2000)}</p>`;
  const artifact = f.store.createFile({ projectId: f.project.id, title: "아티팩트", kind: "artifact", html, summary: "요약" });
  const plain = f.store.createFile({ projectId: f.project.id, title: "문서", body: "본문" });
  const message = f.store.createMessage({ projectId: f.project.id, who: "직원", kind: "완료", memberId: f.member.id, body: `[보기](#/p/${f.project.id}/files/${artifact.id})` });
  const reads = f.measure(() => ({
    list: f.store.listFiles(f.project.id), one: f.store.getFile(artifact.id), state: f.store.projectState(f.project.id), linked: f.store.getMessage(message.id),
  }));
  const fileReads = reads.sql.filter(text => /\bFROM files\b/.test(text));
  expect(fileReads.length).toBeGreaterThan(0);
  for (const text of fileReads) {
    expect(text).not.toContain("*");
    expect(text).not.toMatch(/\bhtml\b/);
  }
  expect(reads.result.list.map(file => file.id)).toEqual([plain.id, artifact.id]);
  expect(reads.result.one).toEqual(artifact);
  expect(reads.result.one).toMatchObject({ kind: "artifact", title: "아티팩트", summary: "요약", projectId: f.project.id, attachments: [] });
  expect(reads.result.state.files).toEqual(reads.result.list);
  expect(reads.result.linked!.fileIds).toEqual([artifact.id]);
  expect(JSON.stringify(reads.result)).not.toContain("원본원본");
  // 원본은 전용 조회로만 나온다.
  expect(f.store.getFileHtml(artifact.id)).toBe(html);
  expect(f.store.getFileHtml(plain.id)).toBeNull();
});

test("다른 프로젝트나 없는 자료를 가리키는 링크·보고 출처는 여전히 거부된다", () => {
  const f = setup();
  const other = f.store.createProject({ name: "다른 곳", cwd: f.runtime.paths.work });
  const foreign = f.store.createFile({ projectId: other.id, title: "남의 자료", body: "본문" });
  const message = f.store.createMessage({ projectId: f.project.id, who: "직원", kind: "완료", memberId: f.member.id,
    body: `[남](#/p/${f.project.id}/files/${foreign.id}) [없음](#/p/${f.project.id}/files/missing)` });
  expect(f.store.getMessage(message.id)!.fileIds).toEqual([]);
  for (const fileId of [foreign.id, "missing"]) {
    expect(() => f.store.saveReportReferences(f.project.id, { sourceMessageId: message.id, correctsMessageId: null, fileIds: [fileId], decisionIds: [], authoredAt: message.at, sequence: 1 })).toThrow("자료의 프로젝트가 다릅니다");
  }
});

test("전달 복구 목록은 전달마다 다시 묻지 않고 한 번에 읽는다", () => {
  const f = setup();
  const other = f.store.createProject({ name: "다른 곳", cwd: f.runtime.paths.work });
  const outsider = f.store.createMember({ projectId: other.id, name: "다른 직원", handle: "other", kind: "worker", origin: "manual" });
  for (let i = 0; i < 6; i++) f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: `지시 ${i}` });
  f.store.enqueue({ projectId: other.id, memberId: outsider.id, kind: "instruction", text: "다른 지시" });
  const first = f.store.listDeliveries(f.project.id)[0]!;
  const recovery = f.store.getDeliveryRecovery(first.id)!;
  f.store.updateDeliveryRecovery(first.id, recovery.version, { phase: "checking", reason: "unknown_result", evidence: { note: "증거" } as never });
  const all = f.measure(() => f.store.listDeliveryRecoveries());
  expect(all.sql).toHaveLength(1);
  expect(all.result).toEqual(f.store.listDeliveries().map(delivery => f.store.getDeliveryRecovery(delivery.id)!));
  expect(all.result).toHaveLength(7);
  expect(all.result[0]).toMatchObject({ deliveryId: first.id, phase: "checking", reason: "unknown_result" });
  const own = f.measure(() => f.store.listDeliveryRecoveries(other.id));
  expect(own.sql).toHaveLength(1);
  expect(own.result).toEqual(f.store.listDeliveries(other.id).map(delivery => f.store.getDeliveryRecovery(delivery.id)!));
  expect(own.result).toHaveLength(1);
});

test("첨부 참조 검사는 프로젝트마다 읽기 스냅샷을 한 번만 싣고, 오래된 대화의 참조도 찾는다", () => {
  const f = setup();
  const inbox = join(f.runtime.paths.iamceoHome, "inbox");
  const references = createStorageReferences(f.store, inbox);
  const kept = { id: "a_keptAttachment01", name: "kept.png", mime: "image/png", size: 1, path: join(f.runtime.paths.iamceoHome, "uploads", "a_keptAttachment01", "kept.png") };
  const orphan = { id: "a_orphanAttachment", name: "orphan.png", mime: "image/png", size: 1, path: join(f.runtime.paths.iamceoHome, "uploads", "a_orphanAttachment", "orphan.png") };
  f.store.createMessage({ projectId: f.project.id, who: "대표", kind: "나", mine: true, body: `첨부 ${kept.path}` });
  seedMessages(f, 450);
  const projects = f.store.listProjects({ includeArchived: true }).length;
  const scan = f.measure(() => references.isReferenced(orphan));
  expect(scan.result).toBe(false);
  // 200개씩 세 쪽을 넘겨도 프로젝트의 전달 전체는 한 번만 읽는다.
  expect(scan.sql.filter(text => text === "SELECT * FROM deliveries WHERE project_id = ? ORDER BY rowid")).toHaveLength(projects);
  expect(scan.sql.filter(text => text.includes("FROM messages WHERE project_id = $project")).length).toBeGreaterThanOrEqual(3);
  expect(scan.sql.some(text => text === "SELECT * FROM delivery_recovery WHERE delivery_id = ?")).toBe(false);
  expect(references.isReferenced(kept)).toBe(true);
  // 검사 뒤에도 쓰기는 그대로 된다.
  f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: `첨부: ${orphan.path}`, status: "held", holdReason: "delivery_unknown" });
  expect(references.isReferenced(orphan)).toBe(true);
});
