import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, liteEvent } from "../server/http.ts";
import { Orchestrator, formatTodoDone } from "../server/orchestrator.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult, StartOpts } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import { csvRows, readLocalFile } from "../server/local-files.ts";
import { ARTIFACT_CSP } from "../shared/artifact-kit.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";
import { renderRole } from "../server/roles.ts";
class ApiRunner implements Runner {
  readonly kind = "core" as const;
  starts: { member: RunnerMember; resume: boolean }[] = [];
  stops: string[] = [];
  sent: { id: string; text: string }[] = [];
  busy = new Set<string>();
  probes = 0;
  startGate: (() => Promise<void>) | null = null;
  sendGate: (() => Promise<SendResult>) | null = null;
  callback: (event: RunnerEvent) => void = () => {};
  async available() { this.probes++; return { ok: true }; }
  async start(member: RunnerMember, opts: StartOpts) {
    this.starts.push({ member, resume: !!opts.resume });
    await this.startGate?.();
    return { sessionId: member.sessionId ?? `native-${member.id}`, paneId: `pane-${member.id}` };
  }
  async send(member: RunnerMember, text: string): Promise<SendResult> {
    this.sent.push({ id: member.id, text }); this.busy.add(member.id);
    return this.sendGate ? this.sendGate() : { ok: true, started: true, turn: 0 };
  }
  isBusy(id: string) { return this.busy.has(id); }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async applyConfig(): Promise<SendResult> { throw new Error("core configuration must use managed resume"); }
  async stop(member: RunnerMember) { this.stops.push(member.id); this.busy.delete(member.id); }
  async interrupt() {}
  async screen() { return ""; }
  async shutdown() {}
  on(callback: (event: RunnerEvent) => void) { this.callback = callback; }
  end(store: Store, id: string, turn = 1, errorText?: string) {
    const member = store.requireMember(id); this.busy.delete(id);
    this.callback({ type: "turn_end", memberId: id, terminalId: member.paneId, sessionGeneration: store.memberRevisions(id).sessionGeneration, turn, finalText: "", isError: !!errorText, ...(errorText ? { errorText } : {}) });
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture() {
  const isolated = createIsolatedRuntime();
  const config = loadConfig({ IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: isolated.socketPath, IAMCEO_HERDR_SOCKET: isolated.herdrSocketPath,
    IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin });
  const db = openDb(config.dbPath), bus = new Bus(), store = new Store(db, bus), runner = new ApiRunner();
  store.patchSettings({ boardTidyHours: 0 });
  const cwd = join(isolated.paths.home, "work"); mkdirSync(cwd);
  const project = store.createProject({ name: "UX-T2", cwd });
  const calls: string[] = [];
  const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), notifier: (title, body) => { calls.push(title + body); }, timings: { tickMs: 60_000, healthMs: 60_000 } });
  let n = 0;
  function member(kind: "conductor" | "worker" = "worker") {
    n++;
    return store.createMember({ projectId: project.id, kind, handle: `m${n}`, name: `직원 ${n}`, cwd, origin: "runner", backend: "core", status: "idle", sessionId: `native-${n}`, paneId: `pane-${n}` });
  }
  async function http() {
    const server = await startServer({ config, store, bus, orch, delivery: orch.deliveryRecovery, folderHome: isolated.paths.home });
    expect(server.port).not.toBe(7878);
    cleanups.push(async () => { await server.stop(); });
    const url = `http://127.0.0.1:${server.port}`;
    const request = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST", headers: Record<string, string> = {}) => fetch(url + path, {
      method, headers: { Authorization: `Bearer ${config.accessCode}`, "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { request, url };
  }
  cleanups.push(async () => { await orch.shutdown(); db.close(); await isolated.stop(); });
  return { isolated, config, db, bus, store, runner, project, cwd, orch, member, http, calls };
}

