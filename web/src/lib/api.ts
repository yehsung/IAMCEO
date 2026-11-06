// REST 클라이언트 + 접속 코드 저장. 계약: docs/spec.md §3. 접속 코드는 이 기기 localStorage 에만 둔다.
import type {
  Activity,
  AnswerApprovalReq,
  AnswerReq,
  ApprovalPrompt,
  Attachment,
  Bootstrap,
  CreateProjectReq,
  CreateMemberReq,
  RuntimeInfo,
  Decision,
  Member,
  Message,
  PatchMemberReq,
  PatchProjectReq,
  Project,
  ProjectState,
  SendMessageReq,
  Settings,
  SettingsPatch,
  TidyResult,
  Todo,
} from "@shared/types";

const CODE_KEY = "iamceo.accessCode";

export function getAccessCode(): string | null {
  try {
    return localStorage.getItem(CODE_KEY);
  } catch {
    return null; // 사파리 개인정보 모드 등
  }
}

export function setAccessCode(code: string): void {
  localStorage.setItem(CODE_KEY, code);
}

export function clearAccessCode(): void {
  try {
    localStorage.removeItem(CODE_KEY);
  } catch {
    // 저장소를 못 쓰는 환경에서는 지울 것도 없다
  }
  // 첨부 쿠키는 HttpOnly 라 서버가 지운다. 실패해도 쿠키는 첨부에만 통하고 코드가 바뀌면 무효다.
  void fetch("/api/files-session", { method: "DELETE" }).catch(() => {});
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const isUnauthorized = (e: unknown): boolean => e instanceof ApiError && e.status === 401;

/** 화면에 보여 줄 한 줄. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.status === 0 ? "서버에 연결할 수 없습니다" : e.message;
  return e instanceof Error ? e.message : String(e);
}

let onUnauthorized: () => void = () => {};
/** 저장된 코드가 거부되면(401) 부른다. store 가 접속 코드 화면으로 돌린다. */
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

/** 망이 멈추면 응답도 끊김도 오지 않아 버튼이 말없이 잠긴다(실측: 200초에도 안 끝남). 시간이 지나면 실패로 치고 기존 재시도·재동기화를 탄다. 결재·지시는 멱등이라 다시 보내도 안전하다. */
const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 20_000;
/** 세션을 띄우는 요청. 서버의 띄우기 시간 상한(120초)보다 길게 둔다. */
const SLOW_TIMEOUT_MS = 150_000;

async function request<T>(method: string, path: string, body?: unknown, timeoutMs: number | null = method === "GET" ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS): Promise<T> {
  const headers: Record<string, string> = {};
  const code = getAccessCode();
  if (code) headers.Authorization = `Bearer ${code}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body; // 경계 문자열은 브라우저가 Content-Type 에 넣는다
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const abort = new AbortController();
  const timer = timeoutMs === null ? null : setTimeout(() => abort.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload, signal: abort.signal });
  } catch (e) {
    throw new ApiError(0, e instanceof Error ? e.message : "network error");
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) {
    if (res.status === 401) onUnauthorized();
    throw new ApiError(res.status, await readError(res));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function readError(res: Response): Promise<string> {
  const fallback = `요청 실패 (${res.status})`;
  try {
    const text = await res.text();
    if (!text) return fallback;
    try {
      const j = JSON.parse(text) as { error?: unknown; message?: unknown };
      const m = j.error ?? j.message;
      return typeof m === "string" && m ? m : fallback;
    } catch {
      return text.length <= 200 ? text : fallback;
    }
  } catch {
    return fallback;
  }
}

const seg = encodeURIComponent;
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body);
const slowPost = <T>(path: string, body?: unknown) => request<T>("POST", path, body, SLOW_TIMEOUT_MS);
const get = <T>(path: string) => request<T>("GET", path);

export const api = {
  bootstrap: () => get<Bootstrap>("/api/bootstrap"),
  runtime: () => get<RuntimeInfo>("/api/runtime"),
  /** <img>·<video> 가 쓸 첨부 쿠키를 받는다. 화면을 그리기 전에 부른다. */
  filesSession: () => post<void>("/api/files-session"),

  projectState: (id: string) => get<ProjectState>(`/api/projects/${seg(id)}/state`),
  archivedProjects: () => get<Project[]>("/api/projects/archived"),
  createProject: (req: CreateProjectReq) => slowPost<Project>("/api/projects", req),
  patchProject: (id: string, req: PatchProjectReq) => request<Project>("PATCH", `/api/projects/${seg(id)}`, req, SLOW_TIMEOUT_MS),
  createMember: (id: string, req: CreateMemberReq) => slowPost<Member>(`/api/projects/${seg(id)}/members`, req),
  startConductor: (id: string) => slowPost<Member>(`/api/projects/${seg(id)}/conductor/start`),

  messages: (id: string, opts: { before?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.before) q.set("before", opts.before);
    if (opts.limit) q.set("limit", String(opts.limit));
    const s = q.toString();
    return get<Message[]>(`/api/projects/${seg(id)}/messages${s ? `?${s}` : ""}`);
  },
  sendMessage: (id: string, req: SendMessageReq) => post<Message>(`/api/projects/${seg(id)}/messages`, req),

  /** to 를 주면 서버가 받기 전에 연결부터 본다(끝까지 올린 뒤 보내기에서 거부당하지 않게). */
  upload: (file: File | Blob, name?: string, to?: { project: string; target?: string | null }) => {
    const form = new FormData();
    if (name !== undefined) form.append("file", file, name);
    else form.append("file", file);
    const q = new URLSearchParams();
    if (to) q.set("project", to.project);
    if (to?.target) q.set("target", to.target);
    const s = q.toString();
    return request<Attachment>("POST", `/api/uploads${s ? `?${s}` : ""}`, form, null); // 50MB 까지라 시간을 정할 수 없다
  },

  decision: (decisionId: string) => get<Decision>(`/api/decisions/${seg(decisionId)}`),
  doneDecisions: (projectId: string, opts: { before?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.before) q.set("before", opts.before);
    if (opts.limit) q.set("limit", String(opts.limit));
    const s = q.toString();
    return get<Decision[]>(`/api/projects/${seg(projectId)}/decisions${s ? `?${s}` : ""}`);
  },
  answer: (decisionId: string, req: AnswerReq) => post<Decision>(`/api/decisions/${seg(decisionId)}/answer`, req),
  todoDone: (todoId: string, done: boolean) => post<Todo>(`/api/todos/${seg(todoId)}/done`, { done }),
  /** AI 가 닫은 결재를 다시 연다. 결재할 항목으로 돌아간다. */
  reopenDecision: (decisionId: string) => post<Decision>(`/api/decisions/${seg(decisionId)}/reopen`),
  /** 총괄에게 판 정리를 맡긴다. 총괄이 없거나 잠들었으면 띄우므로 오래 걸릴 수 있다. */
  tidy: (projectId: string) => slowPost<TidyResult>(`/api/projects/${seg(projectId)}/tidy`),

  activity: (memberId: string, limit?: number) =>
    get<Activity[]>(`/api/members/${seg(memberId)}/activity${limit ? `?limit=${limit}` : ""}`),
  screen: (memberId: string) => get<{ text: string }>(`/api/members/${seg(memberId)}/screen`),
  sleep: (memberId: string, force = false) => slowPost<Member>(`/api/members/${seg(memberId)}/sleep`, force ? { force: true } : undefined),
  freshSession: (memberId: string) => slowPost<Member>(`/api/members/${seg(memberId)}/fresh-session`),
  resume: (memberId: string) => slowPost<Member>(`/api/members/${seg(memberId)}/resume`),
  compact: (memberId: string) => post<Member>(`/api/members/${seg(memberId)}/compact`),
  interrupt: (memberId: string) => post<Member>(`/api/members/${seg(memberId)}/interrupt`),
  closeMember: (memberId: string) => post<{ ok: boolean }>(`/api/members/${seg(memberId)}/close`),
  /** herdr 칸에 뜬 권한 승인 창. 승인 창 앞이 아니거나 승인 창으로 알아보지 못하면 null(터미널에서 푼다). */
  approval: (memberId: string) => get<{ approval: ApprovalPrompt | null }>(`/api/members/${seg(memberId)}/approval`),
  /** 고른 선택지를 칸에서 누른다. 서버가 누르기 직전에 다시 읽어 fingerprint 가 다르면 409. note 는 거절일 때만. */
  answerApproval: (memberId: string, req: AnswerApprovalReq) => post<{ ok: true }>(`/api/members/${seg(memberId)}/approval`, req),

  /** 아티팩트 원본. 격리 칸(ArtifactFrame)에만 넣는다. */
  artifact: (fileId: string) => get<{ html: string }>(`/api/files/${seg(fileId)}/artifact`),

  patchMember: (memberId: string, patch: PatchMemberReq) => request<Member>("PATCH", `/api/members/${seg(memberId)}`, patch, SLOW_TIMEOUT_MS),
  putSettings: (patch: SettingsPatch) => request<Settings>("PUT", "/api/settings", patch),
};

/** <img>·<video>·<audio> 주소. 태그는 헤더를 못 붙이므로 filesSession 이 준 첨부 쿠키로 인증한다(§3). 주소에 접속 코드를 싣지 않는다. 내려받기는 saveAttachment. */
export function fileUrl(att: Pick<Attachment, "url">): string {
  return att.url;
}

/** 첨부를 헤더 인증으로 받는다. 주소에 접속 코드를 싣지 않으니 표·코드·PDF 처럼 내용을 스크립트로 다룰 때 쓴다. */
export async function fetchAttachment(att: Pick<Attachment, "url">, signal?: AbortSignal): Promise<Response> {
  const code = getAccessCode();
  let res: Response;
  try {
    res = await fetch(att.url, { headers: code ? { Authorization: `Bearer ${code}` } : {}, signal });
  } catch (e) {
    throw new ApiError(0, e instanceof Error ? e.message : "network error");
  }
  if (!res.ok) {
    if (res.status === 401) onUnauthorized();
    throw new ApiError(res.status, await readError(res));
  }
  return res;
}

/** 헤더 인증으로 받아 파일로 저장한다. 형식을 지워 어떤 문서로도 해석되지 않게 한다. */
export async function saveAttachment(att: Pick<Attachment, "url" | "name">): Promise<void> {
  const buf = await (await fetchAttachment(att)).arrayBuffer();
  const href = URL.createObjectURL(new Blob([buf], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = href;
  a.download = att.name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  // Safari 는 눌린 뒤에 blob 을 읽으므로 바로 지우지 않는다.
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

export function wsUrl(): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws?t=${seg(getAccessCode() ?? "")}`;
}
