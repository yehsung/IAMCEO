// 전역 상태. 화면은 Props 없이 이 파일에서 읽는다.
//   읽기: useStore(s => s.xxx) · useProject() · useRoute() · useSummary() · useBootstrap()
//   쓰기: navigate · login · logout · refresh · sendMessage · loadOlderMessages · loadActivity · applyLocal
// 주소: #/p/<id>/<tab>[/<sub>] · #/settings. 주소가 원본이고 route 는 그 사본이다(<sub>: 자료 id, 직원 id 처럼 화면이 정해 쓴다).
// 동기화: WebSocket 이 (다시) 열릴 때마다 bootstrap·state 를 다시 받는다. 받는 동안 온 이벤트는 모아 두었다가 받은 값 위에 다시 입힌다
// (안 그러면 먼저 시작한 응답이 그 사이 도착한 이벤트를 덮어쓴다).
import { useSyncExternalStore } from "react";
import type {
  Activity,
  Attachment,
  Bootstrap,
  Decision,
  DecisionStatus,
  Member,
  Message,
  ProjectState,
  ProjectSummary,
  SendMessageReq,
  WsEvent,
} from "@shared/types";
import {
  ApiError,
  api,
  clearAccessCode,
  errorText,
  getAccessCode,
  isUnauthorized,
  setAccessCode,
  setUnauthorizedHandler,
  wsUrl,
} from "./api";

export type Tab = "home" | "inbox" | "team" | "thread" | "files";
export const HQ_ID = "hq";

export interface Route {
  projectId: string;
  tab: Tab;
  sub: string | null;
  settings: boolean;
}

export type Auth = "checking" | "need_code" | "ok";
export type Connection = "connecting" | "online" | "offline";

export interface AppState {
  auth: Auth;
  authError: string | null;
  connection: Connection;
  bootstrap: Bootstrap | null;
  route: Route;
  /** route.projectId 의 상태. 전환 중에는 null 이다. */
  project: ProjectState | null;
  projectLoading: boolean;
  projectError: string | null;
  /** 대화에서 더 오래된 글을 받을 수 있는지 */
  hasOlderMessages: boolean;
  /** loadActivity 로 연 직원만 쌓인다 */
  activity: Record<string, Activity[]>;
  /** 화면 위 띠에 잠깐 보일 안내 */
  notice: string | null;
}

// ---- 주소 ----

const TABS: readonly Tab[] = ["home", "inbox", "team", "thread", "files"];
export const tabsFor = (projectId: string): Tab[] => (projectId === HQ_ID ? ["home", "inbox", "thread", "files"] : [...TABS]);

/** 본사는 팀 탭이 없지만 본사 AI 상세는 팀 탭과 같은 주소로 연다(#/p/hq/team/<직원 id>). 목록만 보는 #/p/hq/team 은 없다. */
function routable(projectId: string, wanted: Tab | undefined, sub: string | undefined): boolean {
  if (!wanted) return false;
  return tabsFor(projectId).includes(wanted) || (projectId === HQ_ID && wanted === "team" && !!sub);
}

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "settings") return { projectId: parts[1] ? safeDecode(parts[1]) : HQ_ID, tab: "home", sub: null, settings: true };
  if (parts[0] !== "p" || !parts[1]) return { projectId: HQ_ID, tab: "home", sub: null, settings: false };
  const projectId = safeDecode(parts[1]);
  const wanted = parts[2] as Tab | undefined;
  const tab = wanted && routable(projectId, wanted, parts[3]) ? wanted : "home";
  const sub = tab === wanted && parts[3] ? safeDecode(parts[3]) : null;
  return { projectId, tab, sub, settings: false };
}