test("needsCount includes permission, selection, errors and owner delivery attention without changing legacy counts", () => {
  const f = fixture(), permission = f.member(), selection = f.member(), error = f.member();
  f.store.patchMember(permission.id, { status: "blocked", blockedReason: "permission" });
  f.store.patchMember(selection.id, { status: "blocked", blockedReason: "selection" });
  f.store.patchMember(error.id, { status: "error" });
  f.store.createDecision({ projectId: f.project.id, who: "직원", title: "열린 결재" });
  f.store.createTodo({ projectId: f.project.id, title: "대표 할 일" });
  const delivery = f.store.enqueue({ projectId: f.project.id, memberId: permission.id, kind: "instruction", text: "작업" });
  f.store.updateDeliveryRecovery(delivery.id, 1, { phase: "needs_owner", reason: "log_missing" });
  let summary = f.store.projectSummaries().find(p => p.id === f.project.id)!;
  expect(summary.needsCount).toBe(6); expect(summary.needsDanger).toBe(true);
  expect(summary.inboxCount).toBe(2); expect(summary.blockedCount).toBe(1); expect(summary.errorCount).toBe(1);
  f.store.updateDeliveryRecovery(delivery.id, 2, { phase: "stopped" });
  summary = f.store.projectSummaries().find(p => p.id === f.project.id)!;
  expect(summary.needsCount).toBe(5);
  f.store.patchMember(error.id, { status: "idle" });
  expect(f.store.projectSummaries().find(p => p.id === f.project.id)!.needsDanger).toBe(false);
});

test("explicit corrections expose both directions and all report files; reject foreign authors and branches", async () => {
  const f = fixture(), worker = f.member(), other = f.member();
  const a = f.store.createFile({ projectId: f.project.id, title: "첫 자료", body: "one" });
  const b = f.store.createFile({ projectId: f.project.id, title: "둘째 자료", body: "two" });
  const first = await f.orch.recordPost(worker, { kind: "완료", title: "보고", fileIds: [a.id, b.id] });
  expect(first.fileId).toBe(a.id); expect(first.fileIds).toEqual([a.id, b.id]);
  const next = await f.orch.recordPost(worker, { kind: "완료", title: "정정", supersedes: first.id, fileIds: [b.id, a.id] });
  expect(next.supersedes).toBe(first.id); expect(next.fileIds).toEqual([b.id, a.id]);
  expect(f.store.requireMessage(first.id).supersededBy).toBe(next.id);
  expect(f.store.listMessagePage(f.project.id).items.find(m => m.id === next.id)!.supersedes).toBe(first.id);
  await expect(f.orch.recordPost(other, { kind: "완료", title: "남의 보고", supersedes: next.id })).rejects.toThrow();
  const count = f.store.listMessages(f.project.id).length;
  await expect(f.orch.recordPost(worker, { kind: "완료", title: "분기", supersedes: first.id })).rejects.toThrow();
  expect(f.store.listMessages(f.project.id).length).toBe(count);
  const old = f.store.createMessage({ projectId: f.project.id, kind: "완료", fileId: a.id, body: `[자료](#/p/${f.project.id}/files/${b.id})` });
  expect(f.store.requireMessage(old.id).fileIds).toEqual([a.id, b.id]);
});

test("todo completion preserves exact owner note, uploaded attachments, quote evidence and v2 revision", async () => {
  const f = fixture(), conductor = f.member("conductor"), worker = f.member();
  const attachment = f.store.createAttachment({ id: "a_fixture", path: "fixture.txt", name: "fixture.txt", mime: "text/plain", size: 4 });
  const todo = f.store.createTodo({ projectId: f.project.id, memberId: worker.id, title: "파일 확인" });
  const note = "  대표 답 원문\n줄바꿈 · 이 글 전체를 보존합니다.  ";
  const result = await f.orch.setTodoDoneV2(todo.id, { done: true, note, fileIds: [attachment.id] }, { expectedRevision: f.store.todoRevision(todo.id) });
  expect(result.todo.completionNote).toBe(note); expect(result.todo.completionFileIds).toEqual([attachment.id]);
  expect(f.orch.findQuoteSource(f.project.id, note)?.text).toBe(note);
  const notifications = f.store.listDeliveries(f.project.id).filter(d => d.refId === todo.id);
  expect(notifications.some(d => d.memberId === conductor.id && d.text.includes(note) && d.text.includes(attachment.id))).toBe(true);
  expect(formatTodoDone(result.todo)).toContain(note);
  await expect(f.orch.setTodoDoneV2(todo.id, { done: false }, { expectedRevision: result.revision - 1 })).rejects.toThrow();
  await f.orch.setTodoDone(todo.id, false);
  expect(f.store.requireTodo(todo.id).completionNote).toBeNull();
  expect(f.orch.findQuoteSource(f.project.id, note)).toBeNull();
  await expect(f.orch.setTodoDone(todo.id, true, { fileIds: ["missing"] })).rejects.toThrow();
  expect(f.store.requireTodo(todo.id).done).toBe(false);
});

