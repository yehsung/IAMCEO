// 1차 작업(서버): 폴더 신뢰 창 자동 답과 막힘의 까닭(blockedCode), 실행 엔진 상태(engine).
// 실제 core·CLI 는 쓰지 않는다. core 의 소켓 약속만 흉내 낸 가짜 서버에 실제 CoreRunner 와 Orchestrator 를 붙인다.
import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { Bus } from "../server/bus.ts";
import { CORE_VERSION, loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer } from "../server/http.ts";
import { Orchestrator, type OrchestratorTimings } from "../server/orchestrator.ts";
import { claudeFolderTrust, codexFolderTrust, looksLikeFolderTrust } from "../server/runner/core-approval.ts";
import { CoreRunner, trustDialogLike, type CoreRunnerDeps } from "../server/runner/core.ts";
import type { CoreTerminal } from "../server/runner/core-client.ts";
import { Store } from "../server/store.ts";
import type { Bootstrap, EngineStatus, SyncSnapshot, WsEvent } from "../shared/types.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(what: string, check: () => boolean, tries = 300) {
  for (let i = 0; i < tries && !check(); i++) await Bun.sleep(10);
  if (!check()) throw new Error(`시간 초과: ${what}`);
}

const composer = `output\n${"─".repeat(30)}\n❯ \n${"─".repeat(30)}\n`;
const claudeTrust = (cwd: string, selected = 0) => ` Accessing workspace:\n ${cwd}\n Quick safety check: Is this a project you created or one you trust?\n ${selected === 0 ? "❯" : " "} No, exit\n ${selected === 1 ? "❯" : " "} Yes, I trust this folder\n Enter to confirm · Esc to cancel\n`;
const codexTrust = (cwd: string) => `  Folder access\n  ${cwd}\n  Trust this folder? Codex can read, edit, and run files here. Your trust decision will be saved.\n› 1. Trust and continue\n  2. Quit\n  enter continue · esc quit\n`;
/** 글자가 달라진 다음 버전의 창을 가정한 화면. 실측이 아니므로 해석기는 읽지 못해야 한다. */
const changedTrust = (cwd: string) => ` Workspace access\n ${cwd}\n Do you trust the files in this folder?\n ❯ 1. Yes, proceed\n   2. No, exit\n Enter to confirm · Esc to cancel\n`;

/** Claude Code 2.1.322 에서 본 창(2026-11-11). 입력 칸이 없고, 선택지 위에 설명 두 줄과 Security guide 줄이 있다. */
const claudeTrust322 = (cwd: string, question = "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.") =>
  `\n Accessing workspace:\n\n ${cwd}\n\n ${question}\n\n Claude Code'll be able to read, edit, and execute files here.\n\n Security guide\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n`;
/** 정상 화면: 글에 trust 와 folder·workspace 가 있어도 입력 칸이 보이면 폴더 신뢰 창이 아니다. */
const claudeBanner = ` ▐▛███▜▌   Claude Code v2.1.322\n▝▜█████▛▘  Fable 5.2 · Claude Max\n  ▘▘ ▝▝    /Users/me/workspace/trust-api\n\n${"─".repeat(30)}\n❯ \n${"─".repeat(30)}\n  ? for shortcuts\n`;
const claudeResumed = (last: string) => `❯ 폴더 신뢰 창 해석기를 고쳐 주세요\n\n⏺ ${last}\n\n${"─".repeat(30)}\n❯ \n${"─".repeat(30)}\n  ? for shortcuts\n`;
const codexBanner = `╭──────────────────────────────────────────────╮\n│ >_ OpenAI Codex (v0.166.0)                   │\n│                                              │\n│ model:     gpt-6-astra high   /model to change │\n│ directory: ~/workspace/trust-api             │\n╰──────────────────────────────────────────────╯\n\n  To get started, describe a task or try one of these commands:\n\n› Ask Codex to do anything\n\n  ? for shortcuts\n`;

