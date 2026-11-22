// Gemini(Antigravity CLI) 도구 호출 직전 훅(server/runner/gemini-tool-hook.ts)을 agy 가 하듯 `/bin/sh -c` 로 실제로 돌린다.
// 실제 agy 는 띄우지 않는다. 입력 견본의 칸 이름은 agy 1.5.14 가 실제로 넘긴 PreToolUse 입력을 따랐다(값은 지어낸 것).
// agy 1.5.14 실측 계약: 빈 출력 + 0 = 기본 정책, `{}`·0 아닌 종료·JSON 아닌 출력 = 도구가 막힌다. 그래서 훅은 늘 0 이고 판정 JSON 하나만 내거나 아무것도 내지 않는다.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GEMINI_TOOL_HOOK_LOCAL_TIMEOUT_SEC, geminiInjectDenyReason, geminiToolHookConfigFile, geminiToolHookSet } from "../server/runner/gemini-tool-hook.ts";
import { geminiHooksFile, geminiRecorderHookSet, GEMINI_HOOKS_NAME } from "../server/runner/gemini-hooks.ts";

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
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1, cwd: project, injectDir, injectDeny: geminiInjectDenyReason(project, injectDir) });
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
