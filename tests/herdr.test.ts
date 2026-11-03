// 라이브 서버에 쓰지 않는다. 통합 시험은 sessions/iamceo-test-* 격리 서버에서만, 칸 안 claude 는 가짜다.
process.env.IAMCEO_TEST = "1";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { MemberKind } from "../shared/types.ts";
import { rpc } from "../server/runner/herdr-client.ts";
import { HerdrRunner, backgroundWait, conductorTraces, detectHerdr, exitHintShown, inputLooksEmpty, inputText, inspectPane, listAgents, screenContextPct, transcriptTurnEnded } from "../server/runner/herdr.ts";
import type { RunnerEvent, RunnerMember, StartOpts } from "../server/runner/types.ts";
import { assertIsolatedSocket, startIsolatedHerdr, type IsolatedHerdr } from "./fixtures/herdr-harness.ts";

const SCREEN = (input: string, tail = "") => [
  "이전 출력", "> 인용된 줄", "─".repeat(40), `❯ ${input}`, "─".repeat(40),
  "  ◆ Opus │ ███░░░░░░░ │ 27% │ 268K/1.0M", "  ⏵⏵ bypass permissions on", tail,
].join("\n");

describe("화면 해석", () => {
  test("뒤 작업 기다림 줄: 입력칸 바로 위의 상태 줄일 때만, 좁은 칸에서 접혀도 읽는다", () => {
    const rule = "─".repeat(30);
    const screen = (...above: string[]) => ["⏺ 워크플로를 걸었습니다", ...above, rule, "❯ ", rule, "  ⏵⏵ bypass permissions on"].join("\n");
    // 실측(2.1.316) 넓은 칸
    expect(backgroundWait(screen("", "✻ Waiting for 1 dynamic workflow to finish", ""))).toBe("1 dynamic workflow");
    // 실측 좁은 칸: 접히고 그 아래 안내 줄이 붙는다
    expect(backgroundWait(screen("✻ Waiting for 1 dynamic", "  workflow to finish", "  new tas… · Update av…"))).toBe("1 dynamic workflow");
    expect(backgroundWait(screen("✶ Waiting for 2 background agents to finish"))).toBe("2 background agents");
    // 일하는 중·끝난 턴의 상태 줄은 아니다
    expect(backgroundWait(screen("✶ Thinking… (esc to interrupt · 12s)"))).toBe(null);
    expect(backgroundWait(screen("✻ Cogitated for 13s · done 10:56 PM"))).toBe(null);
    // 기다림 줄 아래로 새 대화(넣은 글의 되풀이·답)가 오면 그 줄은 지난 것이다
    expect(backgroundWait(screen("✻ Waiting for 1 dynamic workflow to finish", "❯ 대표 답이 들어옴"))).toBe(null);
    expect(backgroundWait(screen("✻ Waiting for 1 dynamic workflow to finish", "⏺ 답했습니다"))).toBe(null);
    // 대화 글에 인용된 같은 말이나 입력칸이 없는 화면
    expect(backgroundWait("✻ Waiting for 1 dynamic workflow to finish\nuser@host % ")).toBe(null);

    // 실측 둘째 모양: 기다림 줄 없이 입력칸 아래 뒤 작업 막대만 있다(끝난 답 글과 안내 줄이 입력칸 위에 있다).
    const withBar = (...above: string[]) => ["⏺ 머지·푸시 전에는 다시 묻겠습니다.", "  before any merge, push,", ...above, rule, "❯ ", rule, "  ◆ Opus(X) │ ██░░░░░░…", "  ⏵⏵ bypass permissions", "", "  ◯ mahjong-…  ▰▰▰▰▰▰▱▱"].join("\n");
    expect(backgroundWait(withBar("   Update available! R…"))).toBe("mahjong-…");
    expect(backgroundWait(withBar("✻ Worked for 3m 2s"))).toBe("mahjong-…");
    // 막대가 있어도 지금 도는 상태 줄이 있거나 넣은 글이 막 들어왔으면 일하는 중이다
    expect(backgroundWait(withBar("✶ Working… (esc to interrupt)"))).toBe(null);
    expect(backgroundWait(withBar("✢ Thinking… (12s · ↓ 1.2k tokens)"))).toBe(null);
    expect(backgroundWait(withBar("❯ 대표 답"))).toBe(null);
  });

  test("기록의 턴 끝: turn_duration 이나 도구를 부르지 않은 assistant 글이면 끝, 입력·도구 결과·도구 호출이면 아직이다", () => {
    const j = (...entries: object[]) => entries.map((e) => JSON.stringify(e)).join("\n");
    const toolUse = { type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash" }] } };
    const thinking = { type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "thinking" }] } };
    const final = { type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "끝" }] } };
    const result = { type: "user", message: { content: [{ type: "tool_result" }] } };
    const typed = { type: "user", message: { content: "대표 답" } };
    const duration = { type: "system", subtype: "turn_duration" };
    expect(transcriptTurnEnded(j(toolUse, result, final, duration, { type: "api-request" }))).toBe(true);
    expect(transcriptTurnEnded(j(toolUse, result, final))).toBe(true);
    expect(transcriptTurnEnded(j(final, duration, typed))).toBe(false);
    expect(transcriptTurnEnded(j(final, toolUse))).toBe(false);
    expect(transcriptTurnEnded(j(result, thinking))).toBe(false);
    expect(transcriptTurnEnded(j(final, result))).toBe(false);
    // 서브에이전트(사이드체인) 줄과 잘린 첫 줄은 보지 않는다
    expect(transcriptTurnEnded(`{"type":"user","mess\n${j(final, { ...typed, isSidechain: true })}`)).toBe(true);
    expect(transcriptTurnEnded("")).toBe(false);
  });

  test("입력칸", () => {
    expect(inputLooksEmpty(SCREEN(""))).toBe(true);
    expect(inputLooksEmpty(SCREEN("쓰다 만 글"))).toBe(false);
    expect(inputLooksEmpty(SCREEN('Try "edit foo.ts"'))).toBe(true);
    expect(inputLooksEmpty(`${"─".repeat(20)}\n❯ 첫 줄\n  둘째 줄\n${"─".repeat(20)}\n`)).toBe(false);
    expect(inputLooksEmpty(`${"─".repeat(20)}\n❯\n  둘째 줄\n${"─".repeat(20)}\n`)).toBe(false);
    expect(inputLooksEmpty("Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel")).toBe(null);
    expect(inputLooksEmpty("user@host % ")).toBe(null);
    expect(inputLooksEmpty(`\x1b[38m${"─".repeat(20)}\x1b[0m\n\x1b[0m❯ \x1b[7m \x1b[0m\n${"─".repeat(20)}\n`)).toBe(true);
  });

  test("흐린 글씨(다음 말 추천·안내 글)는 친 글이 아니다", () => {
    const rule = `\x1b[2m\x1b[38;5;244m${"─".repeat(40)}\x1b[0m`;
    const box = (line: string) => `이전 출력\n${rule}\n${line}\n${rule}\n  ⏵⏵ bypass permissions on`;
    // 실제 칸에서 읽은 줄(Claude Code 의 다음 말 추천)
    expect(inputLooksEmpty(box("❯\xa0\x1b[0m\x1b[2m포이 님 집계 확인 예약은 지워 줘\x1b[0m\r"))).toBe(true);
    expect(inputLooksEmpty(box("❯ \x1b[2;3mTry \"fix lint errors\"\x1b[22;23m"))).toBe(true);
    expect(inputLooksEmpty(box("❯ 쓰던 글"))).toBe(false);
    // 친 글 뒤에 흐린 이어쓰기 추천이 붙어도 친 글이 있다
    expect(inputLooksEmpty(box("❯ 포이\x1b[2m 님 집계 확인\x1b[0m"))).toBe(false);
    // 트루컬러·256색 숫자 안의 2 는 흐림이 아니다
    expect(inputLooksEmpty(box("❯ \x1b[38;2;200;2;2m빨간 글\x1b[0m"))).toBe(false);
    expect(inputLooksEmpty(box("❯ \x1b[38;5;2m초록 글\x1b[39m"))).toBe(false);
    // 22 로 흐림이 풀린 뒤의 글은 친 글
    expect(inputLooksEmpty(box("❯ \x1b[2m추천\x1b[22m친 글"))).toBe(false);
    // 윗줄에서 켠 흐림이 이어진다(리셋 없음)
    expect(inputLooksEmpty(`\x1b[2m${"─".repeat(30)}\n❯ 흐린 채 이어진 글\n${"─".repeat(30)}\x1b[0m`)).toBe(true);
    // 링크(OSC 8)가 섞여도 읽는다
    expect(inputLooksEmpty(box("❯ \x1b]8;;https://x.y\x07링크\x1b]8;;\x07"))).toBe(false);
  });

  test("입력칸에 남은 글을 그대로 읽고, 종료 안내는 입력칸 아래에서만 본다", () => {
    expect(inputText(SCREEN("쓰다 만 글"))).toBe("쓰다 만 글");
    expect(inputText(SCREEN(""))).toBe("");
    expect(inputText(`${"─".repeat(20)}\n❯ 첫 줄\n  둘째 줄\n${"─".repeat(20)}\n`)).toBe("첫 줄\n둘째 줄");
    expect(inputText(`${"─".repeat(20)}\n❯ 포이\x1b[2m 님 집계 확인\x1b[0m\n${"─".repeat(20)}\n`)).toBe("포이");
    expect(inputText("Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel")).toBe(null);
    expect(exitHintShown(SCREEN("", "  Press Ctrl-C again to exit"))).toBe(true);
    expect(exitHintShown(SCREEN("쓰던 글"))).toBe(false);
    // 대화에 인용된 같은 글은 안내가 아니다.
    expect(exitHintShown(`답변: 'Press Ctrl-C again to exit' 가 뜹니다\n${SCREEN("")}`)).toBe(false);
  });

  test("실제 화면 모양(라벨 달린 가로줄, 아래 상태줄·진행 줄)", () => {
    const real = [
      `${"─".repeat(190)} ops-board-v2-plan ─`, "❯", "─".repeat(200),
      "  ◆ Opus(X) │ ███░░░░░░░ │ 27% │ 268K/1.0M │ $38.35", "  📁 me (iamceo) (main)", "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent", "",
      "  ◯ iamceo-build  ▰▰▰▱▱  2/4 · 19m27s", "",
    ].join("\n");
    expect(inputLooksEmpty(real)).toBe(true);
    expect(screenContextPct(real)).toBe(27);
    expect(screenContextPct("아무 글")).toBe(null);
    expect(screenContextPct("│ 50% │ 표 안의 숫자")).toBe(null);
  });
});

describe("안전장치", () => {
  const live = join(homedir(), ".config", "herdr", "herdr.sock");

  test("IAMCEO_TEST=1 이면 라이브 소켓으로 만들 수 없다", () => {
    expect(() => new HerdrRunner({ socketPath: live }, { inboxDir: "/nonexistent" })).toThrow("시험 소켓이 아닙니다");
    expect(() => new HerdrRunner({ socketPath: join(homedir(), ".config", "herdr", "sessions", "work", "herdr.sock") }, { inboxDir: "/x" })).toThrow();
    expect(() => new HerdrRunner({ socketPath: join(homedir(), ".config", "herdr", "sessions", "iamceo-test", "herdr.sock") }, { inboxDir: "/x" })).toThrow();
  });

  test("시험 격리 소켓은 허용되고 HERDR_SOCKET_PATH 를 읽지 않는다", async () => {
    const saved = process.env.HERDR_SOCKET_PATH;
    process.env.HERDR_SOCKET_PATH = live;
    const missing = join(homedir(), ".config", "herdr", "sessions", "iamceo-test-none", "herdr.sock");
    const runner = new HerdrRunner({ socketPath: missing }, { inboxDir: "/x" });
    const a = await runner.available();
    expect(a.ok).toBe(false);
    await runner.shutdown();
    if (saved === undefined) delete process.env.HERDR_SOCKET_PATH; else process.env.HERDR_SOCKET_PATH = saved;
  });

  test("클라이언트는 라이브 소켓 쓰기를 소켓에 닿기 전에 막는다", async () => {
    await expect(rpc(live, "pane.close", { pane_id: "w1:p1" })).rejects.toThrow("쓰기 차단");
    await expect(rpc(live, "agent.prompt", { target: "x", text: "y" })).rejects.toThrow("쓰기 차단");
  });

  test("격리 소켓 판별", () => {
    expect(() => assertIsolatedSocket(live)).toThrow();
    expect(() => assertIsolatedSocket(join(homedir(), ".config/herdr/sessions/iamceo-test-a1/herdr.sock"))).not.toThrow();
  });
});

// ---- 가짜 소켓 서버: 격리 herdr 로 만들 수 없는 상황(무응답·프로토콜 차이·연결 끊김) ----
function mockServer(handler: (method: string, params: any) => unknown | undefined) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-herdr-mock-")));
  const path = join(dir, "s.sock");
  const subs = new Set<any>();
  const calls: Array<{ method: string; params: any }> = [];
  let server = Bun.listen<{ buf: string }>({
    unix: path,
    socket: {
      open(s) { s.data = { buf: "" }; },
      data(s, chunk) {
        s.data.buf += chunk.toString();
        const nl = s.data.buf.indexOf("\n");
        if (nl < 0) return;
        const msg = JSON.parse(s.data.buf.slice(0, nl));
        s.data.buf = s.data.buf.slice(nl + 1);
        calls.push({ method: msg.method, params: msg.params });
        if (msg.method === "events.subscribe") {
          const verdict = handler(msg.method, msg.params);
          if (verdict instanceof Error) { s.write(JSON.stringify({ id: msg.id, error: { code: verdict.message, message: verdict.message } }) + "\n"); s.end(); return; }
          subs.add(s);
          s.write(JSON.stringify({ id: msg.id, result: { type: "subscription_started" } }) + "\n");
          return;
        }
        const r = handler(msg.method, msg.params);
        if (r === undefined) return; // 답하지 않음(시간 초과 시험)
        s.write(JSON.stringify(r instanceof Error ? { id: msg.id, error: { code: r.message, message: r.message } } : { id: msg.id, result: r }) + "\n");
        s.end();
      },
      close(s) { subs.delete(s); },
    },
  });
  return {
    path, calls, subs,
    kickSubscribers() { for (const s of subs) s.end(); subs.clear(); },
    event(e: unknown) { for (const s of subs) s.write(JSON.stringify(e) + "\n"); },
    stop() { server.stop(true); },
  };
}

