// K(E2): 도구 승인을 결재함에서 답하기.
// 진짜 Claude Code 는 띄우지 않는다. 훅 스크립트는 CLI 가 하듯 /bin/sh -c 로 명령을 돌리고 표준 입력에 훅 JSON 을 넣어 확인한다.
// 서버 쪽은 임시 홈의 실제 DB·서버(127.0.0.1)로, 팀장 열쇠로 /agent/permission 을 부르고 대표 열쇠로 결재 답 경로를 부른다.
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile, VERSION } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer, type ServerContext } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { PushStore } from "../server/push/store.ts";
import { permissionHook, PERMISSION_HOOK_MARKER, PERMISSION_HOOK_TIMEOUT_SEC, TOOL_PERMISSION_TTL_MS } from "../server/runner/permission-hook.ts";
import { providerLaunch } from "../server/runner/providers.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult, StartOpts } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import { describeToolRequest, redactSecrets, ToolPermissions, type ToolPermissionDeps } from "../server/tool-permission.ts";
import type { Decision, Member } from "../shared/types.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const dirs: string[] = [];
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string { const dir = mkdtempSync(join(tmpdir(), "iamceo-toolperm-")); dirs.push(dir); return dir; }
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(5);
  expect(check()).toBe(true);
}

// ---- 요약과 가리기 ----
describe("요약: 무엇을 승인하는지, 비밀은 가리고 길면 자른다", () => {
  test("명령 실행은 명령을, 비밀로 보이는 값은 가린다", () => {
    const { action, target } = describeToolRequest("Bash", { command: "curl -H 'Authorization: Bearer abcdefghijklmnop1234' https://api.example.com && export OPENAI_API_KEY=sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA", description: "x" });
    expect(action).toBe("명령 실행");
    expect(target).toContain("curl -H");
    expect(target).not.toContain("abcdefghijklmnop1234");
    expect(target).not.toContain("sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA");
    expect(target).toContain("••••");
  });
  test("여러 비밀 모양을 가리고 평범한 경로·커밋 해시는 둔다", () => {
    const text = [
      "git push https://user:hunter2pass@github.com/a/b.git",
      "ghp_0123456789abcdefghijABCDEFGHIJ",
      "password: \"correct horse\"",
      "mysql --password=s3cretpw -u root",
      "AKIAABCDEFGHIJKLMNOP",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
      "git checkout 0123456789abcdef0123456789abcdef01234567",
      "/Users/someone/projects/very-long-folder-name/with/nested/paths/file.ts",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9eyJzdWIiOiIxMjM0NTY3ODkwIn0x",
    ].join("\n");
    const out = redactSecrets(text);
    for (const secret of ["hunter2pass", "ghp_0123456789", "correct horse", "s3cretpw", "AKIAABCDEFGHIJKLMNOP", "AAAA\n", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"]) expect(out).not.toContain(secret);
    expect(out).toContain("0123456789abcdef0123456789abcdef01234567");
    expect(out).toContain("/Users/someone/projects/very-long-folder-name/with/nested/paths/file.ts");
    expect(out).toContain("[가린 개인 키]");
  });
  test("파일 쓰기는 경로와 글자 수만, 내용은 싣지 않는다", () => {
    const { action, target } = describeToolRequest("Write", { file_path: "/tmp/a.env", content: "SECRET=abc\nmore" });
    expect(action).toBe("파일 쓰기");
    expect(target).toBe("/tmp/a.env (15자)");
    expect(describeToolRequest("Edit", { file_path: "/tmp/x.ts", old_string: "a", new_string: "b" })).toEqual({ action: "파일 고치기", target: "/tmp/x.ts" });
  });
  test("연결 도구·모르는 도구는 이름과 입력 요약, 긴 명령은 자른다", () => {
    expect(describeToolRequest("mcp__github__create_issue", { title: "t" }).action).toBe("연결 도구 쓰기(github)");
    expect(describeToolRequest("mcp__github__create_issue", { title: "t" }).target).toBe('create_issue {"title":"t"}');
    expect(describeToolRequest("Strange", { a: 1 })).toEqual({ action: "도구 쓰기(Strange)", target: '{"a":1}' });
    const long = describeToolRequest("Bash", { command: "echo " + "x".repeat(2000) }).target;
    expect(long.length).toBeLessThan(700);
    expect(long).toContain("자 더 있음");
    const lines = describeToolRequest("Bash", { command: Array.from({ length: 40 }, (_, i) => `echo ${i}`).join("\n") }).target;
    expect(lines).toContain("줄 더 있음");
  });
});

// ---- 카드와 기다림(ToolPermissions) ----
function storeFixture() {
  const dir = temp();
  const db = openDb(join(dir, "iamceo.db"));
  const store = new Store(db, new Bus());
  const project = store.createProject({ name: "도구 승인", cwd: dir });
  const member = store.createMember({ projectId: project.id, handle: "pay", name: "결제 연동", kind: "worker", cwd: dir, origin: "runner", backend: "core", status: "working", sessionId: randomUUID(), paneId: "pane-1" });
  cleanups.push(() => db.close());
  return { dir, db, store, project, member };
}
function permissions(store: Store, extra: Partial<ToolPermissionDeps> = {}) {
  const notes: string[] = [], notices: string[] = [], still: string[] = [];
  const tp = new ToolPermissions({ store, notify: (title, body) => notices.push(`${title}|${body}`), deliverNote: (_member, decision) => notes.push(decision.note ?? ""),
    stillBlocked: member => still.push(member.id), ttlMs: 2_000, pollMs: 200, goneMs: 300, graceMs: 80, sweepMs: 20, ...extra });
  cleanups.push(() => tp.dispose());
  return { tp, notes, notices, still };
}
const bash = (command = "git push origin main") => ({ toolName: "Bash", toolInput: { command }, sessionId: "s", cwd: null });

describe("ToolPermissions: 카드를 띄우고 대표의 답을 훅에 돌려준다", () => {
  test("허용: 카드가 열리고, 답하면 기다리던 요청이 allow 를 받고 카드는 전달됨으로 간다", async () => {
    const { store, member } = storeFixture();
    const { tp, notices } = permissions(store);
    const pending = tp.request(member, bash());
    const card = store.listOpenToolPermissions()[0]!;
    expect(card.kind).toBe("tool_permission");
    expect(card.toolPermission).toMatchObject({ tool: "Bash", action: "명령 실행", target: "git push origin main" });
    expect(card.options.map(o => o.k)).toEqual(["allow", "deny"]);
    expect(card.rec).toBeNull();
    expect(card.title).toBe("명령 실행: git push origin main");
    expect(card.detail).toContain("```\ngit push origin main\n```");
    expect(card.detail).toContain("분 안에 답하지 않으면");
    expect(notices).toEqual(["결제 연동 도구 승인|명령 실행: git push origin main"]);
    // 팀장의 결재 대기·잠재우기 판단에는 넣지 않는다.
    expect(store.listOpenDecisionsByMember(member.id)).toEqual([]);
    expect(tp.covers(member.id)).toBe(true);
    const answered = tp.answer(card.id, { choice: "allow" });
    expect(answered.status).toBe("delivered");
    expect(answered.choice).toBe("allow");
    expect(answered.answeredAt).not.toBeNull();
    expect(await pending).toEqual({ id: card.id, state: "allow" });
    expect(tp.covers(member.id)).toBe(true); // 방금 답했다
    expect(store.listActivity(member.id).map(a => a.text).join("\n")).toContain("허용했습니다");
  });

  test("거절·메모: 거절 글에 메모를 싣고, 메모만 보내도 거절이다. 허용+메모는 다음 입력으로 보낸다", async () => {
    const { store, member } = storeFixture();
    const { tp, notes } = permissions(store);
    const first = tp.request(member, bash("rm -rf build"));
    tp.answer(store.listOpenToolPermissions()[0]!.id, { choice: "deny", note: "빌드 폴더는 두세요" });
    expect(await first).toMatchObject({ state: "deny", message: '대표가 결재함에서 거절했습니다. 대표 메모: "빌드 폴더는 두세요"' });
    const second = tp.request(member, bash("ls"));
    tp.answer(store.listOpenToolPermissions()[0]!.id, { note: "잠깐 기다려" });
    expect(await second).toMatchObject({ state: "deny" });
    const third = tp.request(member, bash("ls"));
    tp.answer(store.listOpenToolPermissions()[0]!.id, { choice: "allow", note: "끝나면 보고" });
    expect(await third).toMatchObject({ state: "allow" });
    expect(notes).toEqual(["끝나면 보고"]);
    expect(() => tp.answer("d_none", { choice: "allow" })).toThrow();
  });

  test("한 번의 기다림은 pending 으로 끝나고, 같은 카드를 다시 기다리면 이어서 받는다", async () => {
    const { store, member } = storeFixture();
    const { tp } = permissions(store, { pollMs: 40 });
    const first = await tp.request(member, bash());
    expect(first.state).toBe("pending");
    const again = tp.wait(member, first.id!);
    tp.answer(first.id!, { choice: "allow" });
    expect(await again).toEqual({ id: first.id, state: "allow" });
    // 다른 팀장은 남의 카드를 기다릴 수 없다.
    const other = store.createMember({ projectId: member.projectId, handle: "doc", name: "문서 정리", kind: "worker", origin: "runner", backend: "core", status: "idle" });
    const second = await tp.request(member, bash("ls"));
    await expect(tp.wait(other, second.id!)).rejects.toThrow("다른 팀장");
  });

  test("시간이 지나면 닫히고 터미널의 원래 창으로 넘긴다(승인 창 앞이면 다시 알린다). 닫힌 카드에 답하면 409", async () => {
    const { store, member } = storeFixture();
    store.patchMember(member.id, { status: "blocked", blockedReason: "permission" });
    const { tp, still } = permissions(store, { ttlMs: 120, pollMs: 1_000 });
    const result = await tp.request(member, bash());
    expect(result.state).toBe("closed");
    const card = store.requireDecision(result.id!);
    expect(card.status).toBe("closed");
    expect(card.closeKind).toBeNull();
    expect(card.closedBy).toBe("시스템");
    expect(card.closeReason).toContain("터미널의 승인 창으로 넘겼습니다");
    expect(still).toEqual([member.id]);
    expect(() => tp.answer(card.id, { choice: "allow" })).toThrow("이미 닫혔거나");
    expect(tp.covers(member.id)).toBe(false);
  });

  test("훅이 끊기면(요청 취소) 바로 닫고, 기다리는 요청 없이 시간이 지나도 닫는다", async () => {
    const { store, member } = storeFixture();
    const { tp } = permissions(store, { pollMs: 50 });
    const abort = new AbortController();
    const pending = tp.request(member, bash(), abort.signal);
    abort.abort();
    expect((await pending).state).toBe("closed");
    expect(store.listOpenToolPermissions()).toEqual([]);
    // 첫 기다림이 pending 으로 끝난 뒤 훅이 다시 오지 않는다.
    const first = await tp.request(member, bash("ls"));
    expect(first.state).toBe("pending");
    await until(() => store.requireDecision(first.id!).status === "closed");
    expect(store.requireDecision(first.id!).closeReason).toContain("끊겨");
    // 끊긴 뒤의 답은 409 이고 카드는 닫힌 채다.
    expect(() => tp.answer(first.id!, { choice: "allow" })).toThrow();
  });

  test("승인 창 앞이던 팀장이 잠깐 넘게 다른 상태면(터미널에서 먼저 답함) 닫는다. 연이은 창 사이의 깜빡임은 넘긴다", async () => {
    const { store, member } = storeFixture();
    const { tp } = permissions(store, { pollMs: 5_000, graceMs: 80 });
    const pending = tp.request(member, bash());
    const id = store.listOpenToolPermissions()[0]!.id;
    // 카드를 연 뒤 아직 승인 창으로 관측되지 않았으면 일하는 중이어도 닫지 않는다.
    tp.memberStatus(member.id, "working");
    await Bun.sleep(150);
    expect(store.requireDecision(id).status).toBe("open");
    store.patchMember(member.id, { status: "blocked" });
    tp.memberStatus(member.id, "blocked");
    store.patchMember(member.id, { status: "working" });
    tp.memberStatus(member.id, "working");
    await Bun.sleep(20);
    store.patchMember(member.id, { status: "blocked" });
    tp.memberStatus(member.id, "blocked");
    await Bun.sleep(150);
    expect(store.requireDecision(id).status).toBe("open");
    store.patchMember(member.id, { status: "working" });
    tp.memberStatus(member.id, "working");
    expect(await pending).toMatchObject({ state: "closed" });
    expect(store.requireDecision(id).closeReason).toContain("터미널에서 먼저 답해");
    // 터미널이 끝나면 바로 닫는다.
    const next = tp.request(member, bash("ls"));
    tp.memberStatus(member.id, "gone");
    expect((await next).state).toBe("closed");
  });

  test("서버가 다시 시작되면 지난 카드를 닫고, 모르는 카드를 기다리면 closed", async () => {
    const { store, member } = storeFixture();
    const before = permissions(store, { pollMs: 30 });
    const left = await before.tp.request(member, bash());
    before.tp.dispose();
    const after = permissions(store);
    expect(after.tp.closeLeftovers()).toBe(1);
    expect(store.requireDecision(left.id!).closeReason).toContain("서버가 다시 시작되어");
    expect(await after.tp.wait(member, left.id!)).toEqual({ id: left.id, state: "closed" });
    expect(await after.tp.wait(member, "d_unknown")).toEqual({ id: "d_unknown", state: "closed" });
    // 기억에 없는 열린 카드(서버가 바뀐 사이 연 것)는 기다림이 닫는다.
    const orphan = store.createToolPermissionDecision({ projectId: member.projectId, memberId: member.id, who: member.name, title: "t", options: [], toolPermission: { tool: "Bash", action: "명령 실행", target: "ls", cwd: null, expiresAt: new Date().toISOString() } });
    expect(await after.tp.wait(member, orphan.id)).toMatchObject({ state: "closed" });
    expect(store.requireDecision(orphan.id).status).toBe("closed");
    expect(() => after.tp.answer(orphan.id, { choice: "allow" })).toThrow();
  });

  test("보관한 프로젝트·사람이 직접 답하는 도구(질문 창)에는 카드를 띄우지 않는다", async () => {
    const { store, member, project } = storeFixture();
    const { tp } = permissions(store);
    expect(await tp.request(member, { toolName: "AskUserQuestion", toolInput: { questions: [] } })).toEqual({ id: null, state: "closed" });
    store.patchProject(project.id, { archived: true });
    expect(await tp.request(member, bash())).toEqual({ id: null, state: "closed" });
    expect(store.listOpenToolPermissions()).toEqual([]);
  });
});

// ---- 훅 스크립트(실제로 실행) ----
async function runHook(command: string, input: string) {
  const started = Date.now();
  const child = Bun.spawn(["/bin/sh", "-c", command], { stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code, ms: Date.now() - started };
}
const hookInput = (extra: Record<string, unknown> = {}) => JSON.stringify({ session_id: "sess-1", transcript_path: "/x/sess-1.jsonl", cwd: "/tmp/w", permission_mode: "default",
  hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "git push", description: "올리기" }, permission_suggestions: [], ...extra });

describe("permission-hook: CLI 가 부르는 명령", () => {
  function setup(url: string, token = "member-token-secret") {
    const dir = temp();
    const mcpConfigFile = join(dir, "m_one.mcp.json");
    writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: { iamceo: { command: "/bin/echo", args: [], env: { IAMCEO_URL: url, IAMCEO_TOKEN: token } } } }), { mode: 0o600 });
    return { dir, mcpConfigFile, hook: permissionHook({ runDir: join(dir, "run"), mcpConfigFile, totalMs: 3_000, pollMs: 200 }) };
  }
  function fakeServer(answer: (path: string, body: Record<string, unknown>, auth: string | null) => Response | Promise<Response>) {
    const seen: { path: string; body: Record<string, unknown>; auth: string | null }[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const body = await req.json() as Record<string, unknown>;
      const path = new URL(req.url).pathname;
      seen.push({ path, body, auth: req.headers.get("authorization") });
      return answer(path, body, req.headers.get("authorization"));
    } });
    cleanups.push(() => server.stop(true));
    return { url: `http://127.0.0.1:${server.port}`, seen };
  }

  test("명령에는 MCP 설정 파일 경로만 싣고 열쇠는 싣지 않는다. 스크립트는 0600, 언제나 0 으로 끝나는 꼴", () => {
    const { dir, mcpConfigFile, hook } = setup("http://127.0.0.1:1");
    expect(hook.command).toContain(`${PERMISSION_HOOK_MARKER}.mjs`);
    expect(hook.command).toContain(`'${mcpConfigFile}'`);
    expect(hook.command).not.toContain("member-token-secret");
    expect(hook.command.endsWith("2>/dev/null; exit 0")).toBe(true);
    expect(hook.timeoutSec).toBe(PERMISSION_HOOK_TIMEOUT_SEC);
    expect(PERMISSION_HOOK_TIMEOUT_SEC * 1000).toBeGreaterThan(TOOL_PERMISSION_TTL_MS);
    const script = join(dir, "run", `${PERMISSION_HOOK_MARKER}.mjs`);
    expect(statSync(script).mode & 0o777).toBe(0o600);
    expect(() => permissionHook({ runDir: "run", mcpConfigFile })).toThrow();
  });

  test("허용: 팀장 열쇠로 요청을 올리고, pending 이면 다시 기다린 뒤 allow 훅 답을 쓴다", async () => {
    let polls = 0;
    const server = fakeServer((path) => {
      if (path === "/agent/permission") return Response.json({ id: "d_1", state: "pending" });
      return Response.json(++polls < 2 ? { id: "d_1", state: "pending" } : { id: "d_1", state: "allow" });
    });
    const { hook } = setup(server.url);
    const out = await runHook(hook.command, hookInput({ tool_input: { command: "git push", content: "x".repeat(10_000) } }));
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    expect(server.seen.map(s => s.path)).toEqual(["/agent/permission", "/agent/permission/wait", "/agent/permission/wait"]);
    expect(server.seen[0]!.auth).toBe("Bearer member-token-secret");
    expect(server.seen[0]!.body).toMatchObject({ toolName: "Bash", sessionId: "sess-1", cwd: "/tmp/w", permissionMode: "default" });
    // 긴 입력은 줄여서 보낸다.
    expect(((server.seen[0]!.body.toolInput as Record<string, string>).content).length).toBeLessThanOrEqual(4001);
    expect(server.seen[1]!.body).toEqual({ id: "d_1" });
  });

  test("거절: 서버의 글을 그대로 거절 사유로 쓴다", async () => {
    const server = fakeServer(() => Response.json({ id: "d_2", state: "deny", message: "대표가 결재함에서 거절했습니다." }));
    const { hook } = setup(server.url);
    const out = await runHook(hook.command, hookInput());
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "대표가 결재함에서 거절했습니다." } } });
  });

  test("답이 없으면 아무것도 쓰지 않고 0 으로 끝난다: 닫힘·서버 없음·오류 응답·이상한 입력·다른 사건", async () => {
    const closed = fakeServer(() => Response.json({ id: "d_3", state: "closed" }));
    expect(await runHook(setup(closed.url).hook.command, hookInput())).toMatchObject({ stdout: "", code: 0 });
    // 서버가 없다(닫힌 포트).
    const gone = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const goneUrl = `http://127.0.0.1:${gone.port}`;
    gone.stop(true);
    expect(await runHook(setup(goneUrl).hook.command, hookInput())).toMatchObject({ stdout: "", code: 0 });
    const failing = fakeServer(() => new Response("{}", { status: 401 }));
    expect(await runHook(setup(failing.url).hook.command, hookInput())).toMatchObject({ stdout: "", code: 0 });
    const weird = fakeServer(() => new Response("not json"));
    expect(await runHook(setup(weird.url).hook.command, hookInput())).toMatchObject({ stdout: "", code: 0 });
    const never = fakeServer(() => Response.json({ id: "d_4", state: "allow" }));
    const { hook } = setup(never.url);
    expect(await runHook(hook.command, "{broken")).toMatchObject({ stdout: "", code: 0 });
    expect(await runHook(hook.command, hookInput({ hook_event_name: "PreToolUse" }))).toMatchObject({ stdout: "", code: 0 });
    expect(never.seen).toHaveLength(0);
    // 설정 파일이 없거나 열쇠가 없다.
    expect(await runHook(permissionHook({ runDir: join(temp(), "run"), mcpConfigFile: join(temp(), "none.json") }).command, hookInput())).toMatchObject({ stdout: "", code: 0 });
  });

  test("서버가 계속 pending 이어도 정해진 시간 안에 빈 응답으로 끝난다", async () => {
    const server = fakeServer(() => Response.json({ id: "d_5", state: "pending" }));
    const dir = temp();
    const mcpConfigFile = join(dir, "m.mcp.json");
    writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: { iamceo: { env: { IAMCEO_URL: server.url, IAMCEO_TOKEN: "t" } } } }));
    const hook = permissionHook({ runDir: join(dir, "run"), mcpConfigFile, totalMs: 400, pollMs: 100 });
    const out = await runHook(hook.command, hookInput());
    expect(out).toMatchObject({ stdout: "", code: 0 });
    expect(out.ms).toBeLessThan(6_000);
  });
});

