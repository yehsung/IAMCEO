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
// 그 폴더의 manifest 에는 서버의 실제 신원(serverIdentity: 알림 저장소의 서버 ID 와 데이터 폴더)도 남는다. 0.2.5 부터의 해석기는
// 응답의 server.id·home 이 그 신원과 같은 서버로 읽히는지 본다(대기열의 글을 쓴 서버에 묶는다).
// files 의 항목이 객체면 그 파일에서 from 줄부터 to 줄 바로 앞까지만 원문 그대로 꺼낸다(화면 코드와 섞인 파일의 해석부만 쓸 때).
// mirrorOnly 항목은 빌드하지 않고, Harness.swift 가 옮겨 쓴 줄이 그 태그의 파일에 그대로 있는지만 본다(AppStore 의 확장처럼
// 따로 빌드할 수 없는 파일에서 해석 뒤의 판정 몇 줄을 옮겨 쓸 때).
// defines 는 그 태그의 빌드에만 켜는 Swift 조건(Harness.swift 의 #if)이다. 뒤 판은 앞 판의 조건을 함께 켠다(0.2.5 = 0.2.4 + 0.2.5).
// 0.2.6 부터의 해석기는 모든 응답에서 답 상태·서버 글 코드·오류 줄 코드를 본다. 그 앱이 모르는 새 글 코드는 받은 문장 그대로 보이므로
// 실패가 아니라 기록으로 남고, allow.json 에 그 판과 이유를 적어야 통과한다(새 서버가 코드를 더할 때마다 그 앱에서 어떻게 보이는지 정한다).
// iPhone 과 Mac 이 같은 태그로 나가면 해석 코드가 같다(플랫폼 조건은 AppVersion.platform 한 줄). 그래서 태그마다 한 항목이고,
// appHeaders.platform 은 그 판에서 서버가 다른 기기로 보는 쪽(QR 로 붙은 iPhone)을 적는다. 서버가 도는 Mac 의 앱이 받는 응답은
// tests/compat-dump.test.ts 가 macos 머리글로 따로 받는다(연결된 기기).
//
// 본 덤프와 따로, samples/<이름>/ 의 응답 견본도 태그마다 그 해석기에 먹인다(sampleFolders). 덤프를 만드는 서버 상태에 아직 없는 모양을
// 실제 응답에 손으로 넣어 둔 것이다(samples/gemini: cli 가 gemini 인 팀장, geminiRanks, 모델 목록의 gemini 등). 견본의 manifest.json 은
// 덤프와 같은 entries 에, 게이트 자체 검사용 teeth(그 파일에서 그 칸을 지운 사본은 실패해야 한다)를 둔다.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** 태그 파일에서 해석부만 꺼내는 조각. */
export interface SliceFile {
  path: string;
  /** 이 글자로 시작하는 줄부터(그 줄 포함). 파일에 한 줄만 있어야 한다. */
  from: string;
  /** 이 글자로 시작하는 줄 바로 앞까지. from 뒤에 한 줄만 있어야 한다. */
  to: string;
  /** 꺼낸 조각 위에 붙일 import(원본 파일의 import 에는 앱 안에서만 있는 모듈이 섞일 수 있다). */
  imports: string[];
  /** Harness.swift 가 이 파일에서 옮겨 쓴 원문 조각. 태그의 파일에 그대로 있어야 한다(옮긴 뜻이 원문과 같다는 표시). */
  mirrored?: string[];
}
/** 빌드하지 않고 Harness.swift 가 옮겨 쓴 원문만 견주는 파일. */
export interface MirrorOnlyFile {
  path: string;
  mirrorOnly: true;
  /** Harness.swift 가 이 파일에서 옮겨 쓴 원문 조각. 하나 이상. */
  mirrored: string[];
}
/** 출시 태그에서 꺼낼 파일. 글자면 파일 전체. */
export type ReleaseFile = string | SliceFile | MirrorOnlyFile;
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