export function routeHash(r: Pick<Route, "projectId" | "tab"> & { sub?: string | null; settings?: boolean }): string {
  if (r.settings) return "#/settings";
  const base = `#/p/${encodeURIComponent(r.projectId)}/${r.tab}`;
  return r.sub ? `${base}/${encodeURIComponent(r.sub)}` : base;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---- 이벤트 적용(순수) ----

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

/** 시각순을 유지해 끼운다. 같은 id 는 서버 값으로 바꾼다. */
export function upsertMessage(list: Message[], m: Message): Message[] {
  const without = list.filter((x) => x.id !== m.id);
  let i = without.length;
  while (i > 0 && without[i - 1]!.at > m.at) i--;
  return [...without.slice(0, i), m, ...without.slice(i)];
}

/** 다시 받은 최근 글과 이미 가진 글(더 오래된 쪽·아직 서버에 없는 쪽)을 합친다. */
export function mergeMessages(local: Message[], fresh: Message[]): Message[] {
  const ids = new Set(fresh.map((m) => m.id));
  return local.filter((m) => !ids.has(m.id)).reduce(upsertMessage, fresh);
}

/**
 * 끊긴 동안 한 쪽 분량을 넘게 쌓였는지. 그러면 가진 글과 받은 글 사이에 틈이 있다.
 * 옛 글을 버리고 새 글부터 다시 시작해야 위로 스크롤해서 이어 받을 수 있다.
 */
export function hasMessageGap(local: Message[], fresh: Message[], pageSize: number): boolean {
  if (fresh.length < pageSize) return false;
  const known = local.filter((m) => m.delivery !== "failed" && m.delivery !== "queued");
  const newest = known.at(-1);
  const oldestFresh = fresh[0];
  if (!newest || !oldestFresh) return false;
  return !fresh.some((m) => m.id === newest.id) && newest.at < oldestFresh.at;
}

/** 소켓이 이만큼 조용하면 망이 바뀌어 멈춘 것으로 본다. 서버는 15초마다 신호를 보낸다. */
export const WS_STALE_MS = 45_000;
const WS_PING_MS = 20_000;
export const isSocketStale = (lastSeen: number, now: number): boolean => now - lastSeen > WS_STALE_MS;

const DECISION_RANK: Record<DecisionStatus, number> = { open: 0, answered: 1, delivered: 2, closed: 3 };

// REST 응답과 이벤트는 다른 길로 온다. 먼저 만들어진 응답이 뒤늦게 도착해 '받음'을 '보냄'으로 되돌리면 안 된다.
function upsertNewer<T extends { id: string; updatedAt: string }>(list: T[], item: T): T[] {
  const cur = list.find((x) => x.id === item.id);
  return cur && cur.updatedAt > item.updatedAt ? list : upsert(list, item);
}

/**
 * 결재는 되돌아갈 수 있다(전달 실패 → answered → 다시 open). 순위로만 막으면 서버가 다시 연 카드가 화면에 '받음'으로 남아 답할 수 없다.
 * 판 번호(updatedAt)로 새 값과 늦게 온 응답을 가른다. 번호가 없는 값(옛 서버)만 순위로 본다.
 */
function upsertDecision(list: Decision[], item: Decision): Decision[] {
  const cur = list.find((x) => x.id === item.id);
  if (!cur) return upsert(list, item);
  if (cur.updatedAt && item.updatedAt) return cur.updatedAt > item.updatedAt ? list : upsert(list, item);
  return DECISION_RANK[cur.status] > DECISION_RANK[item.status] ? list : upsert(list, item);
}

/** 처리된 결재 전체 수는 받을 때의 값이다. 눈앞에서 열림↔처리로 바뀐 만큼만 고친다(모르던 옛 결재는 이미 세어져 있다). */
function doneDelta(list: Decision[], item: Decision): number {
  const cur = list.find((x) => x.id === item.id);
  if (!cur || (upsertDecision(list, item).find((x) => x.id === item.id) === cur)) return 0;
  return Number(item.status !== "open") - Number(cur.status !== "open");
}

export function applyToProject(p: ProjectState, e: WsEvent): ProjectState {
  const id = p.project.id;
  switch (e.type) {
    case "project":
      return e.project.id === id && e.project.updatedAt >= p.project.updatedAt ? { ...p, project: e.project } : p;
    case "member":
      return e.member.projectId === id ? { ...p, members: upsertNewer(p.members, e.member) } : p;
    case "member_removed":
      return e.projectId === id ? { ...p, members: p.members.filter((m) => m.id !== e.memberId) } : p;
    case "decision":
      if (e.decision.projectId !== id) return p;
      return { ...p, decisions: upsertDecision(p.decisions, e.decision), doneDecisionCount: p.doneDecisionCount + doneDelta(p.decisions, e.decision) };
    case "todo":
      return e.todo.projectId === id ? { ...p, todos: upsert(p.todos, e.todo) } : p;
    case "work":
      return e.projectId === id ? { ...p, work: e.work } : p;
    case "message":
      return e.message.projectId === id ? { ...p, messages: upsertMessage(p.messages, e.message) } : p;
    case "file":
      return e.file.projectId === id ? { ...p, files: upsert(p.files, e.file) } : p;
    default:
      return p;
  }
}

function applyToBootstrap(b: Bootstrap, e: WsEvent): Bootstrap {
  switch (e.type) {
    case "projects":
      return { ...b, projects: e.projects };
    case "project":
      return {
        ...b,
        projects: b.projects.map((s) =>
          s.id === e.project.id
            ? { ...s, name: e.project.name, cwd: e.project.cwd, now: e.project.now, runnerEnabled: e.project.runnerEnabled, connection: e.project.connection }
            : s,
        ),
      };
    case "settings":
      return { ...b, settings: e.settings };
    case "herdr":
      return { ...b, herdr: e.herdr };
    default:
      return b;
  }
}

const ACTIVITY_CAP = 500;

export function reduce(s: AppState, e: WsEvent): AppState {
  let next = s;
  if (s.bootstrap) {
    const bootstrap = applyToBootstrap(s.bootstrap, e);
    if (bootstrap !== s.bootstrap) next = { ...next, bootstrap };
  }
  if (s.project) {
    const project = applyToProject(s.project, e);
    if (project !== s.project) next = { ...next, project };
  }
  if (e.type === "activity" && s.activity[e.activity.memberId]) {
    const list = s.activity[e.activity.memberId]!;
    if (!list.some((a) => a.id === e.activity.id)) {
      next = { ...next, activity: { ...s.activity, [e.activity.memberId]: [...list, e.activity].slice(-ACTIVITY_CAP) } };
    }
  }
  return next;
}

// ---- 저장소 ----

let state: AppState = {
  auth: "checking",
  authError: null,
  connection: "connecting",
  bootstrap: null,
  route: { projectId: HQ_ID, tab: "home", sub: null, settings: false },
  project: null,
  projectLoading: false,
  projectError: null,
  hasOlderMessages: false,
  activity: {},
  notice: null,
};

const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
function set(patch: Partial<AppState> | AppState): void {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

export const getState = (): AppState => state;

/** 고른 값이 같으면 다시 그리지 않는다. 선택 함수는 새 객체를 만들지 말 것. */
export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}
export const useProject = (): ProjectState | null => useStore((s) => s.project);
export const useRoute = (): Route => useStore((s) => s.route);
export const useBootstrap = (): Bootstrap | null => useStore((s) => s.bootstrap);
export const useSummary = (): ProjectSummary | null =>
  useStore((s) => s.bootstrap?.projects.find((p) => p.id === s.route.projectId) ?? null);
export function findMember(p: ProjectState | null, id: string | null | undefined): Member | null {
  return (id && p?.members.find((m) => m.id === id)) || null;
}

// ---- 동기화 ----

const MSG_PAGE = 200;
const RECONNECT_MIN = 500;
const RECONNECT_MAX = 15_000;
const RESYNC_RETRY = 3_000;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let resyncTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = RECONNECT_MIN;
let wanted = false; // 로그아웃·접속 코드 거부 뒤에는 다시 잇지 않는다
let syncToken = 0; // 가장 최근 동기화만 결과를 쓴다
let buffered: WsEvent[] | null = null; // 동기화 중 도착한 이벤트
let lastSeen = 0; // 소켓에서 마지막으로 무엇이든 받은 시각
let staleTimer: ReturnType<typeof setInterval> | null = null;

function handleEvent(e: WsEvent): void {
  if (e.type === "hello" || e.type === "ping") return;
  if (buffered) buffered.push(e);
  const next = reduce(state, e);
  if (next !== state) set(next);
  if (e.type === "projects") leaveIfArchived();
}

/** 다른 기기에서 보관하면 제목이 빈 채 보관된 프로젝트에 계속 지시하게 된다. */
function leaveIfArchived(): void {
  const { route, bootstrap } = state;
  if (!bootstrap || route.projectId === HQ_ID || route.settings) return;
  if (bootstrap.projects.some((p) => p.id === route.projectId)) return;
  set({ notice: "보던 프로젝트가 보관되어 본사로 돌아왔습니다" });
  navigate({ projectId: HQ_ID, tab: "home" }, { replace: true });
}

export function clearNotice(): void {
  if (state.notice) set({ notice: null });
}

/** bootstrap 과 현재 프로젝트를 함께 다시 받는다. 받는 동안 온 이벤트는 받은 값 위에 다시 입힌다. */
export async function refresh(): Promise<void> {
  const token = ++syncToken;
  const projectId = state.route.projectId;
  const sameProject = state.project?.project.id === projectId;
  buffered = [];
  if (!sameProject) set({ project: null, projectLoading: true, projectError: null, hasOlderMessages: false });
  if (resyncTimer) {
    clearTimeout(resyncTimer);
    resyncTimer = null;
  }

  const [boot, proj] = await Promise.allSettled([api.bootstrap(), api.projectState(projectId)]);
  if (token !== syncToken) return;
  const pending = buffered ?? [];
  buffered = null;

  if (boot.status === "rejected") {
    // 401 은 setUnauthorizedHandler 가 이미 처리했다
    if (!isUnauthorized(boot.reason)) {
      const text = errorText(boot.reason);
      set({
        projectLoading: false,
        projectError: state.project ? null : text,
        authError: state.auth === "need_code" ? text : null,
        connection: ws ? state.connection : "offline",
      });
      scheduleResync();
    }
    return;
  }

  let next: AppState = { ...state, auth: "ok", authError: null, bootstrap: boot.value, projectLoading: false };

  if (proj.status === "fulfilled") {
    const fresh = proj.value;
    const local = next.project?.project.id === projectId ? next.project.messages : [];
    const gap = hasMessageGap(local, fresh.messages, MSG_PAGE);
    next = {
      ...next,
      // 틈이 있으면 옛 글을 버린다. 아직 서버에 없는 내 글(실패·보내는 중)만 남긴다.
      project: { ...fresh, messages: mergeMessages(gap ? local.filter((m) => m.mine && (m.delivery === "failed" || m.delivery === "queued")) : local, fresh.messages) },
      projectError: null,
      hasOlderMessages: gap || local.length === 0 ? fresh.messages.length >= MSG_PAGE : next.hasOlderMessages,
    };
  } else if (proj.reason instanceof ApiError && proj.reason.status === 404) {
    // 없는 프로젝트(주소를 직접 쳤거나 보관됨)면 본사로 돌린다
    if (projectId !== HQ_ID) {
      // 설정 화면에서는 돌아갈 곳만 본사로 바꾼다. 주소는 #/settings 그대로다(거기서 보던 프로젝트를 보관한 경우).
      if (next.route.settings) {
        set({ ...next, route: { ...next.route, projectId: HQ_ID, tab: "home" } });
        void refresh();
        return;
      }
      set(next);
      navigate({ projectId: HQ_ID, tab: "home" }, { replace: true });
      return;
    }
    next = { ...next, projectError: errorText(proj.reason) };
  } else {
    next = { ...next, projectError: next.project ? null : errorText(proj.reason) };
    scheduleResync();
  }

  for (const e of pending) next = reduce(next, e);
  set(next);
  leaveIfArchived();
  if (wanted && !ws) connect();
}

function scheduleResync(): void {
  if (resyncTimer || !wanted) return;
  resyncTimer = setTimeout(() => {
    resyncTimer = null;
    void refresh();
  }, RESYNC_RETRY);
}

function connect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws || !wanted) return;
  set({ connection: state.connection === "offline" ? "offline" : "connecting" });
  let sock: WebSocket;
  try {
    sock = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  ws = sock;
  sock.onopen = () => {
    if (ws !== sock) return;
    lastSeen = Date.now();
    reconnectDelay = RECONNECT_MIN;
    set({ connection: "online" });
    void refresh();
  };
  sock.onmessage = (ev) => {
    if (ws !== sock || typeof ev.data !== "string") return;
    lastSeen = Date.now();
    let parsed: WsEvent;
    try {
      parsed = JSON.parse(ev.data) as WsEvent;
    } catch {
      return; // 형식이 어긋난 한 건 때문에 연결을 버리지 않는다
    }
    handleEvent(parsed);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    if (!wanted) return;
    set({ connection: "offline" });
    scheduleReconnect();
    // 브라우저는 소켓이 거부된 까닭(401)을 알려 주지 않는다. REST 로 물어봐야 접속 코드가 바뀐 줄 안다.
    scheduleResync();
  };
  sock.onerror = () => sock.close();
}

