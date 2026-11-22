// Gemini(Antigravity CLI, `agy`) 팀장의 상태줄 기록. 실행기·사용량·지휘가 함께 쓰는 계약이다.
//
// agy 는 상태가 바뀔 때마다 상태줄 명령을 돌리고 표준 입력으로 JSON 을 준다. 상태줄 래퍼가 그 JSON 을 geminiStatusFromPayload 로
// 아래 모양으로 바꿔 <contextHome>/context/gemini/<memberId>.json 에 쓴다(임시 파일 → rename). 서버는 이 파일을 읽기만 한다:
// 세션 id(conversationId), 문맥 %, 한도, 비용이 여기서 나온다. 계정 메일(email)은 담지 않는다.
// 파일은 팀장마다 하나다. 어느 터미널이 쓴 기록인지는 launch 칸(띄울 때 정한 값)으로 가른다: 실행기는 지금 터미널의 값이 적힌 기록만 믿는다.
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface GeminiStatusRecord {
  v: 1;
  memberId: string;
  /** 쓴 시각(ISO). 터미널을 띄운 시각보다 앞선 기록은 예전 세션의 것이라 믿지 않는다. */
  at: string;
  /** agy 의 대화 id. 첫 대화 전에는 null. */
  conversationId: string | null;
  /** agy 가 알려 준 기록 파일 경로 그대로다. 읽기 전에 쓰는 쪽이 gemini 홈 안의 경로인지 확인한다. */
  transcriptPath: string | null;
  model: { id: string | null; effort: string | null };
  /** usedPct 는 0~100. */
  context: { usedPct: number | null; windowSize: number | null; inputTokens: number | null; outputTokens: number | null };
  /** 한도 묶음 id → 남은 비율(0~1)과 초기화 시각(ISO). 남은 양만 알려 준 묶음(remaining_amount)은 remainingFraction 이 null 이다. */
  quota: Record<string, { remainingFraction: number | null; resetAt: string | null; disabled: boolean }>;
  costUsd: number | null;
  agentState: string | null;
  /**
   * 도는 서브에이전트 수: 상태줄의 subagents 항목 가운데 status 가 "running" 인 것. 문서상 status 는 "running"·"completed" 둘이다.
   * 끝난 것("completed")은 세지 않는다.
   */
  subagents: number;
  /**
   * 도는 것도 끝난 것도 아닌 항목의 수(status 가 없거나 문서에 없는 값). 0 이 아니면 subagents 는 정확한 수가 아니다: 그 항목이 도는 중인지 모른다
   * (실제 상태줄 입력은 아직 본 적이 없다). null: 이 칸을 모르던 래퍼가 쓴 기록이다(그때의 subagents 는 '끝나지 않은 항목' 수였다). 역시 정확하지 않다.
   */
  subagentsUnknown: number | null;
  planTier: string | null;
  /**
   * 이 기록을 쓴 상태줄 명령이 받은 띄우기 값. 서버는 Antigravity CLI 를 띄울 때마다 임의 값을 만들어 터미널 라벨과 상태줄 명령의 인자에 함께 싣고,
   * 실행기는 이 값이 지금 터미널의 라벨과 같은 기록만 그 터미널의 것으로 믿는다(방금 끝낸 예전 터미널의 래퍼가 늦게 쓴 기록을 새 터미널 것으로 읽지 않게).
   * null: 값을 받지 않은 명령이 썼다(이 칸을 모르던 래퍼의 기록 포함).
   */
  launch: string | null;
}

const MEMBER_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** 서버가 받는 CLI 세션 id 모양과 같다(CONTEXT_SESSION_RE, providerLaunch 의 검사). 이 모양이 아닌 id 는 띄울 때 어차피 거절된다. */
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
/** 한 기록의 최대 크기. 래퍼가 쓰는 기록은 이보다 훨씬 작다. */
const MAX_BYTES = 64 * 1024;
const MAX_QUOTA = 32;
const MAX_SUBAGENTS = 10_000;
/** 띄우기 값의 모양(영문·숫자·`_`·`-`, 64자까지). 서버는 하이픈을 뺀 UUID(32자)를 쓴다. 상태줄 명령의 인자로 실리므로 셸에 뜻이 있는 글자는 받지 않는다. */
const LAUNCH = /^[A-Za-z0-9_-]{1,64}$/;

/** 팀장 하나의 기록 파일. memberId 가 파일 이름이 되므로 모양이 다르면 던진다. */
export function geminiStatusPath(contextHome: string, memberId: string): string {
  if (typeof contextHome !== "string" || !isAbsolute(contextHome) || contextHome.includes("\0")) throw new Error("gemini status: contextHome must be an absolute path");
  if (typeof memberId !== "string" || !MEMBER_ID.test(memberId)) throw new Error("gemini status: invalid member id");
  return join(contextHome, "context", "gemini", `${memberId}.json`);
}

