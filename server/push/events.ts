import { createHash } from "node:crypto";
import type { Decision, Member, Message } from "../../shared/types.ts";
import type { DomainRecorder } from "../service-contracts.ts";
import { PushStore } from "./store.ts";
import type { PushEpisode } from "./store.ts";

/** Compare normalized errors without persisting or transmitting the error text. */
export function pushErrorDigest(error: string | null): string | null {
  const normalized = error?.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return normalized ? createHash("sha256").update(normalized).digest("hex") : null;
}
type ApprovalState = Pick<Member, "status" | "blockedReason"> & Partial<Pick<Member, "statusObservation">>;
export function isPushApproval(member: ApprovalState): boolean {
  return member.status === "blocked" && (member.blockedReason === "permission" || member.blockedReason === "selection" ||
    (member.blockedReason === "setup" && member.statusObservation?.source === "core" && member.statusObservation.error?.code === "folder_trust"));
}
function baseline(member: ApprovalState & Pick<Member, "id" | "lastError">): PushEpisode {
  return { memberId: member.id, blockedGeneration: 0, blockedActive: isPushApproval(member), errorGeneration: 0,
    errorActive: member.status === "error" || pushErrorDigest(member.lastError) !== null, errorDigest: pushErrorDigest(member.lastError) };
}

/** Synchronous SQL-only recorder. The caller must write the domain object on push.db in the same transaction.
 * No subscriptions: Bus rebroadcasts and network retries cannot create events. Production wiring belongs to W5/W6.
 */
export class PushEventRecorder implements DomainRecorder {
  constructor(readonly push: PushStore) {
    // INSERT only missing baselines. Restart must never reset generations or emit old incidents.
    push.transaction(() => {
      for (const row of push.db.query<{ id: string; status: Member["status"]; last_error: string | null; blocked_reason: Member["blockedReason"]; status_observation_json: string | null }, []>(
        "SELECT id,status,last_error,blocked_reason,status_observation_json FROM members").all()) {
        let statusObservation: Member["statusObservation"] = null;
        try { statusObservation = row.status_observation_json ? JSON.parse(row.status_observation_json) : null; } catch { /* No inferred approval from unreadable evidence. */ }
        if (!push.getEpisode(row.id)) push.saveEpisode(baseline({ id: row.id, status: row.status, lastError: row.last_error, blockedReason: row.blocked_reason, statusObservation }));
      }
    });
  }
  private requireDomainTransaction(): void {
    if (!this.push.db.inTransaction) throw new Error("PushEventRecorder requires the domain transaction on the same database");
  }
  decision(before: Decision | null, after: Decision): void {
    this.requireDomainTransaction();
    this.push.transaction(() => {
      if (after.status === "open" && (!before || before.status !== "open")) {
        this.push.recordEvent({ sourceKey: `ask:${after.id}:${after.updatedAt}`, kind: "decision", projectId: after.projectId,
          memberId: after.memberId, target: { screen: "inbox", projectId: after.projectId, decisionId: after.id }, occurredAt: this.push.timestamp() });
      }
      this.push.cancelInvalidPending();
    });
  }
  message(message: Message): void {
    if (message.mine || !message.memberId || (message.kind !== "완료" && message.kind !== "막힘")) return;
    this.requireDomainTransaction();
    if (message.kind === "완료") this.push.appendReport(message);
    else this.push.recordEvent({ sourceKey: `report-blocked:${message.id}`, kind: "report_blocked", projectId: message.projectId,
      memberId: message.memberId, target: { screen: "chat", projectId: message.projectId, memberId: message.memberId, messageId: message.id }, occurredAt: this.push.timestamp() });
  }
  /**
   * context.restartOwned(D2-4·D4-2): 재시작(Mac·실행 엔진)으로 꺼져 서버가 스스로 다시 여는 중인 팀장이다(재시작 깨우기 표식이 기다림·여는 중).
   * 그동안의 오류(꺼짐 안내, 다시 열기 실패)는 이 팀장 하나로 알리지 않고 사건 상태만 적는다. 한 번의 재시작으로 팀장 수만큼 '오류' 알림이 갔다
   * (11-13 두 번, 각 15건 — 1분 안에 모두 다시 열렸다). 다시 열기에 실패한 팀장이 있으면 그 묶음이 끝날 때 한 번만 알린다(restartFailures).
   */
  member(before: Member, after: Member, context: { restartOwned?: boolean } = {}): void {
    this.requireDomainTransaction();
    this.push.transaction(() => {
      const episode = this.push.getEpisode(after.id) ?? baseline(before);
      const blocked = isPushApproval(after) || (episode.blockedActive && after.status === "blocked" && after.blockedReason === "setup" &&
        before.blockedReason === "setup" && after.statusObservation?.freshness === "stale");
      const digest = pushErrorDigest(after.lastError);
      const error = after.status === "error" || digest !== null;
      const newBlocked = blocked && !episode.blockedActive;
      const newError = error && (!episode.errorActive || (digest !== null && digest !== episode.errorDigest)) && !context.restartOwned;
      if (newBlocked) episode.blockedGeneration++;
      if (newError) episode.errorGeneration++;
      episode.blockedActive = blocked;
      episode.errorActive = error;
      // An error status with no text does not erase the digest of its active incident.
      episode.errorDigest = error ? digest ?? episode.errorDigest : null;
      this.push.saveEpisode(episode);
      if (newBlocked) this.push.recordEvent({ sourceKey: `blocked:${after.id}:${episode.blockedGeneration}`, kind: "approval_wait",
        projectId: after.projectId, memberId: after.id, target: { screen: "team", projectId: after.projectId, memberId: after.id }, occurredAt: this.push.timestamp() });
      if (newError) this.push.recordEvent({ sourceKey: `error:${after.id}:${episode.errorGeneration}`, kind: "error",
        projectId: after.projectId, memberId: after.id, target: { screen: "team", projectId: after.projectId, memberId: after.id }, occurredAt: this.push.timestamp() });
      this.push.cancelInvalidPending();
    });
  }
  /**
   * 재시작으로 꺼진 팀장을 서버가 다시 여는 한 묶음이 끝났고, 그 가운데 다시 열지 못한 팀장이 있다. 오류 알림을 한 번만 낸다
   * (아직 오류 상태인 첫 팀장의 팀 화면으로. 알림 글은 종류별 고정 문구라 이름·수는 싣지 않는다. 대화의 요약 글에 다 있다).
   * 이미 다른 길로 깨어나 오류가 풀린 팀장은 빼고, 남은 팀장이 없으면 알리지 않는다.
   */
  restartFailures(members: readonly Member[]): void {
    this.requireDomainTransaction();
    this.push.transaction(() => {
      const first = members.find(member => this.push.getEpisode(member.id)?.errorActive);
      if (!first) return;
      const episode = this.push.getEpisode(first.id)!;
      episode.errorGeneration++;
      this.push.saveEpisode(episode);
      this.push.recordEvent({ sourceKey: `error:${first.id}:${episode.errorGeneration}`, kind: "error",
        projectId: first.projectId, memberId: first.id, target: { screen: "team", projectId: first.projectId, memberId: first.id }, occurredAt: this.push.timestamp() });
      this.push.cancelInvalidPending();
    });
  }
}
