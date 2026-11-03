// herdr 칸 안에서 `claude` 처럼 도는 가짜 TUI. 실제 claude 를 절대 부르지 않는다.
// bun build --compile 로 이름이 claude 인 실행 파일을 만들어야 herdr 가 에이전트로 인식한다.
// 입력 글에 따라 움직인다: SLOW(오래 일함) · BLOCK(승인 창, 숫자 1·2 승인 3 거절) · EXIT(종료) · GHOST(턴 뒤 흐린 다음 말 추천) · /effort · /compact.
// 키는 Claude Code 2.1.316 실측과 같게: Ctrl+C 는 입력칸의 글을 한 번에 다 지우고(여러 줄도) 약 0.8초 종료 창을 연다.
// 그 창 안에 빈 입력칸에서 또 누르면 끝난다. 일하는 중이면 턴을 끊는다. 쉬는 칸의 Esc 한 번은 글을 지우지 않는다.
// 누른 Ctrl+C 는 keys.jsonl 에 남긴다.
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.IAMCEO_FAKE_DIR;
if (!dir) throw new Error("IAMCEO_FAKE_DIR 없음");
const socket = process.env.HERDR_SOCKET_PATH ?? "";
if (socket && !/\/sessions\/iamceo-test-[^/]+\/herdr\.sock$/.test(socket)) throw new Error(`시험 소켓이 아님: ${socket}`);

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null; };
const sessionId = flag("--session-id") ?? flag("--resume") ?? crypto.randomUUID();
// 진짜 Claude 와 같은 자리 규칙. 시험은 CLAUDE_CONFIG_DIR=<dir>/claude 로 transcript.ts 를 그대로 태운다.
const sessionsDir = join(dir, "claude", "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
mkdirSync(sessionsDir, { recursive: true });
const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
appendFileSync(join(dir, "argv.jsonl"), JSON.stringify({ args, cwd: process.cwd(), paneId: process.env.HERDR_PANE_ID, sessionId, subagentModel: process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? null, subagentForce: process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE ?? null }) + "\n");
if (flag("--resume") && !existsSync(sessionFile)) { console.error(`No conversation found with session ID: ${flag("--resume")}`); process.exit(1); }

const out = (s: string) => process.stdout.write(s);
const log: string[] = [];
let input = "";
let inPaste = false;
let state: "idle" | "working" | "blocked" = "idle";
let workTimer: ReturnType<typeof setTimeout> | null = null;
/** 실측: 안내는 750ms 까지 보이고 850ms 에는 사라졌다. */
const EXIT_WINDOW_MS = 800;
let exitUntil = 0;
let exitTimer: ReturnType<typeof setTimeout> | null = null;
/** 턴이 끝난 뒤 빈 입력칸에 흐리게 뜨는 다음 말 추천. 글을 치면 숨고, 지우면 다시 나온다. */
let ghost: string | null = null;
/** 승인 창에 보일 명령. 들어온 글에서 따온다. */
let blockCmd = "";

function report(method: string, params: Record<string, unknown>) {
  if (!socket) return;
  Bun.connect({ unix: socket, socket: {
    open(s) { s.write(JSON.stringify({ id: "fake", method, params }) + "\n"); },
    data(s) { s.end(); }, error() {}, connectError() {},
  } }).catch(() => {});
}

function render() {
  const rows = process.stdout.rows || 24;
  const cols = process.stdout.columns || 80;
  const rule = "─".repeat(Math.max(10, cols - 1));
  // 여러 줄 글은 진짜 칸처럼 둘째 줄부터 들여 쓴다. 추천은 흐린 글씨(SGR 2)다.
  const box = input ? input.split("\n").map((l, i) => `${i === 0 ? "❯ " : "  "}${l}`) : [ghost ? `❯ \x1b[0m\x1b[2m${ghost}\x1b[0m` : "❯ "];
  const hint = state === "working" ? "  ⏵⏵ bypass permissions on · esc to interrupt" : Date.now() < exitUntil ? "  Press Ctrl-C again to exit" : "  ⏵⏵ bypass permissions on (shift+tab to cycle)";
  // 실측(2.1.316) 승인 창 모양. 숫자 키가 고르고 바로 확정한다.
  const footer = state === "blocked"
    ? [rule, " Bash command", "", ` ${blockCmd}`, " 가짜 명령", "", " Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and don't ask again for touch commands in", "      /tmp/fake", "   3. No", "", " Esc to cancel · Tab to amend"]
    : [rule, ...box, rule, `  ◆ Fake │ ███░░░░░░░ │ 27% │ 54K/200K`, hint];
  const room = Math.max(1, rows - footer.length);
  const body = log.slice(-room);
  // 지우고 다시 그린다. 진짜 Claude 처럼 칸 크기에 맞춘다(흐린 글씨의 제어 문자는 너비에 넣지 않는다).
  const fit = (l: string) => (l.includes("\x1b") ? l : l.slice(0, cols - 1));
  out("\x1b[2J\x1b[H" + [...body, ...Array(room - body.length).fill(""), ...footer].map(fit).join("\r\n"));
}

function setState(next: typeof state) {
  state = next;
  out(next === "working" ? "\x1b]0;⠋ fake\x07" : "\x1b]0;✳ fake\x07");
  render();
}

function append(entry: Record<string, unknown>) { appendFileSync(sessionFile, JSON.stringify(entry) + "\n"); }

function work(ms: number, done: () => void) {
  setState("working");
  workTimer = setTimeout(() => { workTimer = null; done(); setState("idle"); }, ms);
}

function submit(raw: string) {
  const text = raw;
  input = "";
  ghost = null;
  if (!text.startsWith("/")) append({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: text } });
  appendFileSync(join(dir!, "prompts.jsonl"), JSON.stringify({ sessionId, text }) + "\n");
  log.push(`> ${text.replace(/\n/g, " ⏎ ")}`);
  if (text === "EXIT" || text === "/exit") process.exit(0);
  // 진짜 Claude 처럼 칸 안에서 곧바로 답한다. 턴이 아니다.
  const added = /^\/add-dir (.+)$/.exec(text);
  if (added) {
    // 진짜 칸처럼 긴 줄은 접힌다.
    const width = Math.max(20, (process.stdout.columns || 80) - 2);
    const line = `Added ${added[1]} as a working directory for this session`;
    for (let at = 0; at < line.length; at += width) log.push(line.slice(at, at + width));
    render();
    return;
  }
  const effort = /^\/effort ultracode (on|off)$/.exec(text);
  if (effort) { log.push(`Ultracode ${effort[1]}`); render(); return; }
  if (text.startsWith("/compact")) {
    work(800, () => { log.push("Compacted"); append({ type: "system", subtype: "compact_boundary" }); });
    return;
  }
  if (text.includes("BLOCK")) { blockCmd = text.replace(/\s+/g, " ").slice(0, 60); setState("blocked"); return; }
  const answer = `답변: ${text.replace(/\s+/g, " ").slice(0, 60)}`;
  work(text.includes("SLOW") ? 4000 : 800, () => {
    log.push(answer);
    if (text.includes("GHOST")) ghost = "다음에 할 말 추천";
    append({ type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", model: "fake-model", content: [{ type: "text", text: answer }], usage: { input_tokens: 1000, cache_read_input_tokens: 53000, cache_creation_input_tokens: 0 } } });
  });
}

/** 승인 창의 숫자 키. 1·2 는 승인하고 이어서 일한 뒤 답한다. 3(No)은 실측처럼 끊기고 쉰다. */
function pressOption(n: number) {
  appendFileSync(join(dir!, "approvals.jsonl"), JSON.stringify({ sessionId, option: n, cmd: blockCmd, at: Date.now() }) + "\n");
  if (n === 1 || n === 2) {
    log.push(`승인됨 ${n}`);
    work(800, () => {
      const answer = `승인 뒤 실행: ${blockCmd}`;
      log.push(answer);
      append({ type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", model: "fake-model", content: [{ type: "text", text: answer }], usage: { input_tokens: 1000, cache_read_input_tokens: 53000, cache_creation_input_tokens: 0 } } });
    });
    return;
  }
  if (n === 3) { log.push("Interrupted · What should Claude do instead?"); setState("idle"); return; }
  render();
}

/** 실측한 만큼만 흉내 낸다. 승인 창의 Ctrl+C 는 재지 않아 아무것도 하지 않는다. */
function ctrlC() {
  appendFileSync(join(dir!, "keys.jsonl"), JSON.stringify({ sessionId, key: "ctrl+c", at: Date.now(), state, input }) + "\n");
  if (state === "working" && workTimer) { clearTimeout(workTimer); workTimer = null; log.push("Interrupted"); setState("idle"); return; }
  if (state !== "idle") return;
  const now = Date.now();
  if (!input && now < exitUntil) {
    out(`\x1b[2J\x1b[HResume this session with: claude --resume ${sessionId}\r\n`);
    process.exit(0);
  }
  // 글이 있으면 다 지운다. 글이 있어도 종료 창은 열린다(실측: 지운 뒤 400ms 에 또 누르면 끝났다).
  input = "";
  exitUntil = now + EXIT_WINDOW_MS;
  if (exitTimer) clearTimeout(exitTimer);
  exitTimer = setTimeout(() => { exitTimer = null; render(); }, EXIT_WINDOW_MS + 20);
  render();
}

function handle(chunk: string) {
  let rest = chunk;
  while (rest.length) {
    if (rest.startsWith("\x1b[200~")) { inPaste = true; rest = rest.slice(6); continue; }
    if (rest.startsWith("\x1b[201~")) { inPaste = false; rest = rest.slice(6); render(); continue; }
    const ch = rest[0]!;
    rest = rest.slice(1);
    if (inPaste) { input += ch; continue; }
    if (ch === "\x1b") {
      if (state === "working" && workTimer) { input = ""; clearTimeout(workTimer); workTimer = null; log.push("Interrupted"); setState("idle"); }
      else if (state === "blocked") { input = ""; log.push("Cancelled"); setState("idle"); }
      // 실측: 쉬는 칸에서 Esc 한 번은 입력칸의 글을 지우지 않는다.
      else render();
      continue;
    }
    if (ch === "\x03") { ctrlC(); continue; }
    if (state === "blocked" && ch >= "0" && ch <= "9") { pressOption(Number(ch)); continue; }
    if (ch === "\r" || ch === "\n") {
      if (state === "blocked") { setState("idle"); continue; }
      if (input.length) submit(input);
      continue;
    }
    if (ch === "\x7f") input = input.slice(0, -1);
    else if (ch >= " ") input += ch;
    render();
  }
}

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (b: Buffer) => handle(b.toString("utf8")));
process.stdout.on("resize", render);
process.on("SIGWINCH", render);
out("\x1b[?2004h");
log.push("Fake Claude");
appendFileSync(sessionFile, "");
setState(flag("-n") === "시작승인" ? "blocked" : "idle");
const paneId = process.env.HERDR_PANE_ID;
if (paneId) report("pane.report_agent_session", { pane_id: paneId, source: "herdr:claude", agent: "claude", agent_session_id: sessionId });
