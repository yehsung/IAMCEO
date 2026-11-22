// Provider CLIs remain interactive and load their ordinary user/project settings.
// IAMCEO additions are invocation-scoped; no global CLI configuration is changed.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CLI_INFO, type CliProvider } from "../../shared/types.ts";
import type { RunnerMember, StartOpts } from "./types.ts";
import { CoreError } from "./core-client.ts";
import { writeStatuslineWrapper } from "./statusline.ts";
import { hookEventsDir, hookSettings, mergeHooks } from "./hooks.ts";
import { permissionHook } from "./permission-hook.ts";
import { subagentEnv } from "./env.ts";
import { geminiHookEventsDir, geminiHooksFile, geminiRecorderHookSet, type GeminiHookSet } from "./gemini-hooks.ts";
import { geminiToolHookSet } from "./gemini-tool-hook.ts";
import { geminiInjectDir, geminiSettings, writeGeminiInjectDir } from "./gemini-inject.ts";
import { geminiStatusLine } from "./gemini-statusline.ts";

/** core 가 띄우는 CLI. "gemini" 는 Antigravity CLI 다: 띄우는 실행 파일은 `agy`(CLI_INFO.gemini.program)이고 값 이름과 다르다. */
export type CoreProvider = CliProvider;
export interface ProviderLaunch {
  argv: string[]; env: Record<string, string>; sessionId: string | null;
  /** 이 띄우기에만 붙는 터미널 라벨. 실행기가 terminal.run 의 라벨에 더한다(지금은 Antigravity CLI 의 GEMINI_LAUNCH_LABEL 뿐이다). */
  labels?: Record<string, string>;
}
/**
 * Antigravity CLI 터미널의 라벨: 띄울 때마다 새로 만드는 임의 값. 같은 값을 상태줄 명령의 인자로 실어 상태줄 기록의 launch 칸에 적히게 한다
 * (gemini-statusline.ts). 실행기는 그 값이 이 라벨과 같은 기록만 이 터미널의 것으로 믿는다(CoreRunner.geminiStatus).
 * Codex 의 iamceo.binding 과는 다른 라벨이다: 그 값은 입력 앞에 붙는 표지이고 Antigravity CLI 터미널에는 없다.
 */
export const GEMINI_LAUNCH_LABEL = "iamceo.launch";
export interface ProviderBins {
  claudeBin?: string; codexBin?: string;
  /** Antigravity CLI 실행 파일. 없으면 `agy`. */
  geminiBin?: string;
  contextHome?: string;
  /** E1 사건 기록 훅. 없으면 IAMCEO_HOOK_EVENTS=0 일 때만 끈다. contextHome 이 있을 때만 넣는다. */
  hookEvents?: boolean;
  /**
   * K(E2) 도구 승인 훅. 서버가 띄우는 실행기(createOrchestrator)만 true 로 켠다: 받을 서버(/agent/permission)가 있어야 뜻이 있다.
   * IAMCEO_TOOL_PERMISSION=0 이면 끈다. contextHome 이 있을 때만, 묻지 않기 팀장에게는 넣지 않는다.
   */
  toolPermission?: boolean;
}
const toml = (value: unknown) => JSON.stringify(value);

/**
 * 이 팀장의 Claude 훅(--settings 의 hooks 값). 만들지 못하면 null: 훅 때문에 CLI 를 못 띄우는 일은 없게 한다.
 * K(도구 승인)는 아래 hookSettings 호출에 permissionHook 만 더한다.
 */
function claudeHooks(member: RunnerMember, home: string, bins: ProviderBins, mcpConfigFile: string): Record<string, unknown> | null {
  const events = bins.hookEvents ?? process.env.IAMCEO_HOOK_EVENTS !== "0";
  const eventsDir = hookEventsDir(home);
  // 합치기: 사건 기록과 도구 승인을 따로 만든다. 한쪽을 만들지 못해도(잘못된 팀장 ID, 잘못된 승인 명령) 다른 쪽은 그대로 넣는다.
  const hooks: Record<string, unknown> = {};
  if (events) { try { Object.assign(hooks, hookSettings({ memberId: member.id, eventsDir })); } catch { /* 기록 훅 없이 */ } }
  const permission = toolPermissionHook(member, home, bins, mcpConfigFile);
  if (permission) { try { Object.assign(hooks, hookSettings({ memberId: member.id, eventsDir, events: false, permissionHook: permission })); } catch { /* 승인 훅 없이 */ } }
  return Object.keys(hooks).length ? hooks : null;
}

