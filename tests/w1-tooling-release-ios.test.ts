import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  appleTeamId, ascClient, ascCredentials, ascRequest, ascToken, defaultBuildNumber, exportOptionsPlist, iosBundleId,
  parseIosReleaseOptions, submitForReview, uploadScreenshots, type AscApi,
} from "../scripts/release-ios";
import pkg from "../package.json";

// The iPhone release tool never uploads or submits here: API calls go to an in-test fake, and the
// script itself is only run with --dry-run and --help.
setDefaultTimeout(20_000);

const root = resolve(import.meta.dir, "..");
const script = join(root, "scripts/release-ios.ts");
const projectYml = readFileSync(join(root, "native/project.yml"), "utf8");
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "iamceo-w1-tooling-")); temporary.push(path); return path;
}
function key(): { path: string; pem: string; publicKey: ReturnType<typeof createPublicKey> } {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const path = join(temp(), "test-key.p8"); writeFileSync(path, pem);
  return { path, pem, publicKey: pair.publicKey };
}

test("release-ios: options are per command, and malformed input is refused", () => {
  expect(parseIosReleaseOptions([]).command).toBe("help");
  expect(parseIosReleaseOptions(["upload", "--help"]).command).toBe("help");
  expect(parseIosReleaseOptions(["upload"])).toMatchObject({ command: "upload", ref: "HEAD", dryRun: false });
  expect(parseIosReleaseOptions(["upload", "--ref", "v0.2.2", "--build", "2026111017", "--dry-run"])).toMatchObject({ ref: "v0.2.2", build: "2026111017", dryRun: true });
  expect(parseIosReleaseOptions(["submit", "--build", "2026111017", "--version", "0.2.3"])).toMatchObject({ command: "submit", build: "2026111017", version: "0.2.3" });
  expect(parseIosReleaseOptions(["screenshots", "--localization", "abc-123", "--display-type", "APP_IPHONE_67", "a.png", "b.png"]).files).toEqual(["a.png", "b.png"]);
  expect(parseIosReleaseOptions(["api", "GET", "/v1/apps?filter[bundleId]=x"])).toMatchObject({ method: "GET", path: "/v1/apps?filter[bundleId]=x" });
  for (const args of [
    ["publish"], ["upload", "--unknown"], ["upload", "--ref"], ["upload", "--build", "1.2"], ["upload", "--build", "0"], ["upload", "extra"],
    ["upload", "--version", "0.2.3"], ["submit"], ["submit", "--build", "12", "--version", "0.2"], ["submit", "--build", "12", "--ref", "HEAD"],
    ["screenshots", "--localization", "abc", "a.png"], ["screenshots", "--localization", "abc", "--display-type", "APP_IPHONE_67"],
    ["api", "GET"], ["api", "PUT", "/v1/apps"], ["api", "POST", "/v1/apps", "{not json"],
    // The key must never be sent to another host: only an absolute API path is accepted.
    ["api", "GET", "@evil.example/v1/apps"], ["api", "GET", "https://evil.example/v1/apps"], ["api", "GET", "/apps"],
  ]) expect(() => parseIosReleaseOptions(args), args.join(" ")).toThrow();
});

test("release-ios: the build number is the local date and hour, and always ten digits", () => {
  expect(defaultBuildNumber(new Date(2026, 10, 10, 17, 45))).toBe("2026111017");
  expect(defaultBuildNumber(new Date(2027, 0, 5, 3, 0))).toBe("2027010503");
  expect(defaultBuildNumber()).toMatch(/^20\d{8}$/);
  // Later hours give larger numbers, so every upload is accepted as newer.
  expect(Number(defaultBuildNumber(new Date(2026, 10, 11, 0)))).toBeGreaterThan(Number(defaultBuildNumber(new Date(2026, 10, 10, 23))));
});