interface Options { screen?: string; reported?: boolean; version?: string; timings?: Partial<OrchestratorTimings>; deps?: Partial<CoreRunnerDeps> }
async function fixture(options: Options = {}) {
  const isolated = createIsolatedRuntime();
  const config = loadConfig({ IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: isolated.socketPath,
    IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin });
  const db = openDb(config.dbPath), bus = new Bus(), store = new Store(db, bus);
  store.patchSettings({ boardTidyHours: 0, notifyMac: true });
  const state = { screen: options.screen ?? composer, reported: options.reported ?? false, version: options.version ?? CORE_VERSION, helloFails: false };
  const keys: string[][] = [];
  const terminals = new Map<string, CoreTerminal>();
  const sockets = new Set<Socket>();
  let onKeys: ((terminal: CoreTerminal, pressed: string[]) => void) | null = null;
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const req = JSON.parse(buffer.slice(0, end)) as { id: string; method: string; params: Record<string, any> }; buffer = buffer.slice(end + 1);
        const terminal = terminals.get(req.params.terminal);
        let result: unknown;
        switch (req.method) {
          case "hello": if (!state.helloFails) result = { generation: 1, version: state.version, methods: ["terminal.run", "terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.interrupt", "terminal.kill", "terminal.keys"], features: [] }; break;
          case "terminal.list": result = { terminals: [...terminals.values()] }; break;
          case "terminal.run": {
            const t: CoreTerminal = { address: `t${terminals.size + 1}`, cwd: req.params.cwd, argv: req.params.argv, labels: req.params.labels, state: "live", turn: 0, ...(state.reported ? { status: { state: "idle" } } : {}) };
            terminals.set(t.address, t); result = t; break;
          }
          case "terminal.get": result = terminal; break;
          case "terminal.read": result = { text: state.screen }; break;
          case "terminal.keys": if (terminal) { keys.push(req.params.keys); onKeys?.(terminal, req.params.keys); result = { status: "blocked", turn: 0 }; } break;
          case "terminal.send": result = { started: false, turn: terminal?.turn ?? 0 }; break;
          case "terminal.kill": if (terminal) { terminal.state = "finished"; result = terminal; } break;
        }
        socket.write(JSON.stringify(result === undefined ? { jsonrpc: "2.0", id: req.id, error: { message: "missing", data: { kind: "not_found" } } } : { jsonrpc: "2.0", id: req.id, result }) + "\n");
      }
    });
  });
  await new Promise<void>(resolve => server.listen(isolated.socketPath, resolve));
  const running: Orchestrator[] = [];
  /** 같은 DB·같은 엔진에 서버 한 벌(실행기와 조율기)을 붙인다. 알림은 벌마다 따로 모은다. */
  function boot() {
    const runner = new CoreRunner(isolated.runnerOptions(isolated.providerHomes), { recoveryStore: store, pollMs: 20, rpcTimeoutMs: 500, sendTimeoutMs: 500, ...options.deps });
    const notices: { title: string; body: string }[] = [];
    const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), notifier: (title, body) => { notices.push({ title, body }); },
      timings: { tickMs: 60_000, healthMs: 60_000, retryMs: 5, ...options.timings } });
    running.push(orch);
    const supervise = () => (orch as unknown as { coreSupervisor: { tick(): Promise<void> } }).coreSupervisor.tick();
    return { orch, runner, notices, supervise };
  }
  const first = boot();
  const events: WsEvent[] = [];
  const unsubscribe = bus.subscribe(event => { events.push(event); });
  cleanups.push(async () => {
    unsubscribe();
    for (const orch of running.splice(0)) await orch.shutdown();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close(); await isolated.stop();
  });
  /** 서버를 다시 띄운다: 앞의 한 벌을 내리고, 터미널은 엔진에 그대로 둔 채 새 한 벌이 명부를 복구한다. */
  async function restart() {
    for (const orch of running.splice(0)) await orch.shutdown();
    const next = boot();
    await next.orch.recover();
    await next.supervise();
    return next;
  }
  return { isolated, config, db, bus, store, ...first, state, keys, terminals, events, restart, cwd: isolated.paths.work,
    onKeys(fn: typeof onKeys) { onKeys = fn; } };
}

/** '신뢰'를 누르면 CLI 가 넘어가 준비를 알리는 것까지 흉내 낸다. */
function proceedOnEnter(f: Awaited<ReturnType<typeof fixture>>) {
  f.onKeys((terminal, pressed) => { if (pressed.at(-1) === "enter") { f.state.screen = composer; terminal.status = { state: "idle" }; } });
}

