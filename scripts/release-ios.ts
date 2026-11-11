/** iPhone release, run by the supervisor on a Mac with Xcode and XcodeGen. Procedure: docs/releasing.md.
 *   bun scripts/release-ios.ts upload [--ref COMMIT] [--build NUMBER] [--dry-run]
 *   bun scripts/release-ios.ts submit --build NUMBER [--version X.Y.Z] [--dry-run]
 *   bun scripts/release-ios.ts screenshots --localization ID --display-type TYPE [--dry-run] FILE.png...
 *   bun scripts/release-ios.ts api METHOD /v1/path [JSON] [--dry-run]
 * Credentials ONLY from the environment: ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID, and APPLE_TEAM_ID for upload.
 * Nothing here prints a credential, and --dry-run neither reads the key file nor opens a network connection.
 * upload builds git archive inputs only, never the working tree.
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const ASC_HOST = "https://api.appstoreconnect.apple.com";
const PROJECT = "IAMCEO.xcodeproj";
const SCHEME = "IAMCEO-iOS";

export const HELP = `iPhone 릴리스 도구 (절차 전체는 docs/releasing.md)

사용법
  bun scripts/release-ios.ts upload [--ref 커밋] [--build 번호] [--dry-run]
      커밋된 소스(git archive)를 아카이브해 App Store Connect(TestFlight)에 올립니다.
      --ref 를 생략하면 HEAD, --build 를 생략하면 지금 시각의 연월일시(예: 2026111017)를 씁니다.
  bun scripts/release-ios.ts submit --build 번호 [--version X.Y.Z] [--dry-run]
      올린 빌드의 처리가 끝나기를 기다렸다가 그 버전에 붙이고 심사에 제출합니다.
      --version 을 생략하면 package.json 의 버전을 씁니다. 버전은 App Store Connect 에 미리 만들어 둬야 합니다.
  bun scripts/release-ios.ts screenshots --localization ID --display-type 종류 [--dry-run] 파일.png...
      스크린샷을 올립니다. 기존 것을 지우지 않고, 묶음이 없으면 만든 뒤 순서대로 덧붙입니다.
  bun scripts/release-ios.ts api METHOD /v1/경로 [JSON] [--dry-run]
      App Store Connect API 를 한 번 부르고 상태 코드와 응답을 그대로 보여 줍니다.

환경 변수 (값은 저장소에 적지 않습니다)
  ASC_KEY_PATH     App Store Connect API 키 파일(.p8)의 경로
  ASC_KEY_ID       그 키의 ID
  ASC_ISSUER_ID    발급자 ID
  APPLE_TEAM_ID    Apple 개발자 팀 ID (upload 에만 필요)

--dry-run 은 실행할 명령과 API 호출 순서만 보여 주고, 키 파일을 읽지도 네트워크에 연결하지도 않습니다.
`;

export type IosCommand = "help" | "upload" | "submit" | "screenshots" | "api";
export interface IosReleaseOptions {
  command: IosCommand; dryRun: boolean; ref: string; build?: string; version?: string;
  localization?: string; displayType?: string; files: string[]; method?: string; path?: string; body?: string;
}

const FLAGS: Record<Exclude<IosCommand, "help">, string[]> = {
  upload: ["--ref", "--build"], submit: ["--build", "--version"], screenshots: ["--localization", "--display-type"], api: [],
};
const checkBuild = (build: string) => { if (!/^[1-9]\d{0,17}$/.test(build)) throw new Error("--build must be a positive whole number (digits only, at most 18)"); return build; };
const checkVersion = (version: string) => { if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("A stable X.Y.Z version is required"); return version; };
const checkAscPath = (path: string) => { if (!/^\/v\d+\/[^\s]*$/.test(path)) throw new Error("The API path must start with /v1/ (or another /vN/)"); return path; };

export function parseIosReleaseOptions(args: string[]): IosReleaseOptions {
  const options: IosReleaseOptions = { command: "help", dryRun: false, ref: "HEAD", files: [] };
  if (args.length === 0 || args.includes("--help") || args.includes("-h") || args[0] === "help") return options;
  const command = args[0] as Exclude<IosCommand, "help">;
  if (!Object.hasOwn(FLAGS, command)) throw new Error(`Unknown command: ${args[0]} (upload, submit, screenshots, api)`);
  options.command = command;
  const positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") { options.dryRun = true; continue; }
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    if (!FLAGS[command].includes(arg)) throw new Error(`Unknown argument for ${command}: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith("-")) throw new Error(`${arg} requires a value`);
    if (arg === "--ref") options.ref = value;
    else if (arg === "--build") options.build = checkBuild(value);
    else if (arg === "--version") options.version = checkVersion(value);
    else if (arg === "--localization") options.localization = value;
    else options.displayType = value;
  }
  if (command === "upload" || command === "submit") {
    if (positional.length > 0) throw new Error(`Unexpected argument: ${positional[0]}`);
    if (command === "submit" && !options.build) throw new Error("submit requires --build (the number printed by upload)");
  } else if (command === "screenshots") {
    if (!options.localization || !options.displayType) throw new Error("screenshots requires --localization and --display-type");
    if (!/^[A-Za-z0-9-]+$/.test(options.localization) || !/^[A-Z0-9_]+$/.test(options.displayType)) throw new Error("Invalid --localization or --display-type");
    if (positional.length === 0) throw new Error("screenshots requires at least one image file");
    options.files = positional;
  } else {
    if (positional.length < 2 || positional.length > 3) throw new Error("api requires METHOD /v1/path [JSON]");
    if (!["GET", "POST", "PATCH", "DELETE"].includes(positional[0])) throw new Error("METHOD must be GET, POST, PATCH or DELETE");
    options.method = positional[0]; options.path = checkAscPath(positional[1]); options.body = positional[2];
    if (options.body !== undefined) { try { JSON.parse(options.body); } catch { throw new Error("The request body must be JSON"); } }
  }
  return options;
}

/** Build number rule: the local date and hour, YYYYMMDDHH. It only ever grows, so App Store Connect accepts each
 * upload. A second upload within the same hour needs an explicit, larger --build. */
