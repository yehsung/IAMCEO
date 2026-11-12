// 보관한 프로젝트 지우기(DELETE /api/projects/:id)와 프로젝트 내보내기(GET /api/projects/:id/export) — B5.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile, type Config } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import type { OrchestratorApi } from "../server/orchestrator-api.ts";
import { Store } from "../server/store.ts";
import type { Attachment } from "../shared/types.ts";

const CODE = "delete-export-fixture-code";
const at = "2026-11-01T00:00:00.000Z";
let home: string, config: Config, store: Store, bus: Bus, server: RunningServer, base: string;
let archivedId: string, activeId: string, leadId: string, workerId: string, otherId: string;
let only: Attachment, shared: Attachment;
const events: string[] = [];
const headers = { Authorization: `Bearer ${CODE}` };

function attachment(id: string, name: string, bytes: string): Attachment {
  const path = join(config.uploadsDir, `${id}-${name}`);
  writeFileSync(path, bytes, { mode: 0o600 });
  return store.createAttachment({ id, name, mime: "text/plain", size: Buffer.byteLength(bytes), path });
}

function unzip(file: string, ...args: string[]): string {
  const result = Bun.spawnSync(["/usr/bin/unzip", ...args, file], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString());
  return result.stdout.toString();
}
function entry(file: string, name: string): string {
  const result = Bun.spawnSync(["/usr/bin/unzip", "-p", file, name], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

beforeAll(async () => {
  home = mkdtempSync("/private/tmp/iamceo-delete-export-");
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: CODE, hosts: ["127.0.0.1"] }, env);
  config = loadConfig(env);
  bus = new Bus();
  store = new Store(openDb(config.dbPath), bus);
  const orch = new Proxy({}, { get: (_target, key) => () => { throw new Error(`delete/export must not call the orchestrator (${String(key)})`); } }) as OrchestratorApi;
  server = await startServer({ config, store, bus, orch });
  base = `http://127.0.0.1:${server.port}`;

  archivedId = store.createProject({ name: "지울 프로젝트", cwd: home, runnerEnabled: false }).id;
  activeId = store.createProject({ name: "남을 프로젝트", cwd: home, runnerEnabled: false }).id;
  leadId = store.createMember({ projectId: archivedId, handle: "lead", name: "지울 총괄", kind: "conductor" }).id;
  workerId = store.createMember({ projectId: archivedId, handle: "worker", name: "지울 팀장", kind: "worker" }).id;
  otherId = store.createMember({ projectId: activeId, handle: "lead", name: "남을 총괄", kind: "conductor" }).id;
  only = attachment("att_only", "only.txt", "지울 프로젝트만 가리키는 첨부");
  shared = attachment("att_shared", "shared.txt", "두 프로젝트가 함께 가리키는 첨부");
  store.createMessage({ projectId: archivedId, mine: true, who: "대표", kind: "나", body: "첫 지시", attachments: [only, shared] });
  for (let i = 0; i < 30; i++) store.createMessage({ projectId: archivedId, memberId: workerId, who: "지울 팀장", kind: "알림", body: `보고 ${i}` });
  const decision = store.createDecision({ projectId: archivedId, memberId: workerId, who: "지울 팀장", title: "고를 것", images: [only] });
  store.createTodo({ projectId: archivedId, title: "대표 할 일" });
  store.createFile({ projectId: archivedId, title: "보고서", kind: "artifact", html: "<h1>아티팩트</h1>", body: "" });
  store.createMessage({ projectId: activeId, mine: true, who: "대표", kind: "나", body: "같은 첨부", attachments: [shared] });
  for (let i = 0; i < 1_100; i++) store.createMessage({ id: `bulk_${String(i).padStart(4, "0")}`, projectId: activeId, memberId: otherId, who: "남을 총괄", kind: "알림", body: `기록 ${i}`, at: `2026-11-02T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0").slice(-3)}Z` });
  // 프로젝트에 외래 키로 묶이지 않은 기록도 남겨 둔다.
  const db = store.db;
  db.query("INSERT INTO deliveries (id,project_id,member_id,kind,text,status,created_at) VALUES ('dl_a',?,?,'message','지시','held',?)").run(archivedId, workerId, at);
  db.query("INSERT INTO delivery_recovery (delivery_id,updated_at) VALUES ('dl_a',?)").run(at);
  db.query("INSERT INTO activity (member_id,at,kind,text) VALUES (?,?,'tool','기록')").run(workerId, at);
  db.query(`INSERT INTO operation_receipts (operation_id,kind,project_id,member_id,status,request_json,result_json,created_at,updated_at)
    VALUES ('op_a','settings',NULL,?,'applied','{}','{}',?,?)`).run(workerId, at, at);
  db.query("INSERT INTO agent_operation_receipts (operation_id,member_id,project_id,tool_name,request_json,result_json,created_at) VALUES ('ag_a',?,?,'post','{}','{}',?)").run(workerId, archivedId, at);
  db.query("INSERT INTO push_events (id,source_key,kind,project_id,member_id,target,occurred_at,expires_at) VALUES ('pe_a','src_a','decision',?,?,'{}',?,?)").run(archivedId, workerId, at, at);
  db.query("INSERT INTO lifecycle_journal (operation_id,member_id,project_id,intent,phase,generation,terminal_identity_json,created_at,updated_at) VALUES ('lj_a',?,?,'archive','confirmed',0,'{}',?,?)").run(workerId, archivedId, at, at);
  db.query("INSERT INTO execution_journal (run_id,member_id,project_id,generation,terminal_identity_json,phase,created_at,updated_at) VALUES ('ej_a',?,?,0,'{}','ended',?,?)").run(workerId, archivedId, at, at);
  db.query("INSERT INTO member_session_history (id,member_id,cli,generation,archived_at,reason) VALUES ('msh_a',?,'claude',0,?,'fixture')").run(workerId, at);
  db.query("INSERT INTO decision_close_audit (decision_id,answered_decision_id,actor_id,answer_quote,created_at) VALUES (?,?,'lead','원문',?)").run(decision.id, decision.id, at);
  store.trustProjectFolder(archivedId, home);
  store.setRestartWake(workerId, { generation: 0, reason: "holder_lost", lostAt: at, state: "pending", attempts: 0, runIds: [], resumeId: null });
  mkdirSync(join(config.inboxDir, workerId), { recursive: true });
  writeFileSync(join(config.inboxDir, workerId, "att_only-only.txt"), "팀장에게 건넨 파일");
  mkdirSync(join(home, "run"), { recursive: true });
  for (const name of [`${workerId}.rules.md`, `${workerId}.mcp.json`, `${otherId}.rules.md`]) writeFileSync(join(home, "run", name), "{}");
  store.patchProject(archivedId, { archived: true });
  bus.subscribe(event => events.push(event.type));
});

