// 0.2.11: AI 도구(CLI) 새 판 알림과 원클릭 업데이트(server/cli-update.ts).
// - 설치 방식은 서버가 쓰는 실행 파일의 실제 경로로 가리고, 그 방식에 맞는 공개 주소에서 최신 판을 읽는다(시험은 주소별 답을 주입한다).
// - 업데이트는 가짜 brew·npm·claude·agy 로만 돌린다(임시 폴더에 만든 셸 스크립트). 이 Mac 의 진짜 CLI 는 부르지 않는다.
// - 시험 모드(IAMCEO_TEST)의 서비스는 네트워크를 쓰지 않고, 임시 폴더 밖의 실행 파일로는 업데이트 명령을 돌리지 않는다.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CliVersionMonitor } from "../server/cli-version.ts";
import {
  CLI_UPDATE_FORCE_MIN_MS, CLI_UPDATE_NOTICES_KEY, CliUpdateError, CliUpdates, compareCliVersions, detectCliInstall, parseLatestVersion, testModeAllows, updatePlan,
  type CliUpdatesOptions,
} from "../server/cli-update.ts";
import type { CliProvider, CliUpdateInfo, CliUpdatePhase, CliUpdateRun } from "../shared/types.ts";
import { rejection } from "./fixtures/settle.ts";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function dir(prefix = "iamceo-cli-update-"): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function script(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
/** --version 이면 판 파일의 내용을 찍는 가짜 CLI. 판 파일을 바꾸면 '새 판이 깔린' 것과 같다. */
function versionScript(path: string, versionFile: string, format = "%s"): string {
  return script(path, `if [ "$1" = "--version" ]; then printf '${format}\\n' "$(cat '${versionFile}')"; exit 0; fi\necho "unexpected: $*" >&2\nexit 9`);
}
const calls = (file: string) => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];

/** api_recovery_state 대신 쓰는 메모리 저장소(같은 객체를 넘기면 서버를 다시 켠 것과 같다). */
function memoryState() {
  const data = new Map<string, string>();
  return { loadApiRecovery: <T>(key: string) => (data.has(key) ? JSON.parse(data.get(key)!) as T : null), saveApiRecovery: (key: string, value: unknown) => { data.set(key, JSON.stringify(value)); }, data };
}

