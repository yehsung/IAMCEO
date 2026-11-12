// E9: 오류와 보류 사유를 문장이 아니라 코드로 가른다.
// - 모든 ApiError 가 shared/error-codes.ts 의 코드를 갖고, 응답 몸에 { error, code } 로 실린다(error 문장은 그대로).
// - 앞머리로 판정하던 팀장 보류는 members.fence_code, 대표 글의 보류 메모는 messages.delivery_code 로 가른다.
//   두 열은 DB 판 번호를 올리지 않고 더하며, 이전 판 서버가 문장만 고친 행은 다시 열 때 문장에서 맞춘다.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { ERROR_CODES, isErrorCode } from "../shared/error-codes.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile, type Config } from "../server/config.ts";
import { ERROR_CODE_COLUMNS, MIGRATIONS, openDb } from "../server/db.ts";
import { CONTROL_UNKNOWN_NOTE, deliveryNoteCode, fenceCodeFromLegacyText, HOLD_NOTES, IMPORT_HOLD_NOTE, startingUnknownNote, stopCheckHeldNote, USAGE_WAIT_NOTE } from "../server/hold-codes.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import type { OrchestratorApi } from "../server/orchestrator-api.ts";
import { CoreError } from "../server/runner/core-client.ts";
import { ApiError, Store } from "../server/store.ts";

const ROOT = join(import.meta.dir, "..");
const dirs: string[] = [];
function tempDir(): string { const dir = mkdtempSync(join(tmpdir(), "iamceo-error-codes-")); dirs.push(dir); return dir; }
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".d.ts"))
    .map(e => join(e.parentPath, e.name));
}

describe("코드 목록", () => {
  test("모든 코드에 지금 한국어 문장이 짝지어 있고, en 은 칸만 있다", () => {
    for (const [code, text] of Object.entries(ERROR_CODES)) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$|^[A-Z][A-Z0-9_]*$/);
      expect((text as { ko: string }).ko.trim().length).toBeGreaterThan(0);
    }
    expect(isErrorCode("project_not_found")).toBe(true);
    expect(isErrorCode("toString")).toBe(false);
  });

  test("서버의 모든 new ApiError 가 코드 인자를 갖고, 글자로 쓴 코드는 목록에 있다", () => {
    const missing: string[] = [], unknown: string[] = [];
    for (const file of [...sourceFiles("server"), ...sourceFiles("bin")]) {
      const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isNewExpression(node) && node.expression.getText() === "ApiError") {
          const where = `${file.slice(ROOT.length + 1)}:${src.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
          const code = node.arguments?.[2];
          if (!code) missing.push(where);
          else if (ts.isStringLiteral(code) && !isErrorCode(code.text)) unknown.push(`${where} ${code.text}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(src);
    }
    expect(missing).toEqual([]);
    expect(unknown).toEqual([]);
  });

  test("이미 내보낸 코드는 이름 그대로 남아 있다(출시된 앱이 이 이름으로 가른다)", () => {
    for (const code of ["STARTING", "LOCAL_ONLY", "LOCAL_FILE_NOT_FOUND", "TERMINAL_REFUSED", "TERMINAL_GONE", "MESSAGE_SCOPE_CHANGED",
      "OPERATION_CONFLICT", "REVISION_CONFLICT", "INVALID_MESSAGE_PAGE_QUERY", "project_not_archived", "export_too_large"]) expect(isErrorCode(code)).toBe(true);
  });
});

