// 완성도 4차 R(B2): 오류·보류 코드의 영어 문장. 앱은 영어 화면에서 코드로 이 문장을 고른다.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ERROR_CODES, errorText, type ErrorCode, type ErrorCodeText } from "../shared/error-codes";
import { renderServerErrorTextSwift, SWIFT_PATH } from "../scripts/gen-error-text-swift";

const HANGUL = /[가-힣ㄱ-ㆎ]/;
const entries = Object.entries(ERROR_CODES as Record<string, ErrorCodeText>);

describe("코드의 영어 문장", () => {
  test("모든 코드에 영어 문장이 있고, 한글이 섞이지 않았다", () => {
    const missing = entries.filter(([, text]) => !text.en?.trim()).map(([code]) => code);
    expect(missing).toEqual([]);
    const hangul = entries.filter(([, text]) => HANGUL.test(text.en ?? "")).map(([code]) => code);
    expect(hangul).toEqual([]);
  });

  test("문장 안의 명령·설정 이름은 영어 문장에도 그대로 있다", () => {
    // 사용자가 그대로 쳐야 하는 낱말(명령, 설정 키)이 번역에서 빠지면 안내가 쓸모없어진다.
    const literal = /(tailscale (?:serve|funnel)[^.]*?(?:status|off)|iamceo open|config\.json|127\.0\.0\.1|If-Match|operationId|user_quote|answered_decision_id|same_issue|MagicDNS|HTTPS Certificates)/g;
    const lost: string[] = [];
    for (const [code, text] of entries) {
      for (const word of text.ko.match(literal) ?? []) if (!(text.en ?? "").includes(word)) lost.push(`${code}: ${word}`);
    }
    expect(lost).toEqual([]);
  });

  test("errorText 는 언어를 고른다(영어가 없으면 한국어)", () => {
    expect(errorText("unauthorized" as ErrorCode)).toBe("인증이 필요합니다");
    expect(errorText("unauthorized" as ErrorCode, "en")).toBe("Authentication required");
    expect(errorText("held_asleep" as ErrorCode, "en")).toBe("Asleep");
  });

  test("앱의 Swift 표(ServerErrorText.swift)가 이 목록과 같다", () => {
    // 다르면: bun scripts/gen-error-text-swift.ts
    expect(readFileSync(SWIFT_PATH, "utf8")).toBe(renderServerErrorTextSwift());
  });
});
