// D5 호환 게이트: 출시한 앱의 해석 코드로 지금 서버의 실제 응답을 풀어 본다.
//
//   bun scripts/compat-decoders/run.ts <덤프 폴더> <작업 폴더>
//
// 덤프 폴더는 tests/compat-dump.test.ts 가 IAMCEO_COMPAT_OUT 에 남긴 것이다(scripts/check.sh compat 이 둘을 이어 부른다).
// releases.json 의 태그마다 앱 모델 파일을 `git show <태그>:<경로>` 로 꺼내 작업 폴더의 임시 Swift 패키지에 넣고,
// Harness.swift 를 main.swift 로 붙여 빌드한 뒤 실행한다. 옛 소스에는 기록용 호출 두 곳만 끼워 넣는다(값과 동작은 그대로):
//   - SafeStringEnum 의 '?? Self.unknown' → 모르는 열거값을 기록
//   - ContractLog.skipped(0.2.3 부터) → lenient 해석이 건너뛴 칸을 기록
// 새 앱을 출시하면 releases.json 에 그 태그를 더한다. 의도한 변경으로 생긴 기록은 allow.json 에 이유와 함께 적는다.
// 태그가 없으면(얕은 체크아웃) 실패한다: 건너뛰면 게이트가 아무것도 지키지 않으면서 통과하기 때문이다.
//
// 0.2.4 부터의 앱은 모든 요청에 버전 머리글을 싣고, 서버는 그 앱에만 새 칸(Bootstrap.server 등)을 싣는다.
// 그런 태그는 releases.json 에 appHeaders(그 앱이 보내는 값)를 적는다. 덤프 시험은 그 머리글로 받은 응답을
// 덤프 폴더의 app-<태그>/ 에 따로 남기고, 이 스크립트는 그 태그의 해석기에 그 폴더를 먹인다(머리글 없는 응답은 그 앱이 받지 않는다).
// files 의 항목이 객체면 그 파일에서 from 줄부터 to 줄 바로 앞까지만 원문 그대로 꺼낸다(화면 코드와 섞인 파일의 해석부만 쓸 때).
// defines 는 그 태그의 빌드에만 켜는 Swift 조건(Harness.swift 의 #if)이다.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** 출시 태그에서 꺼낼 파일. 글자면 파일 전체. */
export type ReleaseFile = string | {
  path: string;
  /** 이 글자로 시작하는 줄부터(그 줄 포함). 파일에 한 줄만 있어야 한다. */
  from: string;
  /** 이 글자로 시작하는 줄 바로 앞까지. from 뒤에 한 줄만 있어야 한다. */
  to: string;
  /** 꺼낸 조각 위에 붙일 import(원본 파일의 import 에는 앱 안에서만 있는 모듈이 섞일 수 있다). */
  imports: string[];
  /** Harness.swift 가 이 파일에서 옮겨 쓴 원문 조각. 태그의 파일에 그대로 있어야 한다(옮긴 뜻이 원문과 같다는 표시). */
  mirrored?: string[];
};
/** 그 출시 앱이 모든 요청에 싣는 버전 머리글의 값(태그의 AppVersion.swift 와 같아야 한다). */
export interface AppHeaders { version: string; platform: "ios" | "macos"; apiLevel: number }
export interface Release { tag: string; files: ReleaseFile[]; defines?: string[]; appHeaders?: AppHeaders }

const root = resolve(import.meta.dir, "../..");
const here = import.meta.dir;

