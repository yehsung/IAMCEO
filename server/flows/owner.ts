// 대표 쪽 업무 흐름(G): 대표의 메시지·결재 답·할 일 완료, 대표가 AI 가 닫은 결재를 다시 열기,
// 받을 사람이 없어 멈춘 대표의 글을 총괄에게 넘기기. orchestrator.ts 에서 옮겨 왔다(동작은 그대로다).
// 원본을 저장소에 쓰고 전달 의도를 줄 세운 뒤 펌프를 민다. 총괄 띄우기·펌프·턴 상태는 Orchestrator 가 맡고, 여기서는 포트로만 부른다.
import { copyFileSync, existsSync, linkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RevisionPrecondition, TodoDoneRequest, TodoWriteResult } from "../../shared/operations.ts";
import type { AnswerReq, Attachment, Decision, Delivery, Member, Message, Project, SendMessageReq, Todo } from "../../shared/types.ts";
import type { DeliveryRecovery } from "../delivery-recovery.ts";
import { attachmentLines, formatAnswer, formatSystem, formatTodoDone, formatTodoUndone, formatUserMessage, normalizeSpace, quotedInline } from "../delivery-text.ts";
import { sanitizeName } from "../files.ts";
import { HOLD_NOTES } from "../hold-codes.ts";
import { josa } from "../roles.ts";
import { ApiError, type NewDelivery, type Store } from "../store.ts";
import { WAKE_POST_KINDS } from "./member.ts";

/** 대표 쪽 흐름이 Orchestrator 에서 받는 것: 원본 저장(store), 전달 의도와 펌프, 그리고 총괄 띄우기 같은 세션 수명의 입구. */
export interface OwnerFlowPort {
  readonly store: Store;
  readonly deliveryRecovery: DeliveryRecovery;
  /** IAMCEO 데이터 폴더. 첨부를 직원별 inbox 폴더로 잇는다. */
  readonly home: string;
  /** 서버를 닫는 중이다. */
  closed(): boolean;
  pump(memberId: string): Promise<void>;
  /** 줄 세우고 곧바로 민다. */
  deliver(input: NewDelivery): Promise<Delivery>;
  /** 보관했거나 보관 중인 프로젝트면 ApiError(409). */
  requireActive(project: Project): void;
  /** 총괄을 명부에 올리고 띄우기 시작한다. retainOnFailure: 띄우지 못해도 명부에 남겨 대표의 글을 붙잡아 둔다. */
  beginConductor(project: Project, retainOnFailure: boolean): { member: Member; ready: Promise<void> };
  ensureConductor(projectId: string): Promise<Member>;
  /** 실행을 켠 프로젝트: 멈춘 글을 총괄에게 넘기고 모든 직원의 전달을 민다. */
  enableProject(projectId: string): Promise<void>;
  /** 실행기 연결만 다시 본다(화면 요청용). */
  refreshHealth(): Promise<void>;
  /** waiting 인데 답하지 않은 결재가 남지 않았으면 지금 하는 대로 고친다. */
  refreshWaiting(memberId: string): void;
  isBusy(member: Member): boolean;
  /** 턴 밖의 상태로 돌린다(답하지 않은 결재가 있으면 waiting, 없으면 idle). */
  settle(member: Member): void;
  /** 결재 답을 기다리는 직접 띄운 CLI 를 깨운다(flows/member.ts). */
  wakeAsk(decisionId: string): void;
  /** 직접 띄운 CLI 의 수신함 대기를 깨운다(flows/member.ts). */
  wakeInbox(memberId: string): void;
  /** 직원 보고를 총괄에게 보내는 글(flows/member.ts). */
  reportText(message: Message): string;
}

export class OwnerFlows {
  private readonly store: Store;

  constructor(private readonly port: OwnerFlowPort) {
    this.store = port.store;
  }

