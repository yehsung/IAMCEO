// Z(0.2.6): 대표 글의 '답 상태'. 대표가 글을 보낸 뒤 받은 팀장(총괄 포함)이 그 글을 받아 일하는 중인지, 답했는지, 답 없이 끝냈는지를
// 서버 한 곳에서 정한다. 앱은 이 값을 그리기만 하고 따로 추측하지 않는다(0.2.4 E3 원칙).
//
// 근거(믿는 순서):
// - 아직 넣지 못한 글: 그 전달의 대기 사유(Store.deliveryWait = 펌프 판정 + 이 전달의 수신 확인·다음 시도). 사유가 곧 상태다.
// - 넣은 글: 그 전달을 실은 실행 기록(execution_journal, 봉투 하나 = 실행 하나). 실행기가 본 턴 시작·끝(core 의 OSC 상태·기록)으로 움직인다.
//   Claude 훅(UserPromptSubmit·Stop)은 비교 기록일 뿐 여기서 쓰지 않는다(훅이 없는 Codex 도 같은 근거로 판정된다).
// - 답: 이 글을 실은 실행이 만들어진 뒤부터 그 팀장이 대표의 다음 글(또는 결재 답)을 받기 전까지, 그 팀장이 대화에 쓴 첫 글
//   (post·ask 의 질문·턴 마지막 글). 서버가 만든 알림(시스템 글, '대표 전달 지연')은 답이 아니다. 앞 일을 하던 중에 쓴 글은
//   이 글이 들어가기 전이라 세지 않는다(core 는 도는 턴에 글을 끼워 넣지 못한다).
// - 총괄이 답 대신 팀장에게 맡기고 턴을 끝냈으면(배정 확인 기록) 답한 것으로 본다. 대화에 '총괄이 …에게 맡겼습니다'가 남는다.
//   답함은 굳은 값이다: 뒤에 어떤 실행이 돌아도, 서버를 다시 띄워도 바뀌지 않는다.
// - 답 없이 끝난(끊긴) 턴 뒤에는 그 턴을 **잇는** 실행만 본다: 서버가 그 실행에 요청한 보고 보완, 사용 한도·인터넷·재시작 뒤 이어가기.
//   그 서버 글이 아직 들어가기 전이면 '답 쓰는 중'으로 둔다('답 없이 끝남'·'멈춤'을 띄웠다가 곧 지우지 않는다).
//   이 글과 무관한 실행(팀장 보고로 깬 총괄 턴, 총괄의 다른 지시, 알림·판 정리로 깬 턴)이 시작되면 답 창이 거기서 닫힌다(저장소가 정한다).
//   그동안 이 글은 끝난 상태 그대로이고, 그 턴에서 쓴 글은 이 글의 답이 아니다.
// - 핫픽스 C: Claude 가 뒤 작업을 남기고 끝낸 턴(실행 기록 사유 claude_background_task)은 그 작업이 끝나 결과 보고를 확인할 때까지 '잇는 중'(continuing)이다.
//   그동안 들어간 무관한 실행은 창을 닫지 않고 그 실행이 돈 구간만 창에서 뺀다(저장소가 정한다).
import type { DeliveryStatus, DeliveryWaitInfo, DeliveryWaitReason, Member, MessageReply, ReplyReason, ReplyState } from "../shared/types.ts";

/** 실행 기록에서 판정에 쓰는 칸. */
export interface ReplyRun {
  runId: string;
  phase: "received" | "starting" | "running" | "ended" | "interrupted" | "unknown";
  result: "success" | "error" | "interrupted" | null;
  createdAt: string;
  inputReceivedAt: string | null;
  startedAt: string | null;
  lastProgressAt: string | null;
  endedAt: string | null;
}

export interface ReplyFacts {
  memberId: string;
  delivery: { status: DeliveryStatus; createdAt: string; deliveredAt: string | null };
  /** 아직 넣지 못한 전달의 대기 사유(Store.deliveryWait). */
  wait?: DeliveryWaitInfo | null;
  /** 받은 팀장의 지금 상태. */
  member: Pick<Member, "status" | "blockedReason" | "fenceCode"> & { observationError?: string | null };
  /** 이 전달을 실은 실행. 직접 띄운 세션처럼 실행 기록이 없으면 null. */
  run?: ReplyRun | null;
  /**
   * 그 실행을 잇는 그 팀장의 마지막 실행(없으면 null). 잇는 실행은 앞 실행을 잇는 서버 글을 실은 것뿐이다: 그 실행의 보고 보완,
   * 사용 한도·인터넷·재시작 뒤 이어가기. 팀장 보고로 깬 총괄의 턴, 다른 지시, 알림·판 정리로 깬 턴은 잇는 실행이 아니다(답 창을 닫는다).
   */
  later?: ReplyRun | null;
  /**
   * 그 실행(또는 이은 실행)을 잇는 서버 글(보고 보완·이어가기)을 넣었고 아직 들어가지 않았다. 재시작으로 끊긴 실행을 서버가 다시 열어
   * 이어가게 할 차례인 것도 같다. 답 창이 열려 있을 때만 참이다.
   */
  continuing?: boolean;
  /** 답 창 안의 첫 답 글. */
  reply?: { id: string; at: string } | null;
  /** 그 실행(또는 이은 실행)에서 총괄이 다른 팀장에게 일을 맡기고 턴을 끝낸 시각. */
  delegatedAt?: string | null;
}

