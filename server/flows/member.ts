// 직원 쪽 업무 흐름(H): MCP 도구, 지시(team_assign), 보고(post), ask, 결재 닫기·할 일 정리, 직접 띄운 CLI 의 수신함과 대기.
// orchestrator.ts 에서 옮겨 왔다(동작은 그대로다). 원본을 저장소에 쓰고 전달 의도를 줄 세운 뒤 펌프를 민다.
// 턴 상태는 Orchestrator 의 것을 TurnContext 로만 읽고 쓴다. 세션 수명·펌프는 Orchestrator 가 맡고, 여기서는 포트로만 부른다.
import type { AgentOperationContext, ManualInboxAckRequest, ManualInboxAckResult, ManualInboxBatch } from "../../shared/operations.ts";
import type { Attachment, Decision, DecisionCloseFollowUp, DecisionCloseKind, DecisionOption, Delivery, Member, Message, MessageKind, Project, Todo, TodoOutcome, WorkItem, WorkSec } from "../../shared/types.ts";
import { attachmentLines, formatAnswer, formatInstruction, formatReport, formatSystem, isTidy, normalizeSpace, QUOTE_SCAN_PAGES, quotedInline, quoteNeedsContext, SHORT_QUOTE, type QuoteSource, type VerifiedQuote } from "../delivery-text.ts";
import type { AgentToolDef, AgentToolResult, AskWaitResult } from "../orchestrator-api.ts";
import type { AgentToolsImpl, Orchestrator } from "../orchestrator.ts";
import { josa } from "../roles.ts";
import type { ReportReferences } from "../service-contracts.ts";
import { ApiError, type NewDelivery, type Store } from "../store.ts";

export interface AssignInput {
  text: string;
  userQuote?: string;
  parallel?: boolean;
  urgent?: boolean;
  /** 대표 메시지의 첨부 id. 그 직원 폴더로 이어 경로를 알린다. */
  attachmentIds?: string[];
}

export interface AssignResult {
  delivery: Delivery;
  /** 앞에 일이 있어 기다리면 대기열 위치(1부터), 곧바로 들어가면 0. */
  position: number;
  verified: boolean | null;
  /** 맞았지만 버튼 글·짧은 글이라 '문맥 확인 필요'로 나갔다. */
  needsContext: boolean;
}

export interface PostInput {
  kind: Extract<MessageKind, "완료" | "진행" | "막힘" | "알림" | "질문">;
  title: string;
  body?: string;
  fileIds?: string[];
  decisionId?: string | null;
  group?: string | null;
  correctsMessageId?: string | null;
  supersedes?: string | null;
}

export interface AskInput {
  title: string;
  detail?: string;
  options?: DecisionOption[];
  rec?: string | null;
  group?: string | null;
  fileId?: string | null;
  images?: Attachment[];
}

const APPROVAL_CARD_INSTRUCTION = "보고에 대표 승인이 필요하다고 썼는데 열린 결재 카드가 없다. 지금 ask 로 카드를 올리거나, 필요 없으면 보고를 정정하라.";

/** 단어만으로 막지 않는다. 앞으로 받을 판단과 이미 받은 판단·불필요·CLI 승인을 구분한다. */
function needsApprovalCard(text: string): boolean {
  const prose = text.replace(/```[^]*?```|~~~[^]*?~~~/g, "").replace(/^\s*>.*$/gm, "");
  return prose.split(/[\n.!?;,。]|(?:하지만|그러나|지만)/).some(part => {
    const clause = part
      .replace(/(?:터미널|CLI|cli|명령(?:어)?|도구|실행|권한|샌드박스)\s*(?:승인|허락)(?:\s*창)?/g, "")
      .replace(/승인\s*창/g, "")
      .replace(/(?:승인|결재|허락)\s*(?:요청\s*)?(?:기능|로직|문구|테스트|시험|규칙|카드\s*UI)/g, "")
      .replace(/(?:승인|허락|결재)\s*요청(?:은|을)?\s*(?:하지\s*않|안\s*했)/g, "")
      .replace(/(?:대표(?:님)?(?:의)?\s*)?(?:승인|허락|결재|확인|결정)(?:은|는|이|가|을|를)?\s*(?:불필요|필요\s*(?:없|하지\s*않)|요청하지\s*않|받지\s*않아도|(?:이미\s*)?(?:받았|받음|완료|끝났|끝남))/g, "")
      .replace(/(?:대표(?:님)?(?:이|께서)?\s*)?(?:승인|허락|결재|확인|결정)(?:을|를)?\s*(?:해\s*주셨|하셨|했습|했음)/g, "")
      .replace(/(?:여쭙|여쭈|여쭤)(?:지\s*않|지\s*말|지\s*않아도|었|봤)/g, "");
    if (/(?:승인|허락|결재|대표(?:님)?(?:의)?\s*(?:확인|결정))\s*(?:후|뒤).*(?:했습니다|했음|끝냈습니다|마쳤습니다)\s*$/.test(clause)
      && !/(?:필요|대기|여쭙|여쭈|여쭤)/.test(clause)) return false;
    return /(?:승인|허락|결재)(?:을|를|이|가|은|는)?\s*(?:뒤|후|전|대기|필요|요청|받아야|받으면|받고|받은\s*(?:뒤|후)|받기\s*전|부탁|올려야|올릴)/.test(clause)
      || /대표(?:님)?(?:의)?\s*(?:확인|결정)(?:을|를|이|가|은|는)?\s*(?:필요|대기|기다|요청|뒤|후|전|받아야|받으면|받고|부탁|바랍니다|해\s*주)/.test(clause)
      || /(?:대표(?:님)?(?:의)?\s*(?:확인|결정)|승인|허락|결재)\s*$/.test(clause)
      || /(?:여쭙|여쭘|여쭈|여쭤|정해\s*주시면)/.test(clause);
  });
}

