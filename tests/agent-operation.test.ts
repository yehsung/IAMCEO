import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleAgentTool, listAgentTools } from "../server/agent-tools.ts";
import { renderRole } from "../server/roles.ts";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import type { Orchestrator } from "../server/orchestrator.ts";
import type { AgentWorkflowService, DecisionFollowUp, ManualInboxService, ReportReferences } from "../server/service-contracts.ts";
import { ApiError, Store } from "../server/store.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

function fixture() {
  const runtime = createIsolatedRuntime();
  const db = openDb(join(runtime.paths.iamceoHome, "test.db"));
  const store = new Store(db, new Bus());
  cleanups.push(async () => { db.close(); await runtime.stop(); });
  const project = store.createProject({ name: "MCP 계약", cwd: runtime.paths.work });
  const member = store.createMember({ projectId: project.id, handle: "manual", name: "직원", kind: "worker", origin: "manual" });
  const lead = store.createMember({ projectId: project.id, handle: "lead", name: "총괄", kind: "conductor" });
  let legacyCloses = 0;
  let legacyWaits = 0;
  // W1's service ports are fake; the real Store records effects and references.
  // Any accidental orchestration/runner call fails instead of starting a CLI.
  const host = {
    store, dataDir: runtime.paths.iamceoHome, uploadsDir: join(runtime.paths.iamceoHome, "uploads"),
    closeAsk: async () => { legacyCloses++; throw new ApiError(409, "legacy close", "decision_closed"); },
    waitInbox: async () => { legacyWaits++; return "v1 inbox"; },
  } as unknown as Orchestrator & Partial<AgentWorkflowService> & {
    manualInbox?: (id: string, timeout: number, signal?: AbortSignal) => ReturnType<ManualInboxService["inbox"]>;
    acknowledgeManualInbox?: ManualInboxService["acknowledge"];
  };
  const call = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => handleAgentTool(host, member, name, args, signal);
  return { runtime, db, store, project, member, lead, host, call, legacy: () => ({ closes: legacyCloses, waits: legacyWaits }) };
}

describe("agent receipt 저장 계약", () => {
  test("같은 ID와 요청만 합친다; 새 ID의 같은 본문은 독립이며 키 순서는 무관하다", () => {
    const f = fixture();
    const id = randomUUID();
    let effects = 0;
    const execute = () => ({ text: `결과 ${++effects}` });
    const first = f.store.agentOperation(f.member.id, "post", id, { title: "같음", kind: "완료" }, execute);
    expect(f.store.agentOperation(f.member.id, "post", id, { kind: "완료", title: "같음" }, execute)).toEqual(first);
    expect(f.store.agentOperation(f.member.id, "post", randomUUID(), { kind: "완료", title: "같음" }, execute)).not.toEqual(first);
    expect(effects).toBe(2);
    for (const [memberId, tool, args] of [
      [f.member.id, "post", { kind: "완료", title: "다름" }],
      [f.member.id, "ask", { kind: "완료", title: "같음" }],
      [f.lead.id, "post", { kind: "완료", title: "같음" }],
    ] as const) expect(() => f.store.agentOperation(memberId, tool, id, args, execute)).toThrow("operationId");
    expect(effects).toBe(2);
  });
});