  /** 받을 사람이 없어 멈춘 대표의 말·답·완료를 총괄에게 넘긴다. */
  async adoptOrphans(projectId: string): Promise<void> {
    if (this.orphanMessages(projectId).length + this.orphanAnswers(projectId).length + this.orphanTodos(projectId).length === 0) return;
    const conductor = await this.port.ensureConductor(projectId);
    // 기다리는 사이 겹친 호출이 이미 넘겼을 수 있다. 여기부터 줄 세우기까지 await 가 없어야 두 번 넘기지 않는다.
    const messages = this.orphanMessages(projectId);
    const answers = this.orphanAnswers(projectId);
    const todos = this.orphanTodos(projectId);
    for (const message of messages) {
      this.store.enqueue({
        projectId,
        memberId: conductor.id,
        kind: "user_message",
        text: formatUserMessage(message.body, this.attachmentsFor(conductor, message.attachments), message.id, false) + this.messageContext(message),
        refType: "message",
        refId: message.id,
      });
    }
    for (const d of answers) this.store.enqueue({ projectId, memberId: conductor.id, kind: "answer", text: formatAnswer(d), refType: "decision", refId: d.id });
    for (const t of todos) {
      this.store.enqueue({ projectId, memberId: conductor.id, kind: "todo_done", text: this.todoDoneText(t, conductor), refType: "todo", refId: t.id });
      this.store.setTodoNoticePending(t.id, false);
    }
  }

  /** 실행이 켜진 프로젝트에서 총괄을 못 띄워 멈춘 말이 있으면 다시 시도한다. 실행기가 돌아오면 저절로 풀린다. */
  private repairSourceIntents(projectId: string): void {
    this.store.transaction(() => {
      for (const message of this.store.listMessagesMissingDeliveries(projectId)) {
        const member = message.targetMemberId ? this.store.getMember(message.targetMemberId) : null;
        if (member) this.store.enqueue({ projectId, memberId: member.id, kind: "user_message", text: formatUserMessage(message.body, this.attachmentsFor(member, message.attachments), message.id, true) + this.messageContext(message), refType: "message", refId: message.id });
      }
      for (const decision of this.store.listAnswersMissingDeliveries(projectId)) {
        const member = decision.memberId ? this.store.getMember(decision.memberId) : null;
        if (member && member.origin !== "manual") this.store.enqueue({ projectId, memberId: member.id, kind: "answer", text: formatAnswer(decision), refType: "decision", refId: decision.id });
      }
      const lead = this.store.getConductor(projectId);
      if (lead) for (const message of this.store.listReportsMissingDeliveries(projectId)) {
        const author = message.memberId ? this.store.getMember(message.memberId) : null;
        if (author?.kind === "worker" && author.id !== lead.id) this.store.enqueue({ projectId, memberId: lead.id, kind: "report", text: this.port.reportText(message), wake: WAKE_POST_KINDS.has(message.kind), refType: "message", refId: message.id });
      }
    });
  }

  async retryOrphans(): Promise<void> {
    if (this.port.closed()) return;
    for (const project of this.store.listProjects()) {
      if (!project.runnerEnabled) continue;
      this.repairSourceIntents(project.id);
      if (this.store.getConductor(project.id)) {
        await this.adoptOrphans(project.id);
        for (const id of new Set(this.store.listUndelivered(project.id).map(d => d.memberId))) void this.port.pump(id);
        continue;
      }
      // 편입은 세션 하나를 넘겨준 것이다. 대표가 시키지 않은 총괄을 띄워 옛 지시를 실행하지 않는다.
      if (this.store.runnerByAdopt(project.id)) continue;
      if (this.orphanMessages(project.id).length + this.orphanAnswers(project.id).length + this.orphanTodos(project.id).length === 0) continue;
      await this.port.enableProject(project.id).catch((e) => console.warn(`${project.name} 총괄 띄우기 재시도 실패:`, (e as Error).message));
    }
  }

  /** 전달 항목이 없는 대표 메시지: 총괄이 없을 때 보류됐거나, 총괄을 띄우다 실패해 항목째 사라졌다. */
  private orphanMessages(projectId: string): Message[] {
    return this.store.listMessagesMissingDeliveries(projectId).filter(m => !m.targetMemberId);
  }

