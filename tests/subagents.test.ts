// 0.2.7 묶음 6: 서브에이전트가 일하는 동안의 팀장 상태.
// 서버가 팀장마다 지금 돌고 있는 서브에이전트 수를 CLI 자기 기록으로 잰다(server/runner/subagents.ts → CoreRunner subagents 사건 → 명부의 subagentState).
// 상태(status)는 바꾸지 않는다: 턴을 끝낸 팀장은 서브에이전트가 돌아도 '쉬는 중'(입력을 받음)이고, 앱이 subagentState 로 '서브에이전트 일하는 중'을 보인다.
// 기록 견본은 이 Mac 의 실제 기록(Claude Code 2.1.3xx 주 대화·워크플로 journal, Codex rollout)의 줄 종류·키·순서를 흉내 낸 가짜 글이다.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readClaudeSubagents, readCodexSubagents, type ClaudeSubagentCursor, type ClaudeSubagentResult, type CodexSubagentState } from "../server/runner/subagents.ts";
import { transcriptPath } from "../server/runner/transcript.ts";
import type { AgentToolsImpl, PostInput } from "../server/orchestrator.ts";
import type { RunnerEvent } from "../server/runner/types.ts";
import type { Member, ProjectSummary } from "../shared/types.ts";
import { coreSetup, type CoreEnv, type CoreSetupOptions } from "./fixtures/core-harness.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "cli", "claude", "2.1.323");
const WAIT_SCREEN = readFileSync(join(FIXTURES, "background-wait.txt"), "utf8");
const IDLE_SCREEN = readFileSync(join(FIXTURES, "idle.txt"), "utf8");

