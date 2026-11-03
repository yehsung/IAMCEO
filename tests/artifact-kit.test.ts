// 아티팩트 문서 조립(shared/artifact-kit.ts). 실제 브라우저에서의 격리는 tests/artifact.browser.ts 가 본다.
import { describe, expect, test } from "bun:test";
import { ARTIFACT_CSP, ARTIFACT_KIT_CSS, buildArtifactSrcdoc } from "../shared/artifact-kit.ts";

const META = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`;

describe("buildArtifactSrcdoc", () => {
  test("CSP 는 요구한 값이고 지켜야 할 것을 다 막는다", () => {
    expect(ARTIFACT_CSP).toBe("default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'");
  });

  test("작성자 스크립트보다 먼저 WebRTC 생성자를 지운다", () => {
    const out = buildArtifactSrcdoc("<p>본문</p>");
    expect(out.indexOf("RTCPeerConnection")).toBeGreaterThan(0);
    expect(out.indexOf("RTCPeerConnection")).toBeLessThan(out.indexOf("<p>본문</p>"));
  });

  test("순서: 메타 → 키트 → 높이 보고 → 작성자", () => {
    const out = buildArtifactSrcdoc("<p>본문</p>");
    const order = [out.indexOf(META), out.indexOf("<style>"), out.indexOf("iamceoHeight"), out.indexOf("<p>본문</p>")];
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out.startsWith('<!doctype html><html lang="ko"><head><meta http-equiv="Content-Security-Policy"')).toBe(true);
  });

  const TRICKS = [
    "<!doctype html><html><head><meta http-equiv='Content-Security-Policy' content=\"default-src *\"><title>x</title></head><body>글</body></html>",
    "--><script>1</script>",
    "</style></head><script>1</script>",
    "<!--",
    "</script><script>1</script>",
    "<base href='https://evil.example/'>",
    "﻿<!DOCTYPE html>",
    "\0<meta http-equiv=refresh content='0;url=https://evil.example'>",
  ];
  test.each(TRICKS)("어떤 작성자 글이어도 메타가 먼저다: %s", (html) => {
    const out = buildArtifactSrcdoc(html);
    const head = out.slice(0, out.indexOf("</head><body>"));
    expect(out.indexOf(META)).toBeLessThan(out.indexOf("<style>"));
    // 앞머리는 작성자 글과 상관없이 늘 같다.
    expect(head).toBe(buildArtifactSrcdoc("").slice(0, buildArtifactSrcdoc("").indexOf("</head><body>")));
    expect(out).not.toContain("\0");
  });

  test("제목·언어는 깨지지 않게 넣는다", () => {
    const out = buildArtifactSrcdoc("x", { title: '</title><script>alert(1)</script>"', lang: 'ko"><script>' });
    expect(out).not.toContain("</title><script>alert(1)");
    expect(out).toContain("&lt;/title&gt;");
    expect(out).toContain('<html lang="ko">');
  });

  test("키트: 모든 조각이 있고 작성자 CSS 가 덮을 수 있게 우선순위가 0 이다", () => {
    for (const piece of [".card", ".grid", ".callout", ".kpi", ".steps", ".tag", ".compare", "table", "pre", "h1", "@media"]) expect(ARTIFACT_KIT_CSS).toContain(piece);
    for (const line of ARTIFACT_KIT_CSS.split("\n")) if (!line.startsWith("@media")) expect(line.startsWith(":where(")).toBe(true);
    expect(ARTIFACT_KIT_CSS).not.toContain("url(");
  });
});