// ---- providers: 어떤 팀장에게 넣는가 ----
describe("providerLaunch: 도구 승인 훅을 넣는 팀장", () => {
  const member = (extra: Partial<RunnerMember> = {}): RunnerMember => ({ id: "m_one", sessionGeneration: 1, projectId: "p_one", cli: "claude", handle: "w", name: "Worker", cwd: "/tmp", sessionId: null, paneId: null, model: null, effort: null, subagentModel: null, permissionMode: "default", kind: "worker", ...extra });
  function opts(dir: string): StartOpts {
    const o: StartOpts = { systemPromptFile: join(dir, "rules.md"), mcpConfigFile: join(dir, "m_one.mcp.json"), resume: false };
    writeFileSync(o.systemPromptFile, "rules");
    writeFileSync(o.mcpConfigFile, JSON.stringify({ mcpServers: { iamceo: { command: "/bin/echo", args: [], env: { IAMCEO_URL: "http://127.0.0.1:1", IAMCEO_TOKEN: "secret-token" } } } }));
    return o;
  }
  const hooksOf = (argv: string[]) => JSON.parse(argv[argv.indexOf("--settings") + 1]!).hooks as Record<string, { hooks: { command: string; timeout: number }[] }[]> | undefined;

  test("매번 묻기·자동 판단 팀장에게는 같은 --settings 의 PermissionRequest 로 넣는다", () => {
    for (const permissionMode of ["default", "auto"] as const) {
      const dir = temp();
      const launch = providerLaunch(member({ permissionMode }), opts(dir), { claudeBin: "/fake/claude", contextHome: dir, toolPermission: true, hookEvents: false });
      const hooks = hooksOf(launch.argv)!;
      expect(Object.keys(hooks)).toEqual(["PermissionRequest"]);
      expect(hooks.PermissionRequest![0]!.hooks[0]!.command).toContain(`'${join(dir, "m_one.mcp.json")}'`);
      expect(hooks.PermissionRequest![0]!.hooks[0]!.timeout).toBe(PERMISSION_HOOK_TIMEOUT_SEC);
      expect(launch.argv.join(" ")).not.toContain("secret-token");
      expect(existsSync(join(dir, "run", `${PERMISSION_HOOK_MARKER}.mjs`))).toBe(true);
    }
  });

  test("묻지 않기 팀장·Codex·켜지 않은 실행기·IAMCEO_TOOL_PERMISSION=0 에는 넣지 않는다", () => {
    const dir = temp();
    expect(hooksOf(providerLaunch(member({ permissionMode: "bypassPermissions" }), opts(dir), { claudeBin: "/fake/claude", contextHome: dir, toolPermission: true, hookEvents: false }).argv)).toBeUndefined();
    expect(hooksOf(providerLaunch(member(), opts(dir), { claudeBin: "/fake/claude", contextHome: dir, hookEvents: false }).argv)).toBeUndefined();
    const codex = providerLaunch(member({ cli: "codex" }), opts(dir), { codexBin: "/fake/codex", contextHome: dir, toolPermission: true });
    expect(codex.argv.join(" ")).not.toContain("PermissionRequest");
    const before = process.env.IAMCEO_TOOL_PERMISSION;
    process.env.IAMCEO_TOOL_PERMISSION = "0";
    try { expect(hooksOf(providerLaunch(member(), opts(dir), { claudeBin: "/fake/claude", contextHome: dir, toolPermission: true, hookEvents: false }).argv)).toBeUndefined(); }
    finally { if (before === undefined) delete process.env.IAMCEO_TOOL_PERMISSION; else process.env.IAMCEO_TOOL_PERMISSION = before; }
    // 사건 기록 훅과 함께면 한 hooks 객체에 둘 다.
    const both = hooksOf(providerLaunch(member(), opts(dir), { claudeBin: "/fake/claude", contextHome: dir, toolPermission: true }).argv)!;
    expect(Object.keys(both)).toContain("PermissionRequest");
    expect(Object.keys(both)).toContain("Stop");
  });
});

