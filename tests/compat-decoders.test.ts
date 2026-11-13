// D5 호환 게이트(scripts/compat-decoders/run.ts)의 손질 부분: 태그 파일에서 해석부만 원문 그대로 꺼내기, 버전 머리글을 보내는
// 출시 앱(0.2.4 부터)의 덤프가 그 앱이 실제로 보내는 머리글로 받은 것인지 견주기. git 은 부르지 않는다(가짜 show).
// 실제 태그로 빌드해 덤프를 읽는 것은 scripts/check.sh compat 이 한다.
import { describe, expect, test } from "bun:test";
import { appHeadersDumpDir, checkAppHeaders, loadReleases, MUTATIONS, releaseSource, type ReleaseFile } from "../scripts/compat-decoders/run.ts";
import { APP_HEADERS } from "../shared/types.ts";

const VIEW = [
  "import SwiftUI",
  "import Foundation",
  "",
  "/// 해석부.",
  "struct DeviceList: Decodable {",
  "    var devices: [String]",
  "}",
  "",
  "/// 화면 글자.",
  "struct DeviceView: View {}",
  "    } catch let failure as APIError where failure.code == \"device_not_found\" {",
].join("\n");
const show = (files: Record<string, string>) => (path: string) =>
  path in files ? { ok: true, out: files[path]!, err: "" } : { ok: false, out: "", err: `fatal: path '${path}' does not exist` };
const slice = (extra: Partial<Exclude<ReleaseFile, string>> = {}): ReleaseFile =>
  ({ path: "Views/DeviceView.swift", from: "/// 해석부.", to: "/// 화면 글자.", imports: ["Foundation"], ...extra });

describe("releaseSource: 태그 파일 꺼내기", () => {
  test("글자 항목은 파일 전체를 그대로", () => {
    expect(releaseSource("v9.9.9", "Views/DeviceView.swift", show({ "Views/DeviceView.swift": VIEW }))).toEqual({ name: "DeviceView.swift", text: VIEW });
  });

  test("조각은 from 줄부터 to 줄 앞까지를 원문 그대로 두고, 위에 출처와 정한 import 만 붙인다(앱 안 모듈 import 는 버린다)", () => {
    const source = releaseSource("v9.9.9", slice(), show({ "Views/DeviceView.swift": VIEW }));
    expect("text" in source).toBe(true);
    const lines = (source as { text: string }).text.split("\n");
    expect(lines[0]).toContain("v9.9.9:Views/DeviceView.swift 의 4~8줄(원문 그대로)");
    expect(lines.slice(1)).toEqual(["import Foundation", "", "/// 해석부.", "struct DeviceList: Decodable {", "    var devices: [String]", "}", ""]);
    expect((source as { text: string }).text).not.toContain("SwiftUI");
  });

  test("자리가 없거나 두 곳이거나 거꾸로면 실패한다(엉뚱한 조각을 빌드하지 않는다)", () => {
    const fails = (file: ReleaseFile, text = VIEW) => "error" in releaseSource("v9.9.9", file, show({ "Views/DeviceView.swift": text }));
    expect(fails(slice({ from: "/// 없는 표지" }))).toBe(true);
    expect(fails(slice(), `${VIEW}\n/// 해석부.`)).toBe(true);
    expect(fails(slice({ from: "/// 화면 글자.", to: "/// 해석부." }))).toBe(true);
    expect(fails("Views/Missing.swift")).toBe(true);
  });

  test("mirrored: Harness.swift 가 옮겨 쓴 원문이 태그 파일에 그대로 있어야 한다", () => {
    const files = { "Views/DeviceView.swift": VIEW };
    expect("text" in releaseSource("v9.9.9", slice({ mirrored: ["} catch let failure as APIError where failure.code == \"device_not_found\" {"] }), show(files))).toBe(true);
    const changed = releaseSource("v9.9.9", slice({ mirrored: ["failure.code == \"device_gone\""] }), show(files));
    expect("error" in changed && changed.error).toContain("옮겨 쓴 원문이 없습니다");
  });
});

