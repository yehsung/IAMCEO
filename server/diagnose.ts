// D8: 진단 파일. 버전, 서비스 상태, 점검표, 로그 끝부분, 멈춤 기록(루프 지연·vitals·crash-guard·시작·종료 줄), 충돌 보고 파일 이름,
// 백업 상태, DB 의 상태 요약(ID·상태·시각·개수)을 ~/.iamceo/diagnostics/<시각>/ 에 모으고 같은 이름의 .zip 을 만든다.
// 넣지 않는 것: 대화·보고·결재·할 일·자료의 본문, 첨부 파일, 접속 코드, 팀장 열쇠(MCP 토큰), 알림 토큰, 환경 변수 값.
// DB 는 허용 목록의 열만 옮기고(본문 열은 아예 읽지 않는다), 로그는 아는 비밀을 지운 뒤 끝부분만 넣는다.
import type { Database } from "bun:sqlite";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, homedir, platform, release } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { DiagnoseResult, DoctorReport } from "../shared/types.ts";
import { formatDoctorReport, SERVICE_LABEL } from "./doctor.ts";
import type { Config } from "./config.ts";

export const DIAGNOSTICS_DIR = "diagnostics";
/** 진단 묶음을 몇 개까지 남기나. 오래된 것부터 지운다. */
export const DIAGNOSTICS_KEEP = 5;
const LOG_TAIL_BYTES = 256 * 1024;
const LOG_PREVIOUS_TAIL_BYTES = 128 * 1024;
const EVENT_SCAN_BYTES = 2 * 1024 * 1024;
const EVENT_LINES = 400;
const ROW_LIMIT = 300;
const MASK = "[가림]";

type DiagnoseConfig = Pick<Config, "accessCode" | "port" | "hosts" | "claudeBin"> &
  Partial<Pick<Config, "hostsAuto" | "keepAwake" | "codexBin" | "coreBin" | "coreSocket" | "claudeHome" | "codexHome">>;

export interface DiagnoseInput {
  home: string;
  dbPath: string;
  /** 비밀이 아닌 값만 옮긴다. 접속 코드는 가림 목록에만 쓴다. 설정 파일이 없으면 null. */
  config: DiagnoseConfig | null;
  /** 읽기만 한다. 서버 안에서는 서버의 DB, 명령줄에서는 읽기 전용으로 연 DB. 없으면 DB 요약을 건너뛴다. */
  db: Database | null;
  source: "server" | "cli";
  versions: { server: string; buildId?: string | null };
  doctor: DoctorReport | null;
  /** 서버가 아는 상태(준비·실행 엔진·Tailscale·주소·백업·core). 명령줄에서 서버가 꺼져 있으면 null. */
  server?: Record<string, unknown> | null;
  /** launchd 서비스 상태 요약. 기본은 launchctl print 를 읽어 허용한 줄만 남긴다(시험 환경에서는 부르지 않는다). */
  service?: () => Promise<string | null>;
  logDir?: string;
  /** macOS 충돌 보고 폴더. 이름·시각·크기만 적는다. null 이면 건너뛴다. */
  crashReportsDir?: string | null;
  now?: Date;
  keep?: number;
  /** 더 가릴 문자열(시험용). */
  extraSecrets?: string[];
}

// ---- 가리기 ----