test("release-ios: the bundle identifier comes from the iPhone target of project.yml", () => {
  // A fixed example, not this repository's value: a fork that sets its own bundle identifier keeps passing.
  const example = (id: string) => `name: IAMCEO\ntargets:\n  IAMCEO-macOS:\n    settings:\n      base:\n        PRODUCT_BUNDLE_IDENTIFIER: com.example.mac\n  IAMCEO-iOS:\n    type: application\n    settings:\n      base:\n        PRODUCT_BUNDLE_IDENTIFIER: ${id}\n        MARKETING_VERSION: "1.2.3"\n`;
  expect(iosBundleId(example("com.example.phone"))).toBe("com.example.phone");
  expect(iosBundleId(example("org.fork.iamceo"))).toBe("org.fork.iamceo");
  // The real file must yield some identifier, whatever it is.
  expect(iosBundleId(projectYml)).toMatch(/^[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z0-9.-]+$/);
  expect(() => iosBundleId("targets:\n  IAMCEO-macOS:\n    settings:\n      base:\n        PRODUCT_BUNDLE_IDENTIFIER: com.iamceo.native.mac\n")).toThrow();
});

test("release-ios: export options upload to App Store Connect and leave the version numbers alone", () => {
  const plist = exportOptionsPlist("ABCDE12345");
  for (const text of ["<key>method</key><string>app-store-connect</string>", "<key>destination</key><string>upload</string>",
    "<key>teamID</key><string>ABCDE12345</string>", "<key>signingStyle</key><string>automatic</string>",
    "<key>manageAppVersionAndBuildNumber</key><false/>"]) expect(plist).toContain(text);
});

test("release-ios: credentials come from the environment only, and errors name the variable, never its value", () => {
  const k = key();
  const env = { ASC_KEY_PATH: k.path, ASC_KEY_ID: "TESTKEY123", ASC_ISSUER_ID: "11111111-2222-3333-4444-555555555555", APPLE_TEAM_ID: "ABCDE12345" };
  expect(ascCredentials(env)).toEqual({ keyPath: k.path, keyId: "TESTKEY123", issuerId: env.ASC_ISSUER_ID });
  expect(appleTeamId(env)).toBe("ABCDE12345");
  for (const name of ["ASC_KEY_PATH", "ASC_KEY_ID", "ASC_ISSUER_ID"]) expect(() => ascCredentials({ ...env, [name]: "" })).toThrow(`Missing environment variable: ${name}`);
  expect(() => appleTeamId({})).toThrow("Missing environment variable: APPLE_TEAM_ID");
  expect(() => appleTeamId({ APPLE_TEAM_ID: "abc'; rm" })).toThrow("10-character");
  let message = "";
  try { ascCredentials({ ...env, ASC_KEY_PATH: "/nonexistent/SECRET-PATH.p8" }); } catch (error) { message = (error as Error).message; }
  expect(message).toBe("ASC_KEY_PATH does not exist");
});

test("release-ios: the API token is a 15-minute ES256 token for App Store Connect, signed with the key", () => {
  const k = key();
  const token = ascToken(k.pem, "TESTKEY123", "issuer-1", 1_800_000_000);
  const [head, body, signature] = token.split(".");
  expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({ alg: "ES256", kid: "TESTKEY123", typ: "JWT" });
  expect(JSON.parse(Buffer.from(body, "base64url").toString())).toEqual({ iss: "issuer-1", iat: 1_800_000_000, exp: 1_800_000_900, aud: "appstoreconnect-v1" });
  expect(verify("sha256", Buffer.from(`${head}.${body}`), { key: k.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))).toBe(true);
  expect(token).not.toContain("PRIVATE KEY");
});

test("release-ios: a request goes only to App Store Connect, and a failed call reports status and answer", async () => {
  const k = key();
  const credentials = { keyPath: k.path, keyId: "TESTKEY123", issuerId: "issuer-1" };
  const seen: { url: string; method?: string; auth: string; body?: unknown }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), method: init?.method, auth: (init?.headers as Record<string, string>).Authorization, body: init?.body });
    return String(url).endsWith("/missing") ? new Response('{"errors":[{"detail":"no such thing"}]}', { status: 404 }) : Response.json({ data: [] });
  }) as typeof fetch;
  expect(await ascClient(credentials, fetcher)("GET", "/v1/apps")).toEqual({ data: [] });
  expect(seen[0].url).toBe("https://api.appstoreconnect.apple.com/v1/apps");
  expect(seen[0].auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  await expect(ascClient(credentials, fetcher)("GET", "/v1/missing")).rejects.toThrow("GET /v1/missing -> 404");
  // A path that would change the host is refused before the key is read or anything is sent.
  await expect(ascRequest({ ...credentials, keyPath: "/nonexistent" }, "GET", "@evil.example/v1/apps", undefined, fetcher)).rejects.toThrow("API path");
  expect(seen).toHaveLength(2);
});