const rows = (...values: unknown[]) => values.map(value => JSON.stringify(value)).join("\n") + "\n";
let clock = Date.now();
/** 줄 시각은 늘 앞으로 간다(시험이 since 를 잡은 뒤에 쓴 줄은 그 뒤 시각이다). */
const stamp = () => new Date(clock = Math.max(clock + 1, Date.now())).toISOString();
// 실측 줄 모양(키·순서). 글은 가짜다.
const line = (s: string, extra: Record<string, unknown>) => ({ parentUuid: null, isSidechain: false, uuid: crypto.randomUUID(), timestamp: stamp(), userType: "external", entrypoint: "cli", cwd: "/work", sessionId: s, version: "2.1.323", ...extra });
const usage = { input_tokens: 10, cache_read_input_tokens: 990, cache_creation_input_tokens: 0, output_tokens: 5 };
const prompt = (s: string, text = "가짜 일") => line(s, { type: "user", message: { role: "user", content: text }, origin: { kind: "human" } });
const answer = (s: string, text = "가짜 답") => line(s, { type: "assistant", message: { model: "claude-opus-5-5", id: `msg_${crypto.randomUUID()}`, role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", usage } });
const call = (s: string, id: string, name: "Agent" | "Workflow", background = true) => line(s, { type: "assistant", message: { model: "claude-opus-5-5", id: `msg_${crypto.randomUUID()}`, role: "assistant",
  content: [{ type: "tool_use", id, name, input: name === "Agent" ? { description: "가짜 조사", prompt: "가짜 지시", subagent_type: "general-purpose", ...(background ? { run_in_background: true } : {}) } : { script_path: "/tmp/fake-flow.js" } }], stop_reason: "tool_use", usage } });
const agentLaunched = (s: string, toolId: string, agentId: string) => line(s, { type: "user", message: { role: "user", content: [{ tool_use_id: toolId, type: "tool_result", content: [{ type: "text", text: "Async agent launched successfully." }] }] },
  toolUseResult: { isAsync: true, status: "async_launched", agentId, description: "가짜 조사", prompt: "가짜 지시", outputFile: `/tmp/${agentId}.output`, canReadOutputFile: true, canContinueAgent: true, resolvedModel: "claude-opus-5-5" } });
const workflowLaunched = (s: string, toolId: string, taskId: string, runId: string) => line(s, { type: "user", message: { role: "user", content: [{ tool_use_id: toolId, type: "tool_result", content: "Workflow launched in background." }] },
  toolUseResult: { status: "async_launched", taskId, taskType: "local_workflow", workflowName: "가짜-흐름", runId, summary: "가짜 흐름", transcriptDir: `/tmp/${runId}`, scriptPath: "/tmp/fake-flow.js" } });
const agentDone = (s: string, toolId: string, agentId: string) => line(s, { type: "user", message: { role: "user", content: [{ tool_use_id: toolId, type: "tool_result", content: [{ type: "text", text: "가짜 결과" }] }] },
  toolUseResult: { status: "completed", agentId, prompt: "가짜 지시", content: [{ type: "text", text: "가짜 결과" }] } });
const stopSummary = (s: string) => line(s, { type: "system", subtype: "stop_hook_summary", hookCount: 1, hookInfos: [{ command: "fake", durationMs: 20 }], hookErrors: [], preventedContinuation: false, stopReason: "", hasOutput: false, level: "suggestion" });
/** 턴 끝. 남은 뒤 작업이 0 이면 키가 없다(실측). */
const turnDuration = (s: string, pending: { agents?: number; workflows?: number } = {}) => line(s, { type: "system", subtype: "turn_duration", durationMs: 30_000, messageCount: 9,
  ...(pending.workflows ? { pendingWorkflowCount: pending.workflows } : {}), ...(pending.agents ? { pendingBackgroundAgentCount: pending.agents } : {}), isMeta: false });
const block = (taskId: string, status: string, summary: string) => `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>toolu_fake</tool-use-id>\n<output-file>/tmp/${taskId}.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n<result>가짜 결과</result>\n</task-notification>`;
const enqueue = (s: string, taskId: string, status: string, summary: string) => ({ type: "queue-operation", operation: "enqueue", timestamp: stamp(), sessionId: s, content: block(taskId, status, summary) });
const dequeue = (s: string) => ({ type: "queue-operation", operation: "dequeue", timestamp: stamp(), sessionId: s });
const notified = (s: string, taskId: string, status: string, summary: string) => line(s, { type: "user", message: { role: "user", content: block(taskId, status, summary) }, origin: { kind: "task-notification", producer: "session-task" } });

describe("Claude 기록: 지금 돌고 있는 서브에이전트 수", () => {
  const scratch = mkdtempSync(join(tmpdir(), "iamceo-subagents-"));
  function session(head = "") {
    const home = mkdtempSync(join(scratch, "home-"));
    const sessionId = crypto.randomUUID();
    const path = join(home, "projects", "-work", `${sessionId}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, head);
    const since = Date.now();
    let cursor: ClaudeSubagentCursor | null = null;
    const read = (extra: { since?: number } = {}): ClaudeSubagentResult => { const result = readClaudeSubagents({ home, path, sessionId, since: extra.since ?? since }, cursor); cursor = result.cursor; return result; };
    const sessionDir = join(dirname(path), sessionId);
    /** 워크플로 실행 기록(<세션>/subagents/workflows/<run>/journal.jsonl). */
    const journal = (runId: string, ...events: Record<string, unknown>[]) => {
      mkdirSync(join(sessionDir, "subagents", "workflows", runId), { recursive: true });
      appendFileSync(join(sessionDir, "subagents", "workflows", runId, "journal.jsonl"), rows(...events));
    };
    const finish = (runId: string) => {
      mkdirSync(join(sessionDir, "workflows"), { recursive: true });
      writeFileSync(join(sessionDir, "workflows", `${runId}.json`), JSON.stringify({ runId, taskId: "wfake", status: "completed", agentCount: 2, summary: "가짜 흐름 끝" }));
    };
    return { s: sessionId, path, since, read, append: (...values: unknown[]) => appendFileSync(path, rows(...values)), journal, finish };
  }
  const started = (agentId: string) => ({ type: "started", key: `v2:${agentId}`, agentId, label: `가짜:${agentId}`, phase: "조사" });
  const result = (agentId: string) => ({ type: "result", key: `v2:${agentId}`, agentId, result: "가짜 결과", toolsUsed: 3 });
  // 실측 모양: 실패한 에이전트는 {type:"failed", key, agentId}. 같은 key 로 다시 시작하면 다시 시도다.
  const failed = (agentId: string) => ({ type: "failed", key: `v2:${agentId}`, agentId });
  const retried = (agentId: string, key: string) => ({ type: "started", key: `v2:${key}`, agentId, label: `가짜:${key}`, phase: "조사" });

  test("이 CLI 에서 아직 아무 일이 없으면 0(exact). 백그라운드 에이전트를 띄우고 턴을 끝내면 턴 끝의 CLI 셈 그대로(exact)", () => {
    const t = session();
    // 이 CLI 를 띄운 시각을 모르면 근거가 없다(앞 프로세스의 줄과 가를 수 없다).
    expect(t.read({ since: Number.NaN })).toMatchObject({ quality: "unknown", count: null, code: "since_unknown" });
    expect(t.read()).toMatchObject({ quality: "exact", count: 0 });
    t.append(prompt(t.s), call(t.s, "toolu_a1", "Agent"), agentLaunched(t.s, "toolu_a1", "a1fake"), call(t.s, "toolu_a2", "Agent"), agentLaunched(t.s, "toolu_a2", "a2fake"));
    // 턴 도중: 띄운 것을 더한 추정.
    expect(t.read()).toMatchObject({ quality: "estimated", count: 2, code: "turn_open" });
    t.append(answer(t.s), stopSummary(t.s), turnDuration(t.s, { agents: 2 }));
    expect(t.read()).toMatchObject({ quality: "exact", count: 2, code: "turn_end", detail: { agents: 2, workflows: 0 } });
    // 하나가 끝났다: 끝 알림(enqueue) → Claude 가 스스로 연 알림 턴(dequeue). 그 턴이 끝나면 다시 CLI 셈.
    t.append(enqueue(t.s, "a1fake", "completed", "Agent \"가짜 조사\" finished"));
    expect(t.read()).toMatchObject({ quality: "estimated", count: 1 });
    t.append(dequeue(t.s), notified(t.s, "a1fake", "completed", "Agent \"가짜 조사\" finished"));
    expect(t.read()).toMatchObject({ quality: "estimated", count: 1, code: "turn_open" });
    t.append(answer(t.s), stopSummary(t.s), turnDuration(t.s, { agents: 1 }));
    expect(t.read()).toMatchObject({ quality: "exact", count: 1 });
    t.append(enqueue(t.s, "a2fake", "completed", "Agent \"가짜 조사\" finished"), dequeue(t.s), notified(t.s, "a2fake", "completed", "Agent \"가짜 조사\" finished"), answer(t.s), stopSummary(t.s), turnDuration(t.s));
    expect(t.read()).toMatchObject({ quality: "exact", count: 0 });
  });

  test("중간 알림('자기 뒤 작업을 기다림')은 끝으로 세지 않는다. 같은 끝 알림은 한 번만 센다. 셸·Monitor 알림은 서브에이전트가 아니다", () => {
    const t = session();
    t.append(prompt(t.s), call(t.s, "toolu_a1", "Agent"), agentLaunched(t.s, "toolu_a1", "a1fake"), answer(t.s), stopSummary(t.s), turnDuration(t.s, { agents: 1 }));
    expect(t.read()).toMatchObject({ quality: "exact", count: 1 });
    t.append(enqueue(t.s, "a1fake", "completed", "Agent \"가짜 조사\" is waiting on its own background work"), enqueue(t.s, "bshell1", "completed", "Background command \"가짜 시험\" completed (exit code 0)"),
      enqueue(t.s, "bmon1", "completed", "Monitor \"가짜 감시\" stream ended"));
    expect(t.read()).toMatchObject({ count: 1 });
    t.append(enqueue(t.s, "a1fake", "failed", "Agent \"가짜 조사\" failed: 가짜 오류"), enqueue(t.s, "a1fake", "failed", "Agent \"가짜 조사\" failed: 가짜 오류"));
    expect(t.read()).toMatchObject({ quality: "estimated", count: 0 });
  });

  test("워크플로는 그 안에서 돌고 있는 에이전트 수로 센다(단계 사이라 없으면 1). 실행 기록에서 센 수라 추정이다. 끝나면 빠진다", () => {
    const t = session();
    t.append(prompt(t.s), call(t.s, "toolu_w1", "Workflow"), workflowLaunched(t.s, "toolu_w1", "wfake1", "wf_fake-001"));
    t.journal("wf_fake-001", { type: "launched" }, started("aw1"), started("aw2"), started("aw3"), result("aw1"));
    expect(t.read()).toMatchObject({ quality: "estimated", count: 2 });
    // 턴이 닫혀도 워크플로 안의 수는 실행 기록에서 센 것이다(끝 표시 없이 멈춘 에이전트가 남을 수 있다): exact 로 내지 않는다.
    t.append(answer(t.s), stopSummary(t.s), turnDuration(t.s, { workflows: 1 }));
    expect(t.read()).toMatchObject({ quality: "estimated", count: 2, code: "workflow_journal", detail: { workflows: 1, workflowAgents: 2 } });
    // 팀장이 쉬는 동안에도 워크플로 안의 에이전트는 바뀐다(주 대화에는 줄이 없다).
    t.journal("wf_fake-001", result("aw2"), result("aw3"));
    expect(t.read()).toMatchObject({ quality: "estimated", count: 1 });
    t.journal("wf_fake-001", started("aw4"), started("aw5"));
    expect(t.read()).toMatchObject({ quality: "estimated", count: 2 });
    // 끝: 끝난 실행 파일이 생기고 끝 알림이 온다. 알림 턴이 끝나면 0(exact).
    t.journal("wf_fake-001", result("aw4"), result("aw5"));
    t.finish("wf_fake-001");
    t.append(enqueue(t.s, "wfake1", "completed", "Dynamic workflow \"가짜 흐름\" completed"));
    expect(t.read()).toMatchObject({ quality: "estimated", count: 0 });
    t.append(dequeue(t.s), notified(t.s, "wfake1", "completed", "Dynamic workflow \"가짜 흐름\" completed"), answer(t.s), stopSummary(t.s), turnDuration(t.s));
    expect(t.read()).toMatchObject({ quality: "exact", count: 0 });
  });

  test("워크플로 안에서 실패한 에이전트(failed)와 같은 key 로 다시 시도한 앞 시도는 끝으로 센다", () => {
    const t = session();
    t.append(prompt(t.s), call(t.s, "toolu_w1", "Workflow"), workflowLaunched(t.s, "toolu_w1", "wfake6", "wf_fake-006"), answer(t.s), stopSummary(t.s), turnDuration(t.s, { workflows: 1 }));
    // 열 개를 띄웠는데 아홉이 API 오류로 실패했다: 도는 것은 하나다(started − result 로만 세면 10).
    t.journal("wf_fake-006", { type: "launched" }, ...Array.from({ length: 10 }, (_, i) => started(`af${i}`)), ...Array.from({ length: 9 }, (_, i) => failed(`af${i + 1}`)));
    expect(t.read()).toMatchObject({ quality: "estimated", count: 1, detail: { workflows: 1, workflowAgents: 1 } });
    // 실패 뒤 같은 key 로 다시 시도: 앞 시도(결과 없이 멈춤)는 끝이고 뒤 시도만 돈다.
    t.journal("wf_fake-006", result("af0"), started("ag1"), retried("ag2", "ag1"), retried("ag3", "ag1"), started("ag4"));
    expect(t.read()).toMatchObject({ quality: "estimated", count: 2 });
    t.journal("wf_fake-006", result("ag3"));
    expect(t.read()).toMatchObject({ quality: "estimated", count: 1 });
    // 결과를 낸 뒤 같은 key 로 다시 시작한 것도 뒤 시도만 센다.
    t.journal("wf_fake-006", result("ag4"), retried("ag5", "ag4"));
    expect(t.read()).toMatchObject({ quality: "estimated", count: 1 });
    t.journal("wf_fake-006", failed("ag5"));
    // 단계 사이(돌고 있는 에이전트 없음)라도 워크플로가 끝나지 않았으면 하나로 센다.
    expect(t.read()).toMatchObject({ quality: "estimated", count: 1, detail: { workflowAgents: 1 } });
  });

  test("'Task … was stopped' 처럼 요약으로 종류를 모르는 끝은 띄울 때 본 종류로 가른다", () => {
    const t = session();
    t.append(prompt(t.s), call(t.s, "toolu_w1", "Workflow"), workflowLaunched(t.s, "toolu_w1", "wfake2", "wf_fake-002"), answer(t.s), stopSummary(t.s), turnDuration(t.s, { workflows: 1 }));
    t.journal("wf_fake-002", { type: "launched" }, started("ax1"));
    expect(t.read()).toMatchObject({ quality: "estimated", count: 1, code: "workflow_journal" });
    t.append(enqueue(t.s, "wfake2", "stopped", "Task \"가짜 흐름\" was stopped by main session"));
    expect(t.read()).toMatchObject({ quality: "estimated", count: 0 });
  });

  test("워크플로 기록이 CLI 의 수와 맞지 않으면(앞 프로세스의 실행·아직 없는 기록) CLI 의 수만큼 가장 최근 실행을 본다. 이 CLI 를 띄우기 전의 실행 폴더는 보지 않는다", async () => {
    const t = session();
    // 이 CLI 를 띄우기 전에 만든 실행(끝 파일 없이 남은 것): 세지 않는다.
    t.journal("wf_old-001", { type: "launched" }, started("ao1"), started("ao2"));
    await Bun.sleep(5);
    const since = Date.now();
    await Bun.sleep(2);
    t.append(prompt(t.s), call(t.s, "toolu_w1", "Workflow"), workflowLaunched(t.s, "toolu_w1", "wfake3", "wf_fake-003"), answer(t.s), stopSummary(t.s), turnDuration(t.s, { workflows: 1 }));
    // 실행 기록이 아직 없다: 워크플로 하나로 센다(추정).
    expect(t.read({ since })).toMatchObject({ quality: "estimated", count: 1 });
    t.journal("wf_fake-003", { type: "launched" }, started("ay1"), started("ay2"), started("ay3"));
    expect(t.read({ since })).toMatchObject({ quality: "estimated", count: 3 });
    // CLI 는 하나라는데 이 CLI 의 실행이 둘이다(하나는 끝 파일 없이 사라짐): 가장 최근 것만 세고 추정이다.
    await Bun.sleep(5);
    t.journal("wf_fake-004", { type: "launched" }, started("az1"));
    expect(t.read({ since })).toMatchObject({ quality: "estimated", count: 1 });
  });

  test("한 관측 사이에 4MiB 넘게 덧붙으면(기록·워크플로 기록) 읽은 데까지 추정으로 내고 다음 관측이 따라잡는다", () => {
    const t = session();
    t.append(prompt(t.s), call(t.s, "toolu_w1", "Workflow"), workflowLaunched(t.s, "toolu_w1", "wfake5", "wf_fake-005"), answer(t.s), stopSummary(t.s), turnDuration(t.s, { workflows: 1 }));
    // 워크플로 기록: 에이전트 60개 시작, 앞 50개는 큰 결과(줄마다 100KB, 모두 5MB 남짓)와 함께 끝났다. 남은 것은 10개.
    t.journal("wf_fake-005", { type: "launched" }, ...Array.from({ length: 60 }, (_, i) => started(`ab${i}`)));
    t.journal("wf_fake-005", ...Array.from({ length: 50 }, (_, i) => ({ ...result(`ab${i}`), result: "가".repeat(35_000) })));
    // 첫 관측은 4MiB 까지만 읽어 결과 일부만 봤다(10 보다 많게 센다). 다음 관측이 따라잡는다.
    expect(t.read().count).toBeGreaterThan(10);
    expect(t.read()).toMatchObject({ quality: "estimated", count: 10, code: "workflow_journal" });
    // 주 대화 기록: 큰 줄들(5MB 남짓) 뒤의 턴 끝.
    const filler = Array.from({ length: 50 }, () => line(t.s, { type: "attachment", attachment: { type: "diagnostics", files: "나".repeat(35_000) } }));
    t.append(prompt(t.s), ...filler, answer(t.s), stopSummary(t.s), turnDuration(t.s, { workflows: 1, agents: 2 }));
    expect(t.read()).toMatchObject({ quality: "estimated", code: "scan_pending" });
    expect(t.read()).toMatchObject({ quality: "estimated", count: 12, code: "workflow_journal", detail: { agents: 2, workflowAgents: 10 } });
    // 워크플로가 끝나고 백그라운드 에이전트만 남으면 다시 CLI 자기 셈(exact)이다.
    t.finish("wf_fake-005");
    t.append(enqueue(t.s, "wfake5", "completed", "Dynamic workflow \"가짜 흐름\" completed"), dequeue(t.s), notified(t.s, "wfake5", "completed", "Dynamic workflow \"가짜 흐름\" completed"), answer(t.s), stopSummary(t.s), turnDuration(t.s, { agents: 2 }));
    expect(t.read()).toMatchObject({ quality: "exact", count: 2, code: "turn_end" });
  });

  test("열린 턴의 전경 에이전트(뒤로 띄우지 않은 Agent 호출)는 결과가 올 때까지 센다", () => {
    const t = session();
    t.append(prompt(t.s), call(t.s, "toolu_f1", "Agent", false), call(t.s, "toolu_f2", "Agent", false));
    expect(t.read()).toMatchObject({ quality: "estimated", count: 2, detail: { foreground: 2 } });
    t.append(agentDone(t.s, "toolu_f1", "af1"));
    expect(t.read()).toMatchObject({ quality: "estimated", count: 1 });
    t.append(agentDone(t.s, "toolu_f2", "af2"), answer(t.s), stopSummary(t.s), turnDuration(t.s));
    expect(t.read()).toMatchObject({ quality: "exact", count: 0 });
  });

  test("앞 CLI 프로세스의 줄은 세지 않는다: 그때 남은 뒤 작업은 그 프로세스와 함께 끝났다", () => {
    const before = (s: string, v: Record<string, unknown>) => ({ ...v, timestamp: new Date(Date.now() - 60_000).toISOString(), sessionId: s });
    const t = session();
    t.append(before(t.s, prompt(t.s)), before(t.s, call(t.s, "toolu_a1", "Agent")), before(t.s, agentLaunched(t.s, "toolu_a1", "aold")), before(t.s, turnDuration(t.s, { agents: 3, workflows: 1 })));
    expect(t.read()).toMatchObject({ quality: "exact", count: 0, code: "no_turn_yet" });
  });

  test("기록 끝 4MiB 안에 이 CLI 의 턴 끝이 없고 그 앞도 못 보면 모른다(unknown). 턴 끝이 오면 정해진다", () => {
    // 4MiB 넘는 앞부분(이 CLI 의 긴 턴): 기록 끝에서부터 잡은 범위의 첫 줄도 since 뒤다.
    const filler = Array.from({ length: 1200 }, () => JSON.stringify(line("x", { type: "attachment", attachment: { type: "diagnostics", files: "가".repeat(1200) } }))).join("\n") + "\n";
    const t = session();
    const big = filler.replaceAll("\"sessionId\":\"x\"", `"sessionId":"${t.s}"`);
    t.append(prompt(t.s), call(t.s, "toolu_a1", "Agent"), agentLaunched(t.s, "toolu_a1", "a1fake"));
    appendFileSync(t.path, big + big);
    expect(t.read()).toMatchObject({ quality: "unknown", count: null, code: "no_turn_end" });
    t.append(answer(t.s), stopSummary(t.s), turnDuration(t.s, { agents: 1 }));
    expect(t.read()).toMatchObject({ quality: "exact", count: 1 });
  });

  test("사이드체인 줄은 주 대화가 아니다. 다른 세션 줄은 근거가 섞인 것이라 모른다. 망가진 줄을 지나면 다음 턴 끝까지 추정이다. 덜 쓴 줄은 이어 읽는다", () => {
    const t = session();
    t.append(prompt(t.s), answer(t.s), stopSummary(t.s), turnDuration(t.s, { agents: 1 }), { ...call(t.s, "toolu_side", "Agent", false), isSidechain: true });
    expect(t.read()).toMatchObject({ quality: "exact", count: 1 });
    appendFileSync(t.path, "{broken\n");
    expect(t.read()).toMatchObject({ quality: "estimated", count: 1 });
    t.append(answer(t.s), stopSummary(t.s), turnDuration(t.s, { agents: 1 }));
    expect(t.read()).toMatchObject({ quality: "exact", count: 1 });
    // 같은 범위 안에서 망가진 줄 뒤에 턴 끝이 오면 그 턴 끝이 다시 정한다.
    appendFileSync(t.path, "{broken again\n" + rows(prompt(t.s), answer(t.s), stopSummary(t.s), turnDuration(t.s, { agents: 1 })));
    expect(t.read()).toMatchObject({ quality: "exact", count: 1 });
    appendFileSync(t.path, JSON.stringify(turnDuration(t.s)));
    expect(t.read()).toMatchObject({ quality: "exact", count: 1 });
    appendFileSync(t.path, "\n");
    expect(t.read()).toMatchObject({ quality: "exact", count: 0 });
    // 다른 세션 줄: 이 세션의 다음 턴 끝까지 모른다(그 뒤부터 이어 읽는다).
    const other = session();
    other.append(prompt(other.s), answer(other.s), stopSummary(other.s), turnDuration(other.s, { agents: 1 }), answer("someone-else"));
    expect(other.read()).toMatchObject({ quality: "unknown", count: null, code: "session_conflict" });
    other.append(prompt(other.s), answer(other.s), stopSummary(other.s), turnDuration(other.s, { agents: 1 }));
    expect(other.read()).toMatchObject({ quality: "exact", count: 1 });
  });
});

describe("Codex 기록: 이 팀장이 띄운 네이티브 서브에이전트", () => {
  const scratch = mkdtempSync(join(tmpdir(), "iamceo-codex-subagents-"));
  const day = (t: number) => { const d = new Date(t); return [String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")]; };
  const meta = (id: string, parent: string | null) => ({ timestamp: stamp(), type: "session_meta", payload: { id, session_id: id, timestamp: stamp(), cwd: "/work", originator: "codex_cli_rs", cli_version: "0.166.0", base_instructions: { text: "가짜 지침" },
    source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: "/root/fake", agent_nickname: "가짜", agent_role: "worker" } } } : "cli", ...(parent ? { parent_thread_id: parent, agent_role: "worker" } : {}) } });
  const event = (type: string) => ({ timestamp: stamp(), type: "event_msg", payload: { type, turn_id: "turn-1" } });
  function sessions() {
    const home = mkdtempSync(join(scratch, "home-"));
    const dir = join(home, "sessions", ...day(Date.now()));
    mkdirSync(dir, { recursive: true });
    const parent = crypto.randomUUID();
    const since = Date.now() - 1000;
    let state: CodexSubagentState | null = null;
    const read = () => { const result = readCodexSubagents({ home, sessionId: parent, since, now: Date.now() }, state); state = result.state; return result; };
    const rollout = (id: string, parentId: string | null, ...lines: unknown[]) => { const path = join(dir, `rollout-fake-${id}.jsonl`); writeFileSync(path, rows(meta(id, parentId), ...lines)); return path; };
    return { home, dir, parent, since, read, rollout };
  }

  test("부모를 가리키는 자식 rollout 가운데 일이 열린 것을 센다(손자 포함). 끝나면 빠진다. 다른 팀장의 자식은 세지 않는다", () => {
    const t = sessions();
    expect(t.read()).toMatchObject({ quality: "exact", count: 0 });
    t.rollout(t.parent, null, event("task_started"));
    const one = t.rollout("child-1", t.parent, event("task_started"));
    const two = t.rollout("child-2", t.parent, event("task_started"), event("task_complete"));
    t.rollout("grand-1", "child-1", event("task_started"));
    t.rollout("other-1", "someone-else", event("task_started"));
    // 열린 자식은 끝 사건이 아직 없는 것이다(끝 사건 없이 끝나는 길이 있을 수 있다): 추정. 0 이면 exact.
    expect(t.read()).toMatchObject({ quality: "estimated", count: 2 });
    appendFileSync(one, rows(event("task_complete")));
    expect(t.read()).toMatchObject({ quality: "estimated", count: 1 });
    // 다시 맡긴 일(followup)은 다시 연다. 중단(turn_aborted)도 끝이다.
    appendFileSync(two, rows(event("task_started")));
    expect(t.read()).toMatchObject({ count: 2 });
    appendFileSync(two, rows(event("turn_aborted")));
    expect(t.read()).toMatchObject({ count: 1 });
    appendFileSync(join(t.dir, "rollout-fake-grand-1.jsonl"), rows(event("task_complete")));
    expect(t.read()).toMatchObject({ quality: "exact", count: 0 });
  });

  test("이 CLI 를 띄우기 전에 마지막으로 쓰인 자식(앞 프로세스의 것)은 열려 있어도 세지 않는다. 망가진 줄이 있으면 추정이다", () => {
    const t = sessions();
    const old = t.rollout("child-old", t.parent, event("task_started"));
    const past = new Date(t.since - 60_000);
    utimesSync(old, past, past);
    expect(t.read()).toMatchObject({ quality: "exact", count: 0 });
    const broken = t.rollout("child-broken", t.parent, event("task_started"));
    appendFileSync(broken, "{broken\n");
    expect(t.read()).toMatchObject({ quality: "estimated", count: 1 });
    // 그 뒤의 일 사건이 열림을 다시 정한다(망가진 줄은 다시 읽지 않는다). 같은 범위 안에서 망가진 줄 뒤에 온 사건도 같다.
    appendFileSync(broken, rows(event("task_complete")));
    expect(t.read()).toMatchObject({ quality: "exact", count: 0 });
    // 열린 자식이 없어도 망가진 줄 뒤라 그 줄이 일 사건이었을 수 있다: 추정 0.
    appendFileSync(broken, "{broken mid\n");
    expect(t.read()).toMatchObject({ quality: "estimated", count: 0 });
    appendFileSync(broken, rows(event("task_complete")));
    expect(t.read()).toMatchObject({ quality: "exact", count: 0 });
    appendFileSync(broken, "{broken again\n" + rows(event("task_started")));
    expect(t.read()).toMatchObject({ quality: "estimated", count: 1 });
    appendFileSync(broken, rows(event("task_started")) + "{broken last\n");
    expect(t.read()).toMatchObject({ quality: "estimated", count: 1 });
  });
});

// ───────── 실제 CoreRunner + 운영 배선의 총괄 + 가짜 core + HTTP ─────────
const TOOLS: AgentToolsImpl = {
  listAgentTools: () => [],
  async handleAgentTool(orch, member, name, args) {
    if (name === "post") return { text: `보고함 ${(await orch.recordPost(member, args as unknown as PostInput)).id}` };
    return { text: "모르는 도구", isError: true };
  },
};
const FAST = { tickMs: 150, healthMs: 40, retryMs: 30, inputBusyRetryMs: 30, writeSettleMs: 40, startGraceMs: 200, blockedNoticeMs: 60 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close().catch(() => {}); });
async function setup(opts: CoreSetupOptions = {}): Promise<CoreEnv> {
  const t = await coreSetup({ agentTools: TOOLS, ...opts, timings: { ...FAST, ...opts.timings } });
  cleanups.push(() => t.close());
  return t;
}
const lastRun = (t: CoreEnv, id: string) => t.store.lastWrittenExecution(id, t.store.memberRevisions(id).sessionGeneration);
const transcript = (t: CoreEnv, m: Member) => transcriptPath(m.cwd, m.sessionId!, join(t.home, "claude-home"));

describe("서브에이전트만 일하는 동안의 Claude 팀장", () => {
  test("턴을 끝냈어도 서브에이전트 수가 명부·HTTP 에 실린다(상태는 쉬는 중 그대로). 알림 턴은 일하는 중, 다 끝나면 0. 재우면 모름", async () => {
    const t = await setup();
    const w = (await t.orch.addMember(t.project.id, { name: "조사", handle: "research", role: "개발" })).member;
    // 첫 일은 보고까지 끝낸다(보고 없이 끝나면 서버가 '보고 보완' 턴을 하나 더 넣는다).
    await t.orch.assign(t.project.id, w.handle, { text: "첫 일 @fake:post=첫일끝" });
    await t.waitFor("첫 일 보고", () => t.texts().some(m => m.title === "첫일끝"));
    await t.idle(w.id);
    const events: RunnerEvent[] = []; t.runner.on(event => { if (event.memberId === w.id && event.type === "subagents") events.push(event); });
    const summaries: ProjectSummary[][] = [];
    t.bus.subscribe(event => { if (event.type === "projects") summaries.push(event.projects); });
    // 가짜 CLI 는 턴 끝 줄을 적지 않는다. 실제 Claude 처럼 첫 턴의 끝을 적는다: 아직 아무것도 띄우지 않아 CLI 셈 0(exact).
    appendFileSync(transcript(t, t.member(w.id)), rows(stopSummary(t.member(w.id).sessionId!), turnDuration(t.member(w.id).sessionId!)));
    await t.waitFor("처음 잰 값", () => t.member(w.id).subagentState?.quality === "exact" && t.member(w.id).subagentState?.count === 0);
    const before = lastRun(t, w.id)?.runId;
    await t.orch.assign(t.project.id, w.handle, { text: "가짜 조사를 뒤에서 돌리세요 @fake:hold" });
    const run = await t.waitFor("일하는 중", () => { const r = lastRun(t, w.id); return r && r.runId !== before && r.phase === "running" && t.member(w.id).status === "working" ? r : null; });
    const m = t.member(w.id), s = m.sessionId!, path = transcript(t, m);
    // 백그라운드 에이전트 둘을 띄우고 턴을 끝냈다(core 는 뒤 작업 때문에 working 그대로, 화면은 기다림 줄).
    appendFileSync(path, rows(call(s, "toolu_a1", "Agent"), agentLaunched(s, "toolu_a1", "a1fake"), call(s, "toolu_a2", "Agent"), agentLaunched(s, "toolu_a2", "a2fake"), answer(s), stopSummary(s), turnDuration(s, { agents: 2 })));
    t.core.setScreen(w.id, WAIT_SCREEN);
    await t.waitFor("업무 닫힘", () => lastRun(t, w.id)?.runId === run.runId && lastRun(t, w.id)?.phase === "ended");
    const idle = await t.waitFor("쉬는 중 + 서브에이전트 2", () => { const now = t.member(w.id); return now.status === "idle" && now.subagentState?.quality === "exact" && now.subagentState.count === 2 ? now : null; });
    expect(idle).toMatchObject({ subagents: 2, subagentState: { quality: "exact", count: 2, sessionGeneration: t.store.memberRevisions(w.id).sessionGeneration } });
    expect(idle.subagentState?.observedAt).toEqual(expect.any(String));
    // 상태는 바꾸지 않는다: 쉬는 중(입력을 받음, 핫픽스 C). 출시 앱은 subagentState 만으로 팀 화면에 'N개'를 보인다.
    expect(t.runner.claudeBackground(w.id)).toBe(true);
    const http = await (await t.api("GET", `/api/projects/${t.project.id}/state`)).json() as { members: Member[] };
    expect(http.members.find(x => x.id === w.id)).toMatchObject({ status: "idle", subagents: 2, subagentState: { quality: "exact", count: 2 } });
    const boot = await (await t.api("GET", "/api/bootstrap")).json() as { projects: ProjectSummary[] };
    expect(boot.projects.find(p => p.id === t.project.id)).toMatchObject({ workingCount: 0, subagentWorkingCount: 1 });
    // 앱은 프로젝트 요약 사건으로 '일하는 중' 수를 고친다: 서브에이전트가 생기고 사라질 때 요약이 다시 나간다.
    expect(summaries.some(list => list.find(p => p.id === t.project.id)?.subagentWorkingCount === 1)).toBe(true);

    // 하나가 끝나 Claude 가 알림으로 스스로 턴을 연다: 평소의 일하는 중, 수는 추정 1.
    appendFileSync(path, rows(enqueue(s, "a1fake", "completed", "Agent \"가짜 조사\" finished"), dequeue(s), notified(s, "a1fake", "completed", "Agent \"가짜 조사\" finished")));
    await t.waitFor("알림 턴은 일하는 중", () => t.member(w.id).status === "working" && t.member(w.id).subagentState?.quality === "estimated" && t.member(w.id).subagentState?.count === 1);
    // 그 턴에서 결과를 보고한다(보고 없이 끝난 업무의 '보고 보완' 턴이 뒤에 붙지 않게).
    await t.orch.recordPost(t.member(w.id), { kind: "완료", title: "뒤 작업 결과" });
    appendFileSync(path, rows(answer(s, "하나 끝"), stopSummary(s), turnDuration(s, { agents: 1 })));
    await t.waitFor("다시 쉬는 중 + 1", () => t.member(w.id).status === "idle" && t.member(w.id).subagentState?.quality === "exact" && t.member(w.id).subagentState?.count === 1);
    // 마지막 것도 끝나 알림 턴이 끝나면 0(exact). 그 뒤 core 가 working 을 마친다.
    appendFileSync(path, rows(enqueue(s, "a2fake", "completed", "Agent \"가짜 조사\" finished"), dequeue(s), notified(s, "a2fake", "completed", "Agent \"가짜 조사\" finished"), answer(s, "다 끝"), stopSummary(s), turnDuration(s)));
    await t.waitFor("0", () => t.member(w.id).subagentState?.quality === "exact" && t.member(w.id).subagents === 0 && t.member(w.id).subagentState?.count === 0);
    await t.waitFor("요약에서도 빠짐", () => summaries.at(-1)?.find(p => p.id === t.project.id)?.subagentWorkingCount === 0);
    t.core.setScreen(w.id, IDLE_SCREEN);
    t.core.release(w.id);
    await t.waitFor("core 끝", () => t.member(w.id).status === "idle" && !t.runner.claudeBackground(w.id));
    // 값이 바뀔 때만 사건을 낸다(관측마다 내지 않는다): 이웃한 두 사건이 같은 값인 적이 없고, 정해진 값들이 차례로 지나갔다.
    const seen = events.map(e => e.type === "subagents" ? `${e.quality}:${e.count}` : "");
    expect(seen.every((value, i) => i === 0 || value !== seen[i - 1])).toBe(true);
    let from = 0;
    for (const value of ["exact:0", "exact:2", "estimated:1", "exact:1", "exact:0"]) {
      const at = seen.indexOf(value, from);
      expect(at).toBeGreaterThanOrEqual(from);
      from = at + 1;
    }
    // 재우면 CLI 와 함께 서브에이전트도 끝난다: 수는 모름.
    await t.idle(w.id);
    await t.orch.sleepMember(w.id);
    await t.waitFor("잠듦", () => t.member(w.id).status === "asleep");
    expect(t.member(w.id)).toMatchObject({ subagents: 0, subagentState: { quality: "unknown", count: null } });
  }, 40_000);

  test("CLI 를 바꾸거나 새 세션을 열면 옛 CLI 의 서브에이전트 수는 모름으로 둔다(요약의 '일하는 중' 수에서도 빠진다)", async () => {
    const t = await setup();
    const w = (await t.orch.addMember(t.project.id, { name: "조사", handle: "research", role: "개발" })).member;
    await t.orch.assign(t.project.id, w.handle, { text: "첫 일 @fake:post=첫일끝" });
    await t.waitFor("첫 일 보고", () => t.texts().some(m => m.title === "첫일끝"));
    await t.idle(w.id);
    const m = t.member(w.id), s = m.sessionId!, path = transcript(t, m);
    const generation = t.store.memberRevisions(w.id).sessionGeneration;
    // 턴 끝에 백그라운드 에이전트 둘이 남았다고 적혀 있고 core 는 쉬는 중이다(새 세션 열기를 거절하지 않는 모양).
    appendFileSync(path, rows(stopSummary(s), turnDuration(s, { agents: 2 })));
    await t.waitFor("쉬는 중 + 2", () => t.member(w.id).status === "idle" && t.member(w.id).subagentState?.quality === "exact" && t.member(w.id).subagents === 2);
    const seen: Member[] = [];
    const summaries: ProjectSummary[][] = [];
    t.bus.subscribe(event => {
      if (event.type === "projects") summaries.push(event.projects);
      if (event.type === "member" && event.member.id === w.id) seen.push(event.member);
    });
    await t.orch.freshMemberSession(w.id);
    expect(t.store.memberRevisions(w.id).sessionGeneration).toBe(generation + 1);
    // 옛 CLI 와 그 서브에이전트는 끝났다: 옛 수(exact 2)를 새 세션에 한 번도 싣지 않는다. 새 CLI 는 실행기가 다시 잰다(모름 또는 0).
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some(x => x.subagentState?.quality === "unknown" && x.subagents === 0)).toBe(true);
    expect(seen.filter(x => (x.subagentState?.count ?? 0) > 0 || x.subagents > 0)).toEqual([]);
    expect(t.member(w.id).subagents).toBe(0);
    expect(t.member(w.id).subagentState?.count ?? 0).toBe(0);
    await t.waitFor("요약에서 빠짐", () => summaries.some(list => list.find(p => p.id === t.project.id)?.subagentWorkingCount === 0));
  }, 40_000);

  test("서버를 다시 켜면 복구가 지난 값을 모름으로 되돌리고, 다시 붙은 실행기가 기록으로 다시 잰다", async () => {
    const t = await setup();
    const w = (await t.orch.addMember(t.project.id, { name: "조사", handle: "research", role: "개발" })).member;
    // 첫 일은 보고까지 끝낸다(보고 없이 끝나면 서버가 '보고 보완' 턴을 하나 더 넣는다).
    await t.orch.assign(t.project.id, w.handle, { text: "첫 일 @fake:post=첫일끝" });
    await t.waitFor("첫 일 보고", () => t.texts().some(m => m.title === "첫일끝"));
    await t.idle(w.id);
    const m = t.member(w.id), s = m.sessionId!, path = transcript(t, m);
    appendFileSync(path, rows(stopSummary(s), turnDuration(s), prompt(s, "혼자 띄운 일"), call(s, "toolu_w1", "Workflow"), workflowLaunched(s, "toolu_w1", "wfake9", "wf_fake-009"), answer(s), stopSummary(s), turnDuration(s, { workflows: 1 })));
    const flows = join(dirname(path), s, "subagents", "workflows", "wf_fake-009");
    mkdirSync(flows, { recursive: true });
    writeFileSync(join(flows, "journal.jsonl"), rows({ type: "launched" }, { type: "started", key: "v2:aw1", agentId: "aw1", label: "가짜:1", phase: "조사" }, { type: "started", key: "v2:aw2", agentId: "aw2", label: "가짜:2", phase: "조사" }));
    await t.waitFor("워크플로 안의 둘", () => t.member(w.id).subagentState?.quality === "estimated" && t.member(w.id).subagentState?.count === 2);
    // 복구 전의 새 서버(운영의 initializeRuntime·recover 는 아래에서 차례로 부른다): 명부에는 지난 서버가 잰 값이 남아 있다.
    const next = await t.restart({ live: false });
    cleanups.push(() => next.close());
    expect(next.member(w.id)).toMatchObject({ subagents: 2, subagentState: { quality: "estimated", count: 2 } });
    const seen: string[] = [];
    const summaries: ProjectSummary[][] = [];
    next.bus.subscribe(event => {
      if (event.type === "projects") summaries.push(event.projects);
      if (event.type === "member" && event.member.id === w.id) seen.push(`${event.member.subagentState?.quality}:${event.member.subagentState?.count}:${event.member.subagents}`);
    });
    await next.orch.initializeRuntime();
    await next.orch.recover();
    // 복구는 지난 값을 모름으로 되돌리고(지난 서버가 잰 값은 믿지 않는다), 다시 붙은 터미널의 다음 관측이 다시 잰다(첫 관측에서는 내지 않는다).
    await next.waitFor("다시 잼", () => next.member(w.id).subagentState?.quality === "estimated" && next.member(w.id).subagentState?.count === 2 && next.member(w.id).subagents === 2);
    const reset = seen.indexOf("unknown:null:0");
    expect(reset).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf("estimated:2:2", reset)).toBeGreaterThan(reset);
    expect(next.member(w.id).status).toBe("idle");
    // 상태는 그대로(쉬는 중)여도 서브에이전트가 생기면 프로젝트 요약이 다시 나간다(앱의 '일하는 중' 수).
    await next.waitFor("요약 사건", () => summaries.some(list => list.find(p => p.id === next.project.id)?.subagentWorkingCount === 1));
  }, 40_000);
});
