// 사람이 쓰지 않는 글자를 다룬다. 직원·외부 자료가 넣은 제어문자가 줄 경계나 출처 접두어를 속이지 못하게 한다.
const LINE_BREAKS = /\r\n?|[\u000b\u000c\u0085\u2028\u2029]/g;
// C0·C1 제어문자(탭·줄바꿈 제외), 제로폭, 양방향 제어, 화면에 안 보이는 한글 채움 글자, 태그 문자.
const INVISIBLE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb]|[\u{e0000}-\u{e0fff}]/gu;

export function cleanText(text: string): string {
  return text.replace(LINE_BREAKS, "\n").replace(INVISIBLE, "");
}

/** 한 줄 값이 아니면 까닭을 돌려준다. 이름·제목·버튼 글처럼 전달 글의 머리에 들어가는 값에 쓴다. */
export function oneLineProblem(value: string, max: number): string | null {
  if (value !== cleanText(value) || /[\n\t]/.test(value)) return "줄바꿈이나 제어문자를 넣을 수 없습니다";
  if (value.length > max) return `${max}자를 넘을 수 없습니다`;
  return null;
}

/** 직원 이름은 `[총괄] <이름>에게`·`[보고 <이름>]` 안에 그대로 들어간다. 접두어를 닫거나 흉내 낼 글자를 받지 않는다. */
const NAME_FORBIDDEN = /[\[\]"'`<>]/;
export const MAX_NAME = 40;
export const MAX_ROLE = 300;
export const MAX_PROJECT_NAME = 100;

export function nameProblem(value: string): string | null {
  const line = oneLineProblem(value, MAX_NAME);
  if (line) return line;
  if (NAME_FORBIDDEN.test(value.normalize("NFKC"))) return `다음 글자는 쓸 수 없습니다: [ ] " ' \` < >`;
  return null;
}

// 대화 작성자·`[보고 <이름>]` 에서 대표나 서버처럼 보이는 이름. '서버 담당'·'보고서 담당' 같은 이름은 그대로 받는다.
const RESERVED_NAMES = new Set(["총괄", "본사AI", "시스템", "보고", "서버"]);
const RESERVED_NAME_PREFIX = /^(?:대표|代表)/;
export const RESERVED_HANDLES = new Set(["lead", "root"]);

/** 직원 이름 검사. 총괄·본사 AI 자신의 이름은 서버가 정하므로 여기를 지나지 않는다. */
export function workerNameProblem(value: string): string | null {
  const basic = nameProblem(value);
  if (basic) return basic;
  const plain = value.normalize("NFKC").replace(/\s+/g, "");
  return RESERVED_NAME_PREFIX.test(plain) || RESERVED_NAMES.has(plain) || (plain.endsWith("총괄") && !plain.startsWith("직원")) ? `대표·총괄·서버로 보이는 이름은 직원 이름으로 쓸 수 없습니다: ${value}` : null;
}

/** 가져오기처럼 거부할 수 없는 경로에서 이름을 안전하게 깎는다. */
export function cleanName(raw: string, fallback: string): string {
  const name = cleanText(raw).normalize("NFKC").replace(/[\[\]"'`<>\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return name || fallback;
}

export function cleanRole(raw: string): string {
  return cleanText(raw).replace(/\s+/g, " ").trim().slice(0, MAX_ROLE);
}

export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 총괄은 프로젝트마다 하나라 프로젝트 이름을 붙여야 세션 이름이 겹치지 않는다. */
export function conductorName(projectName: string): string {
  return `${projectName} 총괄`.slice(0, MAX_NAME);
}

export function conductorHandle(projectName: string): string {
  const slug = projectName.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "").slice(0, 26).replace(/-+$/, "");
  return slug ? `${slug}-lead` : "lead";
}
