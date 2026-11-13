// 판 정리(I): 주기 판 정리, 묵은 할 일 알림, 대표의 '지금 판 정리', 직접 띄운 CLI 의 상태 추정.
// orchestrator.ts 에서 옮겨 왔다(동작은 그대로다). 원본은 저장소에 쓰고 전달은 줄 세운 뒤 펌프만 민다.
import type { Delivery, Member, Project, TidyResult } from "../shared/types.ts";
import { formatSystem, formatTidy, isTidy, quotedInline } from "./delivery-text.ts";
import { josa } from "./roles.ts";
import { ApiError, type Store } from "./store.ts";

/** 판 정리가 Orchestrator 에서 받는 것. 세션 수명과 펌프는 Orchestrator 가 그대로 맡는다. */
export interface BoardHygienePort {
  readonly store: Store;
  /** manualIdleMs·manualOfflineMs 를 부를 때마다 읽는다. */
  readonly timings: { readonly manualIdleMs: number; readonly manualOfflineMs: number };
  /** 서버를 닫는 중이다. */
  closed(): boolean;
  /** 보관 전에 칸을 끝내는 중인 프로젝트. 전달은 보관된 것처럼 멈춘다. */
  archiving(projectId: string): boolean;
  /** 총괄이 일하거나(턴·실행기의 일하는 중·압축 펜스) 세션을 띄우기·다시 열기·전달·닫기 중이다. */
  leadBusy(lead: Member): boolean;
  /** 지금 도는 턴에 실린 전달. 턴이 없으면 undefined. */
  turnDeliveries(memberId: string): Delivery[] | undefined;
  /** 보관했거나 보관 중인 프로젝트면 ApiError(409). */
  requireActive(project: Project): void;
  ensureConductor(projectId: string): Promise<Member>;
  pump(memberId: string): Promise<void>;
}

export class BoardHygiene {
  private readonly store: Store;

  constructor(private readonly port: BoardHygienePort) {
    this.store = port.store;
  }

  /** Passive reminders never pump, start a session, or wake a sleeping member. */
  checkStaleTodos(now = Date.now()): string[] {
    const queued: string[] = [];
    if (this.port.closed()) return queued;
    for (const project of this.store.listProjects()) {
      if (this.port.archiving(project.id)) continue;
      for (const todo of this.store.listStaleTodos(project.id, now)) {
        const requester = todo.memberId ? this.store.getMember(todo.memberId) : null;
        const target = requester?.kind === "worker" ? requester : this.store.getConductor(project.id);
        if (!target) continue;
        const days = Math.floor((now - Date.parse(todo.createdAt)) / 86_400_000);
        if (this.store.remindStaleTodo(todo, target.id, formatSystem(`네가 부탁한 대표의 할 일 #${todo.id} '${quotedInline(todo.title)}' 이 ${days}일째 열려 있다. 다음에 그 일을 할 때 됐는지 직접 확인하고 그 결과를 근거로 todo_close 로 정리해라. 필요 없어졌으면 dropped.`), now)) queued.push(todo.id);
      }
    }
    return queued;
  }

  /**
   * 주기 판 정리: 활성·연결·총괄 idle·중복 방지 조건을 유지한다.
   * 변경+설정 간격 또는 묵은 할 일+24시간 경과 시 요청한다. 정리만 하려고 세션을 띄우지 않는다.
   */
  checkBoardTidy(now = Date.now()): string[] {
    const hours = this.store.getSettings().boardTidyHours;
    if (!(hours > 0) || this.port.closed()) return [];
    const queued: string[] = [];
    for (const project of this.store.listProjects()) {
      if (!project.runnerEnabled || !project.connection.ok || this.port.archiving(project.id)) continue;
      const lead = this.store.getConductor(project.id);
      if (!lead || lead.origin !== "runner" || (!lead.sessionId && !lead.paneId)) continue;
      if (lead.status !== "idle" && lead.status !== "waiting") continue;
      if (this.port.leadBusy(lead)) continue;
      if (this.tidyPending(lead.id)) continue;
      // 한 번도 정리하지 않았으면 총괄이 뜬 때부터 센다.
      const review = this.store.getBoardReview(project.id);
      const since = review?.requestedAt ?? project.tidiedAt ?? lead.createdAt;
      const staleDue = this.store.listStaleTodos(project.id, now).length > 0 && this.store.staleReviewDue(project.id, now);
      if (!staleDue && now - Date.parse(since) < hours * 3_600_000) continue;
      const changed = this.store.lastBoardChangeAt(project.id);
      if (!staleDue && (review?.completedAt ? this.store.boardRevision(project.id) <= (review.reviewedRevision ?? -1) : !review && (!changed || changed <= since))) continue;
      this.queueBoardReview(project.id, lead, false, new Date(now).toISOString());
      void this.port.pump(lead.id);
      queued.push(project.id);
    }
    return queued;
  }

