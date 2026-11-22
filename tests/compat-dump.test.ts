// D5: 출시된 앱의 해석기에 먹일 '지금 서버의 실제 응답'을 만든다.
// 화면에 보이는 상태를 고루 만든 서버에서 출시 앱(0.2.2·0.2.3)이 부르는 경로와 실시간 사건을 받아 파일로 남긴다.
// 버전 머리글을 보내는 출시 앱(0.2.4 부터, releases.json 의 appHeaders)은 그 머리글로 같은 경로를 다시 받아 app-<태그>/ 에 따로 남긴다.
// 서버는 머리글을 보낸 앱에만 새 칸(Bootstrap.server, 0.2.5 의 server.id)을 싣기 때문이다. 그 앱이 부르는 연결된 기기 목록과
// 다른 기기 끊기 거절(403 device_revoke_local_only)도 거기에 넣는다. 연결된 기기 가운데 서버가 도는 Mac 의 앱이 부르는 것은
// macos 머리글로 받는다(같은 판의 Mac 앱. 해석 코드는 iPhone 과 같다). 그 폴더의 manifest 에는 서버의 실제 신원
// (serverIdentity: 알림 저장소의 서버 ID 와 데이터 폴더)을 남겨, 0.2.5 부터의 해석기가 응답의 server.id·home 과 견준다.
// 0.2.6 부터의 해석기는 대표 글의 답 상태(reply), 서버가 만든 글의 코드(대화 글·활동 줄·결재 카드의 textCode 등), 팀장 오류 줄의 코드
// (lastErrorCode)를 읽는다. 그래서 상태에 그런 글(서버가 실제로 만드는 꼴: 도구 승인 카드, 30분 지연 알림, 실행 중단 알림, 활동 줄)과
// 오류 줄이 있는 팀장을 넣고, 0.2.7 이 더한 새 글 코드(0.2.7 묶음 1 의 '하던 일을 마치는 중' 알림 등)도 함께 넣는다.
// 0.2.6 앱(Accept-Language 를 화면 언어 ko·en 그대로 싣는다)의 거절 문장은 그 머리글로 받는다.
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
import { LAST_ERROR_CODES } from "../server/text-refs.ts";
import { TOOL_PERMISSION_OPTIONS, toolActionRef, toolPermissionCard, toolPermissionCardTexts } from "../server/tool-permission.ts";
import { appHeadersDumpDir, loadReleases, type AppHeaders } from "../scripts/compat-decoders/run.ts";
import { API_LEVEL, APP_HEADERS, DEFAULT_GEMINI_RANKS, type DeviceAccessList } from "../shared/types.ts";
import { ERROR_CODES } from "../shared/error-codes.ts";
import { sinceParam, textRef } from "../shared/server-text.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

/** 해석기가 아는 형 이름(scripts/compat-decoders/Harness.swift 의 표와 같다). */
/** DeviceAccessList·APIError 는 0.2.4 부터의 해석기(COMPAT_SINCE_0_2_4)만 안다. app-<태그>/ 덤프에만 넣는다. */
export type CompatType = "ServerCapabilities" | "Bootstrap" | "SyncSnapshot" | "ProjectState" | "[Project]" | "MessagePage" | "Message" | "[Message]"
  | "Decision" | "[Activity]" | "DeliveryNoticePage" | "DeliveryNotices" | "ModelCatalog" | "PushStatus" | "PushDeviceList" | "[FileSearchResult]"
  | "SettingsWriteResult" | "RealtimeEvent" | "DeviceAccessList" | "APIError";
/**
 * 해석 뒤 출시 앱이 따로 거는 조건(해석은 되지만 조건이 어긋나면 그 기능이 조용히 꺼진다). 둘째 줄의 다섯은 0.2.4 부터의 해석기만,
 * 셋째 줄의 둘은 0.2.5 부터의 해석기(COMPAT_SINCE_0_2_5)만 안다. server-info·compat-shown·revoke-refused-* 는 0.2.5 해석기에서
 * 서버 신원과 거절 코드까지 본다(Harness.swift).
 * 넷째 줄은 0.2.6 부터의 해석기(COMPAT_SINCE_0_2_6)만 안다: 그 견본에 답 상태·글 코드·오류 줄 코드가 실제로 실렸는가.
 * 실린 값을 0.2.6 이 그대로 쓰는지는 검사 이름과 상관없이 모든 응답에서 본다(Harness.swift scan026).
 */