const member = (over: Partial<RunnerMember> = {}): RunnerMember => ({
  id: "m_x", projectId: "p_x", handle: "w", name: "직원", cwd: "/tmp", sessionId: "s-1", paneId: "w1:p1",
  model: null, effort: null, subagentModel: null, permissionMode: "auto", kind: "worker", ...over,
});
const OPTS: StartOpts = { systemPromptFile: "/s", mcpConfigFile: "/m", resume: true, projectName: "P" };
const mockAgent = (status = "idle") => ({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", name: "w", agent: "claude", agent_status: status, agent_session: { value: "s-1" } });
const mockSnapshot = (status = "idle") => ({ snapshot: { version: "0", protocol: 22, agents: [mockAgent(status)], panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", agent: "claude" }] } });

async function until(cond: () => boolean, ms = 8000, label = "조건") {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`${label} 시간 초과`);
    await Bun.sleep(30);
  }
}

describe("가짜 소켓 서버", () => {
  const EMPTY_SCREEN = `${"─".repeat(9)}\n❯ \n${"─".repeat(9)}\n`;
  const SID = "11111111-1111-4111-8111-111111111111";

  test("입력칸을 못 찾으면(셸 모드 !, 선택 창) 넣지 않는다", async () => {
    for (const screen of [`${"─".repeat(9)}\n! echo SAFE \n${"─".repeat(9)}\n`, "Resume session\n  세션 1\nEsc to cancel\n", "user@host % "]) {
      const srv = mockServer((method) => {
        if (method === "session.snapshot") return mockSnapshot();
        if (method === "agent.get") return { agent: mockAgent() };
        if (method === "pane.read") return { read: { text: screen } };
        return { type: "ok" };
      });
      const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", claudeHome: "/nonexistent" });
      expect(await r.send(member(), '[대표] "$(touch /tmp/x)" #msg_a', OPTS)).toMatchObject({ ok: false, reason: "input_busy", detail: expect.stringContaining("입력칸을 찾지 못"), retryable: true });
      expect(srv.calls.some((c) => c.method === "agent.prompt")).toBe(false);
      // 선택 창에 지우는 키를 누르면 엉뚱한 선택이 된다.
      expect(srv.calls.some((c) => c.method === "agent.send_keys")).toBe(false);
      await r.shutdown();
      srv.stop();
    }
  });

  const TYPED_SCREEN = `${"─".repeat(9)}\n❯ 실수로 남은 글\n${"─".repeat(9)}\n`;
  const clearKeys = (calls: Array<{ method: string; params: any }>) => calls.filter((c) => c.method === "agent.send_keys" && c.params.keys.includes("ctrl+c"));

  test("입력칸에 남은 글은 지우는 키를 한 번 눌러 지우고, 0.3초 뒤 다시 읽어 비었으면 넣는다", async () => {
    let screen = TYPED_SCREEN;
    let pressedAt = 0;
    let promptAt = 0;
    const srv = mockServer((method, params) => {
      if (method === "session.snapshot") return mockSnapshot();
      if (method === "agent.get") return { agent: mockAgent() };
      if (method === "pane.read") return { read: { text: screen } };
      if (method === "agent.send_keys" && params.keys.includes("ctrl+c")) { pressedAt = Date.now(); screen = EMPTY_SCREEN; }
      if (method === "agent.prompt") promptAt = Date.now();
      return { type: "ok" };
    });
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", claudeHome: "/nonexistent" });
    const seen: RunnerEvent[] = [];
    r.on((e) => seen.push(e));
    expect(await r.send(member(), "지시 #msg_clear", OPTS)).toEqual({ ok: true });
    // 한 번에 키 하나. 두 번 누르면 빈 칸에 누른 셈이 되어 세션이 끝난다.
    expect(clearKeys(srv.calls).map((c) => c.params)).toEqual([{ target: "w1:p1", keys: ["ctrl+c"] }]);
    const order = srv.calls.map((c) => c.method);
    expect(order.indexOf("agent.send_keys")).toBeLessThan(order.indexOf("agent.prompt"));
    expect(srv.calls.filter((c) => c.method === "agent.prompt").map((c) => c.params.text)).toEqual(["지시 #msg_clear"]);
    // 누른 뒤 300ms 는 기다리고, 비었으면 오래 끌지 않는다.
    expect(promptAt - pressedAt).toBeGreaterThanOrEqual(290);
    expect(promptAt - pressedAt).toBeLessThan(1500);
    expect(seen.some((e) => e.type === "activity" && e.text.includes("실수로 남은 글"))).toBe(true);
    await r.shutdown();
    srv.stop();
  });

  test("지운 글이 늦게 사라져도 0.5초 안이면 다시 누르지 않고 넣는다", async () => {
    let screen = TYPED_SCREEN;
    const srv = mockServer((method, params) => {
      if (method === "session.snapshot") return mockSnapshot();
      if (method === "agent.get") return { agent: mockAgent() };
      if (method === "pane.read") return { read: { text: screen } };
      if (method === "agent.send_keys" && params.keys.includes("ctrl+c")) setTimeout(() => { screen = EMPTY_SCREEN; }, 350);
      return { type: "ok" };
    });
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", claudeHome: "/nonexistent" });
    expect(await r.send(member(), "지시 #msg_slow", OPTS)).toEqual({ ok: true });
    expect(clearKeys(srv.calls)).toHaveLength(1);
    expect(srv.calls.filter((c) => c.method === "agent.prompt").map((c) => c.params.text)).toEqual(["지시 #msg_slow"]);
    await r.shutdown();
    srv.stop();
  });

  test("흐린 다음 말 추천만 있으면 지우는 키 없이 넣는다", async () => {
    // 실제 칸에서 읽은 줄. 이때 누르면 추천은 그대로이고 종료 창만 열린다.
    const ghost = `${"─".repeat(9)}\n❯\xa0\x1b[0m\x1b[2m포이 님 집계 확인 예약은 지워 줘\x1b[0m\r\n${"─".repeat(9)}\n`;
    const srv = mockServer((method) => {
      if (method === "session.snapshot") return mockSnapshot();
      if (method === "agent.get") return { agent: mockAgent() };
      if (method === "pane.read") return { read: { text: ghost } };
      return { type: "ok" };
    });
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", claudeHome: "/nonexistent" });
    expect(await r.send(member(), "지시 #msg_ghost", OPTS)).toEqual({ ok: true });
    expect(srv.calls.some((c) => c.method === "agent.send_keys")).toBe(false);
    expect(srv.calls.filter((c) => c.method === "agent.prompt")).toHaveLength(1);
    // 입력칸 판정은 글자 모양까지 읽는다.
    expect(srv.calls.filter((c) => c.method === "pane.read" && c.params.source === "visible").every((c) => c.params.format === "ansi" && c.params.strip_ansi === false)).toBe(true);
    await r.shutdown();
    srv.stop();
  });

  test("일하는 중(urgent)에는 남은 글을 지우지 않는다. 지우는 키가 턴을 끊는다", async () => {
    const srv = mockServer((method) => {
      if (method === "session.snapshot") return mockSnapshot("working");
      if (method === "agent.get") return { agent: mockAgent("working") };
      if (method === "pane.read") return { read: { text: TYPED_SCREEN } };
      return { type: "ok" };
    });
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", claudeHome: "/nonexistent" });
    await r.reattach(member());
    expect(await r.send(member(), "급한 일 #msg_urg", OPTS, true)).toMatchObject({ ok: false, reason: "input_busy", detail: expect.stringContaining("일하는 중"), retryable: true });
    expect(srv.calls.some((c) => c.method === "agent.send_keys" || c.method === "agent.prompt")).toBe(false);
    await r.shutdown();
    srv.stop();
  });

  test("지우는 키는 칸마다 간격을 두고 한 번씩만 누른다. 종료 안내가 떠 있으면 누르지 않는다", async () => {
    // 눌러도 안 지워지는 칸. 곧바로 또 누르면 빈 칸에 두 번 누른 셈이 될 수 있다.
    let screen = TYPED_SCREEN;
    let pressedAt = 0;
    const srv = mockServer((method, params) => {
      if (method === "session.snapshot") return mockSnapshot();
      if (method === "agent.get") return { agent: mockAgent() };
      if (method === "pane.read") return { read: { text: screen } };
      if (method === "agent.send_keys" && params.keys.includes("ctrl+c")) pressedAt = Date.now();
      return { type: "ok" };
    });
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", claudeHome: "/nonexistent" });
    expect(await r.send(member(), "지시 #msg_g1", OPTS)).toMatchObject({ ok: false, reason: "input_busy", detail: expect.stringContaining("비지 않았"), retryable: true });
    expect(clearKeys(srv.calls)).toHaveLength(1);
    // 바로 다음 전달(대기열의 다음 말)도 간격 안이면 누르지 않고 미룬다.
    expect(await r.send(member(), "지시 #msg_g2", OPTS)).toMatchObject({ ok: false, reason: "input_busy", detail: expect.stringContaining("잠시 뒤") });
    expect(clearKeys(srv.calls)).toHaveLength(1);
    // 종료 창(약 0.8초)이 닫힌 뒤라도 1.5초 전이면 아직 누르지 않는다.
    await Bun.sleep(Math.max(0, pressedAt + 950 - Date.now()));
    expect(await r.send(member(), "지시 #msg_g2b", OPTS)).toMatchObject({ ok: false, reason: "input_busy", detail: expect.stringContaining("잠시 뒤") });
    expect(clearKeys(srv.calls)).toHaveLength(1);
    await Bun.sleep(Math.max(0, pressedAt + 1600 - Date.now()));
    screen = `${TYPED_SCREEN}  Press Ctrl-C again to exit\n`;
    expect(await r.send(member(), "지시 #msg_g3", OPTS)).toMatchObject({ ok: false, reason: "input_busy", detail: expect.stringContaining("종료 안내") });
    expect(clearKeys(srv.calls)).toHaveLength(1);
    screen = TYPED_SCREEN;
    await r.send(member(), "지시 #msg_g4", OPTS);
    expect(clearKeys(srv.calls)).toHaveLength(2);
    expect(srv.calls.some((c) => c.method === "agent.prompt")).toBe(false);
    await r.shutdown();
    srv.stop();
  });

  test("Try \" 로 시작해도 뒤에 글이 붙으면 쓰던 글이다", () => {
    const box = (s: string) => `${"─".repeat(9)}\n❯ ${s}\n${"─".repeat(9)}\n`;
    expect(inputLooksEmpty(box('Try "edit foo" 해줘'))).toBe(false);
    expect(inputLooksEmpty(box("Press up to edit queued 메시지 고쳐줘"))).toBe(false);
    expect(inputLooksEmpty(box('Try "fix lint errors"'))).toBe(true);
    expect(inputLooksEmpty(box("Press up to edit queued messages"))).toBe(true);
  });

  test("timeout: 넣기 전부터 화면에 있던 머리글·[Pasted text·#id 는 증거가 아니다", async () => {
    for (const old of ["[총괄] 철수에게", "❯ [Pasted text #1 +40 lines]", "답변 본문에 [Pasted text #1 이라는 글", "[보고 철수] 완료: 어제 끝낸 일"]) {
      const screen = `${old}\n${EMPTY_SCREEN}`;
      const srv = mockServer((method) => {
        if (method === "session.snapshot") return mockSnapshot();
        if (method === "agent.get") return { agent: mockAgent() };
        if (method === "pane.read") return { read: { text: screen } };
        return method === "agent.prompt" ? undefined : { type: "ok" };
      });
      const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", promptTimeoutMs: 100, claudeHome: "/nonexistent" });
      expect(await r.send(member(), "[총괄] 철수에게\n할 일: 일", OPTS)).toMatchObject({ ok: false, retryable: true });
      expect(srv.calls.filter((c) => c.method === "agent.prompt").length).toBe(2);
      await r.shutdown();
      srv.stop();
    }
  });

  test("머리글만 있는 글에는 고유 표지를 붙여 넣는다", async () => {
    const srv = mockServer((method) => {
      if (method === "session.snapshot") return mockSnapshot();
      if (method === "agent.get") return { agent: mockAgent() };
      if (method === "pane.read") return { read: { text: EMPTY_SCREEN } };
      return { type: "ok" };
    });
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", claudeHome: "/nonexistent" });
    await r.send(member(), "[총괄] 철수에게\n할 일: 일", OPTS);
    await r.send(member({ id: "m_y" }), '[대표] "x"\n#msg_keep', OPTS).catch(() => {});
    const texts = srv.calls.filter((c) => c.method === "agent.prompt").map((c) => c.params.text as string);
    expect(texts[0]).toMatch(/\n#dl_[0-9a-f-]+$/);
    await r.shutdown();
    srv.stop();
  });

  test("응답이 턴보다 늦어도 turn_end 는 한 번이고 바쁨이 남지 않는다", async () => {
    let status = "idle";
    let release: ((v: unknown) => void) | null = null;
    const srv = mockServer((method) => {
      if (method === "session.snapshot") return mockSnapshot(status);
      if (method === "agent.get") return { agent: mockAgent(status) };
      if (method === "pane.read") return { read: { text: EMPTY_SCREEN } };
      if (method === "agent.prompt") { release = () => {}; return undefined; }
      return { type: "ok" };
    });
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", settleMs: 20, stallMs: 150, promptTimeoutMs: 400, claudeHome: "/nonexistent" });
    const ends: RunnerEvent[] = [];
    r.on((e) => { if (e.type === "turn_end") ends.push(e); });
    await r.reattach(member());
    await until(() => srv.subs.size === 1, 3000, "구독");
    const sending = r.send(member(), "일해 #msg_late", OPTS);
    await until(() => release !== null, 3000, "넣기");
    status = "working";
    srv.event({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "working" } });
    await Bun.sleep(30);
    status = "idle";
    srv.event({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "idle" } });
    await until(() => ends.length === 1, 3000, "첫 turn_end");
    await sending;
    await Bun.sleep(400);
    expect(ends).toHaveLength(1);
    expect(r.isBusy("m_x")).toBe(false);
    await r.shutdown();
    srv.stop();
  });

  test("승인 창을 거쳐 idle 이 되면 시한을 넘겼어도 awaiting 이 풀린다", async () => {
    let status = "idle";
    const srv = mockServer((method) => {
      if (method === "session.snapshot") return mockSnapshot(status);
      if (method === "agent.get") return { agent: mockAgent(status) };
      if (method === "pane.read") return { read: { text: EMPTY_SCREEN } };
      return { type: "ok" };
    });
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", settleMs: 20, stallMs: 60, claudeHome: "/nonexistent" });
    const seen: RunnerEvent[] = [];
    r.on((e) => seen.push(e));
    await r.reattach(member());
    await until(() => srv.subs.size === 1, 3000, "구독");
    expect(await r.send(member(), "BLOCK #msg_b", OPTS)).toEqual({ ok: true });
    expect(r.isBusy("m_x")).toBe(true);
    status = "blocked";
    await Bun.sleep(200); // 시한을 몇 번 넘긴다
    expect(r.isBusy("m_x")).toBe(true);
    status = "idle";
    srv.event({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "idle" } });
    await until(() => seen.some((e) => e.type === "turn_end"), 3000, "turn_end");
    expect(r.isBusy("m_x")).toBe(false);
    await r.shutdown();
    srv.stop();
  });

  test("소켓이 끊긴 사이에도 awaiting 시한을 다시 건다", async () => {
    let down = false;
    let status = "idle";
    const srv = mockServer((method) => {
      if (method === "session.snapshot") return mockSnapshot(status);
      if (method === "agent.get") return down ? new Error("closed") : { agent: mockAgent(status) };
      if (method === "pane.read") return { read: { text: EMPTY_SCREEN } };
      return { type: "ok" };
    });
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", settleMs: 20, stallMs: 50, claudeHome: "/nonexistent" });
    const seen: RunnerEvent[] = [];
    r.on((e) => seen.push(e));
    await r.send(member(), "일 #msg_c", OPTS);
    down = true;
    await Bun.sleep(120);
    expect(r.isBusy("m_x")).toBe(true);
    down = false;
    await until(() => !r.isBusy("m_x"), 3000, "풀림");
    const end = seen.find((e) => e.type === "turn_end") as Extract<RunnerEvent, { type: "turn_end" }>;
    expect(end.noOutput).toBe(true);
    await r.shutdown();
    srv.stop();
  });

  test("낡은 칸 번호: 세션 없는 남의 칸에 붙지 않고, 화면·Escape 도 보내지 않는다", async () => {
    const foreign = { ...mockAgent(), name: "남의세션", agent_session: null };
    const srv = mockServer((method) => {
      if (method === "session.snapshot") return { snapshot: { version: "0", protocol: 22, agents: [foreign], panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", agent: "claude" }] } };
      if (method === "pane.read") return { read: { text: "사용자 칸 내용" } };
      return { type: "ok" };
    });
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", claudeHome: "/nonexistent" });
    const m = member({ sessionId: SID, paneId: "w1:p1" });
    expect(await r.reattach(m)).toBe(null);
    expect(await r.screen(m)).toBe("");
    await r.interrupt(m);
    expect(await r.send(m, "비밀 지시 #msg_d", OPTS)).toMatchObject({ ok: false, reason: "gone" });
    await r.stop(m);
    for (const method of ["agent.prompt", "agent.send_keys", "pane.close", "pane.read"]) expect(srv.calls.filter((c) => c.method === method)).toEqual([]);
    await r.shutdown();
    srv.stop();
  });

  test("세션 보고가 없어도 어댑터가 준 이름이 맞으면 내 칸이다", async () => {
    const srv = mockServer((method) => {
      if (method === "session.snapshot") return { snapshot: { version: "0", protocol: 22, agents: [{ ...mockAgent(), agent_session: null }], panes: [] } };
      return { type: "ok" };
    });
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", claudeHome: "/nonexistent" });
    expect(await r.reattach(member({ sessionId: SID }))).toMatchObject({ paneId: "w1:p1" });
    await r.shutdown();
    srv.stop();
  });

  test("같은 세션이 두 칸에 있으면 지금 칸을 지키고, 모호하면 붙지 않는다", async () => {
    const mine = { ...mockAgent(), pane_id: "w6:p1", agent_session: { value: SID } };
    const user = { ...mockAgent(), pane_id: "w5:p1", name: "사용자", agent_session: { value: SID } };
    const agents: any[] = [mine];
    const srv = mockServer((method) => {
      if (method === "session.snapshot") return { snapshot: { version: "0", protocol: 22, agents, panes: [] } };
      return { type: "ok" };
    });
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", claudeHome: "/nonexistent", resyncMs: 30 });
    const seen: RunnerEvent[] = [];
    r.on((e) => seen.push(e));
    const m = member({ sessionId: SID, paneId: "w6:p1" });
    await r.reattach(m);
    agents.unshift(user); // 사용자가 복사한 명령으로 번호가 낮은 칸에 같은 세션을 열었다.
    await Bun.sleep(120);
    expect(seen.filter((e) => e.type === "pane").map((e) => (e as any).paneId)).toEqual(["w6:p1"]);
    const again = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", claudeHome: "/nonexistent" });
    expect(await again.reattach(m)).toMatchObject({ paneId: "w6:p1" });
    const third = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", claudeHome: "/nonexistent" });
    agents[1] = { ...mine, name: "다른이름" };
    expect(await third.reattach({ ...m, paneId: null })).toBe(null);
    for (const x of [r, again, third]) await x.shutdown();
    srv.stop();
  });

  test("세션 보고 없는 칸을 옮기면 이벤트로 따라가고 gone 이 나지 않는다", async () => {
    const agents = [{ ...mockAgent(), agent_session: null }];
    const srv = mockServer((method) => {
      if (method === "session.snapshot") return { snapshot: { version: "0", protocol: 22, agents, panes: [] } };
      return { type: "ok" };
    });
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", claudeHome: "/nonexistent" });
    const seen: RunnerEvent[] = [];
    r.on((e) => seen.push(e));
    await r.reattach(member({ sessionId: null }));
    await until(() => srv.subs.size === 1, 3000, "구독");
    agents[0] = { ...agents[0]!, pane_id: "w2:p2", tab_id: "w2:t1" };
    srv.event({ event: "pane_moved", data: { previous_pane_id: "w1:p1", pane: { pane_id: "w2:p2", tab_id: "w2:t1" } } });
    await Bun.sleep(350);
    expect(seen.some((e) => e.type === "status" && e.status === "gone")).toBe(false);
    expect(seen.some((e) => e.type === "pane" && e.paneId === "w2:p2")).toBe(true);
    await r.shutdown();
    srv.stop();
  });

  test("DB 의 탭 번호는 그 탭에 이 프로젝트의 세션이 있을 때만 믿는다. 워크스페이스 이름이 같아도 믿지 않는다", async () => {
    let agents: unknown[] = [];
    const split: string[] = [];
    const srv = mockServer((method, params) => {
      if (method === "session.snapshot") return { snapshot: { version: "0", protocol: 22, agents, panes: [] } };
      if (method === "tab.get") return { tab: { tab_id: params.tab_id, workspace_id: "w5" } };
      if (method === "workspace.get") return { workspace: { label: "내 프로젝트" } };
      if (method === "workspace.create") return { tab: { tab_id: "w9:t1" }, root_pane: { pane_id: "w9:p1" } };
      if (method === "layout.export") return { layout: { root: { type: "pane", pane_id: "w5:p1" } } };
      if (method === "pane.split") { split.push(params.target_pane_id); return { pane: { pane_id: "w5:p2" } }; }
      if (method === "agent.get") return { agent: { ...mockAgent(), pane_id: params.target, tab_id: `${String(params.target).split(":")[0]}:t1`, interactive_ready: true } };
      return { type: "ok" };
    });
    const inbox = mkdtempSync(join(tmpdir(), "iamceo-inbox-"));
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: inbox, claudeHome: "/nonexistent" });
    const o: StartOpts = { ...OPTS, resume: false, herdrTabId: "w5:t1", projectName: "내 프로젝트", projectSessions: ["s-mine"] };
    const first = await r.start(member({ sessionId: null, paneId: null }), o);
    expect(first.tabId).toBe("w9:t1");
    expect(split).toEqual([]);
    await r.shutdown();
    agents = [{ ...mockAgent(), pane_id: "w5:p1", tab_id: "w5:t1", name: "lead", agent_session: { value: "s-mine" } }];
    const r2 = new HerdrRunner({ socketPath: srv.path }, { inboxDir: inbox, claudeHome: "/nonexistent" });
    const second = await r2.start(member({ id: "m_y", handle: "y", sessionId: null, paneId: null }), o);
    expect(split).toEqual(["w5:p1"]); // 있는 칸을 쓰지 않고 나눈다
    expect(second.paneId).toBe("w5:p2");
    await r2.shutdown();
    srv.stop();
  });

  test("낡은 칸 번호의 셸을 다시 쓰지 않고, 시작이 실패해도 그 칸을 닫지 않는다", async () => {
    const srv = mockServer((method, params) => {
      if (method === "session.snapshot") return { snapshot: { version: "0", protocol: 22, agents: [{ ...mockAgent(), pane_id: "w5:p9", tab_id: "w5:t1", name: "lead", agent_session: { value: "s-lead" } }], panes: [{ pane_id: "w5:p1", tab_id: "w5:t1" }] } };
      if (method === "tab.get") return { tab: { tab_id: params.tab_id, workspace_id: "w5" } };
      if (method === "layout.export") return { layout: { root: { type: "pane", pane_id: "w5:p1" } } };
      if (method === "pane.split") return { pane: { pane_id: "w5:p2" } };
      if (method === "agent.start") return new Error("boom");
      return { type: "ok" };
    });
    const inbox = mkdtempSync(join(tmpdir(), "iamceo-inbox-"));
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: inbox, claudeHome: "/nonexistent" });
    await expect(r.start(member({ sessionId: SID, paneId: "w5:p1" }), { ...OPTS, herdrTabId: "w5:t1", projectSessions: ["s-lead"] })).rejects.toThrow();
    const started = srv.calls.filter((c) => c.method === "agent.start");
    expect(started.map((c) => c.params.pane_id)).toEqual(["w5:p2"]);
    expect(srv.calls.filter((c) => c.method === "pane.close").map((c) => c.params.pane_id)).toEqual(["w5:p2"]);
    await r.shutdown();
    srv.stop();
  });

  test("세션 id 가 UUID 가 아니면 칸에 명령을 치지 않는다", async () => {
    const srv = mockServer((method) => (method === "session.snapshot" ? { snapshot: { version: "0", protocol: 22, agents: [], panes: [] } } : { type: "ok" }));
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", claudeHome: "/nonexistent" });
    await expect(r.start(member({ sessionId: "--dangerously-skip-permissions", paneId: null }), OPTS)).rejects.toThrow("세션 ID");
    expect(srv.calls.some((c) => c.method === "agent.start")).toBe(false);
    await r.shutdown();
    srv.stop();
  });

  test("herdr 가 되살린 칸(인자 없음)은 전체 인자로 다시 열고 나서 넣는다. 넘겨받은 세션은 예외", async () => {
    let argv = ["claude", "--resume", SID];
    const panes = { current: "w2:p1" };
    const srv = mockServer((method, params) => {
      if (method === "session.snapshot") return { snapshot: { version: "0", protocol: 22, agents: panes.current === "gone" ? [] : [{ ...mockAgent(), pane_id: panes.current, agent_session: { value: SID } }], panes: [] } };
      if (method === "agent.get") return { agent: { ...mockAgent(), pane_id: panes.current, agent_session: { value: SID }, interactive_ready: true } };
      if (method === "pane.read") return { read: { text: EMPTY_SCREEN } };
      if (method === "pane.process_info") return { process_info: { pane_id: params.pane_id, foreground_processes: [{ pid: 1, name: "claude", argv }] } };
      if (method === "pane.close") { panes.current = "gone"; return { type: "ok" }; }
      if (method === "workspace.create") return { tab: { tab_id: "w3:t1" }, root_pane: { pane_id: "w3:p1" } };
      if (method === "agent.start") { panes.current = params.pane_id; argv = ["claude", "--mcp-config", "/m"]; return { type: "ok" }; }
      return { type: "ok" };
    });
    const inbox = mkdtempSync(join(tmpdir(), "iamceo-inbox-"));
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: inbox, claudeHome: "/nonexistent" });
    const seen: RunnerEvent[] = [];
    r.on((e) => seen.push(e));
    const m = member({ sessionId: SID, paneId: "w2:p1", origin: "runner" });
    expect(await r.send(m, "지시 #msg_r", { ...OPTS, herdrTabId: null })).toEqual({ ok: true });
    const start = srv.calls.find((c) => c.method === "agent.start")!;
    expect(start.params.args).toContain("--mcp-config");
    expect(start.params.args.slice(0, 2)).toEqual(["--resume", SID]);
    const prompt = srv.calls.find((c) => c.method === "agent.prompt")!;
    expect(prompt.params.target).toBe("w3:p1");
    expect(srv.calls.findIndex((c) => c.method === "pane.close")).toBeLessThan(srv.calls.findIndex((c) => c.method === "agent.prompt"));
    expect(seen.some((e) => e.type === "activity" && e.text.includes("다시 엽니다"))).toBe(true);
    await r.shutdown();

    argv = ["claude", "--resume", SID];
    panes.current = "w2:p1";
    const before = srv.calls.length;
    const r2 = new HerdrRunner({ socketPath: srv.path }, { inboxDir: inbox, claudeHome: "/nonexistent" });
    expect(await r2.send(member({ sessionId: SID, paneId: "w2:p1", origin: "adopted" }), "지시 #msg_s", OPTS)).toEqual({ ok: true });
    expect(srv.calls.slice(before).some((c) => c.method === "agent.start" || c.method === "pane.close")).toBe(false);
    await r2.shutdown();

    // 도구 인자는 있어도 effort 가 빠지면 CLI 기본값으로 돌아가므로 다시 연다.
    argv = ["claude", "--resume", SID, "--mcp-config", "/m"];
    panes.current = "w2:p1";
    const mark = srv.calls.length;
    const r3 = new HerdrRunner({ socketPath: srv.path }, { inboxDir: inbox, claudeHome: "/nonexistent" });
    expect(await r3.send(member({ sessionId: SID, paneId: "w2:p1", origin: "runner", effort: "xhigh" }), "지시 #msg_t", { ...OPTS, herdrTabId: null })).toEqual({ ok: true });
    const reopened = srv.calls.slice(mark).find((c) => c.method === "agent.start")!;
    expect(reopened.params.args.join(" ")).toContain("--effort xhigh");
    await r3.shutdown();
    srv.stop();
  });

  test("편입: 입력칸에 쓰던 글은 지우고 /add-dir 를 넣는다. 입력칸을 못 찾으면 미뤘다가 다음 전달 때 넣는다", async () => {
    const SELECT = "Resume session\n❯ 1. 세션 하나\n  2. 세션 둘\nEsc to cancel\n";
    let screen = `${"─".repeat(9)}\n❯ 쓰다 만 내 글 \n${"─".repeat(9)}\n`;
    const srv = mockServer((method, params) => {
      if (method === "session.snapshot") return { snapshot: { version: "0", protocol: 22, agents: [mockAgent()], panes: [] } };
      if (method === "agent.get") return { agent: mockAgent() };
      if (method === "pane.read") return { read: { text: screen } };
      if (method === "workspace.create") return { tab: { tab_id: "w3:t1" }, root_pane: { pane_id: "w3:p1" } };
      if (method === "pane.move") return { move_result: { pane: { pane_id: "w1:p1" } } };
      if (method === "agent.send_keys" && params.keys.includes("ctrl+c")) screen = EMPTY_SCREEN;
      if (method === "agent.prompt" && String(params.text).startsWith("/add-dir")) { screen = `Added ${params.text.slice(9)}\n${EMPTY_SCREEN}`; return { type: "ok" }; }
      return { type: "ok" };
    });
    const inbox = mkdtempSync(join(tmpdir(), "iamceo-inbox-"));
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: inbox, claudeHome: "/nonexistent" });
    const seen: RunnerEvent[] = [];
    r.on((e) => seen.push(e));
    const m = member({ sessionId: null, paneId: null, origin: "adopted" });
    await r.adopt(m, "w1:p1", OPTS);
    expect(clearKeys(srv.calls)).toHaveLength(1);
    expect(srv.calls.filter((c) => c.method === "agent.prompt").map((c) => c.params.text)).toEqual([`/add-dir ${join(inbox, "m_x")}`]);
    expect(seen.some((e) => e.type === "activity" && e.text.includes("미뤘"))).toBe(false);
    r.dropMember(m.id);
    await r.shutdown();

    // 선택 창이 떠 있으면 글자가 선택이 된다. 누르지도 넣지도 않고 미룬다.
    screen = SELECT;
    const before = srv.calls.length;
    const r2 = new HerdrRunner({ socketPath: srv.path }, { inboxDir: inbox, claudeHome: "/nonexistent" });
    const seen2: RunnerEvent[] = [];
    r2.on((e) => seen2.push(e));
    const m2 = member({ id: "m_y", sessionId: null, paneId: null, origin: "adopted" });
    await r2.adopt(m2, "w1:p1", OPTS);
    expect(srv.calls.slice(before).some((c) => c.method === "agent.prompt" || c.method === "agent.send_keys")).toBe(false);
    expect(seen2.some((e) => e.type === "activity" && e.text.includes("미뤘") && e.text.includes("입력칸을 찾지 못"))).toBe(true);
    screen = EMPTY_SCREEN;
    await r2.send(m2, "규칙 #msg_rules", OPTS);
    const texts = srv.calls.slice(before).filter((c) => c.method === "agent.prompt").map((c) => c.params.text as string);
    expect(texts[0]).toBe(`/add-dir ${join(inbox, "m_y")}`);
    expect(texts[1]).toContain("규칙");
    await r2.shutdown();
    srv.stop();
  });

  test("기록을 이어 읽어 서브에이전트 수와 도구 활동을 낸다", async () => {
    const home = mkdtempSync(join(tmpdir(), "iamceo-claude-"));
    const dir = join(home, "projects", "-tmp");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${SID}.jsonl`);
    writeFileSync(file, "");
    let status = "idle";
    const srv = mockServer((method) => {
      if (method === "session.snapshot") return { snapshot: { version: "0", protocol: 22, agents: [{ ...mockAgent(status), agent_session: { value: SID } }], panes: [] } };
      if (method === "agent.get") return { agent: { ...mockAgent(status), agent_session: { value: SID } } };
      if (method === "pane.read") return { read: { text: EMPTY_SCREEN } };
      return { type: "ok" };
    });
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", settleMs: 20, claudeHome: home });
    const seen: RunnerEvent[] = [];
    r.on((e) => seen.push(e));
    const m = member({ sessionId: SID, cwd: "/tmp" });
    await r.reattach(m);
    await until(() => srv.subs.size === 1, 3000, "구독");
    status = "working";
    srv.event({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "working" } });
    await Bun.sleep(30);
    const entry = (o: unknown) => `${JSON.stringify(o)}\n`;
    appendFileSync(file, entry({ type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "Agent", input: { x: 1 } }, { type: "tool_use", id: "b", name: "Task", input: {} }, { type: "tool_use", id: "c", name: "Bash", input: { command: "ls" } }] } }));
    await until(() => seen.some((e) => e.type === "subagents" && e.count === 2), 4000, "서브에이전트 2");
    expect(seen.some((e) => e.type === "activity" && e.kind === "tool" && e.text.startsWith("Bash"))).toBe(true);
    appendFileSync(file, entry({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "끝" }] } }));
    await until(() => seen.some((e) => e.type === "subagents" && e.count === 1), 4000, "서브에이전트 1");
    expect(seen.some((e) => e.type === "activity" && e.kind === "tool_result" && e.text === "끝")).toBe(true);
    status = "idle";
    srv.event({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "idle" } });
    await until(() => seen.some((e) => e.type === "turn_end"), 3000, "turn_end");
    expect(seen.filter((e) => e.type === "subagents").at(-1)).toMatchObject({ count: 0 });
    await r.shutdown();
    srv.stop();
  });

  test("꺼진 사이 끝난 턴: 입력 뒤의 글만 돌려준다", async () => {
    const home = mkdtempSync(join(tmpdir(), "iamceo-claude-"));
    const dir = join(home, "projects", "-tmp");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${SID}.jsonl`);
    const srv = mockServer((method) => {
      if (method === "session.snapshot") return { snapshot: { version: "0", protocol: 22, agents: [{ ...mockAgent("idle"), agent_session: { value: SID } }], panes: [] } };
      if (method === "agent.get") return { agent: mockAgent("idle") };
      return { type: "ok" };
    });
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", settleMs: 10, claudeHome: home });
    const m = member({ sessionId: SID, cwd: "/tmp" });
    await r.reattach(m);
    const line = (at: string, text: string) => `${JSON.stringify({ type: "user", timestamp: at, message: { content: "입력" } })}\n${JSON.stringify({ type: "assistant", timestamp: at, message: { content: [{ type: "text", text }] } })}\n`;
    writeFileSync(file, line("2026-01-01T00:00:10.000Z", "옛 글"));
    expect(r.finishedWhileAway(m, "2026-01-01T00:01:00.000Z")).toBe(null);
    appendFileSync(file, line("2026-01-01T00:02:00.000Z", "끝냈습니다"));
    expect(r.finishedWhileAway(m, "2026-01-01T00:01:00.000Z")).toEqual({ finalText: "끝냈습니다", isError: false });
    await r.shutdown();
    srv.stop();
  });

  test("입력만 있고 API 오류로 끝난 턴은 noOutput, 일하다 난 오류는 아니다", async () => {
    const home = mkdtempSync(join(tmpdir(), "iamceo-claude-"));
    const dir = join(home, "projects", "-tmp");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${SID}.jsonl`);
    const entry = (o: unknown) => `${JSON.stringify(o)}\n`;
    const srv = mockServer((method) => {
      if (method === "session.snapshot") return { snapshot: { version: "0", protocol: 22, agents: [{ ...mockAgent("working"), agent_session: { value: SID } }], panes: [] } };
      if (method === "pane.read") return { read: { text: EMPTY_SCREEN } };
      return { type: "ok" };
    });
    for (const [lines, expected] of [
      [[{ type: "user", message: { content: "일해" } }, { type: "assistant", isApiErrorMessage: true, message: { model: "<synthetic>", content: [{ type: "text", text: "weekly limit" }] } }], true],
      [[{ type: "user", message: { content: "일해" } }, { type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }] } }, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "" }] } }, { type: "assistant", isApiErrorMessage: true, message: { model: "<synthetic>", content: [{ type: "text", text: "limit" }] } }], false],
    ] as const) {
      writeFileSync(file, lines.map(entry).join(""));
      const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", settleMs: 10, claudeHome: home });
      const ends: any[] = [];
      r.on((e) => { if (e.type === "turn_end") ends.push(e); });
      await r.reattach(member({ sessionId: SID }));
      await until(() => srv.subs.size >= 1, 3000, "구독");
      srv.event({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "idle" } });
      await until(() => ends.length === 1, 3000, "turn_end");
      expect(ends[0]).toMatchObject({ isError: true, noOutput: expected });
      await r.shutdown();
    }
    srv.stop();
  });

  test("구독 직전에 칸이 닫혀 구독이 거부되어도 스냅샷으로 알아채고 다시 붙는다", async () => {
    let alive = true;
    const srv = mockServer((method, params) => {
      if (method === "session.snapshot") return alive ? mockSnapshot() : { snapshot: { version: "0", protocol: 22, agents: [], panes: [] } };
      if (method === "events.subscribe" && !alive && params.subscriptions.some((x: { pane_id?: string }) => x.pane_id)) return new Error("pane_not_found");
      return { type: "ok" };
    });
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", claudeHome: "/nonexistent" });
    const seen: RunnerEvent[] = [];
    r.on((e) => seen.push(e));
    await r.reattach(member());
    alive = false;
    await until(() => seen.some((e) => e.type === "status" && e.status === "gone"), 3000, "gone");
    await until(() => srv.subs.size === 1 && r.isConnected(), 5000, "다시 구독");
    await r.shutdown();
    srv.stop();
  });

  test("프로토콜 번호가 다르면 경고하고 계속한다", async () => {
    const srv = mockServer(() => ({ type: "pong", version: "9.9.9", protocol: 99 }));
    const info = await detectHerdr(srv.path);
    expect(info).toMatchObject({ running: true, version: "9.9.9", protocol: 99, compatible: false });
    expect(info.warning).toContain("99");
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x" });
    expect((await r.available()).ok).toBe(true);
    await r.shutdown();
    srv.stop();
  });

  test("timeout 뒤 화면에 #id 가 있으면 다시 넣지 않는다", async () => {
    // 들어갔다면 넣은 뒤에야 화면에 나타난다. 넣기 전부터 있던 글은 증거가 아니다(아래 시험).
    let prompted = false;
    const screenText = () => `${"─".repeat(9)}\n❯ \n${"─".repeat(9)}\n${prompted ? "> 일해 #msg_seen\n" : ""}`;
    const srv = mockServer((method) => {
      if (method === "session.snapshot") return mockSnapshot();
      if (method === "agent.get") return { agent: mockAgent() };
      if (method === "pane.read") return { read: { text: screenText() } };
      if (method === "agent.prompt") prompted = true;
      return method === "agent.prompt" ? undefined : { type: "ok" };
    });
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", promptTimeoutMs: 150, claudeHome: "/nonexistent" });
    expect(await r.send(member(), "일해 #msg_seen", OPTS)).toEqual({ ok: true });
    expect(srv.calls.filter((c) => c.method === "agent.prompt").length).toBe(1);
    await r.shutdown();
    srv.stop();
  });

  test("timeout 뒤 흔적이 없을 때만 한 번 다시 넣는다", async () => {
    const screenText = `${"─".repeat(9)}\n❯ \n${"─".repeat(9)}\n`;
    const srv = mockServer((method) => {
      if (method === "session.snapshot") return mockSnapshot();
      if (method === "agent.get") return { agent: mockAgent() };
      if (method === "pane.read") return { read: { text: screenText } };
      return method === "agent.prompt" ? undefined : { type: "ok" };
    });
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", promptTimeoutMs: 150, claudeHome: "/nonexistent" });
    const res = await r.send(member(), "일해 #msg_lost", OPTS);
    expect(res).toMatchObject({ ok: false, reason: "error", retryable: true });
    expect(srv.calls.filter((c) => c.method === "agent.prompt").length).toBe(2);
    await r.shutdown();
    srv.stop();
  });

  test("working 이면 timeout 을 들어간 것으로 본다", async () => {
    let prompted = false;
    const srv = mockServer((method) => {
      if (method === "session.snapshot") return mockSnapshot();
      if (method === "agent.get") return { agent: mockAgent(prompted ? "working" : "idle") };
      if (method === "pane.read") return { read: { text: `${"─".repeat(9)}\n❯ \n${"─".repeat(9)}\n` } };
      if (method === "agent.prompt") { prompted = true; return undefined; }
      return { type: "ok" };
    });
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", promptTimeoutMs: 150, claudeHome: "/nonexistent" });
    expect(await r.send(member(), "일해", OPTS)).toEqual({ ok: true });
    expect(srv.calls.filter((c) => c.method === "agent.prompt").length).toBe(1);
    await r.shutdown();
    srv.stop();
  });

  test("이벤트 연결이 끊기면 다시 구독하고 놓친 상태를 메운다", async () => {
    let status = "idle";
    const srv = mockServer((method) => {
      if (method === "session.snapshot") return mockSnapshot(status);
      if (method === "agent.get") return { agent: mockAgent(status) };
      return { type: "ok" };
    });
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", settleMs: 20, claudeHome: "/nonexistent" });
    const events: RunnerEvent[] = [];
    r.on((e) => events.push(e));
    await r.reattach(member());
    await until(() => srv.subs.size === 1, 3000, "첫 구독");
    const firstCount = srv.calls.filter((c) => c.method === "events.subscribe").length;
    status = "working";
    srv.kickSubscribers();
    await until(() => srv.calls.filter((c) => c.method === "events.subscribe").length > firstCount, 4000, "재구독");
    await until(() => events.some((e) => e.type === "status" && e.status === "working"), 3000, "놓친 상태");
    // 재접속 뒤 구독에 칸별 상태 이벤트가 들어 있어야 한다.
    const lastSub = srv.calls.filter((c) => c.method === "events.subscribe").at(-1)!;
    expect(lastSub.params.subscriptions).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w1:p1" });
    expect(r.isConnected()).toBe(true);
    await r.shutdown();
    srv.stop();
  });

  test("서버가 사라지면 send 는 down, 돌아오면 다시 된다", async () => {
    const srv = mockServer((method) => (method === "session.snapshot" ? mockSnapshot() : method === "agent.get" ? { agent: mockAgent() } : { type: "ok" }));
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", claudeHome: "/nonexistent" });
    await r.reattach(member());
    srv.stop();
    expect(await r.send(member(), "일해", OPTS)).toMatchObject({ ok: false, reason: "down", retryable: true });
    await r.shutdown();
  });
});

// ---- 격리 herdr 서버 ----
describe("격리 herdr 서버", () => {
  let h: IsolatedHerdr;
  let runner: HerdrRunner;
  let events: RunnerEvent[];
  let inbox: string;
  let claudeHome: string;
  let work: string;
  let serial = 0;
  const startedRunners: HerdrRunner[] = [];

  const newRunner = () => {
    const r = new HerdrRunner({ socketPath: h.socketPath }, { inboxDir: inbox, claudeHome, settleMs: 400, stallMs: 5000, startTimeoutMs: 25_000, compactGraceMs: 6000, bgCheckMs: 300 });
    startedRunners.push(r);
    return r;
  };
  const argvLog = () => readFileSync(join(h.fakeDir, "argv.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const promptLog = () => {
    const f = join(h.fakeDir, "prompts.jsonl");
    return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  };
  /** 가짜 Claude 가 받은 Ctrl+C(지우는 키). */
  const keysLog = (sessionId: string | null) => {
    const f = join(h.fakeDir, "keys.jsonl");
    return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((k) => k.sessionId === sessionId) : [];
  };
  const raw = <T = any>(method: string, params: Record<string, unknown> = {}) => rpc<T>(h.socketPath, method, params, 8000);
  const snapshot = async () => (await raw("session.snapshot")).snapshot;
  const opts = (projectName: string, over: Partial<StartOpts> = {}): StartOpts => ({ systemPromptFile: join(h.dir, "rules.md"), mcpConfigFile: join(h.dir, "mcp.json"), resume: false, projectName, ...over });
  const newMember = (kind: MemberKind, handle: string, projectId: string, name = handle): RunnerMember => ({
    id: `m_${++serial}`, projectId, handle, name, cwd: work, sessionId: null, paneId: null, model: null, effort: null, subagentModel: null, permissionMode: "bypassPermissions", kind,
  });
  const started = async (r: HerdrRunner, m: RunnerMember, o: StartOpts): Promise<RunnerMember & { tabId: string }> => {
    const res = await r.start(m, o);
    return { ...m, sessionId: res.sessionId, paneId: res.paneId, tabId: res.tabId! };
  };
  const waitEvent = (pred: (e: RunnerEvent) => boolean, label: string, ms = 10_000) => until(() => events.some(pred), ms, label);
  const clear = () => { events.length = 0; };
  const statusIs = (id: string, status: string) => (e: RunnerEvent) => e.type === "status" && e.memberId === id && e.status === status;
  const idleNow = async (r: HerdrRunner, m: RunnerMember) => {
    const end = Date.now() + 8000;
    while (r.isBusy(m.id) || (await raw("agent.get", { target: m.paneId })).agent.agent_status === "unknown") {
      if (Date.now() > end) throw new Error("idle 시간 초과");
      await Bun.sleep(50);
    }
  };

  beforeAll(async () => {
    h = await startIsolatedHerdr();
    assertIsolatedSocket(h.socketPath);
    inbox = join(h.dir, "inbox");
    claudeHome = join(h.fakeDir, "claude");
    work = join(h.dir, "work");
    writeFileSync(join(h.dir, "rules.md"), "규칙 1\n규칙 2\n");
    writeFileSync(join(h.dir, "mcp.json"), "{}");
    mkdirSync(claudeHome, { recursive: true });

    // 실제 claude 를 절대 띄우지 않도록 어떤 agent.start 보다 먼저 칸의 claude 를 확인한다.
    const w = await raw("workspace.create", { cwd: work, label: "점검", focus: false });
    const pane = w.root_pane.pane_id;
    await Bun.sleep(400);
    await raw("pane.send_text", { pane_id: pane, text: "command -v claude\r" });
    let screen = "";
    for (let i = 0; i < 40; i++) {
      screen = (await raw("pane.read", { pane_id: pane, source: "visible" })).read.text;
      if (screen.includes("/claude\n")) break;
      await Bun.sleep(100);
    }
    expect(screen.split("\n").map((l: string) => l.trim())).toContain(h.fakeClaudePath);
    await raw("pane.close", { pane_id: pane });

    runner = newRunner();
    events = [];
    runner.on((e) => events.push(e));
  }, 120_000);

  afterEach(() => { clear(); });

  afterAll(async () => {
    for (const r of startedRunners) await r.shutdown();
    await h?.stop();
    await expect(rpc(h.socketPath, "ping", {}, 500)).rejects.toThrow();
  }, 30_000);

  test("detectHerdr·listAgents 는 격리 서버를 본다", async () => {
    const info = await detectHerdr(h.socketPath);
    expect(info).toMatchObject({ installed: true, running: true, protocol: 22, compatible: true, warning: null });
    expect(info.version).toMatch(/\d+\.\d+/);
    expect(await detectHerdr(join(h.dir, "없음.sock"))).toMatchObject({ running: false, compatible: false });
    expect((await runner.available()).ok).toBe(true);
  });

  test("모델·effort 는 인자로, 서브에이전트 모델은 칸 환경으로 간다(새 워크스페이스·나눈 칸 모두)", async () => {
    const pid = "p_rank";
    const lead = await started(runner, { ...newMember("conductor", "rlead", pid), model: "opus", effort: "high", subagentModel: "haiku" }, { ...opts("직급"), settingsFile: join(h.dir, "s.json") });
    const worker = await started(runner, { ...newMember("worker", "rw", pid), model: "sonnet", effort: "low", subagentModel: "haiku" }, opts("직급", { herdrTabId: lead.tabId, projectSessions: [lead.sessionId!] }));
    const plain = await started(runner, newMember("worker", "rp", pid), opts("직급", { herdrTabId: lead.tabId, projectSessions: [lead.sessionId!] }));
    const log = argvLog();
    const of = (sid: string | null) => log.find((a) => a.sessionId === sid)!;
    const value = (a: { args: string[] }, flag: string) => (a.args.includes(flag) ? a.args[a.args.indexOf(flag) + 1] : null);
    expect([value(of(lead.sessionId), "--model"), value(of(lead.sessionId), "--effort"), value(of(lead.sessionId), "--settings")]).toEqual(["opus", "high", join(h.dir, "s.json")]);
    expect(of(lead.sessionId)).toMatchObject({ subagentModel: "haiku", subagentForce: "1" });
    expect([value(of(worker.sessionId), "--model"), value(of(worker.sessionId), "--effort"), value(of(worker.sessionId), "--settings")]).toEqual(["sonnet", "low", null]);
    expect(of(worker.sessionId)).toMatchObject({ subagentModel: "haiku", subagentForce: "1" });
    expect(of(plain.sessionId)).toMatchObject({ subagentModel: null, subagentForce: null });
    expect([value(of(plain.sessionId), "--model"), value(of(plain.sessionId), "--effort")]).toEqual([null, null]);
  }, 60_000);

  test("applyConfig: 쉬는 칸을 같은 세션으로 다시 열고 슬래시 명령은 넣지 않는다. 남은 글은 지우고 하고, 일하는 중이면 안 건드린다", async () => {
    const m = await started(runner, newMember("worker", "cfg", "p_cfg", "설정"), opts("설정 시험"));
    await idleNow(runner, m);
    const next = { ...m, model: "sonnet", effort: "low" as const, subagentModel: "haiku" };

    await raw("pane.send_text", { pane_id: m.paneId, text: "내가 치던 글" });
    const end = Date.now() + 5000;
    while (!(await raw("pane.read", { pane_id: m.paneId, source: "visible" })).read.text.includes("내가 치던 글")) {
      if (Date.now() > end) throw new Error("입력칸 시간 초과");
      await Bun.sleep(50);
    }
    // 실측(2.1.316): Esc 한 번은 입력칸의 글을 지우지 않는다. 지우는 키는 Ctrl+C 다.
    await raw("pane.send_keys", { pane_id: m.paneId, keys: ["Escape"] });
    await Bun.sleep(300);
    expect((await raw("pane.read", { pane_id: m.paneId, source: "visible" })).read.text).toContain("내가 치던 글");

    expect(await runner.applyConfig(next, opts("설정 시험", { resume: true }))).toEqual({ ok: true });
    expect(keysLog(m.sessionId).map((k) => k.input)).toEqual(["내가 치던 글"]);
    const runs = argvLog().filter((a) => a.sessionId === m.sessionId);
    expect(runs).toHaveLength(2);
    const last = runs.at(-1)!;
    expect(last.args.slice(0, 2)).toEqual(["--resume", m.sessionId]);
    expect(last.args[last.args.indexOf("--model") + 1]).toBe("sonnet");
    expect(last.args[last.args.indexOf("--effort") + 1]).toBe("low");
    expect(last).toMatchObject({ subagentModel: "haiku", subagentForce: "1" });
    expect(promptLog().filter((p) => p.sessionId === m.sessionId && /^\/(model|effort)/.test(p.text))).toHaveLength(0);
    // 다시 연 칸으로 그대로 이어진다.
    const fresh = (await listAgents(h.socketPath)).find((a) => a.sessionId === m.sessionId)!;
    expect(fresh.paneId).not.toBe(m.paneId);
    await idleNow(runner, { ...next, paneId: fresh.paneId });
    expect(await runner.send({ ...next, paneId: fresh.paneId }, "SLOW 다시 연 뒤 #msg_cfg", opts("설정 시험"))).toEqual({ ok: true });
    await waitEvent(statusIs(m.id, "working"), "일 시작");
    expect(await runner.applyConfig({ ...next, model: "opus", paneId: fresh.paneId }, opts("설정 시험", { resume: true }))).toMatchObject({ ok: false, reason: "busy" });
    expect(argvLog().filter((a) => a.sessionId === m.sessionId)).toHaveLength(2);
    await runner.interrupt({ ...next, paneId: fresh.paneId });
  }, 60_000);

  test("여러 줄 인자는 herdr 가 거부한다(규칙을 파일로 넘기는 이유)", async () => {
    const w = await raw("workspace.create", { cwd: work, label: "인자", focus: false });
    await Bun.sleep(300);
    await expect(raw("agent.start", { name: "multi", kind: "claude", pane_id: w.root_pane.pane_id, args: ["--append-system-prompt", "a\nb"], timeout_ms: 4000 })).rejects.toThrow("cannot be encoded");
    await raw("pane.close", { pane_id: w.root_pane.pane_id });
  });

  test("총괄을 새 워크스페이스에 띄우고 포커스를 뺏지 않는다", async () => {
    const before = await snapshot();
    const m = newMember("conductor", "lead", "p_layout", "총괄");
    const r = await started(runner, m, opts("배치 시험"));
    expect(r.paneId).toBeTruthy();
    expect(r.tabId).toBeTruthy();
    expect(r.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const after = await snapshot();
    expect(after.focused_pane_id).toBe(before.focused_pane_id);
    const ws = after.workspaces.find((w: any) => r.tabId!.startsWith(`${w.workspace_id}:`));
    expect(ws.label).toBe("배치 시험");
    const argv = argvLog().find((a) => a.sessionId === r.sessionId)!;
    expect(argv.cwd).toBe(work);
    expect(argv.args).toEqual(["--session-id", r.sessionId, "-n", "총괄", "--append-system-prompt-file", join(h.dir, "rules.md"), "--mcp-config", join(h.dir, "mcp.json"), "--permission-mode", "bypassPermissions", "--allowedTools", "mcp__iamceo", "--add-dir", join(h.dir, "inbox", m.id)]);
    await waitEvent((e) => e.type === "session" && e.memberId === m.id && e.sessionId === r.sessionId, "session");
    await waitEvent((e) => e.type === "pane" && e.memberId === m.id && e.paneId === r.paneId && e.tabId === r.tabId, "pane");
    expect((await listAgents(h.socketPath)).find((a) => a.paneId === r.paneId)).toMatchObject({ name: "lead", agent: "claude", sessionId: r.sessionId, adopted: false });
  }, 40_000);

  test("위 줄 직원은 같은 너비, 아래 총괄은 30%", async () => {
    const pid = "p_grid";
    const lead = await started(runner, newMember("conductor", "lead2", pid), opts("칸 시험"));
    const tab = lead.tabId;
    const workers: Array<RunnerMember & { tabId: string }> = [];
    // 한꺼번에 띄워도 트리가 어긋나지 않아야 한다.
    const results = await Promise.all(["a1", "a2", "a3"].map((h2) => started(runner, newMember("worker", h2, pid), opts("칸 시험", { herdrTabId: tab }))));
    workers.push(...results);
    expect(new Set(results.map((r) => r.tabId))).toEqual(new Set([tab]));

    const layout = (await snapshot()).layouts.find((l: any) => l.tab_id === tab);
    const rect = (id: string) => layout.panes.find((p: any) => p.pane_id === id).rect;
    const leadRect = rect(lead.paneId!);
    expect(leadRect.width).toBe(layout.area.width);
    expect(leadRect.y + leadRect.height).toBe(layout.area.y + layout.area.height);
    expect(Math.abs(leadRect.height / layout.area.height - 0.3)).toBeLessThan(0.05);
    const tops = results.map((w) => rect(w.paneId!));
    for (const t of tops) expect(t.y + t.height).toBe(leadRect.y);
    const widths = tops.map((t) => t.width);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);

    // 가운데 칸을 잠재우면 나머지가 같은 너비로 돌아온다. gone 은 나오지 않는다.
    clear();
    await runner.stop(workers[1]!);
    const again = (await snapshot()).layouts.find((l: any) => l.tab_id === tab);
    expect(again.panes.length).toBe(3);
    const a = again.panes.find((p: any) => p.pane_id === workers[0]!.paneId).rect;
    const c = again.panes.find((p: any) => p.pane_id === workers[2]!.paneId).rect;
    expect(Math.abs(a.width - c.width)).toBeLessThanOrEqual(1);
    await Bun.sleep(400);
    expect(events.some(statusIs(workers[1]!.id, "gone"))).toBe(false);
    // 세션 파일은 남는다.
    expect(existsSync(join(claudeHome, "projects", work.replace(/[^a-zA-Z0-9]/g, "-"), `${workers[1]!.sessionId}.jsonl`))).toBe(true);

    // 다시 열기: 같은 탭 맨 오른쪽, --resume.
    const reopened = await started(runner, { ...workers[1]!, paneId: null }, opts("칸 시험", { herdrTabId: tab, resume: true }));
    expect(reopened.sessionId).toBe(workers[1]!.sessionId);
    expect(argvLog().at(-1)!.args.slice(0, 2)).toEqual(["--resume", workers[1]!.sessionId]);
    const last = (await snapshot()).layouts.find((l: any) => l.tab_id === tab);
    const lastRect = last.panes.find((p: any) => p.pane_id === reopened.paneId).rect;
    expect(lastRect.x).toBeGreaterThan(c.x);
    expect(last.splits[0].ratio).toBeCloseTo(0.7, 1);
  }, 90_000);

  test("직원만 있던 탭에 총괄이 오면 맨 아래로 가고 직원은 살아 있다", async () => {
    const pid = "p_late";
    const w1 = await started(runner, newMember("worker", "b1", pid), opts("늦은 총괄"));
    const w2 = await started(runner, newMember("worker", "b2", pid), opts("늦은 총괄", { herdrTabId: w1.tabId }));
    const w3 = await started(runner, newMember("worker", "b3", pid), opts("늦은 총괄", { herdrTabId: w1.tabId }));
    const lead = await started(runner, newMember("conductor", "blead", pid), opts("늦은 총괄", { herdrTabId: w1.tabId }));
    const snap = await snapshot();
    const layout = snap.layouts.find((l: any) => l.tab_id === w1.tabId);
    const leadRect = layout.panes.find((p: any) => p.pane_id === lead.paneId).rect;
    expect(leadRect.width).toBe(layout.area.width);
    expect(layout.panes.length).toBe(4);
    for (const w of [w1, w2, w3]) {
      const agent = snap.agents.find((a: any) => a.agent_session?.value === w.sessionId);
      expect(agent, `${w.handle} 세션 유지`).toBeTruthy();
      expect(agent.tab_id).toBe(w1.tabId);
      expect(layout.panes.find((p: any) => p.pane_id === agent.pane_id).rect.y).toBe(0);
    }
    // 임시 탭이 남지 않는다.
    expect(snap.tabs.filter((t: any) => t.workspace_id === w1.tabId.split(":")[0]).length).toBe(1);
    // 옮긴 뒤에도 이벤트를 받고 글을 넣을 수 있다.
    clear();
    expect(await runner.send(w2, "옮긴 칸 시험 #msg_moved", opts("늦은 총괄"))).toEqual({ ok: true });
    await waitEvent((e) => e.type === "turn_end" && e.memberId === w2.id, "옮긴 칸 turn_end");
  }, 90_000);

  test("글 넣기·상태 전이·turn_end·문맥", async () => {
    const m = await started(runner, newMember("worker", "t1", "p_turn"), opts("턴 시험"));
    await idleNow(runner, m);
    clear();
    const text = "[대표] \"첫 줄\n둘째 줄\" #msg_turn1";
    expect(await runner.send(m, text, opts("턴 시험"))).toEqual({ ok: true });
    expect(runner.isBusy(m.id)).toBe(true);
    await waitEvent(statusIs(m.id, "working"), "working");
    await waitEvent((e) => e.type === "turn_end" && e.memberId === m.id, "turn_end");
    const end = events.find((e) => e.type === "turn_end" && e.memberId === m.id) as Extract<RunnerEvent, { type: "turn_end" }>;
    expect(end.isError).toBe(false);
    expect(end.finalText).toContain("#msg_turn1");
    expect(events.find((e) => e.type === "context" && e.memberId === m.id)).toMatchObject({ pct: 27 });
    // idle 은 turn_end 앞에 와야 Orchestrator 의 waiting 을 덮지 않는다.
    const order = events.filter((e) => e.memberId === m.id).map((e) => e.type === "status" ? e.status : e.type);
    expect(order.indexOf("idle")).toBeLessThan(order.indexOf("turn_end"));
    expect(runner.isBusy(m.id)).toBe(false);
    expect(promptLog().find((p) => p.text.includes("#msg_turn1"))!.text).toBe(text);
    expect(await runner.screen(m)).toContain("#msg_turn1");
  }, 40_000);

  test("일하는 중이면 busy, urgent 면 넣는다", async () => {
    const m = await started(runner, newMember("worker", "t2", "p_busy"), opts("바쁨"));
    await idleNow(runner, m);
    clear();
    expect(await runner.send(m, "SLOW 긴 일 #msg_slow", opts("바쁨"))).toEqual({ ok: true });
    await waitEvent(statusIs(m.id, "working"), "working");
    expect(await runner.send(m, "다음 일 #msg_next", opts("바쁨"))).toMatchObject({ ok: false, reason: "busy", retryable: true });
    expect(promptLog().some((p) => p.text.includes("#msg_next"))).toBe(false);
    expect(await runner.send(m, "급한 일 #msg_urgent", opts("바쁨"), true)).toEqual({ ok: true });
    await waitEvent((e) => e.type === "turn_end" && e.memberId === m.id, "turn_end", 15_000);
  }, 40_000);

  test("입력칸에 남은 글(여러 줄)은 지우는 키 한 번으로 지우고 넣는다. 합쳐지지 않고 세션은 산다", async () => {
    const m = await started(runner, newMember("worker", "t3", "p_input"), opts("입력칸"));
    await idleNow(runner, m);
    await raw("pane.send_text", { pane_id: m.paneId, text: "\x1b[200~내가 치던 글\n둘째 줄\x1b[201~" });
    await screenHas(m.paneId!, "둘째 줄");
    expect(inputLooksEmpty((await raw("pane.read", { pane_id: m.paneId, source: "visible", format: "ansi", strip_ansi: false })).read.text)).toBe(false);
    clear();
    expect(await runner.send(m, "지시 #msg_input", opts("입력칸"))).toEqual({ ok: true });
    await waitEvent((e) => e.type === "turn_end" && e.memberId === m.id, "turn_end");
    expect(promptLog().filter((p) => p.sessionId === m.sessionId).map((p) => p.text)).toEqual(["지시 #msg_input"]);
    expect(keysLog(m.sessionId)).toMatchObject([{ key: "ctrl+c", state: "idle", input: "내가 치던 글\n둘째 줄" }]);
    expect(events.some((e) => e.type === "activity" && e.memberId === m.id && e.text.includes("내가 치던 글"))).toBe(true);
    expect((await raw("agent.get", { target: m.paneId })).agent).toMatchObject({ agent: "claude", agent_session: { value: m.sessionId } });
  }, 40_000);

  test("흐린 다음 말 추천만 있으면 지우는 키 없이 넣고, 추천 위에 친 글은 지우고 넣는다", async () => {
    const m = await started(runner, newMember("worker", "t3g", "p_ghost"), opts("추천"));
    await idleNow(runner, m);
    expect(await runner.send(m, "GHOST 추천 띄우기 #msg_g1", opts("추천"))).toEqual({ ok: true });
    await waitEvent((e) => e.type === "turn_end" && e.memberId === m.id, "turn_end");
    await screenHas(m.paneId!, "다음에 할 말 추천");
    // 글자만 읽으면 친 글과 구분되지 않는다. 글자 모양(흐림)까지 읽어야 빈 칸이다.
    expect(inputLooksEmpty((await raw("pane.read", { pane_id: m.paneId, source: "visible" })).read.text)).toBe(false);
    expect(inputLooksEmpty((await raw("pane.read", { pane_id: m.paneId, source: "visible", format: "ansi", strip_ansi: false })).read.text)).toBe(true);
    clear();
    expect(await runner.send(m, "다음 지시 GHOST #msg_g2", opts("추천"))).toEqual({ ok: true });
    await waitEvent((e) => e.type === "turn_end" && e.memberId === m.id, "turn_end");
    expect(keysLog(m.sessionId)).toEqual([]);
    await screenHas(m.paneId!, "다음에 할 말 추천");

    // 추천 위에 글을 치면 추천은 숨고 친 글만 남는다.
    await raw("pane.send_text", { pane_id: m.paneId, text: "추천 위에 친 글" });
    await screenHas(m.paneId!, "추천 위에 친 글");
    await screenHas(m.paneId!, "다음에 할 말 추천", false);
    clear();
    expect(await runner.send(m, "셋째 지시 #msg_g3", opts("추천"))).toEqual({ ok: true });
    await waitEvent((e) => e.type === "turn_end" && e.memberId === m.id, "turn_end");
    expect(keysLog(m.sessionId).map((k) => k.input)).toEqual(["추천 위에 친 글"]);
    expect(promptLog().filter((p) => p.sessionId === m.sessionId).map((p) => p.text)).toEqual(["GHOST 추천 띄우기 #msg_g1", "다음 지시 GHOST #msg_g2", "셋째 지시 #msg_g3"]);
  }, 40_000);

  test("일하는 중(urgent)에는 남은 글을 지우지 않아 턴을 끊지 않고, 쉬면 지우고 넣는다", async () => {
    const m = await started(runner, newMember("worker", "t3w", "p_inwork"), opts("일 중 입력"));
    await idleNow(runner, m);
    clear();
    expect(await runner.send(m, "SLOW 긴 일 #msg_w1", opts("일 중 입력"))).toEqual({ ok: true });
    await waitEvent(statusIs(m.id, "working"), "working");
    await raw("pane.send_text", { pane_id: m.paneId, text: "일하는 중 친 글" });
    await screenHas(m.paneId!, "일하는 중 친 글");
    expect(await runner.send(m, "급한 일 #msg_w2", opts("일 중 입력"), true)).toMatchObject({ ok: false, reason: "input_busy", detail: expect.stringContaining("일하는 중"), retryable: true });
    expect(keysLog(m.sessionId)).toEqual([]);
    await waitEvent((e) => e.type === "turn_end" && e.memberId === m.id, "turn_end", 15_000);
    const end = events.find((e) => e.type === "turn_end" && e.memberId === m.id) as Extract<RunnerEvent, { type: "turn_end" }>;
    expect(end.finalText).toContain("#msg_w1");
    expect(await runner.screen(m)).not.toContain("Interrupted");
    await idleNow(runner, m);
    expect(await runner.send(m, "급한 일 #msg_w2", opts("일 중 입력"), true)).toEqual({ ok: true });
    expect(keysLog(m.sessionId).map((k) => k.input)).toEqual(["일하는 중 친 글"]);
    await until(() => promptLog().some((p) => p.text === "급한 일 #msg_w2"), 5000, "전달");
    expect(promptLog().some((p) => p.text.includes("일하는 중 친 글"))).toBe(false);
  }, 40_000);

  test("지우는 키를 종료 창 안에 두 번 누르지 않는다: 곧바로 다시 남은 글이 생기면 미뤘다가 간격 뒤에 지운다", async () => {
    const m = await started(runner, newMember("worker", "t3x", "p_gap"), opts("간격"));
    await idleNow(runner, m);
    await raw("pane.send_text", { pane_id: m.paneId, text: "남은 글 하나" });
    await screenHas(m.paneId!, "남은 글 하나");
    // 턴을 만들지 않는 명령으로 곧바로 이어 간다.
    expect(await runner.setParallel(m, true, opts("간격"))).toEqual({ ok: true });
    expect(keysLog(m.sessionId)).toHaveLength(1);
    await raw("pane.send_text", { pane_id: m.paneId, text: "남은 글 둘" });
    await screenHas(m.paneId!, "남은 글 둘");
    expect(await runner.setParallel(m, false, opts("간격"))).toMatchObject({ ok: false, reason: "input_busy", retryable: true });
    expect(keysLog(m.sessionId)).toHaveLength(1);
    expect((await raw("agent.get", { target: m.paneId })).agent.agent).toBe("claude");
    await Bun.sleep(Math.max(0, keysLog(m.sessionId)[0].at + 1600 - Date.now()));
    expect(await runner.setParallel(m, false, opts("간격"))).toEqual({ ok: true });
    const keys = keysLog(m.sessionId);
    expect(keys.map((k) => k.input)).toEqual(["남은 글 하나", "남은 글 둘"]);
    expect(keys[1].at - keys[0].at).toBeGreaterThanOrEqual(1500);
    expect(promptLog().filter((p) => p.sessionId === m.sessionId).map((p) => p.text)).toEqual(["/effort ultracode on", "/effort ultracode off"]);
    expect((await raw("agent.get", { target: m.paneId })).agent).toMatchObject({ agent: "claude", agent_session: { value: m.sessionId } });
  }, 40_000);

  test("가짜 Claude 도 실측처럼 지운 직후 빈 칸에 또 누르면 끝난다(간격을 지키는 이유)", async () => {
    const m = await started(runner, newMember("worker", "t3y", "p_twice"), opts("두 번"));
    await idleNow(runner, m);
    await raw("pane.send_text", { pane_id: m.paneId, text: "남은 글" });
    await screenHas(m.paneId!, "남은 글");
    await raw("agent.send_keys", { target: m.paneId, keys: ["ctrl+c"] });
    await screenHas(m.paneId!, "Press Ctrl-C again to exit");
    await screenHas(m.paneId!, "남은 글", false);
    await Bun.sleep(400);
    await raw("agent.send_keys", { target: m.paneId, keys: ["ctrl+c"] });
    await waitEvent(statusIs(m.id, "gone"), "gone");
    expect(keysLog(m.sessionId)).toHaveLength(2);
  }, 40_000);

  test("승인 창이면 blocked, Escape 로 끊으면 턴이 끝난다", async () => {
    const m = await started(runner, newMember("worker", "t4", "p_block"), opts("승인"));
    await idleNow(runner, m);
    clear();
    expect(await runner.send(m, "BLOCK #msg_block", opts("승인"))).toEqual({ ok: true });
    await waitEvent(statusIs(m.id, "blocked"), "blocked");
    expect(await runner.send(m, "더 #msg_more", opts("승인"))).toMatchObject({ ok: false, reason: "blocked", retryable: true });
    expect((await raw("agent.get", { target: m.paneId })).agent.agent_status).toBe("blocked");
    await expect(raw("agent.prompt", { target: m.paneId, text: "x" })).rejects.toThrow();
    await runner.interrupt(m);
    await waitEvent(statusIs(m.id, "idle"), "idle");
  }, 40_000);

  test("승인 창: 읽고, 대표가 본 창과 같을 때만 번호 키를 누른다", async () => {
    const m = await started(runner, newMember("worker", "t4a", "p_approve"), opts("승인 답"));
    await idleNow(runner, m);
    expect(await runner.approval(m)).toBe(null); // 승인 창 앞이 아니다
    clear();
    expect(await runner.send(m, "BLOCK touch a.txt #msg_ap1", opts("승인 답"))).toEqual({ ok: true });
    await waitEvent(statusIs(m.id, "blocked"), "blocked");
    const a = (await runner.approval(m))!;
    expect(a.title).toBe("Bash command");
    expect(a.body).toContain("BLOCK touch a.txt #msg_ap1");
    expect(a.options.map((o) => [o.n, o.reject])).toEqual([[1, false], [2, false], [3, true]]);
    expect(a.options[1]!.label).toBe("Yes, and don't ask again for touch commands in /tmp/fake");

    // 다른 창을 보고 고른 것이면 누르지 않는다.
    expect(await runner.answerApproval(m, "0".repeat(24), 1)).toMatchObject({ ok: false, reason: "changed", current: { fingerprint: a.fingerprint } });
    expect(await runner.answerApproval(m, a.fingerprint, 7)).toMatchObject({ ok: false, reason: "no_option" });
    const approvals = () => {
      const f = join(h.fakeDir, "approvals.jsonl");
      return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.sessionId === m.sessionId) : [];
    };
    expect(approvals()).toEqual([]);

    // 두 번 눌러도 한 번만 들어간다. 두 번째는 창이 닫혀 있다.
    const [first, second] = await Promise.all([runner.answerApproval(m, a.fingerprint, 1), runner.answerApproval(m, a.fingerprint, 1)]);
    expect(first).toMatchObject({ ok: true, chosen: { n: 1, label: "Yes" } });
    expect(second).toMatchObject({ ok: false });
    expect(approvals().map((x) => x.option)).toEqual([1]);
    await waitEvent((e) => e.type === "turn_end" && e.memberId === m.id && e.finalText.includes("승인 뒤 실행"), "승인 뒤 턴 끝");
    expect(await runner.answerApproval(m, a.fingerprint, 1)).toMatchObject({ ok: false, reason: "not_blocked" });

    // 거절(No): 끊기고 쉰다.
    await idleNow(runner, m);
    clear();
    expect(await runner.send(m, "BLOCK rm -rf out #msg_ap2", opts("승인 답"))).toEqual({ ok: true });
    await waitEvent(statusIs(m.id, "blocked"), "blocked 2");
    const b = (await runner.approval(m))!;
    expect(b.fingerprint).not.toBe(a.fingerprint);
    expect(await runner.answerApproval(m, b.fingerprint, 3)).toMatchObject({ ok: true, chosen: { n: 3, label: "No", reject: true } });
    await waitEvent(statusIs(m.id, "idle"), "거절 뒤 idle");
    expect(approvals().map((x) => x.option)).toEqual([1, 3]);
  }, 60_000);

  test("뒤 작업 기다림: herdr 가 working 이어도 턴을 끝내고 그 사이 온 글은 바로 넣는다. 뒤 작업이 끝나면 스스로 한 턴 하고 쉰다", async () => {
    const m = await started(runner, newMember("worker", "bg1", "p_bg"), opts("뒤 작업"));
    await idleNow(runner, m);
    clear();
    expect(await runner.send(m, "BGWAIT 7000 워크플로 걸기 #msg_bg1", opts("뒤 작업"))).toEqual({ ok: true });
    await waitEvent((e) => e.type === "background" && e.memberId === m.id && e.label === "1 dynamic workflow", "뒤 작업 기다림");
    await waitEvent((e) => e.type === "turn_end" && e.memberId === m.id && e.finalText.includes("워크플로 걸기"), "첫 턴 끝");
    // herdr 는 여전히 working 이라 한다. 그래도 글을 받는다.
    expect((await raw("agent.get", { target: m.paneId })).agent.agent_status).toBe("working");
    expect(runner.isBusy(m.id)).toBe(false);
    expect(events.filter((e) => e.type === "turn_end" && e.memberId === m.id)).toHaveLength(1);

    clear();
    expect(await runner.send(m, "기다리는 동안 온 대표 답 #msg_bg2", opts("뒤 작업"))).toEqual({ ok: true });
    expect(runner.isBusy(m.id)).toBe(true);
    await waitEvent((e) => e.type === "turn_end" && e.memberId === m.id && e.finalText.includes("기다리는 동안 온 대표 답"), "기다리는 중 넣은 글의 턴 끝");
    expect(runner.isBusy(m.id)).toBe(false);
    expect(events.some((e) => e.type === "turn_end" && e.memberId === m.id && e.isError)).toBe(false);
    expect(promptLog().filter((p) => p.sessionId === m.sessionId).map((p) => p.text.split(" #")[0])).toEqual(["BGWAIT 7000 워크플로 걸기", "기다리는 동안 온 대표 답"]);

    // 뒤 작업이 끝나면 알림을 받아 스스로 한 턴 더 하고 쉰다.
    clear();
    await waitEvent((e) => e.type === "background" && e.memberId === m.id && e.label === null, "뒤 작업 끝", 15_000);
    await waitEvent((e) => e.type === "turn_end" && e.memberId === m.id && e.finalText.includes("워크플로 결과"), "스스로 한 턴", 15_000);
    await waitEvent(statusIs(m.id, "idle"), "쉼");
    expect(runner.isBusy(m.id)).toBe(false);
  }, 60_000);

  test("interrupt 는 일을 끊는다", async () => {
    const m = await started(runner, newMember("worker", "t5", "p_int"), opts("끊기"));
    await idleNow(runner, m);
    clear();
    expect(await runner.send(m, "SLOW 끊을 일 #msg_int", opts("끊기"))).toEqual({ ok: true });
    await waitEvent(statusIs(m.id, "working"), "working");
    await runner.interrupt(m);
    await waitEvent((e) => e.type === "turn_end" && e.memberId === m.id, "turn_end");
    expect(await runner.screen(m)).toContain("Interrupted");
  }, 40_000);

  test("setParallel 은 /effort 를 보내고 화면으로 확인하며 턴을 만들지 않는다", async () => {
    const m = await started(runner, newMember("worker", "t6", "p_eff"), opts("병렬"));
    await idleNow(runner, m);
    clear();
    expect(await runner.setParallel(m, true, opts("병렬"))).toEqual({ ok: true });
    expect(await runner.setParallel(m, false, opts("병렬"))).toEqual({ ok: true });
    const sent = promptLog().filter((p) => p.sessionId === m.sessionId).map((p) => p.text);
    expect(sent).toEqual(["/effort ultracode on", "/effort ultracode off"]);
    await Bun.sleep(800);
    expect(events.some((e) => e.type === "turn_end")).toBe(false);
    expect(runner.isBusy(m.id)).toBe(false);
  }, 40_000);

  test("compact 는 compact_boundary 로 끝을 판단하고 turn_end 를 내지 않는다", async () => {
    const m = await started(runner, newMember("worker", "t7", "p_cmp"), opts("압축"));
    await idleNow(runner, m);
    clear();
    expect(await runner.compact(m, "이어갈 일: now\n· next", opts("압축"))).toEqual({ ok: true });
    expect(runner.isBusy(m.id)).toBe(true);
    await waitEvent((e) => e.type === "compacted" && e.memberId === m.id, "compacted");
    expect(promptLog().filter((p) => p.sessionId === m.sessionId).map((p) => p.text)).toEqual(["/compact 이어갈 일: now · next"]);
    expect(events.find((e) => e.type === "context")).toMatchObject({ pct: 0 });
    await Bun.sleep(800);
    expect(events.some((e) => e.type === "turn_end")).toBe(false);
    expect(runner.isBusy(m.id)).toBe(false);
  }, 40_000);

  test("/compact 가 일반 글로 들어가 boundary 가 없으면 오류로 끝낸다", async () => {
    const r = new HerdrRunner({ socketPath: h.socketPath }, { inboxDir: inbox, claudeHome: join(h.dir, "다른곳"), settleMs: 200, compactGraceMs: 800, startTimeoutMs: 25_000 });
    startedRunners.push(r);
    const seen: RunnerEvent[] = [];
    r.on((e) => seen.push(e));
    const m = await started(r, newMember("worker", "t8", "p_cmpfail"), opts("압축 실패"));
    const end = Date.now() + 8000;
    while ((await raw("agent.get", { target: m.paneId })).agent.agent_status === "unknown" && Date.now() < end) await Bun.sleep(50);
    expect(await r.compact(m, "x", opts("압축 실패"))).toEqual({ ok: true });
    await until(() => seen.some((e) => e.type === "turn_end" && e.isError), 10_000, "오류 turn_end");
    expect(seen.some((e) => e.type === "compacted")).toBe(false);
    expect(r.isBusy(m.id)).toBe(false);
  }, 40_000);

  test("1500자 넘는 글은 파일로 두고 첫 줄 접두어와 #id 를 남긴다", async () => {
    const m = await started(runner, newMember("worker", "t9", "p_long"), opts("긴 글"));
    await idleNow(runner, m);
    clear();
    const text = `[대표] "긴 지시"\n${"가".repeat(2000)}\n#msg_long1`;
    expect(await runner.send(m, text, opts("긴 글"))).toEqual({ ok: true });
    await waitEvent((e) => e.type === "turn_end" && e.memberId === m.id, "turn_end");
    const path = join(inbox, m.id, "msg_long1.md");
    expect(readFileSync(path, "utf8")).toBe(text);
    const sent = promptLog().find((p) => p.sessionId === m.sessionId)!.text as string;
    expect(sent.split("\n")[0]).toBe('[대표] "긴 지시"');
    expect(sent).toContain(path);
    expect(sent).toContain("#msg_long1");
    expect(sent.length).toBeLessThan(1500);
  }, 40_000);

  test("다른 프로젝트의 같은 핸들도 띄울 수 있다", async () => {
    const a = await started(runner, newMember("conductor", "same", "p_dup_a"), opts("A"));
    const b = await started(runner, newMember("conductor", "same", "p_dup_b"), opts("B"));
    const agents = await listAgents(h.socketPath);
    const names = [a, b].map((m) => agents.find((x) => x.paneId === m.paneId)!.name);
    expect(names[0]).toBe("same");
    expect(names[1]).toMatch(/^same-[a-z0-9]+$/);
    expect(names[1]!.length).toBeLessThanOrEqual(32);
  }, 40_000);

  test("--resume 실패는 throw 하고 칸을 남기지 않는다", async () => {
    const pid = "p_fail";
    const lead = await started(runner, newMember("conductor", "fl", pid), opts("실패"));
    const before = (await snapshot()).panes.length;
    const m = { ...newMember("worker", "f1", pid), sessionId: "11111111-1111-4111-8111-111111111111" };
    await expect(runner.start(m, opts("실패", { resume: true, herdrTabId: lead.tabId }))).rejects.toThrow("시작하자마자");
    const snap = await snapshot();
    expect(snap.panes.length).toBe(before);
    const layout = snap.layouts.find((l: any) => l.tab_id === lead.tabId);
    expect(layout.panes.length).toBe(1);
    expect(runner.isBusy(m.id)).toBe(false);
  }, 40_000);

  test("재시작 뒤 sessionId 로 다시 붙고 새로 띄우지 않으며 일하던 턴도 잇는다", async () => {
    const m = await started(runner, newMember("worker", "r1", "p_re"), opts("재결합"));
    await idleNow(runner, m);
    expect(await runner.send(m, "SLOW 재시작 넘기기 #msg_re", opts("재결합"))).toEqual({ ok: true });
    await waitEvent(statusIs(m.id, "working"), "working");
    await runner.shutdown();

    const r2 = newRunner();
    const seen: RunnerEvent[] = [];
    r2.on((e) => seen.push(e));
    const argvBefore = argvLog().length;
    // paneId 를 잊어도 sessionId 로 찾는다.
    const res = await r2.start({ ...m, paneId: null }, opts("재결합", { resume: true }));
    expect(res.paneId).toBe(m.paneId);
    expect(res.sessionId).toBe(m.sessionId);
    expect(argvLog().length).toBe(argvBefore);
    expect(seen.some((e) => e.type === "pane" && e.paneId === m.paneId)).toBe(true);
    expect(seen.some((e) => e.type === "status" && e.status === "working")).toBe(true);
    expect(r2.isBusy(m.id)).toBe(true);
    await until(() => seen.some((e) => e.type === "turn_end" && e.memberId === m.id), 12_000, "재결합 뒤 turn_end");
    expect((seen.find((e) => e.type === "turn_end") as any).finalText).toContain("#msg_re");

    // runner 를 새로 만들어 이어 간다.
    runner = r2;
    runner.on((e) => events.push(e));
  }, 60_000);

  test("칸을 모르는 send 도 재결합하고, 없는 세션은 gone", async () => {
    const m = await started(runner, newMember("worker", "r2", "p_lazy"), opts("지연"));
    await idleNow(runner, m);
    const fresh = newRunner();
    expect(await fresh.send(m, "지연 재결합 #msg_lazy", opts("지연"))).toEqual({ ok: true });
    await until(() => promptLog().some((p) => p.text.includes("#msg_lazy")), 5000, "전달");
    await until(() => !runner.isBusy(m.id) && !fresh.isBusy(m.id), 10_000, "idle");
    expect(await fresh.send({ ...m, id: "m_none", paneId: null, sessionId: "없는 세션" }, "x", opts("지연"))).toMatchObject({ ok: false, reason: "gone", retryable: false });
    await fresh.shutdown();
  }, 40_000);

  test("칸이 닫히거나 Claude 가 끝나면 gone. 남은 셸은 건드리지 않고 새 칸을 나눈다", async () => {
    const m = await started(runner, newMember("worker", "g1", "p_gone"), opts("사라짐"));
    await idleNow(runner, m);
    clear();
    await raw("agent.prompt", { target: m.paneId, text: "EXIT" });
    await waitEvent(statusIs(m.id, "gone"), "gone(종료)");
    expect(runner.isBusy(m.id)).toBe(false);
    expect((await snapshot()).panes.some((p: any) => p.pane_id === m.paneId)).toBe(true);

    clear();
    const again = await started(runner, m, opts("사라짐", { resume: true }));
    // 사용자가 그 셸에 무엇을 쳐 두었을지 모른다. agent.start 는 글자를 치는 방식이라 합쳐져 실행된다.
    expect(again.paneId).not.toBe(m.paneId);
    expect((await snapshot()).panes.some((p: any) => p.pane_id === m.paneId)).toBe(true);
    await idleNow(runner, again);

    clear();
    await raw("pane.close", { pane_id: again.paneId });
    await waitEvent(statusIs(m.id, "gone"), "gone(닫힘)");
    expect(await runner.send(again, "x", opts("사라짐"))).toMatchObject({ ok: false, reason: "gone" });
    expect(await runner.screen({ ...again, paneId: null })).toBe("");
  }, 60_000);

  test("마지막 칸을 닫아 워크스페이스가 사라지면 다음 시작 때 새로 만든다", async () => {
    const m = await started(runner, newMember("conductor", "z1", "p_ws"), opts("새 워크스페이스"));
    await runner.stop(m);
    await expect(raw("tab.get", { tab_id: m.tabId })).rejects.toThrow("not found");
    const again = await started(runner, { ...m, paneId: null }, opts("새 워크스페이스", { herdrTabId: m.tabId, resume: true }));
    expect(again.tabId).not.toBe(m.tabId);
    expect(again.sessionId).toBe(m.sessionId);
  }, 40_000);

  const untilAsync = async (check: () => Promise<boolean>, ms: number, label: string) => {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) throw new Error(`시간 초과: ${label}`);
      await Bun.sleep(50);
    }
  };
  // 대표가 자기 탭(칸 둘)에 띄워 쓰던 세션.
  const userSession = async (label: string, name: string, extra: string[] = []) => {
    const w = await raw("workspace.create", { cwd: work, label, focus: false });
    const paneId = (await raw("pane.split", { target_pane_id: w.root_pane.pane_id, direction: "right", cwd: work, focus: false })).pane.pane_id as string;
    const sessionId = crypto.randomUUID();
    await untilAsync(async () => {
      try {
        await raw("agent.start", { name, kind: "claude", pane_id: paneId, args: ["--session-id", sessionId, ...extra], timeout_ms: 8000 });
        return true;
      } catch (e) {
        if (/not an available shell/.test(String(e))) return false;
        throw e;
      }
    }, 15_000, "칸 셸 준비");
    await untilAsync(async () => {
      const { agent } = await raw("agent.get", { target: paneId });
      return (agent.agent_status === "idle" || agent.agent_status === "done") && !agent.launch_pending && agent.agent_session?.value === sessionId;
    }, 15_000, "사용자 세션 준비");
    return { tabId: w.tab.tab_id as string, shellPane: w.root_pane.pane_id as string, paneId, sessionId };
  };
  const layoutOf = async (tabId: string) => JSON.stringify((await raw("layout.export", { tab_id: tabId })).layout.root);
  const screenHas = async (paneId: string, text: string, want = true) =>
    untilAsync(async () => (await raw("pane.read", { pane_id: paneId, source: "visible" })).read.text.includes(text) === want, 5000, `화면 ${text}`);

  test("편입: 칸을 옮기지도 이름을 바꾸지도 않고, 전달·재시작·잠재우기·다시 열기가 그대로 된다", async () => {
    const pid = "p_adopt";
    const u = await userSession("내 탭", "mine");
    const before = await layoutOf(u.tabId);
    const argvBefore = argvLog().length;
    const seen: RunnerEvent[] = [];
    const first = newRunner();
    first.on((e) => seen.push(e));
    const m: RunnerMember = { ...newMember("worker", "adopted", pid, "넘겨받은 직원"), origin: "adopted", sessionId: u.sessionId, paneId: u.paneId };

    const res = await first.adopt(m, u.paneId, opts("넘겨받기"));
    expect(res).toEqual({ sessionId: u.sessionId, paneId: u.paneId, tabId: null });
    expect(argvLog().length).toBe(argvBefore);
    expect(await layoutOf(u.tabId)).toBe(before);
    expect((await listAgents(h.socketPath)).find((a) => a.paneId === u.paneId)).toMatchObject({ name: "mine", tabId: u.tabId, sessionId: u.sessionId });
    expect(seen.some((e) => e.type === "pane" && e.paneId === u.paneId)).toBe(true);
    expect(promptLog().filter((p) => p.sessionId === u.sessionId).map((p) => p.text)).toEqual([`/add-dir ${join(inbox, m.id)}`]);

    // 전달과 턴 끝
    expect(await first.send(m, "규칙 #msg_ad1", opts("넘겨받기"))).toEqual({ ok: true });
    await until(() => seen.some((e) => e.type === "turn_end" && e.memberId === m.id), 10_000, "턴 끝");
    await first.shutdown();

    // 서버 재시작: 이름이 내 것이 아니어도 세션으로 다시 붙고, 이름은 그대로 둔다.
    const second = newRunner();
    const seen2: RunnerEvent[] = [];
    second.on((e) => seen2.push(e));
    expect(await second.reattach(m)).toEqual({ paneId: u.paneId, tabId: u.tabId });
    expect((await raw("agent.get", { target: u.paneId })).agent.name).toBe("mine");
    await untilAsync(async () => (await raw("agent.get", { target: u.paneId })).agent.agent_status !== "working", 5000, "쉼");

    // 대표가 칸을 다른 탭으로 옮기면 번호가 바뀌어도 따라간다.
    const out = await raw("pane.move", { pane_id: u.paneId, focus: false, destination: { type: "new_tab", workspace_id: u.tabId.split(":")[0] } });
    const movedPane = out.move_result.pane.pane_id as string;
    await until(() => seen2.some((e) => e.type === "pane" && e.paneId === movedPane), 8000, "옮긴 칸 따라가기");
    const back = await raw("pane.move", { pane_id: movedPane, focus: false, destination: { type: "tab", tab_id: u.tabId, split: "right", target_pane_id: u.shellPane } });
    const paneNow = back.move_result.pane.pane_id as string;
    await until(() => seen2.some((e) => e.type === "pane" && e.paneId === paneNow), 8000, "돌아온 칸 따라가기");
    const m2 = { ...m, paneId: paneNow };
    const layoutNow = await layoutOf(u.tabId);

    // 입력칸에 남은 글은 막지 않는다. 미리 보기(checkStop)는 읽기만 한다.
    await raw("pane.send_text", { pane_id: paneNow, text: "내가 치던 글" });
    await screenHas(paneNow, "내가 치던 글");
    await second.checkStop(m2);
    await screenHas(paneNow, "내가 치던 글");
    expect(keysLog(u.sessionId)).toEqual([]);
    expect((await raw("agent.get", { target: paneNow })).agent.agent).toBe("claude");

    // 잠재우기: 남은 글을 지우고 /exit 만 넣는다. Claude 만 끝나고 칸은 셸로 남아 탭 구성이 그대로다.
    await second.stop(m2);
    expect(keysLog(u.sessionId).map((k) => k.input)).toEqual(["내가 치던 글"]);
    expect(await layoutOf(u.tabId)).toBe(layoutNow);
    expect((await listAgents(h.socketPath)).some((a) => a.paneId === paneNow && a.agent === "claude")).toBe(false);
    const sentAll = promptLog().filter((p) => p.sessionId === u.sessionId).map((p) => p.text);
    expect(sentAll.at(-1)).toBe("/exit");
    expect(sentAll.some((t) => t.includes("내가 치던 글"))).toBe(false);

    // 다시 열기: 같은 세션을 전체 인자로 서버 쪽 탭에 연다. 대표의 탭에는 칸이 늘지 않는다.
    const reopened = await second.start({ ...m2, paneId: null, origin: "runner" }, opts("넘겨받기", { resume: true }));
    expect(reopened.sessionId).toBe(u.sessionId);
    expect(reopened.tabId).not.toBe(u.tabId);
    const last = argvLog().filter((a) => a.sessionId === u.sessionId).at(-1)!;
    expect(last.args.slice(0, 2)).toEqual(["--resume", u.sessionId]);
    expect(last.args).toContain("--mcp-config");
    expect(await layoutOf(u.tabId)).toBe(layoutNow);
    await second.stop({ ...m2, paneId: reopened.paneId, origin: "runner" });
    await second.shutdown();
  }, 90_000);

  test("편입: 같은 프로젝트의 다음 직원은 대표의 탭에 끼어들지 않는다", async () => {
    const pid = "p_adopt_tab";
    const u = await userSession("내 탭 2", "mine2");
    const before = await layoutOf(u.tabId);
    const r = newRunner();
    const m: RunnerMember = { ...newMember("worker", "ad2", pid, "넘겨받은 둘"), origin: "adopted", sessionId: u.sessionId, paneId: u.paneId };
    await r.adopt(m, u.paneId, opts("탭 시험"));
    // DB 의 탭 번호가 우연히 대표의 탭과 같아도, 넘겨받은 세션은 근거에 넣지 않는다.
    const next = await started(r, newMember("worker", "next2", pid, "다음 직원"), opts("탭 시험", { herdrTabId: u.tabId, projectSessions: [] }));
    expect(next.tabId).not.toBe(u.tabId);
    expect(await layoutOf(u.tabId)).toBe(before);
    await r.stop(next);
    await r.shutdown();
  }, 60_000);

  test("편입: 일하는 중·승인 창 앞이면 거부하고, 끝나면 된다", async () => {
    const u = await userSession("내 탭 3", "mine3");
    const r = newRunner();
    const m: RunnerMember = { ...newMember("worker", "ad3", "p_adopt3", "셋"), origin: "adopted", sessionId: u.sessionId, paneId: u.paneId };
    await raw("agent.prompt", { target: u.paneId, text: "SLOW 내 일" });
    await untilAsync(async () => (await raw("agent.get", { target: u.paneId })).agent.agent_status === "working", 5000, "일");
    await expect(r.adopt(m, u.paneId, opts("거부"))).rejects.toThrow("일하는 중");
    await untilAsync(async () => (await raw("agent.get", { target: u.paneId })).agent.agent_status !== "working", 10_000, "쉼");
    await raw("agent.prompt", { target: u.paneId, text: "BLOCK 승인 창" });
    await untilAsync(async () => (await raw("agent.get", { target: u.paneId })).agent.agent_status === "blocked", 5000, "승인 창");
    await expect(r.adopt(m, u.paneId, opts("거부"))).rejects.toThrow("승인 창");
    await raw("pane.send_keys", { pane_id: u.paneId, keys: ["Escape"] });
    await untilAsync(async () => (await raw("agent.get", { target: u.paneId })).agent.agent_status !== "blocked", 5000, "풀림");
    await untilAsync(async () => ["idle", "done"].includes((await raw("agent.get", { target: u.paneId })).agent.agent_status), 5000, "쉼");
    expect((await r.adopt(m, u.paneId, opts("거부"))).paneId).toBe(u.paneId);
    await r.shutdown();
  }, 60_000);

  test("편입 해제: 칸·세션·이름을 그대로 두고 손을 떼며, 다시 넘겨받을 수 있다", async () => {
    const u = await userSession("내 탭 4", "mine4");
    const before = await layoutOf(u.tabId);
    const r = newRunner();
    const m: RunnerMember = { ...newMember("worker", "ad4", "p_adopt4", "넷"), origin: "adopted", sessionId: u.sessionId, paneId: u.paneId };
    await r.adopt(m, u.paneId, opts("해제"));
    // 남은 글은 지우고 알린다. 합쳐지지 않는다.
    await raw("pane.send_text", { pane_id: u.paneId, text: "쓰던 글" });
    await screenHas(u.paneId, "쓰던 글");
    expect(await r.release(m, "[시스템] 해제 #dl_rel")).toEqual({ notified: true });
    await until(() => promptLog().some((p) => p.text.includes("#dl_rel")), 5000, "해제 알림(남은 글)");
    expect(promptLog().find((p) => p.text.includes("#dl_rel"))!.text).toBe("[시스템] 해제 #dl_rel");
    expect(keysLog(u.sessionId).map((k) => k.input)).toEqual(["쓰던 글"]);
    expect(r.isBusy(m.id)).toBe(false);
    // 알림이 턴을 연다. 끝나야 다시 넘겨받을 수 있다.
    await screenHas(u.paneId, "답변: [시스템] 해제 #dl_rel");
    await untilAsync(async () => ["idle", "done"].includes((await raw("agent.get", { target: u.paneId })).agent.agent_status), 10_000, "쉼");

    await r.adopt(m, u.paneId, opts("해제"));
    expect(await r.release(m, "[시스템] 해제 #dl_rel2")).toEqual({ notified: true });
    await until(() => promptLog().some((p) => p.text.includes("#dl_rel2")), 5000, "해제 알림");
    const a = (await raw("agent.get", { target: u.paneId })).agent;
    expect(a).toMatchObject({ name: "mine4", agent: "claude" });
    expect(a.agent_session.value).toBe(u.sessionId);
    expect(await layoutOf(u.tabId)).toBe(before);
    await r.shutdown();
  }, 60_000);

  test("편입 전 살펴보기: worker-rules 인자·이름·보고 기록을 찾고, 입력칸을 본다", async () => {
    const u = await userSession("내 탭 5", "lead-old", ["--append-system-prompt-file", "/tmp/worker-rules.ME.md"]);
    const live = (await listAgents(h.socketPath)).find((a) => a.paneId === u.paneId)!;
    const seen = await inspectPane(h.socketPath, live, join(h.fakeDir, "claude"));
    expect(seen.inputEmpty).toBe(true);
    expect(seen.screen).toContain("Fake Claude");
    expect(seen.argv.some((x) => x.includes("worker-rules"))).toBe(true);
    expect(seen.traces[0]).toContain("worker-rules");
    expect(conductorTraces({ name: "총괄", argv: [], transcript: '{"name":"SendMessage"}' })).toHaveLength(2);
    expect(conductorTraces({ name: "개발", argv: ["--model", "opus"], transcript: "오케스트라라는 말" })).toEqual([]);
  }, 40_000);

  test("시작 중 승인 창이 떠도 칸을 살려 둔다", async () => {
    const m = newMember("worker", "s1", "p_startblock", "시작승인");
    clear();
    const res = await runner.start(m, opts("시작 승인"));
    await waitEvent(statusIs(m.id, "blocked"), "blocked");
    expect((await raw("agent.get", { target: res.paneId })).agent.agent_status).toBe("blocked");
    await runner.interrupt({ ...m, paneId: res.paneId });
    await waitEvent(statusIs(m.id, "idle"), "idle");
  }, 40_000);

  test("격리 서버 안의 임시 파일만 만들었다", () => {
    expect(readdirSync(inbox, { recursive: true }).some((f) => String(f).endsWith("msg_long1.md"))).toBe(true);
    expect(h.dir.startsWith(realpathSync(tmpdir()))).toBe(true);
  });
});

