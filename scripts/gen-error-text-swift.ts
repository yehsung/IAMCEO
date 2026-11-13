/**
 * shared/error-codes.ts 의 코드별 문장(ko·en)을 앱이 쓰는 Swift 표로 옮긴다(완성도 4차 R, B2).
 * 앱은 영어 화면에서 서버가 보낸 오류 문장이 그 코드의 대표 문장(ko)과 같을 때 en 을 고른다.
 *
 *   bun scripts/gen-error-text-swift.ts          # 파일을 다시 쓴다
 *   bun scripts/gen-error-text-swift.ts --check  # 다르면 1 로 끝난다(tests/error-codes-en.test.ts 와 같은 검사)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ERROR_CODES, type ErrorCodeText } from "../shared/error-codes";

export const SWIFT_PATH = join(resolve(import.meta.dir, ".."), "native/Sources/IAMCEO/Models/ServerErrorText.swift");

function swiftString(value: string): string {
  return JSON.stringify(value).replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => `\\u{${hex}}`);
}

export function renderServerErrorTextSwift(): string {
  const rows = Object.entries(ERROR_CODES as Record<string, ErrorCodeText>)
    .map(([code, text]) => `        ${swiftString(code)}: (ko: ${swiftString(text.ko)}, en: ${swiftString(text.en ?? text.ko)}),`);
  return [
    "// 생성된 파일 — 손으로 고치지 않는다. 원본은 shared/error-codes.ts, 다시 만들기: bun scripts/gen-error-text-swift.ts",
    "",
    "/// 서버 오류·보류 코드마다 대표 문장(ko)과 영어 문장(en). 표시 규칙은 ServerErrorDisplay.swift.",
    "enum ServerErrorText {",
    "    static let table: [String: (ko: String, en: String)] = [",
    ...rows,
    "    ]",
    "}",
    "",
  ].join("\n");
}

if (import.meta.main) {
  const next = renderServerErrorTextSwift();
  if (process.argv.includes("--check")) {
    const current = readFileSync(SWIFT_PATH, "utf8");
    if (current !== next) {
      console.error("ServerErrorText.swift is out of date. Run: bun scripts/gen-error-text-swift.ts");
      process.exit(1);
    }
  } else {
    writeFileSync(SWIFT_PATH, next);
    console.log(`Wrote ${SWIFT_PATH}`);
  }
}
