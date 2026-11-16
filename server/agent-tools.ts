// 에이전트 도구 정의와 처리기(spec §7). 스키마는 zod 하나로 검증과 JSON 스키마를 함께 낸다.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { CONDUCTOR_TOOLS, fileKindOf, MANUAL_TOOLS, ROOT_TOOLS, WORKER_TOOLS, type Attachment, type FileKind, type Member } from "../shared/types.ts";
import { FilePublication, importPath, prepareImport, MAX_ARTIFACT_BYTES, MAX_UPLOAD_BYTES, type PreparedImport, type SavedFile } from "./files.ts";
import { createStorageReferences } from "./storage-maintenance.ts";
import { toStorageError } from "./storage-errors.ts";
import type { AgentToolDef, AgentToolResult, OrchestratorApi } from "./orchestrator-api.ts";
import type { AgentWorkflowService } from "./service-contracts.ts";
import type { AssignResult, Orchestrator, UrgentWaitReason } from "./orchestrator.ts";
import { sinceText } from "./delivery-text.ts";
import { josa } from "./roles.ts";
import { withRo } from "./api-outage.ts";
import { ApiError } from "./store.ts";
import { oneLineProblem } from "./text.ts";
import { canonicalPath as realOrSelf, isInside, isSecretPath, rejectHardLink, SECRET_DIRS } from "./secret-paths.ts";
import { textRef } from "../shared/server-text.ts";
import { changeProjectRule, listProjectRules, RULE_TEXT_MAX } from "./project-rules.ts";

type ToolName = (typeof WORKER_TOOLS | typeof CONDUCTOR_TOOLS | typeof ROOT_TOOLS | typeof MANUAL_TOOLS)[number];
type ToolHost = Orchestrator & Partial<AgentWorkflowService> & Pick<OrchestratorApi, "manualInbox" | "acknowledgeManualInbox">;

const WAIT_DEFAULT_SEC = 50;
// 서버 idleTimeout(255초)보다 짧아야 연결이 안 끊긴다.
const WAIT_MAX_SEC = 240;
const MARKDOWN_BODY_MAX_BYTES = 1024 * 1024;
const MARKDOWN_EXT = new Set([".md", ".markdown", ".txt"]);
const TEXT_BODY_KINDS = new Set<FileKind>(["table", "code"]);

function artifactBytes(html: string): number {
  return Buffer.byteLength(html, "utf8");
}

const text = z.string().trim().min(1);
/** 전달 글의 머리나 따옴표 안에 들어가는 값은 한 줄이어야 한다. 줄을 바꿔 출처 접두어를 지어낼 수 있다. */
const oneLine = (max: number) =>
  text.superRefine((value, ctx) => {
    const problem = oneLineProblem(value, max);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });
const oneLineOpt = (max: number) =>
  z.string().trim().superRefine((value, ctx) => {
    const problem = oneLineProblem(value, max);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });
const memberRef = text.describe("핸들 또는 화면 이름");
const userQuote = z.string().optional().describe("대표가 한 말 중 이 일에 해당하는 부분을 글자 그대로. 서버가 대조해 '서버 확인' 또는 '미확인'을 붙인다");

interface Tool<S extends z.ZodType = z.ZodType> {
  description: string;
  schema: S;
  run(orch: ToolHost, member: Member, args: z.output<S>, signal?: AbortSignal): AgentToolResult | Promise<AgentToolResult>;
}

function tool<S extends z.ZodType>(description: string, schema: S, run: Tool<S>["run"]): Tool<S> {
  return { description, schema, run };
}

function reply(text: string): AgentToolResult {
  return { text };
}

