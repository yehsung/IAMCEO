import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CliProvider, Member, PatchMemberReq, RanksKey, Settings, SettingsPatch } from "../shared/types.ts";
import { ApiError } from "./store.ts";
import { resolveCliExecutable } from "./config.ts";
import { CODEX_EFFORTS, EFFORTS, GEMINI_EFFORTS, isGeminiSubagentTier, memberRank, ranksFor } from "../shared/types.ts";
import { ERROR_CODES } from "../shared/error-codes.ts";
import { withoutGeminiRemote as agyEnvWithoutSsh } from "./runner/env.ts";

export interface ModelOption {
  value: string;
  label: string;
  description?: string;
  efforts: string[];
  defaultEffort?: string;
}
export interface ModelList {
  models: ModelOption[];
  source: "cli" | "default";
  updatedAt?: string;
}
/** gemini 는 Antigravity CLI(`agy`)의 목록이다. 늘 채운다(캐시가 없으면 기본 목록). 이 칸을 모르는 출시 앱은 무시한다. */
export interface ModelCatalog { claude: ModelList; codex: ModelList; gemini: ModelList }

const validName = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,127}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const description = (value: unknown): { description?: string } => typeof value === "string" ? { description: value } : {};
/**
 * `agy models` 캐시가 없을 때 쓰는 Gemini 기본 목록(agy 1.5.14 에서 본 값). 값은 effort 를 뗀 기본 id 다:
 * agy 에는 `--model <기본 id> --effort <e>` 로 넘긴다(effort 를 안 주면 medium).
 */