/** 살아 있어 보여도 멈췄을 수 있는 소켓을 버리고 새로 잇는다. 닫힘 이벤트를 기다리지 않는다(멈춘 소켓은 안 온다). */
function replaceSocket(): void {
  const sock = ws;
  ws = null;
  sock?.close();
  reconnectDelay = RECONNECT_MIN;
  connect();
}

function watchSocket(): void {
  if (staleTimer) return;
  staleTimer = setInterval(() => {
    if (wanted && ws?.readyState === WebSocket.OPEN && isSocketStale(lastSeen, Date.now())) {
      set({ connection: "connecting" });
      replaceSocket();
    }
  }, 5000);
}

function scheduleReconnect(): void {
  if (reconnectTimer || !wanted) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
}

/** 지금 바로 다시 잇는다(연결 끊김 띠의 '다시 연결', 화면 복귀, 온라인 복귀). */
export function reconnectNow(): void {
  if (!wanted) {
    if (getAccessCode()) void startSession();
    return;
  }
  reconnectDelay = RECONNECT_MIN;
  if (!ws) connect();
  // 서버가 살아 있는데 소켓만 거부되면(접속 코드 변경) REST 만 그 까닭을 안다.
  if (state.connection === "offline") void refresh();
}

function disconnect(): void {
  wanted = false;
  syncToken++;
  buffered = null;
  for (const t of [reconnectTimer, resyncTimer]) if (t) clearTimeout(t);
  reconnectTimer = resyncTimer = null;
  const sock = ws;
  ws = null;
  sock?.close();
}