/**
 * 태그의 파일 하나를 꺼낸다. 조각이면 from 줄부터 to 줄 앞까지를 원문 그대로 두고 위에 출처와 import 만 붙인다. 실패하면 이유.
 * mirrorOnly 면 옮겨 쓴 원문만 견주고 빌드할 글은 돌려주지 않는다(text 없음).
 */
export function releaseSource(tag: string, file: ReleaseFile, show: (path: string) => { ok: boolean; out: string; err: string }):
  { name: string; text: string } | { name: string; mirrorOnly: true } | { error: string } {
  const path = typeof file === "string" ? file : file.path;
  const shown = show(path);
  if (!shown.ok) return { error: `${path} 를 꺼내지 못했습니다: ${shown.err}` };
  const name = basename(path);
  if (typeof file === "string") return { name, text: shown.out };
  for (const piece of file.mirrored ?? []) {
    if (!shown.out.includes(piece)) return { error: `${path} 에 Harness.swift 가 옮겨 쓴 원문이 없습니다: ${piece}` };
  }
  if ("mirrorOnly" in file) {
    // 견줄 줄이 없으면 이 항목은 아무것도 지키지 않는다.
    if (!file.mirrored?.length) return { error: `${path}: mirrorOnly 항목에 mirrored 가 없습니다` };
    return { name, mirrorOnly: true };
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
    if (!("text" in source)) continue; // 원문만 견준 파일(mirrorOnly)은 빌드에 넣지 않는다.
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
  console.log(`${label} 옛 해석기 빌드 중(${sources.size}개 파일)`);
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
  const samples = checkSamples(binary, join(packageDir, "sample-teeth"), release.tag);
  return run.exitCode === 0 && teeth && samples;
}

/** 견본 폴더의 자체 검사 하나: file 의 delete 경로(객체 열쇠나 배열 번호)에 있는 칸을 지운 사본은 해석기가 실패로 알려야 한다. */
export interface SampleTooth { name: string; file: string; delete: (string | number)[] }
/** 본 덤프와 따로 먹이는 응답 견본 폴더들(manifest.json 이 있는 samples/<이름>/). 이름 순. */
export function sampleFolders(base = join(here, "samples")): string[] {
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(base, entry.name, "manifest.json")))
    .map(entry => join(base, entry.name)).sort();
}
/** 경로 끝의 칸을 지운다. 그 칸이 없으면 false(견본과 teeth 가 어긋났다). */
export function deleteAt(body: unknown, path: (string | number)[]): boolean {
  if (!path.length) return false;
  let node = body as any;
  for (const key of path.slice(0, -1)) {
    if (node === null || typeof node !== "object" || !(key in node)) return false;
    node = node[key];
  }
  const last = path.at(-1)!;
  if (node === null || typeof node !== "object" || !(last in node)) return false;
  if (Array.isArray(node) && typeof last === "number") node.splice(last, 1); else delete node[last];
  return true;
}