/** A fake App Store Connect: one app, one version waiting for a build, and a build that finishes processing later. */
function fakeConnect(states: (string | undefined)[], overrides: Partial<Record<string, (path: string) => unknown>> = {}) {
  const calls: { method: string; path: string; body?: any }[] = [];
  const api: AscApi = async (method, path, body) => {
    calls.push({ method, path, body });
    for (const [prefix, answer] of Object.entries(overrides)) if (`${method} ${path}`.startsWith(prefix)) return answer!(path);
    if (method === "GET" && path.startsWith("/v1/apps?")) return { data: [
      { id: "APP-OTHER", attributes: { bundleId: "com.yehsung.iamceo.beta" } }, { id: "APP-1", attributes: { bundleId: "com.yehsung.iamceo" } }] };
    if (method === "GET" && path.startsWith("/v1/apps/APP-1/appStoreVersions?")) return { data: [{ id: "VER-1", attributes: { versionString: "0.2.3", appStoreState: "PREPARE_FOR_SUBMISSION" } }] };
    if (method === "GET" && path.startsWith("/v1/builds?")) {
      const state = states.length > 1 ? states.shift() : states[0];
      return { data: state ? [{ id: "BUILD-1", attributes: { processingState: state } }] : [] };
    }
    if (method === "GET" && path === "/v1/appStoreVersions/VER-1/build") return { data: { id: "BUILD-1", attributes: { version: "2026111017" } } };
    if (method === "POST" && path === "/v1/reviewSubmissions") return { data: { id: "SUB-1" } };
    if (method === "GET" && path.startsWith("/v1/appStoreVersions/VER-1?")) return { data: { attributes: { versionString: "0.2.3", appStoreState: "WAITING_FOR_REVIEW" } } };
    return { data: {} };
  };
  const writes = () => calls.filter(call => call.method !== "GET").map(call => `${call.method} ${call.path}`);
  return { api, calls, writes };
}
const submitInput = (api: AscApi, log: string[] = [], sleeps: number[] = []) => ({
  api, bundleId: "com.yehsung.iamceo", version: "0.2.3", build: "2026111017",
  log: (line: string) => { log.push(line); }, sleep: async (ms: number) => { sleeps.push(ms); },
});

test("release-ios submit: waits for processing, attaches the build to the version, then submits for review", async () => {
  const connect = fakeConnect([undefined, "PROCESSING", "VALID"]);
  const log: string[] = [], sleeps: number[] = [];
  await submitForReview(submitInput(connect.api, log, sleeps));
  expect(sleeps).toEqual([30_000, 30_000]);
  expect(connect.calls.find(call => call.path.startsWith("/v1/builds?"))!.path).toBe("/v1/builds?filter[app]=APP-1&filter[version]=2026111017&fields[builds]=processingState");
  expect(connect.writes()).toEqual([
    "PATCH /v1/appStoreVersions/VER-1/relationships/build", "POST /v1/reviewSubmissions", "POST /v1/reviewSubmissionItems", "PATCH /v1/reviewSubmissions/SUB-1",
  ]);
  const body = (path: string) => connect.calls.find(call => call.method !== "GET" && call.path === path)!.body;
  expect(body("/v1/appStoreVersions/VER-1/relationships/build")).toEqual({ data: { type: "builds", id: "BUILD-1" } });
  expect(body("/v1/reviewSubmissions")).toEqual({ data: { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: { app: { data: { type: "apps", id: "APP-1" } } } } });
  expect(body("/v1/reviewSubmissionItems")).toEqual({ data: { type: "reviewSubmissionItems", relationships: {
    reviewSubmission: { data: { type: "reviewSubmissions", id: "SUB-1" } }, appStoreVersion: { data: { type: "appStoreVersions", id: "VER-1" } } } } });
  expect(body("/v1/reviewSubmissions/SUB-1")).toEqual({ data: { type: "reviewSubmissions", id: "SUB-1", attributes: { submitted: true } } });
  expect(log.at(-1)).toBe("SUBMITTED version 0.2.3: WAITING_FOR_REVIEW");
});