async function startSession(): Promise<void> {
  wanted = true;
  watchSocket();
  // 첨부 쿠키가 먼저다. 망 오류면 지난번 쿠키로 그리고, 끊김 표시는 refresh 가 맡는다.
  await api.filesSession().catch(() => {});
  if (!wanted) return; // 코드가 틀려 이미 나갔다
  await refresh();
}

// ---- 동작 ----

/** 접속 코드 확인. 맞으면 저장하고 동기화를 시작한다. 틀리면 authError 를 채운다. */
export async function login(code: string): Promise<boolean> {
  const trimmed = code.trim();
  if (!trimmed) {
    set({ authError: "접속 코드를 넣어 주세요" });
    return false;
  }
  // 한글 등은 헤더에 실을 수 없어 fetch 가 터지고, 그러면 "서버에 연결할 수 없습니다"로 잘못 보인다.
  if (!/^[\x21-\x7e]+$/.test(trimmed)) {
    set({ authError: "접속 코드가 맞지 않습니다" });
    return false;
  }
  setAccessCode(trimmed);
  set({ authError: null });
  await startSession();
  return state.auth === "ok";
}

const logoutHooks = new Set<() => void>();
/** 저장소 밖 메모리에 글을 든 모듈(입력칸 초안)이 함께 비우도록 등록한다. */
export function onLogout(fn: () => void): void {
  logoutHooks.add(fn);
}