export function defaultBuildNumber(now: Date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}${two(now.getHours())}`;
}

/** PRODUCT_BUNDLE_IDENTIFIER of the IAMCEO-iOS target in native/project.yml. */
export function iosBundleId(projectYml: string): string {
  const target = projectYml.split(/^  (?=\S)/m).find(block => block.startsWith(`${SCHEME}:`));
  const id = target?.match(/^\s+PRODUCT_BUNDLE_IDENTIFIER:\s*(\S+)\s*$/m)?.[1];
  if (!id || !/^[A-Za-z0-9.-]+$/.test(id)) throw new Error(`native/project.yml has no bundle identifier for ${SCHEME}`);
  return id;
}

export function exportOptionsPlist(teamId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>${teamId}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
`;
}

export interface AscCredentials { keyPath: string; keyId: string; issuerId: string }
type Env = Record<string, string | undefined>;

/** Reads names from the environment and checks their shape; the key file is only checked for existence here. */
export function ascCredentials(env: Env): AscCredentials {
  for (const key of ["ASC_KEY_PATH", "ASC_KEY_ID", "ASC_ISSUER_ID"]) if (!env[key]) throw new Error(`Missing environment variable: ${key}`);
  if (!/^[A-Za-z0-9]+$/.test(env.ASC_KEY_ID!)) throw new Error("ASC_KEY_ID has an unexpected format");
  if (!/^[A-Za-z0-9-]+$/.test(env.ASC_ISSUER_ID!)) throw new Error("ASC_ISSUER_ID has an unexpected format");
  if (!existsSync(env.ASC_KEY_PATH!)) throw new Error("ASC_KEY_PATH does not exist");
  return { keyPath: env.ASC_KEY_PATH!, keyId: env.ASC_KEY_ID!, issuerId: env.ASC_ISSUER_ID! };
}
export function appleTeamId(env: Env): string {
  if (!env.APPLE_TEAM_ID) throw new Error("Missing environment variable: APPLE_TEAM_ID");
  if (!/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID)) throw new Error("APPLE_TEAM_ID must be the 10-character Apple team ID");
  return env.APPLE_TEAM_ID;
}

