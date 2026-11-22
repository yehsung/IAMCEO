// Gemini(Antigravity CLI, `agy`) 사용 한도의 초기화 시각과 한도 묶음.
//
// 근거(조사 parity/limits, 실제 agy 1.5.14 헤드리스):
// - `agy -p /usage --output-format json` 은 턴을 열지 않고(num_turns 0, 한도를 쓰지 않는다) 약 5초 만에 묶음별 남은 비율·초기화 시각을 준다.
//   command.data.groups[] = { name, description: "Models within this group: Gemini 4 Neon, …, Gemini 3.8 Flash", buckets: [{ id, window, remaining_fraction, reset_time }] }.
//   한 묶음의 모델은 주간·5시간 한도를 함께 쓴다(설명 글). 계정 메일은 들어 있지 않다. 연결이 없으면 exit 1 + status "ERROR".
//   "Gemini 4 Argon" 묶음처럼 모델 목록 글이 없는 묶음은 묶음 이름이 곧 모델 이름이다.
// - 상태줄 입력의 quota 는 묶음 id → { remaining_fraction, reset_time, reset_in_seconds } 다. 상태줄 기록(gemini-status.ts)이 이미 옮겨 둔다.
//   1.5.14 대화형 실측(agy-real statusline-*.json): 키는 '3p-5h'·'3p-weekly'·'gemini-5h'·'gemini-argon-wtu-weekly'·'gemini-weekly' 로 /usage 의 bucket id 와 같고,
//   reset_time 은 '2026-11-22T19:37:31Z' 꼴, disabled 칸은 없다. 쓰지 않은 3p-* 의 reset_time 은 매번 지금+5시간·7일로 움직인다(다 쓴 칸의 시각만 쓴다).
//   그래서 /usage 없이도 묶음 id 로 모델 갈래를 안다(geminiBucketFamily): gemini-5h·gemini-weekly = Gemini 모델, 3p-* = Claude·GPT 모델,
//   gemini-argon-* = Gemini 4 Argon(Pro 요금제에서 따로, Ultra 는 큰 Gemini 묶음에 든다는 /usage 설명).
// 서버는 Gemini 팀장이 한도로 멈췄을 때만 /usage 를 띄운다(60초 안에 다시 묻지 않는다). 시험 모드에서는 만들지 않는다(createOrchestrator).
import { mkdirSync } from "node:fs";
import { resolveCliExecutable } from "./config.ts";
import { withoutGeminiRemote } from "./runner/env.ts";
import type { GeminiStatusRecord } from "./runner/gemini-status.ts";

export interface AgyUsageBucket { id: string; window: string | null; remainingFraction: number | null; resetAt: string | null }
export interface AgyUsageGroup { name: string; models: string[]; buckets: AgyUsageBucket[] }
export interface AgyUsage { at: string; groups: AgyUsageGroup[] }

export const GEMINI_USAGE_TIMEOUT_MS = 25_000;
export const GEMINI_USAGE_CACHE_MS = 60_000;
const OUTPUT_MAX = 256 * 1024;
const NAME = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : null;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * `/usage --output-format json` 의 표준 출력을 묶음 목록으로 바꾼다. 성공(status SUCCESS, command.name usage)이 아니거나 모양이 다르면 null.
 * 고치거나 추정하지 않는다: 남은 비율은 0~1 의 수일 때만, 초기화 시각은 ISO 글일 때만 받는다(아니면 null).
 */
