// 빌드된 앱 번들의 언어 폴더 검사(scripts/check-app-languages.sh, 4차 lang-6).
// 앱의 대체 언어가 en 이라 ko.lproj 에 없는 문구 파일은 한국어 기기도 en.lproj 에서 읽는다. 그 빠짐을 빌드 뒤에 잡는지 본다.
// 임시 폴더에 가짜 번들만 만든다(실제 빌드·앱은 쓰지 않는다).
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const script = join(root, "scripts/check-app-languages.sh");
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function bundle(layout: "mac" | "ios", files: Record<string, string[]>) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-app-languages-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const app = join(dir, "IAMCEO.app");
  const resources = layout === "mac" ? join(app, "Contents", "Resources") : app;
  for (const [language, names] of Object.entries(files)) {
    mkdirSync(join(resources, `${language}.lproj`), { recursive: true });
    for (const name of names) writeFileSync(join(resources, `${language}.lproj`, name), "");
  }
  return app;
}

function check(...apps: string[]) {
  const result = Bun.spawnSync(["/bin/bash", script, ...apps], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

const all = ["InfoPlist.strings", "Localizable.strings", "Localizable.stringsdict"];

test("check-app-languages: ko.lproj 에 en.lproj 의 파일이 모두 있으면 통과한다(Mac·iPhone 번들 모양 둘 다)", () => {
  const result = check(bundle("mac", { en: all, ko: all }), bundle("ios", { en: all, ko: [...all, "Extra.strings"] }));
  expect(result.output).toContain("every en.lproj file is also in ko.lproj (2 app(s))");
  expect(result.code).toBe(0);
});

test("check-app-languages: 한국어 쪽에 복수형·권한 안내 파일이 없으면 그 이름을 대며 막는다(4차 확인에서 본 빌드 그대로)", () => {
  const mac = bundle("mac", { en: all, ko: ["Localizable.strings"] });
  const result = check(mac);
  expect(result.code).toBe(1);
  expect(result.output).toContain("ko.lproj/InfoPlist.strings is missing");
  expect(result.output).toContain("ko.lproj/Localizable.stringsdict is missing");
  expect(result.output).not.toContain("ko.lproj/Localizable.strings is missing");
});

test("check-app-languages: 언어 폴더가 없거나 비었으면 막고, 번들을 주지 않으면 사용법을 알린다", () => {
  expect(check(bundle("ios", { en: all })).output).toContain("has no en.lproj or ko.lproj");
  expect(check(bundle("ios", { en: [], ko: all })).output).toContain("en.lproj is empty");
  expect(check(bundle("ios", { en: [], ko: all })).code).toBe(1);
  const usage = check();
  expect(usage.code).toBe(2);
  expect(usage.output).toContain("Usage:");
});

test("check.sh build 는 두 앱을 지은 뒤 이 검사를 돌린다", () => {
  const text = readFileSync(join(root, "scripts/check.sh"), "utf8");
  const build = text.slice(text.indexOf("build() {"), text.indexOf("\n}", text.indexOf("build() {")));
  expect(build).toContain('bash scripts/check-app-languages.sh "$CHECK_ROOT/dd-mac/Build/Products/Debug/IAMCEO.app"');
  expect(build).toContain('"$CHECK_ROOT/dd-ios/Build/Products/Debug-iphonesimulator/IAMCEO.app"');
  expect(build.indexOf("check-app-languages.sh")).toBeGreaterThan(build.lastIndexOf("xcodebuild"));
});