/** 총괄을 깨우는 보고 종류. 진행·알림은 깨우지 않고 다음 턴에 함께 읽힌다. */
export const WAKE_POST_KINDS = new Set<string>(["완료", "막힘", "질문"]);

/**
 * 지금 턴의 문맥. Orchestrator 가 직원별로 들고 있는 실행 상태를 그대로 넘긴다(같은 객체라 여기서 쓴 값을 턴 끝 처리가 그대로 본다).
 */
export interface TurnContext {
  /** 이번 턴에 post·ask 로 보고했다. 턴이 끝날 때 마지막 글을 자동 보고로 올리지 않는다. */
  posted: boolean;
  /** 이번 턴에 일을 맡겼다(team_assign·team_add·team_resume). 보고가 없어도 보고 보완을 요구하지 않는다. */
  delegated: boolean;
  /** 대표가 이 직원에게 직접 보낸 글로 도는 턴이다. 보고 제목에 '(직접)'을 붙인다. */
  readonly direct: boolean;
  /** 다음 지시를 병렬로 받을지. 마지막 지시가 이긴다. */
  wantParallel: boolean | null;
  /** 지금 도는 턴. 같은 턴에 올린 결재와 판 정리 확인을 여기에 적는다. */
  readonly turn: { askedDecisionIds?: Set<string>; boardReview?: { requestedRevision: number; reviewedRevision: number | null } } | null;
}

/** 직원 쪽 흐름이 Orchestrator 에서 받는 것: 원본 저장(store), 전달 의도와 펌프, 턴 문맥, 그리고 세션 상태를 묻는 몇 가지. */
export interface MemberFlowPort {
  readonly store: Store;
  /** MCP 도구 구현(agent-tools.ts)에 넘기는 Orchestrator. */
  readonly host: Orchestrator;
  /** 서버를 닫는 중이다. 새 대기를 걸지 않는다. */
  closed(): boolean;
  /** 보관 전에 칸을 끝내는 중인 프로젝트. 보관된 것처럼 다룬다. */
  archiving(projectId: string): boolean;
  pump(memberId: string): Promise<void>;
  /** 줄 세우고 곧바로 민다. */
  deliver(input: NewDelivery): Promise<Delivery>;
  /** 보관했거나 보관 중인 프로젝트면 ApiError(409). */
  requireActive(project: Project): void;
  /** 핸들이나 화면 이름으로 이 프로젝트의 직원을 찾는다. 없으면 ApiError(404). */
  requireInProject(projectId: string, memberRef: string): Member;
  turnContext(memberId: string): TurnContext;
  isBusy(member: Member): boolean;
  /** 이 직원의 실행기가 턴 중에 긴급 입력을 끼워 넣을 수 있다. */
  interjects(member: Member): boolean;
  /** 턴 밖의 상태로 돌린다(답하지 않은 결재가 있으면 waiting, 없으면 idle). */
  settle(member: Member): void;
  /** waiting 인데 답하지 않은 결재가 남지 않았으면 지금 하는 대로 고친다. */
  refreshWaiting(memberId: string): void;
  /** 대표에게 Mac 알림(설정에서 켠 때만). */
  notifyInbox(title: string, body: string): void;
  /** 대표가 체크를 푼 할 일의 '아직 안 했음' 정정을 맞춘다(flows/owner.ts). */
  reconcileTodoCorrections(): void;
  /** 첨부를 그 직원의 폴더로 잇는다(flows/owner.ts). */
  attachmentsFor(member: Member, attachments: Attachment[]): Attachment[];
}

export class MemberFlows {
  private readonly store: Store;
  private agentTools: AgentToolsImpl | null;
  private askWaiters = new Map<string, Set<() => void>>();
  private inboxWaiters = new Map<string, Set<() => void>>();
  private readonly agentOperations = new Map<string, Promise<AgentToolResult>>();

  constructor(private readonly port: MemberFlowPort, agentTools: AgentToolsImpl | null) {
    this.store = port.store;
    this.agentTools = agentTools;
  }

  /** 결재 답을 기다리는 직접 띄운 CLI(askWait)를 깨운다. */
  wakeAsk(decisionId: string): void {
    this.wakeAll(this.askWaiters, decisionId);
  }

  /** 직접 띄운 CLI 의 수신함 대기(wait·manualInbox)를 깨운다. */
  wakeInbox(memberId: string): void {
    this.wakeAll(this.inboxWaiters, memberId);
  }

  /** 서버를 닫는다: 기다리는 것을 모두 풀어 준다. */
  wakeEveryone(): void {
    for (const waiters of [...this.askWaiters.values(), ...this.inboxWaiters.values()]) {
      for (const wake of waiters) wake();
    }
  }

  async listAgentTools(member: Member): Promise<AgentToolDef[]> {
    return (await this.tools()).listAgentTools(member);
  }