describe("HTTP 오류 응답", () => {
  const CODE = "error-codes-fixture-code";
  let config: Config, store: Store, server: RunningServer, base: string;
  const headers = { Authorization: `Bearer ${CODE}` };
  beforeAll(async () => {
    const home = tempDir();
    const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
    updateConfigFile({ accessCode: CODE, hosts: ["127.0.0.1"] }, env);
    config = loadConfig(env);
    const bus = new Bus();
    store = new Store(openDb(config.dbPath), bus);
    const orch = new Proxy({}, { get: (_t, key) => () => { throw new ApiError(409, `시험용 거절 ${String(key)}`, "TERMINAL_REFUSED", "core_terminal_missing"); } }) as OrchestratorApi;
    server = await startServer({ config, store, bus, orch });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(async () => { await server?.stop(); });

  test("ApiError 는 문장(error)과 코드(code)를 함께 싣는다", async () => {
    const res = await fetch(`${base}/api/projects/nope/state`, { headers });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "프로젝트를 찾을 수 없습니다", code: "project_not_found" });
  });

  test("없는 경로·허용되지 않는 메서드·잘못된 본문에도 코드가 있다", async () => {
    const missing = await fetch(`${base}/api/no-such-route`, { headers });
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe("route_not_found");
    const method = await fetch(`${base}/api/projects`, { method: "PUT", headers });
    expect(method.status).toBe(405);
    expect((await method.json()).code).toBe("method_not_allowed");
    const body = await fetch(`${base}/api/projects`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{" });
    expect(body.status).toBe(400);
    expect(await body.json()).toEqual({ error: "JSON 본문이 필요합니다", code: "invalid_json" });
  });

  test("코드가 없던 두 응답(실시간 연결 주소의 접속 코드, 팀장 통로의 틀린 토큰)에도 코드가 있고, fail() 은 코드 없이 부를 수 없다", async () => {
    const ws = await fetch(`${base}/ws?v=2&t=${CODE}`, { headers });
    expect(ws.status).toBe(400);
    expect(await ws.json()).toEqual({ error: "실시간 연결 주소에 접속 코드를 넣지 마세요", code: "realtime_code_in_url" });
    const agent = await fetch(`${base}/agent/tool`, { method: "POST", headers: { Authorization: "Bearer not-a-member-token", "Content-Type": "application/json" }, body: "{}" });
    expect(agent.status).toBe(401);
    expect(await agent.json()).toEqual({ error: "인증이 필요합니다", code: "agent_token_invalid" });
    // 원문 검사: http.ts 의 모든 fail(…) 호출이 코드(세 번째 인자)를 갖는다. 글자로 쓴 코드는 목록에 있다.
    const file = join(ROOT, "server/http.ts");
    const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const missing: string[] = [], unknown: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fail") {
        const where = `http.ts:${src.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        const code = node.arguments[2];
        if (!code) missing.push(where);
        else if (ts.isStringLiteral(code) && !isErrorCode(code.text)) unknown.push(`${where} ${code.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(src);
    expect(missing).toEqual([]);
    expect(unknown).toEqual([]);
  });

  test("넓은 옛 코드 아래의 좁은 사유는 reason 으로 더해진다", async () => {
    const id = store.createProject({ name: "터미널", cwd: tempDir(), runnerEnabled: false }).id;
    const member = store.createMember({ projectId: id, handle: "worker", name: "결제 연동", kind: "worker" });
    const res = await fetch(`${base}/api/members/${member.id}/terminal/control`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ action: "claim" }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("TERMINAL_REFUSED");
    expect(body.reason).toBe("core_terminal_missing");
    expect(body.error).toStartWith("시험용 거절");
  });
});

function fixtureStore(path = ":memory:") {
  const bus = new Bus();
  const store = new Store(openDb(path), bus);
  const project = store.createProject({ name: "보류", cwd: "/fixture", runnerEnabled: false });
  const member = store.createMember({ projectId: project.id, handle: "worker", name: "결제 연동", kind: "worker" });
  return { store, project, member };
}

describe("팀장 보류 코드(members.fence_code)", () => {
  test("lastError 와 함께 코드를 쓰고, 다른 글로 덮이면 코드도 지운다", () => {
    const { store, member } = fixtureStore();
    expect(store.patchMember(member.id, { lastError: CONTROL_UNKNOWN_NOTE, fenceCode: "control_unknown" }).fenceCode).toBe("control_unknown");
    // 다른 칸만 바꾸면 보류는 그대로다.
    expect(store.patchMember(member.id, { now: "다른 일" }).fenceCode).toBe("control_unknown");
    // 문장(표시용)을 다듬어도 동작은 코드로 갈린다: 같은 코드면 문장과 상관없이 보류다.
    expect(store.patchMember(member.id, { lastError: "병렬 설정 결과 모름", fenceCode: "control_unknown" }).fenceCode).toBe("control_unknown");
    // 보류가 아닌 글로 덮이면(예전 앞머리 판정이 거짓이 되는 경우) 코드도 없어진다.
    const cleared = store.patchMember(member.id, { lastError: "턴 오류" });
    expect(cleared.fenceCode).toBeUndefined();
    expect(cleared.lastError).toBe("턴 오류");
  });

  test("코드가 없는 행에 lastError 를 null 로 다시 써도 행을 바꾸지 않는다(쓸데없는 방송이 없다)", () => {
    const { store, member } = fixtureStore();
    const before = store.requireMember(member.id);
    expect(store.patchMember(member.id, { lastError: null })).toEqual(before);
  });

  test("문장 모양은 이전 판 서버의 앞머리 판정과 같다(되돌려도 옛 서버가 같은 보류로 읽는다)", () => {
    expect(fenceCodeFromLegacyText(CONTROL_UNKNOWN_NOTE)).toBe("control_unknown");
    expect(fenceCodeFromLegacyText(startingUnknownNote("x".repeat(900)))).toBe("starting_unknown");
    expect(startingUnknownNote("x".repeat(900)).length).toBe("starting_unknown: ".length + 500);
    expect(fenceCodeFromLegacyText(stopCheckHeldNote("응답 없음"))).toBe("stop_check_held");
    expect(fenceCodeFromLegacyText("core 재연결 보류: 읽기 재결합을 지원하지 않습니다")).toBe("core_reconnect_held");
    expect(fenceCodeFromLegacyText(USAGE_WAIT_NOTE)).toBe("usage_wait");
    expect(fenceCodeFromLegacyText(`${USAGE_WAIT_NOTE}.`)).toBeNull();
    expect(fenceCodeFromLegacyText("턴 오류: control_unknown: 아님")).toBeNull();
  });
});

describe("대표 글의 보류 코드(messages.delivery_code)", () => {
  test("정해진 보류 문장이면 코드를 함께 쓰고, 다른 상태로 바뀌면 코드도 바뀐다", () => {
    const { store, project } = fixtureStore();
    const message = store.createMessage({ projectId: project.id, mine: true, who: "나", kind: "나", body: "지시", delivery: "queued" });
    expect(message.deliveryCode).toBeUndefined();
    const held = store.setMessageDelivery(message.id, "held", HOLD_NOTES.delivery_unknown!);
    expect(held).toMatchObject({ delivery: "held", deliveryNote: HOLD_NOTES.delivery_unknown, deliveryCode: "held_delivery_unknown" });
    expect(store.setMessageDelivery(message.id, "queued").deliveryCode).toBeUndefined();
    expect(store.setMessageDelivery(message.id, "failed", "결제 연동이 닫혔습니다").deliveryCode).toBeUndefined();
    const imported = store.createMessage({ projectId: project.id, mine: true, who: "나", kind: "나", body: "가져온 말", delivery: "held", deliveryNote: IMPORT_HOLD_NOTE });
    expect(imported.deliveryCode).toBe("held_import");
  });

  test("보류 사유마다 코드가 있고 코드는 목록에 있다", () => {
    for (const [reason, note] of Object.entries(HOLD_NOTES)) {
      const code = deliveryNoteCode(note);
      expect(code).toBe(`held_${reason}` as never);
      expect(isErrorCode(code)).toBe(true);
    }
    expect(deliveryNoteCode(null)).toBeNull();
    expect(deliveryNoteCode("자유 문장")).toBeNull();
  });
});

describe("판 번호를 올리지 않는 열과 되돌린 뒤 다시 올리기", () => {
  test("이전 판 DB 에 열만 더하고 판 번호는 그대로다(이전 판 서버가 그대로 연다)", () => {
    const path = join(tempDir(), "old.db");
    const old = new Database(path, { create: true });
    old.exec("PRAGMA journal_mode = WAL");
    for (let v = 0; v < MIGRATIONS.length; v++) { old.exec(MIGRATIONS[v]!); old.exec(`PRAGMA user_version = ${v + 1}`); }
    old.close();
    const db = openDb(path);
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(MIGRATIONS.length);
    for (const [table, column] of ERROR_CODE_COLUMNS) {
      expect(db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some(c => c.name === column)).toBe(true);
    }
    db.close();
    // 두 번 열어도 같다.
    openDb(path).close();
  });

  test("이전 판 서버가 문장만 바꾼 행은 다시 열 때 문장에서 코드를 맞춘다", () => {
    const path = join(tempDir(), "rollback.db");
    const { store, project, member } = fixtureStore(path);
    const other = store.createMember({ projectId: project.id, handle: "other", name: "로그인 화면", kind: "worker" });
    store.patchMember(member.id, { lastError: CONTROL_UNKNOWN_NOTE, fenceCode: "control_unknown" });
    const message = store.createMessage({ projectId: project.id, mine: true, who: "나", kind: "나", body: "지시", delivery: "queued" });
    store.setMessageDelivery(message.id, "held", HOLD_NOTES.delivery_unknown!);
    const stale = store.createMessage({ projectId: project.id, mine: true, who: "나", kind: "나", body: "옛 서버가 보류한 글", delivery: "queued" });
    // 이전 판 서버: 코드 열을 모른 채 문장만 고친다.
    store.db.query("UPDATE members SET last_error = NULL WHERE id = ?").run(member.id);
    store.db.query("UPDATE members SET last_error = ? WHERE id = ?").run("starting_unknown: 옛 서버가 남긴 보류", other.id);
    store.db.query("UPDATE messages SET delivery = 'delivered', delivery_note = NULL WHERE id = ?").run(message.id);
    store.db.query("UPDATE messages SET delivery = 'held', delivery_note = ? WHERE id = ?").run(HOLD_NOTES.delivery_unknown!, stale.id);
    store.db.close();
    const reopened = new Store(openDb(path), new Bus());
    expect(reopened.requireMember(member.id).fenceCode).toBeUndefined();
    expect(reopened.requireMember(other.id).fenceCode).toBe("starting_unknown");
    expect(reopened.getMessage(message.id)!.deliveryCode).toBeUndefined();
    expect(reopened.getMessage(stale.id)!.deliveryCode).toBe("held_delivery_unknown");
    reopened.db.close();
  });
});

describe("작업 영수증의 좁은 사유", () => {
  test("거절 영수증에 reason 을 저장하고 읽는다(옛 영수증에는 없다)", () => {
    const { store, project, member } = fixtureStore();
    const begin = (operationId: string) => store.beginOperation({ operationId, kind: "terminal_control", projectId: project.id, memberId: member.id, request: { operationId } });
    const receipt = begin("00000000-0000-4000-8000-000000000001");
    const refused = store.finishOperation({ ...receipt, status: "refused", code: "TERMINAL_REFUSED", error: "No core terminal for member", reason: "core_terminal_missing" } as never);
    expect(refused).toMatchObject({ status: "refused", code: "TERMINAL_REFUSED", reason: "core_terminal_missing" });
    const plain = begin("00000000-0000-4000-8000-000000000002");
    expect(store.finishOperation({ ...plain, status: "refused", code: "TERMINAL_REFUSED", error: "x" } as never)).not.toHaveProperty("reason");
  });

  test("실행 엔진의 터미널 거절은 문장과 함께 사유 코드를 갖는다", () => {
    const error = new CoreError("not_found", "No core terminal for member", false, "rejected", undefined, "core_terminal_missing");
    expect(error.reason).toBe("core_terminal_missing");
    const core = readFileSync(join(ROOT, "server/runner/core.ts"), "utf8");
    for (const [text, reason] of [["No core terminal for member", "core_terminal_missing"], ["A matching active terminal control lease is required", "core_lease_required"],
      ["Another terminal control lease is active", "core_lease_other"], ["Terminal has finished", "core_terminal_finished"]] as const) {
      const throws = core.split("\n").filter(line => line.includes(`"${text}"`) && line.includes("new CoreError("));
      expect(throws.length).toBeGreaterThan(0);
      for (const line of throws) expect(line).toContain(`"${reason}"`);
    }
  });
});