  /** 답했는데 물은 직원이 없어(가져온 카드, 닫힌 직원) 아무에게도 가지 않은 결재. */
  private orphanAnswers(projectId: string): Decision[] {
    return this.store.listAnswersMissingDeliveries(projectId).filter(d => !d.memberId || !this.store.getMember(d.memberId));
  }

  private orphanTodos(projectId: string): Todo[] {
    return this.store.listTodoNoticesPending(projectId);
  }

  /** Legacy retry requests schedule evidence collection and never bypass a fence. */
  async resendMessage(existing: Message): Promise<Message> {
    const current = this.store.requireMessage(existing.id);
    if (current.delivery !== "failed") return current;
    const target = current.targetMemberId ? this.store.getMember(current.targetMemberId) : null;
    if (current.targetMemberId && !target) throw new ApiError(409, "그 팀원이 닫혀 다시 보낼 수 없습니다. 새 글로 보내세요", "resend_member_closed");
    await this.port.refreshHealth();
    this.store.requireReachable(current.projectId, target);
    let deliveries = this.store.listDeliveries(current.projectId).filter(d => d.refType === "message" && d.refId === current.id);
    if (!deliveries.length) deliveries = [this.port.deliveryRecovery.materializeLegacyMessage(current.id)];
    for (const d of deliveries) {
      if (d.status !== "delivered") this.port.deliveryRecovery.beginRecovery(d.id);
    }
    await this.port.deliveryRecovery.tick();
    return this.store.requireMessage(current.id);
  }

  private messageContext(message: Message): string {
    if (!message.contextFileId) return "";
    const file = this.store.getFile(message.contextFileId);
    return file && file.projectId === message.projectId ? `\n[시스템 자료 맥락 · 대표 원문 아님]\n대표가 보던 자료: ${file.title.replace(/[\r\n]+/g, " ")} (${file.id})` : "";
  }

  async sendUserMessage(projectId: string, req: SendMessageReq): Promise<Message> {
    const project = this.store.requireProject(projectId);
    this.port.requireActive(project);
    if (req.contextFileId && this.store.getFile(req.contextFileId)?.projectId !== projectId) throw new ApiError(400, "이 프로젝트의 자료가 아닙니다", "file_other_project");
    const attachments = (req.attachmentIds ?? []).map(id => this.store.getAttachment(id)).filter((a): a is Attachment => a !== null);
    const target = req.targetMemberId ? this.store.requireMember(req.targetMemberId) : null;
    if (target && target.projectId !== projectId) throw new ApiError(400, "이 프로젝트의 팀원이 아닙니다", "member_not_in_project");
    let recipient = target ?? this.store.getConductor(projectId);
    let booting: Promise<void> | null = null;
    const { value: message, deliveries } = this.store.withDeliveryIntents(() => {
      const message = this.store.createMessage({ id: req.id, projectId, mine: true, who: "나", kind: "나", body: req.text,
        targetMemberId: target?.id ?? null, targetName: target?.name ?? null, attachments, contextFileId: req.contextFileId, delivery: "queued" });
      if (!recipient && project.runnerEnabled) {
        const spawn = this.port.beginConductor(project, true);
        recipient = spawn.member;
        booting = spawn.ready;
      }
      if (!recipient) return this.store.setMessageDelivery(message.id, "held", HOLD_NOTES.runner_disabled);
      return message;
    }, message => {
      if (!recipient) return [];
      const intents: NewDelivery[] = [{ projectId, memberId: recipient.id, kind: "user_message",
        text: formatUserMessage(message.body, this.attachmentsFor(recipient, attachments), message.id, !!target) + this.messageContext(message), refType: "message", refId: message.id }];
      const conductor = this.store.getConductor(projectId);
      if (target && conductor && conductor.id !== target.id) intents.push({ projectId, memberId: conductor.id, kind: "system",
        text: formatSystem(`대표가 ${target.name}에게 직접 지시했습니다 #${message.id}. 이미 ${target.name}에게 전달했습니다. 같은 일을 다시 시키지 말고, 결과 보고를 기다려 판만 맞추세요.`) + this.messageContext(message), wake: false });
      return intents;
    });
    if (booting) void (booting as Promise<void>).catch(e => console.warn(`${project.name} 총괄을 띄우지 못했습니다:`, (e as Error).message));
    for (const id of new Set(deliveries.map(d => d.memberId))) void this.port.pump(id);
    return this.store.requireMessage(message.id);
  }

