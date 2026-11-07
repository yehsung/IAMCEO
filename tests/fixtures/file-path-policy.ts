// This subprocess must start with a temporary HOME. Never inspect real secrets.
process.env.IAMCEO_TEST = "1";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { additionalSecretFiles, allowedProjectFiles, fixturePNG, headSecretFiles, homeSecretPaths, nestedSecretFiles, projectArtifactFiles, relocatedSecretPaths } from "./secret-path-cases.ts";

const home = realpathSync(process.env.HOME!);
assert(home.includes("iamceo-fakehome-") && realpathSync(homedir()) === home, "HOME must be isolated");
const { handleAgentTool } = await import("../../server/agent-tools.ts");
const { Bus } = await import("../../server/bus.ts");
const { loadConfig, updateConfigFile } = await import("../../server/config.ts");
const { openDb } = await import("../../server/db.ts");
const { readLocalFile, checkLocalImportPath } = await import("../../server/local-files.ts");
const { Orchestrator } = await import("../../server/orchestrator.ts");
const { Store } = await import("../../server/store.ts");
const env = { IAMCEO_HOME: join(home, "state"), IAMCEO_PORT: "0" };
updateConfigFile({ accessCode: "code", hosts: ["127.0.0.1"], claudeBin: "/bin/false" }, env);
const config = loadConfig(env), store = new Store(openDb(config.dbPath), new Bus());
const orch = new Orchestrator({ config, store, runners: new Map() });
const work = join(home, "project"); mkdirSync(work);
const project = store.createProject({ name: "policy", cwd: work });
const member = store.createMember({ projectId: project.id, handle: "worker", name: "직원", kind: "worker", cwd: work });
let allowed = 0, blocked = 0;
async function check(path: string, deny: boolean, projectId = project.id, employee = member) {
  const result = await handleAgentTool(orch, store.requireMember(employee.id), "file", { title: "fixture", path });
  assert.equal(!!result.isError, deny, `employee: ${path}: ${result.text}`);
  if (deny) {
    assert.match(result.text, /비밀이 있는 곳/);
    assert.throws(() => readLocalFile(store, projectId, path, home, orch.protectedFileRoots), { status: 403 });
    assert.throws(() => checkLocalImportPath(resolve(store.requireProject(projectId).cwd, path), home, orch.protectedFileRoots), { status: 403 });
    blocked++;
  } else {
    const local = readLocalFile(store, projectId, path, home, orch.protectedFileRoots);
    if (path.endsWith(".png")) assert.deepEqual(local.bytes, fixturePNG);
    else assert.equal(local.info.content, "safe fixture");
    checkLocalImportPath(resolve(store.requireProject(projectId).cwd, path), home, orch.protectedFileRoots);
    allowed++;
  }
}
for (const name of [...headSecretFiles, ...additionalSecretFiles, ...allowedProjectFiles]) {
  const path = join(work, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "safe fixture");
  await check(name, !allowedProjectFiles.includes(name));
}
for (const name of [...projectArtifactFiles, ...nestedSecretFiles]) {
  const path = join(work, name); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, name.endsWith(".png") ? fixturePNG : "safe fixture");
  await check(name, nestedSecretFiles.includes(name));
}
const homeProject = store.createProject({ name: "home workspace", cwd: home });
const homeMember = store.createMember({ projectId: homeProject.id, handle: "worker", name: "직원", kind: "worker", cwd: home });
for (const name of homeSecretPaths) {
  const path = join(home, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "fixture-only secret");
  await check(name, true, homeProject.id, homeMember);
}
// An unlisted dot directory exercises homeDot, independently of SECRET_DIRS.
const homeDot = join(home, ".mystery", "token"); mkdirSync(dirname(homeDot)); writeFileSync(homeDot, "fixture-only secret");
const homeDotResult = await handleAgentTool(orch, homeMember, "file", { title: "fixture", path: homeDot });
assert.equal(homeDotResult.isError, true); assert.match(homeDotResult.text, /비밀이 있는 곳/);
const nestedArtifact = join(home, "check/.claude/mocks/a.png");
mkdirSync(dirname(nestedArtifact), { recursive: true }); writeFileSync(nestedArtifact, fixturePNG);
await check("check/.claude/mocks/a.png", false, homeProject.id, homeMember);
const history = join(home, "history"); mkdirSync(history);
const historyProject = store.createProject({ name: "history", cwd: history });
const report = join(history, "report.md"); writeFileSync(report, "safe fixture");
const historyMember = store.createMember({ projectId: historyProject.id, handle: "worker", name: "직원", kind: "worker", cwd: history });
await check("report.md", false, historyProject.id, historyMember);
// The orchestrator predates these symlinks: roots must refresh on each check.
const relocated = relocatedSecretPaths(home, work);
for (const path of relocated) await check(path, true);
// Lexical secret names must also reject a link whose canonical target is safe.
const namedSecret = join(work, ".env.alias"); symlinkSync(report, namedSecret);
await check(namedSecret, true);
console.log(JSON.stringify({ allowed, blocked, head: headSecretFiles.length, relocated: relocated.length, homeDotBlocked: 1 }));
store.db.close();
process.exit(0);