function expandPath(raw: string, base: string): string {
  const path = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

function statOrNull(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/**
 * file 도구는 승인 없이 돌고 결과가 화면과 uploads 로 간다. 없으면 직원이 접속 코드·토큰·개인 키를 복사해 읽을 수 있다.
 * 심볼릭 링크를 따라간 진짜 경로가 작업 폴더 안일 때만 허용한다.
 */
function requireReadable(orch: Orchestrator, member: Member, raw: string): string {
  const given = expandPath(raw, member.cwd);
  const path = realOrSelf(given);
  const roots = [member.cwd, orch.store.requireProject(member.projectId).cwd].map(realOrSelf);
  const home = realOrSelf(homedir());
  const covering = roots.filter((root) => isInside(path, root));
  // 작업 폴더가 홈이면(본사) 폴더 제한이 소용없다. 목록으로는 인증 파일을 다 못 막으므로 홈 바로 아래의 점 파일·점 폴더는 기본으로 막는다.
  const homeDot = covering.length > 0 && covering.every((root) => isInside(home, root)) && isInside(path, home) && path !== home && path.slice(home.length + 1).startsWith(".");
  const protectedRoots = orch.protectedFileRoots;
  const secret = isSecretPath(given, home, protectedRoots) || isSecretPath(path, home, protectedRoots, homeDot);
  if (secret) throw new ApiError(403, `이 경로는 자료로 올릴 수 없습니다(비밀이 있는 곳): ${path}`, "agent_path_secret");
  if (covering.length === 0) throw new ApiError(403, `작업 폴더 밖의 파일은 올릴 수 없습니다: ${path}. 작업 폴더로 옮긴 뒤 올리세요`, "agent_path_outside_workdir");
  // 하드 링크는 진짜 경로를 따라가도 원본을 알 수 없다. 작업 폴더 안의 이름으로 비밀을 읽는 길이 된다.
  const stat = statOrNull(path);
  if (stat) rejectHardLink(stat);
  // 검사한 경로 그대로 읽는다. 받은 경로를 다시 열면 그 사이 링크가 바뀔 수 있다.
  return path;
}

/**
 * team_add 의 작업 폴더. 총괄 혼자 프로젝트 밖이나 데이터 폴더에 세션을 만들지 못하게 한다(작업 폴더는 file 도구의 허용 범위이기도 하다).
 * 밖이 꼭 필요하면 대표가 그 경로를 글로 말해야 한다. 서버가 대표 글에서 대조한다.
 */
function requireMemberCwd(orch: Orchestrator, member: Member, raw: string, quote: string | undefined): string {
  const project = orch.store.requireProject(member.projectId);
  const given = expandPath(raw, project.cwd);
  const path = realOrSelf(given);
  const root = realOrSelf(project.cwd);
  const home = realOrSelf(homedir());
  const data = realOrSelf(orch.dataDir);
  const secret = isInside(path, data) || (path !== root && isInside(data, path)) || SECRET_DIRS.some((d) => isInside(path, join(home, d)));
  if (secret) throw new ApiError(403, `작업 폴더로 쓸 수 없습니다(비밀이 있는 곳): ${path}`, "agent_path_secret");
  if (isInside(path, root)) return path;
  const said = quote?.trim() && (quote.includes(raw.trim()) || quote.includes(path)) && orch.findQuoteSource(member.projectId, quote) !== null;
  if (said) return path;
  throw new ApiError(403, `프로젝트 폴더 밖입니다: ${path}. 필요하면 ask 로 대표에게 묻고, 대표가 그 경로를 글로 답하면 그 글을 user_quote 에 실어 다시 부르세요`, "agent_path_outside_project");
}

function prepareAttachment(orch: Orchestrator, member: Member, raw: string): PreparedImport {
  const path = requireReadable(orch, member, raw);
  const stat = statOrNull(path);
  if (!stat?.isFile()) throw new ApiError(400, `파일이 없습니다: ${path}`, "agent_file_missing");
  if (stat.size > MAX_UPLOAD_BYTES) throw new ApiError(413, `파일은 50MB 까지 올릴 수 있습니다: ${path}`, "file_too_large");
  return prepareImport(path);
}

async function attach(orch: Orchestrator, member: Member, raw: string): Promise<Attachment> {
  const input = prepareAttachment(orch, member, raw);
  return orch.store.createAttachment(await importPath(orch.uploadsDir, input.source));
}

/** 다른 직원에게 시키는 도구가 자기 자신을 가리키면 턴이 안 끝나는 대기열이나 자기 종료가 된다. */
function requireOther(orch: Orchestrator, self: Member, ref: string): Member {
  const target = orch.requireInProject(self.projectId, ref);
  if (target.id === self.id) throw new ApiError(400, "자기 자신은 지정할 수 없습니다", "agent_self_target");
  return target;
}

/** 0.2.7 묶음 1: 급한 지시로 하던 턴을 멈추지 못한 까닭(총괄에게 주는 글). */
const URGENT_WAIT_REASONS: Record<UrgentWaitReason, string> = {
  no_owner_quote: "대표 원문(user_quote, 서버 확인)이 실리지 않아",
  weak_quote: "인용이 결재 버튼 글·짧은 글처럼 대표가 이 일로 쓴 문장이 아니라",
  other_target: "인용한 대표 글이 다른 팀장에게 쓴 글이라",
  stale_quote: "인용한 대표 글이 30분보다 오래돼",
  quote_used: "그 대표 글로 이 팀장의 턴을 이미 한 번 멈췄기 때문에(같은 글로 두 번 멈추지 않음)",
  approval: "그 팀장이 승인 창 앞이라",
  usage_limit: "그 팀장이 사용 한도로 멈춰 있어",
  outage: "그 팀장이 인터넷 장애로 멈춰 있어",
  compacting: "그 팀장이 문맥 정리(압축) 중이라",
  manual_control: "대표가 그 터미널을 직접 조작하는 중이라",
  session_busy: "그 세션을 처리하는 중이라(띄우기·닫기·설정 적용 등)",
  receipt_check: "앞 전달을 받았는지 확인하는 중이라",
  not_managed: "서버가 다루는 세션이 아니라",
  no_turn: "서버가 넣은 일하는 턴이 없어(백그라운드 프로그램 등으로 CLI 가 바쁘게 보입니다)",
  busy_unconfirmed: "일하는 중인지 확인되지 않아(CLI 는 쉬는 중으로 보입니다)",
  interrupt_failed: "멈춤 키를 보내지 못해",
};
/** 0.2.7 묶음 1 검토: 멈출 턴이 없어 기다리는 까닭. '그 턴이 끝나야'가 아니라 '받을 수 있게 되면'이 맞다. */
const URGENT_NO_TURN: ReadonlySet<UrgentWaitReason> = new Set(["no_turn", "busy_unconfirmed"]);

function assignNote(result: AssignResult): string {
  const since = sinceText(result.busySince ?? null);
  const urgent = result.urgent;
  // 0.2.7 묶음 1(점검 D5-1): 급한 지시에 서버가 실제로 한 일을 그대로 알린다. 총괄이 대표에게 '급히 넣었다'고 잘못 말하지 않게 한다.
  // 0.2.7 배포 전 확인(real-cli P1·P2): Codex 의 턴은 끝났거나 멈췄지만 하던 명령·띄운 프로그램이 백그라운드 터미널로 계속 돌아 기다리는 경우. 그 명령이
  // 끝나거나 터미널에서 /stop 으로 닫아야 들어간다(IAMCEO 는 끄지 않는다). '그 턴이 끝나면'이라고 하면 총괄이 곧 들어간다고 잘못 알린다.
  const programs = urgent?.outcome === "background" ? urgent.terminals : result.backgroundPrograms ?? 0;
  const place = (urgent?.outcome === "background" || urgent?.outcome === "unconfirmed" && programs ? `대표의 급한 지시라 하던 턴을 멈추게 했습니다. 턴은 멈췄지만 실행하던 명령(백그라운드 터미널 ${programs}개)이 계속 돌고 있어, 그 명령이 끝나거나 대표가 터미널에서 /stop 으로 닫아야 이 지시가 맨 먼저 들어갑니다. IAMCEO는 그 명령을 끄지 않습니다. 대표에게 '바로 넣었다'고 하지 말고 이대로 알리세요`
    : urgent?.outcome === "waiting" && programs ? `급한 지시지만 그 팀장의 턴은 이미 끝났고 Codex가 띄운 백그라운드 프로그램(${programs}개)만 돌고 있어 멈출 턴이 없습니다. 그 프로그램이 끝나거나 대표가 터미널에서 /stop 으로 닫아야 맨 먼저 들어갑니다. IAMCEO는 그 프로그램을 끄지 않습니다. 대표에게 '바로 넣었다'고 하지 말고 이대로 알리세요`
    : programs && result.delivery.status !== "delivered" ? `턴은 끝났지만 Codex가 띄운 백그라운드 프로그램(${programs}개)이 남아 있어 기다립니다(대기열 ${Math.max(result.position, 1)}번째). 그 프로그램이 끝나거나 대표가 터미널에서 /stop 으로 닫아야 들어갑니다. IAMCEO는 그 프로그램을 끄지 않습니다`
    : urgent?.outcome === "interrupted" ? "대표의 급한 지시라 하던 턴을 멈추게 했습니다. 멈추는 대로 이 지시를 맨 먼저 넣습니다"
    : urgent?.outcome === "unconfirmed" ? `대표의 급한 지시라 하던 턴에 멈춤 키를 보냈지만, 바로 멈춘 것은 확인하지 못했습니다. 멈추거나 그 턴이 끝나는 대로 이 지시를 맨 먼저 넣습니다${since ? `(${since} 일하는 중)` : ""}. 대표에게 '바로 넣었다'고 하지 말고 이대로 알리세요`
    : urgent?.outcome === "waiting" ? `급한 지시지만 ${URGENT_WAIT_REASONS[urgent.reason]} 하던 턴을 멈추지 않았습니다. ${URGENT_NO_TURN.has(urgent.reason) ? `그 팀장이 받을 수 있게 되면 맨 먼저 들어갑니다${since ? `(${since} 기다리는 중)` : ""}` : `그 턴이 끝나야 맨 먼저 들어갑니다${since ? `(${since} 일하는 중)` : ""}`}. 대표에게 '바로 넣었다'고 하지 말고 이대로 알리세요`
    : result.position > 0 ? `일하는 중이라 대기열 ${result.position}번째입니다. 끝나면 서버가 넣습니다${since ? `(${since} 일하는 중)` : ""}` : result.delivery.status === "delivered" ? "전달했습니다" : "전달 대기 중입니다. 받을 수 있을 때 서버가 넣습니다") + ` · 전달 ${result.delivery.id}`;
  if (result.verified === null) return place;
  if (result.needsContext) return `${place}. 인용이 버튼 글이나 짧은 글이라 '문맥 확인 필요'로 전달됩니다. 직원은 이 줄만으로 승인으로 치지 않으니, 승인이 필요한 일이면 대표의 문장을 인용하세요`;
  return result.verified ? `${place}. 인용은 대표 글과 맞아 서버 확인으로 전달됩니다` : `${place}. 인용을 대표 글에서 찾지 못해 미확인으로 전달됩니다. 직원은 이것을 승인으로 치지 않습니다`;
}

/**
 * 0.2.7 묶음 4(D3-7): '메모에 적음'처럼 메모가 있어야 뜻이 되는 선택지. ask 의 needs_note 가 없으면 버튼 글로 정한다.
 * 켤 때만 needsNote 를 싣는다(보통 선택지의 모양은 그대로). 잘못 켜면 출시 앱의 답이 400 으로 막히므로 좁게 본다:
 * 대표가 메모에 무엇을 적는다는 꼴('메모에 적음'·'메모로 알려 줄게'·'(메모)'·'메모 참고'·'see my note')만 켜고,
 * 메모가 필요 없다는 꼴('메모는 필요 없어요'·'메모 안 써도 돼'·'메모 없이')과 앞 메모를 가리키는 꼴('앞 메모 그대로'·'메모대로')은 끈다.
 * 'notes' 가 다른 뜻인 글('릴리스 notes 확인 뒤 배포')은 켜지 않는다.
 */
const MEMO_ON = /메모\s*(?:에|로|란|칸|를|을)|\(\s*메모|메모\s*(?:참고|참조|확인)|^\s*메모\s*$|\b(?:in|see|per|check|read)\s+(?:the|my|a)\s+(?:notes?|memo)\b|\b(?:notes?|memo)\s+(?:below|attached)\b|\b(?:wr(?:ite|ote|itten)|add|leave|left)\b.*\b(?:notes?|memo)\b/i;
const MEMO_OFF = /메모\s*(?:는|도|를|을)?\s*(?:필요\s*(?:없|하지\s*않)|불필요|안\s*(?:써|쓰|적|남|달)|않아도|없이|생략|대로|그대로)|(?:앞|이전|지난|위)\s*메모|\b(?:no|without|skip)\s+(?:a\s+|the\s+)?(?:notes?|memo)\b|\b(?:notes?|memo)\s+(?:is\s+)?(?:not\s+)?(?:needed|required|optional)\b/i;
export function needsNoteOf(option: { label: string; needs_note?: boolean }): boolean {
  return option.needs_note ?? (MEMO_ON.test(option.label) && !MEMO_OFF.test(option.label));
}

/** 완료 칸은 길어진다. 판을 맞출 때는 최근 것만 보면 된다. */
const BOARD_DONE_MAX = 10;

/** board 의 결과. 날짜는 ISO. */
function boardView(orch: Orchestrator, projectId: string) {
  const project = orch.store.requireProject(projectId);
  const work = orch.store.listWork(projectId);
  const done = work.filter((w) => w.sec === "done").sort((a, b) => (b.doneAt ?? b.updatedAt).localeCompare(a.doneAt ?? a.updatedAt));
  return {
    lastTidyAt: project.tidiedAt,
    now: project.now,
    nowAt: project.nowAt,
    decisions: orch.store.listOpenDecisions(projectId).map((d) => ({ id: d.id, title: d.title, who: d.who, createdAt: d.createdAt, group: d.group })),
    todos: orch.store
      .listTodos(projectId)
      .filter((t) => !t.done)
      .map((t) => ({ id: t.id, title: t.title, who: t.who, createdAt: t.createdAt })),
    work: [...work.filter((w) => w.sec !== "done"), ...done.slice(0, BOARD_DONE_MAX)].map((w) => ({ id: w.id, sec: w.sec, title: w.title, updatedAt: w.updatedAt })),
    ...(done.length > BOARD_DONE_MAX ? { olderDone: done.length - BOARD_DONE_MAX } : {}),
  };
}

const TOOLS: Record<ToolName, Tool<any>> = {
  status: tool(
    "지금 하는 일을 일상어 한 줄로 적는다. 일을 시작하거나 바뀔 때마다 부른다. 대표 팀 화면에 보인다.",
    z.strictObject({ now: oneLine(500).describe("지금 하는 일(한 줄)"), next: oneLineOpt(500).optional().describe("다음에 할 일(한 줄)") }),
    (orch, member, a) => {
      orch.setMemberStatus(member, a.now, a.next);
      return reply("적었습니다");
    },
  ),

  ask: tool(
    "대표의 판단·승인이 필요할 때 결재함에 카드를 올린다. AskUserQuestion 대신 이것을 쓴다. 결과 글이 턴을 끝내라고 하면 바로 턴을 끝낸다. 답은 다음 입력으로 온다.",
    z.strictObject({
      title: oneLine(200).describe("무엇을 정하는지 한 줄"),
      detail: text.describe("카드만 읽고 고를 수 있는 배경·사실·위험과 왜 지금 정해야 하는지(마크다운). 내부 번호·개발 용어는 풀어 쓴다"),
      options: z
        .array(z.strictObject({ k: oneLine(64).describe("선택지 키"), label: oneLine(120).describe("버튼 글(한 줄). 그대로 대표 원문이 된다"), desc: oneLineOpt(300).optional().describe("고르면 어떻게 되는지(한 줄)"),
          needs_note: z.boolean().optional().describe("이 선택지를 고르면 대표가 메모(또는 첨부)를 꼭 붙여야 할 때 true('메모에 적음' 등). 생략하면 버튼 글이 '메모에 적음'처럼 메모에 적는다는 뜻일 때 켠다") }))
        .optional()
        .describe("비우면 자유 답"),
      rec: z.string().optional().describe("권장 선택지의 k"),
      group: oneLineOpt(80).optional().describe("묶음 이름"),
      file_id: z.string().optional().describe("근거 자료 id(file 도구의 결과)"),
      images: z.array(z.string()).max(10).optional().describe("카드에 바로 보일 이미지 파일 경로(시안 캡처 등). 작업 폴더 안의 파일"),
      replaces: text.optional().describe("이 카드가 대신할 내 열린 결재 id(d_...). 고쳐 다시 물을 때 쓴다. 앞 카드는 서버가 함께 닫고(대체됨) 새 카드에 잇는다. ask_close 를 따로 부르지 않는다"),
    }),
    async (orch, member, a) => {
      const keys = (a.options ?? []).map((o: { k: string }) => o.k);
      if (new Set(keys).size !== keys.length) throw new ApiError(400, "선택지 k 가 겹칩니다", "decision_option_duplicate");
      if (a.rec && !keys.includes(a.rec)) throw new ApiError(400, `권장 선택지가 선택지에 없습니다: ${a.rec}`, "decision_rec_missing");
      if (a.file_id && orch.store.getFile(a.file_id)?.projectId !== member.projectId) throw new ApiError(404, `자료를 찾을 수 없습니다: ${a.file_id}`, "file_not_found");
      const images: Attachment[] = [];
      for (const image of a.images ?? []) {
        const attachment = await attach(orch, member, image);
        if (!attachment.isImage) throw new ApiError(400, `이미지가 아닙니다: ${image}`, "not_an_image");
        images.push(attachment);
      }
      const options = (a.options as { k: string; label: string; desc?: string; needs_note?: boolean }[] | undefined)?.map(({ needs_note, ...option }) => needsNoteOf({ label: option.label, needs_note }) ? { ...option, needsNote: true } : option);
      const { decision, blocking, text } = await orch.registerAsk(member, { title: a.title, detail: a.detail, options, rec: a.rec, group: a.group, fileId: a.file_id, images, replaces: a.replaces });
      return blocking ? { text, wait: { decisionId: decision.id } } : { text };
    },
  ),

  post: tool(
    "대화에 보고를 남긴다. 완료·막힘은 턴을 마치기 전에 반드시, 진행·알림은 필요할 때. 질문은 ask 로 한다. report_id만 주면 같은 프로젝트 보고의 원본·전체 자료·결재·작성 순서·정정 관계를 조회한다(게시하지 않는다).",
    z.strictObject({
      report_id: text.optional().describe("조회할 보고 원본 메시지 id. 조회할 때는 이 필드만 준다"),
      kind: z.enum(["완료", "진행", "막힘", "알림"]).optional(),
      title: oneLine(300).optional().describe("대표가 읽을 결과 핵심 한 문장(무엇이 어떻게 됐는지). 시각·번호·이름만 이어 붙이지 않는다"),
      body: z.string().optional().describe("결과 핵심, 바뀐 파일·커밋, 대표가 확인하거나 정할 것(마크다운)"),
      file_ids: z.array(z.string()).optional().describe("이어 줄 자료 id"),
      decision_id: z.string().optional().describe("이어 줄 결재 id"),
      group: oneLineOpt(80).optional().describe("같은 업무의 결재 묶음 이름(ask의 group과 같은 값)"),
      supersedes: text.optional().describe("정정할 자신의 이전 보고 ID; corrects_message_id와 같은 의미"),
      corrects_message_id: text.optional().describe("정정할 자신의 이전 보고 원본 메시지 id"),
    }).superRefine((a, ctx) => {
      if (a.report_id !== undefined) {
        if ([a.kind, a.title, a.body, a.file_ids, a.decision_id, a.group, a.corrects_message_id, a.supersedes].some(v => v !== undefined)) ctx.addIssue({ code: "custom", message: "report_id 조회와 보고 게시 인자는 함께 줄 수 없습니다" });
      } else if (a.kind === undefined || a.title === undefined) ctx.addIssue({ code: "custom", message: "보고 게시에는 kind와 title이 필요합니다" });
    }),
    async (orch, member, a) => {
      if (a.report_id !== undefined) {
        if (!orch.reportReferences) throw new ApiError(501, "보고 참조 조회를 지원하지 않습니다", "report_lookup_unsupported");
        const refs = orch.reportReferences(member.projectId, a.report_id);
        const source = orch.store.requireMessage(refs.sourceMessageId);
        if (source.projectId !== member.projectId) throw new ApiError(404, "보고를 찾을 수 없습니다", "report_not_found");
        const files = refs.fileIds.map(id => {
          const file = orch.store.getFile(id);
          if (!file || file.projectId !== member.projectId) throw new ApiError(404, `자료를 찾을 수 없습니다: ${id}`, "file_not_found");
          return { id: file.id, title: file.title, summary: file.summary, body: file.body, kind: file.kind, attachments: file.attachments, ...(file.kind === "artifact" ? { html: orch.store.getFileHtml(file.id) } : {}) };
        });
        return reply(JSON.stringify({ ...refs, source, files }));
      }
      if (a.kind === undefined || a.title === undefined) throw new ApiError(400, "보고 게시에는 kind와 title이 필요합니다", "report_fields_required");
      const message = await orch.recordPost(member, { kind: a.kind, title: a.title, body: a.body, fileIds: a.file_ids, decisionId: a.decision_id, group: a.group, correctsMessageId: a.corrects_message_id, supersedes: a.supersedes });
      return reply(`보고했습니다 #${message.id}${message.systemInstruction ? `\n${message.systemInstruction}` : ""}`);
    },
  ),

  file: tool(
    "대표가 읽거나 복사하거나 확인해야 하는 문서·대본·표·이미지·영상은 반드시 이 도구로 자료에 올리고 post의 file_ids로 연결한다. 로컬 경로만 보고하지 않는다. 바뀌면 새 판을 올려 최신 id를 연결한다. 짧은 보고는 post, 긴 글은 content(마크다운). 글로 설명이 길어지거나 비교·흐름·구조·수치·시안처럼 글만으로 보기 힘든 내용은 html 로 한 페이지를 만들어 올린다. 대표가 읽고 판단할 비교표·요약 표도 csv·마크다운 표가 아니라 html 이다. 외부 사이트에 따로 게시하지 않는다. path 는 디스크의 파일로, 종류는 확장자로 정해진다(.html 아티팩트, csv·tsv 표는 내려받아 쓸 원본 데이터일 때, json·코드·로그·txt 코드, pdf, 이미지, 영상, 오디오). 결과의 id 를 post 의 file_ids 로 잇는다.",
    z.strictObject({
      title: text,
      summary: z.string().optional().describe("세 줄 요약"),
      path: z.string().optional().describe("파일 경로. 작업 폴더 안의 파일만. 상대 경로는 작업 폴더 기준"),
      content: z.string().optional().describe("마크다운 전문"),
      html: z.string().optional().describe("한 페이지짜리 자체 완결 HTML(2MB 이하). CDN·일반 외부 요청은 막힌다(iframe·link 는 지워지고, 격리가 완전하지 않으므로 비밀번호·개인정보 같은 민감한 데이터는 싣지 않는다). 대표가 실행을 눌러야 스크립트가 돈다. 스크립트는 인라인만, 이미지는 data: 로. 기본 스타일 키트가 자동으로 깔려 semantic HTML 과 키트 클래스(card, grid, callout, kpi, steps, flow, tabs, tag, compare)만 써도 깔끔하다. kpi 는 <div class=\"kpi\"><b>값</b><small>설명</small></div>"),
      images: z.array(z.string()).optional().describe("이미지 파일 경로(작업 폴더 안)"),
      replaces: text.optional().describe("이 자료가 대신할 옛 판 id(f_...). 고친 판을 올릴 때 쓴다. 대표 자료 목록에는 최신 판만 보이고(이전 판은 판 목록에서), 옛 판을 근거로 둔 열린 결재는 새 판을 가리킨다"),
    }),
    async (orch, member, a) => {
      if ([a.path, a.content, a.html].filter((v) => v !== undefined).length > 1) throw new ApiError(400, "path·content·html 은 하나만 줍니다", "file_source_ambiguous");
      if (a.replaces !== undefined) {
        // 0.2.7 묶음 4(D5-7): 판 갈이. 직원은 자기가 올린 자료만, 총괄·본사 AI 는 프로젝트의 자료를 바꾼다. 이미 새 판이 있으면 store 가 409.
        const old = orch.store.getFile(a.replaces);
        if (!old || old.projectId !== member.projectId) throw new ApiError(404, `자료를 찾을 수 없습니다: ${a.replaces}`, "file_not_found");
        if (member.kind === "worker" && old.memberId !== member.id) throw new ApiError(403, "직원은 자기가 올린 자료만 새 판으로 바꿀 수 있습니다", "file_not_own");
      }
      if (a.html !== undefined && !a.html.trim()) throw new ApiError(400, "html 이 비어 있습니다", "html_empty");
      if (!a.path && a.content === undefined && a.html === undefined && !a.images?.length) throw new ApiError(400, "path·content·html·images 중 하나가 필요합니다", "file_source_required");
      if (a.html !== undefined && artifactBytes(a.html) > MAX_ARTIFACT_BYTES) throw new ApiError(413, "html 은 2MB 까지 올릴 수 있습니다", "html_too_large");
      // Validate and read all inputs before creating a staging directory or attachment row.
      const inputs: PreparedImport[] = [];
      let body: string = a.content ?? "";
      let html: string | null = a.html ?? null;
      let path: string | null = null;
      let kind: FileKind | undefined = html !== null ? "artifact" : a.content !== undefined ? "document" : undefined;
      if (a.path !== undefined) {
        const real = requireReadable(orch, member, a.path);
        path = expandPath(a.path, member.cwd);
        const stat = statOrNull(real);
        if (!stat?.isFile()) throw new ApiError(400, `파일이 없습니다: ${real}`, "agent_file_missing");
        kind = fileKindOf(basename(real));
        if (kind === "artifact") {
          if (stat.size > MAX_ARTIFACT_BYTES) throw new ApiError(413, `html 은 2MB 까지 올릴 수 있습니다: ${real}`, "html_too_large");
          html = readFileSync(real, "utf8");
          if (artifactBytes(html) > MAX_ARTIFACT_BYTES) throw new ApiError(413, "html 은 2MB 까지 올릴 수 있습니다", "html_too_large");
        } else if (MARKDOWN_EXT.has(extname(real).toLowerCase()) && stat.size <= MARKDOWN_BODY_MAX_BYTES) {
          body = readFileSync(real, "utf8");
        } else {
          const input = prepareAttachment(orch, member, real);
          inputs.push(input);
          kind = fileKindOf(input.name, input.mime);
          if (kind === "document") kind = "file";
          if (TEXT_BODY_KINDS.has(kind) && stat.size <= MARKDOWN_BODY_MAX_BYTES) body = readFileSync(real, "utf8");
        }
      }
      for (const image of a.images ?? []) {
        const input = prepareAttachment(orch, member, image);
        if (!input.mime.startsWith("image/")) throw new ApiError(400, `이미지가 아닙니다: ${image}`, "not_an_image");
        inputs.push(input);
      }
      kind ??= "image";
      let publication: FilePublication | undefined;
      let file;
      try {
        const saved: SavedFile[] = [];
        if (inputs.length) {
          publication = new FilePublication(orch.uploadsDir);
          for (const input of inputs) saved.push(await publication.stagePath(input));
          publication.publish();
        }
        file = orch.store.transaction(() => {
          const attachments = saved.map((entry) => orch.store.createAttachment(entry));
          return orch.store.createFile({ projectId: member.projectId, title: a.title, who: member.name, memberId: member.id, summary: a.summary, body, path, attachments, kind, html, replaces: a.replaces ?? null });
        });
        publication?.complete();
      } catch (error) {
        try { publication?.fail(createStorageReferences(orch.store, join(orch.dataDir, "inbox"))); } catch { /* Unknown cleanup stays active and protected. */ }
        throw toStorageError(error, "자료 게시");
      }
      return reply(`자료를 올렸습니다 #${file.id}${a.replaces ? ` (옛 판 #${a.replaces} 를 대신합니다)` : ""}. post 의 file_ids 에 ${file.id} 를 넣으면 대화에 이어집니다`);
    },
  ),

  todo: tool(
    "대표가 손수 해야 할 일(로그인·결제·실물 확인 등)을 결재함의 내 할 일에 올린다. 끝나면 다음 입력으로 알려 준다.",
    z.strictObject({ title: oneLine(200), detail: z.string().optional() }),
    (orch, member, a) => {
      const todo = orch.store.createTodo({ projectId: member.projectId, memberId: member.id, who: member.name, title: a.title, detail: a.detail });
      orch.notifyInbox(textRef("notice.request.title", { name: member.name }), a.title);
      return reply(`내 할 일에 올렸습니다 #${todo.id}`);
    },
  ),

  todo_update: tool(
    "대표의 열린 할 일을 고친다(제목·내용). 판이 바뀌었다고 todo_close 하고 새로 올리지 않는다(대표에게 같은 알림이 되풀이된다). 고쳐도 새 알림은 가지 않고 대표 화면의 그 할 일이 바뀐다. 직원은 자기가 부탁한 할 일만.",
    z.strictObject({
      id: text.describe("할 일 id(t_...). board 로 본다"),
      title: oneLine(200).optional().describe("새 제목(한 줄). 생략하면 그대로"),
      detail: z.string().optional().describe("새 내용(마크다운). 생략하면 그대로"),
    }),
    (orch, member, a) => {
      if (a.title === undefined && a.detail === undefined) throw new ApiError(400, "고칠 제목이나 내용이 필요합니다", "todo_update_empty");
      const { todo, changed } = orch.updateTodo(member, { id: a.id, title: a.title, detail: a.detail });
      return reply(changed ? `할 일 #${todo.id} 를 고쳤습니다` : `할 일 #${todo.id} 는 이미 그 내용입니다`);
    },
  ),

  ask_close: tool(
    "결재함의 열린 카드를 이유와 함께 닫는다. 대표 대신 답하지 않는다. decided는 user_quote의 대표 원문 또는 answered_decision_id의 실제 대표 답으로 검증한다. 답한 결재와 같은 그룹이거나 총괄이 same_issue에 같은 안건인 이유를 명시해야 한다. obsolete는 상황이 바뀌어 불필요해진 경우다. follow_up에 후속 불필요(none) 또는 대상·지시·대표 원본 메시지 ID(instruction)를 명시하면 닫기와 후속 전달을 함께 저장한다. 별도 team_assign으로 반복하지 않는다. 직원은 자기가 올린 카드만 닫는다.",
    z.strictObject({
      id: text.describe("결재 id(d_...). board 로 본다"),
      kind: z.enum(["decided", "obsolete"]).describe("decided 대표가 이미 정함 · obsolete 필요 없어짐"),
      reason: oneLine(300).describe("왜 닫는지 한 줄. 대표 결재함에 그대로 보인다"),
      user_quote: z.string().optional().describe("decided에서 answered_decision_id가 없을 때 필수. 대표가 이 일을 정한 원문. 서버가 대조한다"),
      answered_decision_id: text.optional().describe("같은 프로젝트에서 대표가 실제 답한 결재 ID. 같은 그룹 또는 총괄의 same_issue 설명이 필요하다"),
      same_issue: oneLine(300).optional().describe("그룹이 다를 때 총괄이 두 결재가 같은 안건인 이유를 명시한다"),
      follow_up: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("none") }),
        z.strictObject({ kind: z.literal("instruction"), member_id: text, text, source_message_id: text.optional() }),
      ]).optional().describe("새 호출에서는 반드시 명시한다. instruction은 같은 프로젝트 직원. 대표 글 근거면 source_message_id 필수, answered_decision_id 근거면 생략하고 같은 답을 후속 출처로 쓴다"),
    }).superRefine((a, ctx) => {
      if (a.follow_up?.kind === "instruction" && !a.follow_up.source_message_id && !a.answered_decision_id) ctx.addIssue({ code: "custom", message: "후속 지시의 대표 원문 또는 답한 결재가 필요합니다" });
    }),
    async (orch, member, a) => {
      if (a.follow_up && !orch.closeDecision) throw new ApiError(501, "결재 후속 저장을 지원하지 않습니다", "decision_follow_up_unsupported");
      const closed = a.follow_up
        ? await orch.closeDecision!(member, { id: a.id, kind: a.kind, reason: a.reason, userQuote: a.user_quote, ...(a.answered_decision_id ? { answeredDecisionId: a.answered_decision_id } : {}), ...(a.same_issue ? { sameIssue: a.same_issue } : {}),
          followUp: a.follow_up.kind === "none" ? { kind: "none" } : { kind: "instruction", memberId: a.follow_up.member_id, text: a.follow_up.text, ...(a.follow_up.source_message_id ? { sourceMessageId: a.follow_up.source_message_id } : { sourceDecisionId: a.answered_decision_id! }) } })
        : await orch.closeAsk(member, { id: a.id, kind: a.kind, reason: a.reason, userQuote: a.user_quote, ...(a.answered_decision_id ? { answeredDecisionId: a.answered_decision_id } : {}), ...(a.same_issue ? { sameIssue: a.same_issue } : {}) });
      return reply(`결재 #${closed.id} 를 닫았습니다${closed.closeQuote ? ". 대표 원문 근거를 확인했습니다" : ""}`);
    },
  ),

  todo_close: tool(
    "대표의 내 할 일을 정리한다. done 은 대표가 이미 끝냈다는 근거(대표의 말·기록·직접 확인한 결과. 부탁한 직원이 로그인·파일·설정 등을 직접 확인한 결과도 포함)가 있을 때만, dropped 는 상황이 바뀌어 필요 없어졌을 때. 추측으로 끝냄 처리하지 않고, 애매하면 그대로 둔다. 정리한 할 일은 홈에서 빠진다(끝남은 완료로 간다). 직원은 자기가 부탁한 할 일만 정리한다.",
    z.strictObject({
      id: text.describe("할 일 id(t_...). board 로 본다"),
      outcome: z.enum(["done", "dropped"]).describe("done 끝남 · dropped 필요 없어짐"),
      reason: oneLine(300).describe("근거나 이유 한 줄. 대표 화면에 보인다"),
    }),
    async (orch, member, a) => {
      const closed = await orch.closeTodo(member, { id: a.id, outcome: a.outcome, reason: a.reason });
      return reply(`할 일 #${closed.id} 를 정리했습니다(${a.outcome === "done" ? "끝남" : "필요 없어짐"})`);
    },
  ),

  board: tool(
    "판을 한 번에 본다: 열린 결재(id·제목·물은 직원·올린 날짜·묶음), 안 끝난 내 할 일(id·제목·부탁한 사람·날짜), 진행판(id·칸·제목·갱신 날짜), 지금 상황, 지난 판 정리 시각. 판을 맞추기 전에 부른다.",
    z.strictObject({}),
    (orch, member) => reply(JSON.stringify(boardView(orch, member.projectId))),
  ),

  team_add: tool(
    "직원을 새로 띄운다. 역할이 맞는 직원이 없을 때만. 잠든 직원의 역할이 맞으면 team_resume 을 쓴다. 사용 한도로 멈춘 직원의 일을 넘기려고 새로 띄우지 않는다. 한도가 풀리면 서버가 그 직원을 이어 가게 하니 기다리고, 대표가 모델을 바꾸라고 하면 team_model 로 그 직원의 모델을 바꾼다.",
    z.strictObject({
      name: oneLine(40).describe("화면 이름: 맡은 일(예: 결제 연동). 사람 이름은 쓰지 않는다. 한국어, 프로젝트 안에서 유일, 한 줄. 같은 역할이 더 필요하면 뒤에 2, 3"),
      role: oneLine(300).describe("맡을 역할(한 줄). 모델 이름은 적지 않는다(실제 모델은 roster 에 보인다)"),
      cli: z.enum(["claude", "codex"]).optional().describe("직원이 쓸 CLI, 기본 claude"),
      model: z.string().nullable().optional().describe("대표가 바로 이 직원(이 일)의 모델을 말했을 때만 넣는다(서버 모델 목록의 값). 앞 일에 준 모델 지시나 다른 직원의 모델을 이어 쓰지 않는다. 생략하거나 null이면 설정의 직급 기본값"),
      handle: z.string().optional().describe("영문 소문자 핸들"),
      cwd: z.string().optional().describe("작업 폴더. 기본은 프로젝트 폴더. 프로젝트 폴더 안이어야 한다. 밖이 꼭 필요하면 ask 로 묻고, 대표가 그 경로를 쓴 글을 user_quote 에 싣는다"),
      first_instruction: z.string().optional().describe("첫 지시. 끝났다고 볼 기준 포함"),
      user_quote: userQuote,
      parallel: z.boolean().optional().describe("병렬(ultracode)로 시작"),
    }),
    async (orch, member, a) => {
      const { member: added, assigned } = await orch.addMember(member.projectId, {
        name: a.name,
        role: a.role,
        cli: a.cli,
        modelOverride: a.model,
        handle: a.handle,
        cwd: a.cwd ? requireMemberCwd(orch, member, a.cwd, a.user_quote) : undefined,
        firstInstruction: a.first_instruction,
        userQuote: a.user_quote,
        parallel: a.parallel,
      }, member);
      return reply(`${added.name}(${added.handle}) 직원을 띄웠습니다${assigned ? `. ${assignNote(assigned)}` : ""}`);
    },
  ),

  withdraw: tool(
    "자신이 보낸 아직 쓰기 시작하지 않은 지시를 거둔다. 대체 지시를 보내기 전에 사용한다.",
    z.strictObject({ deliveryId: text }),
    async (orch, member, a) => { orch.store.withdrawInstruction(a.deliveryId, member); return reply(`미전달 지시 ${a.deliveryId}를 거뒀습니다`); },
  ),

  team_assign: tool(
    "직원에게 일을 맡긴다. 일하는 중이면 대기열에 들어가 끝난 뒤 전달되니 직접 기다리지 않는다.",
    z.strictObject({
      member: memberRef,
      text: text.describe("할 일. 끝났다고 볼 기준, 참고 파일, 주의점 포함"),
      user_quote: userQuote,
      parallel: z.boolean().optional().describe("이 일에 병렬(ultracode)이 나은지. 지금과 다를 때만 서버가 바꾼다"),
      urgent: z.boolean().optional().describe("대표가 '지금 바로'·'멈추고'처럼 하던 일을 끊고 넣으라고 했을 때만 true. 일하는 중인 직원이면, 대표가 그렇게 쓴 문장을 user_quote 로 실었고(서버가 대표 글과 맞춰 봄: 30분 안에 총괄이나 그 직원에게 쓴 글, 결재 버튼 글·짧은 글·다른 직원에게 쓴 글은 안 됨) 승인 창·사용 한도·압축·직접 조작 중이 아닐 때만 서버가 하던 턴을 멈추고 이 지시를 맨 먼저 넣는다('하던 턴 멈추고 넣기'). 같은 대표 글로는 한 직원의 턴을 한 번만 멈춘다(보충 지시는 urgent 없이). 그 밖에는 하던 턴이 끝나야 맨 먼저 들어간다. 무엇을 했는지는 이 도구의 답에 나오니 그대로 대표에게 알린다"),
      attachments: z.array(z.string()).max(20).optional().describe("함께 넘길 대표 메시지의 첨부 id(`첨부:` 줄 경로의 파일 이름 앞 a_... 부분). 경로를 글로 옮기지 말고 이것을 쓴다"),
    }),
    async (orch, member, a) => {
      const target = requireOther(orch, member, a.member);
      return reply(`${target.name}: ${assignNote(await orch.assign(member.projectId, target.handle, { text: a.text, userQuote: a.user_quote, parallel: a.parallel, urgent: a.urgent, attachmentIds: a.attachments }, member))}`);
    },
  ),

  team_compact: tool(
    "직원 세션을 압축한다. 보통은 서버가 자동으로 하니 화제가 크게 바뀔 때만. 일하는 중이면 끝난 뒤로 미룬다.",
    z.strictObject({ member: memberRef, focus: oneLineOpt(1000).optional().describe("요약에 남길 것(한 줄)") }),
    async (orch, member, a) => {
      const target = await orch.compactMember(orch.requireInProject(member.projectId, a.member).id, a.focus);
      return reply(`${target.name} 압축을 넣었습니다`);
    },
  ),

  team_sleep: tool(
    "직원을 잠재운다. 세션 기록은 남아 team_resume 으로 그대로 이어진다. 일하는 중·열린 결재·대기열이 있으면 거부된다.",
    z.strictObject({ member: memberRef, force: z.boolean().optional().describe("거부 조건을 무시한다. 대표가 시켰을 때만") }),
    async (orch, member, a) => {
      const target = await orch.sleepMember(requireOther(orch, member, a.member).id, { force: a.force });
      return reply(`${josa(target.name, "을")} 잠재웠습니다`);
    },
  ),

  team_resume: tool(
    "잠든 직원을 대화 기록 그대로 다시 연다.",
    z.strictObject({ member: memberRef, first_instruction: z.string().optional() }),
    async (orch, member, a) => {
      const target = await orch.resumeMember(requireOther(orch, member, a.member).id, a.first_instruction, member);
      return reply(`${josa(target.name, "을")} 다시 열었습니다`);
    },
  ),

  team_close: tool(
    "직원을 닫고 명부에서 뺀다. 대표가 닫으라고 했을 때만. 대화·결재 기록은 남는다. 대기 중인 입력과 열린 결재는 닫힌다.",
    z.strictObject({ member: memberRef }),
    async (orch, member, a) => {
      const target = requireOther(orch, member, a.member);
      const dropped = await orch.closeMember(target.id);
      return reply(`${josa(target.name, "을")} 닫았습니다${dropped.length ? `. 나가지 않은 지시 ${dropped.length}건: ${dropped.join(" / ")}` : ""}`);
    },
  ),

  team_model: tool(
    "대표가 모델을 바꾸라고 했을 때만 쓴다. 직원의 모델(과 effort)을 바꾸고 같은 세션(대화 기록)을 새 모델로 이어 연다. 사용 한도로 멈춘 직원은 대표가 정할 때까지 기다린다(새로 띄우지도, 스스로 모델을 바꾸지도 않는다. 한도가 풀리면 서버가 이어 가게 한다). 대표가 그 직원의 모델을 바꾸라고 하면 이것으로 바꾼다: 서버가 그 직원의 한도 보류를 풀고, 하던 일이 있었으면 멈춘 곳부터 이어서 하게 한다(원래 지시를 다시 보내지 않는다). 같은 계정의 다른 직원은 그대로 보류된다. 일하는 중이면 거부되니 턴이 끝난 뒤 다시 부른다(사용 한도로 멈춘 것은 일하는 중이 아니다). 잠든 직원은 다음에 열 때 새 모델로 연다(사용 한도로 멈춘 일이 있으면 바로 다시 열어 이어 간다). 답이 '다시 엽니다'면 서버가 곧 연다. 같은 일을 다시 맡기지 않는다.",
    z.strictObject({
      member: memberRef,
      model: z.string().nullable().describe("서버 모델 목록의 값(team_add 의 model 과 같다). null이면 직급 기본값"),
      effort: z.string().nullable().optional().describe("effort. 그 모델이 허용하는 값만(서버가 확인한다). null이면 직급 기본값, 생략하면 그대로"),
    }),
    async (orch, member, a) => {
      const target = requireOther(orch, member, a.member);
      const result = await orch.changeMemberModel(target.id, { modelOverride: a.model, ...(a.effort !== undefined ? { effortOverride: a.effort } : {}) });
      const name = result.member.name;
      const handled = "같은 일을 다시 맡기거나 새 직원에게 넘기지 마세요";
      if (result.opened === "later") return reply(`${name}의 모델을 ${withRo(result.model)} 바꿨습니다. ${result.continued ? `사용 한도로 멈춘 일을 이어서 하도록 새 모델로 다시 엽니다. ${handled}` : result.usage ? "사용 한도 보류를 풀었습니다. 다음에 열 때 새 모델로 엽니다" : "다음에 열 때 새 모델로 엽니다"}`);
      const opened = result.opened === "resumed" ? "같은 세션을 이어 열었습니다" : "이어 열 세션 기록이 없어 새 세션으로 열었습니다";
      return reply(`${name}의 모델을 ${withRo(result.model)} 바꿔 ${opened}${result.continued ? `. 사용 한도로 멈춘 일은 ${josa(name, "이")} 멈춘 곳부터 이어서 합니다. ${handled}` : result.usage ? ". 사용 한도 보류를 풀었습니다" : ""}`);
    },
  ),

  work_list: tool(
    "일 항목(진행 중·예정·보류·완료)을 id 와 함께 본다. 압축 뒤 항목을 옮기거나 지울 때 먼저 부른다.",
    z.strictObject({}),
    (orch, member) => reply(JSON.stringify(orch.store.listWork(member.projectId).map((w) => ({ id: w.id, sec: w.sec, title: w.title, detail: w.detail, who: w.who })))),
  ),

  work_remove: tool(
    "낡거나 겹친 일 항목을 지운다.",
    z.strictObject({ id: text }),
    (orch, member, a) => {
      if (orch.store.getWork(a.id)?.projectId !== member.projectId) throw new ApiError(404, `일 항목을 찾을 수 없습니다: ${a.id}`, "board_item_not_found");
      orch.store.removeWork(a.id);
      return reply("지웠습니다");
    },
  ),

  roster: tool("팀 명부를 본다: 역할·상태·지금 일·다음·대기열·열린 결재·문맥 %·서브에이전트·병렬·모델·effort(대표가 설정에서 정한다. 대표가 바꾸라고 할 때만 team_model 로 바꾼다. null 은 CLI 기본). status 가 idle·asleep 이면 now 는 마지막에 하던 일이다.", z.strictObject({}), (orch, member) => reply(JSON.stringify(orch.roster(member.projectId)))),

  project_now: tool(
    "팀 화면 맨 위 '지금 상황'을 고친다. 전체 상태와 대표에게 필요한 것을 늘 최신으로.",
    z.strictObject({ text }),
    (orch, member, a) => {
      orch.setProjectNow(member.projectId, a.text);
      return reply("고쳤습니다");
    },
  ),

  // 0.2.7 묶음 5(D5-5): 대표 상시 규칙. 저장·지침 싣기·알림은 server/project-rules.ts.
  rule: tool(
    "대표가 이 프로젝트에서 앞으로 계속 지킬 일하는 방식으로 정한 상시 규칙을 남기거나(add) 빼거나(remove) 본다(list). 남긴 규칙은 이 프로젝트에서 새로 여는 모든 세션(총괄 포함)의 지침 끝 '대표 상시 규칙'에 실리고, 깨어 있는 다른 세션에는 서버가 다음 입력과 함께 알린다(깨우지 않는다). add·remove 는 그렇게 정한 대표 원문을 user_quote 에 글자 그대로 실어야 한다(서버가 대표 글과 대조한다. 버튼 글·아주 짧은 글은 안 된다). 한 번만 할 일이나 지금 일에 대한 지시는 규칙이 아니다. 규칙은 승인을 대신하지 않는다.",
    z.strictObject({
      action: z.enum(["add", "remove", "list"]).describe("add 남기기 · remove 빼기 · list 보기"),
      text: oneLineOpt(RULE_TEXT_MAX).optional().describe("add: 규칙 한 줄(무엇을 늘 하거나 하지 않는지, 일상어)"),
      id: text.optional().describe("remove: 뺄 규칙 id(r_...). list 로 본다"),
      user_quote: z.string().optional().describe("add·remove: 대표가 그렇게 정한 원문을 글자 그대로. 서버가 대조한다"),
    }).superRefine((a, ctx) => {
      if (a.action === "add" && !a.text) ctx.addIssue({ code: "custom", message: "add 에는 text(규칙 한 줄)가 필요합니다" });
      if (a.action === "remove" && !a.id) ctx.addIssue({ code: "custom", message: "remove 에는 id 가 필요합니다" });
      if (a.action !== "add" && a.text !== undefined) ctx.addIssue({ code: "custom", message: "text 는 add 에만 씁니다" });
      if (a.action !== "remove" && a.id !== undefined) ctx.addIssue({ code: "custom", message: "id 는 remove 에만 씁니다" });
      if (a.action === "list" && a.user_quote !== undefined) ctx.addIssue({ code: "custom", message: "list 에는 user_quote 를 주지 않습니다" });
    }),
    (orch, member, a) => {
      if (a.action === "list") return reply(listProjectRules(orch.store, member.projectId));
      return reply(changeProjectRule(orch, member, a.action === "add" ? { action: "add", text: a.text!, userQuote: a.user_quote } : { action: "remove", id: a.id!, userQuote: a.user_quote }));
    },
  ),

  work_set: tool(
    "일 항목을 만들거나(id 없음) 고친다(id 있음). sec: doing 진행 중 · next 예정 · hold 보류 · done 완료.",
    z.strictObject({ id: z.string().optional(), sec: z.enum(["doing", "next", "hold", "done"]), title: text, detail: z.string().optional(), who: z.string().optional() }),
    (orch, member, a) => reply(`일 항목 #${orch.setWork(member.projectId, a).id}`),
  ),

  project_create: tool(
    "새 프로젝트를 만든다. 폴더가 없으면 먼저 만들고 부른다. 대표가 바로 시작하길 원하면 start_conductor 를 true 로 한다.",
    z.strictObject({
      name: text,
      cwd: text.describe("이미 있는 프로젝트 폴더"),
      goal: z.string().optional().describe("프로젝트 목표. 대표의 말 그대로"),
      start_conductor: z.boolean().optional().describe("총괄을 바로 띄운다"),
      chief_cli: z.enum(["claude", "codex"]).optional(),
    }),
    async (orch, member, a) => {
      const cwd = expandPath(a.cwd, member.cwd);
      if (!statOrNull(cwd)?.isDirectory()) throw new ApiError(400, `폴더가 없습니다: ${cwd}`, "folder_missing");
      // 총괄 띄우기가 실패해도 프로젝트는 남는다. 다시 불렀을 때 둘이 되지 않게 한다.
      const same = orch.store.listProjects().find((p) => p.name === a.name && p.cwd === cwd);
      if (same) throw new ApiError(409, `같은 이름·폴더의 프로젝트가 이미 있습니다 #${same.id}`, "project_exists");
      const project = await orch.createProject({ name: a.name, cwd, goal: a.goal, startConductor: a.start_conductor, chiefCli: a.chief_cli });
      return reply(`프로젝트를 만들었습니다 #${project.id} '${project.name}' (${project.cwd})${a.start_conductor ? ", 총괄을 띄웠습니다" : ""}`);
    },
  ),

  project_list: tool("프로젝트 목록을 본다.", z.strictObject({}), (orch) => {
    const cwds = new Map(orch.store.listProjects().map((p) => [p.id, p.cwd]));
    return reply(JSON.stringify(orch.store.projectSummaries().map((s) => ({ ...s, cwd: cwds.get(s.id) ?? null }))));
  }),

  wait: tool(
    "밀린 지시와 결재 답을 batch로 받는다. 반환만으로 소비하지 않는다. 내용을 읽은 뒤 wait에 ack_batch_id를 넣어 수신을 확인한다. ACK 전 다시 조회하면 같은 batch다. 응답 유실 때 새 operation_id로 조회해도 회수된다. 일이 끝나면 다시 부른다.",
    z.strictObject({
      batch: z.literal(true).optional().describe("재조회 가능한 batch 수신 계약. MCP bridge는 자동으로 true를 보낸다"),
      timeout_sec: z.number().int().min(1).max(WAIT_MAX_SEC).optional().describe(`기본 ${WAIT_DEFAULT_SEC}초`),
      ack_batch_id: text.optional().describe("읽은 batch의 id. ACK만 수행한다. timeout_sec와 함께 주지 않는다"),
    }).refine(a => a.ack_batch_id === undefined || a.timeout_sec === undefined, "ACK와 조회는 따로 호출합니다"),
    async (orch, member, a, signal) => {
      if (a.ack_batch_id !== undefined) {
        if (!orch.acknowledgeManualInbox) throw new ApiError(501, "수신함 ACK를 지원하지 않습니다", "inbox_ack_unsupported");
        return reply(JSON.stringify(await orch.acknowledgeManualInbox(member.id, { batchId: a.ack_batch_id })));
      }
      // 기존 v1 HTTP 도구 호출은 문자열/즉시 소비 계약을 유지한다.
      if (!a.batch) return reply((await orch.waitInbox(member, (a.timeout_sec ?? WAIT_DEFAULT_SEC) * 1000, signal)) ?? "새 지시가 없습니다. 계속 기다리려면 다시 wait 를 부르세요");
      if (!orch.manualInbox) throw new ApiError(501, "수신함 batch 조회를 지원하지 않습니다", "inbox_batch_unsupported");
      const batch = await orch.manualInbox(member.id, (a.timeout_sec ?? WAIT_DEFAULT_SEC) * 1000, signal);
      return reply(batch ? JSON.stringify(batch) : "새 지시가 없습니다. 계속 기다리려면 다시 wait 를 부르세요");
    },
  ),
};

function namesFor(member: Member): readonly ToolName[] {
  return [
    ...WORKER_TOOLS,
    ...(member.kind === "conductor" ? CONDUCTOR_TOOLS : []),
    ...(member.kind === "root" ? ROOT_TOOLS : []),
    ...(member.origin === "manual" ? MANUAL_TOOLS : []),
  ];
}

export function listAgentTools(member: Member): AgentToolDef[] {
  return namesFor(member).map((name) => {
    const { $schema: _, ...inputSchema } = z.toJSONSchema(TOOLS[name].schema) as Record<string, unknown>;
    return { name, description: TOOLS[name].description, inputSchema };
  });
}

export async function handleAgentTool(orch: Orchestrator, member: Member, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult> {
  if (!(namesFor(member) as readonly string[]).includes(name)) return { text: `쓸 수 없는 도구입니다: ${name}`, isError: true };
  const tool = TOOLS[name as ToolName];
  const parsed = (tool.schema as z.ZodType).safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "인자"}: ${i.message}`).join("; ");
    return { text: `인자가 잘못되었습니다. ${issues}`, isError: true };
  }
  try {
    return await tool.run(orch, member, parsed.data, signal);
  } catch (e) {
    if (e instanceof ApiError) return { text: e.message, isError: true };
    throw e;
  }
}