afterAll(async () => { await server.stop(); store.db.close(); rmSync(home, { recursive: true, force: true }); });

async function download(projectId: string): Promise<string> {
  const response = await fetch(`${base}/api/projects/${projectId}/export`, { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/zip");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''IAMCEO-");
  const bytes = Buffer.from(await response.arrayBuffer());
  // 흘려 보내는 응답이라 길이 머리글은 빠질 수 있다. 있으면 맞아야 한다.
  const length = response.headers.get("content-length");
  if (length !== null) expect(bytes.length).toBe(Number(length));
  expect(bytes.length).toBeGreaterThan(22);
  const file = join(home, `${projectId}.zip`);
  writeFileSync(file, bytes);
  return file;
}

describe("프로젝트 내보내기", () => {
  test("대화·결재·할 일·업무·자료와 첨부 원본이 zip 하나에. 접속 코드·팀장 열쇠는 없다", async () => {
    const file = await download(archivedId);
    expect(unzip(file, "-tq")).toContain("No errors");
    expect(unzip(file, "-Z1").trim().split("\n").sort()).toEqual([
      "README.txt", "attachments/att_only-only.txt", "attachments/att_shared-shared.txt", "decisions.json", "files.json", "manifest.json",
      "members.json", "messages.json", "project.json", "todos.json", "work.json"].sort());
    const messages = JSON.parse(entry(file, "messages.json")) as { body: string }[];
    expect(messages).toHaveLength(31);
    expect(messages[0]!.body).toBe("첫 지시");
    expect(JSON.parse(entry(file, "files.json"))[0]).toMatchObject({ title: "보고서", html: "<h1>아티팩트</h1>" });
    expect(JSON.parse(entry(file, "decisions.json"))[0]).toMatchObject({ title: "고를 것" });
    expect(entry(file, "attachments/att_only-only.txt")).toBe("지울 프로젝트만 가리키는 첨부");
    expect(JSON.parse(entry(file, "manifest.json"))).toMatchObject({ format: 1, project: { id: archivedId, archived: true },
      counts: { messages: 31, decisions: 1, todos: 1, files: 1, attachments: 2 }, missingAttachments: [] });
    const raw = readFileSync(file).toString("latin1") + readFileSync(file).toString("utf8");
    for (const secret of [CODE, store.getMemberToken(leadId), store.getMemberToken(workerId)]) expect(raw).not.toContain(secret);
    // 임시 파일은 응답과 함께 사라진다.
    expect(readdirSync(join(home, "exports"))).toEqual([]);
  });

  test("큰 대화도 순서대로 흘려 쓴다", async () => {
    const file = await download(activeId);
    const messages = JSON.parse(entry(file, "messages.json")) as { id: string }[];
    expect(messages).toHaveLength(1_101);
    const ids = messages.map(message => message.id);
    expect(ids.filter(id => id.startsWith("bulk_"))).toHaveLength(1_100);
    expect(JSON.parse(entry(file, "manifest.json")).counts.messages).toBe(1_101);
  });

  test("이 Mac 밖(대리 전달)에서 온 요청은 받지 않는다", async () => {
    const response = await fetch(`${base}/api/projects/${archivedId}/export`, { headers: { ...headers, "X-Forwarded-For": "100.64.0.9" } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "LOCAL_ONLY" });
    expect((await fetch(`${base}/api/projects/${archivedId}/export`)).status).toBe(401);
    expect((await fetch(`${base}/api/projects/nope/export`, { headers })).status).toBe(404);
  });
});

describe("보관한 프로젝트 지우기", () => {
  test("보관하지 않은 프로젝트·본사·없는 프로젝트는 지우지 않는다", async () => {
    for (const id of [activeId, "hq"]) {
      const response = await fetch(`${base}/api/projects/${id}`, { method: "DELETE", headers });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "project_not_archived" });
    }
    expect((await fetch(`${base}/api/projects/nope`, { method: "DELETE", headers })).status).toBe(404);
    expect(store.getProject(activeId)).not.toBeNull();
  });

  test("한 번에 지우고, 다른 프로젝트가 가리키는 첨부와 그 프로젝트의 기록은 남긴다", async () => {
    const seq = bus.seq;
    const response = await fetch(`${base}/api/projects/${archivedId}`, { method: "DELETE", headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: archivedId, deleted: true, removedAttachments: 1 });
    expect(bus.seq).toBeGreaterThan(seq);
    expect(events).toContain("projects");
    const db = store.db;
    // 프로젝트·팀장 ID 를 가진 행이 어느 표에도 남지 않는다.
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'file_search_fts%'").all().map(row => row.name);
    for (const table of tables) {
      const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(column => column.name);
      if (columns.includes("project_id")) expect(db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(archivedId)).toEqual({ n: 0 });
      if (columns.includes("member_id")) expect(db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE member_id IN (?, ?)`).get(leadId, workerId)).toEqual({ n: 0 });
    }
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(store.getAttachment("att_only")).toBeNull();
    expect(store.getAttachment("att_shared")).not.toBeNull();
    expect(existsSync(only.path)).toBe(false);
    expect(existsSync(shared.path)).toBe(true);
    expect(existsSync(join(config.inboxDir, workerId))).toBe(false);
    expect(readdirSync(join(home, "run"))).toEqual([`${otherId}.rules.md`]);
    expect(store.projectFolderTrusted(archivedId, home)).toBe(false);
    expect(store.getRestartWake(workerId)).toBeNull();
    // 남은 프로젝트는 그대로다.
    expect(db.query("SELECT COUNT(*) AS n FROM messages WHERE project_id = ?").get(activeId)).toEqual({ n: 1_101 });
    expect(store.listMembers(activeId).map(member => member.id)).toEqual([otherId]);
    expect(await (await fetch(`${base}/api/projects/archived`, { headers })).json()).toEqual([]);
    expect((await fetch(`${base}/api/projects/${archivedId}`, { method: "DELETE", headers })).status).toBe(404);
    expect((await fetch(`${base}/api/projects/${archivedId}/archive/state`, { headers })).status).toBe(404);
  });
});