export function parseAgyUsage(stdout: string, now: Date = new Date()): AgyUsage | null {
  let value: unknown;
  try { value = JSON.parse(stdout.slice(0, OUTPUT_MAX).trim()); } catch { return null; }
  const object = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  const top = object(value), command = object(top?.command), data = object(command?.data);
  if (top?.status !== "SUCCESS" || command?.name !== "usage" || !Array.isArray(data?.groups)) return null;
  const groups: AgyUsageGroup[] = [];
  for (const raw of (data!.groups as unknown[]).slice(0, 32)) {
    const group = object(raw);
    const name = NAME(group?.name, 120);
    if (!group || !name || !Array.isArray(group.buckets)) continue;
    const listed = typeof group.description === "string" ? /Models within this group:\s*([^\n]+)/i.exec(group.description)?.[1] : undefined;
    const models = (listed ? listed.replace(/\.\s*$/, "").split(/\s*,\s*/) : [name]).map(model => NAME(model, 120)).filter((model): model is string => !!model).slice(0, 64);
    const buckets: AgyUsageBucket[] = [];
    for (const item of (group.buckets as unknown[]).slice(0, 16)) {
      const bucket = object(item);
      const id = typeof bucket?.id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(bucket.id) ? bucket.id : null;
      if (!bucket || !id) continue;
      const fraction = bucket.remaining_fraction;
      const reset = bucket.reset_time;
      buckets.push({ id, window: NAME(bucket.window, 40), remainingFraction: typeof fraction === "number" && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 ? fraction : null,
        resetAt: typeof reset === "string" && reset.length <= 40 && ISO.test(reset) && Number.isFinite(Date.parse(reset)) ? new Date(Date.parse(reset)).toISOString() : null });
    }
    groups.push({ name, models, buckets });
  }
  return groups.length ? { at: now.toISOString(), groups } : null;
}

/** 이름 견주기: 대소문자·겹친 칸을 무시하고, 끝의 effort 표시(`(Low)`·`-low`)는 뗀다. */
export function geminiModelKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s*\((?:low|medium|high|xhigh|max)\)\s*$/, "").replace(/\s+/g, " ");
}

/** 이 모델 이름들(표시 이름·id) 가운데 하나가 든 묶음. 앞의 이름부터 찾는다(먼저 준 이름이 더 믿을 만한 것). 없으면 null. */
export function geminiUsageGroup(usage: AgyUsage | null, names: (string | null | undefined)[]): AgyUsageGroup | null {
  if (!usage) return null;
  for (const name of names) {
    if (typeof name !== "string" || !name.trim()) continue;
    const key = geminiModelKey(name);
    const group = usage.groups.find(item => item.models.some(model => geminiModelKey(model) === key));
    if (group) return group;
  }
  return null;
}

/** 다 쓴 묶음인가: 남은 비율을 아는 칸 가운데 0 이하인 것이 있다. */
export function geminiGroupExhausted(group: AgyUsageGroup): boolean {
  return group.buckets.some(bucket => bucket.remainingFraction !== null && bucket.remainingFraction <= 0);
}

/** 남은 묶음인가: 칸이 하나 이상 있고 모두 남은 비율이 0 보다 크다(모르는 칸이 있으면 아니다). */
export function geminiGroupAvailable(group: AgyUsageGroup): boolean {
  return group.buckets.length > 0 && group.buckets.every(bucket => bucket.remainingFraction !== null && bucket.remainingFraction > 0);
}

/** 한도 묶음의 모델 갈래(위 머리말). gemini: Gemini 모델(Neon·Hydrogen·Orchestrator·3.8 Flash), argon: Gemini 4 Argon, third_party: Claude·GPT-OSS. */
export type GeminiQuotaFamily = "gemini" | "argon" | "third_party";
const FAMILY_NAMES: Record<GeminiQuotaFamily, string> = { gemini: "Gemini Models", argon: "Gemini 4 Argon", third_party: "Claude and GPT models" };

/** 묶음 id 의 갈래(1.5.14 실측의 id 모양). 모르는 id 는 null. */
export function geminiBucketFamily(id: string): GeminiQuotaFamily | null {
  const key = id.trim().toLowerCase();
  if (key.startsWith("3p-")) return "third_party";
  if (key.startsWith("gemini-argon")) return "argon";
  if (key.startsWith("gemini-")) return "gemini";
  return null;
}