const isSavedDraft = (key: string) => key.startsWith("iamceo.draft.") || key.startsWith("iamceo.memo.");

/** '이 기기에서 나가기'로 지워질 초안·메모 수. 확인 창에 알린다. */
export function savedDraftCount(): number {
  try {
    return Object.keys(localStorage).filter(isSavedDraft).length;
  } catch {
    return 0;
  }
}

export function logout(): void {
  disconnect();
  clearAccessCode();
  // 공용 기기에 쓰던 글을 남기지 않는다. 메모리에 든 글도 함께 지워야 같은 탭에서 다시 들어왔을 때 나타나지 않는다.
  for (const key of Object.keys(localStorage)) if (isSavedDraft(key)) localStorage.removeItem(key);
  for (const fn of logoutHooks) fn();
  set({ auth: "need_code", authError: null, bootstrap: null, project: null, connection: "connecting", activity: {} });
}

export function navigate(to: { projectId?: string; tab?: Tab; sub?: string | null; settings?: boolean }, opts: { replace?: boolean } = {}): void {
  const cur = state.route;
  const projectId = to.projectId ?? cur.projectId;
  const wantedTab = to.tab ?? cur.tab;
  const tab = tabsFor(projectId).includes(wantedTab) ? wantedTab : "home";
  const hash = routeHash({ projectId, tab, sub: to.sub ?? null, settings: to.settings ?? false });
  if (location.hash === hash) return;
  if (opts.replace) {
    history.replaceState(null, "", hash);
    syncRoute();
  } else {
    location.hash = hash; // hashchange 가 syncRoute 를 부른다
  }
}

