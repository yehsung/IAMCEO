import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemberKind, ReportLanguage } from "../shared/types.ts";
import conductor from "./roles/conductor.md" with { type: "text" };
import ackTurn from "./roles/parts/ack-turn.md" with { type: "text" };
import artifactContract from "./roles/parts/artifact-contract.md" with { type: "text" };
import deliverables from "./roles/parts/deliverables.md" with { type: "text" };
import manualSession from "./roles/parts/manual-session.md" with { type: "text" };
import toolRetry from "./roles/parts/tool-retry.md" with { type: "text" };
import root from "./roles/root.md" with { type: "text" };
import worker from "./roles/worker.md" with { type: "text" };

export interface RoleVars {
  PROJECT: string;
  NAME: string;
  ROLE: string;
  CONDUCTOR: string;
  /** 서브에이전트 effort 규칙 한 줄. 정하지 않았으면 빈 글. */
  SUBAGENT_EFFORT?: string;
  /** B1: 설정의 보고 언어. en 이면 지침 끝에 ENGLISH_REPORT_RULE 을 붙인다. 없거나 ko 면 그대로. */
  REPORT_LANGUAGE?: ReportLanguage;
  /**
   * E10: 직접 붙인 세션(`iamceo join`, origin=manual)이면 true. 그 세션에만 있는 `wait` 도구의 안내(parts/manual-session.md)를
   * `{{MANUAL_SESSION}}` 자리에 넣는다. 서버가 띄우는 세션에는 `wait` 도구가 없어 그 줄을 지운다.
   */
  MANUAL?: boolean;
}

/**
 * B1: 보고 언어가 영어일 때 지침 끝에 붙는 글. 첫 줄은 대표에게 쓰는 글을 영어로, 둘째 줄은 서버 머리말의 뜻.
 * 머리말([대표]·[총괄] 등)은 서버만 붙이는 규약 표지라 번역하지 않는다. 고쳐 쓴 템플릿에도 빠지지 않게 끝에 붙인다.
 */
export const ENGLISH_REPORT_RULE = `## Report language
- Write everything the owner (대표) reads in English: \`post\` reports, \`ask\` cards (title, background, options, recommendation), \`todo\` items, \`status\` lines, file titles and replies. This replaces any rule above that asks for Korean or for a Korean translation of English text. Keep code, commands, paths and quoted text as they are.
- The source labels the server puts on your input stay in Korean because they are protocol markers, not a language hint: \`[대표]\` the owner, \`[대표 직접]\` the owner writing to you directly, \`[대표 답(원문) ...]\` the owner's verbatim answer to a card, \`[총괄] <name>에게\` an instruction from the lead, \`[보고 <name>]\` a report from a staff session, \`[시스템]\` the server; \`사용자 요청(원문, 서버 확인)\` is an owner quote the server verified, \`총괄 인용(미확인)\` a quote it could not verify.`;

// ---- E10: 조각 조립 ----
// 역할 템플릿(server/roles/<kind>.md)의 `{{> 이름}}` 한 줄은 server/roles/parts/<이름>.md 로 바뀐다.
// 여러 역할에 똑같이 들어가는 규칙은 조각 하나에만 둔다. 새 조각을 더하려면 파일을 만들고 아래 목록에 한 줄,
// 쓰는 역할 템플릿에 `{{> 이름}}` 한 줄을 넣는다. 조각 안에서 다른 조각을 부르지 않는다.

/** 여러 역할이 함께 쓰는 조각. 빌드본에 들어가도록 정적으로 가져온다. */
export const ROLE_PARTS: Readonly<Record<string, string>> = {
  "ack-turn": ackTurn,
  "artifact-contract": artifactContract,
  deliverables,
  "tool-retry": toolRetry,
};

const INCLUDE_LINE = /^\{\{>\s*([a-z0-9-]+)\s*\}\}[ \t]*$/gm;