test.each([
  ["a build that failed processing", () => fakeConnect(["INVALID"]), "failed processing: INVALID"],
  ["a build that never finishes", () => fakeConnect(["PROCESSING"]), "Timed out"],
  ["a version that does not exist yet", () => fakeConnect(["VALID"], { "GET /v1/apps/APP-1/appStoreVersions": () => ({ data: [] }) }), "Create it in App Store Connect first"],
  ["an app this key cannot see", () => fakeConnect(["VALID"], { "GET /v1/apps?": () => ({ data: [{ id: "APP-OTHER", attributes: { bundleId: "com.yehsung.iamceo.beta" } }] }) }), "no app with bundle identifier"],
  ["two builds with the same number", () => fakeConnect(["VALID"], { "GET /v1/builds?": () => ({ data: [{ id: "A", attributes: { processingState: "VALID" } }, { id: "B", attributes: { processingState: "VALID" } }] }) }), "More than one build"],
])("release-ios submit: %s is never attached or submitted", async (_name, make, message) => {
  const connect = make();
  await expect(submitForReview({ ...submitInput(connect.api), attempts: 3 })).rejects.toThrow(message);
  expect(connect.writes()).toEqual([]);
});

test("release-ios submit: a version that does not show the build as attached is not submitted", async () => {
  const connect = fakeConnect(["VALID"], { "GET /v1/appStoreVersions/VER-1/build": () => ({ data: { id: "BUILD-0", attributes: { version: "2026110901" } } }) });
  await expect(submitForReview(submitInput(connect.api))).rejects.toThrow("does not show build 2026111017");
  expect(connect.writes()).toEqual(["PATCH /v1/appStoreVersions/VER-1/relationships/build"]);
});

test("release-ios screenshots: creates the missing set, uploads each part, and confirms with the checksum", async () => {
  const folder = temp(); const file = join(folder, "home.png"); const bytes = Buffer.from("0123456789abcdef"); writeFileSync(file, bytes);
  const calls: { method: string; path: string; body?: any }[] = [];
  const api: AscApi = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET") return { data: [{ id: "SET-OTHER", attributes: { screenshotDisplayType: "APP_IPHONE_55" } }] };
    if (path === "/v1/appScreenshotSets") return { data: { id: "SET-1" } };
    if (path === "/v1/appScreenshots") return { data: { id: "SHOT-1", attributes: { uploadOperations: [
      { url: "https://upload.example/part1", method: "PUT", offset: 0, length: 10, requestHeaders: [{ name: "Content-Type", value: "image/png" }] },
      { url: "https://upload.example/part2", method: "PUT", offset: 10, length: 6, requestHeaders: [] }] } } };
    return { data: {} };
  };
  const parts: { url: string; body: string; type?: string }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    parts.push({ url: String(url), body: Buffer.from(init!.body as Uint8Array).toString(), type: (init!.headers as Record<string, string>)["Content-Type"] });
    return new Response("", { status: 200 });
  }) as typeof fetch;
  await uploadScreenshots({ api, localization: "LOC-1", displayType: "APP_IPHONE_67", files: [file], log: () => {}, fetcher });
  expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
    "GET /v1/appStoreVersionLocalizations/LOC-1/appScreenshotSets", "POST /v1/appScreenshotSets", "POST /v1/appScreenshots", "PATCH /v1/appScreenshots/SHOT-1"]);
  expect(calls[2].body.data.attributes).toEqual({ fileName: "home.png", fileSize: 16 });
  expect(calls[2].body.data.relationships.appScreenshotSet.data.id).toBe("SET-1");
  expect(parts).toEqual([{ url: "https://upload.example/part1", body: "0123456789", type: "image/png" }, { url: "https://upload.example/part2", body: "abcdef", type: undefined }]);
  expect(calls[3].body.data.attributes).toEqual({ uploaded: true, sourceFileChecksum: createHash("md5").update(bytes).digest("hex") });
});

