import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Member, Backend } from "../shared/types.ts";
import { memberConfig, DEFAULT_RANKS } from "../shared/types.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { MIGRATIONS, openDb } from "../server/db.ts";
import { startServer } from "../server/http.ts";
import { createOrchestrator, Orchestrator } from "../server/orchestrator.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";

class FakeCore implements Runner {
  readonly kind: Backend = "core";
  starts: RunnerMember[] = [];
  sends: string[] = [];
  stops: string[] = [];
  busy = false;
  stopError: Error | null = null;
  startError: Error | null = null;
  result: SendResult = { ok: true };
  cb: (e: RunnerEvent) => void = () => {};
  async available() { return { ok: true }; }
  async start(m: RunnerMember) { if (this.startError) throw this.startError; this.starts.push({ ...m }); return { sessionId: m.cli === "codex" ? null : m.sessionId ?? crypto.randomUUID(), paneId: `core:${this.starts.length}` }; }
  async send(_m: RunnerMember, text: string) { this.sends.push(text); return this.result; }
  isBusy() { return this.busy; }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop(m: RunnerMember) { if (this.stopError) throw this.stopError; this.stops.push(m.id); }
  async screen() { return "screen"; }
  on(cb: (e: RunnerEvent) => void) { this.cb = cb; }
  async terminalControl(_m: RunnerMember, action: { action: string }) { return action.action === "claim" ? { leaseId: "manual-lease", expiresAt: Date.now() + 300000 } : {}; }
  async shutdown() {}
}
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "iamceo-core-server-"));
  const config = loadConfig({ IAMCEO_HOME: home, IAMCEO_PORT: "0" });
  const bus = new Bus();
  const db = openDb(config.dbPath);
  const store = new Store(db, bus);
  const runner = new FakeCore();
  const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), timings: { tickMs: 60_000, healthMs: 60_000 } });
  cleanup.push(() => orch.shutdown(), () => db.close());
  const project = store.createProject({ name: "새 프로젝트", cwd: home });
  return { config, bus, db, store, runner, orch, project };
}

test("new production runs choose core despite saved legacy backend", async () => {
  const f = fixture();
  f.store.patchSettings({ backend: "herdr" });
  const production = createOrchestrator(f.config, f.store);
  cleanup.push(() => production.shutdown());
  expect(f.store.effectiveBackend()).toBe("core");
  await expect(production.updateSettings({ backend: "headless" })).rejects.toMatchObject({ status: 400 });
  expect(f.store.getSettings().backend).toBe("herdr");
});

test("chief provider persists before startup and member providers stay independent", async () => {
  const f = fixture();
  const p = await f.orch.createProject({ name: "Codex 프로젝트", cwd: f.config.home, chiefCli: "codex" });
  const chief = await f.orch.ensureConductor(p.id);
  expect(chief.cli).toBe("codex");
  expect(chief.sessionId).toBeNull();
  const worker = await f.orch.createMember(p.id, { name: "개발자", cli: "claude", modelOverride: "sonnet" });
  expect(worker).toMatchObject({ cli: "claude", modelOverride: "sonnet", backend: "core" });
  expect(f.runner.starts.map((m) => m.cli)).toEqual(["codex", "claude"]);
});

test("provider switch preserves member identity, archives old session and rotates credentials", async () => {
  const f = fixture();
  const member = await f.orch.createMember(f.project.id, { name: "개발자", role: "개발" });
  const token = f.store.getMemberToken(member.id);
  f.store.patchMember(member.id, { now: "구현 중", next: "검증" });
  const updated = await f.orch.patchMemberConfig(member.id, { cli: "codex" });
  expect(updated).toMatchObject({ id: member.id, handle: member.handle, role: "개발", cli: "codex", sessionId: null });
  expect(f.runner.stops).toEqual([member.id]);
  expect(f.runner.starts[1]).toMatchObject({ cli: "codex", sessionId: null, paneId: null });
  expect(f.store.getMemberByToken(token)).toBeNull();
  expect(f.store.getMemberToken(member.id)).not.toBe(token);
  expect(f.db.query("SELECT cli,session_id,pane_id,generation FROM member_session_history WHERE member_id=?").get(member.id)).toMatchObject({ cli: "claude", session_id: member.sessionId, pane_id: member.paneId, generation: 0 });
  expect(f.store.listPending(member.id)[0]?.text).toContain("구현 중");
  expect(f.runner.sends).toHaveLength(0);
});

