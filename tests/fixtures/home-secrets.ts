// HOME 을 시작 전에 격리한 프로세스에서 본사(cwd=홈)의 file 도구 판정을 본다. 실제 홈의 파일을 절대 건드리지 않는다.
process.env.IAMCEO_TEST = "1";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = realpathSync(process.env.HOME!);
if (realpathSync(homedir()) !== home || !home.includes("iamceo-fakehome-")) {
  console.error(`홈이 격리되지 않았습니다: ${homedir()}`);
  process.exit(99);
}
const { handleAgentTool } = await import("../../server/agent-tools.ts");
const { Bus } = await import("../../server/bus.ts");
const { loadConfig, updateConfigFile } = await import("../../server/config.ts");
const { openDb } = await import("../../server/db.ts");
const { Orchestrator } = await import("../../server/orchestrator.ts");
const { Store } = await import("../../server/store.ts");

const extended = process.argv.includes("--extended");
const env = { IAMCEO_HOME: join(home, extended ? "custom-state" : ".iamceo"), IAMCEO_PORT: "0" };
const providerHomes = { claudeHome: join(home, "actual-claude"), codexHome: join(home, "actual-codex") };
if (extended) for (const path of Object.values(providerHomes)) mkdirSync(path);

updateConfigFile({ accessCode: "code", hosts: ["127.0.0.1"], claudeBin: "/bin/false", ...(extended ? providerHomes : {}) }, env);
const config = loadConfig(env);
const store = new Store(openDb(config.dbPath), new Bus());
const orch = new Orchestrator({ config, store, runners: new Map() });
const root = store.createMember({ projectId: "hq", handle: "root", name: "본사 AI", kind: "root", origin: "runner", status: "idle" });
const files = extended ? ["project/.netrc", "project/.npmrc", "project/.bash_history", "project/fish_history", "project/id_ed25519", "project/id_ed25519_sk", "project/id_ecdsa", "project/deploy.p12", "project/deploy.pfx", ".kube/config", ".docker/config.json", "custom-state/fixture.txt", "actual-claude/fixture.txt", "actual-codex/fixture.txt", "project/plan.md"] : [".claude.json", ".zsh_history", ".codex/auth.json", ".mystery/token", "project/plan.md", "plan.md"];
const out: Record<string, boolean> = {};
for (const file of files) {
  const path = join(home, file);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "FAKE");
  const r = await handleAgentTool(orch, store.requireMember(root.id), "file", { title: file, path });
  out[file] = !!r.isError;
}
console.log(JSON.stringify(out));
process.exit(0);