/** A PATH whose build tools refuse to run, a git that only answers the two read-only questions, and secret-looking credentials. */
function dryFixture() {
  const path = temp(); const bin = join(path, "bin"); mkdirSync(bin);
  const tool = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  tool("git", `case "$1" in
rev-parse) printf '%040d\\n' 7 ;;
show) printf '{"version":"${pkg.version}"}\\n' ;;
*) echo "git $1 must not run" >&2; exit 91 ;;
esac`);
  for (const name of ["xcodebuild", "xcodegen", "tar", "curl"]) tool(name, `echo "${name} must not run" > "${path}/ran-${name}"; exit 91`);
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: join(path, "home"), TMPDIR: path,
    ASC_KEY_PATH: "/nonexistent/SECRET-KEY-PATH.p8", ASC_KEY_ID: "SECRETKEYID", ASC_ISSUER_ID: "SECRET-ISSUER", APPLE_TEAM_ID: "SECRETTEAM" };
  const run = (...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, script, ...args], { env, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  };
  return { path, run };
}

test("release-ios upload --dry-run: previews archive and upload with the package version and a dated build, runs nothing, prints no credential", () => {
  const f = dryFixture();
  const result = f.run("upload", "--dry-run");
  expect(result.code, result.output).toBe(0);
  for (const text of ["'git' 'archive'", "'xcodegen' 'generate'", "'xcodebuild' '-quiet' 'archive'", "'-scheme' 'IAMCEO-iOS'", "'-configuration' 'Release'",
    "'generic/platform=iOS'", "'-allowProvisioningUpdates'", `'MARKETING_VERSION=${pkg.version}'`, "'xcodebuild' '-exportArchive'", "ExportOptions.plist",
    "'DEVELOPMENT_TEAM=<APPLE_TEAM_ID from env>'", "<ASC_KEY_PATH from env>", "<ASC_KEY_ID from env>", "<ASC_ISSUER_ID from env>", "Nothing was built or uploaded"]) expect(result.output).toContain(text);
  expect(result.output).toMatch(/'CURRENT_PROJECT_VERSION=20\d{8}'/);
  expect(result.output.indexOf("'archive'")).toBeLessThan(result.output.indexOf("'-exportArchive'"));
  expect(result.output).toContain("ASC_KEY_PATH: set");
  expect(result.output).not.toContain("SECRET");
  expect([...new Bun.Glob("ran-*").scanSync({ cwd: f.path })]).toEqual([]);
  // An explicit build number replaces the dated one.
  expect(f.run("upload", "--dry-run", "--build", "2026111018").output).toContain("'CURRENT_PROJECT_VERSION=2026111018'");
});

test("release-ios submit, screenshots, api --dry-run: list the calls without reading the key or sending anything", () => {
  const f = dryFixture();
  const submit = f.run("submit", "--build", "2026111017", "--dry-run");
  expect(submit.code, submit.output).toBe(0);
  for (const text of [`filter[bundleId]=${iosBundleId(projectYml)}`, `filter[versionString]=${pkg.version}`, "filter[version]=2026111017", "relationships/build", "reviewSubmissions", "No key was read and no request was sent."]) expect(submit.output).toContain(text);
  const png = join(f.path, "one.png"); writeFileSync(png, "png");
  const shots = f.run("screenshots", "--localization", "LOC-1", "--display-type", "APP_IPHONE_67", "--dry-run", png);
  expect(shots.code, shots.output).toBe(0); expect(shots.output).toContain("one.png (3 bytes)");
  const api = f.run("api", "GET", "/v1/apps", "--dry-run");
  expect(api.code, api.output).toBe(0); expect(api.output).toContain("GET /v1/apps");
  for (const result of [submit, shots, api]) expect(result.output).not.toContain("SECRET");
  // Without --dry-run the missing key stops everything before any request, and the path is not echoed.
  const real = f.run("api", "GET", "/v1/apps");
  expect(real.code).toBe(1); expect(real.output).toContain("ASC_KEY_PATH does not exist"); expect(real.output).not.toContain("SECRET");
});

test("release-ios --help: explains the commands and names every environment variable", () => {
  const result = dryFixture().run("--help");
  expect(result.code, result.output).toBe(0);
  for (const text of ["upload", "submit", "screenshots", "--dry-run", "ASC_KEY_PATH", "ASC_KEY_ID", "ASC_ISSUER_ID", "APPLE_TEAM_ID", "docs/releasing.md"]) expect(result.output).toContain(text);
});