describe("2차 검수 회귀: 칸 소유·전달(가짜 소켓)", () => {
  const EMPTY = `${"─".repeat(9)}\n❯ \n${"─".repeat(9)}\n`;
  const S = "22222222-2222-4222-8222-222222222222";
  const agent = (over: Record<string, unknown> = {}) => ({ ...mockAgent(), name: "w", agent_session: { value: S }, ...over });

  /** 칸 목록을 시험이 바꿀 수 있는 가짜 소켓. */
  function panes(agents: Array<Record<string, unknown>>, extra: (method: string, params: any) => unknown = () => undefined) {
    const srv = mockServer((method, params) => {
      const x = extra(method, params);
      if (x !== undefined) return x === "NO_ANSWER" ? undefined : x;
      if (method === "session.snapshot") return { snapshot: { version: "0", protocol: 22, agents, panes: [] } };
      if (method === "agent.get") {
        const found = agents.find((a) => a.pane_id === params.target);
        return found ? { agent: found } : new Error("agent_not_found");
      }
      if (method === "pane.read") return { read: { text: EMPTY } };
      if (method === "pane.process_info") return { process_info: { pane_id: params.pane_id, foreground_processes: [{ pid: 1, name: "claude", argv: ["claude", "--resume", S] }] } };
      if (method === "workspace.create") return { tab: { tab_id: "w9:t1" }, root_pane: { pane_id: "w9:p1" } };
      return { type: "ok" };
    });
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: mkdtempSync(join(tmpdir(), "iamceo-inbox-")), claudeHome: "/nonexistent", settleMs: 20, promptTimeoutMs: 150, stallMs: 150 });
    const seen: RunnerEvent[] = [];
    r.on((e) => seen.push(e));
    const closed = () => srv.calls.filter((c) => c.method === "pane.close").map((c) => c.params.pane_id);
    const prompts = () => srv.calls.filter((c) => c.method === "agent.prompt");
    return { srv, r, seen, closed, prompts };
  }

  const TYPED = `${"─".repeat(9)}\n❯ 대표가 치던 글\n${"─".repeat(9)}\n`;
  const SELECT = "Resume session\n❯ 1. 세션 하나\n  2. 세션 둘\nEsc to cancel\n";
  const keyed = (t: { srv: { calls: Array<{ method: string; params: any }> } }) => t.srv.calls.filter((c) => c.method === "agent.send_keys").map((c) => c.params.keys);

  test("넘겨받은 칸이 프로젝트 탭에 있어도 닫지 않는다: 선택 창이면 거부, 남은 글은 지우고 Claude 만 끝낸다", async () => {
    const agents: Array<Record<string, unknown>> = [agent({ pane_id: "w1:p1", tab_id: "w1:t1", name: "mine" })];
    let screen = SELECT;
    const t = panes(agents, (method, params) => {
      if (method === "pane.read") return { read: { text: screen } };
      if (method === "agent.send_keys" && params.keys.includes("ctrl+c")) screen = EMPTY;
      if (method === "agent.prompt" && params.text === "/exit") agents.length = 0;
      return undefined;
    });
    (t.r as unknown as { projectTabs: Map<string, string> }).projectTabs.set("p_x", "w1:t1");
    const m = member({ sessionId: S, paneId: "w1:p1", origin: "adopted" });
    await t.r.reattach(m);
    await expect(t.r.checkStop(m)).rejects.toThrow("입력칸을 찾지 못");
    await expect(t.r.stop(m)).rejects.toThrow("입력칸을 찾지 못");
    expect(t.prompts()).toEqual([]);
    expect(keyed(t)).toEqual([]);
    // 남은 글은 막지 않는다. 미리 보기는 읽기만 하고, 끝낼 때 한 번 지운다.
    screen = TYPED;
    await t.r.checkStop(m);
    expect(keyed(t)).toEqual([]);
    await t.r.stop(m);
    expect(keyed(t)).toEqual([["ctrl+c"]]);
    expect(t.prompts().map((c) => c.params.text)).toEqual(["/exit"]);
    expect(t.closed()).toEqual([]);
    await t.r.shutdown();
    t.srv.stop();
  });

  test("checkStop whileWorking: 일하는 중은 넘기되 선택 창과 승인 창은 거부한다. 남은 글은 막지 않는다", async () => {
    const a = agent({ pane_id: "w1:p1", name: "mine", agent_status: "working" });
    let screen = SELECT;
    const t = panes([a], (method) => (method === "pane.read" ? { read: { text: screen } } : undefined));
    const m = member({ sessionId: S, paneId: "w1:p1", origin: "adopted" });
    await t.r.reattach(m);
    await expect(t.r.checkStop(m, { whileWorking: true })).rejects.toThrow("입력칸을 찾지 못");
    screen = TYPED;
    await t.r.checkStop(m, { whileWorking: true });
    screen = EMPTY;
    await t.r.checkStop(m, { whileWorking: true });
    await expect(t.r.checkStop(m)).rejects.toThrow("일하는 중");
    a.agent_status = "blocked";
    await expect(t.r.checkStop(m, { whileWorking: true })).rejects.toThrow("승인 창");
    expect(keyed(t)).toEqual([]);
    await t.r.shutdown();
    t.srv.stop();
  });

  test("편입 해제: 남은 글은 지우고 알린다. 입력칸을 못 찾으면 알리지 않는다", async () => {
    for (const [first, expected, keys] of [[TYPED, true, 1], [SELECT, false, 0]] as const) {
      let screen: string = first;
      const t = panes([agent({ pane_id: "w1:p1", name: "mine" })], (method, params) => {
        if (method === "pane.read") return { read: { text: screen } };
        if (method === "agent.send_keys" && params.keys.includes("ctrl+c")) screen = EMPTY;
        return undefined;
      });
      const m = member({ sessionId: S, paneId: "w1:p1", origin: "adopted" });
      await t.r.reattach(m);
      expect(await t.r.release(m, "[시스템] 해제 #dl_r")).toEqual({ notified: expected });
      expect(keyed(t)).toHaveLength(keys);
      expect(t.prompts().map((c) => c.params.text)).toEqual(expected ? ["[시스템] 해제 #dl_r"] : []);
      await t.r.shutdown();
      t.srv.stop();
    }
  });

  test("넘겨받은 칸은 이름이 핸들과 같아도 세션이 바뀌면 놓는다", async () => {
    const a = agent({ pane_id: "w1:p1", name: "w" });
    const t = panes([a]);
    const m = member({ sessionId: S, paneId: "w1:p1", origin: "adopted" });
    await t.r.reattach(m);
    a.agent_session = { value: "33333333-3333-4333-8333-333333333333" };
    expect(await t.r.send(m, "서버 지시 #msg_x", OPTS)).toMatchObject({ ok: false, reason: "gone" });
    expect(t.prompts()).toEqual([]);
    expect(t.seen.some((e) => e.type === "status" && e.status === "gone")).toBe(true);
    await t.r.shutdown();
    t.srv.stop();
  });

  test("해제 도중·뒤의 화면 조회는 칸을 다시 묶지 않아 곧바로 다시 넘겨받을 수 있다", async () => {
    // 폴더 허용 확인을 기다리지 않게 이미 허용된 화면으로 둔다.
    const t = panes([agent({ pane_id: "w1:p1", name: "mine" })], (method) => (method === "pane.read" ? { read: { text: `already accessible\n${EMPTY}` } } : undefined));
    const m = member({ sessionId: S, paneId: "w1:p1", origin: "adopted" });
    await t.r.adopt(m, "w1:p1", OPTS);
    const releasing = t.r.release(m, "[시스템] 해제 #dl_x");
    void t.r.screen(m); // 알리는 중의 폴링
    expect(await releasing).toEqual({ notified: true });
    expect(await t.r.screen(m)).toBe("");
    expect(await t.r.send(m, "늦은 지시 #msg_y", OPTS)).toMatchObject({ ok: false, reason: "gone" });
    const next = member({ id: "m_next", sessionId: S, paneId: "w1:p1", origin: "adopted" });
    expect((await t.r.adopt(next, "w1:p1", OPTS)).paneId).toBe("w1:p1");
    t.r.dropMember(next.id);
    const internal = t.r as unknown as { tracks: Map<string, unknown>; byPane: Map<string, string> };
    expect(internal.tracks.size).toBe(0);
    expect(internal.byPane.size).toBe(0);
    await t.r.shutdown();
    t.srv.stop();
  });

  test("대표가 복사한 --resume 칸(이름 없음): 깨우기는 붙지도 새로 띄우지도 않고 오류, stop 은 닫지 않는다", async () => {
    const user = agent({ pane_id: "w3:p1", tab_id: "w3:t1", name: null });
    const t = panes([user]);
    const m = member({ sessionId: S, paneId: null });
    await expect(t.r.start(m, OPTS)).rejects.toThrow("터미널 칸");
    expect(t.srv.calls.some((c) => c.method === "agent.start")).toBe(false);
    await t.r.stop(m);
    expect(t.closed()).toEqual([]);
    expect(await t.r.reattach(m)).toBeNull();
    await t.r.shutdown();
    t.srv.stop();
  });

  test("되살린 칸(이름 없음, 번호가 DB 와 같음)은 내 칸이다. 이름을 다시 주고 잠재우면 닫는다", async () => {
    const restored = agent({ pane_id: "w2:p1", tab_id: "w2:t1", name: null });
    const t = panes([restored]);
    const m = member({ sessionId: S, paneId: "w2:p1" });
    expect(await t.r.reattach(m)).toMatchObject({ paneId: "w2:p1" });
    expect(t.srv.calls.find((c) => c.method === "agent.rename")?.params).toMatchObject({ target: "w2:p1", name: "w" });
    await t.r.stop(m);
    expect(t.closed()).toEqual(["w2:p1"]);
    await t.r.shutdown();
    t.srv.stop();
  });

  test("같은 세션이 두 칸이면 셋째를 띄우지 않고 멈춘다", async () => {
    const t = panes([agent({ pane_id: "w4:p1", name: null }), agent({ pane_id: "w5:p1", name: null })]);
    await expect(t.r.start(member({ sessionId: S, paneId: null }), OPTS)).rejects.toThrow("w4:p1, w5:p1");
    expect(t.srv.calls.some((c) => c.method === "agent.start" || c.method === "workspace.create")).toBe(false);
    await t.r.shutdown();
    t.srv.stop();
  });

  test("일하는 칸의 인자가 모자라도 urgent 로 닫지 않는다", async () => {
    const t = panes([agent({ pane_id: "w1:p1", agent_status: "working" })]);
    const m = member({ sessionId: S, paneId: "w1:p1", origin: "runner" });
    await t.r.reattach(m);
    expect(await t.r.send(m, "급한 일 #msg_u", OPTS, true)).toEqual({ ok: true });
    expect(t.closed()).toEqual([]);
    expect(t.prompts()).toHaveLength(1);
    await t.r.shutdown();
    t.srv.stop();
  });

  test("직원 칸이 사라졌을 때 같은 세션을 연 대표 칸으로 옮겨 가지 않는다. 이름이 맞으면 따라간다", async () => {
    const agents: Array<Record<string, unknown>> = [agent({ pane_id: "w1:p1" })];
    const t = panes(agents);
    const m = member({ sessionId: S, paneId: "w1:p1" });
    await t.r.reattach(m);
    agents.splice(0, 1, agent({ pane_id: "w9:p1", name: "w" }));
    await (t.r as unknown as { resync(): Promise<void> }).resync();
    expect(t.seen.some((e) => e.type === "pane" && e.paneId === "w9:p1")).toBe(true);
    agents.splice(0, 1, agent({ pane_id: "wA:p1", name: null }));
    await (t.r as unknown as { resync(): Promise<void> }).resync();
    expect(t.seen.some((e) => e.type === "status" && e.status === "gone")).toBe(true);
    expect(t.seen.some((e) => e.type === "pane" && e.paneId === "wA:p1")).toBe(false);
    await t.r.shutdown();
    t.srv.stop();
  });

  test("추적 중인 칸에 이름 접두어만 같거나 세션 보고 없는 남의 에이전트가 들어오면 gone 이다", async () => {
    for (const foreign of [{ name: "w-api", agent_session: { value: "33333333-3333-4333-8333-333333333333" } }, { name: "남의세션", agent_session: null }, { name: "w", agent: "codex", agent_session: null }]) {
      const agents: Array<Record<string, unknown>> = [agent({ pane_id: "w1:p1" })];
      const t = panes(agents);
      const m = member({ sessionId: S, paneId: "w1:p1" });
      await t.r.reattach(m);
      agents[0] = agent({ pane_id: "w1:p1", ...foreign });
      expect(await t.r.send(m, "지시 #msg_f", OPTS)).toMatchObject({ ok: false, reason: "gone" });
      expect(t.prompts()).toHaveLength(0);
      expect(t.closed()).toEqual([]);
      await t.r.shutdown();
      t.srv.stop();
    }
  });

  test("이름만 바뀐 세션 교체(/clear)는 그대로 따라간다", async () => {
    const agents: Array<Record<string, unknown>> = [agent({ pane_id: "w1:p1" })];
    const t = panes(agents);
    const m = member({ sessionId: S, paneId: "w1:p1" });
    await t.r.reattach(m);
    const next = "44444444-4444-4444-8444-444444444444";
    agents[0] = agent({ pane_id: "w1:p1", agent_session: { value: next } });
    await (t.r as unknown as { resync(): Promise<void> }).resync();
    expect(t.seen.some((e) => e.type === "session" && e.sessionId === next)).toBe(true);
    expect(t.seen.some((e) => e.type === "status" && e.status === "gone")).toBe(false);
    await t.r.shutdown();
    t.srv.stop();
  });

  test("이미 다른 직원이 쥔 칸에 붙지 않는다", async () => {
    const t = panes([agent({ pane_id: "w7:p2", name: "w" })]);
    const d = member({ id: "m_d", sessionId: S, paneId: "w7:p2" });
    await t.r.reattach(d);
    const c = member({ id: "m_c", handle: "w", sessionId: S, paneId: "w7:p2" });
    expect(await t.r.reattach(c)).toBeNull();
    await t.r.stop(c);
    expect(t.closed()).toEqual([]);
    await t.r.shutdown();
    t.srv.stop();
  });

  test("편입: claude 가 아닌 칸은 건드리기 전에 거부한다", async () => {
    const t = panes([agent({ pane_id: "w2:p1", agent: "codex", name: "cx" })]);
    await expect(t.r.adopt(member({ handle: "cx", sessionId: null, paneId: null }), "w2:p1", OPTS)).rejects.toThrow("Claude 세션만");
    expect(t.srv.calls.some((c) => c.method === "pane.move" || c.method === "agent.rename")).toBe(false);
    await t.r.shutdown();
    t.srv.stop();
  });

  test("agent.prompt 시간 초과 뒤: 쉬는 세션에서만 남은 글을 지우고 다시 넣는다. 일하는 중이거나 입력칸을 못 찾으면 다시 넣지 않는다", async () => {
    const LEFT = `${"─".repeat(9)}\n❯ 반쯤 들어간 지시\n${"─".repeat(9)}\n`;
    for (const [after, status, urgent, expected, keys] of [
      [LEFT, "idle", false, { ok: true }, 1],
      [EMPTY, "idle", false, { ok: true }, 0],
      [LEFT, "done", false, { ok: true }, 1],
      [SELECT, "idle", false, { ok: false, reason: "input_busy", detail: expect.stringContaining("입력칸을 찾지 못") }, 0],
      // urgent 로 일하는 중에 넣다 시간이 넘었다. 지우는 키는 그 턴을 끊고, 넣던 글이 늦게 들어갈 수 있어 빈 칸이어도 다시 넣지 않는다.
      [LEFT, "working", true, { ok: false, reason: "busy", detail: expect.stringContaining("일하는 중"), retryable: true }, 0],
      [EMPTY, "working", true, { ok: false, reason: "busy", detail: expect.stringContaining("일하는 중"), retryable: true }, 0],
    ] as const) {
      let calls = 0;
      let screen = EMPTY;
      const t = panes([agent({ pane_id: "w1:p1", agent_status: status })], (method, params) => {
        if (method === "agent.prompt") {
          if (++calls > 1) return { type: "ok" };
          screen = after;
          return "NO_ANSWER";
        }
        if (method === "agent.send_keys" && params.keys.includes("ctrl+c")) screen = EMPTY;
        if (method === "pane.read") return { read: { text: screen } };
        return undefined;
      });
      const m = member({ sessionId: S, paneId: "w1:p1", origin: "adopted" });
      await t.r.reattach(m);
      expect(await t.r.send(m, "지시 #msg_t", OPTS, urgent)).toMatchObject(expected);
      expect(calls).toBe(expected.ok ? 2 : 1);
      expect(keyed(t)).toHaveLength(keys);
      await t.r.shutdown();
      t.srv.stop();
    }
  });

  test("칸에 넣는 글에는 ESC·DEL·양방향 문자가 없다(prompt·compact 공통 관문)", async () => {
    const t = panes([agent({ pane_id: "w1:p1" })]);
    const m = member({ sessionId: S, paneId: "w1:p1", origin: "adopted" });
    await t.r.reattach(m);
    await t.r.send(m, `일\x1b[201~${"\x7f".repeat(3)}\u202e끝 #msg_c`, OPTS);
    expect(t.prompts()[0]!.params.text).toBe("일[201~끝 #msg_c");
    await t.r.shutdown();
    t.srv.stop();
    const t2 = panes([agent({ pane_id: "w1:p1" })]);
    await t2.r.reattach(m);
    await t2.r.compact(m, `x\x1b[201~\ny`, OPTS);
    expect(t2.prompts()[0]!.params.text).toBe("/compact x[201~ y");
    await t2.r.shutdown();
    t2.srv.stop();
  });

  test("병렬 명령의 working 이 일 글 응답보다 먼저 묻혀도 turn_end 가 난다", async () => {
    const t = panes([agent({ pane_id: "w1:p1" })]);
    const m = member({ sessionId: S, paneId: "w1:p1", origin: "adopted" });
    await t.r.reattach(m);
    const track = (t.r as unknown as { tracks: Map<string, any> }).tracks.get(m.id);
    // /effort 뒤의 무음 창에 들어간 채로 일 글을 넣는다. 무음은 일 글을 넣는 순간 풀린다.
    track.muteUntil = Date.now() + 5000;
    expect(await t.r.send(m, "일 #msg_m", OPTS)).toEqual({ ok: true });
    expect(track.muteUntil).toBe(0);
    expect(track.awaiting).not.toBeNull();
    (t.r as unknown as { applyStatus(t: unknown, s: string): void }).applyStatus(track, "working");
    expect(track.inTurn).toBe(true);
    (t.r as unknown as { applyStatus(t: unknown, s: string): void }).applyStatus(track, "done");
    await until(() => t.seen.some((e) => e.type === "turn_end"), 2000, "turn_end");
    await t.r.shutdown();
    t.srv.stop();
  });

  test("남은 working 이 응답까지 이어져도 awaiting 이 걸려 스톨이 턴을 끝낸다", async () => {
    const agents: Array<Record<string, unknown>> = [agent({ pane_id: "w1:p1" })];
    const t = panes(agents);
    const m = member({ sessionId: S, paneId: "w1:p1", origin: "adopted" });
    await t.r.reattach(m);
    const track = (t.r as unknown as { tracks: Map<string, any> }).tracks.get(m.id);
    const applyStatus = (t.r as unknown as { applyStatus(t: unknown, s: string): void }).applyStatus.bind(t.r);
    // 프롬프트 응답 전에 슬래시 명령의 working 이 와서 그대로 남아 있는 경우: 넣기 직전에 상태를 working 으로 둔다.
    const realPrompt = (t.r as unknown as { prompt(...a: unknown[]): Promise<unknown> }).prompt.bind(t.r);
    (t.r as unknown as { prompt: unknown }).prompt = async (...a: unknown[]) => {
      track.status = "working";
      return realPrompt(...a);
    };
    expect(await t.r.send(m, "일 #msg_n", OPTS)).toEqual({ ok: true });
    expect(track.inTurn).toBe(false);
    expect(track.awaiting).not.toBeNull();
    applyStatus(track, "done");
    await until(() => t.seen.some((e) => e.type === "turn_end"), 3000, "turn_end");
    await t.r.shutdown();
    t.srv.stop();
  });

  test("promptSeen: 세션 기록이나 화면에 표지가 있을 때만 true", async () => {
    const home = mkdtempSync(join(tmpdir(), "iamceo-claude-home-"));
    const dir = join(home, "projects", "x");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${S}.jsonl`), '{"text":"#msg_rec"}\n');
    const srv = mockServer((method) => {
      if (method === "session.snapshot") return { snapshot: { version: "0", protocol: 22, agents: [agent({ pane_id: "w1:p1" })], panes: [] } };
      if (method === "pane.read") return { read: { text: "화면 #msg_scr" } };
      return { type: "ok" };
    });
    const r = new HerdrRunner({ socketPath: srv.path }, { inboxDir: "/x", claudeHome: home });
    const m = member({ sessionId: S, paneId: "w1:p1" });
    expect(await r.promptSeen(m, ["#msg_rec"])).toBe(true);
    expect(await r.promptSeen(m, ["#msg_scr"])).toBe(true);
    expect(await r.promptSeen(m, ["#msg_none"])).toBe(false);
    expect(r.sessionExists(m)).toBe(true);
    expect(r.sessionExists(member({ sessionId: "55555555-5555-4555-8555-555555555555" }))).toBe(false);
    await r.shutdown();
    srv.stop();
  });
});