const CASK_CLAUDE = "https://formulae.brew.sh/api/cask/claude-code@latest.json";
const NPM_CODEX = "https://registry.npmjs.org/@openai/codex/latest";
const AGY_MANIFEST_ARM = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json";
const caskBody = (version: string) => JSON.stringify({ token: "claude-code@latest", version, url: `https://downloads.claude.ai/claude-code-releases/${version}/darwin-arm64/claude` });
const npmBody = (version: string) => JSON.stringify({ name: "@openai/codex", version });
const agyBody = (version: string) => JSON.stringify({ version, url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-1/darwin-arm/cli_mac_arm64.tar.gz`, sha512: "00" });

describe("판 비교와 최신 판 읽기", () => {
  test("점으로 나눈 숫자를 차례로 견주고, 같은 숫자면 정식 판이 미리보기 판보다 새 판이다", () => {
    expect(compareCliVersions("2.1.332", "2.1.331")).toBeGreaterThan(0);
    expect(compareCliVersions("2.1.331", "2.1.331")).toBe(0);
    expect(compareCliVersions("0.172.0", "0.166.0")).toBeGreaterThan(0);
    expect(compareCliVersions("0.99.0", "0.166.0")).toBeLessThan(0);
    expect(compareCliVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareCliVersions("0.170.0", "0.170.0-alpha.2")).toBeGreaterThan(0);
    expect(compareCliVersions("0.170.0-alpha.10", "0.170.0-alpha.2")).toBeGreaterThan(0);
  });
  test("출처마다의 답 모양에서 판만 꺼낸다. 모양이 다르거나 판 같지 않은 값은 버린다", () => {
    expect(parseLatestVersion("brew_cask", caskBody("2.1.331"))).toBe("2.1.331");
    // Antigravity CLI cask 는 '판,빌드' 모양이다(formulae.brew.sh 실측 1.5.16,5250855658717184).
    expect(parseLatestVersion("brew_cask", JSON.stringify({ version: "1.5.16,5250855658717184" }))).toBe("1.5.16");
    expect(parseLatestVersion("brew_formula", JSON.stringify({ name: "codex", versions: { stable: "0.172.0" } }))).toBe("0.172.0");
    expect(parseLatestVersion("npm", npmBody("0.172.0"))).toBe("0.172.0");
    expect(parseLatestVersion("text", "2.1.331\n")).toBe("2.1.331");
    expect(parseLatestVersion("manifest", agyBody("1.5.16"))).toBe("1.5.16");
    for (const [kind, body] of [["npm", "<html>"], ["npm", JSON.stringify({ version: "latest" })], ["text", "<!doctype html>"], ["text", "2.1"],
      ["brew_cask", JSON.stringify({ version: "1.0.0; rm -rf /" })], ["manifest", "{}"], ["npm", JSON.stringify({ version: "9".repeat(80) + ".0.0" })]] as const) {
      expect([kind, body, parseLatestVersion(kind, body)]).toEqual([kind, body, null]);
    }
  });
});

describe("설치 방식 가리기(실행 파일의 실제 경로)", () => {
  test("Homebrew cask: Caskroom/<cask>/<판>/… 이면 그 cask 를 같은 prefix 의 brew 로 올린다. 최신 판은 그 cask 의 공개 API", () => {
    const root = dir();
    const real = versionScript(join(root, "homebrew/Caskroom/claude-code@latest/2.1.331/claude"), join(root, "v"));
    mkdirSync(join(root, "homebrew/bin"), { recursive: true });
    symlinkSync(real, join(root, "homebrew/bin/claude"));
    const brew = script(join(root, "homebrew/bin/brew"), "exit 0");
    const install = detectCliInstall("claude", join(root, "homebrew/bin/claude"));
    expect(install).toMatchObject({ cli: "claude", method: "brew_cask", name: "claude-code@latest", program: brew, manualCommand: "brew upgrade --cask claude-code@latest",
      source: { url: CASK_CLAUDE, kind: "brew_cask", label: "Homebrew cask claude-code@latest" } });
    expect(updatePlan(install, "2.1.332")!.steps.map(step => step.argv)).toEqual([[brew, "update", "--quiet"], [brew, "upgrade", "--cask", "claude-code@latest"]]);
    // brew 가 그 prefix 에 없으면 원클릭은 안 되고 직접 할 명령만 안내한다.
    rmSync(brew);
    expect(detectCliInstall("claude", join(root, "homebrew/bin/claude"))).toMatchObject({ method: "brew_cask", program: null, manualCommand: "brew upgrade --cask claude-code@latest" });
  });
  test("Homebrew formula·cask 로 깐 Codex 도 가린다", () => {
    const root = dir();
    script(join(root, "homebrew/bin/brew"), "exit 0");
    const formula = versionScript(join(root, "homebrew/Cellar/codex/0.166.0/bin/codex"), join(root, "v"));
    expect(detectCliInstall("codex", formula)).toMatchObject({ method: "brew_formula", name: "codex", manualCommand: "brew upgrade codex",
      source: { url: "https://formulae.brew.sh/api/formula/codex.json", kind: "brew_formula" } });
    const cask = versionScript(join(root, "homebrew/Caskroom/codex/0.166.0/codex-aarch64-apple-darwin"), join(root, "v"));
    expect(detectCliInstall("codex", cask)).toMatchObject({ method: "brew_cask", name: "codex", source: { url: "https://formulae.brew.sh/api/cask/codex.json" } });
  });
  test("npm 전역: <prefix>/lib/node_modules/<패키지>/… 이면 같은 prefix 로 npm install -g. 그 prefix 의 npm 이 있으면 그것을 쓴다", () => {
    const root = dir();
    const real = versionScript(join(root, "npm/lib/node_modules/@openai/codex/bin/codex.js"), join(root, "v"), "codex-cli %s");
    mkdirSync(join(root, "npm/bin"), { recursive: true });
    symlinkSync("../lib/node_modules/@openai/codex/bin/codex.js", join(root, "npm/bin/codex"));
    const npm = script(join(root, "npm/bin/npm"), "exit 0");
    const install = detectCliInstall("codex", join(root, "npm/bin/codex"));
    expect(install).toMatchObject({ method: "npm_global", name: "@openai/codex", prefix: join(root, "npm"), program: npm, manualCommand: "npm install -g @openai/codex@latest",
      source: { url: NPM_CODEX, kind: "npm", label: "npm @openai/codex" } });
    expect(real.endsWith("codex.js")).toBe(true);
    expect(updatePlan(install, "0.172.0")!.steps.map(step => step.argv)).toEqual([[npm, "install", "-g", "--prefix", join(root, "npm"), "--no-fund", "--no-audit", "@openai/codex@0.172.0"]]);
    // Claude Code 도 npm 으로 깔 수 있다. 다른 CLI 의 패키지 안에 있는 실행 파일은 모르는 방식이다.
    versionScript(join(root, "npm/lib/node_modules/@anthropic-ai/claude-code/cli.js"), join(root, "v"));
    expect(detectCliInstall("claude", join(root, "npm/lib/node_modules/@anthropic-ai/claude-code/cli.js"))).toMatchObject({ method: "npm_global", name: "@anthropic-ai/claude-code" });
    expect(detectCliInstall("claude", real)).toMatchObject({ method: "unknown", program: null, manualCommand: null });
  });
  test("Claude 네이티브 설치(~/.local/share/claude/versions)는 claude update. 최신 판은 공식 배포 경로의 latest(설정이 stable 이면 stable)", () => {
    const root = dir(), home = join(root, "home"), claudeHome = join(root, "claude-config");
    versionScript(join(home, ".local/share/claude/versions/2.1.331"), join(root, "v"));
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    symlinkSync(join(home, ".local/share/claude/versions/2.1.331"), join(home, ".local/bin/claude"));
    const bin = join(home, ".local/bin/claude");
    const install = detectCliInstall("claude", bin, { userHome: home, claudeHome });
    expect(install).toMatchObject({ method: "claude_native", program: bin, manualCommand: "claude update",
      source: { url: "https://downloads.claude.ai/claude-code-releases/latest", kind: "text" } });
    expect(updatePlan(install, "2.1.332")!.steps.map(step => step.argv)).toEqual([[bin, "update"]]);
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({ autoUpdatesChannel: "stable" }));
    expect(detectCliInstall("claude", bin, { userHome: home, claudeHome }).source?.url).toBe("https://downloads.claude.ai/claude-code-releases/stable");
  });
  test("Antigravity CLI 는 스스로 업데이트한다(agy update). 최신 판은 공식 자동 업데이트 서버의 그 기계용 manifest", () => {
    const root = dir();
    const agy = versionScript(join(root, "bin/agy"), join(root, "v"));
    const install = detectCliInstall("gemini", agy, { arch: "arm64" });
    expect(install).toMatchObject({ method: "agy_self", program: agy, manualCommand: "agy update", source: { url: AGY_MANIFEST_ARM, kind: "manifest" } });
    expect(detectCliInstall("gemini", agy, { arch: "x64" }).source?.url).toBe("https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_amd64.json");
    expect(updatePlan(install, "1.5.17")!.steps.map(step => step.argv)).toEqual([[agy, "update"]]);
  });
  test("모르는 방식이면 원클릭 없이 직접 업데이트 안내만. 최신 판은 그 CLI 의 공식 출처로 읽어 알리기는 한다", () => {
    const root = dir();
    const plain = versionScript(join(root, "somewhere/codex"), join(root, "v"));
    expect(detectCliInstall("codex", plain)).toMatchObject({ method: "unknown", program: null, manualCommand: null, source: { url: NPM_CODEX } });
    const claude = versionScript(join(root, "somewhere/claude"), join(root, "v"));
    expect(detectCliInstall("claude", claude)).toMatchObject({ method: "unknown", program: null, source: { url: "https://downloads.claude.ai/claude-code-releases/latest" } });
    expect(updatePlan(detectCliInstall("codex", plain), "0.172.0")).toBeNull();
    expect(detectCliInstall("codex", null)).toMatchObject({ method: "unknown", bin: null, program: null });
  });
  test("시험 모드에서는 임시 폴더 안의 실행 파일만 돌린다", () => {
    const root = dir();
    expect(testModeAllows(script(join(root, "brew"), "exit 0"))).toBe(true);
    expect(testModeAllows("/bin/echo")).toBe(false);
    expect(testModeAllows("/opt/homebrew/bin/brew")).toBe(false);
    // 임시 폴더 안의 링크라도 실제 경로가 밖이면 막는다.
    symlinkSync("/bin/echo", join(root, "echo"));
    expect(testModeAllows(join(root, "echo"))).toBe(false);
  });
});

// ---- 서비스 ----
interface World { root: string; home: string; urls: Map<string, string | null>; fetched: string[]; notices: CliUpdateInfo[]; installed: [CliProvider, string][]; changes: number; phases: CliUpdatePhase[] }
function service(world: World, bins: { claude?: string | null; codex?: string | null; gemini?: string | null }, extra: Partial<CliUpdatesOptions> = {}) {
  const monitor = new CliVersionMonitor({ claudeBin: bins.claude ?? join(world.root, "no-claude"), codexBin: bins.codex ?? join(world.root, "no-codex"), geminiBin: bins.gemini ?? null, recheckMs: 0 });
  let clock = Date.parse("2026-11-25T00:00:00.000Z");
  const state = extra.state ?? memoryState();
  const updates = new CliUpdates({
    home: world.home, versions: monitor, state,
    bins: () => ({ claudeBin: bins.claude ?? join(world.root, "no-claude"), codexBin: bins.codex ?? join(world.root, "no-codex"), geminiBin: bins.gemini ?? null }),
    fetchText: async url => { world.fetched.push(url); const body = world.urls.get(url); if (body === undefined) throw new Error(`unexpected url ${url}`); return body; },
    now: () => clock,
    onChange: () => { world.changes++; const run = [...updates.list()].map(i => i.run).find(Boolean); if (run && world.phases.at(-1) !== run.phase) world.phases.push(run.phase); },
    onNotice: info => { world.notices.push(info); },
    onInstalled: (cli, version) => { world.installed.push([cli, version]); },
    arch: "arm64", killGraceMs: 200,
    ...extra,
  });
  cleanups.push(() => updates.stop());
  return { updates, monitor, state, advance: (ms: number) => { clock += ms; } };
}
function newWorld(): World {
  const root = dir();
  return { root, home: join(root, "iamceo"), urls: new Map(), fetched: [], notices: [], installed: [], changes: 0, phases: [] };
}
const until = async (what: string, check: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error(`기다림 초과: ${what}`); await Bun.sleep(20); }
};

/** brew 로 깐 Claude Code(이 Mac 과 같은 모양). 가짜 brew 는 upgrade 때 새 판 폴더를 만들고 링크를 옮긴다. */
function brewClaude(world: World, from: string, to: string, upgrade?: string) {
  const prefix = join(world.root, "homebrew"), log = join(world.root, "brew.calls");
  const cli = (version: string) => script(join(prefix, `Caskroom/claude-code@latest/${version}/claude`), `[ "$1" = "--version" ] && echo "${version} (Claude Code)" && exit 0\nexit 9`);
  cli(from);
  mkdirSync(join(prefix, "bin"), { recursive: true });
  symlinkSync(join(prefix, `Caskroom/claude-code@latest/${from}/claude`), join(prefix, "bin/claude"));
  script(join(prefix, "bin/brew"), `echo "$*" >> '${log}'
case "$1" in
  update) echo "Already up-to-date."; exit 0;;
  upgrade) ${upgrade ?? `echo "==> Downloading https://downloads.claude.ai/claude-code-releases/${to}/darwin-arm64/claude"
    echo "==> Upgrading 1 outdated package:"
    echo "claude-code@latest ${from} -> ${to}"
    mkdir -p '${prefix}/Caskroom/claude-code@latest/${to}'
    cat > '${prefix}/Caskroom/claude-code@latest/${to}/claude' <<'NEW'
#!/bin/sh
[ "$1" = "--version" ] && echo "${to} (Claude Code)" && exit 0
exit 9
NEW
    chmod +x '${prefix}/Caskroom/claude-code@latest/${to}/claude'
    ln -sfn '${prefix}/Caskroom/claude-code@latest/${to}/claude' '${prefix}/bin/claude'
    rm -rf '${prefix}/Caskroom/claude-code@latest/${from}'
    echo "==> Installing Cask claude-code@latest"
    echo "claude-code@latest was successfully upgraded!"; exit 0`};;
