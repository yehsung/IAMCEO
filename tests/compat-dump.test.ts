// D5: 출시된 앱의 해석기에 먹일 '지금 서버의 실제 응답'을 만든다.
// 화면에 보이는 상태를 고루 만든 서버에서 출시 앱(0.2.2·0.2.3)이 부르는 경로와 실시간 사건을 받아 파일로 남긴다.
// 버전 머리글을 보내는 출시 앱(0.2.4 부터, releases.json 의 appHeaders)은 그 머리글로 같은 경로를 다시 받아 app-<태그>/ 에 따로 남긴다.
// 서버는 머리글을 보낸 앱에만 새 칸(Bootstrap.server, 0.2.5 의 server.id)을 싣기 때문이다. 그 앱이 부르는 연결된 기기 목록과
// 다른 기기 끊기 거절(403 device_revoke_local_only)도 거기에 넣는다.
// IAMCEO_COMPAT_OUT 이 있으면 그 폴더에(scripts/check.sh compat 이 쓴다), 없으면 임시 폴더에 쓰고 지운다.
// 해석은 scripts/compat-decoders/run.ts 가 git 태그의 옛 Swift 모델로 한다. 이 시험은 빠짐없이 받았는지만 본다.
import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile, VERSION } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer, type ServerContext } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { PushStore } from "../server/push/store.ts";
import type { Runner, RunnerMember, SendResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import { appHeadersDumpDir, loadReleases, type AppHeaders } from "../scripts/compat-decoders/run.ts";
import { API_LEVEL, APP_HEADERS, type DeviceAccessList } from "../shared/types.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

/** 해석기가 아는 형 이름(scripts/compat-decoders/Harness.swift 의 표와 같다). */
/** DeviceAccessList·APIError 는 0.2.4 부터의 해석기(COMPAT_SINCE_0_2_4)만 안다. app-<태그>/ 덤프에만 넣는다. */
export type CompatType = "ServerCapabilities" | "Bootstrap" | "SyncSnapshot" | "ProjectState" | "[Project]" | "MessagePage" | "Message" | "[Message]"
  | "Decision" | "[Activity]" | "DeliveryNoticePage" | "DeliveryNotices" | "ModelCatalog" | "PushStatus" | "PushDeviceList" | "[FileSearchResult]"
  | "SettingsWriteResult" | "RealtimeEvent" | "DeviceAccessList" | "APIError";
/** 해석 뒤 출시 앱이 따로 거는 조건(해석은 되지만 조건이 어긋나면 그 기능이 조용히 꺼진다). 뒤의 다섯은 0.2.4 부터의 해석기만 안다. */
export type CompatCheck = "contract-v2" | "sync-ok" | "notices-v2" | "hello-v2" | "event-payload"
  | "server-info" | "compat-shown" | "devices" | "revoke-refused-ko" | "revoke-refused-en";
/** status: 2xx 가 아닌 답(APIError)일 때 그 상태. */
export interface CompatEntry { file: string; type: CompatType; checks: CompatCheck[]; note: string; status?: number }

/** 출시 앱이 싣는 버전 머리글. 빌드 번호는 서버가 기록에만 쓴다(응답은 같다). */
function appHeaderValues(app: AppHeaders): Record<string, string> {
  return { [APP_HEADERS.version]: app.version, [APP_HEADERS.build]: "1", [APP_HEADERS.platform]: app.platform, [APP_HEADERS.apiLevel]: String(app.apiLevel) };
}
/** 버전 머리글을 보내는 출시 앱마다 그 앱이 받는 응답을 담을 하위 폴더와 머리글. */
const HEADER_APPS = loadReleases().flatMap(release => release.appHeaders
  ? [{ tag: release.tag, dir: appHeadersDumpDir(release.tag), headers: appHeaderValues(release.appHeaders) }] : []);

/** 출시 앱이 실제로 받는 사건 종류. 이 가운데 하나라도 못 받으면 덤프가 모자란 것이다. */
const EVENT_TYPES = ["hello", "projects", "project", "member", "member_removed", "decision", "todo", "work", "message", "file", "activity", "settings"] as const;

class FakeRunner implements Runner {
  readonly kind = "core";
  async available() { return { ok: true }; }
  async start(member: RunnerMember) { return { sessionId: member.sessionId ?? randomUUID(), paneId: `fake:${member.id}` }; }
  async send(): Promise<SendResult> { return { ok: true, started: false }; }
  isBusy() { return false; }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async checkStop() {}
  async stop() {}
  async screen() { return ""; }
  on() {}
  async shutdown() {}
  async terminalControl(): Promise<never> { throw new Error("덤프 시험은 터미널을 쓰지 않는다"); }
}

const kept = process.env.IAMCEO_COMPAT_OUT;
const out = kept ? kept : mkdtempSync(join(tmpdir(), "iamceo-compat-"));
afterAll(() => { if (!kept) rmSync(out, { recursive: true, force: true }); });

test("출시 앱이 읽는 실제 응답과 실시간 사건을 빠짐없이 받아 둔다", async () => {
  mkdirSync(out, { recursive: true });
  const isolated = createIsolatedRuntime();
  const env = { IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0",
    IAMCEO_CORE_SOCKET: isolated.socketPath, IAMCEO_HERDR_SOCKET: isolated.herdrSocketPath,
    IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin };
  updateConfigFile({ accessCode: "compat-dump", hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  store.patchSettings({ boardTidyHours: 0 });
  const orch = new Orchestrator({ config, store, runners: new Map([["core", new FakeRunner()]]), providerHomes: isolated.providerHomes,
    timings: { tickMs: 60_000, healthMs: 60_000 } });
  const context: ServerContext = { config, store, bus, orch, delivery: orch.deliveryRecovery,
    push: { store: new PushStore(store.db), providers: () => [] },
    daemon: () => ({ ready: true, buildId: "compat-dump-build", version: VERSION }) };
  let server: RunningServer | undefined;
  const sockets: WebSocket[] = [];
  try {
    do { if (server) await server.stop(); server = await startServer(context); } while (server.port === 7878);
    const base = `http://127.0.0.1:${server.port}`;
    orch.setServerUrl(base);
    const auth = { Authorization: `Bearer ${config.accessCode}` };

    // 받는 쪽: 머리글 없는 출시 앱(0.2.2·0.2.3)과, 버전 머리글을 보내는 출시 앱마다 그 머리글을 모든 요청에 실은 쪽.
    interface Target { dir: string; tag: string | null; headers: Record<string, string>; frames: Record<string, unknown>[]; entries: CompatEntry[] }
    const targets: Target[] = [{ dir: out, tag: null, headers: {}, frames: [], entries: [] },
      ...HEADER_APPS.map(app => ({ dir: join(out, app.dir), tag: app.tag, headers: app.headers, frames: [], entries: [] }))];

    // 실시간 사건은 상태를 만들기 전에 붙어 받는다. 출시 앱은 v2·lite 로 붙는다(0.2.4 부터는 실시간 연결에도 같은 머리글을 싣는다).
    const Socket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    for (const target of targets) {
      const socket = new Socket(`${base.replace("http:", "ws:")}/ws?v=2&lite=1`, { headers: { ...auth, ...target.headers } });
      sockets.push(socket);
      socket.onmessage = event => { target.frames.push(JSON.parse(String(event.data))); };
      await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("실시간 연결 실패")); });
    }

    // 화면에 보이는 상태를 고루 만든다: 팀장, 실행 기록, 압축·측정, 관측 오류, 보류된 전달, 결재, 할 일, 진행판, 자료, 활동, 대화.
    const project = store.createProject({ name: "호환 덤프", cwd: isolated.paths.work });
    const member = store.createMember({ projectId: project.id, handle: "worker", name: "결제 연동", kind: "worker",
      backend: "core", status: "idle", sessionId: randomUUID(), paneId: "fake:worker", cwd: isolated.paths.work });
    const extra = store.createMember({ projectId: project.id, handle: "extra", name: "문서 정리", kind: "worker", origin: "manual", status: "idle" });
    const at = new Date().toISOString(), generation = store.memberRevisions(member.id).sessionGeneration;
    store.saveLifecycleJournal({ operationId: randomUUID(), memberId: member.id, projectId: project.id, intent: "start", phase: "confirmed",
      identity: { terminalId: "fake:worker", sessionId: member.sessionId, sessionGeneration: generation, process: null }, runId: null, deliveryIds: [], baseline: null, reason: null, exitCode: null, createdAt: at, updatedAt: at });
    const context0 = store.ensureContextState(member.id);
    store.saveContextState({ ...context0, compaction: { id: randomUUID(), trigger: "manual", phase: "failed", reason: "draft", requestedAt: at, startedAt: null, finishedAt: at },
      measurement: { quality: "exact", tokens: 1200, window: 200000, pct: 1, turn: 1, model: "claude-sonnet", sessionId: member.sessionId!, sessionGeneration: generation, terminalId: "fake:worker", fresh: true, measuredAt: at } as never });
    store.patchMember(member.id, { statusObservation: { source: "core", observedAt: at, freshness: "stale", ownership: "unknown", consecutiveFailures: 2, error: { code: "timeout", note: "다시 관측 중" } } });
    const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
      method, headers: { ...auth, "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const sent = await request(`/api/projects/${project.id}/messages`, "POST", { id: randomUUID(), text: "지시", targetMemberId: member.id }, { "X-IAMCEO-Contract": "2" });
    expect(sent.status).toBe(200);
    const held = store.enqueue({ projectId: project.id, memberId: member.id, kind: "instruction", text: "[지시] 보류될 일" });
    store.markHeld(held.id, "blocked");
    const decision = store.createDecision({ projectId: project.id, memberId: member.id, who: "결제 연동", title: "고를 것", options: [{ k: "a", label: "가" }, { k: "b", label: "나", desc: "설명" }] });
    // K(E2): 도구 승인 카드. 출시 앱은 kind 를 글자로 읽고 toolPermission 은 모른 채 보통 결재(허용·거절 두 선택지)로 보여 준다.
    const toolCard = store.createToolPermissionDecision({ projectId: project.id, memberId: member.id, who: "결제 연동", title: "명령 실행: bun test",
      detail: "결제 연동이 터미널의 승인 창 앞에서 기다립니다.\n\n**명령 실행**\n```\nbun test\n```", options: [{ k: "allow", label: "허용", desc: "이번 한 번만 실행합니다" }, { k: "deny", label: "거절", desc: "실행하지 않고 팀장에게 알립니다" }],
      toolPermission: { tool: "Bash", action: "명령 실행", target: "bun test", cwd: isolated.paths.work, expiresAt: new Date(Date.now() + 600_000).toISOString() } });
    store.createTodo({ projectId: project.id, memberId: member.id, title: "할 일" });
    store.upsertWork({ projectId: project.id, sec: "doing", title: "결제 화면" });
    store.createFile({ projectId: project.id, memberId: member.id, who: "결제 연동", title: "결제 설계", summary: "요약", body: "# 결제 설계\n\n본문" });
    store.appendActivity(member.id, "text", "설계를 쓰는 중");
    const report = store.createMessage({ projectId: project.id, memberId: member.id, who: "결제 연동", kind: "완료", title: "보고", body: "다 했습니다" });
    store.removeMember(extra.id);
    // 보관한 프로젝트 하나(보관함 화면이 읽는다).
    const archived = store.createProject({ name: "보관한 일", cwd: isolated.paths.work });
    const archivedPatch = await request(`/api/projects/${archived.id}`, "PATCH", { archived: true });
    expect(archivedPatch.status).toBe(200);

    // 버전 머리글을 보내는 앱(0.2.4 부터)이 부르는 '연결된 기기'용: QR 로 연결한 iPhone 과 다른 기기 하나.
    const pair = async (device: string, headers: Record<string, string>) => {
      const started = await request("/api/pair/start", "POST");
      expect(started.status).toBe(200);
      const { code } = await started.json() as { code: string };
      const claimed = await fetch(`${base}/pair/claim`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ code, device }) });
      expect(claimed.status).toBe(200);
      const key = (await claimed.json() as { accessCode: string }).accessCode;
      const list = await (await request("/api/devices", "GET", undefined, { Authorization: `Bearer ${key}` })).json() as DeviceAccessList;
      return { key, id: list.devices.find(entry => entry.current)!.id };
    };
    const paired = HEADER_APPS.length ? { phone: await pair("대표의 iPhone", HEADER_APPS[0]!.headers), other: await pair("회사 iPad", {}) } : null;

    const lite = "lite=1";
    const newApp = { [APP_HEADERS.version]: "9.9.9", [APP_HEADERS.build]: "1", [APP_HEADERS.platform]: "ios", [APP_HEADERS.apiLevel]: String(API_LEVEL) };
    const aheadApp = { ...newApp, [APP_HEADERS.apiLevel]: String(API_LEVEL + 1) };
    type Init = { method?: string; body?: unknown; headers?: Record<string, string> };

    /** 한 쪽(target)이 받는 응답을 모두 받아 그 폴더에 남긴다. 요청마다 그 쪽의 머리글을 싣는다(init.headers 가 덮는다). */
    const dump = async (target: Target) => {
      mkdirSync(target.dir, { recursive: true });
      const headerApp = target.tag !== null;
      const save = (file: string, type: CompatType, body: unknown, note: string, checks: CompatCheck[] = [], status?: number) => {
        writeFileSync(join(target.dir, file), JSON.stringify(body));
        target.entries.push({ file, type, checks, note, ...(status === undefined ? {} : { status }) });
      };
      const fetchAs = (path: string, init: Init) => request(path, init.method, init.body, { ...target.headers, ...init.headers });
      const capture = async (file: string, type: CompatType, path: string, note: string, checks: CompatCheck[] = [], init: Init = {}) => {
        const response = await fetchAs(path, init);
        const text = await response.text();
        if (response.status !== 200) throw new Error(`${path} → ${response.status} ${text}`);
        save(file, type, JSON.parse(text), note, checks);
        return JSON.parse(text) as Record<string, any>;
      };
      /** 머리글을 보낸 앱이면 server 칸과 '어긋남 안내가 뜨지 않음'도 본다. */
      const serverInfo: CompatCheck[] = headerApp ? ["server-info"] : [];

      await capture("capabilities.json", "ServerCapabilities", "/api/capabilities", "연결 직후 계약 확인", ["contract-v2"]);
      await capture("bootstrap.json", "Bootstrap", "/api/bootstrap", headerApp ? "첫 연결 확인(버전 머리글을 보낸 앱: server 칸)" : "첫 연결 확인", serverInfo);
      // 머리글 없는 옛 해석기에도 새 칸(server·compat)이 실린 응답을 먹여 본다. 머리글을 보내는 앱 몫은 위 bootstrap.json 이 이미 그 응답이다.
      if (!headerApp) await capture("bootstrap-new-app.json", "Bootstrap", "/api/bootstrap", "버전 머리글을 보낸 앱의 응답(server 필드)", [], { headers: newApp });
      await capture("bootstrap-mismatch.json", "Bootstrap", "/api/bootstrap", "어긋난 앱의 응답(compat 필드)", headerApp ? ["compat-shown"] : [], { headers: aheadApp });
      await capture("sync-none.json", "SyncSnapshot", `/api/sync?${lite}`, "프로젝트를 고르기 전 동기화", serverInfo);
      const sync = await capture("sync-project.json", "SyncSnapshot", `/api/sync?projectId=${project.id}&${lite}`, "프로젝트 동기화(lite)", ["sync-ok", "notices-v2", ...serverInfo]);
      await capture("sync-project-full.json", "SyncSnapshot", `/api/sync?projectId=${project.id}`, "프로젝트 동기화(본문 포함)", ["sync-ok", "notices-v2", ...serverInfo]);
      await capture("sync-not-found.json", "SyncSnapshot", `/api/sync?projectId=missing&${lite}`, "없는 프로젝트", serverInfo);
      await capture("sync-archived.json", "SyncSnapshot", `/api/sync?projectId=${archived.id}&${lite}`, "보관한 프로젝트를 고른 채", serverInfo);
      await capture("sync-mismatch.json", "SyncSnapshot", `/api/sync?projectId=${project.id}&${lite}`, "어긋난 앱의 동기화", ["sync-ok", ...(headerApp ? ["compat-shown" as const] : [])], { headers: aheadApp });
      await capture("state.json", "ProjectState", `/api/projects/${project.id}/state?${lite}`, "프로젝트 상태(lite)", ["notices-v2"]);
      await capture("archive-state.json", "ProjectState", `/api/projects/${archived.id}/archive/state`, "보관한 프로젝트 상태");
      await capture("archived-projects.json", "[Project]", "/api/projects/archived", "보관함 목록");
      await capture("messages-page-project.json", "MessagePage", `/api/projects/${project.id}/messages/page?limit=200&scope=project`, "대화 첫 페이지");
      await capture("messages-page-member.json", "MessagePage", `/api/projects/${project.id}/messages/page?limit=200&scope=member&memberId=${member.id}`, "팀장 대화 첫 페이지");
      await capture("archive-messages-page.json", "MessagePage", `/api/projects/${archived.id}/archive/messages/page?limit=200&scope=project`, "보관한 대화");
      await capture("message.json", "Message", `/api/messages/${report.id}`, "메시지 한 건");
      await capture("messages-around.json", "[Message]", `/api/projects/${project.id}/messages?around=${report.id}&limit=41`, "알림에서 연 대화 주변");
      await capture("decision.json", "Decision", `/api/decisions/${decision.id}`, "결재 한 건");
      await capture("decision-tool-permission.json", "Decision", `/api/decisions/${toolCard.id}`, "도구 승인 카드(K)");
      await capture("activity.json", "[Activity]", `/api/members/${member.id}/activity?limit=100`, "팀장 활동");
      await capture("member-delivery-notices.json", "DeliveryNoticePage", `/api/members/${member.id}/delivery-notices?limit=50`, "팀장 전달 안내");
      await capture("project-delivery-notices.json", "DeliveryNotices", `/api/projects/${project.id}/delivery-notices`, "받는 사람 없는 전달", ["notices-v2"]);
      await capture("models.json", "ModelCatalog", "/api/models", "모델 목록");
      await capture("push-status.json", "PushStatus", "/api/push/status", "iPhone 알림 상태");
      await capture("push-devices.json", "PushDeviceList", "/api/push/devices", "알림 기기 목록");
      await capture("file-search.json", "[FileSearchResult]", `/api/projects/${project.id}/files/search?q=${encodeURIComponent("결제")}&limit=200`, "자료 검색", [], { headers: { "X-IAMCEO-Contract": "2" } });
      await capture("settings-write.json", "SettingsWriteResult", "/api/settings", "설정 쓰기(검토 버전)", [],
        { method: "PATCH", body: { macScriptNotifications: false }, headers: { "X-IAMCEO-Contract": "2", "If-Match": `"${sync.revisions.settings}"` } });

      if (headerApp && paired) {
        // 0.2.4 의 설정 → 연결 → '연결된 기기'. 서버가 도는 Mac 의 앱(공용 코드)과, HTTPS 주소(tailscale serve)로 붙은 iPhone(기기 열쇠).
        const viaServe = { Authorization: `Bearer ${paired.phone.key}`, "X-Forwarded-For": "100.64.0.9" };
        const onMac = await capture("devices.json", "DeviceAccessList", "/api/devices", "연결된 기기(서버가 도는 Mac 의 앱)", ["devices"]);
        expect(onMac.canRevokeOthers).toBe(true);
        const fromPhone = await capture("devices-remote.json", "DeviceAccessList", "/api/devices", "연결된 기기(HTTPS 주소로 붙은 iPhone)", ["devices"], { headers: viaServe });
        expect(fromPhone.canRevokeOthers).toBe(false);
        expect(fromPhone.devices.find((device: Record<string, unknown>) => device.current)?.platform).toBe(HEADER_APPS[0]!.headers[APP_HEADERS.platform]);
        // 0.2.4 iPhone 은 남의 줄에도 '끊기'가 있다. 누르면 서버가 403 으로 거절하고 그 앱은 받은 문장을 빨간 한 줄로 보인다(화면 언어별).
        for (const [file, language, check] of [["devices-revoke-refused.json", "ko-KR,ko;q=0.9", "revoke-refused-ko"], ["devices-revoke-refused-en.json", "en-US,en;q=0.9", "revoke-refused-en"]] as const) {
          const refused = await fetchAs(`/api/devices/${paired.other.id}`, { method: "DELETE", headers: { ...viaServe, "Accept-Language": language } });
          const body = await refused.json() as Record<string, unknown>;
          expect(refused.status).toBe(403);
          expect(body.code).toBe("device_revoke_local_only");
          save(file, "APIError", body, `다른 기기 끊기 거절(${language.slice(0, 2)} 화면)`, [check], refused.status);
        }
        // 거절은 아무것도 끊지 않았다.
        const after = await (await request("/api/devices")).json() as DeviceAccessList;
        expect(after.devices.map(device => device.id).sort()).toEqual([paired.phone.id, paired.other.id].sort());
      }
    };
    for (const target of targets) await dump(target);

    // 상태를 만들며 받은 사건을 쪽마다, 종류마다 하나씩 남긴다. 늦게 오는 사건을 잠깐 기다린다.
    const deadline = Date.now() + 5_000;
    const missing = () => targets.flatMap(target => EVENT_TYPES.filter(type => !target.frames.some(frame => frame.type === type)).map(type => `${target.tag ?? "머리글 없음"}:${type}`));
    while (missing().length && Date.now() < deadline) await Bun.sleep(20);
    expect(missing()).toEqual([]);
    for (const target of targets) {
      for (const type of EVENT_TYPES) {
        const frame = target.frames.find(item => item.type === type)!;
        writeFileSync(join(target.dir, `ws-${type}.json`), JSON.stringify(frame));
        target.entries.push({ file: `ws-${type}.json`, type: "RealtimeEvent", checks: type === "hello" ? ["hello-v2"] : ["event-payload"], note: `실시간 사건 ${type}` });
      }
      const app = HEADER_APPS.find(item => item.tag === target.tag);
      writeFileSync(join(target.dir, "manifest.json"), JSON.stringify({ serverVersion: VERSION, apiLevel: API_LEVEL, createdAt: new Date().toISOString(),
        ...(app ? { release: app.tag, appHeaders: { sent: app.headers } } : {}), entries: target.entries }, null, 2));
    }

    // 만든 상태가 실제로 실렸는지: 비어 있어서 통과하는 덤프가 아니어야 한다.
    const sync = JSON.parse(readFileSync(join(out, "sync-project.json"), "utf8")) as Record<string, any>;
    const state = sync.state as Record<string, any>;
    expect(state.members.length).toBeGreaterThan(0);
    expect(state.decisions.length).toBe(2);
    expect(state.decisions.some((d: Record<string, unknown>) => d.kind === "tool_permission" && d.toolPermission)).toBe(true);
    expect(state.todos.length).toBe(1);
    expect(state.work.length).toBe(1);
    expect(state.files.length).toBe(1);
    expect(state.deliveryNotices.version).toBe(2);
    expect(targets[0]!.entries.length).toBe(28 + EVENT_TYPES.length);
    // 머리글 없는 응답에는 새 칸이 없고, 머리글을 보낸 앱의 응답에는 server(0.2.5 의 server.id 포함)가 실린다.
    expect("server" in sync.bootstrap).toBe(false);
    for (const target of targets.slice(1)) {
      expect(target.entries.length).toBe(27 + 4 + EVENT_TYPES.length);
      for (const file of ["bootstrap.json", "sync-project.json"]) {
        const body = JSON.parse(readFileSync(join(target.dir, file), "utf8")) as Record<string, any>;
        const server = (file === "bootstrap.json" ? body : body.bootstrap).server as Record<string, unknown> | undefined;
        expect(server?.version).toBe(VERSION);
        expect(typeof server?.id).toBe("string");
      }
    }
  } finally {
    for (const socket of sockets) socket.close();
    await server?.stop();
    await orch.shutdown();
    store.db.close();
    await isolated.stop();
  }
}, 30_000);