/** ES256 token for the App Store Connect API, valid for 15 minutes. */
export function ascToken(keyPem: string, keyId: string, issuerId: string, nowSeconds: number = Math.floor(Date.now() / 1000)): string {
  const b64 = (value: Buffer | string) => Buffer.from(value).toString("base64url");
  const head = b64(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const body = b64(JSON.stringify({ iss: issuerId, iat: nowSeconds, exp: nowSeconds + 900, aud: "appstoreconnect-v1" }));
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), { key: createPrivateKey(keyPem), dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64(signature)}`;
}

export interface AscResponse { status: number; ok: boolean; text: string }
/** One authenticated call. The token is rebuilt per call, so a long wait never outlives it. */
export async function ascRequest(credentials: AscCredentials, method: string, path: string, body?: string, fetcher: typeof fetch = fetch): Promise<AscResponse> {
  const url = `${ASC_HOST}${checkAscPath(path)}`; // checked before the key is read: the token must never reach another host
  const token = ascToken(readFileSync(credentials.keyPath, "utf8"), credentials.keyId, credentials.issuerId);
  const response = await fetcher(url, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body,
  });
  return { status: response.status, ok: response.ok, text: await response.text() };
}

/** Parsed JSON of a successful call; a failed call throws with the status and the start of Apple's answer. */
export type AscApi = (method: string, path: string, body?: unknown) => Promise<any>;
export function ascClient(credentials: AscCredentials, fetcher: typeof fetch = fetch): AscApi {
  return async (method, path, body) => {
    const response = await ascRequest(credentials, method, path, body === undefined ? undefined : JSON.stringify(body), fetcher);
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${response.text.slice(0, 600)}`);
    return response.text ? JSON.parse(response.text) : {};
  };
}

