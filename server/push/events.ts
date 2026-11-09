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
  member(before: Member, after: Member): void {
    this.requireDomainTransaction();
    this.push.transaction(() => {
      const episode = this.push.getEpisode(after.id) ?? baseline(before);
      const blocked = isPushApproval(after) || (episode.blockedActive && after.status === "blocked" && after.blockedReason === "setup" &&
        before.blockedReason === "setup" && after.statusObservation?.freshness === "stale");
      const digest = pushErrorDigest(after.lastError);
      const error = after.status === "error" || digest !== null;
      const newBlocked = blocked && !episode.blockedActive;
      const newError = error && (!episode.errorActive || (digest !== null && digest !== episode.errorDigest));
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
}