describe("폴더 신뢰 창", () => {
  for (const cli of ["claude", "codex"] as const) test(`${cli}: 프로젝트를 만들 때 신뢰한다고 답했으면, 정확히 알아본 창에서 '신뢰'를 고른다`, async () => {
    const f = await fixture();
    f.state.screen = cli === "claude" ? claudeTrust(f.cwd) : codexTrust(f.cwd);
    proceedOnEnter(f);
    const project = await f.orch.createProject({ name: "신뢰한 폴더", cwd: f.cwd, trustFolder: true, chiefCli: cli });
    const member = await f.orch.createMember(project.id, { name: "결제 연동", cli });
    await until("신뢰 선택", () => f.keys.length === 1);
    // Claude 는 '아니오'가 먼저 골라져 있어 한 칸 내려 확정하고, Codex 는 첫 줄이 '신뢰'라 바로 확정한다.
    expect(f.keys).toEqual([cli === "claude" ? ["down", "enter"] : ["enter"]]);
    await until("준비", () => f.store.requireMember(member.id).status !== "blocked");
    const picked = cli === "claude" ? "Yes, I trust this folder" : "Trust and continue";
    expect(f.store.listActivity(member.id).map(a => a.text)).toContainEqual(expect.stringContaining(`폴더 신뢰 확인 창에서 '${picked}' 을 골랐습니다`));
    expect(f.store.requireMember(member.id).blockedCode).toBeUndefined();
    // 스스로 답한 창을 두고 대표에게 승인 대기라고 알리지 않는다.
    expect(f.notices).toEqual([]);
    await Bun.sleep(80);
    expect(f.keys).toHaveLength(1);
  });

  test("신뢰한다고 답한 적 없는 프로젝트의 창은 누르지 않고 대표에게 묻는다", async () => {
    const f = await fixture({ screen: "" });
    f.state.screen = claudeTrust(f.cwd);
    const project = await f.orch.createProject({ name: "묻지 않은 폴더", cwd: f.cwd });
    const member = await f.orch.createMember(project.id, { name: "결제 연동" });
    await until("막힘", () => f.store.requireMember(member.id).blockedReason === "setup");
    await until("알림", () => f.notices.length > 0);
    expect(f.keys).toEqual([]);
    expect(f.store.requireMember(member.id)).toMatchObject({ status: "blocked", blockedReason: "setup" });
    expect(f.store.requireMember(member.id).blockedCode).toBeUndefined();
    expect(f.notices[0]!.title).toContain("승인 대기");
    // 대표가 결재함에서 답하는 기존 길은 그대로다.
    const prompt = await f.orch.memberApproval(member.id);
    expect(prompt?.options.map(o => o.label)).toEqual(["No, exit", "Yes, I trust this folder"]);
    await f.orch.answerApproval(member.id, { fingerprint: prompt!.fingerprint, option: 2 });
    expect(f.keys).toEqual([["down", "enter"]]);
  });

  test("신뢰한 폴더라도 다른 폴더의 창이나 글자가 달라진 창은 누르지 않고, 터미널에서 답하라고 알린다", async () => {
    for (const screen of [(cwd: string) => claudeTrust(`${cwd}/other`), changedTrust, (cwd: string) => claudeTrust(cwd).replace("Yes, I trust this folder", "Yes, trust and remember")]) {
      const f = await fixture();
      f.state.screen = screen(f.cwd);
      const project = await f.orch.createProject({ name: "신뢰한 폴더", cwd: f.cwd, trustFolder: true });
      const member = await f.orch.createMember(project.id, { name: "결제 연동" });
      await until("막힘의 까닭", () => f.store.requireMember(member.id).blockedCode === "trust_dialog_unrecognized");
      const blocked = f.store.requireMember(member.id);
      // 승인 창으로 단정하지 않는다: 사유는 그대로 '확인 불가'이고, 까닭만 따로 싣는다.
      expect(blocked).toMatchObject({ status: "blocked", blockedReason: "status_unknown", blockedCode: "trust_dialog_unrecognized" });
      expect(f.store.projectState(project.id).members.find(m => m.id === member.id)?.blockedCode).toBe("trust_dialog_unrecognized");
      await until("알림", () => f.notices.some(n => n.title.includes("확인 필요")));
      expect(f.notices.find(n => n.title.includes("확인 필요"))!.body).toBe("폴더 신뢰 확인 창을 읽지 못했습니다. 터미널을 열어 직접 답해 주세요");
      expect(await f.orch.memberApproval(member.id)).toBeNull();
      await Bun.sleep(60);
      expect(f.keys).toEqual([]);
      // 대표가 터미널에서 풀면 막힘과 까닭이 같이 사라진다.
      f.state.screen = composer;
      f.terminals.get(blocked.paneId!)!.status = { state: "idle" };
      await until("풀림", () => f.store.requireMember(member.id).status !== "blocked");
      expect(f.store.requireMember(member.id).blockedCode).toBeUndefined();
    }
  });

  test("폴더가 바뀐 프로젝트는 예전 답으로 누르지 않는다", async () => {
    const f = await fixture();
    const project = await f.orch.createProject({ name: "옮긴 폴더", cwd: f.cwd, trustFolder: true });
    expect(f.store.projectFolderTrusted(project.id, f.cwd)).toBe(true);
    expect(f.store.projectFolderTrusted(project.id, f.isolated.paths.home)).toBe(false);
    f.store.patchProject(project.id, { cwd: f.isolated.paths.home });
    f.state.screen = claudeTrust(f.isolated.paths.home);
    const member = await f.orch.createMember(project.id, { name: "결제 연동" });
    await until("막힘", () => f.store.requireMember(member.id).blockedReason === "setup");
    await Bun.sleep(60);
    expect(f.keys).toEqual([]);
  });

  test("안내용 감지는 넓게 보되 선택지를 만들지 않는다", () => {
    const cwd = "/tmp/project";
    const unknownMenu = "Do you trust the contents of this directory?\n ❯ 1. Yes\n   2. No";
    for (const screen of [claudeTrust(cwd), claudeTrust(cwd, 1), claudeTrust322(cwd), codexTrust(cwd), changedTrust(cwd), claudeTrust(`${cwd}/other`), `\x1b[1m${claudeTrust(cwd)}`, unknownMenu, ` │ Do you trust the files in this folder? │\n │ ❯ 1. Yes │\n │   2. No  │`]) {
      expect([screen, looksLikeFolderTrust(screen)]).toEqual([screen, true]);
      for (const cli of ["claude", "codex"] as const) expect([cli, screen, trustDialogLike(screen, cli)]).toEqual([cli, screen, true]);
    }
    for (const screen of ["", composer, "Loading…", " Bash command\n rm -rf build\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel", "Select login method:\n ❯ 1. Claude account\n   2. API key",
      // 고르는 줄이 없으면 창이 아니다: 글만으로는 배너·대화와 구분되지 않는다.
      "Do you trust the contents of this directory?\n  1. Yes\n  2. No"]) {
      expect([screen, looksLikeFolderTrust(screen)]).toEqual([screen, false]);
    }
    // 누르는 쪽은 예전처럼 엄격하다.
    expect(claudeFolderTrust(changedTrust(cwd), cwd)).toBeNull();
    expect(codexFolderTrust(changedTrust(cwd), cwd)).toBeNull();
    expect(claudeFolderTrust(claudeTrust(`${cwd}/other`), cwd)).toBeNull();
    expect(claudeFolderTrust(claudeTrust(cwd), cwd)?.prompt.options.map(o => [o.n, o.label, o.reject])).toEqual([[1, "No, exit", true], [2, "Yes, I trust this folder", false]]);
  });

  test("입력 칸이 보이는 정상 화면은 글에 trust 가 있어도 폴더 신뢰 창으로 보지 않는다", () => {
    // 리뷰가 든 세 가지: Codex 시작 배너의 directory 줄, 경로에 trust 가 든 Claude 배너, 다시 그려진 대화의 끝줄.
    expect(trustDialogLike(codexBanner, "codex")).toBe(false);
    expect(trustDialogLike(claudeBanner, "claude")).toBe(false);
    for (const last of ["I updated the folder trust dialog parser", "This is a zero-trust project", "I trust these files"]) {
      expect([last, trustDialogLike(claudeResumed(last), "claude")]).toEqual([last, false]);
      expect([last, trustDialogLike(`› fix the parser\n\n• ${last}\n\n› Ask Codex to do anything\n\n  ? for shortcuts\n`, "codex")]).toEqual([last, false]);
    }
    // 입력 칸이 그려지기 전의 같은 글도, 고르는 줄이 없으니 창이 아니다.
    for (const screen of [codexBanner.split("\n› ")[0]!, claudeBanner.split("\n─")[0]!, "⏺ I updated the folder trust dialog parser", "❯ 폴더 신뢰 창을 고쳐 주세요 (folder trust dialog)"]) {
      expect([screen, looksLikeFolderTrust(screen)]).toEqual([screen, false]);
    }
    // 고르는 줄은 화면 끝에 있어야 한다: 한참 위의 대화 줄은 선택지가 아니다.
    expect(looksLikeFolderTrust(`⏺ the folder trust dialog\n❯ 다음 지시\n${Array.from({ length: 12 }, (_, i) => `⏺ 결과 ${i}`).join("\n")}`)).toBe(false);
    // 실제 창에는 입력 칸이 없어 그대로 창으로 읽힌다.
    expect(trustDialogLike(claudeTrust322("/tmp/project"), "claude")).toBe(true);
    expect(trustDialogLike(codexTrust("/tmp/project"), "codex")).toBe(true);
  });

  test("Claude Code 2.1.322 의 창(설명 두 줄과 Security guide 줄 포함)을 정확 해석기가 읽는다", () => {
    const cwd = "/Users/me/work/new-project";
    const read = claudeFolderTrust(claudeTrust322(cwd), cwd);
    expect(read?.selected).toBe(0);
    expect(read?.prompt).toMatchObject({ title: "폴더 신뢰 확인", body: expect.stringContaining(`${cwd}\n`), question: "Is this a project you created or one you trust?" });
    expect(read?.prompt.options.map(o => [o.n, o.label, o.reject])).toEqual([[1, "No, exit", true], [2, "Yes, I trust this folder", false]]);
    // 좁은 칸에서 긴 질문이 여러 줄로 접혀도 같다.
    const wrapped = claudeTrust322(cwd, "Quick safety check: Is this a project you created or one you trust? (Like your own code, a\n well-known open source project, or work from your team). If not, take a moment to review what's in\n this folder first.");
    expect(claudeFolderTrust(wrapped, cwd)?.prompt.options.map(o => o.label)).toEqual(["No, exit", "Yes, I trust this folder"]);
    // 다른 폴더의 창, 선택지가 달라진 창은 여전히 읽지 않는다.
    expect(claudeFolderTrust(claudeTrust322(`${cwd}/other`), cwd)).toBeNull();
    expect(claudeFolderTrust(claudeTrust322(cwd).replace("Yes, I trust this folder", "Yes, trust and remember"), cwd)).toBeNull();
  });

  test("Claude Code 2.1.322 의 창에서도 신뢰한 폴더면 '신뢰'를 고른다", async () => {
    const f = await fixture();
    f.state.screen = claudeTrust322(f.cwd);
    proceedOnEnter(f);
    const project = await f.orch.createProject({ name: "신뢰한 폴더", cwd: f.cwd, trustFolder: true });
    const member = await f.orch.createMember(project.id, { name: "결제 연동" });
    await until("신뢰 선택", () => f.keys.length === 1);
    expect(f.keys).toEqual([["down", "enter"]]);
    await until("준비", () => f.store.requireMember(member.id).status !== "blocked");
    expect(f.notices).toEqual([]);
  });

  test("막 띄운 정상 화면에 trust 라는 글이 있어도 폴더 신뢰 안내를 내지 않고, 오래 준비를 못 알리면 '시작 지연'으로 알린다", async () => {
    const f = await fixture({ screen: claudeBanner, deps: { startNotReadyMs: 80 } });
    const project = await f.orch.createProject({ name: "trust-api", cwd: f.cwd });
    const member = await f.orch.createMember(project.id, { name: "결제 연동" });
    await until("첫 관측", () => f.store.requireMember(member.id).status === "blocked");
    expect(f.store.requireMember(member.id).blockedCode).not.toBe("trust_dialog_unrecognized");
    await until("막힘의 까닭", () => f.store.requireMember(member.id).blockedCode === "start_not_ready");
    await until("알림", () => f.notices.some(n => n.title.includes("시작 지연")));
    await Bun.sleep(60);
    expect(f.notices.filter(n => n.title.includes("확인 필요") || n.body.includes("폴더 신뢰"))).toEqual([]);
    expect(f.store.listActivity(member.id).map(a => a.text).filter(text => text.includes("폴더 신뢰"))).toEqual([]);
  });
});

