// Gemini(Antigravity CLI, `agy`) 사용 한도의 초기화 시각과 한도 묶음.
//
// 근거(조사 parity/limits, 실제 agy 1.5.14 헤드리스):
// - `agy -p /usage --output-format json` 은 턴을 열지 않고(num_turns 0, 한도를 쓰지 않는다) 약 5초 만에 묶음별 남은 비율·초기화 시각을 준다.
//   command.data.groups[] = { name, description: "Models within this group: Gemini 4 Neon, …, Gemini 3.8 Flash", buckets: [{ id, window, remaining_fraction, reset_time }] }.
//   한 묶음의 모델은 주간·5시간 한도를 함께 쓴다(설명 글). 계정 메일은 들어 있지 않다. 연결이 없으면 exit 1 + status "ERROR".
//   "Gemini 4 Argon" 묶음처럼 모델 목록 글이 없는 묶음은 묶음 이름이 곧 모델 이름이다.
// - 상태줄 입력의 quota 는 묶음 id → { remaining_fraction, reset_time, reset_in_seconds } 다(문서). 상태줄 기록(gemini-status.ts)이 이미 옮겨 둔다.
//   UNVERIFIED-INTERACTIVE: 실제 상태줄 입력의 quota 키 목록·reset_time 꼴은 대화형 화면이 있어야 본다(문서·/usage 의 id 와 같을 것으로 본다).
// 서버는 Gemini 팀장이 한도로 멈췄을 때만 /usage 를 띄운다(60초 안에 다시 묻지 않는다). 시험 모드에서는 만들지 않는다(createOrchestrator).
import { mkdirSync } from "node:fs";
import { resolveCliExecutable } from "./config.ts";
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

/** 다 쓴 칸들의 초기화 시각 가운데 가장 늦은 것(주간·5시간이 함께 바닥이면 늦은 쪽에야 풀린다). 다 쓴 칸이 없거나 시각을 모르면 null. */
export function geminiExhaustedResetAt(buckets: { remainingFraction: number | null; resetAt: string | null }[]): string | null {
  const times = buckets.filter(bucket => bucket.remainingFraction !== null && bucket.remainingFraction <= 0 && bucket.resetAt).map(bucket => bucket.resetAt!).sort();
  return times.at(-1) ?? null;
}

/**
 * 상태줄 기록의 한도 묶음으로 본 초기화 시각: 다 쓴 칸 가운데 가장 늦은 시각(어느 묶음이 이 팀장의 모델 것인지 모를 때 쓰는 대신 길: 늦게 풀리는 쪽으로).
 * 기록이 없거나 다 쓴 칸이 없으면 null.
 */
export function geminiStatusResetAt(record: Pick<GeminiStatusRecord, "quota"> | null): string | null {
  if (!record) return null;
  return geminiExhaustedResetAt(Object.values(record.quota).filter(bucket => !bucket.disabled));
}

/** 상태줄 기록이 알리는 한도 묶음 가운데 다 쓴 것이 있는가. 묶음을 하나도 모르면 null(모름). */
export function geminiStatusExhausted(record: Pick<GeminiStatusRecord, "quota"> | null): boolean | null {
  const buckets = record ? Object.values(record.quota).filter(bucket => !bucket.disabled && bucket.remainingFraction !== null) : [];
  if (!buckets.length) return null;
  return buckets.some(bucket => bucket.remainingFraction! <= 0);
}

export interface AgyUsageRun { exitCode: number | null; stdout: string }
/** 실행 파일을 띄우는 부분. 시험은 가짜를 넣는다(실제 agy 를 띄우지 않는다). */
export type AgyUsageSpawn = (bin: string, cwd: string, timeoutMs: number) => Promise<AgyUsageRun>;

async function spawnAgyUsage(bin: string, cwd: string, timeoutMs: number): Promise<AgyUsageRun> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 환경은 서버의 것을 그대로 쓴다(models.ts 의 `agy models` 와 같다. env -i 로 비우지 않는다). 입력은 닫아 둔다: 물음이 뜨면 답하지 않고 끊긴다.
    // --print-timeout 은 agy 스스로의 상한이고, 아래 deadline 이 서버 쪽 상한이다.
    const seconds = Math.max(5, Math.floor(timeoutMs / 1000) - 5);
    const child = Bun.spawn([bin, "-p", "/usage", "--output-format", "json", "--print-timeout", `${seconds}s`], { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
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