describe("checkAppHeaders: 덤프가 그 앱의 머리글로 받았는가", () => {
  const appVersion = [
    "enum AppVersion {",
    "    static let apiLevel = 1",
    `    static let versionHeader = "${APP_HEADERS.version}"`,
    `    static let buildHeader = "${APP_HEADERS.build}"`,
    `    static let platformHeader = "${APP_HEADERS.platform}"`,
    `    static let apiLevelHeader = "${APP_HEADERS.apiLevel}"`,
    "}",
  ].join("\n");
  const sources = new Map([["AppVersion.swift", appVersion]]);
  const headers = { version: "0.2.4", platform: "ios" as const, apiLevel: 1 };
  const sent = { [APP_HEADERS.version]: "0.2.4", [APP_HEADERS.build]: "1", [APP_HEADERS.platform]: "ios", [APP_HEADERS.apiLevel]: "1" };

  test("태그·앱 원문·보낸 머리글이 모두 맞으면 통과", () => {
    expect(checkAppHeaders("v0.2.4", headers, sent, sources)).toBeNull();
  });

  test("어긋나면 이유와 함께 실패", () => {
    expect(checkAppHeaders("v0.2.5", headers, sent, sources)).toContain("태그");
    expect(checkAppHeaders("v0.2.4", { ...headers, apiLevel: 2 }, sent, sources)).toContain("apiLevel");
    expect(checkAppHeaders("v0.2.4", headers, { ...sent, [APP_HEADERS.platform]: "macos" }, sources)).toContain(APP_HEADERS.platform);
    const { [APP_HEADERS.build]: _build, ...withoutBuild } = sent;
    expect(checkAppHeaders("v0.2.4", headers, withoutBuild, sources)).toContain("덤프가 보낸 머리글");
    expect(checkAppHeaders("v0.2.4", headers, undefined, sources)).toContain("appHeaders.sent");
    expect(checkAppHeaders("v0.2.4", headers, sent, new Map())).toContain("AppVersion.swift");
    // 앱이 다섯째 머리글을 보낸다면 게이트가 모르는 머리글이라 덤프를 다시 맞춰야 한다.
    const more = new Map([["AppVersion.swift", `${appVersion}\n    static let localeHeader = "X-IAMCEO-App-Locale"`]]);
    expect(checkAppHeaders("v0.2.4", headers, sent, more)).toContain("넷");
  });
});

describe("releases.json 과 자체 검사", () => {
  test("머리글을 보내는 태그는 AppVersion.swift 와 0.2.4 해석기 조건을 함께 둔다", () => {
    const releases = loadReleases();
    expect(releases.map(release => release.tag)).toEqual(expect.arrayContaining(["v0.2.2", "v0.2.3", "v0.2.4"]));
    for (const release of releases.filter(item => item.appHeaders)) {
      const paths = release.files.map(file => typeof file === "string" ? file : file.path);
      expect(paths).toContain("native/Sources/IAMCEO/Services/AppVersion.swift");
      expect(paths).toContain("native/Sources/IAMCEO/Views/ConnectedDevicesView.swift");
      expect(release.defines).toContain("COMPAT_SINCE_0_2_4");
      expect(`v${release.appHeaders!.version}`).toBe(release.tag);
    }
    expect(releases.find(release => release.tag === "v0.2.3")?.appHeaders).toBeUndefined();
  });

  test("덤프 하위 폴더 이름은 태그에서 바로 나온다", () => {
    expect(appHeadersDumpDir("v0.2.4")).toBe("app-v0.2.4");
    expect(appHeadersDumpDir("v1/x")).toBe("app-v1_x");
  });

  test("0.2.4 몫 망가뜨리기는 머리글을 보내는 덤프에만 건다(머리글 없는 덤프에는 그 칸·파일이 없다)", () => {
    const only = MUTATIONS.filter(mutation => mutation.appHeaders).map(mutation => mutation.file);
    expect(only).toEqual(expect.arrayContaining(["bootstrap.json", "devices-remote.json", "devices-revoke-refused.json", "devices-revoke-refused-en.json"]));
    expect(MUTATIONS.filter(mutation => !mutation.appHeaders).length).toBe(7);
  });
});