/** 대기 사유 → 아직 넣지 못한 글의 상태. 모르는 사유는 queued(보내는 중)다. */
const PENDING: Record<DeliveryWaitReason, ReplyState> = {
  receipt_check: "checking",
  member_busy: "behind",
  next_turn: "behind",
  waking: "waking",
  approval: "blocked",
  usage_limit: "blocked",
  api_outage: "blocked",
  runner_off: "blocked",
  manual_control: "blocked",
  archived: "blocked",
  run_limit: "queued",
  retry_wait: "queued",
  unknown: "queued",
};

const OPEN = new Set<ReplyRun["phase"]>(["starting", "received", "running", "unknown"]);
/** 같은 답 창 안에서 같은 상태가 다시 바뀔 수 없으면 true(서버가 계산을 아껴도 되는 값). */
export function replySettled(reply: MessageReply | null, windowClosed: boolean): boolean {
  if (!reply) return false;
  return reply.state === "replied" || (windowClosed && (reply.state === "no_reply" || reply.state === "stopped"));
}

/**
 * 팀장을 멈춰 세운 까닭. 멈추지 않았으면 null.
 * withError: 팀장의 오류 상태도 까닭으로 센다. 오류 상태는 앞 턴의 것이 새 글이 들어간 뒤에도 CLI 가 '일하는 중'을 알릴 때까지 남는다
 * (서버는 턴이 오류로 끝났을 때·넣기에 실패했을 때만 오류 상태를 세운다). 그래서 이 글의 실행이 오류로 끝났을 때만 센다.
 */
function stall(member: ReplyFacts["member"], withError: boolean): ReplyReason | null {
  if (member.status === "blocked") return member.blockedReason === "usage_limit" ? "usage_limit" : "approval";
  if (member.fenceCode === "usage_wait" || member.blockedReason === "usage_limit") return "usage_limit";
  if (member.observationError === "network_outage") return "api_outage";
  if (withError && member.status === "error") return "error";
  return null;
}

function make(state: ReplyState, memberId: string, since: string, reason?: ReplyReason): MessageReply {
  return reason ? { state, memberId, since, reason } : { state, memberId, since };
}

/**
 * 한 실행이 아직 도는 동안의 상태. continuing: 이 글을 이미 받은 턴 뒤에 이어지는 실행(보고 보완·이어가기)이면 그 글의 턴이 시작한 시각.
 * 이어지는 실행은 막 넣는 중이어도 일하는 중이고, 화면의 '읽고 일하는 중 · N분'이 처음 턴부터 이어서 센다.
 */
function open(run: ReplyRun, facts: ReplyFacts, received: string, continuing?: string): MessageReply {
  const stopped = stall(facts.member, false);
  if (stopped) return make("blocked", facts.memberId, run.lastProgressAt ?? run.startedAt ?? received, stopped);
  if (continuing) return make("working", facts.memberId, continuing);
  if (run.phase === "running") return make("working", facts.memberId, run.startedAt ?? received);
  return make("delivered", facts.memberId, run.inputReceivedAt ?? received);
}

/**
 * 답 상태를 정한다. 실패로 끝난 전달(다시 보내기 대상)은 기존 '실패' 표시가 맡으므로 null 이다.
 * 판정표는 docs/spec.md 의 '대표 글의 답 상태(Z)'와 같다.
 */
export function judgeReply(facts: ReplyFacts): MessageReply | null {
  const { delivery, memberId } = facts;
  if (delivery.status === "queued" || delivery.status === "held" || delivery.status === "delivering") {
    // 넣는 중(delivering)은 결과를 모르는 동안이다. 대기 사유가 없으면 넣었는지 확인하는 중으로 본다.
    const reason: DeliveryWaitReason = facts.wait?.waitReason ?? (delivery.status === "delivering" ? "receipt_check" : "unknown");
    return make(PENDING[reason] ?? "queued", memberId, facts.wait?.waitingSince ?? delivery.createdAt, reason);
  }
  if (delivery.status !== "delivered") return null;
  const received = delivery.deliveredAt ?? delivery.createdAt;
  if (facts.reply) return make("replied", memberId, facts.reply.at);
  const run = facts.run;
  if (!run) return make("delivered", memberId, received);
  if (OPEN.has(run.phase)) return open(run, facts, received);
  // 맡기고 끝냈으면 답함이다. 뒤 실행(보고 보완, 팀장 보고로 깬 총괄 턴)보다 먼저 본다: 답함은 굳은 값이라 서버를 다시 띄워도 같아야 한다.
  if (facts.delegatedAt) return make("replied", memberId, facts.delegatedAt);
  const began = run.startedAt ?? run.inputReceivedAt ?? received;
  // 끝난 턴을 잇는 실행(보고 보완·이어가기)이 있으면 그 실행을 본다. 거기서 쓴 글이 이 글의 답이다.
  const tail = facts.later ?? run;
  if (tail !== run && OPEN.has(tail.phase)) return open(tail, facts, tail.createdAt, began);
  const ended = tail.endedAt ?? received;
  if (tail.result === "success") {
    // 서버가 결과를 post 로 알려 달라고 다시 넣는 중이다. '답 없이 끝남'을 띄웠다가 곧 지우지 않는다.
    if (facts.continuing) return make("working", memberId, began);
    return make("no_reply", memberId, ended);
  }
  // 오류·종료로 끊긴 턴: 한도·인터넷으로 붙잡힌 동안은 막힘, 이 턴이 오류로 끝나 오류 상태면 오류로 막힘.
  const stopped = stall(facts.member, tail.result === "error");
  if (stopped) return make("blocked", memberId, ended, stopped);
  // 한도·인터넷이 풀려 이어가기를 넣었거나 재시작 뒤 서버가 다시 열 차례면, 이어가기 실행이 만들어지기 전에도 '멈춤'을 띄우지 않는다.
  if (facts.continuing) return make("working", memberId, began);
  return make("stopped", memberId, ended);
}