describe("결재 후속 명시", () => {
  test("닫기와 후속을 한 포트로 넘기고 none도 명시한다; 레거시를 중복 실행하지 않는다", async () => {
    const f = fixture();
    const decision = f.store.createDecision({ projectId: f.project.id, memberId: f.member.id, who: f.member.name, title: "결재" });
    const seen: Parameters<AgentWorkflowService["closeDecision"]>[] = [];
    f.host.closeDecision = async (...args) => { seen.push(args); return decision; };
    const follow = { kind: "instruction", member_id: f.member.id, text: "후속 실행", source_message_id: "msg_owner" };
    expect((await f.call("ask_close", { id: decision.id, kind: "decided", reason: "대표가 정함", user_quote: "대표 원문", follow_up: follow })).isError).toBeUndefined();
    expect(seen[0]).toEqual([f.member, { id: decision.id, kind: "decided", reason: "대표가 정함", userQuote: "대표 원문", followUp: { kind: "instruction", memberId: f.member.id, text: "후속 실행", sourceMessageId: "msg_owner" } }]);
    await f.call("ask_close", { id: decision.id, kind: "obsolete", reason: "불필요", follow_up: { kind: "none" } });
    expect(seen[1]![1].followUp).toEqual({ kind: "none" });
    expect(f.legacy().closes).toBe(0);
  });

  test("답한 결재 근거와 동일 안건 설명을 서비스 계약의 후속 출처로 넘긴다", async () => {
    const f = fixture();
    const decision = f.store.createDecision({ projectId: f.project.id, memberId: f.member.id, who: f.member.name, title: "결재" });
    const seen: Parameters<AgentWorkflowService["closeDecision"]>[] = [];
    f.host.closeDecision = async (...args) => { seen.push(args); return decision; };
    const followUp: DecisionFollowUp = { kind: "instruction", memberId: f.member.id, text: "검증된 답의 후속", sourceDecisionId: "d_answered" };
    const result = await f.call("ask_close", { id: decision.id, kind: "decided", reason: "같은 안건", answered_decision_id: "d_answered", same_issue: "같은 결제 범위",
      follow_up: { kind: "instruction", member_id: f.member.id, text: followUp.text } });
    expect(result.isError).toBeUndefined();
    expect(seen).toEqual([[f.member, { id: decision.id, kind: "decided", reason: "같은 안건", userQuote: undefined,
      answeredDecisionId: "d_answered", sameIssue: "같은 결제 범위", followUp }]]);
    expect(f.legacy().closes).toBe(0);
  });

  test("후속 schema 오류와 미지원 포트는 닫기 효과 없이 거부한다", async () => {
    const f = fixture();
    const base = { id: "d_test", kind: "decided", reason: "근거", user_quote: "원문" };
    for (const follow_up of [{}, { kind: "none", text: "숨긴 지시" }, { kind: "instruction", member_id: "m" }, { kind: "instruction", member_id: "m", text: "", source_message_id: "msg" }]) {
      expect((await f.call("ask_close", { ...base, follow_up })).isError).toBe(true);
    }
    expect(await f.call("ask_close", { ...base, follow_up: { kind: "none" } })).toMatchObject({ isError: true, text: "결재 후속 저장을 지원하지 않습니다" });
    expect(f.legacy().closes).toBe(0);
    expect((await f.call("ask_close", base)).text).toBe("legacy close");
    expect(f.legacy().closes).toBe(1);
  });
});

describe("보고 참조 조회", () => {
  test("원본·전체 자료·결재·작성 순서·정정 관계를 읽고 게시하지 않는다", async () => {
    const f = fixture();
    const files = ["하나", "둘"].map(title => f.store.createFile({ projectId: f.project.id, title, who: f.member.name, body: `${title} 전문` }));
    files.push(f.store.createFile({ projectId: f.project.id, title: "시안", who: f.member.name, kind: "artifact", html: "<main>시안 원본</main>" }));
    const source = f.store.createMessage({ projectId: f.project.id, memberId: f.member.id, who: f.member.name, kind: "완료", title: "결과" });
    const refs: ReportReferences = { sourceMessageId: source.id, fileIds: files.map(file => file.id), decisionIds: ["d_related"], authoredAt: source.at, sequence: 7, correctsMessageId: "msg_previous" };
    f.host.reportReferences = (projectId, messageId) => { expect(projectId).toBe(f.project.id); expect(messageId).toBe(source.id); return refs; };
    const before = f.store.listMessages(f.project.id).length;
    const result = await f.call("post", { report_id: source.id });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.text)).toMatchObject({ ...refs, source: { id: source.id }, files: files.map(file => ({ id: file.id, body: file.body })) });
    expect(JSON.parse(result.text).files[2].html).toBe("<main>시안 원본</main>");
    expect(f.store.listMessages(f.project.id)).toHaveLength(before);
    for (const args of [{}, { kind: "완료" }, { report_id: source.id, title: "동시 게시" }, { report_id: source.id, corrects_message_id: source.id }]) expect((await f.call("post", args)).isError).toBe(true);
  });

  test("없는 포트·타 프로젝트 원본/자료는 조회 오류이며 다른 자료를 노출하지 않는다", async () => {
    const f = fixture();
    expect((await f.call("post", { report_id: "msg_x" })).text).toBe("보고 참조 조회를 지원하지 않습니다");
    const other = f.store.createProject({ name: "다른 프로젝트", cwd: f.runtime.paths.work });
    const foreign = f.store.createMessage({ projectId: other.id, who: "비공개", kind: "완료", title: "비공개 원본" });
    const local = f.store.createMessage({ projectId: f.project.id, memberId: f.member.id, who: "직원", kind: "완료", title: "원본" });
    const file = f.store.createFile({ projectId: other.id, who: "비공개", title: "비공개 자료", body: "secret-canary" });
    let refs: ReportReferences = { sourceMessageId: foreign.id, fileIds: [], decisionIds: [], authoredAt: foreign.at, sequence: 1, correctsMessageId: null };
    f.host.reportReferences = () => refs;
    expect((await f.call("post", { report_id: foreign.id })).isError).toBe(true);
    refs = { ...refs, sourceMessageId: local.id, fileIds: [file.id] };
    const result = await f.call("post", { report_id: local.id });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("secret-canary");
  });
});