/**
 * K(E2): 도구 승인 창을 결재함에서 답하게 하는 PermissionRequest 훅. 묻지 않기(bypassPermissions) 팀장에게는 넣지 않는다(승인 창이 없다).
 * 만들지 못하면 넣지 않는다: 그때는 지금처럼 터미널의 원래 승인 창만 뜬다.
 */
function toolPermissionHook(member: RunnerMember, home: string, bins: ProviderBins, mcpConfigFile: string): { command: string; timeoutSec: number } | undefined {
  if (member.permissionMode === "bypassPermissions" || bins.toolPermission !== true || process.env.IAMCEO_TOOL_PERMISSION === "0") return undefined;
  try { return permissionHook({ runDir: join(home, "run"), mcpConfigFile }); } catch { return undefined; }
}

export function providerFor(member: RunnerMember): CoreProvider { return member.cli ?? "claude"; }

/** 이 CLI 로 띄울 실행 파일(설정값, 없으면 기본 이름). gemini 의 기본은 `agy` 다: 값 이름("gemini")을 명령으로 쓰면 옛 Gemini CLI 가 불린다. */
export function providerBin(provider: CoreProvider, bins: ProviderBins): string {
  switch (provider) {
    case "claude": return bins.claudeBin || CLI_INFO.claude.program;
    case "codex": return bins.codexBin || CLI_INFO.codex.program;
    case "gemini": return bins.geminiBin || CLI_INFO.gemini.program;
    default: { const unlisted: never = provider; throw new CoreError("config", `Unknown CLI provider: ${String(unlisted)}`); }
  }
}

/**
 * Antigravity CLI(`agy`) 명령줄. 지침·MCP·훅은 팀장의 주입 폴더(--add-dir)에 쓰고, 나머지는 --settings 한 줄로 넘긴다(gemini-inject.ts).
 * `agy [--conversation <id>] --add-dir <주입 폴더> --settings '<JSON>' [--model <id> [--effort <e>]] [권한 플래그]`
 * - 새 대화의 id 는 agy 가 정한다(미리 줄 수 없다). 그래서 새 세션은 sessionId null 이고, id 는 상태줄 기록(없으면 훅 기록)으로 알아낸다(CoreRunner).
 * - effort 는 모델을 정했을 때만 넘긴다. 모델 없이 --effort 만 주면 agy 가 사용자의 기본 모델로 판정하고, 그 모델이 그 값을 받지 않으면 뜨지 못한다
 *   (1.5.14 실측: `--effort max` → exit 1 `gemini-4-neon has no "max" effort`. 기본 모델은 사용자마다 다르다).
 * - 띄울 때마다 임의 값을 만들어 상태줄 명령의 인자와 터미널 라벨(GEMINI_LAUNCH_LABEL)에 함께 싣는다.
 * - 서브에이전트 모델(subagentModel)은 agy 에 넘길 길이 없어 쓰지 않는다. Claude 용 설정 파일(opts.settingsFile)도 쓰지 않는다.
 * - 상태 보고(OSC 7501)는 AGY_CLI_OSC7501=on 으로 늘 켠다. MCP 서버의 열쇠는 프로세스 환경·명령줄이 아니라 주입 폴더 옆의 환경 파일(0600)에 둔다(gemini-inject.ts).
 */
