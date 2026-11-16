import type { TextLang } from "../shared/server-text.ts";

// 사람이 쓰지 않는 글자를 다룬다. 직원·외부 자료가 넣은 제어문자가 줄 경계나 출처 접두어를 속이지 못하게 한다.
const LINE_BREAKS = /\r\n?|[\u000b\u000c\u0085\u2028\u2029]/g;
// C0·C1 제어문자(탭·줄바꿈 제외), 제로폭, 양방향 제어, 화면에 안 보이는 한글 채움 글자, 태그 문자.
const INVISIBLE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb]|[\u{e0000}-\u{e0fff}]/gu;

export function cleanText(text: string): string {
  return text.replace(LINE_BREAKS, "\n").replace(INVISIBLE, "");
}

/**
 * 0.2.7 묶음 4(D5-10): 대표가 쓴 글(대화·결재 메모·할 일 답)에 섞여 들어온 C0·C1 제어문자(백스페이스 0x08 등)를 저장 전에 지운다.
 * 탭·줄바꿈은 남기고 CR·CRLF 는 줄바꿈으로 맞춘다. cleanText 와 달리 제로폭 결합 문자(이모지의 ZWJ 등)는 건드리지 않는다: 대표가 쓴 글 그대로 보여야 한다.
 */
const OWNER_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
export function stripControls(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(OWNER_CONTROLS, "");
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
  return RESERVED_NAME_PREFIX.test(plain) || RESERVED_NAMES.has(plain) || (plain.endsWith("총괄") && !plain.startsWith("직원")) ? `대표·총괄·서버로 보이는 이름은 팀장 이름으로 쓸 수 없습니다: ${value}` : null;
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

/**
 * 총괄은 프로젝트마다 하나라 프로젝트 이름을 붙여야 세션 이름이 겹치지 않는다.
 * 0.2.6 Y: 서버가 정하는 기본 이름이라 만들 때의 보고 언어를 따른다(한국어 'X 총괄', 영어 'X Lead'). 이미 있는 이름은 바꾸지 않는다.
 */
export function conductorName(projectName: string, lang: TextLang = "ko"): string {
  return `${projectName} ${DEFAULT_NAMES[lang].lead}`.slice(0, MAX_NAME);
}

/** 0.2.6 Y: 서버가 처음 만드는 이름. 본사 프로젝트(hq)·본사 AI 와 그 역할, 프로젝트 총괄의 이름 꼬리와 역할. */
export const DEFAULT_NAMES = {
  ko: { hq: "본사", hqAgent: "본사 AI", hqRole: "프로젝트 만들기와 잡다한 일", lead: "총괄", leadRole: "총괄" },
  en: { hq: "HQ", hqAgent: "HQ AI", hqRole: "Creating projects and odd jobs", lead: "Lead", leadRole: "Lead" },
} as const satisfies Record<TextLang, Record<string, string>>;

/**
 * 0.2.6 Y: 새로 설치한 서버의 첫 실행 언어. IAMCEO_LANG 만 본다(앱이 '이 Mac에서 시작'으로 서비스를 등록할 때 앱 화면 언어를,
 * 명령줄 iamceo service install 은 새 데이터 폴더일 때 그 터미널의 언어를 서비스 환경에 적는다). 없으면 예전처럼 한국어다.
 * LANG 은 보지 않는다: launchd 로 뜬 서버에는 보통 없고, 한국어 사용자의 Mac 에도 en_US 인 경우가 흔하다.
 */
export function firstRunLang(env: NodeJS.ProcessEnv = process.env): TextLang {
  const value = (env.IAMCEO_LANG ?? "").trim().toLowerCase();
  return value && !value.startsWith("ko") ? "en" : "ko";
}

export function conductorHandle(projectName: string): string {
  const slug = projectName.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "").slice(0, 26).replace(/-+$/, "");
  return slug ? `${slug}-lead` : "lead";
}