/** 견본 폴더마다: 그대로는 통과해야 하고, teeth 로 망가뜨린 사본은 실패해야 한다. */
function checkSamples(binary: string, work: string, tag: string): boolean {
  let ok = true;
  for (const folder of sampleFolders()) {
    const name = basename(folder);
    const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")) as { entries: { file: string }[]; teeth?: SampleTooth[] };
    const run = Bun.spawnSync([binary, folder, join(here, "allow.json"), tag], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    process.stdout.write(run.stdout.toString().replaceAll(`[${tag}]`, `[${tag}] 견본 ${name}:`));
    if (run.stderr.length) process.stderr.write(run.stderr.toString());
    if (run.exitCode !== 0) { console.log(`실패 [${tag}] 견본 ${name}: 이 앱이 견본 응답을 그대로 읽지 못합니다(종료 코드 ${run.exitCode})`); ok = false; }
    const teeth = manifest.teeth ?? [];
    if (!teeth.length) { console.log(`실패 [${tag}] 견본 ${name}: manifest.json 에 teeth 가 없습니다(견본이 실제로 해석되는지 확인할 수 없다)`); ok = false; continue; }
    let caught = 0;
    for (const [index, tooth] of teeth.entries()) {
      const entry = manifest.entries.find(item => item.file === tooth.file);
      const body = entry ? JSON.parse(readFileSync(join(folder, tooth.file), "utf8")) as unknown : null;
      if (!entry || body === null || !deleteAt(body, tooth.delete)) {
        console.log(`실패 [${tag}] 견본 ${name} 자체 검사 '${tooth.name}': 견본에 지울 자리가 없습니다(${tooth.file} ${tooth.delete.join(".")})`);
        ok = false; continue;
      }
      const dir = join(work, name, String(index));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, tooth.file), JSON.stringify(body));
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ entries: [entry] }));
      const broken = Bun.spawnSync([binary, dir, join(here, "allow.json"), tag], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      if (broken.exitCode !== 1) {
        console.log(`실패 [${tag}] 견본 ${name} 자체 검사 '${tooth.name}': 망가뜨린 견본을 잡지 못했습니다(종료 코드 ${broken.exitCode}).\n${broken.stdout.toString()}`);
        ok = false; continue;
      }
      caught++;
    }
    if (caught === teeth.length) console.log(`[${tag}] 견본 ${name} 자체 검사 ${teeth.length}건: 망가뜨린 견본을 모두 잡았습니다`);
  }
  return ok;
}

/**
 * 게이트가 실제로 어긋남을 잡는지 매번 확인한다. 진짜 덤프를 한 군데씩 망가뜨린 사본을 같은 해석기에 먹여
 * 모두 실패해야 한다. 하나라도 통과하면 게이트가 빈 껍데기라는 뜻이라 게이트 전체를 실패로 친다.
 */
type Json = Record<string, any>;
/**
 * appHeaders: 버전 머리글을 보내는 태그(app-<태그>/ 덤프)에만 건다. 그 덤프에만 있는 칸·파일을 망가뜨린다.
 * since: 그 해석기 조건(defines)을 켠 태그에만 건다. 앞 판이 읽지 않는 칸이라 앞 판에서는 어긋남이 아니다(0.2.4 는 server.id 를 모른다).
 */