function geminiLaunch(member: RunnerMember, opts: StartOpts, bins: ProviderBins, bin: string): ProviderLaunch {
  // agy 도 대화 id 를 스스로 정한다. 모르는 채로 '이어 열기'를 하면 조용히 새 대화가 된다.
  if (opts.resume && !member.sessionId) throw new CoreError("session_unknown", "Antigravity conversation id is unknown; reattach the existing core terminal or explicitly start a fresh session");
  const events = bins.hookEvents ?? process.env.IAMCEO_HOOK_EVENTS !== "0";
  // 경로로 쓸 수 없는 팀장 id·상대 경로면 여기서 던진다(띄우지 않는다). 아래의 '빼고 띄웁니다' 줄이 띄우지도 않을 것에 남지 않게 먼저 본다.
  const plannedInjectDir = geminiInjectDir(opts.systemPromptFile, member.id);
  // 훅·상태줄을 만들지 못해도 CLI 는 띄운다(기록이 없을 뿐이다). 지침·MCP 를 쓰지 못하면 띄우지 않는다.
  // 훅은 장치마다 따로 만든다(gemini-hooks.ts geminiHooksFile): 한 장치를 만들지 못해도 나머지는 그대로 싣는다.
  const hookSets: GeminiHookSet[] = [];
  // 만들지 못한 것은 서버 기록에 한 줄 남긴다: 그 세션은 뜨지만 대화 id·문맥 %·전달 수신 확인의 근거가 줄어든다. 까닭은 오류 종류만 적는다(경로·열쇠는 적지 않는다).
  const why = (error: unknown): string => (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.name : "error");
  if (bins.contextHome && events) {
    try { hookSets.push(geminiRecorderHookSet({ memberId: member.id, eventsDir: geminiHookEventsDir(bins.contextHome) })); }
    catch (error) { console.warn(`[gemini] ${member.id}: 훅 기록을 만들지 못해 훅 없이 띄웁니다. 전달 수신 확인과 대화 id 의 둘째 근거(훅 기록)가 없습니다 (${why(error)})`); }
  }
  // 도구 호출 직전 판정(작업 폴더 바로잡기). 사건 기록과 따로다: IAMCEO_HOOK_EVENTS=0 이어도 싣는다(산출물이 주입 폴더에 생기지 않게).
  if (bins.contextHome) {
    try { hookSets.push(geminiToolHookSet({ runDir: join(bins.contextHome, "run"), cwd: member.cwd, injectDir: plannedInjectDir })); }
    catch (error) { console.warn(`[gemini] ${member.id}: 도구 훅을 만들지 못해 빼고 띄웁니다. 작업 폴더 바로잡기가 없습니다 (${why(error)})`); }
  }
  const injectDir = writeGeminiInjectDir({ memberId: member.id, systemPromptFile: opts.systemPromptFile, mcpConfigFile: opts.mcpConfigFile, cwd: member.cwd, hooks: geminiHooksFile(...hookSets) });
  // 이 띄우기의 값. 상태줄 명령이 기록마다 적고, 실행기는 터미널 라벨의 같은 값으로 이 터미널의 기록을 가려낸다.
  const launchId = crypto.randomUUID().replaceAll("-", "");
  let statusLine: { type: "command"; command: string } | null = null;
  if (bins.contextHome) {
    try { statusLine = geminiStatusLine(bins.contextHome, member.id, { launch: launchId }); }
    catch (error) { console.warn(`[gemini] ${member.id}: 상태줄 명령을 만들지 못해 상태줄 없이 띄웁니다. 대화 id·문맥 %·한도를 상태줄 기록으로 알 수 없습니다 (${why(error)})`); }
  }
  const args: string[] = [];
  if (opts.resume && member.sessionId) args.push("--conversation", member.sessionId);
  args.push("--add-dir", injectDir, "--settings", JSON.stringify(geminiSettings({ cwd: member.cwd, injectDir, permissionMode: member.permissionMode, autoFallback: member.geminiAutoFallback === true, statusLine })));
  // 모델을 정하지 않았으면 effort 도 넘기지 않는다(위 설명): agy 의 기본 모델·기본 effort 로 뜬다.
  if (member.model) {
    args.push("--model", member.model);
    if (member.effort) args.push("--effort", member.effort);
  }
  // default(전부 묻기)·auto 는 플래그가 없다: 위 설정의 agentMode("" · "auto", 대신하는 모드면 "accept-edits")가 그 뜻이다.
  if (member.permissionMode === "bypassPermissions") args.push("--dangerously-skip-permissions");
  return { argv: [bin, ...args], env: { AGY_CLI_OSC7501: "on", IAMCEO_MEMBER_ID: member.id }, sessionId: opts.resume ? member.sessionId : null, labels: { [GEMINI_LAUNCH_LABEL]: launchId } };
}