/** 템플릿의 `{{> 이름}}` 줄을 조각으로 바꾼다. 없는 조각이나 남은 표시가 있으면 던진다(시험과 서버 시작에서 바로 드러난다). */
export function assembleRole(template: string, parts: Readonly<Record<string, string>> = ROLE_PARTS): string {
  const out = template.replace(INCLUDE_LINE, (_, name: string) => {
    const part = parts[name];
    if (part === undefined) throw new Error(`역할 조각이 없습니다: ${name}`);
    return part.replace(/\n+$/, "");
  });
  if (out.includes("{{>")) throw new Error("역할 템플릿에 조립하지 못한 조각 표시가 남았습니다");
  return out;
}

const KINDS: readonly MemberKind[] = ["conductor", "worker", "root"];
const BUILT_IN: Record<MemberKind, string> = { conductor: assembleRole(conductor), worker: assembleRole(worker), root: assembleRole(root) };

/** 조립을 마친 기본 템플릿(자리표시 그대로). `roles export` 가 꺼내는 글이고, 기준판 지문의 재료다. */
export function builtInRole(kind: MemberKind): string {
  return BUILT_IN[kind];
}

// ---- E10: 기준판 표지 ----
// 통째 교체 파일(`<kind>.md`)은 이후의 기본 규칙 개선을 받지 못한다. 꺼낸 기본 템플릿의 첫 줄에 지금 기본 규칙의 지문을 적어 두고,
// 고쳐 쓴 파일의 지문이 지금 것과 다르면 서버 로그와 점검표에 알린다. 표지 줄은 세션에 넘기기 전에 지운다.

/** 기본 템플릿의 지문(sha256 앞 12자리). 기본 규칙이 한 글자라도 바뀌면 달라진다. */
export function roleBaseHash(kind: MemberKind): string {
  return createHash("sha256").update(BUILT_IN[kind]).digest("hex").slice(0, 12);
}

/** 꺼낸 기본 템플릿의 첫 줄. 기계가 읽는 부분은 `iamceo-role-base: <kind>@<지문>` 이다. */
export function roleBaseMarker(kind: MemberKind): string {
  return `<!-- iamceo-role-base: ${kind}@${roleBaseHash(kind)} · 이 줄은 지우지 마세요. 기본 지침이 바뀌면 점검표가 알려 줍니다 · Keep this line: the self-check tells you when the default rules change -->`;
}

const MARKER = /<!--[ \t]*iamceo-role-base:[ \t]*([a-z]+)@([0-9a-f]{6,64})\b[^\n]*?-->[ \t]*\r?\n?/;
const MARKERS = new RegExp(MARKER.source, "g");

/** 파일 안의 기준판 표지. 없으면 null. */
export function readRoleBase(text: string): { kind: string; hash: string } | null {
  const m = MARKER.exec(text);
  return m ? { kind: m[1]!, hash: m[2]! } : null;
}

function stripRoleBase(text: string): string {
  return text.replace(MARKERS, "");
}

export type RoleBaseState = "current" | "stale" | "unmarked" | "other_kind";

