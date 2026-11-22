import { Database } from "bun:sqlite";
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { ensureFileVersionSchema, openDb } from "../server/db.ts";
import { Store } from "../server/store.ts";

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

describe("0.2.10 자료 판 색인(files_revisions)", () => {
  test("같은 이름의 부분 색인이 남은 DB 도 다시 열면 덮는 색인으로 바뀌고 한 건 조회·올리기가 된다", () => {
    const dir = mkdtempSync(join(tmpdir(), "iamceo-w11-index-")); dirs.push(dir);
    const path = join(dir, "iamceo.db");
    const first = openDb(path);
    first.exec("DROP INDEX files_revisions");
    first.exec("CREATE INDEX files_revisions ON files(project_id, id, replaces, replaced_by) WHERE replaces IS NOT NULL OR replaced_by IS NOT NULL");
    first.close();

    const db = openDb(path);
    try {
      const index = db.query("PRAGMA index_list(files)").all() as { name: string; partial: number }[];
      expect(index.find(i => i.name === "files_revisions")?.partial).toBe(0);
      const store = new Store(db, new Bus());
      const project = store.createProject({ name: "판 색인", cwd: "/private/tmp/iamceo-w11-index" });
      const file = store.createFile({ projectId: project.id, title: "결제 연동 설계", who: "결제 연동", body: "본문" });
      expect(store.getFile(file.id)?.id).toBe(file.id);
      expect(store.listFiles(project.id).map(f => f.id)).toEqual([file.id]);
    } finally {
      db.close();
    }
  });
  test("부분 색인을 지우지 못하면(다른 연결이 쓰는 중) 실패로 적고, Store 는 INDEXED BY 없이 표에서 읽어 한 건 조회·판 갈이가 된다", () => {
    const dir = mkdtempSync(join(tmpdir(), "iamceo-w11-index-")); dirs.push(dir);
    const path = join(dir, "iamceo.db");
    const db = openDb(path);
    const holder = new Database(path);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      db.exec("DROP INDEX files_revisions");
      db.exec("CREATE INDEX files_revisions ON files(project_id, id, replaces, replaced_by) WHERE replaces IS NOT NULL OR replaced_by IS NOT NULL");
      db.exec("PRAGMA busy_timeout = 50");
      holder.exec("BEGIN IMMEDIATE");
      expect(ensureFileVersionSchema(db)).toContain("files_revisions");
      expect(warn.mock.calls.some(call => String(call[0]).includes("files_revisions"))).toBe(true);
      holder.exec("ROLLBACK");
      const index = db.query("PRAGMA index_list(files)").all() as { name: string; partial: number }[];
      expect(index.find(i => i.name === "files_revisions")?.partial).toBe(1);

      const store = new Store(db, new Bus());
      expect((store as unknown as { revisionSource: string }).revisionSource).toBe("files");
      const project = store.createProject({ name: "판 색인 대체 길", cwd: "/private/tmp/iamceo-w11-index-fallback" });
      const first = store.createFile({ projectId: project.id, title: "결제 연동 설계 v1", who: "결제 연동", body: "1판" });
      const second = store.createFile({ projectId: project.id, title: "결제 연동 설계 v2", who: "결제 연동", body: "2판", replaces: first.id });
      expect(store.getFile(second.id)?.replaces).toBe(first.id);
      expect(store.getFile(first.id)?.replacedBy).toBe(second.id);
      expect(store.listFiles(project.id).map(f => f.id)).toEqual([second.id, first.id]);
    } finally {
      warn.mockRestore();
      holder.close();
      db.close();
    }
  });
});
