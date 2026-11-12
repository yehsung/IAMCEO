// Provider CLIs remain interactive and load their ordinary user/project settings.
// IAMCEO additions are invocation-scoped; no global CLI configuration is changed.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { RunnerMember, StartOpts } from "./types.ts";
import { CoreError } from "./core-client.ts";
import { writeStatuslineWrapper } from "./statusline.ts";
import { hookEventsDir, hookSettings, mergeHooks } from "./hooks.ts";
import { permissionHook } from "./permission-hook.ts";
import { subagentEnv } from "./env.ts";

export type CoreProvider = "claude" | "codex";
export interface ProviderLaunch { argv: string[]; env: Record<string, string>; sessionId: string | null }
export interface ProviderBins {
  claudeBin?: string; codexBin?: string; contextHome?: string;
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
export function providerLaunch(member: RunnerMember, opts: StartOpts, bins: ProviderBins = {}): ProviderLaunch {
  const provider = providerFor(member);
  if (member.sessionId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(member.sessionId)) throw new CoreError("invalid_session", "Invalid CLI session id");
  const configured = provider === "claude" ? bins.claudeBin || "claude" : bins.codexBin || "codex";
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

export function isProviderArgv(argv: string[], provider: CoreProvider, bin?: string): boolean {
  return argv.length > 0 && (basename(argv[0]) === provider || (!!bin && argv[0] === bin));
}
