// Gemini(Antigravity CLI) 도구 호출 직전 훅(server/runner/gemini-tool-hook.ts)을 agy 가 하듯 `/bin/sh -c` 로 실제로 돌린다.
// 실제 agy 는 띄우지 않는다. 입력 견본의 칸 이름은 agy 1.5.14 가 실제로 넘긴 PreToolUse 입력을 따랐다(값은 지어낸 것).
// agy 1.5.14 실측 계약: 빈 출력 + 0 = 기본 정책, `{}`·0 아닌 종료·JSON 아닌 출력 = 도구가 막힌다. 그래서 훅은 늘 0 이고 판정 JSON 하나만 내거나 아무것도 내지 않는다.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GEMINI_TOOL_HOOK_LOCAL_TIMEOUT_SEC, geminiInjectDenyReason, geminiToolHookConfigFile, geminiToolHookSet } from "../server/runner/gemini-tool-hook.ts";
import { geminiHooksFile, geminiRecorderHookSet, GEMINI_HOOKS_NAME } from "../server/runner/gemini-hooks.ts";
import { PERMISSION_HOOK_TIMEOUT_SEC } from "../server/runner/permission-hook.ts";
import { providerLaunch } from "../server/runner/providers.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp(): string { const dir = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-gth-"))); dirs.push(dir); return dir; }

async function runHook(command: string, input: string | null) {
  const child = Bun.spawn(["/bin/sh", "-c", command], { stdin: input === null ? "pipe" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}
const CONV = "f0469d2b-813c-4d72-9c13-f80e0a315968";
/** 실측 견본과 같은 칸: 작업 공간은 글자 순(주입 폴더가 앞), cwd = workspacePaths[0]. */
function preToolUse(name: string, args: Record<string, unknown>, workspaces: string[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ artifactDirectoryPath: `/Users/dev/.gemini/antigravity-cli/brain/${CONV}`, conversationId: CONV, cwd: workspaces[0], hookEventName: "PreToolUse",
    lastUserInput: "hello", modelName: "gemini-3.8-flash-low", stepIdx: 3, toolCall: { id: "call_646705910486809191", name, args },
    transcriptPath: `/Users/dev/.gemini/antigravity-cli/brain/${CONV}/.system_generated/logs/transcript_full.jsonl`, workspacePaths: workspaces, ...extra });
}
/** 실제 자리와 같은 모양: <홈>/.iamceo/run/m_lead1.gemini/agy/m_lead1 (주입 폴더), <홈>/proj (프로젝트). */
function layout() {
  const root = temp();
  const home = join(root, ".iamceo"), run = join(home, "run"), project = join(root, "proj");
  const injectDir = join(run, "m_lead1.gemini", "agy", "m_lead1");
  mkdirSync(injectDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  const set = geminiToolHookSet({ runDir: run, cwd: project, injectDir });
  const group = set.PreToolUse![0]!;
  return { root, run, project, injectDir, set, group, command: group.hooks[0]!.command, workspaces: [injectDir, project] };
}

describe("geminiToolHookSet: hooks.json 의 PreToolUse 묶음과 설정 파일", () => {
  test("matcher 는 명령·파일 쓰기 도구, 제한 시간, 명령은 `{}` 를 찍지 않고 0 으로 끝난다. 설정 파일은 주입 폴더 밖(0600)", () => {
    const { group, command, injectDir, project } = layout();
    expect(group.matcher).toBe("^(run_command|write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content|sed_file|notebook_edit)$");
    expect(group.hooks[0]!.timeout).toBe(GEMINI_TOOL_HOOK_LOCAL_TIMEOUT_SEC);
    expect(command).not.toContain("printf");
    expect(command.endsWith("2>/dev/null; exit 0")).toBe(true);
    const file = geminiToolHookConfigFile(injectDir);
    expect(file.startsWith(`${injectDir}/`)).toBe(false);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1, cwd: project, injectDir, injectDeny: geminiInjectDenyReason(project, injectDir), permission: null, tier: null });
  });
  test("상대 경로는 던진다", () => {
    expect(() => geminiToolHookSet({ runDir: "run", cwd: "/p", injectDir: "/i" })).toThrow();
    expect(() => geminiToolHookSet({ runDir: "/r", cwd: "p", injectDir: "/i" })).toThrow();
  });
  test("geminiHooksFile: 장치마다 만든 처리기를 사건별로 잇는다. 비면 null", () => {
    const { set, run } = layout();
    const recorder = geminiRecorderHookSet({ memberId: "m_lead1", eventsDir: join(run, "gemini-events") });
    const file = geminiHooksFile(recorder, null, set) as Record<string, Record<string, unknown[]>>;
    expect(Object.keys(file)).toEqual([GEMINI_HOOKS_NAME]);
    expect(Object.keys(file[GEMINI_HOOKS_NAME]!).sort()).toEqual(["PreInvocation", "PreToolUse", "SessionStart", "Stop"]);
    // 같은 사건에 둘이면 인자 차례로 잇는다.
    const extra = { Stop: [{ type: "command" as const, command: "true", timeout: 1 }] };
    const both = geminiHooksFile(recorder, extra) as Record<string, Record<string, unknown[]>>;
    expect(both[GEMINI_HOOKS_NAME]!.Stop).toEqual([...recorder.Stop!, ...extra.Stop]);
    expect(geminiHooksFile()).toBeNull();
    expect(geminiHooksFile(null, {}, { Stop: [] })).toBeNull();
  });
});