  private queueBoardReview(projectId: string, lead: Member, manual: boolean, at = new Date().toISOString()): void {
    this.store.transaction(() => {
      this.store.requestBoardReview(projectId, at);
      if (this.store.listStaleTodos(projectId, Date.parse(at)).length) this.store.markStaleReview(projectId, at);
      this.store.enqueue({ projectId, memberId: lead.id, kind: "system", text: formatTidy(lead.kind, manual) });
    });
  }

  /** 판 정리 지시가 줄 서 있거나 지금 그 턴이 돈다. */
  private tidyPending(memberId: string): boolean {
    if (this.port.turnDeliveries(memberId)?.some(isTidy)) return true;
    if (this.store.listPendingExecutions().some(run => run.memberId === memberId && run.deliveryIds.some(id => { const delivery = this.store.getDelivery(id); return delivery && isTidy(delivery); }))) return true;
    return this.store.listPending(memberId).some(isTidy);
  }

  /**
   * 대표의 '지금 판 정리'. 간격·바뀐 것을 따지지 않는다. 총괄이 없거나 잠들었으면 띄운다. 연결은 http 가 먼저 본다(409).
   * 이미 기다리거나 도는 판 정리가 있으면 새로 넣지 않는다.
   */
  async tidyBoard(projectId: string): Promise<TidyResult> {
    const project = this.store.requireProject(projectId);
    this.port.requireActive(project);
    if (!project.runnerEnabled) throw new ApiError(409, "이 프로젝트는 실행이 꺼져 있습니다. 총괄을 먼저 시작하세요", "runner_disabled");
    const lead = this.store.getConductor(projectId) ?? (await this.port.ensureConductor(projectId));
    if (lead.origin === "adopted") throw new ApiError(409, `${josa(lead.name, "은")} 이전 실행기에서 넘겨받은 세션이라 도구가 없어 판을 정리할 수 없습니다`, "board_tidy_legacy_lead");
    if (this.tidyPending(lead.id)) return { already: true };
    this.queueBoardReview(projectId, lead, true);
    await this.port.pump(lead.id);
    return { already: false };
  }

  /** 직접 띄운 CLI 는 실행기가 없어 도구 호출 시각으로만 상태를 안다. */
  checkManualMembers(): void {
    const now = Date.now();
    for (const m of this.store.listAllMembers()) {
      if (m.origin !== "manual") continue;
      const quiet = now - new Date(m.updatedAt).getTime();
      // 답을 기다리는 세션은 브리지가 롱폴을 다시 걸 때마다 시각이 새로워진다. 그것마저 끊겼으면 죽은 것이다.
      if (quiet >= this.port.timings.manualOfflineMs && (m.status === "idle" || m.status === "working" || m.status === "waiting")) this.store.patchMember(m.id, { status: "offline" });
      else if (quiet >= this.port.timings.manualIdleMs && m.status === "working") this.store.patchMember(m.id, { status: "idle" });
    }
  }

  /** 도구를 부르면 살아 있고 일하는 중이다. wait 는 지시를 기다리는 것이니 대기다. */
  noteManualCall(member: Member, tool: string): void {
    if (member.origin !== "manual") return;
    const next = tool === "wait" ? "idle" : tool === "ask_wait" || member.status === "waiting" ? "waiting" : "working";
    if (member.status !== next) this.store.patchMember(member.id, { status: next });
  }
}