test("message context is persisted separately from owner original and forwarded to conductor", async () => {
  const f = fixture(), conductor = f.member("conductor");
  const file = f.store.createFile({ projectId: f.project.id, title: "검토 자료", body: "내용" });
  const legacy = f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: "기존 지시" });
  const legacyDelivery = f.store.enqueue({ projectId: f.project.id, memberId: conductor.id, kind: "user_message", text: "기존 지시", refType: "message", refId: legacy.id });
  const oldRevision = createHash("sha256").update(JSON.stringify({ id: legacy.id, body: legacy.body, title: legacy.title, attachments: legacy.attachments, targetMemberId: legacy.targetMemberId, memberId: conductor.id })).digest("hex");
  expect(f.orch.deliveryRecovery.sourceRevision(legacyDelivery)).toBe(oldRevision);
  const original = "이 자료를 확인해 주세요\n대표 원문입니다";
  const message = await f.orch.sendUserMessage(f.project.id, { text: original, contextFileId: file.id });
  expect(message.body).toBe(original); expect(message.contextFileId).toBe(file.id);
  expect(f.store.listDeliveries(f.project.id).find(d => d.memberId === conductor.id && d.refId === message.id)!.text).toContain(`대표가 보던 자료: 검토 자료 (${file.id})`);
  expect(f.orch.findQuoteSource(f.project.id, "대표가 보던 자료: 검토 자료")).toBeNull();
  const other = f.store.createProject({ name: "다른 프로젝트", cwd: f.cwd });
  const foreign = f.store.createFile({ projectId: other.id, title: "외부 자료" });
  await expect(f.orch.sendUserMessage(f.project.id, { text: "확인", contextFileId: foreign.id })).rejects.toThrow();
});

test("lite state/sync omit body while full state and file detail remain compatible", async () => {
  const f = fixture(), { request } = await f.http();
  const file = f.store.createFile({ projectId: f.project.id, title: "큰 자료", body: "본문".repeat(10000) });
  const full = await (await request(`/api/projects/${f.project.id}/state`)).json();
  const lite = await (await request(`/api/projects/${f.project.id}/state?lite=1`)).json();
  expect(full.files[0].body).toBe(file.body); expect(lite.files[0].body).toBeUndefined(); expect(lite.files[0].title).toBe(file.title);
  expect((await (await request(`/api/files/${file.id}`)).json()).body).toBe(file.body);
  const sync = await (await request(`/api/sync?projectId=${f.project.id}&lite=1`)).json();
  expect(sync.state.files[0].body).toBeUndefined();
  expect((await request(`/api/projects/${f.project.id}/state?lite=bogus`)).status).toBe(400);
});

test("lite WebSocket file events preserve cursor and metadata and omit body", async () => {
  const f = fixture(), { url } = await f.http();
  const file = f.store.createFile({ projectId: f.project.id, title: "자료", body: "큰 본문" });
  expect((liteEvent({ type: "file", file }) as { file: object }).file).not.toHaveProperty("body");
  const AuthenticatedWebSocket = WebSocket as typeof WebSocket & { new(url: string, options: Bun.WebSocketOptions): WebSocket };
  const ws = new AuthenticatedWebSocket(url.replace("http:", "ws:") + "/ws?v=2&lite=1", { headers: { Authorization: `Bearer ${f.config.accessCode}` } });
  cleanups.push(async () => { ws.close(); });
  const events: any[] = [];
  await new Promise<void>((resolve, reject) => { ws.onmessage = e => { events.push(JSON.parse(String(e.data))); resolve(); }; ws.onerror = reject; });
  const received = new Promise<void>(resolve => { ws.onmessage = e => { events.push(JSON.parse(String(e.data))); resolve(); }; });
  f.bus.emit({ type: "file", file }); await received;
  expect(events.at(-1).file.body).toBeUndefined(); expect(events.at(-1).file.id).toBe(file.id);
  expect(events.at(-1).epoch).toBe(f.bus.epoch); expect(events.at(-1).seq).toBe(f.bus.seq);
});

test("same-path publication reuses identical text/HTML/binary but creates changed snapshots", async () => {
  const f = fixture(), { request } = await f.http();
  for (const name of ["report.md", "page.html", "book.xlsx"]) {
    const path = join(f.cwd, name); writeFileSync(path, "first contents");
    const first = await (await request(`/api/projects/${f.project.id}/files/from-path`, { path })).json();
    expect(first.reused).toBe(false);
    const same = await (await request(`/api/projects/${f.project.id}/files/from-path`, { path })).json();
    expect(same.id).toBe(first.id); expect(same.reused).toBe(true);
    writeFileSync(path, "new contents");
    const next = await (await request(`/api/projects/${f.project.id}/files/from-path`, { path })).json();
    expect(next.id).not.toBe(first.id); expect(next.reused).toBe(false);
    expect(f.store.getFile(first.id)).not.toBeNull();
  }
});

