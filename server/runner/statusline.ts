// 사용자 설정은 읽기만 한다. 실행 파일은 IAMCEO 홈 안에만 쓴다.
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bunScriptCommand, shellQuote as quote } from "./bun-script.ts";
import type { ContextReading } from "./context.ts";
import { validWindow } from "./context.ts";

export const STATUSLINE_MARKER = "iamceo-context-statusline";
export const CONTEXT_SESSION_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const MANAGED_SETTINGS = "/Library/Application Support/ClaudeCode/managed-settings.json";

/** 독립 JS: 소스·컴파일 실행 모두 같은 파일을 Bun CLI 로 실행한다. */
const SCRIPT = String.raw`
import { mkdirSync, chmodSync, writeFileSync, renameSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
const home = process.argv[2];
let child;
// 사용자 명령의 캐시 갱신·네트워크 요청을 기다린다. 정상 종료 뒤 자손은 건드리지 않는다.
const stop = signal => { try { child?.kill(signal); } catch {} };
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => { stop(signal); process.exit(0); });
}
let deadline = setTimeout(() => { stop('SIGKILL'); process.exit(0); }, SAFETY_TIMEOUT_MS);
try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  let input = {};
  try { input = JSON.parse(bytes.toString('utf8')) ?? {}; } catch {}
  try {
    const id = input.session_id, ctx = input.context_window;
    if (/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id ?? '') && typeof id === 'string' && Number.isSafeInteger(ctx?.context_window_size) && ctx.context_window_size > 0) {
      const dir = join(home, 'context');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const usage = ctx.current_usage;
      const parts = usage && [usage.input_tokens, usage.cache_creation_input_tokens ?? 0, usage.cache_read_input_tokens ?? 0];
      const tokens = parts && parts.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0) ? parts.reduce((a,b) => a+b, 0) : null;
      const pct = ctx.used_percentage;
      const record = { session_id: id, model: typeof input.model?.id === 'string' ? input.model.id : null,
        context_window_size: ctx.context_window_size, used_percentage: typeof pct === 'number' && Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : null,
        tokens, at: Date.now() };
      // T(F6): CLI 가 보고한 세션 누적 비용·토큰과 계정 한도 사용률. 고치거나 추정하지 않고 모양만 확인해 옮긴다(없으면 넣지 않는다).
      const amount = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
      const count = n => Number.isSafeInteger(n) && n >= 0 ? n : undefined;
      const cost = amount(input.cost?.total_cost_usd);
      if (cost !== undefined) record.cost_usd = cost;
      const inTotal = count(ctx.total_input_tokens), outTotal = count(ctx.total_output_tokens);
      if (inTotal !== undefined) record.input_tokens_total = inTotal;
      if (outTotal !== undefined) record.output_tokens_total = outTotal;
      const limits = input.rate_limits;
      if (limits && typeof limits === 'object' && !Array.isArray(limits)) {
        const windows = {};
        for (const [name, w] of Object.entries(limits).slice(0, 8)) {
          const used = w?.used_percentage ?? w?.used_percent ?? w?.utilization;
          if (!/^[a-z0-9_]{1,40}$/.test(name) || typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) continue;
          const resets = w.resets_at;
          windows[name] = { used_percentage: used, resets_at: (typeof resets === 'number' && Number.isFinite(resets) && resets > 0) || (typeof resets === 'string' && resets.length <= 40) ? resets : null };
        }
        if (Object.keys(windows).length) record.rate_limits = windows;
      }
      const tmp = join(dir, id + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp');
      try { writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 }); renameSync(tmp, join(dir, id + '.json')); }
      finally { try { unlinkSync(tmp); } catch {} }
    }
  } catch {}
  const project = [input.workspace?.project_dir, input.workspace?.current_dir].find(p => typeof p === 'string' && p.length > 0) ?? process.cwd();
  const files = [MANAGED_SETTINGS_PATH, join(project, '.claude/settings.local.json'), join(project, '.claude/settings.json'), join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')];
  let command;
  for (const file of files) {
    try {
      const line = JSON.parse(readFileSync(file, 'utf8')).statusLine;
      if (line === undefined) continue;
      // 자신이 들어 있는 설정은 건너뛰고 원래 사용자 설정을 찾는다.
      if (typeof line?.command === 'string' && line.command.includes('iamceo-context-statusline')) continue;
      if (line?.type === 'command' && typeof line.command === 'string') command = line.command;
      break;
    } catch {}
  }
  if (command) {
    const env = { ...process.env };
    delete env.BUN_BE_BUN;
    clearTimeout(deadline);
    child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'inherit', 'ignore'], env });
    deadline = setTimeout(() => { stop('SIGKILL'); process.exit(0); }, SAFETY_TIMEOUT_MS);
    await new Promise(resolve => {
      child.once('error', resolve); child.once('exit', resolve);
      child.stdin.on('error', () => {}); child.stdin.end(bytes);
    });
    child = undefined;
  }
} catch {}
clearTimeout(deadline);
process.exit(0);
`;

