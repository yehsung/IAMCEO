// Provider CLIs remain interactive and load their ordinary user/project settings.
// IAMCEO additions are invocation-scoped; no global CLI configuration is changed.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { RunnerMember, StartOpts } from "./types.ts";
import { CoreError } from "./core-client.ts";
import { subagentEnv } from "./headless.ts";

export type CoreProvider = "claude" | "codex";
export interface ProviderLaunch { argv: string[]; env: Record<string, string>; sessionId: string | null }
export interface ProviderBins { claudeBin?: string; codexBin?: string }
const sessionPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const toml = (value: unknown) => JSON.stringify(value);

export function providerFor(member: RunnerMember): CoreProvider { return member.cli ?? "claude"; }
export function providerLaunch(member: RunnerMember, opts: StartOpts, bins: ProviderBins = {}): ProviderLaunch {
  const provider = providerFor(member);
  if (member.sessionId && !sessionPattern.test(member.sessionId)) throw new CoreError("invalid_session", "Invalid CLI session id");
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
    if (opts.settingsFile) args.push("--settings", opts.settingsFile);
    Object.assign(env, subagentEnv(member.subagentModel));
    return { argv: [bin, ...args], env, sessionId };
  }
  // Codex owns its native id; inventing one would make resume silently wrong.
  if (opts.resume && !member.sessionId) throw new CoreError("session_unknown", "Codex session id is unknown; reattach the existing core terminal or explicitly start a fresh session");
  if (member.subagentModel) args.push("-c", `agents.default_subagent_model=${toml(member.subagentModel)}`);
  args.push("-c", "features.multi_agent=true");
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