export type CompatCheck = "contract-v2" | "sync-ok" | "notices-v2" | "hello-v2" | "event-payload"
  | "server-info" | "compat-shown" | "devices" | "revoke-refused-ko" | "revoke-refused-en"
  | "revoke-buttons-mac" | "revoke-buttons-remote"
  | "reply-shown" | "server-text" | "server-text-card" | "last-error-code";
/** status: 2xx 가 아닌 답(APIError)일 때 그 상태. */
export interface CompatEntry { file: string; type: CompatType; checks: CompatCheck[]; note: string; status?: number }

/** 출시 앱이 싣는 버전 머리글. 빌드 번호는 서버가 기록에만 쓴다(응답은 같다). */
function appHeaderValues(app: AppHeaders): Record<string, string> {
  return { [APP_HEADERS.version]: app.version, [APP_HEADERS.build]: "1", [APP_HEADERS.platform]: app.platform, [APP_HEADERS.apiLevel]: String(app.apiLevel) };
}
/** 버전 머리글을 보내는 출시 앱마다 그 앱이 받는 응답을 담을 하위 폴더와 머리글, 그 해석기의 조건(defines). */
const HEADER_APPS = loadReleases().flatMap(release => release.appHeaders
  ? [{ tag: release.tag, dir: appHeadersDumpDir(release.tag), headers: appHeaderValues(release.appHeaders), defines: release.defines ?? [] }] : []);

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
    IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin, IAMCEO_GEMINI_BIN: isolated.bins.geminiBin };
  updateConfigFile({ accessCode: "compat-dump", hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  store.patchSettings({ boardTidyHours: 0 });
  const orch = new Orchestrator({ config, store, runners: new Map([["core", new FakeRunner()]]), providerHomes: isolated.providerHomes,
    timings: { tickMs: 60_000, healthMs: 60_000 } });
  const pushStore = new PushStore(store.db);
  const context: ServerContext = { config, store, bus, orch, delivery: orch.deliveryRecovery,
    // 알림 중계: 새 서버는 상태에 선택 필드 via 를 싣는다(키 없는 Mac 의 production = 중계). 출시 앱이 그대로 푸는지 본다.
    push: { store: pushStore, providers: () => [
      { environment: "sandbox", bundleId: "com.yehsung.iamceo", state: "unconfigured", lastError: null },
      { environment: "production", bundleId: "com.yehsung.iamceo", state: "ready", lastError: null, via: "relay" }] },
    daemon: () => ({ ready: true, buildId: "compat-dump-build", version: VERSION }) };
  let server: RunningServer | undefined;
  const sockets: WebSocket[] = [];
  try {
    do { if (server) await server.stop(); server = await startServer(context); } while (server.port === 7878);
    const base = `http://127.0.0.1:${server.port}`;
    orch.setServerUrl(base);
    const auth = { Authorization: `Bearer ${config.accessCode}` };

    // 받는 쪽: 머리글 없는 출시 앱(0.2.2·0.2.3)과, 버전 머리글을 보내는 출시 앱마다 그 머리글을 모든 요청에 실은 쪽.
    interface Target { dir: string; tag: string | null; headers: Record<string, string>; defines: string[]; frames: Record<string, unknown>[]; entries: CompatEntry[] }
    const targets: Target[] = [{ dir: out, tag: null, headers: {}, defines: [], frames: [], entries: [] },
      ...HEADER_APPS.map(app => ({ dir: join(out, app.dir), tag: app.tag, headers: app.headers, defines: app.defines, frames: [], entries: [] }))];

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
    // 0.2.7 배포 전 재확인 검토: Claude 가 압축할 대화가 적다고 끝낸 압축 — 문맥 상태 failed + 새 까닭 nothing_to_compact.
    // 출시 앱은 reason 을 글자(String?)로 읽는다: 모르는 값이어도 읽고, failed 의 기본 글을 보인다(설계된 대체). 0.2.7 앱은 줄을 보이지 않는다.
    const notes = store.createMember({ projectId: project.id, handle: "notes", name: "회의록 정리", kind: "worker",
      backend: "core", status: "idle", sessionId: randomUUID(), paneId: "fake:notes", cwd: isolated.paths.work });
    const notesGeneration = store.memberRevisions(notes.id).sessionGeneration;
    store.saveLifecycleJournal({ operationId: randomUUID(), memberId: notes.id, projectId: project.id, intent: "start", phase: "confirmed",
      identity: { terminalId: "fake:notes", sessionId: notes.sessionId, sessionGeneration: notesGeneration, process: null }, runId: null, deliveryIds: [], baseline: null, reason: null, exitCode: null, createdAt: at, updatedAt: at });
    const notesContext = store.ensureContextState(notes.id);
    store.saveContextState({ ...notesContext, compaction: { id: randomUUID(), trigger: "manual", phase: "failed", reason: "nothing_to_compact", requestedAt: at, startedAt: at, finishedAt: at } });
    // 0.2.10: Gemini(Antigravity CLI) 팀장. 출시 앱은 cli 를 글자로 읽는다: 모르는 값이어도 풀린다(화면은 Claude 모양으로 그린다 — 디코딩만 본다).
    // 새 막힘 코드(gemini_setup)와 설정의 새 칸(geminiRanks)도 모른 채 넘기는지 함께 본다.
    const gem = store.createMember({ projectId: project.id, handle: "gem", name: "자료 검색", kind: "worker", cli: "gemini", modelOverride: "gemini-4-neon",
      backend: "core", status: "blocked", sessionId: randomUUID(), paneId: "fake:gem", cwd: isolated.paths.work });
    store.patchMember(gem.id, { effortOverride: "high", statusObservation: { source: "core", observedAt: at, freshness: "fresh", ownership: "verified", consecutiveFailures: 0,
      error: { code: "gemini_setup", note: ERROR_CODES.observation_gemini_setup.ko } } });
    store.patchSettings({ geminiRanks: { ...DEFAULT_GEMINI_RANKS, lead: { model: "gemini-4-neon", effort: "high" } } });
    const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
      method, headers: { ...auth, "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const sent = await request(`/api/projects/${project.id}/messages`, "POST", { id: randomUUID(), text: "지시", targetMemberId: member.id }, { "X-IAMCEO-Contract": "2" });
    expect(sent.status).toBe(200);
    const held = store.enqueue({ projectId: project.id, memberId: member.id, kind: "instruction", text: "[지시] 보류될 일" });
    store.markHeld(held.id, "blocked");
    const decision = store.createDecision({ projectId: project.id, memberId: member.id, who: "결제 연동", title: "고를 것", options: [{ k: "a", label: "가" }, { k: "b", label: "나", desc: "설명" }] });
    // K(E2): 도구 승인 카드. 출시 앱은 kind 를 글자로 읽고 toolPermission 은 모른 채 보통 결재(허용·거절 두 선택지)로 보여 준다.
    // 서버(tool-permission.ts)가 만드는 꼴 그대로: 0.2.6 Y 의 글 코드(제목·본문 코드와 값 안의 코드·언어별 값, 선택지 이름·설명 코드)를 함께 남긴다.
    const toolTtl = 600_000;
    const toolInfo = { tool: "Bash", action: store.renderText(toolActionRef("Bash")), target: "bun test", cwd: isolated.paths.work, expiresAt: new Date(Date.now() + toolTtl).toISOString() };
    const toolCard = store.createToolPermissionDecision({ projectId: project.id, memberId: member.id, who: member.name, ...toolPermissionCard(member, toolInfo, toolTtl),
      options: TOOL_PERMISSION_OPTIONS, toolPermission: toolInfo, texts: toolPermissionCardTexts(member, toolInfo, toolTtl) });
    store.createTodo({ projectId: project.id, memberId: member.id, title: "할 일" });
    store.upsertWork({ projectId: project.id, sec: "doing", title: "결제 화면" });
    store.createFile({ projectId: project.id, memberId: member.id, who: "결제 연동", title: "결제 설계", summary: "요약", body: "# 결제 설계\n\n본문" });
    // 0.2.7 묶음 4: 판 갈이(replaces·replacedBy·versions), 앞 카드를 대신한 결재(replaces·replacedBy, 메모가 있어야 하는 선택지 needsNote),
    // 첨부를 붙인 결재 답(answerAttachments), 팀장에게 맡긴 할 일(outcome delegated). 출시 앱은 모르는 칸·값을 그대로 넘기는지 본다.
    const draft = store.createFile({ projectId: project.id, memberId: member.id, who: "결제 연동", title: "안내 문구", body: "# 안내 문구" });
    store.createFile({ projectId: project.id, memberId: member.id, who: "결제 연동", title: "안내 문구(고친 판)", body: "# 안내 문구\n\n고친 판", replaces: draft.id });
    const earlier = store.createDecision({ projectId: project.id, memberId: member.id, who: "결제 연동", title: "문구를 고를까요?", options: [{ k: "a", label: "가" }] });
    const revised = store.createDecision({ projectId: project.id, memberId: member.id, who: "결제 연동", title: "문구를 고를까요?(고친 판)", replaces: earlier.id,
      options: [{ k: "a", label: "가" }, { k: "memo", label: "메모에 적음", needsNote: true }] });
    store.setDecisionReplacedBy(earlier.id, revised.id);
    store.closeDecision(earlier.id, { kind: "obsolete", reason: textRef("card.replaced"), by: "결제 연동" });
    const shot = store.createAttachment({ id: "a_compat_shot", name: "캡처.png", mime: "image/png", size: 3, path: join(isolated.paths.work, "캡처.png") });
    const withFiles = store.createDecision({ projectId: project.id, memberId: member.id, who: "결제 연동", title: "시안을 볼까요?", options: [{ k: "a", label: "가" }] });
    store.answerDecision(withFiles.id, { choice: "a", note: "그림 참고", fileIds: [shot.id] });
    // 전달하지 못해 다시 열린 카드의 직전 답 첨부(lastAnswerAttachments).
    const reopened = store.createDecision({ projectId: project.id, memberId: member.id, who: "결제 연동", title: "색을 바꿀까요?", options: [{ k: "a", label: "가" }] });
    store.answerDecision(reopened.id, { choice: "a", note: "그림 참고", fileIds: [shot.id] });
    store.reopenDecision(reopened.id);
    const handed = store.createTodo({ projectId: project.id, memberId: member.id, title: "맡긴 할 일" });
    store.closeTodo(handed.id, { outcome: "delegated", reason: null, by: "대표" });
    store.appendActivity(member.id, "text", "설계를 쓰는 중");
    // 0.2.6 Y: 서버가 만든 글의 코드. 0.2.6 이 아는 코드(30분 지연 알림: 제목 코드가 있다, 실행 중단: 값 안의 코드, 압축 완료 활동 줄)와,
    // 0.2.7 묶음 1 이 더한 새 코드('하던 일을 마치는 중' 지연 알림: 시각 값과 값 안의 새 코드, 급한 지시로 턴을 멈춘 활동 줄).
    // 0.2.6 은 모르는 코드의 글을 받은 문장 그대로 보인다(allow.json 에 그 까닭). 그보다 앞 앱은 코드를 모른 채 문장을 그대로 보인다.
    store.createMessage({ projectId: project.id, memberId: member.id, who: "시스템", kind: "막힘", text: textRef("chat.owner_message_late", { name: member.name, id: held.id }) });
    store.createMessage({ projectId: project.id, memberId: member.id, who: "시스템", kind: "알림",
      text: textRef("chat.run_interrupted", { name: member.name, run: "r_compat", why: textRef("why.slept") }) });
    store.createMessage({ id: `msg_delivery_behind_${held.id}`, projectId: project.id, memberId: member.id, who: "시스템", kind: "알림",
      // 0.2.7 배포 전 확인(문제 3): 오늘 일이면 시각만(언어별 글자 값), 대표 글에 내부 번호 없음.
      text: textRef("chat.owner_delivery_behind", { name: member.name, since: sinceParam(at), what: textRef("word.owner_message") }) });
    store.appendActivity(member.id, "system", textRef("activity.compact_done"));
    store.appendActivity(member.id, "system", textRef("activity.urgent_interrupt"));
    // 0.2.6 Y: 정해진 문장의 오류 줄(lastErrorCode). 0.2.6 영어 화면은 그 코드의 영어 문장을 쓴다.
    const stalled = store.createMember({ projectId: project.id, handle: "deploy", name: "배포 점검", kind: "worker", origin: "manual", status: "idle" });
    store.patchMember(stalled.id, { status: "error", lastError: [...LAST_ERROR_CODES].find(([, code]) => code === "last_error_api_outage")![0] });
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
      /** 0.2.6 부터의 해석기만 아는 검사(앞 판 해석기는 그 이름을 모른다). */
      const since026 = target.defines.includes("COMPAT_SINCE_0_2_6");
      const v026 = (...checks: CompatCheck[]): CompatCheck[] => since026 ? checks : [];

      await capture("capabilities.json", "ServerCapabilities", "/api/capabilities", "연결 직후 계약 확인", ["contract-v2"]);
      await capture("bootstrap.json", "Bootstrap", "/api/bootstrap", headerApp ? "첫 연결 확인(버전 머리글을 보낸 앱: server 칸)" : "첫 연결 확인", serverInfo);
      // 머리글 없는 옛 해석기에도 새 칸(server·compat)이 실린 응답을 먹여 본다. 머리글을 보내는 앱 몫은 위 bootstrap.json 이 이미 그 응답이다.
      if (!headerApp) await capture("bootstrap-new-app.json", "Bootstrap", "/api/bootstrap", "버전 머리글을 보낸 앱의 응답(server 필드)", [], { headers: newApp });
      await capture("bootstrap-mismatch.json", "Bootstrap", "/api/bootstrap", "어긋난 앱의 응답(compat 필드)", headerApp ? ["compat-shown"] : [], { headers: aheadApp });
      await capture("sync-none.json", "SyncSnapshot", `/api/sync?${lite}`, "프로젝트를 고르기 전 동기화", serverInfo);
      const sync = await capture("sync-project.json", "SyncSnapshot", `/api/sync?projectId=${project.id}&${lite}`, "프로젝트 동기화(lite)",
        ["sync-ok", "notices-v2", ...serverInfo, ...v026("reply-shown", "server-text", "last-error-code")]);
      await capture("sync-project-full.json", "SyncSnapshot", `/api/sync?projectId=${project.id}`, "프로젝트 동기화(본문 포함)",
        ["sync-ok", "notices-v2", ...serverInfo, ...v026("reply-shown", "server-text", "last-error-code")]);
      await capture("sync-not-found.json", "SyncSnapshot", `/api/sync?projectId=missing&${lite}`, "없는 프로젝트", serverInfo);
      await capture("sync-archived.json", "SyncSnapshot", `/api/sync?projectId=${archived.id}&${lite}`, "보관한 프로젝트를 고른 채", serverInfo);
      await capture("sync-mismatch.json", "SyncSnapshot", `/api/sync?projectId=${project.id}&${lite}`, "어긋난 앱의 동기화", ["sync-ok", ...(headerApp ? ["compat-shown" as const] : [])], { headers: aheadApp });
      await capture("state.json", "ProjectState", `/api/projects/${project.id}/state?${lite}`, "프로젝트 상태(lite)", ["notices-v2", ...v026("reply-shown", "server-text")]);
      await capture("archive-state.json", "ProjectState", `/api/projects/${archived.id}/archive/state`, "보관한 프로젝트 상태");
      await capture("archived-projects.json", "[Project]", "/api/projects/archived", "보관함 목록");
      await capture("messages-page-project.json", "MessagePage", `/api/projects/${project.id}/messages/page?limit=200&scope=project`, "대화 첫 페이지",
        v026("reply-shown", "server-text"));
      await capture("messages-page-member.json", "MessagePage", `/api/projects/${project.id}/messages/page?limit=200&scope=member&memberId=${member.id}`, "팀장 대화 첫 페이지",
        v026("reply-shown", "server-text"));
      await capture("archive-messages-page.json", "MessagePage", `/api/projects/${archived.id}/archive/messages/page?limit=200&scope=project`, "보관한 대화");
      await capture("message.json", "Message", `/api/messages/${report.id}`, "메시지 한 건");
      await capture("messages-around.json", "[Message]", `/api/projects/${project.id}/messages?around=${report.id}&limit=41`, "알림에서 연 대화 주변", v026("reply-shown"));
      await capture("decision.json", "Decision", `/api/decisions/${decision.id}`, "결재 한 건");
      await capture("decision-tool-permission.json", "Decision", `/api/decisions/${toolCard.id}`, "도구 승인 카드(K, 0.2.6 글 코드)", v026("server-text-card"));
      await capture("decision-replaced.json", "Decision", `/api/decisions/${earlier.id}`, "새 카드가 대신해 닫힌 결재(0.2.7 replacedBy, 닫힌 이유 코드 card.replaced)", v026("server-text"));
      await capture("decision-revised.json", "Decision", `/api/decisions/${revised.id}`, "앞 카드를 대신한 결재(0.2.7 replaces·needsNote)");
      await capture("decision-answer-files.json", "Decision", `/api/decisions/${withFiles.id}`, "첨부를 붙인 결재 답(0.2.7 answerAttachments)");
      await capture("decision-reopened-files.json", "Decision", `/api/decisions/${reopened.id}`, "다시 열린 카드의 직전 답 첨부(0.2.7 lastAnswerAttachments, 다시 연 까닭 코드)", v026("server-text"));
      await capture("activity.json", "[Activity]", `/api/members/${member.id}/activity?limit=100`, "팀장 활동(0.2.6 글 코드)", v026("server-text"));
      await capture("member-delivery-notices.json", "DeliveryNoticePage", `/api/members/${member.id}/delivery-notices?limit=50`, "팀장 전달 안내");
      await capture("project-delivery-notices.json", "DeliveryNotices", `/api/projects/${project.id}/delivery-notices`, "받는 사람 없는 전달", ["notices-v2"]);
      await capture("models.json", "ModelCatalog", "/api/models", "모델 목록");
      await capture("push-status.json", "PushStatus", "/api/push/status", "iPhone 알림 상태");
      await capture("push-devices.json", "PushDeviceList", "/api/push/devices", "알림 기기 목록");
      await capture("file-search.json", "[FileSearchResult]", `/api/projects/${project.id}/files/search?q=${encodeURIComponent("결제")}&limit=200`, "자료 검색", [], { headers: { "X-IAMCEO-Contract": "2" } });
      await capture("settings-write.json", "SettingsWriteResult", "/api/settings", "설정 쓰기(검토 버전)", [],
        { method: "PATCH", body: { macScriptNotifications: false }, headers: { "X-IAMCEO-Contract": "2", "If-Match": `"${sync.revisions.settings}"` } });

      if (headerApp && paired) {
        // 0.2.4 의 설정 → 연결 → '연결된 기기'. 서버가 도는 Mac 의 앱(공용 코드, 같은 판의 Mac 앱이라 macos 머리글)과,
        // HTTPS 주소(tailscale serve)로 붙은 iPhone(기기 열쇠). 0.2.5 부터는 줄마다의 끊기 단추(canRevokeOthers)도 본다.
        const since025 = target.defines.includes("COMPAT_SINCE_0_2_5");
        const viaServe = { Authorization: `Bearer ${paired.phone.key}`, "X-Forwarded-For": "100.64.0.9" };
        const onMac = await capture("devices.json", "DeviceAccessList", "/api/devices", "연결된 기기(서버가 도는 Mac 의 앱)",
          ["devices", ...(since025 ? ["revoke-buttons-mac" as const] : [])], { headers: { [APP_HEADERS.platform]: "macos" } });
        expect(onMac.canRevokeOthers).toBe(true);
        const fromPhone = await capture("devices-remote.json", "DeviceAccessList", "/api/devices", "연결된 기기(HTTPS 주소로 붙은 iPhone)",
          ["devices", ...(since025 ? ["revoke-buttons-remote" as const] : [])], { headers: viaServe });
        expect(fromPhone.canRevokeOthers).toBe(false);
        expect(fromPhone.devices.find((device: Record<string, unknown>) => device.current)?.platform).toBe(HEADER_APPS[0]!.headers[APP_HEADERS.platform]);
        // 0.2.4 iPhone 은 남의 줄에도 '끊기'가 있다. 누르면 서버가 403 으로 거절하고 그 앱은 받은 문장을 빨간 한 줄로 보인다(화면 언어별).
        // 0.2.6 부터의 앱은 Accept-Language 에 화면 언어(ko·en)만 싣는다(AppVersion.apply). 앞 판은 URLSession 이 기기 설정으로 지은 값이다.
        const [ko, en] = since026 ? ["ko", "en"] as const : ["ko-KR,ko;q=0.9", "en-US,en;q=0.9"] as const;
        for (const [file, language, check] of [["devices-revoke-refused.json", ko, "revoke-refused-ko"], ["devices-revoke-refused-en.json", en, "revoke-refused-en"]] as const) {
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
        // 첫 글 사건은 맨 처음 보낸 대표 글이다(답 상태가 실린다). 0.2.6 해석기는 거기에 답 상태가 실렸는지도 본다.
        const since026 = target.defines.includes("COMPAT_SINCE_0_2_6");
        const checks: CompatCheck[] = type === "hello" ? ["hello-v2"] : ["event-payload", ...(since026 && type === "message" ? ["reply-shown" as const] : [])];
        target.entries.push({ file: `ws-${type}.json`, type: "RealtimeEvent", checks, note: `실시간 사건 ${type}` });
      }
      const app = HEADER_APPS.find(item => item.tag === target.tag);
      // serverIdentity: 응답과 따로 읽은 서버의 실제 신원(알림이 쓰는 서버 ID, 데이터 폴더). 0.2.5 해석기가 응답의 server.id·home 과 견준다.
      writeFileSync(join(target.dir, "manifest.json"), JSON.stringify({ serverVersion: VERSION, apiLevel: API_LEVEL, createdAt: new Date().toISOString(),
        ...(app ? { release: app.tag, appHeaders: { sent: app.headers }, serverIdentity: { id: pushStore.serverId, home: config.home } } : {}),
        entries: target.entries }, null, 2));
    }

    // 만든 상태가 실제로 실렸는지: 비어 있어서 통과하는 덤프가 아니어야 한다.
    const sync = JSON.parse(readFileSync(join(out, "sync-project.json"), "utf8")) as Record<string, any>;
    const state = sync.state as Record<string, any>;
    expect(state.members.length).toBeGreaterThan(0);
    // 0.2.7 배포 전 재확인 검토: 새 까닭 값 nothing_to_compact 가 실린 문맥 상태(출시 앱 해석기가 이 덤프를 읽는다).
    expect(state.members.find((m: Record<string, any>) => m.id === notes.id)?.contextState?.compaction).toMatchObject({ phase: "failed", reason: "nothing_to_compact" });
    expect(state.decisions.length).toBe(6);
    expect(state.decisions.some((d: Record<string, unknown>) => d.kind === "tool_permission" && d.toolPermission)).toBe(true);
    // 0.2.7 묶음 4 의 새 칸·값이 실제로 실렸다.
    expect(state.decisions.some((d: Record<string, any>) => d.replacedBy && d.status === "closed")).toBe(true);
    expect(state.decisions.some((d: Record<string, any>) => d.replaces && d.options.some((o: Record<string, unknown>) => o.needsNote === true))).toBe(true);
    expect(state.decisions.some((d: Record<string, any>) => d.answerAttachments?.length === 1)).toBe(true);
    expect(state.decisions.some((d: Record<string, any>) => d.status === "open" && d.lastAnswerAttachments?.length === 1)).toBe(true);
    expect(state.todos.length).toBe(2);
    expect(state.todos.some((t: Record<string, unknown>) => t.outcome === "delegated")).toBe(true);
    expect(state.work.length).toBe(1);
    // 옛 판은 replacedBy 와 함께 남고(출시 앱이 보고의 자료를 연다), 새 판에 판 수가 실린다.
    expect(state.files.length).toBe(3);
    expect(state.files.some((f: Record<string, unknown>) => f.versions === 2 && f.replaces)).toBe(true);
    expect(state.files.some((f: Record<string, unknown>) => f.replacedBy)).toBe(true);
    expect(state.deliveryNotices.version).toBe(2);
    // 0.2.6 이 읽는 칸이 실제로 실렸다: 대표 글의 답 상태, 서버가 만든 글의 코드(대화 글·활동 줄·카드), 오류 줄 코드.
    expect(state.messages.some((m: Record<string, any>) => m.mine && typeof m.reply?.state === "string" && m.reply.memberId === member.id)).toBe(true);
    const coded = (code: string) => state.messages.find((m: Record<string, any>) => m.textCode === code) as Record<string, any> | undefined;
    expect(coded("chat.owner_message_late")?.textLang).toBe("ko");
    expect(coded("chat.run_interrupted")?.textParams?.why).toEqual({ code: "why.slept" });
    expect(coded("chat.owner_delivery_behind")?.textParams?.what).toEqual({ code: "word.owner_message" });
    const tool = state.decisions.find((d: Record<string, any>) => d.kind === "tool_permission") as Record<string, any>;
    expect(tool.textCode).toBe("card.tool_permission");
    expect(Object.keys(tool.optionTexts ?? {}).sort()).toEqual(tool.options.map((o: Record<string, string>) => o.k).sort());
    expect(state.decisions.some((d: Record<string, any>) => d.reopenNoteText?.code === "card.reopen_undelivered" && d.textLang === "ko")).toBe(true);
    expect(state.decisions.some((d: Record<string, any>) => d.closeReasonText?.code === "card.replaced")).toBe(true);
    expect(state.members.find((m: Record<string, any>) => m.id === stalled.id)?.lastErrorCode).toBe("last_error_api_outage");
    const activity = JSON.parse(readFileSync(join(out, "activity.json"), "utf8")) as Record<string, any>[];
    expect(activity.map(line => line.textCode).filter(Boolean).sort()).toEqual(["activity.compact_done", "activity.urgent_interrupt"]);
    expect(targets[0]!.entries.length).toBe(32 + EVENT_TYPES.length);
    // 머리글 없는 응답에는 새 칸이 없고, 머리글을 보낸 앱의 응답에는 server(0.2.5 의 server.id 포함)가 실린다.
    expect("server" in sync.bootstrap).toBe(false);
    for (const target of targets.slice(1)) {
      expect(target.entries.length).toBe(31 + 4 + EVENT_TYPES.length);
      for (const file of ["bootstrap.json", "sync-project.json"]) {
        const body = JSON.parse(readFileSync(join(target.dir, file), "utf8")) as Record<string, any>;
        const server = (file === "bootstrap.json" ? body : body.bootstrap).server as Record<string, unknown> | undefined;
        expect(server?.version).toBe(VERSION);
        expect(typeof server?.id).toBe("string");
      }
      // 해석기가 견줄 서버 신원이 실제로 남았는지(비어 있으면 0.2.5 검사가 기준 없이 실패한다).
      const manifest = JSON.parse(readFileSync(join(target.dir, "manifest.json"), "utf8")) as { serverIdentity?: { id?: unknown; home?: unknown } };
      expect(manifest.serverIdentity).toEqual({ id: pushStore.serverId, home: config.home });
      expect(pushStore.serverId.length).toBeGreaterThan(0);
      // 0.2.5 해석기가 있는 쪽에만 0.2.5 검사를 붙였다(앞 판 해석기는 그 검사 이름을 모른다).
      const since025 = target.defines.includes("COMPAT_SINCE_0_2_5");
      expect(target.entries.some(entry => entry.checks.includes("revoke-buttons-remote"))).toBe(since025);
      // 0.2.6 검사도 0.2.6 해석기가 있는 쪽에만.
      const since026 = target.defines.includes("COMPAT_SINCE_0_2_6");
      expect(target.entries.some(entry => entry.checks.includes("reply-shown"))).toBe(since026);
      expect(target.entries.filter(entry => entry.checks.includes("server-text-card")).map(entry => entry.file)).toEqual(since026 ? ["decision-tool-permission.json"] : []);
    }
    expect(targets.some(target => target.defines.includes("COMPAT_SINCE_0_2_5"))).toBe(true);
    expect(targets.some(target => target.defines.includes("COMPAT_SINCE_0_2_6"))).toBe(true);
  } finally {
    for (const socket of sockets) socket.close();
    await server?.stop();
    await orch.shutdown();
    store.db.close();
    await isolated.stop();
  }
}, 30_000);