export interface SubmitInput {
  api: AscApi; bundleId: string; version: string; build: string;
  log?: (line: string) => void; sleep?: (ms: number) => Promise<void>; attempts?: number; intervalMs?: number;
}
/** Wait until the uploaded build is processed, attach it to the App Store version, and submit that version for review. */
export async function submitForReview(input: SubmitInput): Promise<void> {
  const { api, bundleId, version, build } = input;
  const log = input.log ?? console.log, sleep = input.sleep ?? ((ms: number) => Bun.sleep(ms));
  const attempts = input.attempts ?? 90, intervalMs = input.intervalMs ?? 30_000;
  // The bundleId filter is not an exact match on Apple's side; pick the exact one.
  const apps = await api("GET", `/v1/apps?filter[bundleId]=${bundleId}&fields[apps]=bundleId`);
  const app = (apps.data ?? []).find((item: any) => item.attributes?.bundleId === bundleId);
  if (!app) throw new Error(`App Store Connect has no app with bundle identifier ${bundleId} for this API key`);
  const versions = await api("GET", `/v1/apps/${app.id}/appStoreVersions?filter[versionString]=${version}&filter[platform]=IOS&fields[appStoreVersions]=versionString,appStoreState`);
  const target = (versions.data ?? []).find((item: any) => item.attributes?.versionString === version);
  if (!target) throw new Error(`App Store Connect has no iOS version ${version}. Create it in App Store Connect first (docs/releasing.md), then run submit again.`);
  log(`app ${app.id}, version ${version} (${target.attributes?.appStoreState ?? "state unknown"})`);

  let buildId = "";
  for (let attempt = 1; attempt <= attempts && !buildId; attempt++) {
    const found = await api("GET", `/v1/builds?filter[app]=${app.id}&filter[version]=${build}&fields[builds]=processingState`);
    const builds: any[] = found.data ?? [];
    // The same number can exist under two marketing versions; never guess which one to submit.
    if (builds.length > 1) throw new Error(`More than one build is numbered ${build}; attach the right one in App Store Connect by hand`);
    const state = builds[0]?.attributes?.processingState;
    if (state === "VALID") { buildId = builds[0].id; break; }
    if (state === "INVALID" || state === "FAILED") throw new Error(`Build ${build} failed processing: ${state}`);
    if (attempt < attempts) { log(`build ${build}: ${state ?? "not visible yet"} (${attempt}/${attempts})`); await sleep(intervalMs); }
  }
  if (!buildId) throw new Error(`Timed out waiting for build ${build} to finish processing`);
  log(`build ${build} is VALID (${buildId})`);

  await api("PATCH", `/v1/appStoreVersions/${target.id}/relationships/build`, { data: { type: "builds", id: buildId } });
  const attached = await api("GET", `/v1/appStoreVersions/${target.id}/build`);
  if (attached.data?.attributes?.version !== build) throw new Error(`Version ${version} does not show build ${build} as attached; stop and check App Store Connect`);
  log(`attached build ${build} to version ${version}`);
  const submission = await api("POST", "/v1/reviewSubmissions", {
    data: { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: { app: { data: { type: "apps", id: app.id } } } },
  });
  const submissionId = submission.data?.id;
  if (!submissionId) throw new Error("App Store Connect did not return a review submission");
  await api("POST", "/v1/reviewSubmissionItems", {
    data: { type: "reviewSubmissionItems", relationships: {
      reviewSubmission: { data: { type: "reviewSubmissions", id: submissionId } },
      appStoreVersion: { data: { type: "appStoreVersions", id: target.id } },
    } },
  });
  await api("PATCH", `/v1/reviewSubmissions/${submissionId}`, { data: { type: "reviewSubmissions", id: submissionId, attributes: { submitted: true } } });
  const after = await api("GET", `/v1/appStoreVersions/${target.id}?fields[appStoreVersions]=versionString,appStoreState`);
  log(`SUBMITTED version ${after.data?.attributes?.versionString ?? version}: ${after.data?.attributes?.appStoreState ?? "state unknown"}`);
}

export interface ScreenshotInput { api: AscApi; localization: string; displayType: string; files: string[]; log?: (line: string) => void; fetcher?: typeof fetch }
/** Replaces nothing: creates the set for this display type if it is missing, then appends the files in order. */
export async function uploadScreenshots(input: ScreenshotInput): Promise<void> {
  const { api, localization, displayType, files } = input;
  const log = input.log ?? console.log, fetcher = input.fetcher ?? fetch;
  const sets = await api("GET", `/v1/appStoreVersionLocalizations/${localization}/appScreenshotSets`);
  let set = (sets.data ?? []).find((item: any) => item.attributes?.screenshotDisplayType === displayType);
  if (!set) set = (await api("POST", "/v1/appScreenshotSets", {
    data: { type: "appScreenshotSets", attributes: { screenshotDisplayType: displayType },
      relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: localization } } } },
  })).data;
  log(`set ${set.id} ${displayType}`);
  for (const file of files) {
    const bytes = readFileSync(file);
    const shot = (await api("POST", "/v1/appScreenshots", {
      data: { type: "appScreenshots", attributes: { fileName: basename(file), fileSize: bytes.length },
        relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: set.id } } } },
    })).data;
    for (const operation of shot.attributes.uploadOperations) {
      const headers: Record<string, string> = {};
      for (const header of operation.requestHeaders ?? []) headers[header.name] = header.value;
      const part = await fetcher(operation.url, { method: operation.method, headers, body: bytes.subarray(operation.offset, operation.offset + operation.length) });
      if (!part.ok) throw new Error(`Uploading ${basename(file)} failed: HTTP ${part.status}`);
    }
    await api("PATCH", `/v1/appScreenshots/${shot.id}`, {
      data: { type: "appScreenshots", id: shot.id, attributes: { uploaded: true, sourceFileChecksum: createHash("md5").update(bytes).digest("hex") } },
    });
    log(`uploaded ${basename(file)} ${shot.id}`);
  }
}