/**
 * agy 의 상태줄 입력 JSON 을 기록 모양으로 바꾼다. 고치거나 추정하지 않고 모양만 확인해 옮긴다: 모양이 다른 칸은 null 이다.
 * - 숫자는 유한수이고 0 이상일 때만 받는다(문맥 % 는 100 이하, 창 크기는 0 초과, 남은 비율은 0~1).
 * - 초기화 시각은 reset_time(ISO 글 또는 epoch 초·밀리초)을 ISO 로 옮기고, 없으면 now + reset_in_seconds 다.
 * - 대화 id 는 서버가 받는 세션 id 모양(영문·숫자·`_`·`-`, 128자까지)일 때만 받는다.
 * - email 을 비롯해 아래에 없는 칸은 옮기지 않는다.
 * - 서브에이전트: status 가 "running" 인 항목 수를 subagents 에, "running"·"completed" 가 아닌 항목 수를 subagentsUnknown 에 적는다.
 * - launch(넷째 인자, 없어도 된다): 상태줄 명령이 받은 띄우기 값. 모양이 다르거나 없으면 기록의 launch 는 null 이다.
 * memberId 모양이 다르면 던진다.
 *
 * 이 함수는 바깥 이름을 하나도 쓰지 않는다(안에서 다 정한다). 상태줄 래퍼는 서버 밖의 독립 스크립트라 이 모듈을 import 하지 못하므로,
 * 함수 글(toString())을 스크립트에 그대로 넣어 같은 규칙으로 쓰게 하려는 것이다. 바깥 상수·도우미를 쓰게 고치면 그 길이 깨진다(시험이 잡는다).
 */