function syncRoute(): void {
  const parsed = parseHash(location.hash);
  // 설정은 하나다. 주소에 프로젝트가 없어 돌아갈 곳은 보던 프로젝트를 잇는다(옛 #/settings/<id> 는 그 프로젝트로 돌아간다).
  if (parsed.settings && /^#\/?settings\/?$/.test(location.hash)) parsed.projectId = state.route.projectId;
  const canonical = routeHash(parsed);
  if (location.hash !== canonical) history.replaceState(null, "", canonical); // #/p/hq/team 같은 없는 탭, 빈 주소
  const route: Route = parsed.settings
    ? { ...state.route, projectId: parsed.projectId, tab: parsed.projectId === state.route.projectId ? state.route.tab : "home", settings: true, sub: null }
    : parsed;
  const changedProject = route.projectId !== state.route.projectId;
  set({ route });
  if (changedProject && state.auth === "ok") void refresh();
}

/** 낙관적으로 먼저 보이고 서버 응답·이벤트로 바꾼다. 실패하면 delivery='failed'. id 가 멱등 키라 재시도해도 안전하다. */
export async function sendMessage(
  req: { text: string; targetMemberId?: string | null; attachmentIds?: string[]; id?: string },
  extra: { targetName?: string | null; attachments?: Attachment[]; onRejected?: (e: ApiError) => boolean } = {},
): Promise<Message | null> {
  const p = state.project;
  if (!p) return null;
  const projectId = p.project.id;
  const id = req.id ?? newId();
  const body: SendMessageReq = { id, text: req.text, targetMemberId: req.targetMemberId ?? null, attachmentIds: req.attachmentIds ?? [] };
  const draft: Message = {
    id,
    projectId,
    at: new Date().toISOString(),
    mine: true,
    memberId: null,
    who: "나",
    kind: "나",
    title: "",
    body: req.text,
    targetMemberId: req.targetMemberId ?? null,
    targetName: extra.targetName ?? null,
    decisionId: null,
    fileId: null,
    attachments: extra.attachments ?? [],
    delivery: "queued",
    deliveryNote: null,
  };
  applyLocal({ type: "message", message: draft });
  try {
    const saved = await api.sendMessage(projectId, body);
    // 응답보다 이벤트가 먼저 왔으면(받음 등) 그쪽이 더 새 값이다
    const cur = state.project?.messages.find((m) => m.id === id);
    if (!cur || cur === draft) applyLocal({ type: "message", message: saved });
    return saved;
  } catch (e) {
    // 응답만 잃었고 서버가 받았다는 이벤트가 이미 왔으면 실패가 아니다.
    const cur = state.project?.messages.find((m) => m.id === id);
    if (cur && cur !== draft && cur.delivery !== "failed") return cur;
    // 서버가 받지 않겠다고 답했다(연결 없음). 부른 쪽이 글을 맡으면 낙관적으로 보인 줄을 걷는다. 실패 글로 남기면 보낸 줄 안다.
    if (e instanceof ApiError && extra.onRejected?.(e)) {
      const open = state.project;
      if (open?.project.id === projectId) set({ project: { ...open, messages: open.messages.filter((m) => m.id !== id) } });
      void refresh();
      return null;
    }
    applyLocal({ type: "message", message: { ...draft, delivery: "failed", deliveryNote: errorText(e) } });
    // 응답만 잃었을 수 있다. 서버에 물어 실패 표시를 바로잡는다.
    scheduleResync();
    return null;
  }
}

export async function loadOlderMessages(limit = 100): Promise<void> {
  const p = state.project;
  const oldest = p?.messages.find((m) => m.delivery !== "failed");
  if (!p || !oldest) return;
  const projectId = p.project.id;
  const older = await api.messages(projectId, { before: oldest.at, limit });
  if (state.project?.project.id !== projectId) return;
  set({
    project: { ...state.project, messages: older.reduce(upsertMessage, state.project.messages) },
    hasOlderMessages: older.length >= limit,
  });
}

/** 주소로 하나만 받아 온 옛 결재. 이어 받기의 기준으로 삼으면 그 사이를 건너뛴다. */
const singlyLoaded = new Set<string>();

/** 목록(처리된 최근 50건) 밖의 결재를 하나 받는다. 옛 대화의 링크가 갈 곳을 잃지 않게 한다. */
export async function loadDecision(id: string): Promise<void> {
  const decision = await api.decision(id);
  singlyLoaded.add(id);
  applyLocal({ type: "decision", decision });
}

/** 처리된 결재를 더 받는다. 더 있을 수 있으면 true. */
export async function loadOlderDecisions(limit = 50): Promise<boolean> {
  const p = state.project;
  if (!p) return false;
  const done = p.decisions.filter((d) => d.status !== "open" && !singlyLoaded.has(d.id));
  const oldest = done.map((d) => d.answeredAt ?? d.createdAt).sort()[0];
  const projectId = p.project.id;
  const rows = await api.doneDecisions(projectId, { before: oldest, limit });
  if (state.project?.project.id !== projectId) return false;
  set({ project: { ...state.project, decisions: rows.reduce((list, d) => (list.some((x) => x.id === d.id) ? list : [...list, d]), state.project.decisions) } });
  return rows.length >= limit;
}

/** 직원 활동을 처음 받고, 이후 이벤트로 이어 쌓는다. */
export async function loadActivity(memberId: string, limit = 200): Promise<void> {
  const rows = await api.activity(memberId, limit);
  const live = state.activity[memberId] ?? [];
  const ids = new Set(rows.map((a) => a.id));
  const merged = [...rows, ...live.filter((a) => !ids.has(a.id))].sort((a, b) => a.id - b.id).slice(-ACTIVITY_CAP);
  set({ activity: { ...state.activity, [memberId]: merged } });
}

/** REST 응답을 이벤트와 같은 길로 바로 반영한다. 예: applyLocal({type:'decision', decision}) */
export function applyLocal(e: WsEvent): void {
  handleEvent(e);
}

/** 평문 http(Tailscale IP 접속)에서는 crypto.randomUUID 가 없다. */
export function newId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 앱 시작 때 한 번 부른다. */
export function initStore(): void {
  setUnauthorizedHandler(() => {
    if (!wanted) return; // 동시에 나간 요청들이 한꺼번에 거부된다
    const hadSession = state.auth === "ok";
    disconnect();
    clearAccessCode();
    set({
      auth: "need_code",
      authError: hadSession ? "접속 코드가 바뀌었습니다. 다시 넣어 주세요" : "접속 코드가 맞지 않습니다",
      bootstrap: null,
      project: null,
      projectLoading: false,
    });
  });
  window.addEventListener("hashchange", syncRoute);
  // 폰이 잠들었다 깨면 소켓이 조용히 죽어 있거나 그동안의 이벤트를 놓쳤을 수 있다
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !wanted) return;
    if (ws?.readyState !== WebSocket.OPEN) reconnectNow();
    // 신호가 한 번 이상 안 왔으면 망이 바뀌어 멈췄을 수 있다. 소켓까지 새로 잇는다(열리면 다시 받는다).
    else if (Date.now() - lastSeen > WS_PING_MS) replaceSocket();
    else void refresh();
  });
  // 망이 돌아왔으면 살아 있어 보여도 옛 경로의 소켓이다. 닫힘 이벤트는 오지 않는다.
  window.addEventListener("online", () => {
    if (wanted && ws) replaceSocket();
    else reconnectNow();
  });

  syncRoute();
  if (getAccessCode()) void startSession();
  else set({ auth: "need_code" });
}
