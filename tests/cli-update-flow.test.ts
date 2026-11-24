// 0.2.11: 서버가 쥐는 CLI 업데이트 서비스(serverCliUpdates — startServer 가 쓰는 것과 같은 조립)를 처음부터 끝까지.
// 새 판 확인 → 스냅샷의 cliUpdates → iPhone 푸시 사건 → 앱이 누른 업데이트(가짜 brew) → 진행마다 projects 사건 → 판 다시 읽기 → 적용 세대 → 푸시 거둠.
// 공개 주소는 주입한 답으로, brew 는 임시 폴더의 가짜 스크립트로. 이 Mac 의 진짜 CLI·brew·네트워크는 쓰지 않는다.
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Bus } from "../server/bus.ts";
import { CliVersionMonitor } from "../server/cli-version.ts";
import { loadConfig, updateConfigFile, type Config } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { serverCliUpdates, startServer, type RunningServer, type ServerContext } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { PushStore } from "../server/push/store.ts";
import { Store } from "../server/store.ts";
import { DEFAULT_PUSH_BUNDLE_ID } from "../shared/push.ts";
import type { CliUpdateInfo, CliUpdateRun, SyncSnapshot, WsEvent } from "../shared/types.ts";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function script(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

test("새 판 확인부터 업데이트·적용까지(가짜 brew, 실제 서버 조립)", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-cli-update-flow-")));
  const prefix = join(root, "homebrew"), brewLog = join(root, "brew.calls");
  script(join(prefix, "Caskroom/claude-code@latest/2.1.331/claude"), `[ "$1" = "--version" ] && echo "2.1.331 (Claude Code)" && exit 0\nexit 9`);
  mkdirSync(join(prefix, "bin"), { recursive: true });
  symlinkSync(join(prefix, "Caskroom/claude-code@latest/2.1.331/claude"), join(prefix, "bin/claude"));
  script(join(prefix, "bin/brew"), `echo "$*" >> '${brewLog}'
[ "$1" = "update" ] && exit 0
sleep 0.3
echo "==> Downloading https://downloads.claude.ai/claude-code-releases/2.1.332/darwin-arm64/claude"
sleep 0.3
echo "==> Upgrading 1 outdated package:"
sleep 0.5
mkdir -p '${prefix}/Caskroom/claude-code@latest/2.1.332'
cat > '${prefix}/Caskroom/claude-code@latest/2.1.332/claude' <<'NEW'
#!/bin/sh
[ "$1" = "--version" ] && echo "2.1.332 (Claude Code)" && exit 0
exit 9
NEW
chmod +x '${prefix}/Caskroom/claude-code@latest/2.1.332/claude'
ln -sfn '${prefix}/Caskroom/claude-code@latest/2.1.332/claude' '${prefix}/bin/claude'
echo "claude-code@latest was successfully upgraded!"`);

  const env = { IAMCEO_HOME: join(root, "iamceo"), IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code" }, env);
  const config: Config = { ...loadConfig(env), hosts: ["127.0.0.1"], claudeBin: join(prefix, "bin/claude"), codexBin: join(root, "no-codex") };
  const bus = new Bus(), store = new Store(openDb(config.dbPath), bus);
  const providers = () => [{ environment: "sandbox" as const, bundleId: DEFAULT_PUSH_BUNDLE_ID, state: "ready" as const, lastError: null }];
  const push = new PushStore(store.db, { providers });
  const device = push.registerDevice(randomUUID(), { expectedRevision: null, platform: "ios", bundleId: DEFAULT_PUSH_BUNDLE_ID, environment: "sandbox", deviceToken: "ab", authorization: "authorized" });
  push.patchDevice(device.id, { expectedRevision: device.revision, enabled: true });
  const orch = new Orchestrator({ config, store, runners: new Map(), notifier: () => {} });
  const versions = new CliVersionMonitor({ claudeBin: config.claudeBin, codexBin: config.codexBin, geminiBin: null, recheckMs: 0 });
  const ctx: ServerContext = { config, store, bus, orch, detectHosts: () => [], cliVersions: versions, push: { store: push, providers } };
  const fetched: string[] = [];
  const updates = serverCliUpdates(ctx, versions, {
    fetchText: async url => { fetched.push(url); return url === "https://formulae.brew.sh/api/cask/claude-code@latest.json" ? JSON.stringify({ version: "2.1.332" }) : null; },
    userHome: join(root, "home") });
  ctx.cliUpdates = updates;
  let server: RunningServer = await startServer(ctx);
  while (server.port === 7878) { await server.stop(); server = await startServer(ctx); }
  cleanups.push(async () => { await updates.stop(); await server.stop(); await orch.shutdown(); store.db.close(); });
  const call = async <T>(path: string, init: RequestInit = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { ...init, headers: { Authorization: "Bearer code", "Content-Type": "application/json" } });
    return { status: response.status, body: await response.json() as T };
  };
  const events: WsEvent[] = [];
  cleanups.push(bus.subscribe(event => { events.push(event as WsEvent); }));

  // 1. 새 판 확인: 스냅샷에 실리고, 판마다 한 번 iPhone 푸시 사건이 생긴다.
  await versions.refresh(true);
  await call("/api/cli-updates?refresh=1");
  expect(fetched).toEqual(["https://formulae.brew.sh/api/cask/claude-code@latest.json"]);
  const before = (await call<SyncSnapshot>("/api/sync")).body.bootstrap.cliUpdates!;
  expect(before).toEqual([expect.objectContaining({ cli: "claude", current: "2.1.331", latest: "2.1.332", available: true, method: "brew_cask", oneClick: true, liveSessions: 0 })]);
  const notice = push.listEvents().find(e => e.kind === "cli_update")!;
  expect(notice).toMatchObject({ sourceKey: "cli-update:claude:2.1.332", target: { screen: "home", cli: "claude", version: "2.1.332" } });
  expect(push.listDeliveries(notice.id).map(d => d.state)).toEqual(["queued"]);

  // 2. 앱이 확인 창에서 본 판으로 누른다. 진행이 바뀔 때마다 projects 사건이 나가 앱이 스냅샷을 다시 읽는다.
  const projectsBefore = events.filter(e => e.type === "projects").length;
  const started = await call<CliUpdateRun>("/api/cli-updates/claude", { method: "POST", body: JSON.stringify({ to: "2.1.332" }) });
  expect(started.status).toBe(202);
  const again = await call<{ code: string }>("/api/cli-updates/claude", { method: "POST", body: JSON.stringify({ to: "2.1.332" }) });
  expect(again.body.code).toBe("cli_update_running");
  const seen = new Set<string>();
  let info: CliUpdateInfo;
  for (const end = Date.now() + 15_000; ; await Bun.sleep(50)) {
    info = (await call<SyncSnapshot>("/api/sync")).body.bootstrap.cliUpdates![0]!;
    if (info.run) seen.add(info.run.phase);
    if (info.run?.phase === "done" || info.run?.phase === "failed" || Date.now() > end) break;
  }
  expect(info.run).toMatchObject({ phase: "done", from: "2.1.331", to: "2.1.332", installed: "2.1.332", error: null });
  expect([...seen]).toContain("installing");
  expect(info).toMatchObject({ current: "2.1.332", available: false });
  expect(events.filter(e => e.type === "projects").length - projectsBefore).toBeGreaterThanOrEqual(3);
  expect(readFileSync(brewLog, "utf8").trim().split("\n")).toEqual(["update --quiet", "upgrade --cask claude-code@latest"]);
  expect(existsSync(join(config.home, "logs", "cli-update-claude.log"))).toBe(true);

  // 3. 적용: Claude 업데이트 세대가 올랐고(떠 있는 팀장은 쉬는 때에 같은 대화로 다시 열린다), 그 판의 아직 안 나간 알림은 거뒀다.
  await Bun.sleep(100);
  expect(store.loadApiRecovery<Record<string, number>>("cli_update_epochs")).toEqual({ claude: 1 });
  expect(push.listDeliveries(notice.id).map(d => d.state)).toEqual(["cancelled"]);
  // 같은 판은 다시 알리지 않는다.
  await call("/api/cli-updates?refresh=1");
  expect(push.listEvents().filter(e => e.kind === "cli_update")).toHaveLength(1);
}, 30_000);