/**
 * 모델 이름(표시 이름·id)의 갈래. Claude·GPT 는 third_party, Argon 은 argon, 그 밖의 Gemini 는 gemini. 모르면 null.
 * Orchestrator 는 /usage 가 Gemini 묶음에 둔 'Orchestrator (Neon)' 만 gemini 다(Argon 쪽 Orchestrator 는 어느 묶음에도 없다: 모른다).
 */
export function geminiModelFamily(name: string | null | undefined): GeminiQuotaFamily | null {
  if (typeof name !== "string") return null;
  const key = name.trim().toLowerCase();
  if (/^(?:claude|gpt)/.test(key)) return "third_party";
  if (key.includes("orchestrator")) return /\bneon\b/.test(key) ? "gemini" : null;
  if (/\bargon\b/.test(key)) return "argon";
  if (key.startsWith("gemini")) return "gemini";
  return null;
}

/** 이 이름들 가운데 갈래를 아는 첫 이름의 갈래(앞의 이름이 더 믿을 만하다). */
function familyOf(names: readonly (string | null | undefined)[]): GeminiQuotaFamily | null {
  for (const name of names) {
    const family = geminiModelFamily(name);
    if (family) return family;
  }
  return null;
}

type StatusBucket = GeminiStatusRecord["quota"][string];
/**
 * 상태줄 기록의 묶음 가운데 이 모델 이름들의 갈래 것. Argon 묶음이 없으면(Ultra 요금제) Gemini 묶음이다.
 * 갈래를 모르거나(Orchestrator (Argon) 처럼 어느 묶음에도 없는 모델, 이름을 모름) 기록에 그 갈래 묶음이 없으면 null(어느 묶음이 이 팀장 것인지 모른다).
 */
function familyBuckets(record: Pick<GeminiStatusRecord, "quota">, names: readonly (string | null | undefined)[]): StatusBucket[] | null {
  const family = familyOf(names);
  if (!family) return null;
  const entries = Object.entries(record.quota).filter(([, bucket]) => !bucket.disabled);
  for (const wanted of family === "argon" ? ["argon", "gemini"] as const : [family]) {
    const mine = entries.filter(([id]) => geminiBucketFamily(id) === wanted);
    if (mine.length) return mine.map(([, bucket]) => bucket);
  }
  return null;
}
/** familyBuckets, 모르면 전부(바닥났는지 물을 때: 어느 묶음인지 모르면 모든 묶음을 본다). */
function scopedBuckets(record: Pick<GeminiStatusRecord, "quota">, names: readonly (string | null | undefined)[]): StatusBucket[] {
  return familyBuckets(record, names) ?? Object.values(record.quota).filter(bucket => !bucket.disabled);
}

/**
 * 상태줄 기록의 묶음으로 만든 /usage 꼴(갈래마다 한 묶음). /usage 를 못 읽었을 때(시험 모드·실패) 한도 카드의 모델 선택지·막힌 모델에 쓴다.
 * 묶음의 모델은 Gemini 모델 목록(catalog) 가운데 그 갈래의 것이다. 기록이 없거나 갈래를 아는 묶음이 없으면 null.
 */
export function geminiStatusUsage(record: Pick<GeminiStatusRecord, "quota" | "at"> | null, catalog: readonly { value: string; label: string }[]): AgyUsage | null {
  if (!record) return null;
  const groups: AgyUsageGroup[] = [];
  for (const family of ["gemini", "third_party", "argon"] as const) {
    const buckets = Object.entries(record.quota).filter(([id, bucket]) => !bucket.disabled && geminiBucketFamily(id) === family)
      .map(([id, bucket]): AgyUsageBucket => ({ id, window: /5h$/i.test(id) ? "5h" : /weekly$/i.test(id) ? "weekly" : null, remainingFraction: bucket.remainingFraction, resetAt: bucket.resetAt }));
    if (!buckets.length) continue;
    const models = catalog.filter(option => (geminiModelFamily(option.label) ?? geminiModelFamily(option.value)) === family).map(option => option.label);
    groups.push({ name: FAMILY_NAMES[family], models, buckets });
  }
  return groups.length ? { at: record.at, groups } : null;
}

