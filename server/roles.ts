import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemberKind, ReportLanguage } from "../shared/types.ts";
import conductor from "./roles/conductor.md" with { type: "text" };
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
}

/**
 * B1: 보고 언어가 영어일 때 지침 끝에 붙는 글. 첫 줄은 대표에게 쓰는 글을 영어로, 둘째 줄은 서버 머리말의 뜻.
 * 머리말([대표]·[총괄] 등)은 서버만 붙이는 규약 표지라 번역하지 않는다. 고쳐 쓴 템플릿에도 빠지지 않게 끝에 붙인다.
 */
export const ENGLISH_REPORT_RULE = `## Report language
- Write everything the owner (대표) reads in English: \`post\` reports, \`ask\` cards (title, background, options, recommendation), \`todo\` items, \`status\` lines, file titles and replies. This replaces any rule above that asks for Korean or for a Korean translation of English text. Keep code, commands, paths and quoted text as they are.
- The source labels the server puts on your input stay in Korean because they are protocol markers, not a language hint: \`[대표]\` the owner, \`[대표 직접]\` the owner writing to you directly, \`[대표 답(원문) ...]\` the owner's verbatim answer to a card, \`[총괄] <name>에게\` an instruction from the lead, \`[보고 <name>]\` a report from a staff session, \`[시스템]\` the server; \`사용자 요청(원문, 서버 확인)\` is an owner quote the server verified, \`총괄 인용(미확인)\` a quote it could not verify.`;

const BUILT_IN: Record<MemberKind, string> = { conductor, root, worker };

/** 이름 뒤 조사. 받침이 없으면 가·를·는, 있으면 이·을·은. 한글이 아닌 끝은 받침 없는 것으로 친다. */
export function josa(name: string, withFinal: "이" | "을" | "은"): string {
  const code = name.charCodeAt(name.length - 1) - 0xac00;
  const hasFinal = code >= 0 && code <= 11171 && code % 28 !== 0;
  return name + (hasFinal ? withFinal : { 이: "가", 을: "를", 은: "는" }[withFinal]);
}

const warned = new Set<string>();

/** 기본 템플릿을 고쳐 쓸 수 있게 꺼낸다. `<kind>.example.md` 는 읽히지 않고, `<kind>.md` 로 이름을 바꾸면 쓰인다. */
export function exportRoles(rolesDir: string): string[] {
  mkdirSync(rolesDir, { recursive: true, mode: 0o700 });
  return (Object.keys(BUILT_IN) as MemberKind[]).map((kind) => {
    const path = join(rolesDir, `${kind}.example.md`);
    writeFileSync(path, BUILT_IN[kind]);
    return path;
  });
}

/** `<rolesDir>/<kind>.md` 가 있으면 그것을 쓴다(spec §8). 값 안의 {{...}} 는 다시 치환하지 않는다. */
export function renderRole(kind: MemberKind, vars: RoleVars, rolesDir?: string): string {
  const custom = rolesDir ? join(rolesDir, `${kind}.md`) : null;
  const useCustom = !!custom && existsSync(custom);
  const template = useCustom ? readFileSync(custom, "utf8") : BUILT_IN[kind];
  if (useCustom && !warned.has(custom) && !template.includes("승인")) {
    warned.add(custom);
    console.warn(`역할 템플릿 ${custom} 에 승인 규칙이 없습니다. 기본 규칙 전체를 대체하므로 팀원이 승인 없이 일할 수 있습니다. 'iamceo roles export' 로 기본 규칙을 꺼내 고치세요`);
  }
  const rule = vars.SUBAGENT_EFFORT ?? "";
  // 줄이 통째로 자리표시면 비었을 때 빈 줄을 남기지 않는다. 고쳐 쓴 템플릿에 자리표시가 없어도 규칙은 빠지지 않게 끝에 붙인다.
  const placed = template.includes("{{SUBAGENT_EFFORT}}") ? (rule ? template : template.replace(/^[ \t]*\{\{SUBAGENT_EFFORT\}\}[ \t]*\n?/gm, "")) : rule ? `${template.trimEnd()}\n${rule}\n` : template;
  const rendered = placed.replace(/\{\{(PROJECT|NAME|ROLE|CONDUCTOR|SUBAGENT_EFFORT)\}\}/g, (_, key: Exclude<keyof RoleVars, "REPORT_LANGUAGE">) => vars[key] ?? "");
  return vars.REPORT_LANGUAGE === "en" ? `${rendered.trimEnd()}\n\n${ENGLISH_REPORT_RULE}\n` : rendered;
}