export function loadReleases(): Release[] {
  return (JSON.parse(readFileSync(join(here, "releases.json"), "utf8")) as { releases: Release[] }).releases;
}
/** 버전 머리글을 보내는 태그의 응답을 따로 담는 덤프 하위 폴더. tests/compat-dump.test.ts 가 같은 이름으로 쓴다. */
export function appHeadersDumpDir(tag: string): string {
  return `app-${tag.replace(/[^0-9A-Za-z._-]/g, "_")}`;
}
const ENUM_FALLBACK = "?? Self.unknown";
const ENUM_PROBE = "?? CompatProbe.fallback(Self.self, decoder)";
const SKIPPED_SIGNATURE = /static func skipped\(_ type: Any\.Type, _ error: any Error, fallback: \[any CodingKey\]\) \{/;

function git(args: string[]): { ok: boolean; out: string; err: string } {
  const run = Bun.spawnSync(["git", ...args], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { ok: run.exitCode === 0, out: run.stdout.toString(), err: run.stderr.toString().trim() };
}

/** 옛 소스에 기록 호출을 끼워 넣는다. 끼울 자리를 못 찾으면 이유를 돌려준다(그 태그는 실패로 친다). */
export function attachProbes(sources: Map<string, string>): string | null {
  let enumHits = 0;
  for (const [name, text] of sources) {
    const count = text.split(ENUM_FALLBACK).length - 1;
    if (count) { enumHits += count; sources.set(name, text.replaceAll(ENUM_FALLBACK, ENUM_PROBE)); }
  }
  if (enumHits !== 1) return `열거값 기록 자리('${ENUM_FALLBACK}')를 ${enumHits}곳 찾았습니다(1곳이어야 합니다). Harness.swift 의 CompatProbe 를 이 태그에 맞추세요.`;
  const usesSkipped = [...sources.values()].some(text => text.includes("ContractLog.skipped("));
  let skippedHits = 0;
  for (const [name, text] of sources) {
    if (!SKIPPED_SIGNATURE.test(text)) continue;
    skippedHits++;
    sources.set(name, text.replace(SKIPPED_SIGNATURE, match => `${match}\n        CompatProbe.skipped(type, error, fallback)`));
  }
  if (usesSkipped && skippedHits !== 1) return `건너뛴 칸 기록 자리(ContractLog.skipped 정의)를 ${skippedHits}곳 찾았습니다(1곳이어야 합니다).`;
  return null;
}

function packageSwift(defines: string[]): string {
  const settings = defines.length ? `, swiftSettings: [${defines.map(name => `.define("${name}")`).join(", ")}]` : "";
  return `// swift-tools-version: 6.0
// D5 호환 게이트가 만든 임시 패키지. 출시 태그의 앱 모델과 Harness.swift 만 들어 있다.
import PackageDescription
let package = Package(
    name: "CompatCheck",
    platforms: [.macOS(.v14)],
    targets: [.executableTarget(name: "CompatCheck", path: "Sources/CompatCheck"${settings})],
    swiftLanguageModes: [.v6]
)
`;
}

/** 태그의 파일 하나를 꺼낸다. 조각이면 from 줄부터 to 줄 앞까지를 원문 그대로 두고 위에 출처와 import 만 붙인다. 실패하면 이유. */
export function releaseSource(tag: string, file: ReleaseFile, show: (path: string) => { ok: boolean; out: string; err: string }):
  { name: string; text: string } | { error: string } {
  const path = typeof file === "string" ? file : file.path;
  const shown = show(path);
  if (!shown.ok) return { error: `${path} 를 꺼내지 못했습니다: ${shown.err}` };
  const name = basename(path);
  if (typeof file === "string") return { name, text: shown.out };
  for (const piece of file.mirrored ?? []) {
    if (!shown.out.includes(piece)) return { error: `${path} 에 Harness.swift 가 옮겨 쓴 원문이 없습니다: ${piece}` };
  }
  const lines = shown.out.split("\n");
  const starts = (marker: string) => lines.flatMap((line, index) => line.startsWith(marker) ? [index] : []);
  const from = starts(file.from), to = starts(file.to);
  if (from.length !== 1 || to.length !== 1 || to[0]! <= from[0]!) {
    return { error: `${path} 에서 잘라낼 자리('${file.from}' ${from.length}곳, '${file.to}' ${to.length}곳)가 한 곳씩, 차례대로 있어야 합니다` };
  }
  const header = `// ${tag}:${path} 의 ${from[0]! + 1}~${to[0]}줄(원문 그대로). 호환 게이트가 화면 코드를 빼고 해석부만 꺼냈다.`;
  return { name, text: [header, ...file.imports.map(module => `import ${module}`), "", ...lines.slice(from[0], to[0])].join("\n") };
}

/**
 * appHeaders 가 그 태그의 앱이 실제로 보내는 값인지 본다(덤프가 다른 머리글로 받았으면 게이트가 엉뚱한 응답을 읽는다).
 * sent 는 덤프가 실제로 보낸 머리글(manifest 의 appHeaders.sent). 맞으면 null, 아니면 이유.
 */
export function checkAppHeaders(tag: string, headers: AppHeaders, sent: Record<string, string> | undefined, sources: Map<string, string>): string | null {
  const appVersion = sources.get("AppVersion.swift");
  if (!appVersion) return "appHeaders 를 쓰는 태그는 files 에 AppVersion.swift 가 있어야 합니다(보내는 머리글을 그 원문과 견준다)";
  if (`v${headers.version}` !== tag) return `appHeaders.version(${headers.version})이 태그(${tag})와 다릅니다`;
  const level = /static let apiLevel = (\d+)/.exec(appVersion)?.[1];
  if (Number(level) !== headers.apiLevel) return `appHeaders.apiLevel(${headers.apiLevel})이 그 태그 앱의 apiLevel(${level ?? "없음"})과 다릅니다`;
  // 그 태그의 앱이 싣는 머리글 이름(static let versionHeader = "…" 등). 빌드 번호 값은 서버가 기록에만 쓴다.
  const names = Object.fromEntries([...appVersion.matchAll(/static let (\w+)Header = "([^"]+)"/g)].map(match => [match[1]!, match[2]!]));
  const expected: Record<string, string | null> = { version: headers.version, platform: headers.platform, apiLevel: String(headers.apiLevel), build: null };
  if (Object.keys(names).sort().join() !== Object.keys(expected).sort().join()) return `그 태그 앱의 머리글(${Object.keys(names).join(", ")})이 게이트가 아는 넷(version, build, platform, apiLevel)과 다릅니다`;
  if (!sent) return "덤프에 보낸 머리글 기록(appHeaders.sent)이 없습니다";
  if (Object.keys(sent).sort().join() !== Object.values(names).sort().join()) return `덤프가 보낸 머리글(${Object.keys(sent).join(", ")})이 그 태그의 앱이 싣는 것(${Object.values(names).join(", ")})과 다릅니다`;
  for (const [key, value] of Object.entries(expected)) {
    if (value !== null && sent[names[key]!] !== value) return `덤프가 보낸 ${names[key]}: ${sent[names[key]!]} 가 그 앱의 값 ${value} 와 다릅니다`;
  }
  return null;
}

function swift(args: string[]): { ok: boolean; out: string } {
  const run = Bun.spawnSync(["swift", ...args], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env });
  return { ok: run.exitCode === 0, out: `${run.stdout.toString()}${run.stderr.toString()}` };
}

function checkRelease(release: Release, dump: string, work: string): boolean {
  const label = `[${release.tag}]`;
  if (!git(["rev-parse", "-q", "--verify", `refs/tags/${release.tag}^{commit}`]).ok) {
    console.log(`실패 ${label} 태그가 이 저장소에 없습니다. 'git fetch --tags' 로 받은 뒤 다시 돌리세요(CI 는 checkout 에 fetch-depth: 0).`);
    return false;
  }
  const packageDir = join(work, release.tag.replace(/[^0-9A-Za-z._-]/g, "_"));
  const sourceDir = join(packageDir, "Sources", "CompatCheck");
  mkdirSync(sourceDir, { recursive: true });
  const sources = new Map<string, string>();
  for (const file of release.files) {
    const source = releaseSource(release.tag, file, path => git(["show", `${release.tag}:${path}`]));
    if ("error" in source) { console.log(`실패 ${label} ${source.error}`); return false; }
    if (source.name === "main.swift" || sources.has(source.name)) { console.log(`실패 ${label} 파일 이름이 겹칩니다: ${source.name}`); return false; }
    sources.set(source.name, source.text);
  }
  // 버전 머리글을 보내는 앱은 그 머리글로 받은 응답(app-<태그>/)만 읽는다. 머리글 없는 응답은 그 앱에 오지 않는다.
  if (release.appHeaders) {
    dump = join(dump, appHeadersDumpDir(release.tag));
    const manifest = existsSync(join(dump, "manifest.json"))
      ? JSON.parse(readFileSync(join(dump, "manifest.json"), "utf8")) as { appHeaders?: { sent?: Record<string, string> } } : null;
    if (!manifest) { console.log(`실패 ${label} 버전 머리글로 받은 덤프가 없습니다: ${dump}. tests/compat-dump.test.ts 가 releases.json 의 appHeaders 를 읽어 만든다.`); return false; }
    const mismatch = checkAppHeaders(release.tag, release.appHeaders, manifest.appHeaders?.sent, sources);
    if (mismatch) { console.log(`실패 ${label} ${mismatch}`); return false; }
  }
  const problem = attachProbes(sources);
  if (problem) { console.log(`실패 ${label} ${problem}`); return false; }
  for (const [name, text] of sources) writeFileSync(join(sourceDir, name), text);
  copyFileSync(join(here, "Harness.swift"), join(sourceDir, "main.swift"));
  writeFileSync(join(packageDir, "Package.swift"), packageSwift(release.defines ?? []));
  const common = ["--package-path", packageDir, "--scratch-path", join(packageDir, ".build"), "--cache-path", join(work, "swift-cache"),
    "--config-path", join(work, "swift-config"), "--security-path", join(work, "swift-security")];
  console.log(`${label} 옛 해석기 빌드 중(${release.files.length}개 파일)`);
  const built = swift(["build", ...common]);
  if (!built.ok) {
    console.log(built.out.split("\n").filter(line => /error:/.test(line)).slice(0, 20).join("\n") || built.out.slice(-4000));
    console.log(`실패 ${label} 옛 해석기를 빌드하지 못했습니다. Harness.swift 가 이 태그의 형 이름과 맞는지 보세요.`);
    return false;
  }
  const binPath = swift(["build", ...common, "--show-bin-path"]);
  const binary = join(binPath.out.trim().split("\n").at(-1) ?? "", "CompatCheck");
  if (!binPath.ok || !existsSync(binary)) { console.log(`실패 ${label} 빌드한 실행 파일을 찾지 못했습니다`); return false; }
  const run = Bun.spawnSync([binary, dump, join(here, "allow.json"), release.tag], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  process.stdout.write(run.stdout.toString());
  if (run.stderr.length) process.stderr.write(run.stderr.toString());
  const teeth = checkTeeth(binary, dump, join(packageDir, "teeth"), release);
  return run.exitCode === 0 && teeth;
}

/**
 * 게이트가 실제로 어긋남을 잡는지 매번 확인한다. 진짜 덤프를 한 군데씩 망가뜨린 사본을 같은 해석기에 먹여
 * 모두 실패해야 한다. 하나라도 통과하면 게이트가 빈 껍데기라는 뜻이라 게이트 전체를 실패로 친다.
 */
type Json = Record<string, any>;
/** appHeaders: 버전 머리글을 보내는 태그(app-<태그>/ 덤프)에만 건다. 그 덤프에만 있는 칸·파일을 망가뜨린다. */
export const MUTATIONS: { name: string; file: string; appHeaders?: true; mutate: (body: Json) => boolean }[] = [
  { name: "필드의 형이 바뀜(bootstrap.cli 가 배열)", file: "bootstrap.json",
    mutate: body => typeof body.cli === "string" && (body.cli = ["iamceo"], true) },
  { name: "계약 버전이 바뀜(contractVersion 3)", file: "capabilities.json",
    mutate: body => body.contractVersion === 2 && (body.contractVersion = 3, true) },
  { name: "실시간 hello 의 고정 간격이 바뀜", file: "ws-hello.json",
    mutate: body => body.heartbeatMs === 15000 && (body.heartbeatMs = 20000, true) },
  { name: "전달 안내 version 이 바뀜", file: "sync-project.json",
    mutate: body => body.state?.deliveryNotices?.version === 2 && (body.state.deliveryNotices.version = 3, true) },
  { name: "옛 앱이 모르는 열거값(압축 단계)", file: "sync-project.json",
    mutate: body => { const c = body.state?.members?.find((m: Json) => m.contextState?.compaction)?.contextState.compaction; return !!c && (c.phase = "paused", true); } },
  { name: "부가 정보의 형이 바뀜(관측 실패 횟수가 글자)", file: "sync-project.json",
    mutate: body => { const o = body.state?.members?.find((m: Json) => m.statusObservation)?.statusObservation; return !!o && (o.consecutiveFailures = "two", true); } },
  { name: "필수 칸이 빠짐(프로젝트 목록)", file: "sync-none.json",
    mutate: body => Array.isArray(body.bootstrap?.projects) && (delete body.bootstrap.projects, true) },
  { name: "서버 칸의 형이 바뀜(bootstrap.server.apiLevel 이 글자)", file: "bootstrap.json", appHeaders: true,
    mutate: body => typeof body.server?.apiLevel === "number" && (body.server.apiLevel = String(body.server.apiLevel), true) },
  { name: "버전 머리글을 보낸 앱에 서버 칸이 빠짐(동기화)", file: "sync-project.json", appHeaders: true,
    mutate: body => !!body.bootstrap?.server && (delete body.bootstrap.server, true) },
  { name: "필수 칸이 빠짐(연결된 기기 목록)", file: "devices-remote.json", appHeaders: true,
    mutate: body => Array.isArray(body.devices) && (delete body.devices, true) },
  { name: "영어 화면에 한국어 거절 문장", file: "devices-revoke-refused-en.json", appHeaders: true,
    mutate: body => typeof body.error === "string" && (body.error = "다른 기기는 서버가 도는 Mac에서 끊을 수 있습니다", true) },
  { name: "거절을 device_not_found 로 답함(옛 앱이 줄을 조용히 지운다)", file: "devices-revoke-refused.json", appHeaders: true,
    mutate: body => typeof body.code === "string" && (body.code = "device_not_found", true) },
];

function checkTeeth(binary: string, dump: string, folder: string, release: Release): boolean {
  const tag = release.tag;
  const mutations = MUTATIONS.filter(mutation => !mutation.appHeaders || release.appHeaders);
  const manifest = JSON.parse(readFileSync(join(dump, "manifest.json"), "utf8")) as { entries: { file: string; type: string; checks: string[]; note: string }[] };
  let ok = true;
  for (const [index, mutation] of mutations.entries()) {
    const entry = manifest.entries.find(item => item.file === mutation.file);
    const body = entry ? JSON.parse(readFileSync(join(dump, entry.file), "utf8")) as Json : null;
    if (!entry || !body || !mutation.mutate(body)) {
      console.log(`실패 [${tag}] 게이트 자체 검사 '${mutation.name}': 덤프에 망가뜨릴 자리가 없습니다(${mutation.file}). MUTATIONS 를 덤프에 맞추세요.`);
      ok = false; continue;
    }
    const dir = join(folder, String(index));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, entry.file), JSON.stringify(body));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ entries: [entry] }));
    const run = Bun.spawnSync([binary, dir, join(here, "allow.json"), tag], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    if (run.exitCode !== 1) {
      console.log(`실패 [${tag}] 게이트 자체 검사 '${mutation.name}': 망가뜨린 응답을 잡지 못했습니다(종료 코드 ${run.exitCode}).\n${run.stdout.toString()}`);
      ok = false;
    }
  }
  if (ok) console.log(`[${tag}] 게이트 자체 검사 ${mutations.length}건: 망가뜨린 응답을 모두 잡았습니다`);
  return ok;
}

function main(argv: string[]): number {
  if (argv.length !== 2) { console.log("쓰는 법: bun scripts/compat-decoders/run.ts <덤프 폴더> <작업 폴더>"); return 2; }
  const [dump, work] = argv.map(path => resolve(path!)) as [string, string];
  if (!existsSync(join(dump, "manifest.json"))) {
    console.log(`덤프가 없습니다: ${dump}. 먼저 IAMCEO_COMPAT_OUT=${dump} bun test tests/compat-dump.test.ts 를 돌리세요.`);
    return 2;
  }
  const releases = loadReleases();
  if (!releases.length) { console.log("releases.json 에 출시 태그가 없습니다"); return 2; }
  mkdirSync(work, { recursive: true });
  const failed = releases.filter(release => !checkRelease(release, dump, work)).map(release => release.tag);
  console.log(failed.length
    ? `호환 게이트 실패: ${failed.join(", ")} 앱이 지금 서버의 응답을 그대로 읽지 못합니다.`
    : `호환 게이트 통과: ${releases.map(release => release.tag).join(", ")} 앱이 지금 서버의 응답을 모두 읽습니다.`);
  return failed.length ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