  async handleAgentTool(member: Member, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult> {
    const tools = await this.tools();
    const boardRevision = name === "board" ? this.store.boardRevision(member.projectId) : null;
    const result = await tools.handleAgentTool(this.port.host, member, name, args, signal);
    if (!result.isError) {
      if (boardRevision !== null) this.noteBoardReview(member, boardRevision);
      if (["team_assign", "team_add", "team_resume"].includes(name) && this.port.turnContext(member.id).turn) {
        this.port.turnContext(member.id).delegated = true;
        for (const run of this.store.listPendingExecutions().filter(run => run.memberId === member.id)) this.store.saveExecutionJournal({ ...run, reason: "awaiting_delegation", updatedAt: new Date().toISOString() });
      }
    }
    return result;
  }

  /** 영속 예약을 먼저 커밋한다. 프로세스가 죽으면 미확인 결과를 반환하며 효과를 재생하지 않는다. */
  async handleAgentOperation(member: Member, name: string, args: Record<string, unknown>, context: AgentOperationContext, signal?: AbortSignal): Promise<AgentToolResult> {
    const current = this.store.requireMember(member.id);
    if (current.projectId !== member.projectId) throw new ApiError(404, "팀원을 찾을 수 없습니다", "member_not_found");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(context.operationId)) throw new ApiError(400, "operationId가 잘못되었습니다", "invalid_operation_id");
    let reserved = false;
    const previous = this.store.agentOperation(current.id, name, context.operationId, args, () => {
      reserved = true;
      return { text: "이 작업의 결과를 확인할 수 없습니다. 같은 작업은 자동 재실행하지 않습니다", isError: true };
    });
    const running = this.agentOperations.get(context.operationId);
    if (running) return running;
    // 동기 Store 포트의 두 불변 receipt로 예약과 비동기 결과를 나눈다.
    // ':'는 외부 operation ID에 허용하지 않아 결과 namespace와 충돌하지 않는다.
    const resultId = `agent-result:${context.operationId}`;
    if (!reserved) {
      const missing = Symbol("result_pending");
      try { return this.store.agentOperation(current.id, name, resultId, args, () => { throw missing; }); }
      catch (error) { if (error !== missing) throw error; }
      return previous;
    }
    const execution = this.handleAgentTool(current, name, args, signal).then(result =>
      this.store.agentOperation(current.id, name, resultId, args, () => result),
    ).finally(() => { this.agentOperations.delete(context.operationId); });
    this.agentOperations.set(context.operationId, execution);
    return execution;
  }

  /** Called at the board read boundary; completion only covers the requested revision. */
  noteBoardReview(member: Member, revision = this.store.boardRevision(member.projectId)): void {
    const turn = this.port.turnContext(member.id).turn;
    const runs = this.store.listPendingExecutions().filter(run => run.memberId === member.id);
    const tidy = runs.some(run => run.deliveryIds.some(id => { const delivery = this.store.getDelivery(id); return delivery && isTidy(delivery); }));
    const requestedRevision = turn?.boardReview?.requestedRevision ?? (tidy ? this.store.getBoardReview(member.projectId)?.requestedRevision : undefined);
    if (requestedRevision === undefined) return;
    const reviewedRevision = Math.min(requestedRevision, revision);
    if (turn?.boardReview) turn.boardReview.reviewedRevision = reviewedRevision;
    for (const run of runs) this.store.saveExecutionJournal({ ...run, reason: `board_review:${requestedRevision}:${reviewedRevision}`, updatedAt: new Date().toISOString() });
  }

  private async tools(): Promise<AgentToolsImpl> {
    // agent-tools.ts 가 Orchestrator 의 타입을 쓰므로 정적 import 로 순환시키지 않는다.
    this.agentTools ??= await import("../agent-tools.ts");
    return this.agentTools;
  }

  async askWait(member: Member, decisionId: string, timeoutMs: number, signal?: AbortSignal): Promise<AskWaitResult> {
    const ready = (): AskWaitResult | null => {
      const current = this.store.requireMember(member.id);
      const decision = this.store.requireDecision(decisionId);
      if (decision.projectId !== current.projectId || decision.memberId !== member.id) throw new ApiError(403, "자신이 올린 결재만 기다릴 수 있습니다", "decision_not_own");
      if (signal?.aborted || this.store.requireProject(member.projectId).archived || this.port.archiving(member.projectId) || decision.status === "open") return null;
      const answered = decision.status === "answered" || decision.status === "delivered";
      if (decision.status === "answered") {
        this.materializeManualAnswers(current);
        // An unacknowledged wait batch owns its items. askWait must not consume it.
        if (this.store.manualInbox(member.id, [])?.items.some(item => item.ref?.type === "decision" && item.ref.id === decisionId)) return null;
        const delivery = this.store.listPending(member.id).find(d => d.refType === "decision" && d.refId === decisionId);
        if (delivery) {
          const batch = this.store.manualInbox(member.id, [delivery.id]);
          if (!batch?.items.some(item => item.deliveryId === delivery.id)) return null;
          this.store.acknowledgeManualInbox(member.id, batch.id);
        } else this.store.setDecisionStatus(decisionId, "delivered");
      }
      const text = answered ? formatAnswer(decision) : formatSystem(`결재가 닫혔습니다${decision.closeReason ? `: ${normalizeSpace(decision.closeReason)}` : ""}. 이 질문의 답은 오지 않습니다 #${decision.id}`);
      this.port.settle(current);
      return { done: true, text, decision: this.store.requireDecision(decisionId) };
    };
    if (signal?.aborted) return { done: false };
    const now = ready();
    if (now) return now;
    await this.waitOn(this.askWaiters, decisionId, Math.min(Math.max(timeoutMs, 0), 50_000), signal);
    return ready() ?? { done: false };
  }

  private refuseOwnerDirectRepeat(target: Member, quote: VerifiedQuote | null): void {
    if (quote?.verified && quote.source) {
      const message = this.store.getMessage(quote.source.id);
      if (message?.mine && message.targetMemberId === target.id && this.store.listDeliveries(target.projectId).some(d =>
        d.memberId === target.id && d.kind === "user_message" && d.refType === "message" && d.refId === message.id &&
        ["queued", "delivering", "delivered"].includes(d.status))) {
        const reason = `대표가 이미 ${target.name}에게 직접 보낸 지시입니다(#${message.id}). 다시 보내지 마세요. 더할 일이 있으면 인용 없이 그 부분만 쓰세요.`;
        this.store.appendActivity(target.id, "system", reason);
        throw new ApiError(409, reason, "owner_direct_repeat");
      }
    }
  }