/** 로그·요약에 섞일 수 있는 비밀. 접속 코드, 팀장 열쇠, 알림 토큰. */
function collectSecrets(input: DiagnoseInput): string[] {
  const secrets = new Set<string>();
  if (input.config?.accessCode) secrets.add(input.config.accessCode);
  for (const value of input.extraSecrets ?? []) secrets.add(value);
  if (input.db) {
    for (const sql of ["SELECT token AS v FROM members", "SELECT token AS v FROM push_devices WHERE token IS NOT NULL"]) {
      try { for (const row of input.db.query<{ v: string | null }, []>(sql).all()) if (row.v) secrets.add(row.v); } catch { /* 옛 스키마 */ }
    }
  }
  // 너무 짧은 값은 평범한 낱말까지 지운다. 접속 코드·열쇠는 모두 이보다 길다.
  return [...secrets].filter(value => value.length >= 8).sort((a, b) => b.length - a.length);
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(MASK);
  return out
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, `$1${MASK}`)
    .replace(/((?:IAMCEO_TOKEN|accessCode|access_code|token|password|secret|api[_-]?key)["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/-]{8,}/gi, `$1${MASK}`);
}

// ---- 모으기 ----

function pick(row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in row) out[key] = row[key];
  return out;
}

/** 서버가 만든 코드 모양(control_unknown: …)이면 그 코드만, 아니면 글이 있다는 것만 남긴다. 화면·대화 글이 섞일 수 있다. */
function codeOf(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return /^([a-z][a-z0-9_]{1,40})(?=$|[:\s])/.exec(value)?.[1] ?? "text";
}

function safeRows<T>(read: () => T, fallback: T): T {
  try { return read(); } catch { return fallback; }
}

const SETTINGS_KEYS = ["backend", "permissionMode", "ranks", "codexRanks", "maxConcurrentTurns", "compactAtPct", "contextWindowDefault",
  "contextWindows", "maxAwakeWorkers", "notifyMac", "macScriptNotifications", "boardTidyHours", "permissionAcknowledged", "reportLanguage"];

function databaseSummary(db: Database): Record<string, unknown> {
  const all = (sql: string) => db.query<Record<string, unknown>, []>(sql).all();
  const tables = safeRows(() => all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(row => String(row.name)), []);
  const counts: Record<string, number> = {};
  for (const table of tables) {
    // 표 이름은 sqlite_master 에서 왔고 따옴표로 감싼다.
    counts[table] = safeRows(() => Number(db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${table.replace(/"/g, '""')}"`).get()?.n ?? 0), -1);
  }
  const settings: Record<string, unknown> = {};
  for (const row of safeRows(() => all("SELECT key, value FROM settings"), [])) {
    const key = String(row.key);
    if (!SETTINGS_KEYS.includes(key)) continue;
    try { settings[key] = JSON.parse(String(row.value)); } catch { settings[key] = "?"; }
  }
  return {
    schemaVersion: safeRows(() => db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? null, null),
    rowCounts: counts,
    settings,
    projects: safeRows(() => all("SELECT * FROM projects ORDER BY created_at").map(row =>
      pick(row, ["id", "is_hq", "backend", "runner_enabled", "archived", "chief_cli", "created_at", "updated_at", "board_tidied_at"])), []),
    members: safeRows(() => all("SELECT * FROM members ORDER BY project_id, created_at").map(row => ({
      ...pick(row, ["id", "project_id", "kind", "origin", "cli", "status", "backend", "session_generation", "config_revision", "context_pct",
        "context_window", "subagents", "parallel", "created_at", "updated_at", "now_at"]),
      hasSession: row.session_id != null, hasTerminal: row.pane_id != null,
      errorCode: codeOf(row.last_error), blockedCode: codeOf(row.blocked_reason),
    })), []),
    deliveriesByStatus: safeRows(() => all("SELECT status, COUNT(*) AS n FROM deliveries GROUP BY status"), []),
    openDeliveries: safeRows(() => all(`SELECT * FROM deliveries WHERE status IN ('queued','held','delivering') ORDER BY created_at LIMIT ${ROW_LIMIT}`).map(row => ({
      ...pick(row, ["id", "project_id", "member_id", "kind", "status", "hold_reason", "ref_type", "ref_id", "attempts", "wake", "urgent",
        "next_attempt_at", "retry_scope", "retry_reason", "created_at", "delivered_at"]),
      errorCode: codeOf(row.last_error),
    })), []),
    recoveryByPhase: safeRows(() => all("SELECT phase, COUNT(*) AS n FROM delivery_recovery GROUP BY phase"), []),
    openRecoveries: safeRows(() => all(`SELECT * FROM delivery_recovery WHERE phase NOT IN ('none','resolved') ORDER BY updated_at LIMIT ${ROW_LIMIT}`).map(row => ({
      ...pick(row, ["delivery_id", "phase", "auto_attempts", "check_count", "active_check_ms", "next_check_at", "last_checked_at", "updated_at"]),
      reasonCode: codeOf(row.reason),
    })), []),
    openLifecycle: safeRows(() => all(`SELECT * FROM lifecycle_journal WHERE phase IN ('prepared','started','unknown') ORDER BY updated_at LIMIT ${ROW_LIMIT}`).map(row => ({
      ...pick(row, ["operation_id", "member_id", "project_id", "intent", "phase", "generation", "run_id", "exit_code", "created_at", "updated_at"]),
      reasonCode: codeOf(row.reason),
    })), []),
    openExecutions: safeRows(() => all(`SELECT * FROM execution_journal WHERE phase NOT IN ('ended','interrupted') ORDER BY updated_at LIMIT ${ROW_LIMIT}`).map(row => ({
      ...pick(row, ["run_id", "member_id", "project_id", "generation", "turn", "phase", "input_received_at", "started_at", "last_progress_at",
        "ended_at", "result", "exit_code", "created_at", "updated_at"]),
      reasonCode: codeOf(row.reason),
    })), []),
    pushDevices: safeRows(() => all("SELECT environment, state, enabled, COUNT(*) AS n FROM push_devices GROUP BY environment, state, enabled"), []),
  };
}

function readTail(path: string, maxBytes: number): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, start + offset);
      if (count === 0) break;
      offset += count;
    }
    let text = buffer.subarray(0, offset).toString("utf8");
    // 잘린 첫 줄은 버린다.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } catch { return null; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* 읽기만 했다 */ } }
}

const EVENT_LINE = /\[(startup|shutdown|loop-monitor|vitals|crash-guard|core|backup|hosts|cli|restart|tailnet)\]/;

function eventLines(logDir: string): string[] {
  const lines: string[] = [];
  // 오래된 판부터 읽어 시간 순서를 지킨다.
  for (const name of ["server.log.1", "server.err.log.1", "server.log", "server.err.log"]) {
    const text = readTail(join(logDir, name), EVENT_SCAN_BYTES);
    if (!text) continue;
    for (const line of text.split("\n")) if (EVENT_LINE.test(line)) lines.push(`${name}: ${line.slice(0, 2000)}`);
  }
  return lines.slice(-EVENT_LINES);
}

function crashReports(dir: string): string {
  try {
    const rows = readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && /(iamceo|herdr|bun)/i.test(entry.name))
      .map(entry => { const stat = statSync(join(dir, entry.name)); return { name: entry.name, at: stat.mtimeMs, size: stat.size }; })
      .sort((a, b) => b.at - a.at).slice(0, 50);
    return rows.length ? rows.map(row => `${new Date(row.at).toISOString()}  ${row.size}B  ${row.name}`).join("\n") + "\n" : "(없음 · none)\n";
  } catch { return "(읽지 못함 · unreadable)\n"; }
}

const SNAPSHOT_NAME = /^snapshot-(\d{13})-[a-f0-9-]{36}$/;

function backupList(backupDir: string): unknown[] {
  try {
    return readdirSync(backupDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && SNAPSHOT_NAME.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name)).slice(0, 20)
      .map(entry => {
        const dir = join(backupDir, entry.name);
        let manifest: Record<string, unknown> | null = null;
        try { manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>; } catch { /* 덜 만든 것 */ }
        let dbBytes: number | null = null;
        try { dbBytes = statSync(join(dir, "iamceo.db")).size; } catch { /* 없음 */ }
        return {
          id: entry.name, createdAt: new Date(Number(SNAPSHOT_NAME.exec(entry.name)![1])).toISOString(), complete: manifest !== null, dbBytes,
          ...(manifest ? { applicationVersion: manifest.applicationVersion, schemaVersion: manifest.schemaVersion, verification: manifest.verification,
            attachments: Array.isArray(manifest.attachments) ? manifest.attachments.length : null } : {}),
        };
      });
  } catch { return []; }
}

const SERVICE_LINE = /^\s*(state|pid|last exit code|last terminating signal|runs|program|path|spawn type|active count|forks|execs|job state|immediate reason)\s*=/i;

/** launchctl print 의 허용한 줄만. 환경 변수 묶음(environment = { … })은 값이 있어 넣지 않는다. */
export function serviceSummary(printed: string): string {
  const kept: string[] = [];
  let depth = 0;
  for (const line of printed.split("\n")) {
    const opens = (line.match(/\{/g) ?? []).length, closes = (line.match(/\}/g) ?? []).length;
    // 맨 바깥 묶음(서비스 자신)의 바로 아래 줄만 본다. 안쪽 묶음(environment 등)은 건너뛴다.
    if (depth === 1 && SERVICE_LINE.test(line) && opens === 0) kept.push(line.trim());
    depth += opens - closes;
  }
  return kept.join("\n");
}

async function defaultService(): Promise<string | null> {
  if (process.platform !== "darwin" || process.env.IAMCEO_TEST === "1") return null;
  try {
    const child = Bun.spawn(["/bin/launchctl", "print", `gui/${process.getuid!()}/${SERVICE_LABEL}`], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 끝났다 */ } }, 3_000);
    try {
      const stdout = await new Response(child.stdout).text();
      const code = await child.exited;
      return code === 0 ? serviceSummary(stdout) || "(허용한 줄 없음)" : `launchctl print: 등록되지 않음(종료 코드 ${code})`;
    } finally { clearTimeout(timer); }
  } catch { return null; }
}

// ---- zip ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: (Math.max(0, date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** 작은 zip(deflate). 바깥 프로그램(zip·ditto)에 기대지 않는다. */
export function buildZip(entries: { name: string; data: Uint8Array }[], at: Date): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const { time, date } = dosTime(at);
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(entry.data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100600 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// ---- 만들기 ----

function stampOf(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
}

const DIAG_NAME = /^(\d{8}-\d{6}(?:-\d+)?)(\.zip)?$/;

/** 새 것부터 keep 개만 남긴다. 이 폴더 안의 진단 이름만 지운다. */
function prune(root: string, keep: number): void {
  let names: string[];
  try { names = readdirSync(root); } catch { return; }
  const bases = [...new Set(names.map(name => DIAG_NAME.exec(name)?.[1]).filter((base): base is string => !!base))].sort().reverse();
  for (const base of bases.slice(Math.max(1, keep))) {
    for (const path of [join(root, base), join(root, `${base}.zip`)]) {
      try { rmSync(path, { recursive: true, force: true }); } catch { /* 다음에 다시 */ }
    }
  }
}

const README = `IAMCEO 진단 파일 · IAMCEO diagnostics

들어 있는 것 · Included
- summary.json      버전, 서버 상태, 비밀이 아닌 설정 값 · versions, server state, non-secret settings
- doctor.json/.txt  점검표 · the self-check report
- service.txt       자동 시작(launchd) 상태 · login item (launchd) state
- database.json     DB 요약: ID·상태·시각·개수만 · DB summary: ids, states, times, counts only
- backups.json      백업 목록 · backup list
- logs/             서버 로그의 끝부분(아는 비밀은 가림) · log tails (known secrets masked)
- events.txt        시작·종료·멈춤·지연 기록 줄 · startup, shutdown, stall and delay lines
- crash-reports.txt 충돌 보고 파일 이름·시각 · crash report names and times

넣지 않은 것 · Not included
대화·보고·결재·할 일·자료의 본문, 첨부 파일, 접속 코드, 팀장 열쇠, 알림 토큰, 환경 변수 값.
Message, report, decision, todo and file contents, attachments, the access code, session keys, push tokens, environment variable values.
`;

/** 진단 폴더와 zip 을 만든다. 모으다 한 부분이 실패해도 나머지는 만든다. */
export async function createDiagnostics(input: DiagnoseInput): Promise<DiagnoseResult> {
  const now = input.now ?? new Date();
  const root = join(input.home, DIAGNOSTICS_DIR);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let base = stampOf(now);
  for (let n = 2; existsSync(join(root, base)) || existsSync(join(root, `${base}.zip`)); n++) base = `${stampOf(now)}-${n}`;
  const dir = join(root, base);
  mkdirSync(join(dir, "logs"), { recursive: true, mode: 0o700 });

  const secrets = collectSecrets(input);
  const files: { name: string; text: string }[] = [];
  const add = (name: string, text: string) => files.push({ name, text: redact(text, secrets) });
  const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
  const config = input.config;

  add("README.txt", README);
  add("summary.json", json({
    createdAt: now.toISOString(),
    source: input.source,
    versions: { server: input.versions.server, buildId: input.versions.buildId ?? null, bun: Bun.version, os: `${platform()} ${release()}`, arch: arch() },
    server: input.server ?? null,
    config: config ? {
      home: input.home, port: config.port, hosts: config.hosts, hostsAuto: config.hostsAuto ?? null, keepAwake: config.keepAwake ?? true,
      claudeBin: config.claudeBin, codexBin: config.codexBin ?? null, coreBin: config.coreBin ?? null, coreSocket: config.coreSocket ?? null,
      claudeHome: config.claudeHome ?? null, codexHome: config.codexHome ?? null,
    } : null,
    // 값은 넣지 않는다. 어떤 IAMCEO 환경 변수가 정해져 있는지만.
    environmentNames: Object.keys(process.env).filter(name => /^(IAMCEO_|CLAUDE_CONFIG_DIR$|CODEX_HOME$)/.test(name)).sort(),
  }));
  if (input.doctor) {
    add("doctor.json", json(input.doctor));
    add("doctor.txt", formatDoctorReport(input.doctor, "ko") + "\n");
  }
  const service = await (input.service ?? defaultService)().catch(() => null);
  add("service.txt", `${service ?? "(확인하지 못함 · not checked)"}\n`);
  if (input.db) {
    const db = input.db;
    add("database.json", json(safeRows(() => databaseSummary(db), { error: "DB 를 읽지 못했습니다" })));
  }
  let dbBytes: Record<string, number | null> = {};
  for (const suffix of ["", "-wal", "-shm"]) dbBytes[`iamceo.db${suffix}`] = safeRows(() => statSync(`${input.dbPath}${suffix}`).size, null);
  add("backups.json", json({ dbBytes, snapshots: backupList(join(input.home, "backups")) }));
  const logDir = input.logDir ?? join(input.home, "logs");
  for (const name of ["server.log", "server.err.log"]) {
    const tail = readTail(join(logDir, name), LOG_TAIL_BYTES);
    if (tail !== null) add(`logs/${name}.txt`, tail);
    const previous = readTail(join(logDir, `${name}.1`), LOG_PREVIOUS_TAIL_BYTES);
    if (previous !== null) add(`logs/${name}.1.txt`, previous);
  }
  add("events.txt", eventLines(logDir).join("\n") + "\n");
  const crashDir = input.crashReportsDir === undefined ? join(homedir(), "Library", "Logs", "DiagnosticReports") : input.crashReportsDir;
  if (crashDir) add("crash-reports.txt", crashReports(crashDir));
  const ledger = safeRows(() => readFileSync(join(input.home, "cli-versions.json"), "utf8"), null);
  if (ledger !== null) add("cli-versions.json", ledger);

  const entries: { name: string; data: Uint8Array }[] = [];
  for (const file of files) {
    const data = Buffer.from(file.text, "utf8");
    writeFileSync(join(dir, file.name), data, { mode: 0o600 });
    entries.push({ name: `${base}/${file.name}`, data });
  }
  const zipPath = join(root, `${base}.zip`);
  writeFileSync(zipPath, buildZip(entries, now), { mode: 0o600 });
  prune(root, input.keep ?? DIAGNOSTICS_KEEP);
  return { path: zipPath, sizeBytes: statSync(zipPath).size, createdAt: now.toISOString() };
}