describe("준비를 알리지 않는 막힘", () => {
  test("띄운 뒤 정해진 시간 넘게 준비를 알리지 않으면 까닭을 싣고 '시작이 늦어지고 있습니다'로 알린다", async () => {
    const f = await fixture({ screen: "Resuming session…", deps: { startNotReadyMs: 60 } });
    const project = await f.orch.createProject({ name: "늦는 시작", cwd: f.cwd });
    const member = await f.orch.createMember(project.id, { name: "결제 연동" });
    await until("막힘의 까닭", () => f.store.requireMember(member.id).blockedCode === "start_not_ready");
    expect(f.store.requireMember(member.id)).toMatchObject({ status: "blocked", blockedReason: "status_unknown" });
    await until("알림", () => f.notices.some(n => n.title.includes("시작 지연")));
    const notice = f.notices.find(n => n.title.includes("시작 지연"))!;
    expect(notice.body).toStartWith("시작이 늦어지고 있습니다");
    expect(notice.body).not.toContain("승인 창");
    expect(f.keys).toEqual([]);
    // 준비 신호가 오면 풀린다.
    f.state.screen = composer;
    f.terminals.get(f.store.requireMember(member.id).paneId!)!.status = { state: "idle" };
    await until("풀림", () => f.store.requireMember(member.id).status !== "blocked");
    expect(f.store.requireMember(member.id).blockedCode).toBeUndefined();
  });

  test("보낼 말이 준비를 기다리다 한도를 넘긴 경우에도 승인 창이라고 알리지 않는다", async () => {
    const f = await fixture({ screen: "Resuming session…", timings: { inputBusyLimitMs: 40 }, deps: { startNotReadyMs: 60 * 60_000 } });
    const project = await f.orch.createProject({ name: "늦는 시작", cwd: f.cwd });
    const member = await f.orch.createMember(project.id, { name: "결제 연동" });
    await until("첫 관측", () => f.store.requireMember(member.id).status === "blocked");
    await until("첫 알림", () => f.notices.length > 0);
    // 깨운 직후처럼 명부의 상태가 대기로 돌아간 채 CLI 만 준비를 알리지 않는 경우다.
    f.notices.length = 0;
    f.store.patchMember(member.id, { status: "idle" });
    f.store.enqueue({ projectId: project.id, memberId: member.id, kind: "system", text: "한 번만 전달", wake: true });
    await f.orch.pump(member.id);
    await until("막힘의 까닭", () => f.store.requireMember(member.id).blockedCode === "start_not_ready");
    await until("알림", () => f.notices.length > 0);
    expect(f.notices.map(n => n.title)).toEqual([expect.stringContaining("시작 지연")]);
    expect(f.notices[0]!.body).toStartWith("시작이 늦어지고 있습니다");
  });

  test("이미 막혀 있던 팀장은 서버를 다시 띄워도 같은 까닭으로 다시 알리지 않는다", async () => {
    const f = await fixture({ screen: "Resuming session…", deps: { startNotReadyMs: 60 } });
    const project = await f.orch.createProject({ name: "늦는 시작", cwd: f.cwd });
    const member = await f.orch.createMember(project.id, { name: "결제 연동" });
    await until("막힘의 까닭", () => f.store.requireMember(member.id).blockedCode === "start_not_ready");
    await until("알림", () => f.notices.some(n => n.title.includes("시작 지연")));

    for (let round = 0; round < 2; round++) {
      const next = await f.restart();
      await until("다시 붙은 뒤 첫 관측", () => next.runner.observationState(member.id)?.setupError?.code === "start_not_ready");
      await Bun.sleep(100);
      expect(f.store.requireMember(member.id)).toMatchObject({ status: "blocked", blockedCode: "start_not_ready" });
      expect(next.notices).toEqual([]);
      if (round === 0) continue;
      // 처음 보는 까닭이 붙으면 한 번 알리고, 까닭이 오가도 다시 알리지 않는다.
      f.state.screen = changedTrust(f.cwd);
      await until("새 까닭", () => f.store.requireMember(member.id).blockedCode === "trust_dialog_unrecognized");
      await until("새 까닭 알림", () => next.notices.length === 1);
      expect(next.notices[0]!.title).toContain("확인 필요");
      f.state.screen = "Resuming session…";
      await until("되돌아온 까닭", () => f.store.requireMember(member.id).blockedCode === "start_not_ready");
      f.state.screen = changedTrust(f.cwd);
      await until("다시 같은 까닭", () => f.store.requireMember(member.id).blockedCode === "trust_dialog_unrecognized");
      await Bun.sleep(100);
      expect(next.notices).toHaveLength(1);
    }
  });

  test("까닭 없이 막혀 있던 팀장도 서버를 다시 띄울 때 다시 알리지 않는다", async () => {
    const f = await fixture({ screen: "" });
    f.state.screen = claudeTrust(f.cwd);
    const project = await f.orch.createProject({ name: "묻지 않은 폴더", cwd: f.cwd });
    const member = await f.orch.createMember(project.id, { name: "결제 연동" });
    await until("막힘", () => f.store.requireMember(member.id).blockedReason === "setup");
    await until("알림", () => f.notices.length === 1);
    const next = await f.restart();
    await until("다시 붙은 뒤 첫 관측", () => next.runner.observationState(member.id)?.setupError?.code === "folder_trust");
    await Bun.sleep(100);
    expect(f.store.requireMember(member.id)).toMatchObject({ status: "blocked", blockedReason: "setup" });
    expect(next.notices).toEqual([]);
  });
});