export function providerLaunch(member: RunnerMember, opts: StartOpts, bins: ProviderBins = {}): ProviderLaunch {
  const provider = providerFor(member);
  if (member.sessionId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(member.sessionId)) throw new CoreError("invalid_session", "Invalid CLI session id");
  const configured = providerBin(provider, bins);
  const bin = configured.includes("/") ? configured : Bun.which(configured);
  if (!bin) throw new CoreError("unavailable", `${provider} executable not found: ${configured}`);
  const args: string[] = [];
  const env: Record<string, string> = {};
  if (provider === "claude") {
    const sessionId = member.sessionId || crypto.randomUUID();
    args.push(opts.resume && member.sessionId ? "--resume" : "--session-id", sessionId,
      "--append-system-prompt-file", opts.systemPromptFile, "--mcp-config", opts.mcpConfigFile,
      "--permission-mode", member.permissionMode, "--allowedTools", "mcp__iamceo", "-n", member.name);
    if (member.model) args.push("--model", member.model);
    if (member.effort) args.push("--effort", member.effort);
    if (bins.contextHome) {
      const settings = opts.settingsFile ? JSON.parse(readFileSync(opts.settingsFile, "utf8")) : {};
      // E1: 훅은 statusLine 과 같은 --settings 하나에 합친다. 사용자가 넘긴 설정의 hooks 는 덮지 않고 잇는다.
      const hooks = claudeHooks(member, bins.contextHome, bins, opts.mcpConfigFile);
      args.push("--settings", JSON.stringify({ ...settings, statusLine: writeStatuslineWrapper(bins.contextHome), ...(hooks ? { hooks: mergeHooks(settings.hooks, hooks) } : {}) }));
    } else if (opts.settingsFile) args.push("--settings", opts.settingsFile);
    Object.assign(env, subagentEnv(member.subagentModel));
    // Claude Code 2.1.3xx shows a dim follow-up suggestion inside an empty composer. core's terminal.read is plain
    // text, so the suggestion reads exactly like a half-typed draft and blocks safe input. Off for this process only.
    env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = "false";
    return { argv: [bin, ...args], env, sessionId };
  }
  if (provider === "gemini") return geminiLaunch(member, opts, bins, bin);
  // 여기부터는 Codex 뿐이다. CLI 를 더하면 이 줄이 컴파일 오류가 되어 가지를 따로 만들게 한다.
  provider satisfies "codex";
  // Codex owns its native id; inventing one would make resume silently wrong.
  if (opts.resume && !member.sessionId) throw new CoreError("session_unknown", "Codex session id is unknown; reattach the existing core terminal or explicitly start a fresh session");
  if (member.subagentModel) args.push("-c", `agents.default_subagent_model=${toml(member.subagentModel)}`);
  args.push("-c", "features.multi_agent=true");
  // Codex 0.166 opens an "Update available" menu on start whose default item runs `npm install -g @openai/codex`.
  // Under IAMCEO that menu only stalls the member (and one stray Enter would upgrade a global CLI). Off per process.
  args.push("-c", "check_for_update_on_startup=false");
  if (member.permissionMode === "bypassPermissions") args.push("--dangerously-bypass-approvals-and-sandbox");
  else if (member.permissionMode === "auto") args.push("--approve-for-me");
  else args.push("--ask-for-approval", "on-request");
  if (member.model) args.push("--model", member.model);
  if (member.effort) {
    args.push("-c", `model_reasoning_effort=${toml(member.effort)}`);
  }
  args.push("-c", `developer_instructions=${toml(readFileSync(opts.systemPromptFile, "utf8"))}`);
  const config = JSON.parse(readFileSync(opts.mcpConfigFile, "utf8")) as { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> };
  const bridge = config.mcpServers?.iamceo;
  if (!bridge?.command || !Array.isArray(bridge.args) || bridge.args.some((arg) => typeof arg !== "string")) throw new CoreError("config", "IAMCEO MCP bridge must use a stdio command and args");
  args.push("-c", `mcp_servers.iamceo.command=${toml(bridge.command)}`, "-c", `mcp_servers.iamceo.args=[${bridge.args.map(toml).join(",")}]`);
  const bridgeEnvironment = Object.entries(bridge.env || {});
  for (const [key, value] of bridgeEnvironment) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string") throw new CoreError("config", `Invalid MCP environment value: ${key}`);
    env[key] = value;
  }
  // Forward named environment variables instead of exposing bearer tokens in
  // the CLI argv/process list. Codex's MCP env_vars is invocation-scoped.
  args.push("-c", `mcp_servers.iamceo.env_vars=[${bridgeEnvironment.map(([key]) => toml(key)).join(",")}]`);
  if (opts.resume && member.sessionId) args.push("resume", member.sessionId);
  return { argv: [bin, ...args], env, sessionId: opts.resume ? member.sessionId : null };
}

/**
 * 이 터미널의 프로그램이 그 CLI 인가. 실행 파일 이름(CLI_INFO 의 program: claude·codex·agy)이거나 설정한 실행 파일과 같아야 한다.
 * gemini 는 값 이름과 실행 파일 이름이 달라 값 이름으로 견주면 늘 어긋난다.
 */
export function isProviderArgv(argv: string[], provider: CoreProvider, bin?: string): boolean {
  return argv.length > 0 && (basename(argv[0]) === CLI_INFO[provider].program || (!!bin && argv[0] === bin));
}
