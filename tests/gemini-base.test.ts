// Gemini(Antigravity CLI) 지원의 공통 바탕: CLI 표, 직급표 고르기, 설정(geminiBin·geminiHome).
// 진짜 agy 는 띄우지 않는다. 실행 파일은 임시 폴더의 가짜이고 경로만 찾는다(실행하지 않는다).
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGeminiHome, loadConfig, updateConfigFile } from "../server/config.ts";
import type { DeliveryReceipt, RunnerMember } from "../server/runner/types.ts";
import {
  CLI_INFO, CLI_PROVIDERS, CODEX_EFFORTS, DEFAULT_CODEX_RANKS, DEFAULT_GEMINI_RANKS, DEFAULT_RANKS, EFFORTS, GEMINI_EFFORTS, memberConfig, ranksFor, ranksKey,
  type CliAccountCli, type CliProvider, type DeliveryEvidence, type Ranks, type RuntimeInfo, type Settings, type SettingsPatch,
} from "../shared/types.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp(): string { const dir = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-gemini-base-"))); dirs.push(dir); return dir; }
function fakeBin(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 97\n");
  chmodSync(path, 0o755);
  return path;
}

describe("CLI 표", () => {
  test("세 CLI 를 이 순서로 싣고, gemini 의 실행 파일 이름은 agy 다", () => {
    expect([...CLI_PROVIDERS]).toEqual(["claude", "codex", "gemini"]);
    expect(Object.keys(CLI_INFO)).toEqual([...CLI_PROVIDERS]);
    expect(CLI_INFO).toEqual({
      claude: { short: "Claude", name: "Claude Code", program: "claude" },
      codex: { short: "Codex", name: "Codex", program: "codex" },
      gemini: { short: "Gemini", name: "Antigravity CLI", program: "agy" },
    });
    // "gemini" 를 명령 이름으로 쓰면 옛 Gemini CLI 가 불린다.
    expect(CLI_INFO.gemini.program).not.toBe("gemini");
  });

  test("effort 목록: Claude·Codex 는 그대로, Gemini 는 agy --effort 가 받는 값", () => {
    expect([...EFFORTS]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect([...CODEX_EFFORTS]).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect([...GEMINI_EFFORTS]).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("타입: gemini 는 팀장의 CLI 이지만 로그인 대상은 아니고, 런타임 정보에는 깔렸을 때만 실린다", () => {
    const cli: CliProvider = "gemini";
    const member: Pick<RunnerMember, "cli"> = { cli };
    const receipt: DeliveryReceipt["source"] = "gemini_log";
    const evidence: DeliveryEvidence["source"] = "gemini_log";
    // @ts-expect-error gemini 로그인은 다루지 않는다
    const account: CliAccountCli = "gemini";
    const without: RuntimeInfo["providers"] = { claude: { installed: true }, codex: { installed: false } };
    const withGemini: RuntimeInfo["providers"] = { ...without, gemini: { installed: true } };
    // @ts-expect-error claude·codex 는 늘 실린다
    const missing: RuntimeInfo["providers"] = { claude: { installed: true } };
    const patch: SettingsPatch = { geminiRanks: { lead: { model: "gemini-4-neon" } } };
    const reset: NonNullable<Settings["resetEfforts"]> = ["ranks.lead.effort", "codexRanks.manager.effort", "geminiRanks.staff.effort"];
    expect([member.cli, receipt, evidence, account, without.gemini, withGemini.gemini?.installed, Object.keys(missing), patch.geminiRanks?.lead?.model, reset.length])
      .toEqual(["gemini", "gemini_log", "gemini_log", "gemini", undefined, true, ["claude"], "gemini-4-neon", 3]);
  });
});

describe("직급표 고르기", () => {
  const ranks: Ranks = { manager: { model: "opus", effort: "max" }, lead: { model: "sonnet", effort: "high" }, staff: { model: "haiku", effort: null } };
  const codexRanks: Ranks = { manager: { model: "gpt-6.1-sol", effort: "xhigh" }, lead: { model: "gpt-6-luna", effort: "low" }, staff: { model: null, effort: "minimal" } };
  const geminiRanks: Ranks = { manager: { model: "gemini-4-neon", effort: "xhigh" }, lead: { model: "gemini-4-argon", effort: "medium" }, staff: { model: "gemini-3.8-flash", effort: null } };
  const settings = { ranks, codexRanks, geminiRanks };
  const worker = { kind: "worker" as const, modelOverride: null, effortOverride: null };

  test("ranksKey·ranksFor: CLI 마다 자기 표, cli 가 없으면 Claude", () => {
    expect([ranksKey("claude"), ranksKey("codex"), ranksKey("gemini"), ranksKey(undefined)]).toEqual(["ranks", "codexRanks", "geminiRanks", "ranks"]);
    expect(ranksFor("claude", settings)).toBe(ranks);
    expect(ranksFor(undefined, settings)).toBe(ranks);
    expect(ranksFor("codex", settings)).toBe(codexRanks);
    expect(ranksFor("gemini", settings)).toBe(geminiRanks);
    // 타입 밖의 값(저장된 옛 행)은 지금까지처럼 Claude 표다.
    expect(ranksKey("other" as never)).toBe("ranks");
    expect(ranksKey(null as never)).toBe("ranks");
  });

  test("기본 직급표는 전부 null(= CLI 기본 모델)이고 다른 CLI 의 기본표와 따로 든 값이다", () => {
    expect(DEFAULT_GEMINI_RANKS).toEqual({ manager: { model: null, effort: null }, lead: { model: null, effort: null }, staff: { model: null, effort: null } });
    expect(DEFAULT_GEMINI_RANKS).not.toBe(DEFAULT_RANKS);
    expect(DEFAULT_GEMINI_RANKS).not.toBe(DEFAULT_CODEX_RANKS);
  });

  test("memberConfig: gemini 팀장은 geminiRanks 를 쓰고, Claude·Codex 는 예전과 같다", () => {
    expect(memberConfig({ ...worker, cli: "gemini" }, ranks, codexRanks, geminiRanks)).toEqual({ model: "gemini-4-argon", effort: "medium" });
    expect(memberConfig({ ...worker, cli: "gemini", kind: "conductor" }, ranks, codexRanks, geminiRanks)).toEqual({ model: "gemini-4-neon", effort: "xhigh" });
    expect(memberConfig({ ...worker, cli: "gemini", kind: "root" }, ranks, codexRanks, geminiRanks)).toEqual({ model: "gemini-4-neon", effort: "xhigh" });
    // 팀장별 지정이 직급 기본을 이긴다.
    expect(memberConfig({ ...worker, cli: "gemini", modelOverride: "gemini-4-hydrogen" }, ranks, codexRanks, geminiRanks)).toEqual({ model: "gemini-4-hydrogen", effort: "medium" });
    expect(memberConfig({ ...worker, cli: "gemini", effortOverride: "low" }, ranks, codexRanks, geminiRanks)).toEqual({ model: "gemini-4-argon", effort: "low" });
    // 넷째 인자가 있어도 Claude·Codex 는 자기 표를 쓴다.
    expect(memberConfig({ ...worker, cli: "claude" }, ranks, codexRanks, geminiRanks)).toEqual({ model: "sonnet", effort: "high" });
    expect(memberConfig(worker, ranks, codexRanks, geminiRanks)).toEqual({ model: "sonnet", effort: "high" });
    expect(memberConfig({ ...worker, cli: "codex" }, ranks, codexRanks, geminiRanks)).toEqual({ model: "gpt-6-luna", effort: "low" });
    expect(memberConfig({ ...worker, cli: "codex" }, ranks)).toEqual({ model: null, effort: null });
  });

  test("memberConfig: geminiRanks 를 넘기지 않은 옛 호출에서 gemini 팀장은 Claude·Codex 모델을 받지 않는다", () => {
    expect(memberConfig({ ...worker, cli: "gemini" }, ranks, codexRanks)).toEqual({ model: null, effort: null });
    expect(memberConfig({ ...worker, cli: "gemini", kind: "conductor" }, ranks)).toEqual({ model: null, effort: null });
  });
});

describe("설정: geminiBin·geminiHome", () => {
  function home(file: Record<string, unknown> = {}): { userHome: string; env: Record<string, string>; configPath: string } {
    const userHome = temp();
    const appHome = join(userHome, "app");
    mkdirSync(appHome, { mode: 0o700 });
    const env = { IAMCEO_HOME: appHome, HOME: userHome, PATH: "/usr/bin:/bin", IAMCEO_CLAUDE_BIN: "/usr/bin/false", IAMCEO_CODEX_BIN: "/usr/bin/false" };
    updateConfigFile({ accessCode: "abc", hosts: ["127.0.0.1"] }, env);
    const configPath = join(appHome, "config.json");
    if (Object.keys(file).length) writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, "utf8")), ...file }), { mode: 0o600 });
    return { userHome, env, configPath };
  }

  test("환경 변수가 설정 파일을 이기고, 찾지 못한 경로는 적은 그대로 둔다", () => {
    const { userHome, env } = home();
    const fromEnv = fakeBin(join(userHome, "tools", "agy-env"));
    const fromFile = fakeBin(join(userHome, "tools", "agy-file"));
    updateConfigFile({ geminiBin: fromFile, geminiHome: join(userHome, "gemini-file") }, env);
    expect(loadConfig(env)).toMatchObject({ geminiBin: fromFile, geminiHome: join(userHome, "gemini-file") });
    expect(loadConfig({ ...env, IAMCEO_GEMINI_BIN: fromEnv, IAMCEO_GEMINI_HOME: join(userHome, "gemini-env") })).toMatchObject({ geminiBin: fromEnv, geminiHome: join(userHome, "gemini-env") });
    expect(loadConfig({ ...env, IAMCEO_GEMINI_BIN: "/missing/explicit-agy" }).geminiBin).toBe("/missing/explicit-agy");
    // 다른 CLI 의 값은 그대로다.
    expect(loadConfig(env)).toMatchObject({ claudeBin: "/usr/bin/false", codexBin: "/usr/bin/false" });
  });

  test("적지 않으면 agy 를 PATH 와 흔한 설치 폴더에서 찾는다(gemini 라는 이름은 찾지 않는다)", () => {
    const { userHome, env } = home();
    // 옛 Gemini CLI 가 같은 자리에 있어도 고르지 않는다.
    fakeBin(join(userHome, ".local", "bin", "gemini"));
    const agy = fakeBin(join(userHome, ".local", "bin", "agy"));
    const config = loadConfig(env);
    expect(config.geminiBin).toBe(agy);
    expect(config.geminiHome).toBeUndefined();
    const onPath = fakeBin(join(userHome, "first", "agy"));
    expect(loadConfig({ ...env, PATH: `${join(userHome, "first")}:/usr/bin:/bin` }).geminiBin).toBe(onPath);
  });

  test("설정 파일의 geminiBin 이 글이 아니면 다른 실행 파일 칸처럼 거절한다", () => {
    for (const bad of [7, "", null, ["agy"], "a\0b"]) {
      const { env } = home({ geminiBin: bad });
      expect(() => loadConfig(env)).toThrow("geminiBin");
    }
  });

  test("defaultGeminiHome: IAMCEO_GEMINI_HOME 이 있으면 그 값, 없으면 ~/.gemini/antigravity-cli", () => {
    expect(defaultGeminiHome({ HOME: "/Users/tester" })).toBe("/Users/tester/.gemini/antigravity-cli");
    expect(defaultGeminiHome({ HOME: "/Users/tester", IAMCEO_GEMINI_HOME: "/tmp/agy-home" })).toBe("/tmp/agy-home");
    expect(defaultGeminiHome({ HOME: "/Users/tester", IAMCEO_GEMINI_HOME: "" })).toBe("/Users/tester/.gemini/antigravity-cli");
  });
});