  /** team_assign. member 는 핸들 또는 화면 이름. 다른 프로젝트 직원은 찾지 못한다. */
  async assign(projectId: string, memberRef: string, input: AssignInput, assignedBy?: Member): Promise<AssignResult> {
    const target = this.port.requireInProject(projectId, memberRef);
    const source = input.userQuote?.trim() ? this.findQuoteSource(projectId, input.userQuote) : null;
    const quote = input.userQuote?.trim() ? { text: input.userQuote, verified: source !== null, source } : null;
    this.refuseOwnerDirectRepeat(target, quote);
    // 마지막 지시가 이긴다. 거절된 지시는 병렬 설정도 바꾸지 않는다.
    if (input.parallel !== undefined) this.port.turnContext(target.id).wantParallel = input.parallel;
    const project = this.store.requireProject(projectId);
    const busy = this.port.isBusy(target);
    const attachments = (input.attachmentIds ?? []).map((id) => {
      const attachment = this.store.getAttachment(id);
      if (!attachment || !this.store.isProjectAttachment(projectId, id)) throw new ApiError(404, `이 프로젝트에서 대표가 보낸 첨부가 아닙니다: ${id}`, "attachment_not_found");
      return attachment;
    });
    const delivery = this.store.transaction(() => {
      const delivery = this.store.enqueue({
        projectId,
        memberId: target.id,
        kind: "instruction",
        text: [formatInstruction(target.name, input.text, quote), ...attachmentLines(this.port.attachmentsFor(target, attachments))].join("\n"),
        urgent: input.urgent,
      });
      // 끼워 넣을 수 없는 실행기에서는 긴급도 턴이 끝나야 나간다. 지시한 쪽에 '대기'로 알린다.
      if (assignedBy) { this.store.setDeliveryAuthor(delivery.id, assignedBy.id); this.store.noteDelegation(assignedBy.id, delivery, busy && !(input.urgent && this.port.interjects(target))); }
      return delivery;
    });
    const position = busy ? this.store.listPending(target.id).length : 0;
    await this.port.pump(target.id);
    return { delivery: this.store.requireDelivery(delivery.id), position, verified: quote?.verified ?? null, needsContext: quote ? quoteNeedsContext(quote) : false };
  }