describe("manual batch 수신", () => {
  test("응답을 버려도 같은 batch를 회수하고 명시 ACK만 소비한다", async () => {
    const f = fixture();
    const delivery = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "밀린 일" });
    const calls: { timeout: number; signal?: AbortSignal }[] = [];
    const inbox: ManualInboxService = {
      inbox: async (id, timeout, signal) => { calls.push({ timeout, signal }); return signal?.aborted ? null : f.store.manualInbox(id); },
      acknowledge: async (id, request) => f.store.acknowledgeManualInbox(id, request.batchId),
    };
    f.host.manualInbox = inbox.inbox;
    f.host.acknowledgeManualInbox = inbox.acknowledge;
    const signal = new AbortController().signal;
    const first = await f.call("wait", { batch: true, timeout_sec: 1 }, signal);
    expect(f.store.requireDelivery(delivery.id).status).not.toBe("delivered");
    expect(await f.call("wait", { batch: true, timeout_sec: 1 })).toEqual(first);
    expect(calls[0]).toEqual({ timeout: 1000, signal });
    const batch = JSON.parse(first.text) as { id: string };
    for (let i = 0; i < 2; i++) expect(JSON.parse((await f.call("wait", { ack_batch_id: batch.id })).text)).toEqual({ batchId: batch.id, acknowledged: true });
    expect(f.store.requireDelivery(delivery.id).status).toBe("delivered");
    expect((await f.call("wait", { batch: true, timeout_sec: 1 })).text).toContain("새 지시가 없습니다");
    expect((await f.call("wait", { ack_batch_id: batch.id, timeout_sec: 1 })).isError).toBe(true);
    expect(f.legacy().waits).toBe(0);
  });

  test("미지원 포트는 v1 소비로 내려가지 않고 기존 v1 호출은 유지한다", async () => {
    const f = fixture();
    expect((await f.call("wait", { batch: true, timeout_sec: 1 })).isError).toBe(true);
    expect((await f.call("wait", { ack_batch_id: "batch_x" })).isError).toBe(true);
    expect(f.legacy().waits).toBe(0);
    expect((await f.call("wait", { timeout_sec: 1 })).text).toBe("v1 inbox");
    expect(f.legacy().waits).toBe(1);
    expect((await handleAgentTool(f.host, f.lead, "wait", { batch: true })).isError).toBe(true);
    expect(listAgentTools(f.member).find(t => t.name === "wait")!.inputSchema.properties).toHaveProperty("ack_batch_id");
  });
});

test("역할 지침은 core 명시 post와 정상 미보고 예외·응답 유실 ID를 설명한다", () => {
  // 3차 M: 응답 유실 절은 공통 조각(server/roles/parts/tool-retry.md)으로 옮겨 조립한다. 원본 파일 대신 조립한 지침을 본다.
  for (const name of ["root", "conductor", "worker"] as const) {
    const role = renderRole(name, { PROJECT: "P", NAME: "N", ROLE: "R", CONDUCTOR: "C" });
    expect(role).toContain("core는 턴 마지막 글을 자동 게시하지 않는다");
    expect(role).toContain("미보고 예외");
    expect(role).toContain("operation_id");
    expect(role).not.toContain("마지막 글은 그대로 대화에 올라간다");
  }
});
