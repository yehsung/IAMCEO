// 0.2.5 W: App Store 등록 정보(docs/appstore/ko.md·en.md)의 글이 App Store Connect 의 한도와 약속을 지키는지.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../docs/appstore");
const FIELDS = ["name", "subtitle", "promotionalText", "description", "keywords", "whatsNew"] as const;
type Field = (typeof FIELDS)[number];
/** App Store Connect 의 글자 수 한도(문자). */
const LIMITS: Record<Field, number> = { name: 30, subtitle: 30, promotionalText: 170, description: 4000, keywords: 100, whatsNew: 4000 };

/** `## <칸>` 아래 첫 ```text 상자의 글. */
export function parseListing(markdown: string): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {};
  for (const section of markdown.split(/^## /m).slice(1)) {
    const field = section.split("\n", 1)[0].trim() as Field;
    const block = /```text\n([\s\S]*?)\n```/.exec(section);
    if ((FIELDS as readonly string[]).includes(field) && block) out[field] = block[1];
  }
  return out;
}

const listings = {
  ko: parseListing(readFileSync(resolve(ROOT, "ko.md"), "utf8")),
  en: parseListing(readFileSync(resolve(ROOT, "en.md"), "utf8")),
};

describe("App Store 등록 정보", () => {
  for (const [lang, listing] of Object.entries(listings)) {
    test(`${lang}: 모든 칸이 있고 한도를 넘지 않는다`, () => {
      for (const field of FIELDS) {
        const text = listing[field];
        expect(text, `${lang}.${field}`).toBeDefined();
        expect(text!.trim().length, `${lang}.${field}`).toBeGreaterThan(0);
        // App Store Connect 는 글자(UTF-16 단위가 아니라 문자) 수로 센다.
        expect([...text!].length, `${lang}.${field}`).toBeLessThanOrEqual(LIMITS[field]);
      }
      expect([...listing.name!].length).toBeGreaterThanOrEqual(2);
      // 키워드: 쉼표로 나누고 쉼표 뒤에 띄어 쓰지 않는다(빈 칸·중복 없음). 한국어도 바이트로 세는 경우를 생각해 100바이트 안으로.
      const keywords = listing.keywords!.split(",");
      expect(keywords.every(word => word.length > 0 && word === word.trim())).toBe(true);
      expect(new Set(keywords.map(word => word.toLowerCase())).size).toBe(keywords.length);
      expect(Buffer.byteLength(listing.keywords!, "utf8")).toBeLessThanOrEqual(100);
    });

    test(`${lang}: 키워드에 상표·다른 앱 이름이 없고, iPhone 알림은 조건(Mac 서버 0.2.5 이상)과 중계를 함께 밝힌다`, () => {
      // 심사 지침 2.3.7: 키워드에 상표나 다른 앱의 이름을 넣지 않는다.
      expect(listing.keywords!).not.toMatch(/claude|codex|anthropic|openai|tailscale|github|chatgpt|cursor/i);
      // 0.2.5 부터 App Store 판도 알림 중계로 알림을 받는다(PRIVACY.md 1·2절). 새로운 기능은 Mac 서버 판 조건을, 설명은 중계를 밝힌다.
      expect(listing.whatsNew!).toMatch(lang === "ko" ? /알림[^\n]*0\.2\.5/ : /notifications[^\n]*0\.2\.5/i);
      expect(listing.description!).toMatch(lang === "ko" ? /중계/ : /relay/);
      // "운영하는 서버가 없다"는 말은 중계와 어긋난다.
      expect(listing.description!).not.toMatch(/IAMCEO가 운영하는 서버도 없|no IAMCEO cloud/);
      // 이름은 두 언어가 같다.
      expect(listing.name).toBe("IAMCEO");
    });
  }

  test("영어 등록 정보에는 한글이 없다(언어 선택지 이름 '한국어'만 빼고)", () => {
    for (const field of FIELDS) expect(listings.en[field]!.replaceAll("한국어", ""), field).not.toMatch(/[가-힣]/);
  });

  test("두 언어의 새로운 기능은 같은 항목 수이고, 설명은 샘플과 언어 선택을 알린다", () => {
    const bullets = (text: string) => text.split("\n").filter(line => line.startsWith("• ")).length;
    expect(bullets(listings.ko.whatsNew!)).toBe(bullets(listings.en.whatsNew!));
    expect(listings.en.description).toContain("Explore the sample");
    expect(listings.ko.description).toContain("샘플로 둘러보기");
    expect(listings.en.description).toContain("Settings → General → Language");
    expect(listings.ko.description).toContain("설정 → 일반 → 언어");
  });

  test("읽는 함수는 칸 이름과 글 상자만 본다", () => {
    expect(parseListing("## name\n\n설명\n\n```text\nX\n```\n\n## other\n```text\nY\n```\n")).toEqual({ name: "X" });
  });
});