export interface Mutation { name: string; file: string; appHeaders?: true; since?: string; mutate: (body: Json) => boolean }
const NOT_THIS_SERVER = "00000000-0000-4000-8000-000000000000";
const SINCE_0_2_6 = "COMPAT_SINCE_0_2_6";
/** 응답 안의 대화 글(형마다 자리가 다르다: 목록·페이지·동기화·상태·실시간 사건). */
function messagesIn(body: Json): Json[] {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.items)) return body.items;
  if (Array.isArray(body.state?.messages)) return body.state.messages;
  if (Array.isArray(body.messages)) return body.messages;
  return body.message ? [body.message] : [];
}
const withReply = (body: Json) => messagesIn(body).find(message => message.reply && typeof message.reply === "object");
const withCode = (body: Json, code: string) => messagesIn(body).find(message => message.textCode === code);
export const MUTATIONS: Mutation[] = [
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
  // 기기 이름이 끼어 대표 문장과 다른 한국어 문장. 대표 문장 그대로면 0.2.5 는 코드의 영어 문장으로 바꿔 보인다(ServerErrorDisplay).
  { name: "영어 화면에 한국어 거절 문장", file: "devices-revoke-refused-en.json", appHeaders: true,
    mutate: body => typeof body.error === "string" && (body.error = "‘회사 iPad’ 연결은 서버가 도는 Mac에서 끊을 수 있습니다", true) },
  { name: "거절을 device_not_found 로 답함(옛 앱이 줄을 조용히 지운다)", file: "devices-revoke-refused.json", appHeaders: true,
    mutate: body => typeof body.code === "string" && (body.code = "device_not_found", true) },
  // 0.2.5: 대기열을 서버 신원(server.id + home)에 묶고, 연결된 기기의 끊기 단추를 canRevokeOthers 로 가르고, 거절 코드로 까닭을 안다.
  { name: "서버 ID 가 빠짐(0.2.5 가 보낼 글을 주소로만 가린다)", file: "sync-project.json", appHeaders: true, since: "COMPAT_SINCE_0_2_5",
    mutate: body => typeof body.bootstrap?.server?.id === "string" && (delete body.bootstrap.server.id, true) },
  { name: "서버 ID 의 모양이 어긋남(0.2.5 가 없는 것으로 읽는다)", file: "bootstrap.json", appHeaders: true, since: "COMPAT_SINCE_0_2_5",
    mutate: body => typeof body.server?.id === "string" && (body.server.id = "server 1", true) },
  { name: "응답의 서버 ID 가 서버의 실제 ID 와 다름(0.2.5 가 이 서버에 쓴 글을 다른 서버 몫으로 둔다)", file: "sync-project-full.json", appHeaders: true, since: "COMPAT_SINCE_0_2_5",
    mutate: body => typeof body.bootstrap?.server?.id === "string" && (body.bootstrap.server.id = NOT_THIS_SERVER, true) },
  { name: "데이터 폴더가 서버의 실제 폴더와 다름(0.2.5 가 다른 서버로 본다)", file: "sync-none.json", appHeaders: true, since: "COMPAT_SINCE_0_2_5",
    mutate: body => typeof body.bootstrap?.home === "string" && (body.bootstrap.home = "/Users/other/.iamceo", true) },
  { name: "다른 기기 끊기 여부가 빠짐(iPhone 이 남의 줄에도 끊기 단추를 둔다)", file: "devices-remote.json", appHeaders: true, since: "COMPAT_SINCE_0_2_5",
    mutate: body => typeof body.canRevokeOthers === "boolean" && (delete body.canRevokeOthers, true) },
  { name: "서버가 도는 Mac 에 다른 기기를 못 끊는다고 답함", file: "devices.json", appHeaders: true, since: "COMPAT_SINCE_0_2_5",
    mutate: body => body.canRevokeOthers === true && (body.canRevokeOthers = false, true) },
  { name: "거절 코드가 바뀜(0.2.5 가 까닭을 알아보지 못해 목록을 다시 읽지 않는다)", file: "devices-revoke-refused.json", appHeaders: true, since: "COMPAT_SINCE_0_2_5",
    mutate: body => body.code === "device_revoke_local_only" && (body.code = "forbidden", true) },
  // 0.2.6: 대표 글의 답 상태(reply), 서버가 만든 글의 코드(textCode·textParams·textLang·optionTexts·reopenNoteText), 팀장 오류 줄 코드(lastErrorCode).
  { name: "답 상태의 모양이 어긋남(memberId 빠짐: 0.2.6 이 답 상태를 기록 없이 버린다)", file: "messages-page-project.json", appHeaders: true, since: SINCE_0_2_6,
    mutate: body => { const message = withReply(body); return !!message && (delete message.reply.memberId, true); } },
  { name: "0.2.6 이 모르는 답 상태(그 팀장의 답 상태 줄을 그리지 않는다)", file: "sync-project.json", appHeaders: true, since: SINCE_0_2_6,
    mutate: body => { const message = withReply(body); return !!message && (message.reply.state = "thinking", true); } },
  { name: "답 상태의 since 가 시각이 아님", file: "state.json", appHeaders: true, since: SINCE_0_2_6,
    mutate: body => { const message = withReply(body); return typeof message?.reply.since === "string" && (message.reply.since = "어제", true); } },
  { name: "대표 글의 답 상태가 빠짐(0.2.6 대화에서 '답 쓰는 중'이 사라진다)", file: "ws-message.json", appHeaders: true, since: SINCE_0_2_6,
    mutate: body => { const message = withReply(body); return !!message && (delete message.reply, true); } },
  { name: "글 코드의 값이 빠짐(0.2.6 이 영어 화면으로 다시 그리지 못한다)", file: "messages-page-member.json", appHeaders: true, since: SINCE_0_2_6,
    mutate: body => { const message = withCode(body, "chat.owner_message_late"); return typeof message?.textParams?.name === "string" && (delete message.textParams.name, true); } },
  { name: "제목 코드가 없는 글에 제목이 실림(0.2.6 이 모르는 제목 코드)", file: "messages-page-project.json", appHeaders: true, since: SINCE_0_2_6,
    mutate: body => { const message = withCode(body, "chat.run_interrupted"); return message?.title === "" && (message.title = "실행 중단", true); } },
  { name: "활동 줄의 글 코드가 0.2.6 이 모르는 코드로 바뀜", file: "activity.json", appHeaders: true, since: SINCE_0_2_6,
    mutate: body => { const line = (body as unknown as Json[]).find(item => item.textCode === "activity.compact_done"); return !!line && (line.textCode = "activity.compaction_done", true); } },
  { name: "카드의 그린 언어(textLang)가 빠짐(0.2.6 이 다시 그리지 않는다)", file: "decision-tool-permission.json", appHeaders: true, since: SINCE_0_2_6,
    mutate: body => typeof body.textLang === "string" && (delete body.textLang, true) },
  { name: "카드의 글 코드가 빠짐", file: "decision-tool-permission.json", appHeaders: true, since: SINCE_0_2_6,
    mutate: body => typeof body.textCode === "string" && (delete body.textCode, delete body.textParams, true) },
  { name: "선택지 이름 코드의 형이 바뀜(0.2.6 이 선택지 코드를 모두 버린다)", file: "decision-tool-permission.json", appHeaders: true, since: SINCE_0_2_6,
    mutate: body => typeof body.optionTexts?.allow?.label === "object" && (body.optionTexts.allow.label = "허용", true) },
  { name: "다시 연 까닭 코드의 값이 빠짐(아는 코드인데 그리지 못한다)", file: "decision-reopened-files.json", appHeaders: true, since: SINCE_0_2_6,
    mutate: body => !!body.reopenNoteText && (body.reopenNoteText = { code: "card.reopen_by_owner" }, true) },
  { name: "오류 줄 코드가 빠짐", file: "sync-project.json", appHeaders: true, since: SINCE_0_2_6,
    mutate: body => { const coded = (body.state?.members ?? []).filter((member: Json) => member.lastErrorCode); for (const member of coded) delete member.lastErrorCode; return coded.length > 0; } },
  { name: "오류 줄이 코드의 대표 문장과 다름(0.2.6 영어 화면에 한국어 오류 줄)", file: "sync-project-full.json", appHeaders: true, since: SINCE_0_2_6,
    mutate: body => { const member = body.state?.members?.find((item: Json) => item.lastErrorCode); return !!member && (member.lastError = "인터넷이 끊겨 멈췄습니다", true); } },
];

/** 그 태그의 해석기에 거는 망가뜨리기. */
export function mutationsFor(release: Release): Mutation[] {
  return MUTATIONS.filter(mutation => (!mutation.appHeaders || !!release.appHeaders)
    && (!mutation.since || (release.defines ?? []).includes(mutation.since)));
}

function checkTeeth(binary: string, dump: string, folder: string, release: Release): boolean {
  const tag = release.tag;
  const mutations = mutationsFor(release);
  const manifest = JSON.parse(readFileSync(join(dump, "manifest.json"), "utf8")) as Json & { entries: { file: string; type: string; checks: string[]; note: string }[] };
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
    // 목록 밖의 기록(서버 신원 serverIdentity 등)은 그대로 넘긴다. 망가뜨린 응답을 그 기준과 견준다.
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, entries: [entry] }));
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