const GEMINI_DEFAULT_MODELS: ReadonlyArray<{ value: string; label: string; efforts: readonly string[] }> = [
  { value: "gemini-4-neon", label: "Gemini 4 Neon", efforts: ["low", "medium", "high", "xhigh"] },
  { value: "gemini-4-argon", label: "Gemini 4 Argon", efforts: ["low", "medium", "high"] },
  { value: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", efforts: ["low", "medium", "high", "xhigh"] },
  { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"] },
];
/** agy 가 effort 없이 띄운 모델에 쓰는 값. 그 모델의 effort 목록에 있을 때만 defaultEffort 로 적는다. */
const GEMINI_DEFAULT_EFFORT = "medium";

function defaults(cli: CliProvider): ModelList {
  switch (cli) {
    case "claude": return { source: "default", models: ["opus", "sonnet", "haiku"].map(value => ({ value, label: value[0]!.toUpperCase() + value.slice(1), efforts: [...EFFORTS] })) };
    case "codex": return { source: "default", models: ["gpt-6.1-sol", "gpt-6-luna", "gpt-6.1-terra", "gpt-6-astra"].map(value => ({ value, label: value, efforts: [...CODEX_EFFORTS] })) };
    case "gemini": return { source: "default", models: GEMINI_DEFAULT_MODELS.map(model => ({ value: model.value, label: model.label, efforts: [...model.efforts], defaultEffort: GEMINI_DEFAULT_EFFORT })) };
    // CLI 를 더하면 아래 줄이 컴파일 오류가 되어 여기를 고치게 한다.
    default: { const unlisted: never = cli; throw new Error(`Unknown CLI: ${String(unlisted)}`); }
  }
}

/**
 * effort 가 없는 모델(또는 모델을 정하지 않았을 때)에 그 CLI 가 받는 effort 값.
 * Gemini 는 목록에 없는 모델 이름(지워진 옛 값)에만 쓴다: 모델을 정하지 않은 Gemini 는 effort 를 받지 않는다(ModelCatalogReader.efforts).
 */
function fallbackEfforts(cli: CliProvider): readonly string[] {
  switch (cli) {
    case "codex": return CODEX_EFFORTS;
    case "gemini": return GEMINI_EFFORTS;
    case "claude": return EFFORTS;
    // 타입 밖의 값(저장된 옛 행)은 지금까지처럼 Claude 값이다.
    default: { const unlisted: never = cli; void unlisted; return EFFORTS; }
  }
}

function claudeModels(data: unknown): ModelOption[] {
  // Account settings are never retained in the cache or copied into the response.
  const options = record(data) ? data.additionalModelOptionsCache : undefined;
  if (!Array.isArray(options)) throw new Error("Missing model options");
  const models = defaults("claude").models;
  for (const option of options) {
    if (!record(option) || !validName(option.value) || typeof option.label !== "string") continue;
    if (models.some(model => model.value === option.value)) continue;
    models.push({ value: option.value, label: option.label, ...description(option.description), efforts: [...EFFORTS] });
  }
  return models;
}

function codexModels(data: unknown): ModelOption[] {
  if (!record(data) || !Array.isArray(data.models)) throw new Error("Missing models");
  const models: ModelOption[] = [];
  const visible = data.models.filter(record).filter(model => model.visibility === "list")
    .sort((a, b) => (typeof a.priority === "number" ? a.priority : Infinity) - (typeof b.priority === "number" ? b.priority : Infinity));
  for (const model of visible) {
    if (!validName(model.slug) || !Array.isArray(model.supported_reasoning_levels)) continue;
    const efforts = [...new Set(model.supported_reasoning_levels.filter(record).map(level => level.effort).filter((effort): effort is string => typeof effort === "string" && effort.length > 0))];
    if (models.some(option => option.value === model.slug)) continue;
    models.push({ value: model.slug, label: typeof model.display_name === "string" ? model.display_name : model.slug,
      ...description(model.description), efforts,
      ...(typeof model.default_reasoning_level === "string" && efforts.includes(model.default_reasoning_level) ? { defaultEffort: model.default_reasoning_level } : {}),
    });
  }
  if (!models.length) throw new Error("No usable models");
  return models;
}

// ---- Gemini(Antigravity CLI): `agy models` 출력 → 캐시 파일 → 목록 ----
// agy 는 모델 목록을 파일로 두지 않는다. 서버가 뒤에서 `agy models` 를 띄워 <IAMCEO_HOME>/cache/gemini-models.json 에 적어 두고,
// 목록 읽기(ModelCatalogReader)는 Claude·Codex 처럼 그 파일만 본다(요청 중에 CLI 를 띄우지 않는다).

/** 캐시 파일의 자리. home 은 IAMCEO 데이터 홈(Config.home)이다. */
export function geminiModelsCachePath(home: string): string { return join(home, "cache", "gemini-models.json"); }
/** 갱신 간격. 서버가 뜬 뒤 한 번, 그 뒤로 이 간격마다 다시 묻는다. */
export const GEMINI_MODELS_REFRESH_MS = 6 * 60 * 60_000;
/**
 * 캐시가 없을 때(agy 를 나중에 깔았거나 앞 시도가 실패) 다시 해 보는 간격. 실패가 이어지면 차례로 벌리고, 다 쓰면 갱신 간격(6시간)이다:
 * 로그인하지 않은 Mac 에서 `agy models` 를 10분마다 영영 띄우지 않는다. agy 가 아직 없을 때는 띄우지 않으므로 첫 간격으로만 다시 본다.
 */
export const GEMINI_MODELS_RETRY_STEPS_MS: readonly number[] = [10 * 60_000, 30 * 60_000, 60 * 60_000, 120 * 60_000];
/** `agy models` 가 이보다 늦으면 끊는다(계정에 물어 오는 명령이라 네트워크가 느리면 걸린다). */
export const GEMINI_MODELS_TIMEOUT_MS = 15_000;
const GEMINI_MODELS_MAX = 200;
const GEMINI_OUTPUT_MAX = 256 * 1024;
const GEMINI_LABEL_MAX = 120;
/** id 끝의 effort(`gemini-4-neon-high`)와 이름 끝의 effort(`Gemini 4 Neon (High)`). 둘이 같은 값일 때만 effort 로 본다. */
const AGY_EFFORT_ID = /^(.+)-(low|medium|high|xhigh|max)$/;
const AGY_EFFORT_LABEL = /^(.*\S)\s*\((low|medium|high|xhigh|max)\)$/i;
const ANSI_SEQUENCE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const cleanLabel = (value: string): string => value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, GEMINI_LABEL_MAX);
const orderedEfforts = (efforts: Iterable<string>): string[] => {
  const known: readonly string[] = GEMINI_EFFORTS, seen = new Set(efforts);
  return [...known.filter(effort => seen.has(effort)), ...[...seen].filter(effort => !known.includes(effort))];
};
const geminiOption = (value: string, label: string, efforts: string[]): ModelOption =>
  ({ value, label, efforts, ...(efforts.includes(GEMINI_DEFAULT_EFFORT) ? { defaultEffort: GEMINI_DEFAULT_EFFORT } : {}) });

/**
 * `agy models` 의 출력 글을 모델 목록으로 바꾼다. 줄은 `id<TAB>이름` 이고, 탭이 없는 줄(첫 줄 `Fetching available models...` 등)은 버린다.
 * id 끝의 `-low|-medium|-high|-xhigh|-max` 와 이름 끝의 `(Low|Medium|High|XHigh|Max)` 가 같은 값이면 그것이 effort 다:
 * 기본 id 로 묶어 `gemini-4-neon-{low,medium,high,xhigh}` → { value: "gemini-4-neon", label: "Gemini 4 Neon", efforts: [low, medium, high, xhigh] }.
 * 둘이 맞지 않으면 effort 가 없는 모델로 그대로 싣는다(id 가 우연히 -max 로 끝나는 모델을 자르지 않는다). agy 가 주는 모델을 모두 싣고
 * (Claude·GPT-OSS 포함) 순서는 agy 가 준 순서다. effort 는 낮은 것부터 늘어놓는다.
 */
export function parseAgyModels(text: string): ModelOption[] {
  const found = new Map<string, { label: string; efforts: Set<string> }>();
  for (const raw of text.slice(0, GEMINI_OUTPUT_MAX).split(/\r?\n/)) {
    const line = raw.replace(ANSI_SEQUENCE, "");
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const id = line.slice(0, tab).trim(), name = cleanLabel(line.slice(tab + 1));
    if (!validName(id) || !name) continue;
    const idEffort = AGY_EFFORT_ID.exec(id), nameEffort = AGY_EFFORT_LABEL.exec(name);
    const effort = idEffort && nameEffort && idEffort[2] === nameEffort[2]!.toLowerCase() ? idEffort[2]! : null;
    const value = effort ? idEffort![1]! : id;
    const label = effort ? cleanLabel(nameEffort![1]!) : name;
    if (!validName(value) || !label) continue;
    let entry = found.get(value);
    if (!entry) {
      if (found.size >= GEMINI_MODELS_MAX) continue;
      found.set(value, entry = { label, efforts: new Set() });
    }
    if (effort) entry.efforts.add(effort);
  }
  return [...found].map(([value, entry]) => geminiOption(value, entry.label, orderedEfforts(entry.efforts)));
}

/** 캐시 파일(writeGeminiModelsCache 가 쓴 것)을 목록으로 읽는다. 모양이 다른 줄은 버리고, 쓸 모델이 하나도 없으면 던진다(기본 목록을 쓴다). */
function geminiModels(data: unknown): ModelOption[] {
  if (!record(data) || data.v !== 1 || !Array.isArray(data.models)) throw new Error("Missing models");
  const models: ModelOption[] = [];
  for (const model of data.models.slice(0, GEMINI_MODELS_MAX)) {
    if (!record(model) || !validName(model.value) || typeof model.label !== "string" || !Array.isArray(model.efforts)) continue;
    const label = cleanLabel(model.label);
    if (!label || models.some(option => option.value === model.value)) continue;
    const efforts = orderedEfforts(model.efforts.filter((effort): effort is string => typeof effort === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(effort)));
    models.push(geminiOption(model.value, label, efforts));
  }
  if (!models.length) throw new Error("No usable models");
  return models;
}

/** 캐시를 쓴다(임시 파일 → rename, 0600). 폴더가 없으면 만든다. 실패하면 던지고 예전 파일은 그대로 남는다. */
export function writeGeminiModelsCache(path: string, models: ModelOption[], now: Date): void {
  const temp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temp, `${JSON.stringify({ v: 1, updatedAt: now.toISOString(), models }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    try { if (existsSync(temp)) unlinkSync(temp); } catch { /* 다음 갱신이 다시 쓴다 */ }
    throw error;
  }
}

/** `agy models` 를 한 번 띄운 결과. exitCode null 은 제한 시간 안에 끝나지 않아 끊은 것이다. */
export interface AgyModelsRun { exitCode: number | null; stdout: string }
/** 실행 파일을 띄우는 부분. 시험은 가짜를 넣는다(실제 agy 를 띄우지 않는다). */
export type AgyModelsSpawn = (bin: string, timeoutMs: number) => Promise<AgyModelsRun>;
/**
 * not_installed: 실행 파일이 없어 띄우지 않았다 · timeout: 제한 시간에 끊었다 · failed: 띄우지 못했거나 0 아닌 종료 ·
 * empty: 읽을 모델이 없었다 · write_failed: 캐시를 쓰지 못했다. 실패는 모두 예전 캐시를 그대로 둔다.
 */
export type GeminiModelsRefresh = { ok: true; count: number } | { ok: false; reason: "not_installed" | "timeout" | "failed" | "empty" | "write_failed" };

/**
 * agy 에 넘길 환경(서버 것에서 SSH_CLIENT·SSH_TTY·SSH_CONNECTION 만 뺀 것). 서버를 SSH 세션에서 띄웠어도 폰 로그인(cli-login.ts geminiCliEnv)·
 * 팀장 터미널·한도 조회와 같은 키체인의 로그인을 읽게 한다. 정의는 runner/env.ts 하나다.
 */
export { GEMINI_REMOTE_ENV as AGY_FILE_TOKEN_ENV, withoutGeminiRemote as agyEnvWithoutSsh } from "./runner/env.ts";

async function spawnAgyModels(bin: string, timeoutMs: number): Promise<AgyModelsRun> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 환경은 서버의 것에서 SSH_* 만 뺀다(agyEnvWithoutSsh). 입력은 닫아 둔다: 물음이 뜨면 답하지 않고 제한 시간에 끊는다.
    const child = Bun.spawn([bin, "models"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: agyEnvWithoutSsh() });
    // 손주 프로세스가 출력 관을 쥐고 있으면 읽기가 끝나지 않는다. 읽기도 제한 시간과 겨룬다.
    const deadline = new Promise<AgyModelsRun>(resolve => {
      timer = setTimeout(() => { try { child.kill(); } catch { /* 이미 끝났다 */ } resolve({ exitCode: null, stdout: "" }); }, Math.max(1, timeoutMs));
    });
    const read = (async (): Promise<AgyModelsRun> => {
      const stdout = await new Response(child.stdout).text();
      return { exitCode: await child.exited, stdout: stdout.slice(0, GEMINI_OUTPUT_MAX) };
    })();
    return await Promise.race([read, deadline]);
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * `agy models` 를 띄워 캐시를 새로 쓴다. 실행 파일이 없으면 띄우지 않는다. 실패(시간 초과·오류 종료·빈 출력·쓰기 실패)하면 예전 캐시를 건드리지 않는다.
 * bin 은 Config.geminiBin(절대 경로 또는 이름)이다. 던지지 않는다.
 */
export async function refreshGeminiModels(opts: { bin: string | undefined; cachePath: string; timeoutMs?: number; spawn?: AgyModelsSpawn; now?: () => Date }): Promise<GeminiModelsRefresh> {
  let bin: string | null = null;
  try { bin = opts.bin ? resolveCliExecutable(opts.bin) : null; } catch { bin = null; }
  if (!bin) return { ok: false, reason: "not_installed" };
  let run: AgyModelsRun;
  try { run = await (opts.spawn ?? spawnAgyModels)(bin, opts.timeoutMs ?? GEMINI_MODELS_TIMEOUT_MS); }
  catch { return { ok: false, reason: "failed" }; }
  if (run.exitCode === null) return { ok: false, reason: "timeout" };
  if (run.exitCode !== 0) return { ok: false, reason: "failed" };
  const models = parseAgyModels(run.stdout);
  if (!models.length) return { ok: false, reason: "empty" };
  try { writeGeminiModelsCache(opts.cachePath, models, (opts.now ?? (() => new Date()))()); }
  catch { return { ok: false, reason: "write_failed" }; }
  return { ok: true, count: models.length };
}

export interface GeminiModelsRefresherOptions {
  bin: string | undefined;
  cachePath: string;
  intervalMs?: number;
  /** 캐시가 없을 때 다시 해 보는 간격들(기본 GEMINI_MODELS_RETRY_STEPS_MS). 실패가 이어지면 다음 칸으로 가고, 다 쓰면 intervalMs 다. */
  retryStepsMs?: readonly number[];
  timeoutMs?: number;
  spawn?: AgyModelsSpawn;
  now?: () => number;
  /**
   * Gemini 를 쓰는 근거가 있는가(Gemini 인 팀장·총괄이 있거나 Gemini 직급표에 정한 값이 있다). false 인 동안은 start()·주기·ensure() 가
   * agy 를 띄우지 않는다: agy 를 깔아만 두고 쓰지 않는 사람의 Mac 에서 뒤에서 `agy models` 를 돌리지 않는다(로그인하지 않은 agy 가 이 명령에서
   * 무엇을 하는지 확인하지 못했다). 근거가 생기면 다음 ensure() 가 건너뛴 갱신을 한다. 넣지 않으면 늘 쓰는 것으로 본다.
   */
  wanted?: () => boolean;
}

/**
 * Gemini 모델 목록 캐시를 뒤에서 갱신한다: start() 때 한 번(서버가 뜬 뒤), 그 뒤 6시간마다, 그리고 캐시 파일이 없으면 ensure() 가
 * 10분 뒤부터 간격을 벌려 가며 다시 건다. 한 번에 하나만 돈다. 실패는 조용히 지나가고(예전 캐시·기본 목록을 그대로 쓴다) 까닭이 바뀔 때만 한 줄 남긴다.
 * Gemini 를 쓰는 근거(options.wanted)가 없는 동안은 어느 것도 agy 를 띄우지 않는다. 직접 부른 refresh() 만 그 조건을 보지 않는다.
 */
export class GeminiModelsRefresher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<GeminiModelsRefresh> | null = null;
  private nextCheck = 0;
  /** 띄웠는데 목록을 얻지 못한 횟수(이어서). 성공하면 0. 다음에 다시 볼 때까지의 간격을 정한다. */
  private failures = 0;
  private stopped = false;
  private lastReason: string | null = null;
  /** 쓰는 근거가 없어 건너뛴 갱신(서버가 뜬 뒤의 첫 갱신, 6시간 주기)이 있다. 근거가 생긴 뒤의 첫 ensure() 가 한다. */
  private skipped = false;
  constructor(private readonly options: GeminiModelsRefresherOptions) {}

  private now(): number { return (this.options.now ?? Date.now)(); }
  private intervalMs(): number { return Math.max(1, this.options.intervalMs ?? GEMINI_MODELS_REFRESH_MS); }
  private retryDelay(): number {
    const steps = this.options.retryStepsMs ?? GEMINI_MODELS_RETRY_STEPS_MS;
    return Math.max(0, steps[this.failures] ?? this.intervalMs());
  }
  /** 쓰는 근거를 읽지 못하면(저장소가 닫히는 중 등) 없는 것으로 본다: 모르면 띄우지 않는다. */
  private wanted(): boolean {
    if (!this.options.wanted) return true;
    try { return this.options.wanted(); } catch { return false; }
  }
  /** 정해진 때의 갱신(첫 갱신·주기). 쓰는 근거가 없으면 띄우지 않고, 건너뛴 것만 적어 둔다. */
  private scheduled(): void {
    if (this.stopped) return;
    if (!this.wanted()) { this.skipped = true; return; }
    this.skipped = false;
    void this.refresh();
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.scheduled();
    this.timer = setInterval(() => this.scheduled(), this.intervalMs());
    this.timer.unref?.();
  }

  /**
   * 캐시 파일이 없으면 뒤에서 갱신을 건다. 틱마다 불러도 파일은 다시 볼 때가 됐을 때만 본다.
   * 쓰는 근거가 없어 건너뛴 갱신이 있으면, 근거가 생긴 뒤 처음 불릴 때 한다(캐시가 있어도: 오래된 목록일 수 있다).
   */
  ensure(): void {
    if (this.stopped || this.running) return;
    if (this.skipped) {
      if (!this.wanted()) return;
      this.skipped = false;
      void this.refresh();
      return;
    }
    if (this.now() < this.nextCheck || !this.wanted()) return;
    this.nextCheck = this.now() + this.retryDelay();
    if (!existsSync(this.options.cachePath)) void this.refresh();
  }

  /** 지금 갱신한다. 이미 도는 중이면 그 결과를 함께 받는다. 던지지 않는다. */
  refresh(): Promise<GeminiModelsRefresh> {
    if (this.stopped) return Promise.resolve({ ok: false, reason: "failed" });
    return this.running ??= (async (): Promise<GeminiModelsRefresh> => {
      const result = await refreshGeminiModels({ bin: this.options.bin, cachePath: this.options.cachePath, timeoutMs: this.options.timeoutMs, spawn: this.options.spawn, now: () => new Date(this.now()) })
        .catch((): GeminiModelsRefresh => ({ ok: false, reason: "failed" }));
      const reason = result.ok ? null : result.reason;
      // 띄웠는데 못 얻었으면 다음 간격을 벌린다. agy 가 없어 띄우지 않은 것은 세지 않는다(깔리면 곧 알아본다).
      if (result.ok) this.failures = 0;
      else if (result.reason !== "not_installed") this.failures += 1;
      this.nextCheck = this.now() + this.retryDelay();
      // agy 가 없는 것은 Gemini 를 쓰지 않는 사람의 보통 상태라 적지 않는다.
      if (reason && reason !== "not_installed" && reason !== this.lastReason) console.warn(`Gemini 모델 목록을 갱신하지 못했습니다(${reason}). 예전 목록을 그대로 씁니다`);
      this.lastReason = reason;
      return result;
    })().finally(() => { this.running = null; });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** One cache per server. Stat on each request; parse only when the file changes. */
export class ModelCatalogReader {
  /** gemini 는 캐시 자리를 모르면 null 이다(늘 기본 목록). */
  private readonly paths: Record<"claude" | "codex", string> & { gemini: string | null };
  private readonly cache = new Map<string, { stamp: string; list: ModelList }>();

  /**
   * homes.home: IAMCEO 데이터 홈(Config.home). Gemini 모델 캐시(<home>/cache/gemini-models.json)의 자리를 정한다. Config 를 그대로 넘기면 된다.
   * homes.geminiModelsCache: 그 자리를 직접 줄 때(시험). 둘 다 없으면 Gemini 는 기본 목록만 낸다(데이터 홈을 짐작해 읽지 않는다).
   */
  constructor(homes: { claudeHome?: string; codexHome?: string; userHome?: string; home?: string; geminiModelsCache?: string } = {}, env: NodeJS.ProcessEnv = process.env) {
    const home = homes.userHome ?? (env.IAMCEO_TEST === "1" ? env.IAMCEO_HOME ?? "/private/tmp/iamceo-model-test-empty" : homedir());
    const claudeHome = homes.claudeHome ?? env.CLAUDE_CONFIG_DIR;
    this.paths = {
      claude: claudeHome ? join(claudeHome, ".claude.json") : join(home, ".claude.json"),
      codex: join(homes.codexHome ?? env.CODEX_HOME ?? join(home, ".codex"), "models_cache.json"),
      gemini: homes.geminiModelsCache ?? (homes.home ? geminiModelsCachePath(homes.home) : null),
    };
  }

  read(): ModelCatalog { return { claude: this.readList("claude"), codex: this.readList("codex"), gemini: this.readList("gemini") }; }

  /** 그 CLI 의 모델 목록에 있는 값인가. */
  listed(cli: CliProvider, value: string): boolean {
    const list = this.read()[cli].models;
    return list.some(model => model.value === value) ||
      (cli === "claude" && value === "fable" && list.some(model => model.label.toLowerCase() === "fable"));
  }

  requireModel(cli: CliProvider, value: string | null | undefined): void {
    if (value == null || this.listed(cli, value)) return;
    throw new ApiError(400, "목록에 없는 모델입니다", "model_unknown");
  }

  efforts(cli: CliProvider, value?: string | null): readonly string[] {
    const list = this.read()[cli].models;
    const model = list.find(model => model.value === value) ??
      (cli === "claude" && value === "fable" ? list.find(model => model.label.toLowerCase() === "fable") : undefined);
    if (cli === "gemini") {
      // 목록에 있는데 effort 가 붙지 않는 모델(orchestrator 등)은 effort 를 고를 수 없다. agy 가 그 조합을 시작 전에 오류로 끝낸다.
      if (model) return model.efforts;
      // 모델을 정하지 않으면 effort 도 받지 않는다. `agy --effort <값>` 만 주면 agy 가 사용자 설정의 기본 모델로 따지는데(agy 1.5.14 실측:
      // 기본이 gemini-4-neon 인 Mac 에서 `--effort max` 는 시작 전에 종료 코드 1), 그 기본 모델은 사용자마다 달라 서버가 알 수 없다.
      // 그래서 직급표의 '모델 없음 + effort' 와 팀장의 '모델 없음 + effort 지정'은 거절하고, CLI 를 Gemini 로 바꿀 때 남은 effort 지정은 되돌린다.
      if (value == null) return [];
    }
    return model?.efforts.length ? model.efforts : fallbackEfforts(cli);
  }

  requireEffort(cli: CliProvider, model: string | null | undefined, effort: string | null | undefined): void {
    if (effort != null && !this.efforts(cli, model).includes(effort)) throw new ApiError(400, `${cli}에서 지원하지 않는 effort입니다`, "effort_unsupported");
  }

  memberPatch(member: Member, input: PatchMemberReq, settings: Settings): { patch: PatchMemberReq; resetOverrides: NonNullable<Member["resetOverrides"]> } {
    const patch = { ...input }, cli = patch.cli ?? member.cli;
    const resetOverrides: NonNullable<Member["resetOverrides"]> = [];
    const switching = cli !== member.cli;
    if (switching && patch.modelOverride === undefined && member.modelOverride != null) {
      try { this.requireModel(cli, member.modelOverride); }
      catch { patch.modelOverride = null; resetOverrides.push("modelOverride"); }
    }
    this.requireModel(cli, patch.modelOverride);
    const rank = ranksFor(cli, settings)[memberRank(member.kind)];
    const model = (patch.modelOverride === undefined ? member.modelOverride : patch.modelOverride) ?? rank.model;
    // Gemini 는 모델마다 받는 effort 가 다르고 모델이 없으면 effort 를 받지 않는다. effort 를 따로 적지 않은 요청으로 모델이 바뀌어(또는 비워져)
    // 남은 effort 지정이 맞지 않게 되면, 거절하지 않고 그 지정을 되돌린다(직급표의 처리와 같다). 거절하면 모델 지정만 비우는 요청(team_model 의
    // model: null)과, 직급 모델을 비운 뒤 그 팀장을 고치는 모든 요청이 effort 때문에 막힌다. Claude·Codex 는 CLI 를 바꿀 때만 되돌린다(그대로).
    if ((switching || cli === "gemini") && patch.effortOverride === undefined && member.effortOverride != null && !this.efforts(cli, model).includes(member.effortOverride)) {
      patch.effortOverride = null; resetOverrides.push("effortOverride");
    }
    this.requireEffort(cli, model, patch.effortOverride === undefined ? member.effortOverride : patch.effortOverride);
    return { patch, resetOverrides };
  }

  settingsPatch(input: SettingsPatch, current?: Settings): { patch: SettingsPatch; resetEfforts: NonNullable<Settings["resetEfforts"]> } {
    const patch = { ...input };
    const resetEfforts: NonNullable<Settings["resetEfforts"]> = [];
    const tables: readonly (readonly [CliProvider, RanksKey])[] = [["claude", "ranks"], ["codex", "codexRanks"], ["gemini", "geminiRanks"]];
    for (const [cli, field] of tables) {
      if (!input[field]) continue;
      patch[field] = { ...input[field] };
      for (const [key, rank] of Object.entries(input[field]!)) {
        if (!rank) continue;
        const rankKey = key as keyof Settings["ranks"];
        // Gemini 서브에이전트는 모델 이름이 아니라 단계를 고른다(shared/types.ts GEMINI_SUBAGENT_TIERS). effort 는 넘길 길이 없다.
        if (cli === "gemini" && rankKey === "staff") {
          if (rank.model != null && !isGeminiSubagentTier(rank.model)) throw new ApiError(400, ERROR_CODES.gemini_staff_tier_unknown.ko, "gemini_staff_tier_unknown");
          if (rank.effort != null) throw new ApiError(400, `${cli}에서 지원하지 않는 effort입니다`, "effort_unsupported");
          continue;
        }
        this.requireModel(cli, rank.model);
        const previous = current?.[field][rankKey];
        const model = rank.model === undefined ? previous?.model : rank.model;
        const effort = rank.effort === undefined ? previous?.effort : rank.effort;
        if (rank.model !== undefined && rank.model !== previous?.model && rank.effort === undefined &&
            effort != null && !this.efforts(cli, model).includes(effort)) {
          patch[field]![rankKey] = { ...rank, effort: null };
          resetEfforts.push(`${field}.${rankKey}.effort`);
        } else {
          this.requireEffort(cli, model, effort);
        }
      }
    }
    return { patch, resetEfforts };
  }

  requireSettings(patch: SettingsPatch, current?: Settings): void { this.settingsPatch(patch, current); }

  private readList(cli: CliProvider): ModelList {
    const path = this.paths[cli];
    // 캐시 자리를 모르는 Gemini 는 기본 목록이다(파일을 찾아 헤매지 않는다).
    if (path === null) return this.missing ??= defaults(cli);
    let stamp = "missing", updatedAt: string | undefined;
    try {
      const stat = statSync(path);
      stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
      updatedAt = stat.mtime.toISOString();
    } catch { /* Missing/unreadable files use defaults, including after deletion. */ }
    const cached = this.cache.get(path);
    if (cached?.stamp === stamp) return cached.list;
    let list = defaults(cli);
    if (updatedAt) {
      try {
        const data: unknown = JSON.parse(readFileSync(path, "utf8"));
        list = { models: parseList(cli, data), source: "cli", updatedAt };
      } catch { /* Invalid JSON or schema: keep defaults; never expose file contents. */ }
    }
    this.cache.set(path, { stamp, list });
    return list;
  }
  private missing: ModelList | null = null;
}

/** 그 CLI 의 파일 내용을 목록으로. 못 읽으면 던진다(부른 쪽이 기본 목록을 쓴다). */
function parseList(cli: CliProvider, data: unknown): ModelOption[] {
  switch (cli) {
    case "claude": return claudeModels(data);
    case "codex": return codexModels(data);
    case "gemini": return geminiModels(data);
    default: { const unlisted: never = cli; throw new Error(`Unknown CLI: ${String(unlisted)}`); }
  }
}
