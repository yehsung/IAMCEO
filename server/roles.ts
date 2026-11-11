import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemberKind } from "../shared/types.ts";
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
}

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
  return placed.replace(/\{\{(PROJECT|NAME|ROLE|CONDUCTOR|SUBAGENT_EFFORT)\}\}/g, (_, key: keyof RoleVars) => vars[key] ?? "");
}
