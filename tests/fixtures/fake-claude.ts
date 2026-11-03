#!/usr/bin/env bun
// `claude -p` 흉내(spec §9). 실제 모델을 부르지 않는다.
// 시나리오는 FAKE_CLAUDE_DIRECTIVES 또는 글 안의 @fake:이름[=값] 으로 정한다.
//   delay=ms · text=글 · silent · usage=토큰 · window=창크기 · post=제목 · postkind=종류 · ask=제목
//   error=글 · crash=글 · linger · hang · ignore-sigint · agent · noise · denied(승인 없어 막힌 도구)
// FAKE_CLAUDE_SCRIPT 는 규칙 JSON 파일 경로다: 글에 when 이 든 첫 규칙의 도구를 차례로 부른다(tests/e2e-fake.browser.ts).
//   인자 안의 $last 는 앞 도구 결과의 마지막 #id 로 바뀐다.
// FAKE_CLAUDE_LOG 에 호출마다 한 줄, FAKE_CLAUDE_SESSIONS 폴더에 세션 파일을 남긴다.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
function flag(name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

// 실제 서버는 글을 stdin 으로 넘긴다(argv 에 넣으면 ps 로 보이고 약 1MB 에서 E2BIG). -p 뒤가 플래그가 아니면 인자 글로도 받는다.
const stdinStart = Date.now();
const stdinRead = Bun.stdin.text();
const stdinClosed = await Promise.race([stdinRead.then(() => true), Bun.sleep(1000).then(() => false)]);
const stdinText = stdinClosed ? await stdinRead : "";
const promptArg = flag("-p");
const prompt = promptArg && !promptArg.startsWith("--") ? promptArg : stdinText;
const sessionFlag = flag("--session-id");
const resumeFlag = flag("--resume");
const sessionId = sessionFlag ?? resumeFlag ?? crypto.randomUUID();

const directives = new Map<string, string>();
for (const match of `${process.env.FAKE_CLAUDE_DIRECTIVES ?? ""} ${prompt}`.matchAll(/@fake:([a-z-]+)(?:=([^\s"]+))?/g)) {
  directives.set(match[1]!, match[2] ?? "");
}

interface ScriptRule {
  when: string;
  tools?: { name: string; args: Record<string, unknown> }[];
  text?: string;
  /** 턴을 끝내기 전에 기다리는 시간(ms). 화면에서 일하는 중 상태를 볼 수 있게 한다. */
  delay?: number;
  usage?: number;
  silent?: boolean;
}

const scriptFile = process.env.FAKE_CLAUDE_SCRIPT;
const rule = scriptFile ? (JSON.parse(readFileSync(scriptFile, "utf8")) as ScriptRule[]).find((r) => prompt.includes(r.when)) : undefined;
if (rule?.text !== undefined) directives.set("text", rule.text);
if (rule?.delay !== undefined) directives.set("delay", String(rule.delay));
if (rule?.usage !== undefined) directives.set("usage", String(rule.usage));
if (rule?.silent) directives.set("silent", "");

if (directives.has("ignore-sigint")) process.on("SIGINT", () => {});

const logPath = process.env.FAKE_CLAUDE_LOG;
function log(extra: Record<string, unknown> = {}): void {
  if (!logPath) return;
  appendFileSync(
    logPath,
    `${JSON.stringify({
      pid: process.pid,
      at: Date.now(),
      prompt,
      args: argv,
      cwd: process.cwd(),
      env: Object.keys(process.env).filter((k) => /^(HERDR_|CLAUDE)/.test(k)),
      subagentModel: process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? null,
      subagentForce: process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE ?? null,
      sessionFlag,
      resumeFlag,
      stdinClosed,
      stdinMs: Date.now() - stdinStart,
      ...extra,
    })}\n`,
  );
}
log({ event: "start" });

const sessionsDir = process.env.FAKE_CLAUDE_SESSIONS;
if (sessionsDir) {
  mkdirSync(sessionsDir, { recursive: true });
  const file = join(sessionsDir, `${sessionId}.txt`);
  if (resumeFlag && !existsSync(file)) {
    process.stderr.write(`No conversation found with session ID: ${resumeFlag}\n`);
    process.exit(1);
  }
  if (sessionFlag && existsSync(file)) {
    process.stderr.write(`Error: Session ID ${sessionFlag} is already in use.\n`);
    process.exit(1);
  }
  writeFileSync(file, prompt);
}

// 큰 글을 바이트 중간에서 끊어 보내 줄 조립과 UTF-8 디코딩을 시험한다.
async function emit(value: unknown): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const cut = Math.floor(bytes.length / 2);
  process.stdout.write(bytes.subarray(0, cut));
  await Bun.sleep(2);
  process.stdout.write(bytes.subarray(cut));
}

const model = "fake-model";
const contextWindow = Number(directives.get("window") ?? 200_000);
const usageTokens = Number(directives.get("usage") ?? 1000);
const usage = { input_tokens: 10, cache_read_input_tokens: usageTokens - 10, cache_creation_input_tokens: 0, output_tokens: 5 };
function assistant(content: unknown[], parent: string | null = null): Record<string, unknown> {
  return { type: "assistant", parent_tool_use_id: parent, session_id: sessionId, message: { id: `msg_${crypto.randomUUID()}`, model, role: "assistant", content, usage } };
}
function toolResult(id: string, text: string): Record<string, unknown> {
  return { type: "user", parent_tool_use_id: null, session_id: sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const id = `toolu_${crypto.randomUUID()}`;
  await emit(assistant([{ type: "tool_use", id, name: `mcp__iamceo__${name}`, input: args }]));
  const config = JSON.parse(readFileSync(flag("--mcp-config")!, "utf8"));
  const { IAMCEO_URL, IAMCEO_TOKEN } = config.mcpServers.iamceo.env;
  const response = await fetch(`${IAMCEO_URL}/agent/tool`, {
    method: "POST",
    headers: { Authorization: `Bearer ${IAMCEO_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, args }),
  });
  const text = await response.text();
  await emit(toolResult(id, text));
  return text;
}

await emit({ type: "system", subtype: "hook_started", hook_id: "h1", session_id: sessionId });
process.stdout.write("이 줄은 JSON 이 아니다\n[1,2,3]\nnull\n");
await emit({ type: "system", subtype: "init", session_id: sessionId, model, tools: [] });
await emit({ type: "system", subtype: "hook_response", hook_id: "h1", session_id: sessionId });

if (directives.has("crash")) {
  process.stderr.write(`${directives.get("crash")}\n`);
  log({ event: "crash" });
  process.exit(3);
}

if (prompt.startsWith("/compact")) {
  await emit({ type: "system", subtype: "compact_boundary", session_id: sessionId, compact_metadata: { trigger: "manual", pre_tokens: 150000 } });
  await emit({ type: "result", subtype: "success", is_error: false, result: "", session_id: sessionId, modelUsage: { [model]: { contextWindow } } });
  log({ event: "end" });
  process.exit(0);
}
if (prompt.startsWith("/effort")) {
  await emit({ type: "result", subtype: "success", is_error: false, result: "Ultracode 설정됨", session_id: sessionId, modelUsage: { [model]: { contextWindow } } });
  log({ event: "end" });
  process.exit(0);
}

if (directives.has("noise")) {
  // 서브에이전트 메시지: 문맥 계산·마지막 글에 섞이면 안 된다.
  await emit({ type: "assistant", parent_tool_use_id: "toolu_x", session_id: sessionId, message: { model: "haiku", content: [{ type: "text", text: "서브에이전트 글" }], usage: { input_tokens: 190_000 } } });
}
if (directives.has("agent")) {
  await emit(assistant([{ type: "tool_use", id: "toolu_agent", name: "Agent", input: { description: "조사" } }]));
  await Bun.sleep(Number(directives.get("agent") || 30));
  await emit(toolResult("toolu_agent", "조사 끝"));
}
if (directives.has("post")) {
  await callTool("post", { kind: directives.get("postkind") || "완료", title: directives.get("post") });
}
if (directives.has("ask")) {
  await callTool("ask", { title: directives.get("ask"), detail: "배경", options: [{ k: "a", label: "그렇게 하세요", desc: "추천" }, { k: "b", label: "하지 마세요" }] });
}

let lastId = "";
for (const call of rule?.tools ?? []) {
  const args = JSON.parse(JSON.stringify(call.args).replaceAll("$last", lastId)) as Record<string, unknown>;
  const result = await callTool(call.name, args);
  lastId = [...result.matchAll(/#([A-Za-z0-9_]+)/g)].at(-1)?.[1] ?? lastId;
}

const finalText = directives.has("silent") ? "" : (directives.get("text") ?? `가짜 응답 ${sessionId.slice(0, 8)} 한글확인`);
if (finalText) await emit(assistant([{ type: "text", text: finalText }]));
await Bun.sleep(Number(directives.get("delay") ?? 0));
if (directives.has("hang")) await Bun.sleep(600_000);

if (directives.has("error")) {
  await emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: [directives.get("error")], session_id: sessionId });
  log({ event: "end" });
  process.exit(1);
}
await emit({ type: "result", subtype: "success", is_error: false, result: finalText, session_id: sessionId, modelUsage: { [model]: { contextWindow }, haiku: { contextWindow: 1 } }, ...(directives.has("denied") ? { permission_denials: [{ tool_name: "Bash", tool_use_id: "toolu_d", tool_input: {} }] } : {}) });
log({ event: "end" });
if (directives.has("linger")) await Bun.sleep(600_000);
process.exit(0);