describe("작업 폴더 바로잡기(스크립트를 실제로 돌린다)", () => {
  test("run_command 의 Cwd 가 없으면(agy 는 첫째 작업 공간 = 주입 폴더에서 돌린다) 프로젝트 폴더로 바꿔 쓴다", async () => {
    const { command, project, workspaces } = layout();
    const out = await runHook(command, preToolUse("run_command", { CommandLine: "pwd", WaitMsBeforeAsync: 5000, toolSummary: "Print working directory" }, workspaces));
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ decision: "allow", overwrite: { Cwd: project } });
  });
  test("Cwd 가 주입 폴더나 그 아래면 프로젝트 폴더로, 프로젝트(그 아래 포함)나 다른 폴더면 그대로 둔다(아무것도 내지 않는다)", async () => {
    const { command, project, injectDir, workspaces } = layout();
    for (const cwd of [injectDir, `${injectDir}/`, join(injectDir, ".agents"), join(injectDir, "sub", "..")]) {
      const out = await runHook(command, preToolUse("run_command", { CommandLine: "ls", Cwd: cwd }, workspaces));
      expect(JSON.parse(out.stdout)).toEqual({ decision: "allow", overwrite: { Cwd: project } });
    }
    for (const cwd of [project, join(project, "app"), "/usr"]) {
      const out = await runHook(command, preToolUse("run_command", { CommandLine: "ls", Cwd: cwd }, workspaces));
      expect(out).toEqual({ stdout: "", stderr: "", code: 0 });
    }
    // 이름이 주입 폴더로 시작할 뿐인 옆 폴더는 주입 폴더가 아니다.
    const out = await runHook(command, preToolUse("run_command", { CommandLine: "ls", Cwd: `${injectDir}-other` }, workspaces));
    expect(out.stdout).toBe("");
  });
  test("파일 쓰기 도구의 경로가 주입 폴더 안이면 막는다(까닭에 작업 폴더). 상대 경로는 첫째 작업 공간에 붙여 읽는다", async () => {
    const { command, project, injectDir, workspaces } = layout();
    const deny = { decision: "deny", reason: geminiInjectDenyReason(project, injectDir) };
    expect(deny.reason).toContain(`작업 폴더는 ${project} 입니다`);
    for (const [name, args] of [
      ["write_file", { Content: "x", Path: join(injectDir, "probe.txt") }],
      ["edit_file", { Path: join(injectDir, ".agents", "hooks.json"), Target: "a", Replacement: "b" }],
      ["write_to_file", { TargetFile: join(injectDir, "a", "b.txt"), CodeContent: "x" }],
      ["write_file", { Content: "x", Path: "probe.txt" }],
    ] as const) {
      const out = await runHook(command, preToolUse(name, args, workspaces));
      expect(out.code).toBe(0);
      expect(JSON.parse(out.stdout)).toEqual(deny);
    }
    // 프로젝트에 쓰기, 프로젝트가 첫째 작업 공간일 때의 상대 경로는 막지 않는다.
    expect((await runHook(command, preToolUse("write_file", { Content: "x", Path: join(project, "probe.txt") }, workspaces))).stdout).toBe("");
    expect((await runHook(command, preToolUse("write_file", { Content: "x", Path: "probe.txt" }, [project, injectDir]))).stdout).toBe("");
  });
  test("링크로 가리킨 같은 자리(/tmp 와 /private/tmp 같은)도 주입 폴더로 본다", async () => {
    const { command, project, injectDir, root, workspaces } = layout();
    const alias = join(root, "alias");
    symlinkSync(join(root, ".iamceo"), alias);
    const via = join(alias, "run", "m_lead1.gemini", "agy", "m_lead1");
    const write = await runHook(command, preToolUse("write_file", { Content: "x", Path: join(via, "new-dir", "f.txt") }, workspaces));
    expect(JSON.parse(write.stdout).decision).toBe("deny");
    const run = await runHook(command, preToolUse("run_command", { CommandLine: "ls", Cwd: via }, workspaces));
    expect(JSON.parse(run.stdout)).toEqual({ decision: "allow", overwrite: { Cwd: project } });
    expect(injectDir).not.toBe(via);
  });
  test("읽기·다른 도구·다른 사건은 건드리지 않는다", async () => {
    const { command, injectDir, workspaces } = layout();
    for (const input of [
      preToolUse("read_file", { Path: join(injectDir, ".agents", "rules", "iamceo-01.md") }, workspaces),
      preToolUse("call_mcp_tool", { ServerName: "iamceo", ToolName: "post", Arguments: {} }, workspaces),
      JSON.stringify({ hookEventName: "PostToolUse", toolCall: { name: "run_command", args: {} }, workspacePaths: workspaces }),
    ]) expect(await runHook(command, input)).toEqual({ stdout: "", stderr: "", code: 0 });
  });
  test("입력이 이상하거나 설정·실행 파일이 없으면 아무것도 내지 않고 0(= agy 기본 정책, 도구를 막지 않는다)", async () => {
    const { command, injectDir, workspaces } = layout();
    for (const input of ["", "not json", "{}", "[]", JSON.stringify({ hookEventName: "PreToolUse" })]) {
      expect(await runHook(command, input)).toEqual({ stdout: "", stderr: "", code: 0 });
    }
    const run = preToolUse("run_command", { CommandLine: "pwd" }, workspaces);
    rmSync(geminiToolHookConfigFile(injectDir));
    expect(await runHook(command, run)).toEqual({ stdout: "", stderr: "", code: 0 });
    writeFileSync(geminiToolHookConfigFile(injectDir), "{ broken");
    expect(await runHook(command, run)).toEqual({ stdout: "", stderr: "", code: 0 });
    // 실행 파일이 사라졌다(앱을 지우거나 옮김).
    const gone = command.replace(/BUN_BE_BUN=1 '[^']+'/, "BUN_BE_BUN=1 '/nonexistent/iamceo'");
    expect(gone).not.toBe(command);
    expect(await runHook(gone, run)).toEqual({ stdout: "", stderr: "", code: 0 });
  });
  test("팀장 작업 폴더의 bunfig.toml(preload)·.env 를 읽지 않는다", async () => {
    const { command, project, workspaces } = layout();
    writeFileSync(join(project, "bunfig.toml"), `preload = ["./evil.ts"]\n`);
    writeFileSync(join(project, "evil.ts"), `process.stdout.write('{"decision":"auto_approve"}'); process.exit(0);\n`);
    const child = Bun.spawn(["/bin/sh", "-c", command], { cwd: project, stdin: new Blob([preToolUse("run_command", { CommandLine: "pwd" }, workspaces)]), stdout: "pipe" });
    const stdout = await new Response(child.stdout).text();
    expect(JSON.parse(stdout)).toEqual({ decision: "allow", overwrite: { Cwd: project } });
  });
});