describe("실행 엔진 상태", () => {
  test("고정 버전과 같으면 ok, 다르면 version_mismatch 로 내보내고 화면이 다시 읽게 알린다", async () => {
    const f = await fixture({ reported: true });
    expect(f.orch.engineStatus()).toBeNull();
    await f.supervise();
    expect(f.orch.engineStatus()).toEqual({ state: "ok", version: CORE_VERSION, expectedVersion: CORE_VERSION });

    // 떠 있는 엔진이 다른 버전으로 바뀐 경우.
    f.state.version = "hc 9.9.9";
    const before = f.events.length;
    await f.supervise();
    const mismatch: EngineStatus = { state: "version_mismatch", version: "9.9.9", expectedVersion: CORE_VERSION };
    expect(f.orch.engineStatus()).toEqual(mismatch);
    expect(f.events.slice(before).map(e => e.type)).toContain("projects");
    // 같은 상태가 이어지면 다시 알리지 않는다.
    const quiet = f.events.length;
    await f.supervise();
    expect(f.events.slice(quiet).map(e => e.type)).not.toContain("projects");

    let server = await startServer({ config: f.config, store: f.store, bus: f.bus, orch: f.orch, delivery: f.orch.deliveryRecovery, detectHosts: () => [],
      daemon: () => ({ ready: true, version: "0.0.0", buildId: "b".repeat(64) }) });
    while (server.port === 7878) { await server.stop(); server = await startServer({ config: f.config, store: f.store, bus: f.bus, orch: f.orch, detectHosts: () => [], daemon: () => ({ ready: true, version: "0.0.0", buildId: "b".repeat(64) }) }); }
    cleanups.push(async () => { await server.stop(); });
    const get = async <T>(path: string) => (await (await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { Authorization: `Bearer ${f.config.accessCode}` } })).json()) as T;
    expect((await get<Bootstrap>("/api/bootstrap")).engine).toEqual(mismatch);
    expect((await get<SyncSnapshot>("/api/sync")).bootstrap.engine).toEqual(mismatch);
    expect((await get<{ engine?: EngineStatus; core: unknown }>("/api/readiness")).engine).toEqual(mismatch);
  });

  test("엔진이 정해진 시간 넘게 답하지 않으면 unresponsive, 돌아오면 ok", async () => {
    const f = await fixture({ reported: true, timings: { engineUnresponsiveMs: 60 } });
    await f.supervise();
    expect(f.orch.engineStatus()?.state).toBe("ok");
    f.state.helloFails = true;
    await f.supervise();
    // 잠깐의 끊김으로는 바꾸지 않는다.
    expect(f.orch.engineStatus()?.state).toBe("ok");
    await Bun.sleep(80);
    const before = f.events.length;
    await f.supervise();
    expect(f.orch.engineStatus()).toEqual({ state: "unresponsive", expectedVersion: CORE_VERSION });
    expect(f.events.slice(before).map(e => e.type)).toContain("projects");
    f.state.helloFails = false;
    await f.supervise();
    expect(f.orch.engineStatus()).toEqual({ state: "ok", version: CORE_VERSION, expectedVersion: CORE_VERSION });
  });

  test("한 번도 답한 적 없는 엔진도 시간이 지나면 unresponsive 로 드러난다", async () => {
    const f = await fixture({ timings: { engineUnresponsiveMs: 40 } });
    f.state.helloFails = true;
    await f.supervise();
    expect(f.orch.engineStatus()).toBeNull();
    await Bun.sleep(60);
    await f.supervise();
    expect(f.orch.engineStatus()).toEqual({ state: "unresponsive", expectedVersion: CORE_VERSION });
  });
});
