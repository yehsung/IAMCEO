// 명령줄(bin/iamceo.ts, 설치 스크립트 도우미)에 찍는 문구를 한국어·영어 중 하나로 고른다.
// 고르는 순서: IAMCEO_LANG → LC_ALL → LANG. 값이 "ko" 로 시작하면 한국어, 그 밖에는 영어.
// 환경 변수는 부를 때마다 다시 읽는다(시험이 중간에 바꿔도 맞게).

export type CliLang = "ko" | "en";

function pick(value: string | undefined): CliLang | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  return v.toLowerCase().startsWith("ko") ? "ko" : "en";
}

/** 지금 명령줄이 쓸 언어. IAMCEO_LANG 이 있으면 그것, 없으면 LC_ALL·LANG 이 ko 로 시작할 때 한국어. */
export function cliLang(env: NodeJS.ProcessEnv = process.env): CliLang {
  return pick(env.IAMCEO_LANG) ?? pick(env.LC_ALL) ?? pick(env.LANG) ?? "en";
}

/** 한국어·영어 문구 중 지금 언어에 맞는 하나를 돌려준다. */
export function say(ko: string, en: string): string {
  return cliLang() === "ko" ? ko : en;
}