/** Archive the committed sources and upload the build. Mirrors release-mac.ts: every command is printed, credentials never are. */
export function uploadBuild(options: IosReleaseOptions, env: Env = process.env): void {
  const dry = options.dryRun;
  function read(command: string[], cwd = root): string {
    const result = Bun.spawnSync(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`${command[0]} failed: ${result.stderr.toString().trim()}`);
    return result.stdout.toString().trim();
  }
  const commit = read(["git", "rev-parse", "--verify", "--end-of-options", `${options.ref}^{commit}`]);
  const version = checkVersion((JSON.parse(read(["git", "show", `${commit}:package.json`])) as { version: string }).version);
  const build = options.build ?? defaultBuildNumber();
  let credentials: AscCredentials = { keyPath: "$ASC_KEY_PATH", keyId: "$ASC_KEY_ID", issuerId: "$ASC_ISSUER_ID" };
  let team = "$APPLE_TEAM_ID";
  if (dry) {
    for (const key of ["ASC_KEY_PATH", "ASC_KEY_ID", "ASC_ISSUER_ID", "APPLE_TEAM_ID"]) console.log(`[dry-run] ${key}: ${env[key] ? "set" : "MISSING"}`);
  } else {
    if (process.platform !== "darwin") throw new Error("Build on a Mac with Xcode and XcodeGen");
    credentials = ascCredentials(env); team = appleTeamId(env);
    for (const tool of ["git", "tar", "xcodegen", "xcodebuild"]) if (!Bun.which(tool)) throw new Error(`Required release tool missing: ${tool}`);
  }
  const work = dry ? "$WORK" : mkdtempSync(join(tmpdir(), "iamceo-ios-release-"));
  const native = join(work, "native");
  const archive = join(work, "IAMCEO.xcarchive");
  const secretAfter: Record<string, string> = { "-authenticationKeyPath": "ASC_KEY_PATH", "-authenticationKeyID": "ASC_KEY_ID", "-authenticationKeyIssuerID": "ASC_ISSUER_ID" };
  function run(command: string[], cwd = root): void {
    const display = command.map((part, i) => secretAfter[command[i - 1]] ? `<${secretAfter[command[i - 1]]} from env>`
      : part.startsWith("DEVELOPMENT_TEAM=") ? "DEVELOPMENT_TEAM=<APPLE_TEAM_ID from env>" : part);
    console.log(`${dry ? "[dry-run] " : ""}${display.map(part => `'${part.replaceAll("'", "'\\''")}'`).join(" ")}`);
    if (dry) return;
    const result = Bun.spawnSync(command, { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    if (result.exitCode !== 0) throw new Error(`Command failed (${result.exitCode}): ${command[0]}`);
  }
  const auth = ["-allowProvisioningUpdates", "-authenticationKeyPath", credentials.keyPath, "-authenticationKeyID", credentials.keyId, "-authenticationKeyIssuerID", credentials.issuerId];
  try {
    console.log(`iPhone ${version} build ${build} from clean git archive ${commit}. Working tree changes are excluded.`);
    run(["git", "archive", "--format=tar", "--output", join(work, "native.tar"), commit, "native"]);
    run(["tar", "-xf", join(work, "native.tar"), "-C", work]);
    if (dry) console.log("[dry-run] Set the empty project-level DEVELOPMENT_TEAM in the extracted copy of project.yml (never in the repository)");
    else {
      const spec = join(native, "project.yml");
      writeFileSync(spec, readFileSync(spec, "utf8").replace("DEVELOPMENT_TEAM: ''", `DEVELOPMENT_TEAM: '${team}'`));
    }
    run(["xcodegen", "generate", "--spec", "project.yml", "--quiet"], dry ? root : native);
    // package.json is the one source of the version; the build number follows the date rule above.
    run(["xcodebuild", "-quiet", "archive", "-project", PROJECT, "-scheme", SCHEME, "-configuration", "Release",
      "-destination", "generic/platform=iOS", "-archivePath", archive, "-derivedDataPath", join(work, "dd"), ...auth,
      `DEVELOPMENT_TEAM=${team}`, `MARKETING_VERSION=${version}`, `CURRENT_PROJECT_VERSION=${build}`], dry ? root : native);
    if (dry) console.log(`[dry-run] Require the archive to report version ${version} and build ${build}; abort before uploading otherwise`);
    else {
      const info = join(archive, "Info.plist");
      const print = (key: string) => read(["/usr/libexec/PlistBuddy", "-c", `Print :ApplicationProperties:${key}`, info]);
      if (print("CFBundleShortVersionString") !== version || print("CFBundleVersion") !== build) throw new Error("The archive's version or build number differs from the release; nothing was uploaded");
      writeFileSync(join(work, "ExportOptions.plist"), exportOptionsPlist(team));
    }
    run(["xcodebuild", "-exportArchive", "-archivePath", archive, "-exportOptionsPlist", join(work, "ExportOptions.plist"), "-exportPath", join(work, "export"), ...auth], dry ? root : native);
    console.log(dry ? `[dry-run] Nothing was built or uploaded. Next: submit --build ${build}`
      : `UPLOADED build ${build} (version ${version}). Next, once the App Store version exists: bun scripts/release-ios.ts submit --build ${build}`);
  } finally {
    if (!dry) rmSync(work, { recursive: true, force: true });
  }
}

function dryRequests(lines: string[]): void {
  for (const line of lines) console.log(`[dry-run] ${line}`);
  console.log("[dry-run] No key was read and no request was sent.");
}

export async function releaseIos(options: IosReleaseOptions, env: Env = process.env): Promise<void> {
  if (options.command === "help") { console.log(HELP); return; }
  if (options.command === "upload") { uploadBuild(options, env); return; }
  if (options.command === "submit") {
    const version = options.version ?? checkVersion((JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version);
    const bundleId = iosBundleId(readFileSync(join(root, "native", "project.yml"), "utf8"));
    if (options.dryRun) return dryRequests([
      `GET /v1/apps?filter[bundleId]=${bundleId}  -> the app`,
      `GET /v1/apps/<app>/appStoreVersions?filter[versionString]=${version}&filter[platform]=IOS  -> the version (must already exist)`,
      `GET /v1/builds?filter[app]=<app>&filter[version]=${options.build}  -> repeat every 30 s, up to 45 min, until processingState is VALID`,
      "PATCH /v1/appStoreVersions/<version>/relationships/build  -> attach the build",
      "POST /v1/reviewSubmissions, POST /v1/reviewSubmissionItems, PATCH /v1/reviewSubmissions/<id> submitted=true  -> submit for review",
    ]);
    await submitForReview({ api: ascClient(ascCredentials(env)), bundleId, version, build: options.build! });
    return;
  }
  if (options.command === "screenshots") {
    for (const file of options.files) if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`Not a file: ${file}`);
    if (options.dryRun) return dryRequests([
      `GET /v1/appStoreVersionLocalizations/${options.localization}/appScreenshotSets  -> find or create the ${options.displayType} set`,
      ...options.files.map(file => `POST /v1/appScreenshots ${basename(file)} (${statSync(file).size} bytes), upload its parts, PATCH uploaded=true`),
    ]);
    await uploadScreenshots({ api: ascClient(ascCredentials(env)), localization: options.localization!, displayType: options.displayType!, files: options.files });
    return;
  }
  if (options.dryRun) return dryRequests([`${options.method} ${options.path}${options.body ? " with a JSON body" : ""}`]);
  const response = await ascRequest(ascCredentials(env), options.method!, options.path!, options.body);
  console.log(response.status);
  try { console.log(JSON.stringify(JSON.parse(response.text), null, 1)); } catch { console.log(response.text); }
  if (!response.ok) process.exitCode = 1;
}

if (import.meta.main) {
  try { await releaseIos(parseIosReleaseOptions(process.argv.slice(2))); }
  catch (error) { console.error(`iPhone release failed: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; }
}