export function writeStatuslineWrapper(home: string, options: { execPath?: string; managedSettingsPath?: string; /** 테스트의 대기 시간만 줄인다. 실제 호출은 기본 30초. */ safetyTimeoutMs?: number } = {}): { type: "command"; command: string } {
  const dir = join(home, "run");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${STATUSLINE_MARKER}.mjs`);
  const timeout = options.safetyTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("Invalid statusline safety timeout");
  const content = `const MANAGED_SETTINGS_PATH = ${JSON.stringify(options.managedSettingsPath ?? MANAGED_SETTINGS)};\nconst SAFETY_TIMEOUT_MS = ${timeout};\n${SCRIPT}`;
  // 전달마다 파일을 다시 쓰지 않는다. 컴파일 실행에도 외부 소스 경로가 필요 없다.
  let same = false;
  try { same = readFileSync(path, "utf8") === content; } catch {}
  if (!same) {
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    try { writeFileSync(tmp, content, { mode: 0o600 }); renameSync(tmp, path); }
    finally { try { unlinkSync(tmp); } catch { /* rename 성공 */ } }
  }
  chmodSync(path, 0o600);
  // 작업 폴더(팀장 프로젝트)의 bunfig.toml preload·.env 를 읽지 않는다(bun-script.ts). 사용자 상태줄 명령은 그 폴더에서 그대로 돈다(cd 하지 않는다).
  return { type: "command", command: `${bunScriptCommand(options.execPath ?? process.execPath, dir, path)} ${quote(home)}` };
}

interface ContextRecord { session_id: string; model: string | null; context_window_size: number; used_percentage: number | null; tokens: number | null; at: number;
  /** T(F6): 래퍼가 함께 옮기는 CLI 보고값. 이전 판 래퍼가 쓴 기록에는 없다. 사용량 모으기(server/usage.ts)만 읽는다. */
  cost_usd?: number; input_tokens_total?: number; output_tokens_total?: number; rate_limits?: Record<string, { used_percentage: number; resets_at: number | string | null }> }
export function readContextRecord(home: string | undefined, sessionId: string): ContextRecord | null {
  if (!home || !CONTEXT_SESSION_RE.test(sessionId)) return null;
  try {
    const r = JSON.parse(readFileSync(join(home, "context", `${sessionId}.json`), "utf8"));
    if (r.session_id !== sessionId || !validWindow(r.context_window_size) || !Number.isFinite(r.at)) return null;
    return { ...r, model: typeof r.model === "string" ? r.model : null,
      tokens: typeof r.tokens === "number" && Number.isFinite(r.tokens) && r.tokens >= 0 ? r.tokens : null,
      used_percentage: typeof r.used_percentage === "number" && Number.isFinite(r.used_percentage) && r.used_percentage >= 0 && r.used_percentage <= 100 ? r.used_percentage : null };
  } catch { return null; }
}

/** 턴 끝 2초 안의 같은 사용량만 공식 % 로 쓴다. 늦은 상태 갱신은 한 번 기다린다. */
export async function capturedContext(home: string | undefined, sessionId: string, reading: ContextReading, endedAt: number): Promise<ContextReading> {
  if (!home) return reading;
  const fresh = (r: ContextRecord | null) => r !== null && r.at >= endedAt - 2000 && r.at <= Date.now() + 1000 && (reading.tokens === null || reading.tokens === r.tokens);
  let r = readContextRecord(home, sessionId);
  if (!fresh(r)) { await Bun.sleep(100); r = readContextRecord(home, sessionId); }
  if (!r) return reading;
  const isFresh = fresh(r);
  if (!isFresh && reading.tokens !== null && reading.tokens > r.context_window_size) return reading;
  return { ...reading, model: isFresh ? r.model ?? reading.model : reading.model, tokens: isFresh ? r.tokens ?? reading.tokens : reading.tokens,
    exact: { window: r.context_window_size, source: "statusline", pct: isFresh ? r.used_percentage : null } };
}