// ---- 결재함 승인(가짜 서버) ----
interface Seen { path: string; auth: string | null; body: Record<string, unknown> }
/** /agent/permission 을 흉내 낸다. answer(body) 가 돌려준 답을 주고, 받은 요청을 적는다. */
function fakeServer(answer: (body: Record<string, unknown>, path: string) => unknown) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>;
      const path = new URL(req.url).pathname;
      seen.push({ path, auth: req.headers.get("authorization"), body });
      return Response.json(answer(body, path));
    },
  });
  cleanups.push(() => server.stop(true));
  return { seen, url: `http://127.0.0.1:${server.port}` };
}
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });
function permissionLayout(url: string, token = "member-token-1") {
  const base = layout();
  const mcpConfigFile = join(base.run, "m_lead1.gemini", "mcp.json");
  writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: { iamceo: { command: "/bin/echo", args: [], env: { IAMCEO_URL: url, IAMCEO_TOKEN: token } } } }), { mode: 0o600 });
  const set = geminiToolHookSet({ runDir: base.run, cwd: base.project, injectDir: base.injectDir, permission: { mcpConfigFile }, totalMs: 4000, pollMs: 300 });
  return { ...base, mcpConfigFile, set, group: set.PreToolUse![0]!, command: set.PreToolUse![0]!.hooks[0]!.command };
}