/** 다 쓴 칸들의 초기화 시각 가운데 가장 늦은 것(주간·5시간이 함께 바닥이면 늦은 쪽에야 풀린다). 다 쓴 칸이 없거나 시각을 모르면 null. */
export function geminiExhaustedResetAt(buckets: { remainingFraction: number | null; resetAt: string | null }[]): string | null {
  const times = buckets.filter(bucket => bucket.remainingFraction !== null && bucket.remainingFraction <= 0 && bucket.resetAt).map(bucket => bucket.resetAt!).sort();
  return times.at(-1) ?? null;
}

/**
 * 상태줄 기록의 한도 묶음으로 본 초기화 시각: 이 팀장 모델(names)의 갈래 묶음에서 다 쓴 칸 가운데 가장 늦은 시각.
 * 갈래를 모르거나(Orchestrator (Argon), 이름 없음) 기록에 그 갈래 묶음이 없으면 null(모름)이다: 다른 갈래 칸의 시각(예: Claude·GPT 주간 6일 뒤)을 빌리면
 * 그때까지 자동 이어가기가 없다. 모르면 부르는 쪽이 1시간부터 간격을 벌려 다시 이어 본다(이르게 이어도 agy 는 할당량 오류를 곧바로 돌려준다).
 * 기록이 없거나 다 쓴 칸이 없어도 null. 남은 비율을 모르는 칸은 다 쓴 칸으로 보지 않는다(빠진 칸을 0 으로 읽을 실측이 없다).
 */
export function geminiStatusResetAt(record: Pick<GeminiStatusRecord, "quota"> | null, names: readonly (string | null | undefined)[] = []): string | null {
  const buckets = record ? familyBuckets(record, names) : null;
  return buckets ? geminiExhaustedResetAt(buckets) : null;
}

/**
 * 상태줄 기록이 알리는 한도 묶음(이 팀장 모델의 갈래, 모르면 전부) 가운데 다 쓴 것이 있는가. 아는 칸 가운데 다 쓴 칸이 있으면 true.
 * 그렇지 않은데 남은 비율을 모르는 칸이 하나라도 있으면 null(모름)이다: agy 는 다 쓴 칸의 remaining_fraction 을 빠뜨릴 수 있다(실행 파일의 JSON 태그가
 * omitempty, 검토 지적). 그런 기록으로 '바닥나지 않음'(false)이라고 하면 429 글을 장애로 바꾸는 규칙이 불완전한 근거로 돈다. 묶음을 하나도 모르면 null.
 */
export function geminiStatusExhausted(record: Pick<GeminiStatusRecord, "quota"> | null, names: readonly (string | null | undefined)[] = []): boolean | null {
  const buckets = record ? scopedBuckets(record, names) : [];
  if (buckets.some(bucket => bucket.remainingFraction !== null && bucket.remainingFraction <= 0)) return true;
  if (!buckets.length || buckets.some(bucket => bucket.remainingFraction === null)) return null;
  return false;
}

export interface AgyUsageRun { exitCode: number | null; stdout: string }
/** 실행 파일을 띄우는 부분. 시험은 가짜를 넣는다(실제 agy 를 띄우지 않는다). */
export type AgyUsageSpawn = (bin: string, cwd: string, timeoutMs: number) => Promise<AgyUsageRun>;