test("local preview distinguishes safe HTML, CSV table, PDF bytes and unsupported xlsx; secrets stay blocked", async () => {
  const f = fixture(), { request } = await f.http();
  writeFileSync(join(f.cwd, "page.html"), '<h1>보고</h1><script>document.title="works"</script>');
  writeFileSync(join(f.cwd, "rows.csv"), 'a,b\r\n"two,three","line\nnext"');
  writeFileSync(join(f.cwd, "book.xlsx"), "PK-fixture");
  writeFileSync(join(f.cwd, "doc.pdf"), "%PDF-1.7\nfixture");
  writeFileSync(join(f.cwd, ".env"), "SECRET=hidden");
  const preview = (name: string, suffix = "") => request(`/api/projects/${f.project.id}/local-file?path=${name}${suffix}`);
  expect((await (await preview("page.html")).json()).kind).toBe("html");
  const html = await preview("page.html", "&render=1");
  expect(html.headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts");
  expect(await html.text()).toContain("Content-Security-Policy");
  expect((await (await preview("rows.csv")).json()).rows).toEqual([["a", "b"], ["two,three", "line\nnext"]]);
  const pdf = await preview("doc.pdf"); expect(pdf.headers.get("Content-Type")).toBe("application/pdf"); expect(await pdf.text()).toBe("%PDF-1.7\nfixture");
  const xlsx = await (await preview("book.xlsx")).json(); expect(xlsx.kind).toBe("xlsx"); expect(xlsx.previewAvailable).toBe(false);
  expect((await preview(".env")).status).toBe(403);
});

test("CSV quoted cells preserve escaping, empty fields, CRLF and terminal line behavior", () => {
  expect(csvRows('"a""b",,c\r\n')).toEqual([['a"b', "", "c"]]);
  expect(csvRows("")).toEqual([]); expect(csvRows("\n")).toEqual([[""]]);
  expect(csvRows("a\tb", "\t")).toEqual([["a", "b"]]);
});

test("artifact JSON remains compatible and rendered HTML has isolated CSP with inline scripts", async () => {
  const f = fixture(), { request } = await f.http();
  const source = '<h1>동작</h1><script>window.answer=42</script>';
  const file = f.store.createFile({ projectId: f.project.id, kind: "artifact", title: "상호작용", html: source });
  const json = await request(`/api/files/${file.id}/artifact`);
  expect(json.headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts");
  const body = await json.json(); expect(body.html).toBe(source); expect(json.headers.get("Content-Security-Policy")).toContain("connect-src 'none'");
  const rendered = await request(`/api/files/${file.id}/artifact?render=1`);
  const csp = rendered.headers.get("Content-Security-Policy")!;
  expect(csp).toContain("script-src 'unsafe-inline'"); expect(csp).not.toContain("allow-same-origin");
  expect(csp).toContain(ARTIFACT_CSP); expect(await rendered.text()).toContain("window.answer=42");
  for (const name of ["worker", "conductor", "root"] as const) {
    const role = await Bun.file(join(import.meta.dir, `../server/roles/${name}.md`)).text();
    expect(role).toContain("외부 CDN 금지"); expect(role).toContain("링크는 앱이 확인 후 연다");
  }
});

test("Mac script notifications default true, PATCH supports disabling and v2 preconditions", async () => {
  const f = fixture(), { request } = await f.http();
  expect(f.store.getSettings().macScriptNotifications).toBe(true);
  const response = await request("/api/settings", { macScriptNotifications: false }, "PATCH");
  expect(response.status).toBe(200); expect((await response.json()).macScriptNotifications).toBe(false);
  f.store.patchSettings({ notifyMac: true });
  f.orch.notifyInbox("결재", "확인"); expect(f.calls).toHaveLength(0);
  const revision = f.store.settingsRevision();
  const restored = await request("/api/settings", { macScriptNotifications: true }, "PATCH", { "X-IAMCEO-Contract": "2", "If-Match": `"${revision}"` });
  expect(restored.status).toBe(200); expect((await restored.json()).settings.macScriptNotifications).toBe(true);
  f.orch.notifyInbox("결재", "확인"); expect(f.calls).toHaveLength(1);
  expect((await request("/api/settings", { macScriptNotifications: false }, "PATCH", { "X-IAMCEO-Contract": "2", "If-Match": `"${revision}"` })).status).toBe(409);
});
