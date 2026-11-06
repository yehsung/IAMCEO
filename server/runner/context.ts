import type { ContextWindowSource } from "../../shared/types.ts";

/** 상태줄 반올림 범위 안에서만 맞춘다. 실측 후보일 뿐 모델별 보장은 아니다. */
export const KNOWN_CONTEXT_WINDOWS: readonly number[] = [200_000, 258_400, 475_000, 1_000_000];
const MIN_INFERRED_CONTEXT_WINDOW = Math.min(...KNOWN_CONTEXT_WINDOWS);
const MAX_INFERRED_CONTEXT_WINDOW = 10_000_000;
/** 이 설치의 Codex rollout 실측값. 세션 실측이 항상 우선하며 설정에서 덮어쓸 수 있다. */
export const DEFAULT_CONTEXT_WINDOWS: Readonly<Record<string, number>> = { "gpt-6-astra": 475_000 };
/** 1M 세션을 200k 로 오인해 실제 14% 에서 압축하는 손실을 피한다. CLI 자체 압축도 남아 있다. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

export function validWindow(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
export function exactSource(source: ContextWindowSource | null | undefined): boolean {
  return source === "statusline" || source === "codex" || source === "headless";
}

/** 정수 % 의 ±0.5 반올림 오차. 낮은 % 에서 후보가 겹치면 배우지 않는다. */
export function inferContextWindow(tokens: number | null, pct: number | null): number | null {
  if (tokens === null || pct === null || !Number.isFinite(tokens) || !Number.isFinite(pct) || tokens <= 0 || pct < 3 || pct >= 100) return null;
  const near = KNOWN_CONTEXT_WINDOWS.filter((w) => tokens <= w && Math.abs(tokens / w * 100 - pct) <= 0.5);
  if (near.length === 1) return near[0]!;
  if (near.length > 1 || pct < 10) return null;
  const window = Math.round(tokens * 100 / pct);
  return window >= MIN_INFERRED_CONTEXT_WINDOW && window <= MAX_INFERRED_CONTEXT_WINDOW ? window : null;
}

export interface WindowHints {
  learned: number | null;
  source?: ContextWindowSource | null;
  model: string | null;
  fallback: number;
  windows?: Readonly<Record<string, number>>;
}

/** 저장값은 토큰보다 작으면 버린다. 모델 표는 정확한 id 로만 조회한다. */
export function contextWindowFor(tokens: number, hints: WindowHints): number {
  const learned = validWindow(hints.learned) && tokens <= hints.learned ? hints.learned : null;
  if (learned !== null && exactSource(hints.source)) return learned;
  const model = hints.model ?? "";
  if (/\[1m\]/i.test(model) && tokens <= 1_000_000) return 1_000_000;
  if (learned !== null) return learned;
  const table = { ...DEFAULT_CONTEXT_WINDOWS, ...hints.windows };
  const known = Object.hasOwn(table, model) ? table[model] : null;
  if (validWindow(known) && tokens <= known) return known;
  const fallback = validWindow(hints.fallback) ? hints.fallback : DEFAULT_CONTEXT_WINDOW;
  if (tokens <= fallback) return fallback;
  // 기본값이 이미 쓴 토큰보다 작으면 100% 로 오인해 압축하지 않는다.
  return KNOWN_CONTEXT_WINDOWS.find((window) => window >= tokens) ?? Math.ceil(tokens * 2);
}

export function pctOfWindow(tokens: number, window: number): number {
  return Math.max(0, Math.min(100, Math.round(tokens / window * 100)));
}

export interface ExactContext {
  window: number;
  source: Exclude<ContextWindowSource, "screen">;
  /** 신선한 공식 % 만 넣는다. 오래된 기록은 창 크기만 쓴다. */
  pct?: number | null;
}
export interface ContextReading {
  tokens: number | null;
  shownPct: number | null;
  model: string | null;
  exact?: ExactContext | null;
  /** 늦게 온 읽기가 교체된 세션에 적용되지 않게 한다. */
  sessionId?: string;
}

export function measureContext(reading: ContextReading, hints: Omit<WindowHints, "model">): { pct: number | null; learned: number | null; source?: ContextWindowSource } | null {
  const tokens = reading.tokens !== null && Number.isFinite(reading.tokens) && reading.tokens >= 0 ? reading.tokens : null;
  const exact = reading.exact;
  if (exact && validWindow(exact.window)) {
    const pct = exact.pct;
    if (typeof pct === "number" && Number.isFinite(pct) && pct >= 0 && pct <= 100) return { pct, learned: exact.window, source: exact.source };
    return { pct: tokens !== null ? pctOfWindow(tokens, exact.window) : null, learned: exact.window, source: exact.source };
  }
  const storedExact = exactSource(hints.source) && validWindow(hints.learned) && (tokens === null || tokens <= hints.learned);
  if (storedExact && tokens !== null) return { pct: pctOfWindow(tokens, hints.learned!), learned: null };
  if (reading.shownPct !== null && Number.isFinite(reading.shownPct) && reading.shownPct >= 0 && reading.shownPct <= 100) {
    const learned = storedExact ? null : inferContextWindow(tokens, reading.shownPct);
    return { pct: reading.shownPct, learned, ...(learned !== null ? { source: "screen" as const } : {}) };
  }
  if (tokens === null) return null;
  return { pct: pctOfWindow(tokens, contextWindowFor(tokens, { ...hints, model: reading.model })), learned: null };
}