async function spawnAgyUsage(bin: string, cwd: string, timeoutMs: number): Promise<AgyUsageRun> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 환경은 서버의 것을 그대로 쓰되(env -i 로 비우지 않는다) SSH_CLIENT·SSH_TTY·SSH_CONNECTION 만 뺀다: 그 값이 있으면 agy 가 키체인이 아닌 토큰 파일을 읽어
    // 서버를 SSH 세션에서 띄웠을 때 폰 로그인·팀장(키체인)과 다른 계정의 한도를 읽거나 인증에 실패한다(runner/env.ts withoutGeminiRemote).
    // 입력은 닫아 둔다: 물음이 뜨면 답하지 않고 끊긴다. --print-timeout 은 agy 스스로의 상한이고, 아래 deadline 이 서버 쪽 상한이다.
    const seconds = Math.max(5, Math.floor(timeoutMs / 1000) - 5);
    const child = Bun.spawn([bin, "-p", "/usage", "--output-format", "json", "--print-timeout", `${seconds}s`], { cwd, env: withoutGeminiRemote(process.env), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const deadline = new Promise<AgyUsageRun>(resolve => {
      timer = setTimeout(() => { try { child.kill(); } catch { /* 이미 끝났다 */ } resolve({ exitCode: null, stdout: "" }); }, Math.max(1, timeoutMs));
    });
    const read = (async (): Promise<AgyUsageRun> => {
      const stdout = await new Response(child.stdout).text();
      return { exitCode: await child.exited, stdout: stdout.slice(0, OUTPUT_MAX) };
    })();
    return await Promise.race([read, deadline]);
  } finally { if (timer) clearTimeout(timer); }
}

export interface GeminiQuotaReaderOptions {
  /** Config.geminiBin(절대 경로 또는 이름). */
  bin: string | undefined;
  /** agy 를 띄울 빈 폴더(<IAMCEO_HOME>/run/gemini-usage). 없으면 만든다. 프로젝트 폴더에서 띄우지 않는다. */
  cwd: string;
  timeoutMs?: number;
  cacheMs?: number;
  spawn?: AgyUsageSpawn;
  now?: () => number;
}

/**
 * `/usage` 읽기. 한 번에 하나만 띄우고, 성공한 답은 cacheMs(60초) 동안 다시 띄우지 않고 쓴다. 실패(실행 파일 없음·시간 초과·오류 종료·모양이 다름)는
 * null 이고 예전 답을 지우지 않는다. 던지지 않는다.
 */
export class GeminiQuotaReader {
  private last: AgyUsage | null = null;
  private lastAt = 0;
  private running: Promise<AgyUsage | null> | null = null;
  private stopped = false;
  constructor(private readonly options: GeminiQuotaReaderOptions) {}
  private now(): number { return (this.options.now ?? Date.now)(); }

  /** 마지막으로 읽은 답(maxAgeMs 안의 것만). 띄우지 않는다. */
  latest(maxAgeMs = 30 * 60_000): AgyUsage | null {
    return this.last && this.now() - this.lastAt <= maxAgeMs ? this.last : null;
  }

  read(force = false): Promise<AgyUsage | null> {
    if (this.stopped) return Promise.resolve(null);
    if (!force && this.last && this.now() - this.lastAt < (this.options.cacheMs ?? GEMINI_USAGE_CACHE_MS)) return Promise.resolve(this.last);
    return this.running ??= (async (): Promise<AgyUsage | null> => {
      let bin: string | null = null;
      try { bin = this.options.bin ? resolveCliExecutable(this.options.bin) : null; } catch { bin = null; }
      if (!bin) return null;
      try { mkdirSync(this.options.cwd, { recursive: true, mode: 0o700 }); } catch { return null; }
      let run: AgyUsageRun;
      try { run = await (this.options.spawn ?? spawnAgyUsage)(bin, this.options.cwd, this.options.timeoutMs ?? GEMINI_USAGE_TIMEOUT_MS); }
      catch { return null; }
      if (run.exitCode !== 0) return null;
      const usage = parseAgyUsage(run.stdout, new Date(this.now()));
      if (usage && !this.stopped) { this.last = usage; this.lastAt = this.now(); }
      return usage;
    })().catch(() => null).finally(() => { this.running = null; });
  }

  stop(): void { this.stopped = true; }
}
