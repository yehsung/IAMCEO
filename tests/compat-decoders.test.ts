// D5 호환 게이트(scripts/compat-decoders/run.ts)의 손질 부분: 태그 파일에서 해석부만 원문 그대로 꺼내기, 버전 머리글을 보내는
// 출시 앱(0.2.4 부터)의 덤프가 그 앱이 실제로 보내는 머리글로 받은 것인지 견주기. git 은 부르지 않는다(가짜 show).
// 실제 태그로 빌드해 덤프를 읽는 것은 scripts/check.sh compat 이 한다.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appHeadersDumpDir, checkAppHeaders, loadReleases, MUTATIONS, mutationsFor, releaseSource, type ReleaseFile, type SliceFile } from "../scripts/compat-decoders/run.ts";
import { SERVER_TEXTS } from "../shared/server-text.ts";
import { APP_HEADERS, REPLY_STATES } from "../shared/types.ts";

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
const slice = (extra: Partial<SliceFile> = {}): ReleaseFile =>
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

  test("mirrorOnly: 빌드할 글 없이 옮겨 쓴 원문만 견준다(AppStore 확장처럼 따로 빌드할 수 없는 파일)", () => {
    const store = "extension AppStore {\n    var currentServerID: String? { ServerVersionInfo.normalizedID(bootstrap?.server?.id) }\n}\n";
    const files = { "State/AppStore+Offline.swift": store };
    const only = (mirrored: string[]): ReleaseFile => ({ path: "State/AppStore+Offline.swift", mirrorOnly: true, mirrored });
    const ok = releaseSource("v9.9.9", only(["var currentServerID: String? { ServerVersionInfo.normalizedID(bootstrap?.server?.id) }"]), show(files));
    expect(ok).toEqual({ name: "AppStore+Offline.swift", mirrorOnly: true });
    expect("text" in ok).toBe(false);
    const changed = releaseSource("v9.9.9", only(["var currentServerID: String? { bootstrap?.server?.id }"]), show(files));
    expect("error" in changed && changed.error).toContain("옮겨 쓴 원문이 없습니다");
    // 견줄 줄이 없으면 아무것도 지키지 않으므로 실패로 친다.
    const empty = releaseSource("v9.9.9", only([]), show(files));
    expect("error" in empty && empty.error).toContain("mirrored 가 없습니다");
    expect("error" in releaseSource("v9.9.9", only(["x"]), show({}))).toBe(true);
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

  test("0.2.5 는 0.2.4 조건을 함께 켜고, 서버 신원(ServerIdentity)과 대기열 판정 원문을 함께 둔다", () => {
    const releases = loadReleases();
    const release = releases.find(item => item.tag === "v0.2.5");
    expect(release?.appHeaders).toEqual({ version: "0.2.5", platform: "ios", apiLevel: 1 });
    expect(release?.defines).toEqual(["COMPAT_SINCE_0_2_4", "COMPAT_SINCE_0_2_5"]);
    const objects = release!.files.filter((file): file is Exclude<ReleaseFile, string> => typeof file !== "string");
    expect(objects.find(file => file.path.endsWith("State/OfflineState.swift") && "from" in file && file.from === "enum ServerIdentity")).toBeDefined();
    const store = objects.find(file => file.path.endsWith("State/AppStore+Offline.swift"));
    expect(store && "mirrorOnly" in store && store.mirrored.some(line => line.includes("currentServerID"))).toBe(true);
    const devices = objects.find(file => file.path.endsWith("Views/ConnectedDevicesView.swift"));
    expect(devices?.mirrored).toEqual(expect.arrayContaining(["} catch let failure as APIError where failure.code == \"device_revoke_local_only\" {"]));
    // 0.2.5 조건은 0.2.5 부터의 태그에만(앞 판 해석기에는 server.id·canRevokeOthers 를 읽는 원문이 없다).
    for (const tag of ["v0.2.2", "v0.2.3", "v0.2.4"]) {
      expect(releases.find(item => item.tag === tag)?.defines ?? []).not.toContain("COMPAT_SINCE_0_2_5");
    }
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

  test("0.2.5 몫 망가뜨리기는 0.2.5 해석기 조건이 있는 태그에만 건다(0.2.4 는 server.id·canRevokeOthers 를 읽지 않아 어긋남이 아니다)", () => {
    const releases = new Map(loadReleases().map(release => [release.tag, release]));
    const names = (tag: string) => mutationsFor(releases.get(tag)!).map(mutation => mutation.name);
    const since025 = MUTATIONS.filter(mutation => mutation.since === "COMPAT_SINCE_0_2_5");
    expect(since025.map(mutation => mutation.file)).toEqual(expect.arrayContaining(
      ["sync-project.json", "bootstrap.json", "sync-project-full.json", "sync-none.json", "devices-remote.json", "devices.json", "devices-revoke-refused.json"]));
    expect(since025.every(mutation => mutation.appHeaders)).toBe(true);
    expect(names("v0.2.3").length).toBe(7);
    expect(names("v0.2.4")).toEqual(MUTATIONS.filter(mutation => !mutation.since).map(mutation => mutation.name));
    expect(names("v0.2.5")).toEqual(MUTATIONS.filter(mutation => !mutation.since || mutation.since === "COMPAT_SINCE_0_2_5").map(mutation => mutation.name));
    // 영어 화면의 한국어 거절 문장은 대표 문장이 아니어야 0.2.5 에서도 잡힌다(대표 문장이면 0.2.5 는 영어로 바꿔 보인다).
    const body = { error: "Other devices can be disconnected on the Mac that runs the server" };
    MUTATIONS.find(mutation => mutation.name === "영어 화면에 한국어 거절 문장")!.mutate(body);
    expect(body.error).not.toBe("다른 기기는 서버가 도는 Mac에서 끊을 수 있습니다");
    expect(body.error).toMatch(/\p{Script=Hangul}/u);
  });
});

describe("0.2.6: 답 상태와 서버 글 코드", () => {
  const releases = new Map(loadReleases().map(release => [release.tag, release]));
  const v026 = releases.get("v0.2.6")!;
  const objects = v026.files.filter((file): file is Exclude<ReleaseFile, string> => typeof file !== "string");

  test("v0.2.6 은 앞 판의 조건을 함께 켜고, 서버 글을 그리는 원문(ServerText·코드 표·날짜 읽기)과 답 상태 형을 함께 둔다", () => {
    expect(v026.appHeaders).toEqual({ version: "0.2.6", platform: "ios", apiLevel: 1 });
    expect(v026.defines).toEqual(["COMPAT_SINCE_0_2_4", "COMPAT_SINCE_0_2_5", "COMPAT_SINCE_0_2_6"]);
    const paths = v026.files.map(file => typeof file === "string" ? file : file.path);
    expect(paths).toEqual(expect.arrayContaining(["native/Sources/IAMCEO/Services/ServerText.swift", "native/Sources/IAMCEO/Models/ServerTextCatalog.swift"]));
    expect(objects.find(file => file.path.endsWith("Design/Components.swift") && "from" in file && file.from.startsWith("/// 날짜 문자열 파싱"))).toBeDefined();
    const reply = objects.find(file => file.path.endsWith("Design/ReplyPresentation.swift"));
    expect(reply && "from" in reply && reply.from).toBe("/// 대표 글 하나의 답 상태.");
    // 0.2.6 조건은 0.2.6 부터의 태그에만(앞 판 해석기에는 reply·textCode 를 읽는 원문이 없다).
    for (const tag of ["v0.2.2", "v0.2.3", "v0.2.4", "v0.2.5"]) expect(releases.get(tag)?.defines ?? []).not.toContain("COMPAT_SINCE_0_2_6");
  });

  test("서버가 보내는 답 상태는 모두 0.2.6 이 그리는 상태다(모르는 state 는 0.2.6 대화에서 그 줄이 사라진다)", () => {
    // releases.json 의 mirrored(태그 원문과 run.ts 가 견준다)에서 0.2.6 ChatReplyBoard 의 두 묶음을 읽는다.
    const reply = objects.find(file => file.path.endsWith("Design/ReplyPresentation.swift"));
    const mirrored = reply && "mirrored" in reply ? reply.mirrored ?? [] : [];
    const set = (name: string) => {
      const line = mirrored.find(item => item.startsWith(`static let ${name}: Set<String> = [`));
      return [...(line ?? "").matchAll(/"([a-z_]+)"/g)].map(match => match[1]!);
    };
    const known = [...set("open"), ...set("settled")];
    expect(set("open").length).toBeGreaterThan(0);
    expect(set("settled").length).toBeGreaterThan(0);
    expect(REPLY_STATES.filter(state => !known.includes(state))).toEqual([]);
  });

  test("0.2.6 몫 망가뜨리기는 0.2.6 해석기 조건이 있는 태그에만 건다", () => {
    const since026 = MUTATIONS.filter(mutation => mutation.since === "COMPAT_SINCE_0_2_6");
    expect(since026.length).toBeGreaterThanOrEqual(10);
    expect(since026.every(mutation => mutation.appHeaders)).toBe(true);
    // 답 상태·글 코드·카드·활동 줄·오류 줄을 모두 건드린다.
    expect(since026.map(mutation => mutation.file)).toEqual(expect.arrayContaining(
      ["messages-page-project.json", "sync-project.json", "state.json", "ws-message.json", "messages-page-member.json", "activity.json",
        "decision-tool-permission.json", "decision-reopened-files.json", "sync-project-full.json"]));
    const names = (tag: string) => mutationsFor(releases.get(tag)!).map(mutation => mutation.name);
    for (const tag of ["v0.2.2", "v0.2.3", "v0.2.4", "v0.2.5"]) expect(names(tag).filter(name => since026.some(mutation => mutation.name === name))).toEqual([]);
    expect(names("v0.2.6")).toEqual(MUTATIONS.map(mutation => mutation.name));
    // 답 상태를 지우거나 바꾸는 망가뜨리기는 덤프의 실제 모양(대표 글의 reply)에 걸린다.
    const page: Record<string, any> = { items: [{ id: "a", mine: false }, { id: "b", mine: true, reply: { state: "queued", memberId: "m", since: "2026-11-16T00:00:00.000Z" } }] };
    expect(MUTATIONS.find(mutation => mutation.name.startsWith("답 상태의 모양이 어긋남"))!.mutate(page)).toBe(true);
    expect(page.items[1].reply).toEqual({ state: "queued", since: "2026-11-16T00:00:00.000Z" });
  });

  test("allow.json 은 지금 서버가 실제로 쓰는 글 코드만, 판과 이유를 붙여 허용한다(지난 기록이 남아 새 어긋남을 덮지 않게)", () => {
    const allows = JSON.parse(readFileSync(join(import.meta.dir, "../scripts/compat-decoders/allow.json"), "utf8")) as { release?: string; file?: string; contains: string; reason: string }[];
    for (const allow of allows) {
      expect(allow.reason.length).toBeGreaterThan(10);
      expect(releases.has(allow.release ?? "")).toBe(true);
      const code = /^모르는 글 코드: '([^']+)'$/.exec(allow.contains)?.[1];
      if (code) expect(Object.keys(SERVER_TEXTS)).toContain(code);
    }
  });
});