/** 이 Mac 사용자가 고쳐 둔 역할 지침 하나(`<rolesDir>/<kind>.md`, `<kind>.extra.md`). */
export interface RoleCustomization {
  kind: MemberKind;
  /** `<kind>.md`: 기본 규칙 전체를 대신한다. base 는 기준판 표지와 지금 기본 규칙의 비교, approval 은 '승인' 낱말이 있는지. */
  replacement: { path: string; base: RoleBaseState; baseKind: string | null; approval: boolean } | null;
  /** `<kind>.extra.md`: 기본 규칙(또는 통째 교체 파일) 끝에 덧붙는다. 기본 규칙 개선은 그대로 받는다. */
  extra: { path: string } | null;
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function baseState(kind: MemberKind, text: string): { base: RoleBaseState; baseKind: string | null } {
  const marker = readRoleBase(text);
  if (!marker) return { base: "unmarked", baseKind: null };
  if (marker.kind !== kind) return { base: "other_kind", baseKind: marker.kind };
  return { base: marker.hash === roleBaseHash(kind) ? "current" : "stale", baseKind: marker.kind };
}

function replacementStatus(kind: MemberKind, path: string, text: string): NonNullable<RoleCustomization["replacement"]> {
  return { path, ...baseState(kind, text), approval: stripRoleBase(text).includes("승인") };
}

/** 고쳐 둔 역할 지침을 모은다(점검표의 `roles` 항목). 고친 것이 없으면 빈 배열. 읽지 못한 파일은 표지가 없는 것으로 본다. */
export function roleCustomizations(rolesDir: string): RoleCustomization[] {
  const out: RoleCustomization[] = [];
  for (const kind of KINDS) {
    const path = join(rolesDir, `${kind}.md`);
    const extraPath = join(rolesDir, `${kind}.extra.md`);
    let replacement: RoleCustomization["replacement"] = null;
    let extra: RoleCustomization["extra"] = null;
    try {
      const text = readIfExists(path);
      if (text !== null) replacement = replacementStatus(kind, path, text);
    } catch {
      replacement = { path, base: "unmarked", baseKind: null, approval: false };
    }
    try {
      if ((readIfExists(extraPath) ?? "").trim()) extra = { path: extraPath };
    } catch { /* 읽지 못한 덧붙임은 세션에도 들어가지 않는다 */ }
    if (replacement || extra) out.push({ kind, replacement, extra });
  }
  return out;
}

/** 통째 교체 파일의 문제(서버 로그 한 줄씩). 문제가 없으면 빈 배열. */
export function replacementWarnings(kind: MemberKind, status: NonNullable<RoleCustomization["replacement"]>): string[] {
  const { path } = status;
  const extraName = `${kind}.extra.md`;
  const out: string[] = [];
  if (!status.approval) out.push(`역할 템플릿 ${path} 에 승인 규칙이 없습니다. 기본 규칙 전체를 대체하므로 팀원이 승인 없이 일할 수 있습니다. 'iamceo roles export' 로 기본 규칙을 꺼내 고치세요`);
  if (status.base === "unmarked") {
    out.push(`역할 템플릿 ${path} 에 기준판 표지가 없어, 기본 규칙이 바뀌어도 이 파일에는 들어가지 않고 알 수도 없습니다. 'iamceo roles export' 로 새 기본 규칙을 꺼내 고친 부분을 옮기거나, 더할 규칙만 ${extraName} 로 옮기세요`);
  } else if (status.base === "stale") {
    out.push(`역할 템플릿 ${path} 은 이전 기본 규칙을 바탕으로 합니다(지금 기본 규칙 ${kind}@${roleBaseHash(kind)}). 그 뒤 바뀐 기본 규칙이 들어가지 않습니다. 'iamceo roles export' 로 꺼내 비교한 뒤 첫 줄의 기준판 표지를 새 것으로 바꾸거나, 더할 규칙만 ${extraName} 로 옮기세요`);
  } else if (status.base === "other_kind") {
    out.push(`역할 템플릿 ${path} 은 다른 역할(${status.baseKind})의 기본 규칙을 바탕으로 합니다. 'iamceo roles export' 로 꺼낸 ${kind}.example.md 에서 고치세요`);
  }
  return out;
}

/** 이름 뒤 조사. 받침이 없으면 가·를·는, 있으면 이·을·은. 한글이 아닌 끝은 받침 없는 것으로 친다. */
export function josa(name: string, withFinal: "이" | "을" | "은"): string {
  const code = name.charCodeAt(name.length - 1) - 0xac00;
  const hasFinal = code >= 0 && code <= 11171 && code % 28 !== 0;
  return name + (hasFinal ? withFinal : { 이: "가", 을: "를", 은: "는" }[withFinal]);
}

const warned = new Set<string>();

/** 같은 파일의 같은 문제는 서버가 도는 동안 한 번만 로그에 남긴다. */
function warnOnce(path: string, messages: string[]): void {
  for (const message of messages) {
    const key = `${path}\0${message}`;
    if (warned.has(key)) continue;
    warned.add(key);
    console.warn(message);
  }
}

/**
 * 기본 템플릿을 고쳐 쓸 수 있게 꺼낸다. `<kind>.example.md` 는 읽히지 않고, `<kind>.md` 로 이름을 바꾸면 쓰인다.
 * 첫 줄은 기준판 표지다. 규칙을 더하기만 하려면 `<kind>.extra.md` 에 더할 글만 쓴다(기본 규칙 개선을 계속 받는다).
 */
export function exportRoles(rolesDir: string): string[] {
  mkdirSync(rolesDir, { recursive: true, mode: 0o700 });
  return KINDS.map((kind) => {
    const path = join(rolesDir, `${kind}.example.md`);
    writeFileSync(path, `${roleBaseMarker(kind)}\n${BUILT_IN[kind]}`);
    return path;
  }).sort();
}

/** 자리표시 한 줄. 값이 비면 그 줄을 지운다. appendIfMissing 이면 자리표시 없는 고친 템플릿의 끝에 붙인다. */
function placeLine(template: string, key: "SUBAGENT_EFFORT" | "MANUAL_SESSION", value: string, appendIfMissing: boolean): string {
  if (template.includes(`{{${key}}}`)) return value ? template : template.replace(new RegExp(`^[ \\t]*\\{\\{${key}\\}\\}[ \\t]*\\n?`, "gm"), "");
  return appendIfMissing && value ? `${template.trimEnd()}\n${value}\n` : template;
}

/**
 * 역할 지침을 만든다(spec §8).
 * - `<rolesDir>/<kind>.md` 가 있으면 기본 규칙 대신 그것을 쓴다(통째 교체). 기준판 표지 줄은 지우고, 표지가 없거나 옛것이면 로그에 경고한다.
 * - `<rolesDir>/<kind>.extra.md` 가 있으면 그 끝에 덧붙인다(사용자 덧붙임, 기본으로 권하는 방식).
 * - 보고 언어 줄은 언제나 맨 끝이다. 값 안의 {{...}} 는 다시 치환하지 않는다.
 */
export function renderRole(kind: MemberKind, vars: RoleVars, rolesDir?: string): string {
  const customPath = rolesDir ? join(rolesDir, `${kind}.md`) : null;
  const custom = customPath ? readIfExists(customPath) : null;
  if (customPath && custom !== null) warnOnce(customPath, replacementWarnings(kind, replacementStatus(kind, customPath, custom)));
  const extraPath = rolesDir ? join(rolesDir, `${kind}.extra.md`) : null;
  const extra = extraPath ? stripRoleBase(readIfExists(extraPath) ?? "").trim() : "";

  const rule = vars.SUBAGENT_EFFORT ?? "";
  const manual = vars.MANUAL ? manualSession.replace(/\n+$/, "") : "";
  // 줄이 통째로 자리표시면 비었을 때 빈 줄을 남기지 않는다. 고쳐 쓴 템플릿에 자리표시가 없어도 effort 규칙은 빠지지 않게 끝에 붙인다.
  // wait 안내는 고쳐 쓴 템플릿에 자리표시가 있을 때만 넣는다(옛 템플릿에는 그 글이 이미 들어 있다).
  let template = custom !== null ? stripRoleBase(custom) : BUILT_IN[kind];
  template = placeLine(template, "SUBAGENT_EFFORT", rule, true);
  template = placeLine(template, "MANUAL_SESSION", manual, false);
  if (extra) template = `${template.trimEnd()}\n\n${extra}\n`;

  const values: Record<string, string> = { PROJECT: vars.PROJECT, NAME: vars.NAME, ROLE: vars.ROLE, CONDUCTOR: vars.CONDUCTOR, SUBAGENT_EFFORT: rule, MANUAL_SESSION: manual };
  const rendered = template.replace(/\{\{(PROJECT|NAME|ROLE|CONDUCTOR|SUBAGENT_EFFORT|MANUAL_SESSION)\}\}/g, (_, key: string) => values[key] ?? "");
  return vars.REPORT_LANGUAGE === "en" ? `${rendered.trimEnd()}\n\n${ENGLISH_REPORT_RULE}\n` : rendered;
}