// ---- 서버 끝까지: 팀장 통로 + 대표의 결재 답(출시된 앱과 같은 요청) ----
class FakeRunner implements Runner {
  readonly kind = "core";
  callback: (event: RunnerEvent) => void = () => {};
  async available() { return { ok: true }; }
  async start(member: RunnerMember) { return { sessionId: member.sessionId ?? randomUUID(), paneId: `fake:${member.id}` }; }
  async send(): Promise<SendResult> { return { ok: true, started: false }; }
  isBusy() { return false; }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async checkStop() {}
  async stop() {}
  async screen() { return ""; }
  on(callback: (event: RunnerEvent) => void) { this.callback = callback; }
  async shutdown() {}
  async terminalControl(): Promise<never> { throw new Error("쓰지 않는다"); }
}

async function serverFixture() {
  const isolated = createIsolatedRuntime();
  const env = { IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: isolated.socketPath, IAMCEO_HERDR_SOCKET: isolated.herdrSocketPath,
    IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin };
  updateConfigFile({ accessCode: "tool-permission-test", hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  // Mac 알림을 켜 둔다: 꺼져 있으면 '승인 대기 알림을 내지 않는다'는 확인이 빈 확인이 된다.
  store.patchSettings({ boardTidyHours: 0, notifyMac: true });
  const runner = new FakeRunner();
  const notices: string[] = [];
  const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), providerHomes: isolated.providerHomes, notifier: (title, body) => notices.push(`${title}|${body}`),
    timings: { tickMs: 60_000, healthMs: 60_000 } });
  const context: ServerContext = { config, store, bus, orch, delivery: orch.deliveryRecovery, push: { store: new PushStore(store.db), providers: () => [] },
    daemon: () => ({ ready: true, buildId: "tool-permission", version: VERSION }) };
  let server: RunningServer | undefined;
  do { if (server) await server.stop(); server = await startServer(context); } while (server.port === 7878);
  const base = `http://127.0.0.1:${server.port}`;
  orch.setServerUrl(base);
  const project = store.createProject({ name: "도구 승인", cwd: isolated.paths.work });
  const member = store.createMember({ projectId: project.id, handle: "pay", name: "결제 연동", kind: "worker", backend: "core", origin: "runner", status: "working",
    sessionId: randomUUID(), paneId: "fake:pay", cwd: isolated.paths.work });
  const token = store.getMemberToken(member.id);
  const agent = (path: string, body: unknown, signal?: AbortSignal) => fetch(base + path, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const owner = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: "POST", headers: { Authorization: `Bearer ${config.accessCode}`, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  cleanups.push(async () => { await server!.stop(); await orch.shutdown(); store.db.close(); await isolated.stop(); });
  return { store, orch, runner, project, member, agent, owner, notices, base, config };
}
const statusEvent = (store: Store, member: Member, status: "working" | "blocked" | "idle"): RunnerEvent =>
  ({ type: "status", memberId: member.id, terminalId: member.paneId!, sessionGeneration: store.memberRevisions(member.id).sessionGeneration, status, ...(status === "blocked" ? { blockedReason: "permission" } : {}) }) as RunnerEvent;

describe("서버: 팀장 통로로 올리고 결재 답 경로로 답한다", () => {
  test("출시된 앱처럼 일반 결재로 답해도(선택지 allow, 검토 버전) 훅이 허용을 받는다", async () => {
    const f = await serverFixture();
    const pending = f.agent("/agent/permission", { toolName: "Bash", toolInput: { command: "bun test" }, sessionId: "s", cwd: null });
    await until(() => f.store.listOpenToolPermissions().length === 1);
    const card = f.store.listOpenToolPermissions()[0]!;
    // 실시간·조회 응답에 kind 와 요약이 실린다. 옛 앱은 kind 를 글자로만 읽고 선택지 두 개를 보통 결재처럼 보여 준다.
    const fetched = await (await fetch(`${f.base}/api/decisions/${card.id}`, { headers: { Authorization: `Bearer ${f.config.accessCode}` } })).json() as Decision;
    expect(fetched).toMatchObject({ kind: "tool_permission", status: "open", options: [{ k: "allow", label: "허용" }, { k: "deny", label: "거절" }], toolPermission: { tool: "Bash", target: "bun test" } });
    const answer = await f.owner(`/api/decisions/${card.id}/answer`, { choice: "allow", expectedVersion: card.updatedAt }, { "X-IAMCEO-Contract": "2" });
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as Decision).status).toBe("delivered");
    expect(await (await pending).json()).toEqual({ id: card.id, state: "allow" });
    // 같은 답을 다시 보내면 그 카드를 돌려주고, 다른 답은 409.
    expect((await f.owner(`/api/decisions/${card.id}/answer`, { choice: "allow" })).status).toBe(200);
    expect((await f.owner(`/api/decisions/${card.id}/answer`, { choice: "deny" })).status).toBe(409);
    // 팀장에게 결재 답 글을 보내지 않는다(훅이 바로 받았다).
    expect(f.store.listPending(f.member.id)).toEqual([]);
    expect(f.notices).toContain("IAMCEO · 결제 연동 도구 승인|명령 실행: bun test");
  });

  test("거절과 메모, 끝난 요청에 답하면 409 tool_permission_gone, AI 는 닫지 못하고 대표는 다시 열지 못한다", async () => {
    const f = await serverFixture();
    const pending = f.agent("/agent/permission", { toolName: "Write", toolInput: { file_path: "/tmp/a.txt", content: "abc" } });
    await until(() => f.store.listOpenToolPermissions().length === 1);
    const card = f.store.listOpenToolPermissions()[0]!;
    await expect(f.orch.closeDecision(f.member, { id: card.id, kind: "obsolete", reason: "필요 없음", followUp: { kind: "none" } })).rejects.toThrow("대표만");
    expect((await f.owner(`/api/decisions/${card.id}/answer`, { choice: "deny", note: "다른 파일에 쓰세요" })).status).toBe(200);
    expect(await (await pending).json()).toMatchObject({ state: "deny", message: expect.stringContaining("다른 파일에 쓰세요") });
    // 훅이 끊긴 카드.
    const abort = new AbortController();
    const second = f.agent("/agent/permission", { toolName: "Bash", toolInput: { command: "ls" } }, abort.signal).catch(() => null);
    await until(() => f.store.listOpenToolPermissions().length === 1);
    const orphan = f.store.listOpenToolPermissions()[0]!;
    abort.abort();
    await second;
    await until(() => f.store.requireDecision(orphan.id).status === "closed");
    const late = await f.owner(`/api/decisions/${orphan.id}/answer`, { choice: "allow" });
    expect(late.status).toBe(409);
    expect((await f.owner(`/api/decisions/${orphan.id}/reopen`, {})).status).toBe(409);
    expect(f.store.requireDecision(orphan.id).closeKind).toBeNull();
  });

  test("CLI 가 승인 창 앞이 아니게 되면(터미널에서 답함) 카드를 닫고, 열린 카드가 있으면 '승인 대기' 알림을 따로 내지 않는다", async () => {
    const f = await serverFixture();
    const pending = f.agent("/agent/permission", { toolName: "Bash", toolInput: { command: "make" } });
    await until(() => f.store.listOpenToolPermissions().length === 1);
    const card = f.store.listOpenToolPermissions()[0]!;
    f.runner.callback(statusEvent(f.store, f.member, "blocked"));
    await until(() => f.store.requireMember(f.member.id).status === "blocked");
    await Bun.sleep(5_300); // 승인 대기 알림 지연(blockedNoticeMs 5초)을 넘긴다.
    expect(f.notices.filter(n => n.includes("승인 대기"))).toEqual([]);
    f.runner.callback(statusEvent(f.store, f.member, "working"));
    expect(await (await pending).json()).toMatchObject({ id: card.id, state: "closed" });
    expect(f.store.requireDecision(card.id).closeReason).toContain("터미널에서 먼저 답해");
    // 대조: 카드 없이 승인 창 앞이면 예전처럼 알린다(위의 '알리지 않음'이 빈 확인이 아니다).
    f.runner.callback(statusEvent(f.store, f.member, "blocked"));
    await until(() => f.notices.some(n => n.includes("결제 연동 승인 대기")), 8_000);
  }, 25_000);

  test("다른 팀장의 열쇠·이 Mac 밖의 요청·잘못된 몸은 거절한다", async () => {
    const f = await serverFixture();
    const wrong = await fetch(`${f.base}/agent/permission`, { method: "POST", headers: { Authorization: "Bearer nope", "Content-Type": "application/json" }, body: JSON.stringify({ toolName: "Bash" }) });
    expect(wrong.status).toBe(401);
    const proxied = await fetch(`${f.base}/agent/permission`, { method: "POST", headers: { Authorization: `Bearer ${f.store.getMemberToken(f.member.id)}`, "Content-Type": "application/json", "X-Forwarded-For": "100.64.0.9" }, body: JSON.stringify({ toolName: "Bash" }) });
    expect(proxied.status).toBe(403);
    expect((await f.agent("/agent/permission", { toolInput: {} })).status).toBe(400);
    expect((await f.agent("/agent/permission/wait", { id: "d_none" })).status).toBe(200);
  });
});