  /**
   * 인용이 이 프로젝트의 대표 메시지·결재 답에 (공백 정규화 후) 그대로 있으면 그 글. 총괄의 말은 승인이 아니다.
   * 직원에게 전문·시각·카드 제목을 함께 보내 잘린 인용이나 다른 안건의 답으로 뜻이 뒤집히지 않게 한다.
   */
  findQuoteSource(projectId: string, rawQuote: string): QuoteSource | null {
    const quote = normalizeSpace(rawQuote).replace(/^["'“”‘’](.*)["'“”‘’]$/, "$1").trim();
    if (!quote) return null;
    // "네" 같은 짧은 인용은 다른 글의 일부로 우연히 맞는다. 글 전체가 같아야 한다.
    const matches = (source: string): boolean => {
      const text = normalizeSpace(source);
      return quote.length < SHORT_QUOTE ? text === quote : includesWhole(text, quote);
    };
    for (const d of this.store.listAllDoneDecisions(projectId)) {
      const option = d.options.find((o) => o.k === d.choice);
      // 버튼 글은 대표가 보고 누른 그대로만 친다. 설명·버튼 글의 일부는 직원이 쓴 글이라 대표의 말이 아니다.
      if (option && normalizeSpace(option.label) === quote) return { id: d.id, text: option.label, at: d.answeredAt, card: d.title };
      if (d.note && matches(d.note)) return { id: d.id, text: d.note, at: d.answeredAt };
    }
    for (const todo of this.store.listTodos(projectId)) if (todo.done && todo.completionNote && matches(todo.completionNote)) return { id: todo.id, text: todo.completionNote, at: todo.doneAt, card: todo.title };
    const project = this.store.requireProject(projectId);
    if (project.creationGoal && matches(project.creationGoal)) return { id: project.id, text: project.creationGoal, at: project.createdAt };
    let before: string | undefined;
    for (let page = 0; page < QUOTE_SCAN_PAGES; page++) {
      const messages = this.store.listMessages(projectId, { before, limit: 500 });
      const found = [...messages].reverse().find((m) => m.mine && matches(m.body));
      if (found) return { id: found.id, text: found.body, at: found.at };
      if (messages.length < 500) return null;
      before = messages[0]!.at;
    }
    return null;
  }

  async recordPost(member: Member, input: PostInput): Promise<Message & { systemInstruction?: string }> {
    const rt = this.port.turnContext(member.id);
    if (input.supersedes && input.correctsMessageId && input.supersedes !== input.correctsMessageId) throw new ApiError(400, "정정 대상이 서로 다릅니다", "correction_target_mismatch");
    input = { ...input, correctsMessageId: input.supersedes ?? input.correctsMessageId };
    const files = (input.fileIds ?? []).map((id) => {
      const file = this.store.getFile(id);
      if (!file || file.projectId !== member.projectId) throw new ApiError(404, `자료를 찾을 수 없습니다: ${id}`, "file_not_found");
      return file;
    });
    if (input.decisionId && this.store.getDecision(input.decisionId)?.projectId !== member.projectId) {
      throw new ApiError(404, `결재를 찾을 수 없습니다: ${input.decisionId}`, "decision_not_found");
    }
    // 거부된 호출은 보고가 아니다. 턴 마지막 글의 자동 보고를 막으면 안 된다.
    // v1 웹은 첫 자료와 본문 링크를 계속 사용한다. 전체 목록은 Message.fileIds에도 projection한다.
    const extra = files
      .slice(1)
      .map((f) => `[자료: ${f.title.replace(/[\[\]\\]/g, "\\$&")}](#/p/${encodeURIComponent(member.projectId)}/files/${encodeURIComponent(f.id)})`)
      .join("\n\n");
    if (input.correctsMessageId) {
      const previous = this.store.requireMessage(input.correctsMessageId);
      if (previous.projectId !== member.projectId || previous.memberId !== member.id || previous.mine) throw new ApiError(400, "자신이 작성한 보고만 정정할 수 있습니다", "report_not_own");
    }
    const conductor = member.kind === "worker" ? this.store.getConductor(member.projectId) : null;
    let systemInstruction: string | undefined;
    const { value: message, deliveries } = this.store.withDeliveryIntents(() => this.store.createMessage({
      projectId: member.projectId, memberId: member.id, who: member.name, kind: input.kind,
      title: rt.direct ? `(직접) ${input.title}` : input.title,
      body: [input.body ?? "", extra].filter(Boolean).join("\n\n"), decisionId: input.decisionId ?? null, fileId: files[0]?.id ?? null,
    }), message => {
      this.store.noteDelegationPost(member.id, `${message.title}\n${message.body}`);
      this.store.saveReportReferences(member.projectId, { sourceMessageId: message.id, fileIds: files.map(file => file.id), decisionIds: input.decisionId ? [input.decisionId] : [], authoredAt: message.at, sequence: this.store.boardRevision(member.projectId), correctsMessageId: input.correctsMessageId ?? null });
      if (this.missingApprovalCard(member, input)) {
        systemInstruction = formatSystem(APPROVAL_CARD_INSTRUCTION);
        // post 응답으로 한 번만 돌려준다. 업무 입력을 enqueue하거나 직원을 깨우지 않는다.
        this.store.appendActivity(member.id, "system", systemInstruction, `approval-card:${message.id}`);
      }
      return conductor && conductor.id !== member.id ? [{ projectId: member.projectId, memberId: conductor.id, kind: "report", text: this.reportText(message), wake: WAKE_POST_KINDS.has(input.kind), refType: "message", refId: message.id }] : [];
    });
    rt.posted = true;
    await Promise.all(deliveries.map(d => this.port.pump(d.memberId)));
    return { ...this.store.requireMessage(message.id), ...(systemInstruction ? { systemInstruction } : {}) };
  }

  private missingApprovalCard(member: Member, input: PostInput): boolean {
    const report = `${input.title}\n${input.body ?? ""}`;
    if (!needsApprovalCard(report) || this.port.turnContext(member.id).turn?.askedDecisionIds?.size) return false;
    const group = input.group?.trim() || (input.decisionId ? this.store.getDecision(input.decisionId)?.group?.trim() : null);
    const normalizedReport = normalizeSpace(report);
    return !this.store.listOpenDecisions(member.projectId).some(decision =>
      decision.memberId === member.id
      || decision.id === input.decisionId
      || new RegExp(`(?<![\\w-])${decision.id}(?![\\w-])`).test(report)
      || (normalizeSpace(decision.title).length >= 2 && normalizedReport.includes(normalizeSpace(decision.title)))
      || (!!group && decision.group?.trim() === group));
  }

  reportReferences(projectId: string, messageId: string): ReportReferences {
    const message = this.store.requireMessage(messageId);
    if (message.projectId !== projectId || message.mine || !message.memberId) throw new ApiError(404, "보고를 찾을 수 없습니다", "report_not_found");
    return this.store.getReportReferences(projectId, messageId) ?? { sourceMessageId: message.id, fileIds: message.fileId ? [message.fileId] : [], decisionIds: message.decisionId ? [message.decisionId] : [], authoredAt: message.at, sequence: 0, correctsMessageId: null };
  }

  reportText(message: Message): string {
    const refs = this.reportReferences(message.projectId, message.id);
    const direct = message.title.startsWith("(직접) ");
    return `${formatReport(message.who, direct ? `(직접) ${message.kind}` : message.kind, direct ? message.title.slice(5) : message.title, message.body)}\n보고 원본 #${refs.sourceMessageId} · 작성 ${refs.authoredAt} · 순번 ${refs.sequence}\n자료: ${refs.fileIds.join(", ") || "없음"} · 결재: ${refs.decisionIds.join(", ") || "없음"}${refs.correctsMessageId ? ` · 정정 대상 #${refs.correctsMessageId}` : ""}`;
  }

  /** ask. blocking 이면(manual) 호출자가 askWait 로 기다리고, 아니면 text 를 도구 결과로 돌려준다. */
  async registerAsk(member: Member, input: AskInput): Promise<{ decision: Decision; blocking: boolean; text: string }> {
    // 보관한 프로젝트의 카드는 화면에 없고 답도 409 다. 올리면 세션이 답 없는 대기에 묶인다.
    if (this.store.requireProject(member.projectId).archived || this.port.archiving(member.projectId)) throw new ApiError(409, "프로젝트가 보관되어 대표가 답할 수 없습니다. 묻지 말고 턴을 끝내세요", "ask_project_archived");
    const { value: decision, deliveries } = this.store.withDeliveryIntents(() => {
      const decision = this.store.createDecision({
        projectId: member.projectId,
        memberId: member.id,
        who: member.name,
        title: input.title,
        detail: input.detail,
        options: input.options,
        rec: input.rec,
        group: input.group,
        fileId: input.fileId,
        images: input.images,
      });
      this.store.createMessage({
        projectId: member.projectId,
        memberId: member.id,
        who: member.name,
        kind: "질문",
        title: input.title,
        body: input.detail ?? "",
        decisionId: decision.id,
        fileId: input.fileId ?? null,
        attachments: input.images,
      });
      this.store.patchMember(member.id, { status: "waiting" });
      return decision;
    }, decision => {
      const conductor = member.kind === "worker" ? this.store.getConductor(member.projectId) : null;
      return conductor ? [{ projectId: member.projectId, memberId: conductor.id, kind: "system",
        text: formatSystem(`${josa(member.name, "이")} 대표에게 질문했습니다: ${normalizeSpace(input.title)} #${decision.id}`), wake: false }] : [];
    });
    const rt = this.port.turnContext(member.id);
    rt.posted = true;
    if (rt.turn) (rt.turn.askedDecisionIds ??= new Set()).add(decision.id);
    this.port.notifyInbox(`${member.name}의 결재`, input.title);
    await Promise.all(deliveries.map(d => this.port.pump(d.memberId)));
    if (member.origin === "manual") return { decision, blocking: true, text: `질문 #${decision.id} 등록됨. 답을 기다립니다` };
    return { decision, blocking: false, text: `질문 #${decision.id} 등록됨. 턴을 끝내세요. 답은 다음 입력으로 옵니다` };
  }

  /**
   * ask_close. decided는 검증된 대표 글 또는 같은 안건에서 실제 답한 결재의 원문으로만 닫는다.
   * 짧은 버튼 글만으로는 닫지 않는다. 답한 결재 ID·안건 연결·실제 답을 함께 검증하고 감사 기록을 남긴다.
   * 닫으면 물은 직원에게 깨우지 않고 알리고, ask 를 기다리던 직접 띄운 CLI 는 풀어 준다.
   */
  async closeDecision(member: Member, request: { id: string; kind: "decided" | "obsolete"; reason: string; userQuote?: string; answeredDecisionId?: string; sameIssue?: string; followUp: DecisionCloseFollowUp }): Promise<Decision> {
    if (this.store.requireDecision(request.id).kind === "usage_limit") throw new ApiError(403, "사용 한도 알림은 대표만 닫을 수 있습니다", "usage_notice_owner_only");
    // K(E2): 도구 승인 카드는 대표만 답한다. AI 가 닫으면 대표가 볼 승인 요청이 사라진다.
    if (this.store.requireDecision(request.id).kind === "tool_permission") throw new ApiError(403, "도구 승인 요청은 대표만 답할 수 있습니다", "tool_permission_owner_only");
    return this.closeAsk(member, request);
  }

  async closeAsk(member: Member, input: { id: string; kind: DecisionCloseKind; reason: string; userQuote?: string; answeredDecisionId?: string; sameIssue?: string; followUp?: DecisionCloseFollowUp }): Promise<Decision> {
    const decision = this.store.getDecision(input.id);
    if (!decision || decision.projectId !== member.projectId) throw new ApiError(404, `결재를 찾을 수 없습니다: ${input.id}`, "decision_not_found");
    if (member.kind === "worker" && decision.memberId !== member.id) throw new ApiError(403, "직원은 자기가 올린 결재만 닫을 수 있습니다", "decision_not_own");
    if (decision.status !== "open") throw new ApiError(409, decision.status === "closed" ? "이미 닫힌 결재입니다" : "대표가 이미 답한 결재입니다. 닫지 않습니다", "decision_closed");
    const reason = normalizeSpace(input.reason);
    let quote: string | null = null;
    let sourceId: string | null = null;
    let answered: Decision | null = null;
    if (input.answeredDecisionId) {
      if (input.kind !== "decided") throw new ApiError(400, "answered_decision_id는 decided에만 쓸 수 있습니다", "decision_close_invalid");
      answered = this.store.requireDecision(input.answeredDecisionId);
      if (answered.projectId !== member.projectId || !["answered", "delivered"].includes(answered.status) || !answered.answeredAt) throw new ApiError(409, "같은 프로젝트에서 대표가 실제로 답한 결재만 근거로 쓸 수 있습니다", "decision_close_evidence_invalid");
      if (!(decision.group?.trim() && decision.group === answered.group) && (member.kind === "worker" || !input.sameIssue?.trim())) throw new ApiError(409, "같은 그룹이거나 총괄이 same_issue에 같은 안건인 이유를 명시해야 합니다", "decision_close_group_mismatch");
      quote = formatAnswer(answered);
    } else if (input.kind === "decided") {
      const raw = input.userQuote?.trim();
      if (!raw) throw new ApiError(400, "decided 로 닫으려면 user_quote 에 대표가 정한 말을 글자 그대로 실어야 합니다. 대표가 아직 정하지 않았으면 닫지 마세요", "decision_close_quote_required");
      const source = this.findQuoteSource(member.projectId, raw);
      if (!source) throw new ApiError(409, "인용을 대표 글에서 찾지 못해 닫지 않았습니다. 대표가 정하지 않았으면 그대로 두세요", "decision_close_quote_not_found");
      if (quoteNeedsContext({ text: raw, verified: true, source })) throw new ApiError(409, "버튼 글이나 아주 짧은 글은 이 결재를 정했다는 근거가 못 되어 닫지 않았습니다. 대표가 이 일을 정한 문장을 인용하세요", "decision_close_quote_weak");
      quote = normalizeSpace(raw);
      sourceId = source.id;
    }
    const followUp = input.followUp;
    if (followUp?.kind === "instruction") {
      const target = this.store.requireMember(followUp.memberId);
      if (target.projectId !== member.projectId || !followUp.text.trim()) throw new ApiError(400, "후속 지시의 대상·내용을 확인하세요", "follow_up_invalid");
      if ("sourceDecisionId" in followUp) {
        if (!answered || followUp.sourceDecisionId !== answered.id) throw new ApiError(409, "후속 지시의 대표 답이 닫기 근거와 다릅니다", "follow_up_mismatch");
      } else {
        const source = this.store.requireMessage(followUp.sourceMessageId);
        if (answered || source.projectId !== member.projectId || !source.mine) throw new ApiError(400, "후속 지시의 대표 원문을 확인하세요", "follow_up_invalid");
        if (input.kind === "decided" && source.id !== sourceId) throw new ApiError(409, "후속 지시의 대표 원문이 닫기 근거와 다릅니다", "follow_up_mismatch");
        this.refuseOwnerDirectRepeat(target, { text: input.userQuote ?? source.body, verified: true,
          source: { id: source.id, text: source.body, at: source.at } });
      }
    }
    const closed = this.store.transaction(() => {
      const closed = this.store.closeDecision(decision.id, { kind: input.kind, reason, by: member.name, quote });
      if (answered) {
        this.store.auditDecisionClose(decision.id, answered.id, member.id, input.sameIssue?.trim() ?? null, quote!);
        this.store.appendActivity(member.id, "system", `결재 #${decision.id}를 대표 답 #${answered.id}에 따라 닫았습니다${input.sameIssue ? `: ${input.sameIssue}` : " (같은 그룹)"}`, `decision-close:${decision.id}:${decision.updatedAt}`);
        const target = decision.memberId ? this.store.getMember(decision.memberId) : null;
        if (target) this.store.enqueue({ projectId: decision.projectId, memberId: target.id, kind: "system", text: formatSystem(`같은 안건의 결재 #${decision.id}는 대표가 답한 결재 #${answered.id}에 따라 닫혔습니다. 대표 답 원문:\n${quote}`), wake: false });
      }
      if (followUp) {
        this.store.setDecisionFollowUp(decision.id, followUp);
        if (followUp.kind === "instruction") {
          const source = "sourceMessageId" in followUp ? this.store.requireMessage(followUp.sourceMessageId) : null;
          const original = source ? { id: source.id, text: source.body, at: source.at } : { id: answered!.id, text: quote!, at: answered!.answeredAt! };
          const delivery = this.store.enqueue({ projectId: member.projectId, memberId: followUp.memberId, kind: "instruction", text: formatInstruction(member.name, `${followUp.text}\n결재 #${decision.id} 닫기의 후속 지시`, { text: source ? input.userQuote ?? source.body : quote!, verified: true, source: original }) });
          this.store.noteDelegation(member.id, delivery, this.port.isBusy(this.store.requireMember(followUp.memberId)));
          this.store.afterCommit(() => { void this.port.pump(followUp.memberId); });
        }
      }
      return closed;
    });
    const why = `${reason}${sourceId ? ` (대표가 이미 정함, 대표 글 #${sourceId})` : answered ? ` (대표 답 #${answered.id})` : ""}`;
    const asker = decision.memberId ? this.store.getMember(decision.memberId) : null;
    if (asker?.origin === "manual") this.wakeAll(this.askWaiters, decision.id);
    if (asker && asker.id !== member.id && asker.origin !== "manual" && !answered) {
      await this.port.deliver({ projectId: decision.projectId, memberId: asker.id, kind: "system", text: formatSystem(`결재 #${decision.id} 가 닫혔습니다: ${why}. 질문 '${quotedInline(decision.title)}' 의 답은 오지 않습니다`), wake: false });
    }
    if (asker && asker.origin !== "manual") this.port.refreshWaiting(asker.id);
    // 직원이 스스로 닫았으면 총괄의 판도 맞춘다.
    const lead = this.store.getConductor(decision.projectId);
    if (lead && lead.id !== member.id && lead.id !== asker?.id) {
      await this.port.deliver({ projectId: decision.projectId, memberId: lead.id, kind: "system", text: formatSystem(`${josa(member.name, "이")} 결재 #${decision.id} 를 닫았습니다: ${why} (질문 '${quotedInline(decision.title)}')`), wake: false });
    }
    return closed;
  }

  /** todo_close. 대표의 할 일을 끝남·필요 없어짐으로 정리한다. 직원은 자기가 부탁한 할 일만. 부탁한 직원에게 깨우지 않고 알린다. */
  async closeTodo(member: Member, input: { id: string; outcome: TodoOutcome; reason: string }): Promise<Todo> {
    const todo = this.store.getTodo(input.id);
    if (!todo || todo.projectId !== member.projectId) throw new ApiError(404, `할 일을 찾을 수 없습니다: ${input.id}`, "todo_not_found");
    if (member.kind === "worker" && todo.memberId !== member.id) throw new ApiError(403, "직원은 자기가 부탁한 할 일만 정리할 수 있습니다", "todo_not_own");
    const reason = normalizeSpace(input.reason);
    const closed = this.store.closeTodo(todo.id, { outcome: input.outcome, reason, by: member.name });
    const label = input.outcome === "done" ? "끝남" : "필요 없어짐";
    const requester = todo.memberId ? this.store.getMember(todo.memberId) : null;
    if (requester && requester.id !== member.id) {
      // 대표가 체크를 풀면 '아직 안 했음'이 이 글을 바로잡도록 할 일에 잇는다.
      await this.port.deliver({ projectId: todo.projectId, memberId: requester.id, kind: "system", text: formatSystem(`${josa(member.name, "이")} 대표의 할 일 #${todo.id} 를 정리했습니다(${label}): ${reason} (할 일 '${quotedInline(todo.title)}')`), wake: false, refType: "todo", refId: todo.id });
    }
    const lead = this.store.getConductor(todo.projectId);
    if (lead && lead.id !== member.id && lead.id !== requester?.id) {
      await this.port.deliver({ projectId: todo.projectId, memberId: lead.id, kind: "system", text: formatSystem(`${josa(member.name, "이")} 대표의 할 일 #${todo.id} 를 정리했습니다(${label}): ${reason} (할 일 '${quotedInline(todo.title)}')`), wake: false });
    }
    return closed;
  }

  setMemberStatus(member: Member, now: string, next?: string): Member {
    return this.store.patchMember(member.id, { now: normalizeSpace(now), ...(next !== undefined ? { next: normalizeSpace(next) } : {}) });
  }

  setProjectNow(projectId: string, text: string): Project {
    return this.store.patchProject(projectId, { now: text });
  }

  setWork(projectId: string, input: { id?: string; sec: WorkSec; title: string; detail?: string; who?: string }): WorkItem {
    return this.store.upsertWork({ projectId, ...input });
  }

  /** 직접 띄운 CLI 의 wait. 밀린 지시를 한 글로 묶어 돌려준다. 없으면 null. */
  async waitInbox(member: Member, timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return null;
    const first = this.takeInbox(member);
    if (first) return first;
    await this.waitOn(this.inboxWaiters, member.id, timeoutMs, signal);
    // 끊긴 연결로 응답을 보내면 지시가 받은 것으로 표시된 채 사라진다.
    if (signal?.aborted) return null;
    return this.takeInbox(member);
  }

  private materializeManualAnswers(member: Member): void {
    if (this.store.requireProject(member.projectId).archived || this.port.archiving(member.projectId)) return;
    this.store.transaction(() => {
      for (const decision of this.store.listUnreceivedAnswers(member.id)) {
        if (!this.store.listDeliveries(member.projectId).some(d => d.refType === "decision" && d.refId === decision.id && d.memberId === member.id)) this.store.enqueue({ projectId: member.projectId, memberId: member.id, kind: "answer", text: formatAnswer(decision), refType: "decision", refId: decision.id });
      }
    });
  }

  async manualInbox(memberId: string, timeoutMs: number, signal?: AbortSignal): Promise<ManualInboxBatch | null> {
    const take = () => {
      const member = this.store.requireMember(memberId);
      if (member.origin !== "manual") throw new ApiError(409, "직접 띄운 직원만 수신함을 사용할 수 있습니다", "manual_inbox_only");
      if (signal?.aborted || this.store.requireProject(member.projectId).archived || this.port.archiving(member.projectId)) return null;
      this.materializeManualAnswers(member);
      return this.store.manualInbox(memberId);
    };
    if (signal?.aborted) return null;
    const first = take();
    if (first) return first;
    await this.waitOn(this.inboxWaiters, memberId, Math.min(Math.max(timeoutMs, 0), 50_000), signal);
    return take();
  }

  async acknowledgeManualInbox(memberId: string, request: ManualInboxAckRequest): Promise<ManualInboxAckResult> {
    const member = this.store.requireMember(memberId);
    this.port.requireActive(this.store.requireProject(member.projectId));
    if (member.origin !== "manual") throw new ApiError(409, "직접 띄운 직원만 수신함을 사용할 수 있습니다", "manual_inbox_only");
    const result = this.store.acknowledgeManualInbox(memberId, request.batchId);
    this.port.reconcileTodoCorrections();
    for (const item of this.store.getManualInboxBatch(memberId, request.batchId)!.items) if (item.ref?.type === "decision") this.wakeAll(this.askWaiters, item.ref.id);
    return result;
  }

  /** v1 compatibility: delivery and ACK are inseparable in the old string response. */
  private takeInbox(member: Member): string | null {
    if (this.store.requireProject(member.projectId).archived || this.port.archiving(member.projectId)) return null;
    this.materializeManualAnswers(member);
    const batch = this.store.manualInbox(member.id);
    if (!batch) return null;
    this.store.acknowledgeManualInbox(member.id, batch.id);
    this.port.reconcileTodoCorrections();
    return batch.items.map(item => item.text).join("\n\n");
  }

  private waitOn(table: Map<string, Set<() => void>>, key: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((done) => {
      if (this.port.closed() || signal?.aborted) return done();
      const waiters = table.get(key) ?? new Set<() => void>();
      table.set(key, waiters);
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        waiters.delete(finish);
        if (waiters.size === 0 && table.get(key) === waiters) table.delete(key);
        done();
      };
      const timer = setTimeout(finish, timeoutMs);
      signal?.addEventListener("abort", finish, { once: true });
      waiters.add(finish);
    });
  }

  private wakeAll(table: Map<string, Set<() => void>>, key: string): void {
    for (const wake of [...(table.get(key) ?? [])]) wake();
  }
}

/**
 * 인용이 낱말 경계에 맞게 들어 있는가. '삭제는 하지 마'에서 '삭제'만 잘라 오면 조사에서 끊겨 맞지 않는다.
 * 공백·문장 부호에서 시작하고 끝나야 한다.
 */
function includesWhole(text: string, quote: string): boolean {
  const boundary = /[\s.,!?;:…·"'“”‘’()[\]{}<>~\-—–/]/;
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
    const before = at === 0 ? " " : text[at - 1]!;
    const after = at + quote.length >= text.length ? " " : text[at + quote.length]!;
    if (boundary.test(before) && boundary.test(after)) return true;
  }
  return false;
}