esac
exit 1`);
  return { bin: join(prefix, "bin/claude"), log, brew: join(prefix, "bin/brew") };
}

describe("새 판 확인(공개 주소)", () => {
  test("설치 방식에 맞는 출처를 한 번 읽고 약 6시간 담아 둔다. 새 판이면 available, 확인된 판인지도 싣는다", async () => {
    const world = newWorld();
    const claude = brewClaude(world, "2.1.323", "2.1.332");
    world.urls.set(CASK_CLAUDE, caskBody("2.1.332"));
    const { updates, monitor, advance } = service(world, { claude: claude.bin });
    await monitor.refresh(true);
    await updates.check();
    expect(world.fetched).toEqual([CASK_CLAUDE]);
    const [info] = updates.list();
    expect(info).toMatchObject({ cli: "claude", current: "2.1.323", latest: "2.1.332", available: true, latestVerified: false, method: "brew_cask", oneClick: true,
      manualCommand: "brew upgrade --cask claude-code@latest", source: "Homebrew cask claude-code@latest" });
    expect(info!.checkedAt).toBe("2026-11-25T00:00:00.000Z");
    // 6시간 안에는 다시 읽지 않는다.
    advance(5 * 3600_000);
    await updates.check();
    expect(world.fetched).toHaveLength(1);
    advance(3600_000 + 1);
    world.urls.set(CASK_CLAUDE, caskBody("2.1.323"));
    await updates.check();
    expect(world.fetched).toHaveLength(2);
    expect(updates.list()[0]).toMatchObject({ latest: "2.1.323", available: false, latestVerified: true });
  });
  test("읽기에 실패해도 서버에 영향이 없고 마지막으로 읽은 값을 쓴다. 30분 뒤에 다시 읽는다", async () => {
    const world = newWorld();
    const claude = brewClaude(world, "2.1.323", "2.1.332");
    world.urls.set(CASK_CLAUDE, caskBody("2.1.332"));
    const { updates, monitor, advance } = service(world, { claude: claude.bin });
    await monitor.refresh(true);
    await updates.check();
    advance(6 * 3600_000 + 1);
    world.urls.set(CASK_CLAUDE, null);
    await updates.check();
    expect(updates.list()[0]).toMatchObject({ latest: "2.1.332", available: true });
    advance(10 * 60_000);
    await updates.check();
    expect(world.fetched).toHaveLength(2);
    advance(21 * 60_000);
    world.urls.delete(CASK_CLAUDE); // 던지는 출처
    await updates.check();
    expect(world.fetched).toHaveLength(3);
    expect(updates.list()[0]).toMatchObject({ latest: "2.1.332" });
  });
  test("시험 모드에서 읽기를 주입하지 않으면 네트워크를 쓰지 않는다", async () => {
    const world = newWorld();
    const claude = brewClaude(world, "2.1.323", "2.1.332");
    const realFetch = globalThis.fetch;
    let used = 0;
    globalThis.fetch = (async () => { used++; throw new Error("no network in tests"); }) as unknown as typeof fetch;
    try {
      const monitor = new CliVersionMonitor({ claudeBin: claude.bin, codexBin: join(world.root, "no"), geminiBin: null });
      await monitor.refresh(true);
      const updates = new CliUpdates({ home: world.home, versions: monitor, state: memoryState(), bins: () => ({ claudeBin: claude.bin, codexBin: join(world.root, "no"), geminiBin: null }) });
      cleanups.push(() => updates.stop());
      await updates.check(true);
      expect(used).toBe(0);
      expect(updates.list()[0]).toMatchObject({ cli: "claude", current: "2.1.323", latest: null, available: false });
    } finally { globalThis.fetch = realFetch; }
  });
  test("새 판은 판마다 한 번만 알린다. 서버를 다시 켜도(같은 저장소) 같은 판을 다시 알리지 않고, 더 새 판이 나오면 다시 알린다", async () => {
    const world = newWorld();
    const claude = brewClaude(world, "2.1.323", "2.1.332");
    world.urls.set(CASK_CLAUDE, caskBody("2.1.332"));
    const first = service(world, { claude: claude.bin });
    await first.monitor.refresh(true);
    await first.updates.check();
    await first.updates.check(true);
    expect(world.notices.map(n => [n.cli, n.latest])).toEqual([["claude", "2.1.332"]]);
    expect(first.state.loadApiRecovery<Record<string, string>>(CLI_UPDATE_NOTICES_KEY)).toEqual({ claude: "2.1.332" });
    const again = service(world, { claude: claude.bin }, { state: first.state });
    await again.monitor.refresh(true);
    await again.updates.check(true);
    expect(world.notices).toHaveLength(1);
    world.urls.set(CASK_CLAUDE, caskBody("2.1.333"));
    // '다시 확인'도 같은 출처를 1분 안에 다시 읽지는 않는다.
    await again.updates.check(true);
    expect(world.notices).toHaveLength(1);
    again.advance(CLI_UPDATE_FORCE_MIN_MS);
    await again.updates.check(true);
    expect(world.notices.map(n => n.latest)).toEqual(["2.1.332", "2.1.333"]);
  });
});

describe("원클릭 업데이트(가짜 명령)", () => {
  test("Homebrew cask: brew update 뒤 brew upgrade --cask. 입력은 닫혀 있고, 진행이 내려받는 중 → 설치 중 → 확인 중 → 끝으로 바뀐다. 판을 다시 읽어 확인하고 적용을 부른다", async () => {
    const world = newWorld();
    const claude = brewClaude(world, "2.1.323", "2.1.332");
    world.urls.set(CASK_CLAUDE, caskBody("2.1.332"));
    const { updates, monitor } = service(world, { claude: claude.bin });
    await monitor.refresh(true);
    await updates.check();
    const run = updates.update("claude", "2.1.332");
    expect(run).toMatchObject({ cli: "claude", from: "2.1.323", to: "2.1.332", phase: "downloading", endedAt: null, error: null, installed: null });
    await updates.settled("claude");
    const done = updates.info("claude").run!;
    expect(done).toMatchObject({ phase: "done", installed: "2.1.332", error: null });
    expect(done.endedAt).not.toBeNull();
    expect(world.phases).toEqual(["downloading", "installing", "verifying", "done"]);
    expect(calls(claude.log)).toEqual(["update --quiet", "upgrade --cask claude-code@latest"]);
    expect(world.installed).toEqual([["claude", "2.1.332"]]);
    expect(updates.info("claude")).toMatchObject({ current: "2.1.332", available: false });
    // 출력은 로그 파일로 남는다(비밀은 가린다).
    const log = readFileSync(join(world.home, "logs", "cli-update-claude.log"), "utf8");
    expect(log).toContain("brew upgrade --cask claude-code@latest");
    expect(log).toContain("claude-code@latest was successfully upgraded!");
  });
  test("npm 전역: 같은 prefix 의 npm 으로 그 판을 깐다", async () => {
    const world = newWorld();
    const prefix = join(world.root, "npm"), versionFile = join(world.root, "codex.version"), log = join(world.root, "npm.calls");
    writeFileSync(versionFile, "0.166.0");
    versionScript(join(prefix, "lib/node_modules/@openai/codex/bin/codex.js"), versionFile, "codex-cli %s");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    symlinkSync("../lib/node_modules/@openai/codex/bin/codex.js", join(prefix, "bin/codex"));
    script(join(prefix, "bin/npm"), `echo "$*" >> '${log}'\necho "npm_config_yes=$npm_config_yes"\necho "added 2 packages, changed 1 package in 3s"\nprintf '%s' "\${7#@openai/codex@}" > '${versionFile}'\nexit 0`);
    world.urls.set(NPM_CODEX, npmBody("0.172.0"));
    const { updates, monitor } = service(world, { codex: join(prefix, "bin/codex") });
    await monitor.refresh(true);
    await updates.check();
    expect(updates.info("codex")).toMatchObject({ current: "0.166.0", latest: "0.172.0", available: true, latestVerified: false, method: "npm_global", oneClick: true });
    updates.update("codex");
    await updates.settled("codex");
    expect(calls(log)).toEqual([`install -g --prefix ${prefix} --no-fund --no-audit @openai/codex@0.172.0`]);
    expect(updates.info("codex").run).toMatchObject({ phase: "done", installed: "0.172.0" });
    expect(readFileSync(join(world.home, "logs", "cli-update-codex.log"), "utf8")).toContain("npm_config_yes=true");
  });
  test("Claude 네이티브는 claude update, Antigravity CLI 는 agy update", async () => {
    const world = newWorld();
    const home = join(world.root, "home");
    const claudeVersion = join(world.root, "claude.version"), agyVersion = join(world.root, "agy.version");
    writeFileSync(claudeVersion, "2.1.323"); writeFileSync(agyVersion, "1.5.16");
    const claudeLog = join(world.root, "claude.calls"), agyLog = join(world.root, "agy.calls");
    script(join(home, ".local/share/claude/versions/2.1.323"), `if [ "$1" = "--version" ]; then echo "$(cat '${claudeVersion}') (Claude Code)"; exit 0; fi\necho "$*" >> '${claudeLog}'\necho "Checking for updates"\necho "Installing update..."\nprintf 2.1.332 > '${claudeVersion}'\necho "Successfully updated from 2.1.323 to version 2.1.332"`);
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    symlinkSync(join(home, ".local/share/claude/versions/2.1.323"), join(home, ".local/bin/claude"));
    const agy = script(join(world.root, "bin/agy"), `if [ "$1" = "--version" ]; then cat '${agyVersion}'; exit 0; fi\necho "$*" >> '${agyLog}'\necho "SSH_CLIENT=$SSH_CLIENT"\nprintf 1.5.17 > '${agyVersion}'\necho "Updated to 1.5.17"`);
    world.urls.set("https://downloads.claude.ai/claude-code-releases/latest", "2.1.332\n");
    world.urls.set(AGY_MANIFEST_ARM, agyBody("1.5.17"));
    const previous = process.env.SSH_CLIENT;
    process.env.SSH_CLIENT = "10.0.0.1 22 22";
    try {
      const { updates, monitor } = service(world, { claude: join(home, ".local/bin/claude"), gemini: agy }, { userHome: home });
      await monitor.refresh(true);
      await updates.check();
      expect(updates.info("claude")).toMatchObject({ method: "claude_native", latest: "2.1.332", available: true });
      expect(updates.info("gemini")).toMatchObject({ method: "agy_self", current: "1.5.16", latest: "1.5.17", available: true });
      updates.update("claude"); updates.update("gemini");
      await updates.settled("claude"); await updates.settled("gemini");
      expect(calls(claudeLog)).toEqual(["update"]);
      expect(calls(agyLog)).toEqual(["update"]);
      expect(updates.info("claude").run).toMatchObject({ phase: "done", installed: "2.1.332" });
      expect(updates.info("gemini").run).toMatchObject({ phase: "done", installed: "1.5.17" });
      // agy 에는 원격(SSH) 표시를 넘기지 않는다(키체인 대신 파일 토큰을 쓰게 된다).
      expect(readFileSync(join(world.home, "logs", "cli-update-gemini.log"), "utf8")).toContain("SSH_CLIENT=\n");
      expect(world.installed.map(([cli]) => cli).sort()).toEqual(["claude", "gemini"]);
    } finally { if (previous === undefined) delete process.env.SSH_CLIENT; else process.env.SSH_CLIENT = previous; }
  });
  test("명령이 실패하면 옛 판이 남고 까닭과 직접 할 명령을 싣는다. 적용은 부르지 않는다", async () => {
    const world = newWorld();
    const claude = brewClaude(world, "2.1.323", "2.1.332", `echo "Error: Download failed on Cask 'claude-code@latest'" >&2; exit 1`);
    world.urls.set(CASK_CLAUDE, caskBody("2.1.332"));
    const { updates, monitor } = service(world, { claude: claude.bin });
    await monitor.refresh(true);
    await updates.check();
    updates.update("claude");
    await updates.settled("claude");
    expect(updates.info("claude").run).toMatchObject({ phase: "failed", installed: null, manualCommand: "brew upgrade --cask claude-code@latest", error: { code: "cli_update_failed" } });
    expect(updates.info("claude")).toMatchObject({ current: "2.1.323", available: true });
    expect(world.installed).toEqual([]);
    expect(readFileSync(join(world.home, "logs", "cli-update-claude.log"), "utf8")).toContain("Download failed");
  });
  test("명령이 끝났는데 판이 그대로면 실패로 둔다", async () => {
    const world = newWorld();
    const claude = brewClaude(world, "2.1.323", "2.1.332", `echo "Warning: Not upgrading claude-code@latest, the latest version is already installed"; exit 0`);
    world.urls.set(CASK_CLAUDE, caskBody("2.1.332"));
    const { updates, monitor } = service(world, { claude: claude.bin });
    await monitor.refresh(true);
    await updates.check();
    updates.update("claude");
    await updates.settled("claude");
    expect(updates.info("claude").run).toMatchObject({ phase: "failed", error: { code: "cli_update_unchanged" } });
    expect(world.installed).toEqual([]);
  });
  test("암호·물음이 뜨면 기다리지 않고 멈춰 실패로 둔다. 입력은 닫혀 있다", async () => {
    const world = newWorld();
    const claude = brewClaude(world, "2.1.323", "2.1.332", `if read answer; then echo "read:$answer"; else echo "stdin closed"; fi; printf 'Password:'; sleep 30; exit 0`);
    world.urls.set(CASK_CLAUDE, caskBody("2.1.332"));
    const { updates, monitor } = service(world, { claude: claude.bin });
    await monitor.refresh(true);
    await updates.check();
    const started = Date.now();
    updates.update("claude");
    await updates.settled("claude");
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(updates.info("claude").run).toMatchObject({ phase: "failed", error: { code: "cli_update_needs_input" } });
    expect(readFileSync(join(world.home, "logs", "cli-update-claude.log"), "utf8")).toContain("stdin closed");
  });
  test("시간 제한을 넘기면 멈추고 실패로 둔다", async () => {
    const world = newWorld();
    const claude = brewClaude(world, "2.1.323", "2.1.332", `echo "==> Downloading"; sleep 30; exit 0`);
    world.urls.set(CASK_CLAUDE, caskBody("2.1.332"));
    const { updates, monitor } = service(world, { claude: claude.bin }, { runTimeoutMs: 400 });
    await monitor.refresh(true);
    await updates.check();
    updates.update("claude");
    await updates.settled("claude");
    expect(updates.info("claude").run).toMatchObject({ phase: "failed", error: { code: "cli_update_timeout" } });
  });
  test("거절: 이미 하는 중·새 판 없음·확인한 판과 다름·모르는 방식·설치 안 됨·시험 모드에서 임시 폴더 밖", async () => {
    const world = newWorld();
    const claude = brewClaude(world, "2.1.323", "2.1.332", `sleep 1; exit 1`);
    world.urls.set(CASK_CLAUDE, caskBody("2.1.332"));
    const plain = join(world.root, "plain"), plainVersion = join(world.root, "plain.version");
    writeFileSync(plainVersion, "0.166.0");
    versionScript(join(plain, "codex"), plainVersion, "codex-cli %s");
    world.urls.set(NPM_CODEX, npmBody("0.172.0"));
    // Antigravity CLI 자리에 임시 폴더 밖의 실행 파일로 가는 링크(실제 경로가 /bin 이다).
    const outside = join(world.root, "agy");
    symlinkSync("/bin/echo", outside);
    const { updates, monitor, advance } = service(world, { claude: claude.bin, codex: join(plain, "codex"), gemini: outside },
      { versions: { snapshot: () => [
        { provider: "claude", installed: true, version: "2.1.323", known: true }, { provider: "codex", installed: true, version: "0.166.0", known: true },
        { provider: "gemini", installed: true, version: "1.5.16", known: false }],
      refresh: async () => monitor.refresh(true) } });
    world.urls.set(AGY_MANIFEST_ARM, agyBody("1.5.17"));
    await updates.check();
    const code = (run: () => unknown) => { try { run(); return null; } catch (e) { return e instanceof CliUpdateError ? [e.status, e.code] : String(e); } };
    expect(code(() => updates.update("claude", "2.1.331"))).toEqual([409, "cli_update_changed"]);
    updates.update("claude", "2.1.332");
    expect(code(() => updates.update("claude"))).toEqual([409, "cli_update_running"]);
    expect(code(() => updates.update("codex"))).toEqual([409, "cli_update_unsupported"]);
    expect(code(() => updates.update("gemini"))).toEqual([503, "cli_update_test_mode"]);
    expect(code(() => updates.update("nope" as CliProvider))).toEqual([404, "cli_update_unknown_cli"]);
    await updates.settled("claude");
    world.urls.set(CASK_CLAUDE, caskBody("2.1.323"));
    advance(CLI_UPDATE_FORCE_MIN_MS);
    await updates.check(true);
    expect(code(() => updates.update("claude"))).toEqual([409, "cli_update_none"]);
    const none = service(newWorld(), {});
    expect(code(() => none.updates.update("claude"))).toEqual([409, "cli_update_not_installed"]);
    expect(await rejection(Promise.reject(new CliUpdateError(409, "cli_update_none")))).toBeInstanceOf(CliUpdateError);
  });
  test("업데이트가 끝난 뒤 다시 열기를 기다리는 팀장 수를 싣고, 그 수가 바뀌면 앱이 다시 읽게 한다", async () => {
    const world = newWorld();
    const claude = brewClaude(world, "2.1.323", "2.1.332");
    world.urls.set(CASK_CLAUDE, caskBody("2.1.332"));
    let pending = 2;
    const { updates, monitor } = service(world, { claude: claude.bin }, { reopen: cli => (cli === "claude" ? { live: 3, pending } : { live: 0, pending: 0 }), pendingPollMs: 30 });
    await monitor.refresh(true);
    await updates.check();
    expect(updates.info("claude")).toMatchObject({ liveSessions: 3 });
    expect("pendingReopen" in updates.info("claude")).toBe(false);
    updates.update("claude");
    await updates.settled("claude");
    expect(updates.info("claude")).toMatchObject({ liveSessions: 3, pendingReopen: 2 });
    const before = world.changes;
    pending = 0;
    await until("다시 읽게 함", () => world.changes > before);
    expect("pendingReopen" in updates.info("claude")).toBe(false);
  });
});

/** 한 번 쓰고 버리는 run 사본이 서비스 안의 값을 바꾸지 못한다. */
test("돌려준 진행 값은 사본이다", async () => {
  const world = newWorld();
  const claude = brewClaude(world, "2.1.323", "2.1.332");
  world.urls.set(CASK_CLAUDE, caskBody("2.1.332"));
  const { updates, monitor } = service(world, { claude: claude.bin });
  await monitor.refresh(true);
  await updates.check();
  const run: CliUpdateRun = updates.update("claude");
  run.phase = "failed";
  expect(updates.info("claude").run!.phase).not.toBe("failed");
  await updates.settled("claude");
});