  /** 첨부를 그 직원의 폴더로 잇는다. CLI 는 이 폴더만 승인 없이 읽고, 다른 프로젝트의 첨부는 열지 않는다. */
  attachmentsFor(member: Member, attachments: Attachment[]): Attachment[] {
    if (attachments.length === 0) return attachments;
    const dir = join(this.port.home, "inbox", member.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return attachments.map((a) => {
      // 전에 올라온 첨부의 이름에는 위험한 글자가 남아 있을 수 있다. 전달 글에 들어가는 경로는 이 이름으로 만든다.
      const dest = join(dir, `${a.id}-${sanitizeName(a.name)}`);
      try {
        if (!existsSync(dest)) {
          try {
            linkSync(a.path, dest);
          } catch {
            copyFileSync(a.path, dest);
          }
        }
        return { ...a, path: dest };
      } catch {
        return a; // 원본이 사라졌으면 그대로 알린다. 읽는 쪽에서 오류가 보인다.
      }
    });
  }

  todoDoneText(todo: Todo, member: Member): string {
    const attachments = (todo.completionFileIds ?? []).map(id => this.store.getAttachment(id)).filter((a): a is Attachment => a !== null);
    return [formatTodoDone(todo), ...attachmentLines(this.attachmentsFor(member, attachments))].join("\n");
  }

  async dropTodo(todoId: string, reason?: string): Promise<Todo> {
    return this.writeTodo(todoId, true, {}, reason?.trim() || "대표가 필요 없음으로 정리");
  }

  async setTodoDone(todoId: string, done: boolean, completion: { note?: string; fileIds?: string[] } = {}): Promise<Todo> {
    return this.writeTodo(todoId, done, completion);
  }

  private async writeTodo(todoId: string, done: boolean, completion: { note?: string; fileIds?: string[] }, dropReason?: string): Promise<Todo> {
    for (const id of completion.fileIds ?? []) if (!this.store.getAttachment(id)) throw new ApiError(400, "업로드된 첨부를 찾을 수 없습니다", "upload_not_found");
    if (!done && (completion.note !== undefined || completion.fileIds?.length)) throw new ApiError(400, "완료할 때만 답과 첨부를 붙일 수 있습니다", "todo_answer_requires_done");
    let targetId: string | null = null;
    const { todo, changed } = this.store.transaction(() => {
      const before = this.store.requireTodo(todoId);
      if (before.done !== done) this.store.setTodoCompletion(todoId, done ? completion.note ?? null : null, done ? completion.fileIds ?? [] : []);
      if (dropReason !== undefined && before.done && before.outcome !== "dropped") throw new ApiError(409, "이미 끝났거나 정리된 할 일입니다", "todo_finished");
      const result = dropReason !== undefined && !before.done
        ? { todo: this.store.closeTodo(todoId, { outcome: "dropped", reason: dropReason, by: "대표" }), changed: true }
        : this.store.setTodoDone(todoId, done);
      if (!result.changed) return result;
      const todo = result.todo;
      const target = (todo.memberId ? this.store.getMember(todo.memberId) : null) ?? this.store.getConductor(todo.projectId);
      targetId = target?.id ?? null;
      if (!done) {
        this.store.setTodoNoticePending(todo.id, false);
        this.store.cancelPendingFor("todo", todo.id);
        this.reconcileTodoCorrections(todo.id);
      } else if (target) {
        const delivery = this.store.enqueue({ projectId: todo.projectId, memberId: target.id, kind: "todo_done", text: this.todoDoneText(todo, target), refType: "todo", refId: todo.id });
        this.store.patchDeliveryRetry(delivery.id, { correctionRevision: this.store.todoRevision(todo.id) });
        const conductor = this.store.getConductor(todo.projectId);
        if (conductor && conductor.id !== target.id) {
          const notice = this.store.enqueue({ projectId: todo.projectId, memberId: conductor.id, kind: "todo_done", text: this.todoDoneText(todo, conductor), refType: "todo", refId: todo.id });
          this.store.patchDeliveryRetry(notice.id, { correctionRevision: this.store.todoRevision(todo.id) });
          this.store.afterCommit(() => { void this.port.pump(conductor.id); });
        } else if (!conductor && target.kind === "worker") {
          this.store.setTodoNoticePending(todo.id, true);
        }
      } else this.store.setTodoNoticePending(todo.id, true);
      return result;
    });
    if (changed && done && !targetId && this.store.requireProject(todo.projectId).runnerEnabled && !this.store.runnerByAdopt(todo.projectId)) {
      await this.port.ensureConductor(todo.projectId).catch(e => console.warn("할 일 완료를 받을 총괄을 띄우지 못했습니다:", (e as Error).message));
      await this.adoptOrphans(todo.projectId);
      const conductor = this.store.getConductor(todo.projectId);
      if (conductor && targetId && conductor.id !== targetId) void this.port.pump(conductor.id);
      targetId ??= conductor?.id ?? null;
    }
    if (changed && targetId) {
      if (done) await this.port.pump(targetId);
      else void this.port.pump(targetId);
    }
    return todo;
  }

  /** A successful old send is an external fact. Compensate only after it settles. */
  reconcileTodoCorrections(todoId?: string): void {
    this.store.transaction(() => {
      const groups = new Map<string, Delivery[]>();
      for (const delivery of this.store.listDeliveries()) if (delivery.refType === "todo" && delivery.refId && (!todoId || delivery.refId === todoId)) {
        const key = `${delivery.refId}:${delivery.memberId}`;
        groups.set(key, [...(groups.get(key) ?? []), delivery]);
      }
      for (const deliveries of groups.values()) {
        const delivered = deliveries.filter(d => d.status === "delivered").at(-1);
        if (!delivered?.refId) continue;
        const todo = this.store.getTodo(delivered.refId);
        if (!todo || todo.done) continue;
        const text = formatTodoUndone(todo);
        const revision = this.store.todoRevision(todo.id);
        if (delivered.text === text || deliveries.some(d => d.text === text && this.store.getDeliveryRetry(d.id).correctionRevision === revision)) continue;
        // A still unresolved older write can land after the correction. Wait for evidence.
        if (deliveries.some(d => d.status === "delivering" || this.store.inputState(d.memberId).unresolvedDispatches.some(dispatch => dispatch.items.some(item => item.deliveryId === d.id)))) continue;
        const correction = this.store.enqueue({ projectId: todo.projectId, memberId: delivered.memberId, kind: "todo_done", text, refType: "todo", refId: todo.id });
        this.store.patchDeliveryRetry(correction.id, { correctionRevision: revision });
        this.store.afterCommit(() => { void this.port.pump(correction.memberId); });
      }
    });
  }

  /** 대표가 AI 가 닫은 결재를 다시 연다. 결재할 항목으로 돌아가고, 물은 직원과 총괄에게 깨우지 않고 알린다. */
  async reopenDecision(decisionId: string): Promise<Decision> {
    const decision = this.store.requireDecision(decisionId);
    this.port.requireActive(this.store.requireProject(decision.projectId));
    if (decision.status !== "closed" || !decision.closeKind) throw new ApiError(409, "AI가 닫은 결재만 다시 열 수 있습니다", "decision_reopen_refused");
    const reopened = this.store.reopenDecision(decisionId, `${josa(decision.closedBy ?? "AI", "이")} 닫았던 결재를 대표가 다시 열었습니다${decision.closeReason ? `(닫은 이유: ${normalizeSpace(decision.closeReason)})` : ""}`);
    const asker = decision.memberId ? this.store.getMember(decision.memberId) : null;
    const note = `대표가 결재 #${decision.id} 를 다시 열었습니다(질문 '${quotedInline(decision.title)}'). 닫은 것은 취소이며 답이 오면 전달됩니다`;
    if (asker && asker.origin !== "manual") {
      await this.port.deliver({ projectId: decision.projectId, memberId: asker.id, kind: "system", text: formatSystem(note), wake: false });
      const fresh = this.store.getMember(asker.id);
      if (fresh?.status === "idle" && !this.port.isBusy(fresh)) this.port.settle(fresh);
    }
    const lead = this.store.getConductor(decision.projectId);
    if (lead && lead.id !== asker?.id) await this.port.deliver({ projectId: decision.projectId, memberId: lead.id, kind: "system", text: formatSystem(note), wake: false });
    return this.store.requireDecision(reopened.id);
  }

  async setTodoDoneV2(todoId: string, request: TodoDoneRequest, precondition: RevisionPrecondition): Promise<TodoWriteResult> {
    if (this.store.todoRevision(todoId) !== precondition.expectedRevision) throw new ApiError(409, "할 일이 변경되었습니다", "REVISION_CONFLICT");
    const writing = this.setTodoDone(todoId, request.done, request);
    const revision = this.store.todoRevision(todoId);
    const todo = await writing;
    return { todo, revision };
  }

  async dropTodoV2(todoId: string, request: { reason?: string }, precondition: RevisionPrecondition): Promise<TodoWriteResult> {
    if (this.store.todoRevision(todoId) !== precondition.expectedRevision) throw new ApiError(409, "할 일이 변경되었습니다", "REVISION_CONFLICT");
    const writing = this.dropTodo(todoId, request.reason);
    const revision = this.store.todoRevision(todoId);
    return { todo: await writing, revision };
  }

  /** 보통 결재의 답(도구 승인·사용 한도 카드는 Orchestrator.answerDecision 이 먼저 가른다). 물은 직원에게 보내고, 총괄에게는 깨우지 않는 소식으로 알린다. */
  answerDecision(decisionId: string, req: AnswerReq): Decision {
    let booting: Promise<void> | null = null;
    const { value: { decision, changed }, deliveries } = this.store.withDeliveryIntents(() => this.store.answerDecision(decisionId, req), ({ decision, changed }) => {
      if (!changed) return [];
      const asker = decision.memberId ? this.store.getMember(decision.memberId) : null;
      let conductor = this.store.getConductor(decision.projectId);
      const project = this.store.requireProject(decision.projectId);
      if (!asker && !conductor && project.runnerEnabled && !this.store.runnerByAdopt(project.id)) {
        const spawn = this.port.beginConductor(project, true);
        conductor = spawn.member;
        booting = spawn.ready;
      }
      const recipient = asker ?? conductor;
      const intents: NewDelivery[] = [];
      if (recipient && asker?.origin !== "manual") intents.push({ projectId: project.id, memberId: recipient.id, kind: "answer", text: formatAnswer(decision), refType: "decision", refId: decision.id });
      if (conductor && recipient && conductor.id !== recipient.id) intents.push({ projectId: project.id, memberId: conductor.id, kind: "system",
        text: formatSystem(`대표가 ${decision.who}의 결재에 답했습니다. 이미 ${decision.who}에게 전달했습니다. 같은 일을 다시 시키지 말고, 결과 보고를 기다려 판만 맞추세요.\n${formatAnswer(decision)}`), wake: false });
      return intents;
    });
    if (!changed) return decision;
    if (booting) void (booting as Promise<void>).catch(e => console.warn("결재 답을 받을 총괄을 띄우지 못했습니다:", (e as Error).message));
    this.port.wakeAsk(decisionId);
    if (decision.memberId) this.port.wakeInbox(decision.memberId);
    for (const id of new Set(deliveries.map(d => d.memberId))) void this.port.pump(id);
    const asker = decision.memberId ? this.store.getMember(decision.memberId) : null;
    if (asker && asker.origin !== "manual") this.port.refreshWaiting(asker.id);
    return this.store.requireDecision(decisionId);
  }
}