test("busy or blocked provider switch never stops or changes the old session", async () => {
  const f = fixture();
  const member = await f.orch.createMember(f.project.id, { name: "개발자" });
  f.runner.busy = true;
  await expect(f.orch.patchMemberConfig(member.id, { cli: "codex" })).rejects.toMatchObject({ status: 409 });
  expect(f.store.requireMember(member.id).cli).toBe("claude");
  expect(f.runner.stops).toHaveLength(0);
  f.runner.busy = false;
  f.store.patchMember(member.id, { status: "blocked" });
  await expect(f.orch.patchMemberConfig(member.id, { cli: "codex" })).rejects.toMatchObject({ status: 409 });
});

test("failed old-session stop leaves provider and token unchanged", async () => {
  const f = fixture();
  const member = await f.orch.createMember(f.project.id, { name: "개발자" });
  const token = f.store.getMemberToken(member.id);
  f.runner.stopError = new Error("still alive");
  await expect(f.orch.patchMemberConfig(member.id, { cli: "codex" })).rejects.toThrow("still alive");
  expect(f.store.requireMember(member.id)).toMatchObject({ cli: "claude", sessionId: member.sessionId });
  expect(f.store.getMemberToken(member.id)).toBe(token);
  expect(f.runner.starts).toHaveLength(1);
});

test("recovery preserves legacy panes without treating them as core or starting work", async () => {
  const f = fixture();
  const legacy = f.store.createMember({ projectId: f.project.id, name: "이전 직원", handle: "legacy", kind: "worker", backend: "herdr", paneId: "old:p1", sessionId: crypto.randomUUID(), status: "working" });
  const delivery = f.store.enqueue({ projectId: f.project.id, memberId: legacy.id, kind: "instruction", text: "기존 입력" });
  await f.orch.recover();
  expect(f.store.requireMember(legacy.id)).toMatchObject({ backend: "herdr", paneId: "old:p1", sessionId: legacy.sessionId });
  expect(f.store.getDelivery(delivery.id)).toMatchObject({ status: "held", holdReason: "legacy_session" });
  expect(f.runner.starts).toHaveLength(0);
  expect(f.runner.sends).toHaveLength(0);
  await expect(f.orch.memberResume(legacy.id)).rejects.toMatchObject({ status: 409 });
});

test("unknown in-flight deliveries are held across repeated pumps instead of retried", async () => {
  const f = fixture();
  const member = await f.orch.createMember(f.project.id, { name: "개발자", cli: "codex" });
  const d = f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "instruction", text: "한 번만" });
  f.store.setDeliveryStatus(d.id, "delivering");
  await f.orch.recover();
  await f.orch.pump(member.id);
  expect(f.store.getDelivery(d.id)).toMatchObject({ status: "held", holdReason: "delivery_unknown" });
  expect(f.runner.sends).toHaveLength(0);
  await expect(f.orch.patchMemberConfig(member.id, { cli: "claude" })).rejects.toMatchObject({ status: 409 });
});

test("Codex never inherits Claude-specific rank models or staff settings", () => {
  expect(memberConfig({ kind: "conductor", cli: "codex", modelOverride: null, effortOverride: null }, { ...DEFAULT_RANKS, manager: { model: "opus", effort: "max" } })).toEqual({ model: null, effort: null });
});

test("idle model change resumes Claude explicitly while Codex change gets a fresh handoff", async () => {
  const f = fixture();
  const member = await f.orch.createMember(f.project.id, { name: "개발자" });
  const updated = await f.orch.patchMemberConfig(member.id, { modelOverride: "sonnet" });
  expect(updated.sessionId).toBe(member.sessionId);
  expect(f.runner.starts[1]).toMatchObject({ sessionId: member.sessionId, model: "sonnet" });
});