describe("결재함 승인(스크립트를 실제로 돌리고, 서버는 가짜)", () => {
  test("matcher 에 읽기·연결 도구·웹이 더해지고, 제한 시간은 Claude 승인 훅과 같다. 열쇠는 명령줄·설정 파일에 없다", () => {
    const t = permissionLayout("http://127.0.0.1:1");
    expect(t.group.matcher).toBe("^(run_command|write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content|sed_file|notebook_edit|read_file|view_file|call_mcp_tool|read_url_content|open_browser_url|browser_subagent)$");
    expect(t.group.hooks[0]!.timeout).toBe(PERMISSION_HOOK_TIMEOUT_SEC);
    expect(t.command).not.toContain("member-token-1");
    expect(readFileSync(geminiToolHookConfigFile(t.injectDir), "utf8")).not.toContain("member-token-1");
    expect(JSON.parse(readFileSync(geminiToolHookConfigFile(t.injectDir), "utf8")).permission).toEqual({ mcpConfigFile: t.mcpConfigFile });
  });
  test("허용 → auto_approve(바꿔 쓴 Cwd 와 함께), 요청에는 실제로 돌 인자·종류·대화 id·호출 id 를 싣고 팀장 열쇠로 부른다", async () => {
    const server = fakeServer(() => ({ id: "d1", state: "allow" }));
    const t = permissionLayout(server.url);
    const out = await runHook(t.command, preToolUse("run_command", { CommandLine: "npm test", WaitMsBeforeAsync: 5000 }, t.workspaces));
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ decision: "auto_approve", overwrite: { Cwd: t.project } });
    expect(server.seen).toHaveLength(1);
    expect(server.seen[0]).toEqual({ path: "/agent/permission", auth: "Bearer member-token-1", body: {
      toolName: "run_command", toolInput: { CommandLine: "npm test", WaitMsBeforeAsync: 5000, Cwd: t.project }, sessionId: CONV, cwd: t.project,
      cli: "gemini", geminiKind: "command", toolCallId: "call_646705910486809191" } });
  });
  test("거절 → deny + 대표 메모(모델이 받는 까닭), 기다림(pending) 뒤의 답도 받는다", async () => {
    let polls = 0;
    const server = fakeServer((_body, path) => path === "/agent/permission" ? { id: "d2", state: "pending" } : ++polls < 2 ? { id: "d2", state: "pending" } : { id: "d2", state: "deny", message: "대표가 결재함에서 거절했습니다. 대표 메모: \"main 에 밀지 마세요\"" });
    const t = permissionLayout(server.url);
    const out = await runHook(t.command, preToolUse("run_command", { CommandLine: "git push origin main", Cwd: t.project }, t.workspaces));
    expect(JSON.parse(out.stdout)).toEqual({ decision: "deny", reason: "대표가 결재함에서 거절했습니다. 대표 메모: \"main 에 밀지 마세요\"" });
    expect(server.seen.map(s => s.path)).toEqual(["/agent/permission", "/agent/permission/wait", "/agent/permission/wait"]);
    expect(server.seen[1]!.body).toEqual({ id: "d2" });
  });
  test("닫힘·모르는 답·서버 없음·잘못된 열쇠 설정: 승인 판정 없이 끝난다(바꿔 쓸 인자만 있으면 allow + overwrite, 없으면 아무것도 내지 않는다)", async () => {
    const closed = fakeServer(() => ({ id: null, state: "closed" }));
    const t = permissionLayout(closed.url);
    expect(JSON.parse((await runHook(t.command, preToolUse("run_command", { CommandLine: "ls" }, t.workspaces))).stdout)).toEqual({ decision: "allow", overwrite: { Cwd: t.project } });
    expect(await runHook(t.command, preToolUse("write_file", { Path: join(t.project, "a.txt"), Content: "x" }, t.workspaces))).toEqual({ stdout: "", stderr: "", code: 0 });
    const odd = fakeServer(() => ({ state: "maybe" }));
    expect((await runHook(permissionLayout(odd.url).command, preToolUse("write_file", { Path: "/elsewhere/a.txt", Content: "x" }, t.workspaces))).stdout).toBe("");
    // 서버가 없다(꺼짐·재시작 중).
    expect(await runHook(permissionLayout("http://127.0.0.1:1").command, preToolUse("write_file", { Path: join(t.project, "a.txt"), Content: "x" }, t.workspaces))).toEqual({ stdout: "", stderr: "", code: 0 });
    // 주소·열쇠가 잘못됐다.
    for (const [url, token] of [["ftp://x", "t"], ["http://127.0.0.1:1", ""]] as const) {
      const bad = permissionLayout(url, token);
      expect((await runHook(bad.command, preToolUse("write_file", { Path: join(bad.project, "a.txt"), Content: "x" }, bad.workspaces))).stdout).toBe("");
    }
  });
  test("종류: 작업 공간 안/임시 폴더/밖 쓰기·읽기, 연결 도구, 웹. 작업 공간 안 읽기와 IAMCEO 연결 도구는 묻지 않는다", async () => {
    const server = fakeServer(() => ({ id: null, state: "closed" }));
    const t = permissionLayout(server.url);
    const kindOf = async (name: string, args: Record<string, unknown>) => {
      const before = server.seen.length;
      await runHook(t.command, preToolUse(name, args, t.workspaces));
      return server.seen.length > before ? server.seen.at(-1)!.body.geminiKind : null;
    };
    expect(await kindOf("write_file", { Path: join(t.project, "src", "a.ts"), Content: "x" })).toBe("edit");
    expect(await kindOf("edit_file", { Path: "/tmp/scratch.txt", Target: "a", Replacement: "b" })).toBe("edit_temp");
    expect(await kindOf("write_file", { Path: "/etc/hosts", Content: "x" })).toBe("edit_outside");
    expect(await kindOf("read_file", { Path: join(t.project, "README.md") })).toBeNull();
    expect(await kindOf("read_file", { Path: join(t.injectDir, ".agents", "rules", "iamceo-01.md") })).toBeNull();
    expect(await kindOf("read_file", { Path: "/private/tmp/x.log" })).toBe("read_temp");
    expect(await kindOf("view_file", { AbsolutePath: "/Users/someone/.ssh/config" })).toBe("read_outside");
    expect(await kindOf("call_mcp_tool", { ServerName: "iamceo", ToolName: "post", Arguments: {} })).toBeNull();
    expect(await kindOf("call_mcp_tool", { ServerName: "github", ToolName: "create_issue", Arguments: { title: "x" } })).toBe("mcp");
    expect(await kindOf("read_url_content", { Url: "https://example.com" })).toBe("web");
    // 주입 폴더 쓰기는 서버에 묻지 않고 막는다.
    expect(await kindOf("write_file", { Path: join(t.injectDir, "x.txt"), Content: "x" })).toBeNull();
  });
  test("HTTP_PROXY 가 있어도 이 Mac 의 서버로 바로 간다(팀장 열쇠가 실린 요청이 프록시로 나가지 않는다)", async () => {
    const server = fakeServer(() => ({ id: "d3", state: "allow" }));
    const t = permissionLayout(server.url);
    const child = Bun.spawn(["/bin/sh", "-c", t.command], { env: { ...process.env, HTTP_PROXY: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9" }, stdin: new Blob([preToolUse("write_file", { Path: join(t.project, "a.txt"), Content: "x" }, t.workspaces)]), stdout: "pipe" });
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({ decision: "auto_approve" });
    expect(server.seen).toHaveLength(1);
  });
});

describe("providerLaunch(gemini): 도구 훅의 승인 부분은 Claude 승인 훅과 같은 조건에서만 싣는다", () => {
  function launchHooks(permissionMode: "default" | "auto" | "bypassPermissions", toolPermission: boolean | undefined, envOff = false) {
    const home = temp();
    const run = join(home, "run");
    mkdirSync(run, { recursive: true, mode: 0o700 });
    const opts = { systemPromptFile: join(run, "m_lead1.rules.md"), mcpConfigFile: join(run, "m_lead1.mcp.json"), resume: false };
    writeFileSync(opts.systemPromptFile, "지침\n");
    writeFileSync(opts.mcpConfigFile, JSON.stringify({ mcpServers: { iamceo: { command: "/bin/echo", args: [], env: { IAMCEO_TOKEN: "secret", IAMCEO_URL: "http://127.0.0.1:1" } } } }), { mode: 0o600 });
    const before = process.env.IAMCEO_TOOL_PERMISSION;
    if (envOff) process.env.IAMCEO_TOOL_PERMISSION = "0";
    try {
      const member = { id: "m_lead1", sessionGeneration: 1, projectId: "p", cli: "gemini" as const, handle: "lead", name: "결제 연동", cwd: home, sessionId: null, paneId: null, model: null, effort: null, subagentModel: null, permissionMode, kind: "worker" as const };
      const launch = providerLaunch(member, opts, { geminiBin: "/fake/agy", contextHome: home, ...(toolPermission === undefined ? {} : { toolPermission }) });
      const injectDir = launch.argv[launch.argv.indexOf("--add-dir") + 1]!;
      const hooks = JSON.parse(readFileSync(join(injectDir, ".agents", "hooks.json"), "utf8"))[GEMINI_HOOKS_NAME].PreToolUse[0];
      return { hooks, config: JSON.parse(readFileSync(geminiToolHookConfigFile(injectDir), "utf8")), mcpConfigFile: opts.mcpConfigFile };
    } finally { if (envOff) { if (before === undefined) delete process.env.IAMCEO_TOOL_PERMISSION; else process.env.IAMCEO_TOOL_PERMISSION = before; } }
  }
  test("받을 서버가 있고(toolPermission) 묻지 않기가 아니면 싣는다. 열쇠는 MCP 설정 파일 자리로만", () => {
    for (const mode of ["default", "auto"] as const) {
      const on = launchHooks(mode, true);
      expect(on.config.permission).toEqual({ mcpConfigFile: on.mcpConfigFile });
      expect(on.hooks.matcher).toContain("|read_file|");
      expect(on.hooks.hooks[0].timeout).toBe(PERMISSION_HOOK_TIMEOUT_SEC);
      expect(JSON.stringify(on.hooks)).not.toContain("secret");
    }
  });
  test("묻지 않기, 받을 서버 없음(toolPermission 아님), IAMCEO_TOOL_PERMISSION=0 이면 폴더 바로잡기만", () => {
    for (const off of [launchHooks("bypassPermissions", true), launchHooks("default", undefined), launchHooks("default", false), launchHooks("default", true, true)]) {
      expect(off.config.permission).toBeNull();
      expect(off.hooks.matcher).not.toContain("read_file");
      expect(off.hooks.hooks[0].timeout).toBe(GEMINI_TOOL_HOOK_LOCAL_TIMEOUT_SEC);
    }
  });
});

describe("서브에이전트 단계(스크립트를 실제로 돌린다)", () => {
  function tierLayout(tier: "flash_lite" | "flash" | "pro" | null) {
    const base = layout();
    const set = geminiToolHookSet({ runDir: base.run, cwd: base.project, injectDir: base.injectDir, tier });
    return { ...base, group: set.PreToolUse![0]!, command: set.PreToolUse![0]!.hooks[0]!.command };
  }
  test("단계를 골랐으면 invoke_subagent 를 matcher 에 넣고 Model 을 그 단계로 바꿔 쓴다(평평한 인자·Model 이 없던 호출 = inherit 포함)", async () => {
    const t = tierLayout("flash");
    expect(t.group.matcher.endsWith("|invoke_subagent)$")).toBe(true);
    expect(JSON.parse(readFileSync(geminiToolHookConfigFile(t.injectDir), "utf8")).tier).toBe("flash");
    for (const args of [{ Prompt: "조사", Role: "research", TypeName: "research" }, { Prompt: "조사", Role: "r", TypeName: "self", Model: "pro" }, { Prompt: "조사", TypeName: "research", Model: "inherit" }]) {
      const out = await runHook(t.command, preToolUse("invoke_subagent", args, t.workspaces));
      expect(out.code).toBe(0);
      expect(JSON.parse(out.stdout)).toEqual({ decision: "allow", overwrite: { Model: "flash" } });
    }
  });
  test("문서 모양(Subagents 배열)은 항목마다 Model 을 넣는다", async () => {
    const t = tierLayout("flash_lite");
    const out = await runHook(t.command, preToolUse("invoke_subagent", { Subagents: [{ Prompt: "a", Role: "r", TypeName: "research" }, "odd", { Prompt: "b", TypeName: "self", Model: "pro" }] }, t.workspaces));
    expect(JSON.parse(out.stdout)).toEqual({ decision: "allow", overwrite: { Subagents: [{ Prompt: "a", Role: "r", TypeName: "research", Model: "flash_lite" }, "odd", { Prompt: "b", TypeName: "self", Model: "flash_lite" }] } });
  });
  test("단계를 고르지 않았으면(inherit) matcher 에 없고, 불려도 손대지 않는다. 설정 파일의 단계가 아닌 값도 손대지 않는다", async () => {
    const t = tierLayout(null);
    expect(t.group.matcher).not.toContain("invoke_subagent");
    expect(await runHook(t.command, preToolUse("invoke_subagent", { Prompt: "a", TypeName: "research" }, t.workspaces))).toEqual({ stdout: "", stderr: "", code: 0 });
    const file = geminiToolHookConfigFile(t.injectDir);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), tier: "gemini-4-neon" }));
    expect((await runHook(t.command, preToolUse("invoke_subagent", { Prompt: "a", TypeName: "research" }, t.workspaces))).stdout).toBe("");
    // 단계가 아닌 값은 설정 파일에도 싣지 않는다.
    expect(JSON.parse(readFileSync(geminiToolHookConfigFile(geminiToolHookSet({ runDir: t.run, cwd: t.project, injectDir: t.injectDir, tier: "neon" as never }) && t.injectDir), "utf8")).tier).toBeNull();
  });
  test("승인과 함께: invoke_subagent 는 묻지 않는 종류라 서버에 묻지 않고 단계만 바꿔 쓴다", async () => {
    const server = fakeServer(() => ({ id: "d", state: "allow" }));
    const t = permissionLayout(server.url);
    const set = geminiToolHookSet({ runDir: t.run, cwd: t.project, injectDir: t.injectDir, permission: { mcpConfigFile: t.mcpConfigFile }, tier: "pro" });
    const out = await runHook(set.PreToolUse![0]!.hooks[0]!.command, preToolUse("invoke_subagent", { Prompt: "a", TypeName: "research" }, t.workspaces));
    expect(JSON.parse(out.stdout)).toEqual({ decision: "allow", overwrite: { Model: "pro" } });
    expect(server.seen).toEqual([]);
  });
});