export function geminiStatusFromPayload(memberId: string, payload: unknown, now: Date, launch?: string | null): GeminiStatusRecord {
  if (typeof memberId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(memberId)) throw new Error("gemini status: invalid member id");
  const object = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
  const text = (value: unknown, max: number): string | null => (typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null);
  const amount = (value: unknown, max = Infinity): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null);
  const iso = (ms: number): string | null => (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null);
  const resetAt = (bucket: Record<string, unknown>): string | null => {
    const time = bucket.reset_time;
    if (typeof time === "string" && time.length <= 40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(time)) {
      const at = iso(Date.parse(time));
      if (at) return at;
    }
    if (typeof time === "number" && Number.isFinite(time) && time > 0) {
      const at = iso(time < 1e11 ? time * 1000 : time);
      if (at) return at;
    }
    const seconds = amount(bucket.reset_in_seconds);
    return seconds === null ? null : iso(now.getTime() + seconds * 1000);
  };

  const input = object(payload);
  const id = (value: unknown): string | null => (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) ? value : null);
  const transcript = text(input.transcript_path, 4096);
  const model = object(input.model);
  const context = object(input.context_window);
  const windowSize = amount(context.context_window_size);
  const quota: [string, { remainingFraction: number | null; resetAt: string | null; disabled: boolean }][] = [];
  for (const [name, value] of Object.entries(object(input.quota))) {
    if (quota.length >= 32) break;
    if (text(name, 80) === null || name === "__proto__" || value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const bucket = value as Record<string, unknown>;
    quota.push([name, { remainingFraction: amount(bucket.remaining_fraction, 1), resetAt: resetAt(bucket), disabled: bucket.disabled === true }]);
  }
  // 문서상 status 는 "running"·"completed" 둘이다. 그 밖(없음·다른 값)은 도는 중인지 모르므로 도는 수에 넣지 않고 따로 센다.
  const agents: unknown[] = Array.isArray(input.subagents) ? input.subagents : [];
  const statusOf = (item: unknown): unknown => (item !== null && typeof item === "object" ? (item as { status?: unknown }).status : undefined);
  const running = agents.filter((item) => statusOf(item) === "running").length;
  const unsure = agents.filter((item) => statusOf(item) !== "running" && statusOf(item) !== "completed").length;
  return {
    v: 1,
    memberId,
    at: now.toISOString(),
    conversationId: id(input.conversation_id) ?? id(input.session_id),
    transcriptPath: transcript !== null && transcript.startsWith("/") ? transcript : null,
    model: { id: text(model.id, 200), effort: text(model.effort, 40) },
    context: {
      usedPct: amount(context.used_percentage, 100),
      windowSize: windowSize !== null && windowSize > 0 ? windowSize : null,
      inputTokens: amount(context.total_input_tokens),
      outputTokens: amount(context.total_output_tokens),
    },
    quota: Object.fromEntries(quota),
    costUsd: amount(object(input.cost).total_usd),
    agentState: text(input.agent_state, 40),
    subagents: Math.min(running, 10_000),
    subagentsUnknown: Math.min(unsure, 10_000),
    planTier: text(input.plan_tier, 80),
    launch: typeof launch === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(launch) ? launch : null,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const nullOr = (value: unknown, valid: (value: unknown) => boolean): boolean => value === null || valid(value);
const isText = (max: number) => (value: unknown): boolean => typeof value === "string" && value.length > 0 && value.length <= max && !CONTROL.test(value);
const isAmount = (max = Infinity) => (value: unknown): boolean => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
/** toISOString() 이 쓴 그대로의 글인가. */
const isIso = (value: unknown): boolean => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/** 디스크의 값을 기록으로 확인한다. 한 칸이라도 모양이 다르면 깨진 기록이다(null). 아는 칸만 새로 담아 돌려준다. */
function parseRecord(value: unknown, memberId: string): GeminiStatusRecord | null {
  if (!isObject(value) || value.v !== 1 || value.memberId !== memberId || !isIso(value.at)) return null;
  const { model, context, quota } = value;
  if (!isObject(model) || !isObject(context) || !isObject(quota)) return null;
  if (!nullOr(value.conversationId, v => typeof v === "string" && CONVERSATION_ID.test(v))) return null;
  if (!nullOr(value.transcriptPath, v => isText(4096)(v) && (v as string).startsWith("/"))) return null;
  if (!nullOr(model.id, isText(200)) || !nullOr(model.effort, isText(40))) return null;
  if (!nullOr(context.usedPct, isAmount(100)) || !nullOr(context.windowSize, v => isAmount()(v) && (v as number) > 0)) return null;
  if (!nullOr(context.inputTokens, isAmount()) || !nullOr(context.outputTokens, isAmount())) return null;
  if (!nullOr(value.costUsd, isAmount()) || !nullOr(value.agentState, isText(40)) || !nullOr(value.planTier, isText(80))) return null;
  if (!Number.isSafeInteger(value.subagents) || (value.subagents as number) < 0 || (value.subagents as number) > MAX_SUBAGENTS) return null;
  // 뒤에 더한 칸(subagentsUnknown·launch)은 없어도 읽는다(그 칸을 모르던 래퍼의 기록): null 이다. 있는데 모양이 다르면 깨진 기록이다.
  const count = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_SUBAGENTS;
  if (value.subagentsUnknown !== undefined && !nullOr(value.subagentsUnknown, count)) return null;
  if (value.launch !== undefined && !nullOr(value.launch, v => typeof v === "string" && LAUNCH.test(v))) return null;
  const names = Object.keys(quota);
  if (names.length > MAX_QUOTA) return null;
  const buckets: [string, GeminiStatusRecord["quota"][string]][] = [];
  for (const name of names) {
    const bucket = quota[name];
    if (!isText(80)(name) || name === "__proto__" || !isObject(bucket)) return null;
    if (!nullOr(bucket.remainingFraction, isAmount(1)) || !nullOr(bucket.resetAt, isIso) || typeof bucket.disabled !== "boolean") return null;
    buckets.push([name, { remainingFraction: bucket.remainingFraction as number | null, resetAt: bucket.resetAt as string | null, disabled: bucket.disabled }]);
  }
  return {
    v: 1,
    memberId,
    at: value.at as string,
    conversationId: value.conversationId as string | null,
    transcriptPath: value.transcriptPath as string | null,
    model: { id: model.id as string | null, effort: model.effort as string | null },
    context: {
      usedPct: context.usedPct as number | null,
      windowSize: context.windowSize as number | null,
      inputTokens: context.inputTokens as number | null,
      outputTokens: context.outputTokens as number | null,
    },
    quota: Object.fromEntries(buckets),
    costUsd: value.costUsd as number | null,
    agentState: value.agentState as string | null,
    subagents: value.subagents as number,
    subagentsUnknown: (value.subagentsUnknown ?? null) as number | null,
    planTier: value.planTier as string | null,
    launch: (value.launch ?? null) as string | null,
  };
}

/**
 * 팀장의 마지막 상태줄 기록. 없거나, 깨졌거나(JSON 이 아님, 모양이 다름, 다른 팀장의 기록), v 가 1 이 아니거나, 보통 파일이 아니면(링크 등) null 이다.
 * 던지지 않는다(memberId·contextHome 모양이 달라도 null). 읽기만 한다.
 */
export function readGeminiStatus(contextHome: string, memberId: string): GeminiStatusRecord | null {
  let fd: number | undefined;
  try {
    fd = openSync(geminiStatusPath(contextHome, memberId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    return parseRecord(JSON.parse(readFileSync(fd, "utf8")), memberId);
  } catch { return null; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* 이미 닫혔다 */ } } }
}