test("member creation and optimistic decisions use authenticated REST contracts", async () => {
  const f = fixture();
  const server = await startServer({ ...f, orch: f.orch });
  cleanup.unshift(() => server.stop());
  const call = (path: string, body: unknown) => fetch(server.urls[0] + path, { method: "POST", headers: { Authorization: `Bearer ${f.config.accessCode}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const response = await call(`/api/projects/${f.project.id}/members`, { name: "개발자", role: "개발", cli: "codex" });
  expect(response.status).toBe(200);
  const member = await response.json() as Member;
  expect(member.cli).toBe("codex");
  expect((await call(`/api/projects/${f.project.id}/members`, { name: "잘못된 직원", cli: "other" })).status).toBe(400);
  const decision = f.store.createDecision({ projectId: f.project.id, memberId: member.id, who: member.name, title: "결정", options: [{ k: "yes", label: "예" }] });
  expect((await call(`/api/decisions/${decision.id}/answer`, { choice: "yes", expectedVersion: "old" })).status).toBe(409);
});


test("pre-migration backup preserves old rows, provider and session without mutating the snapshot", () => {
  const home = mkdtempSync(join(tmpdir(), "iamceo-migration-backup-"));
  const path = join(home, "iamceo.db");
  // Build the actual historical prefix; later migrations may add dependent indexes/triggers.
  const providerMigration = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE member_session_history"));
  expect(providerMigration).toBeGreaterThan(0);
  const db = new Database(path, { create: true });
  db.exec("PRAGMA foreign_keys = ON");
  for (let v = 0; v < providerMigration; v++) db.exec(MIGRATIONS[v]!);
  db.exec(`PRAGMA user_version = ${providerMigration}`);
  const at = "2026-01-01T00:00:00.000Z";
  db.query("INSERT INTO projects (id,name,is_hq,cwd,runner_enabled,created_at,updated_at) VALUES ('hq','본사',1,?,1,?,?)").run(home, at, at);
  db.query(`INSERT INTO members (id,project_id,name,handle,kind,origin,status,cwd,backend,cli,session_id,pane_id,token,created_at,updated_at)
    VALUES ('m_legacy','hq','이전 직원','legacy','worker','runner','idle',?,'headless','codex','old-native-session','old:p7','legacy-token',?,?)`).run(home, at, at);
  db.close();
  const upgraded = openDb(path);
  const migrated = new Store(upgraded, new Bus());
  expect(migrated.requireMember("m_legacy")).toMatchObject({ cli: "codex", backend: "headless", sessionId: "old-native-session", paneId: "old:p7" });
  const backups = readdirSync(home).filter((name) => name.includes(".pre-v"));
  expect(backups).toHaveLength(1);
  expect(statSync(join(home, backups[0]!)).mode & 0o777).toBe(0o600);
  // Read the snapshot without openDb (which would itself migrate it).
  const backupPath = join(home, backups[0]!);
  const before = readFileSync(backupPath);
  const snapshot = new Database(backupPath, { readonly: true });
  expect(snapshot.query("PRAGMA user_version").get()).toEqual({ user_version: providerMigration });
  expect(snapshot.query("SELECT cli,session_id,pane_id FROM members WHERE id='m_legacy'").get()).toEqual({ cli: "codex", session_id: "old-native-session", pane_id: "old:p7" });
  expect(snapshot.query("SELECT name FROM sqlite_schema WHERE name IN ('member_session_history','delivery_recovery','push_devices')").all()).toEqual([]);
  expect(snapshot.query<{ name: string }, []>("PRAGMA table_info(members)").all().map((column) => column.name)).not.toContain("context_window");
  snapshot.close();
  expect(readFileSync(backupPath)).toEqual(before);
  upgraded.close();
});

test("human terminal control requires accessCode and whitelisted structured input", async () => {
  const f = fixture();
  const server = await startServer({ ...f, orch: f.orch });
  cleanup.unshift(() => server.stop());
  const member = await f.orch.createMember(f.project.id, { name: "개발자" });
  const call = (body: unknown, token = f.config.accessCode) => fetch(`${server.urls[0]}/api/members/${member.id}/terminal/control`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const claimed = await call({ action: "claim" });
  expect(claimed.status).toBe(200);
  expect(await claimed.json()).toMatchObject({ leaseId: "manual-lease", expiresAt: expect.any(Number) });
  expect((await call({ action: "key", leaseId: "manual-lease", key: "enter" })).status).toBe(200);
  expect((await call({ action: "key", leaseId: "manual-lease", key: "shell" })).status).toBe(400);
  expect((await call({ action: "input", text: "yes" })).status).toBe(400);
  expect((await call({ action: "claim" }, f.store.getMemberToken(member.id))).status).toBe(401);
});


test("a failed new session after a successful stop is explicit for provider and model changes", async () => {
  for (const patch of [{ cli: "codex" as const }, { modelOverride: "sonnet" }]) {
    const f = fixture();
    const member = await f.orch.createMember(f.project.id, { name: "개발자" });
    f.runner.startError = new Error("new launch failed");
    await expect(f.orch.patchMemberConfig(member.id, patch)).rejects.toThrow("new launch failed");
    expect(f.store.requireMember(member.id)).toMatchObject({ status: "error", lastError: "새 세션 시작 실패: new launch failed" });
    expect(f.runner.stops).toEqual([member.id]);
  }
});


test("explicit fresh-session recovers Codex and transfers idle legacy identity without touching its pane", async () => {
  const f = fixture();
  const member = await f.orch.createMember(f.project.id, { name: "개발자", cli: "codex" });
  const fresh = await f.orch.freshMemberSession(member.id);
  expect(fresh).toMatchObject({ id: member.id, cli: "codex", sessionId: null, backend: "core" });
  expect(f.runner.starts[1]).toMatchObject({ cli: "codex", sessionId: null, paneId: null });
  const legacy = f.store.createMember({ projectId: f.project.id, name: "이전 직원", handle: "legacy", kind: "worker", origin: "adopted", backend: "herdr", paneId: "legacy:p9", sessionId: "legacy-id", status: "offline" });
  const transferred = await f.orch.freshMemberSession(legacy.id);
  expect(transferred).toMatchObject({ id: legacy.id, origin: "runner", backend: "core" });
  expect(f.runner.stops).not.toContain(legacy.id);
  expect(f.db.query("SELECT pane_id,reason FROM member_session_history WHERE member_id=?").get(legacy.id)).toEqual({ pane_id: "legacy:p9", reason: "fresh_session" });
});


test("v2 fresh-session HTTP retries return the same receipt before generation validation", async () => {
  const f = fixture();
  const member = await f.orch.createMember(f.project.id, { name: "개발자" });
  const server = await startServer({ ...f, orch: f.orch });
  cleanup.unshift(() => server.stop());
  const operationId = crypto.randomUUID();
  const headers = { Authorization: `Bearer ${f.config.accessCode}`, "Content-Type": "application/json", "X-IAMCEO-Contract": "2" };
  const request = { operationId, expectedSessionGeneration: f.store.memberRevisions(member.id).sessionGeneration };
  const call = () => fetch(`${server.urls[0]}/api/members/${member.id}/fresh-session`, { method: "POST", headers, body: JSON.stringify(request) });
  const first = await call();
  expect(first.status).toBe(200);
  const receipt = await first.json();
  expect(receipt).toMatchObject({ status: "applied", result: { sessionGeneration: request.expectedSessionGeneration + 1 } });
  expect(await (await call()).json()).toEqual(receipt);
  const result = await fetch(`${server.urls[0]}/api/operations/${operationId}`, { headers });
  expect(await result.json()).toEqual(receipt);
  expect(f.runner.starts).toHaveLength(2);
  expect(f.runner.stops).toEqual([member.id]);
});

test("v2 member config uses reviewed revision and serializes v1 writes during provider stop", async () => {
  const f = fixture();
  const member = await f.orch.createMember(f.project.id, { name: "개발자" });
  const revision = f.store.memberRevisions(member.id).configRevision;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.runner.stop = async () => { await barrier; };
  const writing = f.orch.patchMemberConfigV2(member.id, { cli: "codex" }, { expectedRevision: revision });
  try {
    await expect(f.orch.patchMemberConfig(member.id, { effortOverride: "low" })).rejects.toMatchObject({ status: 409 });
    await expect(f.orch.patchMemberConfigV2(member.id, { modelOverride: "sonnet" }, { expectedRevision: revision })).rejects.toMatchObject({ status: 409 });
  } finally { release(); }
  const updated = await writing;
  expect(updated.member.cli).toBe("codex");
  expect(updated.configRevision).toBeGreaterThan(revision);
  await expect(f.orch.patchMemberConfigV2(member.id, { effortOverride: "max" }, { expectedRevision: revision })).rejects.toMatchObject({ status: 409, code: "REVISION_CONFLICT" });
  expect(f.store.requireMember(member.id).effortOverride).toBe(member.effortOverride);
});

test("restart converts pending fresh and direct-input operations to durable unknown without replay", async () => {
  const f = fixture();
  const member = await f.orch.createMember(f.project.id, { name: "개발자" });
  const request = { operationId: crypto.randomUUID(), expectedSessionGeneration: f.store.memberRevisions(member.id).sessionGeneration };
  f.store.beginOperation({ operationId: request.operationId, kind: "fresh_session", projectId: f.project.id, memberId: member.id, request });
  const terminalRequest = { ...request, operationId: crypto.randomUUID(), claimId: "persistent-claim", action: "key" as const, key: "enter" as const, inputSequence: 1 };
  f.store.beginOperation({ operationId: terminalRequest.operationId, kind: "terminal_control", projectId: f.project.id, memberId: member.id, request: terminalRequest });
  await f.orch.recover();
  expect((await f.orch.freshMemberSessionV2(member.id, request)).status).toBe("unknown");
  expect((await f.orch.terminalControlV2(member.id, terminalRequest)).status).toBe("unknown");
  expect(f.runner.starts).toHaveLength(1);
  expect(f.runner.stops).toHaveLength(0);
});

test("v2 stale settings and todo revisions cannot overwrite a newer value", async () => {
  const f = fixture();
  const settingsRevision = f.store.settingsRevision();
  const settings = await f.orch.updateSettingsV2({ maxConcurrentTurns: 2 }, { expectedRevision: settingsRevision });
  expect(settings.settings.maxConcurrentTurns).toBe(2);
  expect(settings.revision).toBeGreaterThan(settingsRevision);
  await expect(f.orch.updateSettingsV2({ maxConcurrentTurns: 9 }, { expectedRevision: settingsRevision })).rejects.toMatchObject({ status: 409 });
  const todo = f.store.createTodo({ projectId: f.project.id, title: "검토" });
  const revision = f.store.todoRevision(todo.id);
  const changed = await f.orch.setTodoDoneV2(todo.id, { done: true }, { expectedRevision: revision });
  expect(changed.todo.done).toBe(true);
  await expect(f.orch.setTodoDoneV2(todo.id, { done: false }, { expectedRevision: revision })).rejects.toMatchObject({ status: 409 });
  expect(f.store.requireTodo(todo.id).done).toBe(true);
});

test("Codex rank precedence resolves each leaf independently and keeps Claude isolated", () => {
  const ranks = { ...DEFAULT_RANKS, manager: { model: "opus", effort: "max" as const }, lead: { model: "sonnet", effort: "high" as const } };
  const codexRanks = { ...DEFAULT_RANKS, manager: { model: "gpt-6.1-sol", effort: "xhigh" as const }, lead: { model: "gpt-6-luna", effort: "low" as const } };
  const worker = { kind: "worker" as const, cli: "codex" as const, modelOverride: null, effortOverride: null };
  expect(memberConfig(worker, ranks, DEFAULT_RANKS)).toEqual({ model: null, effort: null });
  expect(memberConfig(worker, ranks, codexRanks)).toEqual(codexRanks.lead);
  expect(memberConfig({ ...worker, kind: "conductor" }, ranks, codexRanks)).toEqual(codexRanks.manager);
  expect(memberConfig({ ...worker, kind: "root" }, ranks, codexRanks)).toEqual(codexRanks.manager);
  expect(memberConfig({ ...worker, modelOverride: "gpt-6-astra" }, ranks, codexRanks)).toEqual({ model: "gpt-6-astra", effort: "low" });
  expect(memberConfig({ ...worker, effortOverride: "minimal" }, ranks, codexRanks)).toEqual({ model: "gpt-6-luna", effort: "minimal" });
  expect(memberConfig({ ...worker, modelOverride: "gpt-6-astra", effortOverride: "high" }, ranks, codexRanks)).toEqual({ model: "gpt-6-astra", effort: "high" });
  expect(memberConfig({ ...worker, cli: "claude" }, ranks, codexRanks)).toEqual(ranks.lead);
});

test("Codex ranks merge persisted partial values, patch only leaves, survive legacy saves and never fill efforts", () => {
  const f = fixture();
  expect(f.store.getSettings().codexRanks).toEqual(DEFAULT_RANKS);
  f.db.query("INSERT INTO settings(key,value) VALUES (?,?)").run("codexRanks", JSON.stringify({ lead: { model: "gpt-6-luna" } }));
  expect(f.store.getSettings().codexRanks).toEqual({ ...DEFAULT_RANKS, lead: { model: "gpt-6-luna", effort: null } });
  f.store.fillRankEfforts("high");
  expect(f.store.getSettings().codexRanks.lead.effort).toBeNull();
  f.store.patchSettings({ codexRanks: { lead: { effort: "low" }, staff: { model: "gpt-6.1-terra", effort: "minimal" } } });
  const saved = f.store.getSettings().codexRanks;
  expect(saved.lead).toEqual({ model: "gpt-6-luna", effort: "low" });
  const { codexRanks: _omitted, ...legacy } = f.store.getSettings();
  f.store.patchSettings(legacy);
  expect(new Store(f.db, f.bus).getSettings().codexRanks).toEqual(saved);
  expect(f.store.patchSettings({ codexRanks: { lead: { model: null } } }).codexRanks.lead).toEqual({ model: null, effort: "low" });
  expect(f.store.getSettings().codexRanks.staff).toEqual(saved.staff);
});

test("Codex startup and roster use their own ranks and staff model while staff effort is stored only", async () => {
  const f = fixture();
  f.store.patchSettings({ ranks: { lead: { model: "sonnet", effort: "high" }, staff: { model: "haiku", effort: "low" } }, codexRanks: { manager: { model: "gpt-6.1-sol", effort: "medium" }, lead: { model: "gpt-6-luna", effort: "low" }, staff: { model: "gpt-6.1-terra", effort: "minimal" } } });
  const chiefProject = await f.orch.createProject({ name: "Codex 총괄", cwd: f.config.home, chiefCli: "codex" });
  await f.orch.ensureConductor(chiefProject.id);
  expect(f.runner.starts.at(-1)).toMatchObject({ model: "gpt-6.1-sol", effort: "medium", subagentModel: "gpt-6.1-terra" });
  const codex = await f.orch.createMember(f.project.id, { name: "Codex 팀장", cli: "codex" });
  expect(f.runner.starts.at(-1)).toMatchObject({ model: "gpt-6-luna", effort: "low", subagentModel: "gpt-6.1-terra" });
  expect(f.store.getAppliedConfig(codex.id)).toMatchObject({ model: "gpt-6-luna", effort: "low", staffModel: "gpt-6.1-terra", staffEffort: null });
  const claude = await f.orch.createMember(f.project.id, { name: "Claude 팀장", cli: "claude" });
  expect(f.runner.starts.at(-1)).toMatchObject({ model: "sonnet", effort: "high", subagentModel: "haiku" });
  expect(f.orch.roster(f.project.id).find(m => m.handle === codex.handle)).toMatchObject({ model: "gpt-6-luna", effort: "low", subagentModel: "gpt-6.1-terra", subagentEffort: null });
  expect(f.orch.roster(f.project.id).find(m => m.handle === claude.handle)).toMatchObject({ model: "sonnet", effort: "high", subagentModel: "haiku", subagentEffort: "low" });
});

test("Codex rank HTTP validation, legacy save, v2 CAS and all settings responses preserve the new field", async () => {
  const f = fixture();
  const server = await startServer({ ...f, orch: f.orch });
  cleanup.unshift(() => server.stop());
  const headers = { Authorization: `Bearer ${f.config.accessCode}`, "Content-Type": "application/json" };
  const put = (body: unknown, extra = {}) => fetch(`${server.urls[0]}/api/settings`, { method: "PUT", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const saved = await put({ codexRanks: { lead: { model: "gpt-6-luna", effort: "minimal" } } });
  expect(saved.status).toBe(200);
  expect((await saved.json()).codexRanks.lead).toEqual({ model: "gpt-6-luna", effort: "minimal" });
  for (const value of ["max", "auto", "", "HIGH"]) expect((await put({ codexRanks: { lead: { effort: value } } })).status).toBe(400);
  for (const model of ["", " ", "--model", "bad model"]) expect((await put({ codexRanks: { lead: { model } } })).status).toBe(400);
  expect((await put({ codexRanks: { lead: { extra: true } } })).status).toBe(400);
  expect((await put({ codexRanks: { other: {} } })).status).toBe(400);
  expect((await put({ ranks: { lead: { effort: "max" } } })).status).toBe(200);
  expect((await put({ ranks: { lead: { effort: "minimal" } } })).status).toBe(400);
  const revision = f.store.settingsRevision();
  const v2headers = { "X-IAMCEO-Contract": "2", "If-Match": `"${revision}"` };
  const v2 = await put({ codexRanks: { lead: { effort: "low" } } }, v2headers);
  expect(v2.status).toBe(200);
  expect(await v2.json()).toMatchObject({ settings: { codexRanks: { lead: { model: "gpt-6-luna", effort: "low" } } }, revision: revision + 1 });
  expect((await put({ codexRanks: { lead: { model: null } } }, v2headers)).status).toBe(409);
  const { codexRanks: _omitted, ...legacy } = f.store.getSettings();
  expect((await put(legacy)).status).toBe(200);
  const bootstrap = await (await fetch(`${server.urls[0]}/api/bootstrap`, { headers })).json();
  expect(bootstrap.settings.codexRanks.lead).toEqual({ model: "gpt-6-luna", effort: "low" });
  const sync = await (await fetch(`${server.urls[0]}/api/sync`, { headers })).json();
  expect(sync.bootstrap.settings.codexRanks).toEqual(f.store.getSettings().codexRanks);
  const pending = f.store.beginOperation({ operationId: crypto.randomUUID(), kind: "settings", projectId: null, memberId: null, request: {} });
  if (pending.status !== "pending") throw new Error("expected pending settings operation");
  f.store.finishOperation({ ...pending, kind: "settings", status: "applied", result: { settings: f.store.getSettings(), revision: f.store.settingsRevision() } });
  const receipt = await (await fetch(`${server.urls[0]}/api/operations/${pending.operationId}`, { headers: { ...headers, "X-IAMCEO-Contract": "2" } })).json();
  expect(receipt.result.settings.codexRanks).toEqual(f.store.getSettings().codexRanks);
});

test("Codex rank updates preserve a running turn and apply on its next fresh launch", async () => {
  const f = fixture();
  const member = await f.orch.createMember(f.project.id, { name: "Codex", cli: "codex" });
  f.runner.busy = true;
  f.store.patchMember(member.id, { status: "working" });
  await f.orch.updateSettings({ codexRanks: { lead: { model: "gpt-6-luna", effort: "low" } } });
  expect(f.runner.stops).toHaveLength(0);
  expect(f.runner.starts).toHaveLength(1);
  f.runner.busy = false;
  f.store.patchMember(member.id, { status: "idle" });
  await f.orch.freshMemberSession(member.id);
  expect(f.runner.starts.at(-1)).toMatchObject({ model: "gpt-6-luna", effort: "low" });
});


test("member effort HTTP uses the same Codex effort choices and keeps Claude validation", async () => {
  const f = fixture();
  const codex = f.store.createMember({ projectId: f.project.id, name: "Codex", handle: "codex", kind: "worker", cli: "codex" });
  const claude = f.store.createMember({ projectId: f.project.id, name: "Claude", handle: "claude", kind: "worker", cli: "claude" });
  const server = await startServer({ ...f, orch: f.orch });
  cleanup.unshift(() => server.stop());
  const patch = (id: string, effortOverride: string) => fetch(`${server.urls[0]}/api/members/${id}`, { method: "PATCH", headers: { Authorization: `Bearer ${f.config.accessCode}`, "Content-Type": "application/json" }, body: JSON.stringify({ effortOverride }) });
  expect((await patch(codex.id, "minimal")).status).toBe(200);
  expect((await patch(codex.id, "max")).status).toBe(400);
  expect((await patch(claude.id, "minimal")).status).toBe(400);
  expect((await patch(claude.id, "max")).status).toBe(200);
});