describe("푸시: 열린 도구 승인 카드가 있으면 같은 팀장의 '승인 대기' 알림은 내지 않는다", () => {
  test("approval_wait 사건은 카드가 열린 동안 유효하지 않다", () => {
    const { store, member } = storeFixture();
    const push = new PushStore(store.db);
    store.patchMember(member.id, { status: "blocked", blockedReason: "permission" });
    const event = { id: "e1", sourceKey: `blocked:${member.id}:1`, kind: "approval_wait", projectId: member.projectId, memberId: member.id,
      target: { screen: "team", projectId: member.projectId, memberId: member.id }, occurredAt: new Date().toISOString() } as Parameters<PushStore["isEventCurrent"]>[0];
    push.saveEpisode({ memberId: member.id, blockedGeneration: 1, blockedActive: true, errorGeneration: 0, errorActive: false, errorDigest: null });
    expect(push.isEventCurrent(event)).toBe(true);
    const card = store.createToolPermissionDecision({ projectId: member.projectId, memberId: member.id, who: member.name, title: "t", options: [], toolPermission: { tool: "Bash", action: "명령 실행", target: "ls", cwd: null, expiresAt: new Date().toISOString() } });
    expect(push.isEventCurrent(event)).toBe(false);
    store.closeDecision(card.id, { kind: null, reason: "끝", by: "시스템" });
    expect(push.isEventCurrent(event)).toBe(true);
  });
});

// 덤프로 남긴 실제 응답을 옛 해석기가 읽는지는 scripts/check.sh compat(tests/compat-dump.test.ts)가 본다.
test("도구 승인 카드는 DB 의 새 열에만 요약을 둔다(이전 판 서버가 같은 DB 를 연다)", () => {
  const { store, member, db } = storeFixture();
  const card = store.createToolPermissionDecision({ projectId: member.projectId, memberId: member.id, who: member.name, title: "t", options: [], toolPermission: { tool: "Bash", action: "명령 실행", target: "ls", cwd: null, expiresAt: new Date().toISOString() } });
  const row = db.query<{ tool_permission_json: string; usage_limit_json: string | null }, [string]>("SELECT tool_permission_json, usage_limit_json FROM decisions WHERE id = ?").get(card.id)!;
  expect(JSON.parse(row.tool_permission_json)).toMatchObject({ tool: "Bash", target: "ls" });
  expect(row.usage_limit_json).toBeNull();
  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBeGreaterThan(0);
  expect(readFileSync(join(import.meta.dir, "..", "server", "db.ts"), "utf8")).toContain("ensureToolPermissionColumn(db);");
});
