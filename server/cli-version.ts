// D9: 이 Mac 의 Claude Code·Codex 버전을 읽고, 처음 본 시각을 남기고, 견본으로 확인된 버전인지 알린다.
// 화면·기록 해석은 CLI 버전마다 글자가 바뀌면 조용히 어긋난다. 견본이 없는 버전이면 '확인되지 않은 CLI 버전'으로 드러낸다.
// 묶음 사이 약속 5: CliVersionInfo, readCliVersions, VERIFIED_CLI_VERSIONS 의 모양은 바꾸지 않는다(점검 cli_version 이 쓴다).
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveCliExecutable } from "./config.ts";
import type { CliProvider, CliVersionInfo } from "../shared/types.ts";

export type { CliVersionInfo } from "../shared/types.ts";

/**
 * 화면·기록 견본이 tests/fixtures/cli/<provider>/<version>/ 에 있고 해석기 시험을 거친 버전.
 * 새 버전을 넣을 때는 그 폴더에 실제 화면·기록을 함께 넣는다(tests/cli-fixtures.test.ts 가 둘이 맞는지 본다).
 */
export const VERIFIED_CLI_VERSIONS: Record<"claude" | "codex", string[]> = {
  claude: ["2.1.316", "2.1.319", "2.1.322", "2.1.323"],
  codex: ["0.166.0"],
};

export const CLI_PROVIDERS: readonly CliProvider[] = ["claude", "codex"];
/** --version 이 이보다 늦으면 버전을 모르는 것으로 둔다. 서버 응답을 붙잡지 않는다. */
export const CLI_VERSION_TIMEOUT_MS = 3_000;
/** 기록 파일 이름. 데이터 홈(~/.iamceo) 안에 둔다. */
export const CLI_VERSION_LEDGER = "cli-versions.json";
const LEDGER_LIMIT = 50;

/** `claude --version`(예: "2.1.322 (Claude Code)")·`codex --version`(예: "codex-cli 0.166.0")의 첫 버전 번호. */
export function parseCliVersion(output: string): string | null {
  const match = /(?:^|[^\d.])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)(?![\d.])/.exec(output);
  return match ? match[1]! : null;
}

export function isVerifiedCliVersion(provider: CliProvider, version: string | null): boolean {
  return version !== null && VERIFIED_CLI_VERSIONS[provider].includes(version);
}

/** 이름만 주면 서버 설정과 같은 방법(PATH 와 흔한 설치 폴더)으로 찾는다. 없으면 null. */
export function resolveCliBinary(provider: CliProvider, configured?: string): string | null {
  const command = configured?.trim() || provider;
  try { return resolveCliExecutable(command); } catch { return null; }
}

/** `<bin> --version` 한 번. 실패·시간 초과·0 아닌 종료는 null(버전 모름). 모델 호출이나 로그인 없이 끝나는 명령이다. */
export async function readCliVersionOutput(path: string, timeoutMs = CLI_VERSION_TIMEOUT_MS): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 환경은 서버의 것을 그대로 쓴다. 비우면 Claude Code 가 키체인에 빈 계정 항목을 만들 수 있다.
    const child = Bun.spawn([path, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    // 손주 프로세스가 출력 관을 쥐고 있으면 읽기가 끝나지 않는다. 읽기도 제한 시간과 겨룬다.
    const deadline = new Promise<null>(resolve => {
      timer = setTimeout(() => { try { child.kill(); } catch { /* 이미 끝났다 */ } resolve(null); }, Math.max(1, timeoutMs));
    });
    const read = (async () => {
      const output = await new Response(child.stdout).text();
      return await child.exited === 0 ? output.trim().slice(0, 200) || null : null;
    })().catch(() => null);
    return await Promise.race([read, deadline]);
  } catch { return null; }
  finally { if (timer) clearTimeout(timer); }
}

interface LedgerEntry { firstSeenAt: string; lastSeenAt: string }
interface Ledger { version: 1; seen: Record<CliProvider, Record<string, LedgerEntry>> }

function emptyLedger(): Ledger { return { version: 1, seen: { claude: {}, codex: {} } }; }

/** 깨졌거나 모르는 모양이면 빈 기록으로 본다. 기록은 진단용이라 서버를 멈출 이유가 없다. */
export function readCliVersionLedger(home: string): Ledger {
  try {
    const raw = JSON.parse(readFileSync(join(home, CLI_VERSION_LEDGER), "utf8")) as Partial<Ledger>;
    const ledger = emptyLedger();
    if (raw?.version !== 1 || typeof raw.seen !== "object" || raw.seen === null) return ledger;
    for (const provider of CLI_PROVIDERS) {
      const entries = (raw.seen as Record<string, unknown>)[provider];
      if (typeof entries !== "object" || entries === null) continue;
      for (const [version, entry] of Object.entries(entries as Record<string, unknown>)) {
        const e = entry as Partial<LedgerEntry> | null;
        if (parseCliVersion(version) !== version || typeof e?.firstSeenAt !== "string" || typeof e.lastSeenAt !== "string") continue;
        ledger.seen[provider][version] = { firstSeenAt: e.firstSeenAt, lastSeenAt: e.lastSeenAt };
      }
    }
    return ledger;
  } catch { return emptyLedger(); }
}

function writeLedger(home: string, ledger: Ledger): void {
  const path = join(home, CLI_VERSION_LEDGER);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temp, JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch {
    try { if (existsSync(temp)) unlinkSync(temp); } catch { /* 다음에 다시 쓴다 */ }
  }
}

export interface CliVersionChange { provider: CliProvider; version: string; known: boolean; firstSeenAt: string }

/**
 * 읽은 버전을 기록 파일에 남기고 처음 본 시각을 붙인다. 이번에 처음 본 버전은 changes 로 돌려준다.
 * 버전을 모르는(null) 항목은 남기지 않는다.
 */
export function recordCliVersions(home: string, infos: CliVersionInfo[], now: Date = new Date()): { infos: CliVersionInfo[]; changes: CliVersionChange[] } {
  const ledger = readCliVersionLedger(home);
  const at = now.toISOString();
  const changes: CliVersionChange[] = [];
  let dirty = false;
  const result = infos.map(info => {
    if (!info.version) return info;
    const entries = ledger.seen[info.provider];
    let entry = entries[info.version];
    if (!entry) {
      entry = entries[info.version] = { firstSeenAt: at, lastSeenAt: at };
      changes.push({ provider: info.provider, version: info.version, known: info.known, firstSeenAt: at });
      dirty = true;
    } else if (entry.lastSeenAt.slice(0, 10) !== at.slice(0, 10)) {
      // 하루 한 번만 고쳐 쓴다. 요청마다 파일을 쓰지 않는다.
      entry.lastSeenAt = at;
      dirty = true;
    }
    return { ...info, firstSeenAt: entry.firstSeenAt };
  });
  for (const provider of CLI_PROVIDERS) {
    const versions = Object.entries(ledger.seen[provider]);
    if (versions.length <= LEDGER_LIMIT) continue;
    versions.sort((a, b) => b[1].lastSeenAt.localeCompare(a[1].lastSeenAt));
    ledger.seen[provider] = Object.fromEntries(versions.slice(0, LEDGER_LIMIT));
    dirty = true;
  }
  if (dirty) writeLedger(home, ledger);
  return { infos: result, changes };
}

export interface ReadCliVersionsOptions {
  claudeBin?: string;
  codexBin?: string;
  timeoutMs?: number;
  /** 주면 처음 본 시각을 이 데이터 홈의 기록에 남기고 firstSeenAt 을 붙인다. */
  home?: string;
  now?: () => Date;
}

/** 묶음 사이 약속 5. 두 CLI 를 함께 읽는다. 설치되지 않았으면 version=null, known=false. */
export async function readCliVersions(opts: ReadCliVersionsOptions = {}): Promise<CliVersionInfo[]> {
  const timeoutMs = opts.timeoutMs ?? CLI_VERSION_TIMEOUT_MS;
  const infos = await Promise.all(CLI_PROVIDERS.map(async (provider): Promise<CliVersionInfo> => {
    const path = resolveCliBinary(provider, provider === "claude" ? opts.claudeBin : opts.codexBin);
    if (!path) return { provider, installed: false, version: null, known: false };
    const output = await readCliVersionOutput(path, timeoutMs);
    const version = output === null ? null : parseCliVersion(output);
    return { provider, installed: true, version, known: isVerifiedCliVersion(provider, version) };
  }));
  return opts.home ? recordCliVersions(opts.home, infos, opts.now?.() ?? new Date()).infos : infos;
}

/** 사람이 읽는 한 줄. 점검 화면·로그에 쓴다. */
export function describeCliVersion(info: CliVersionInfo): string {
  const name = info.provider === "claude" ? "Claude Code" : "Codex";
  if (!info.installed) return `${name}가 설치되어 있지 않습니다`;
  if (!info.version) return `${name} 버전을 확인하지 못했습니다`;
  return info.known ? `${name} ${info.version}` : `${name} ${info.version}은 확인되지 않은 CLI 버전입니다`;
}

export interface CliVersionMonitorOptions extends ReadCliVersionsOptions {
  /** 실행 파일이 바뀌었는지 다시 볼 최소 간격. 기본 30초. */
  recheckMs?: number;
  /** 처음 본 버전을 알린다. 기본은 서버 로그 한 줄. */
  onChange?: (change: CliVersionChange) => void;
  /** 읽은 결과가 앞과 달라졌다(처음 읽음 포함). 서버는 앱이 스냅샷을 다시 읽게 한다. */
  onUpdate?: (infos: CliVersionInfo[]) => void;
  clock?: () => number;
}

/**
 * 서버가 쥐는 CLI 버전 캐시. 실행 파일(실제 경로·크기·수정 시각)이 바뀔 때만 --version 을 다시 부른다.
 * snapshot() 은 기다리지 않는다: 마지막으로 아는 값을 돌려주고, 낡았으면 뒤에서 다시 읽는다.
 */
export class CliVersionMonitor {
  private last: CliVersionInfo[] | undefined;
  private key = "";
  private checkedAt = -Infinity;
  private inflight: Promise<CliVersionInfo[]> | null = null;
  private readonly clock: () => number;

  constructor(private readonly options: CliVersionMonitorOptions = {}) {
    this.clock = options.clock ?? Date.now;
  }

  /** 실행 파일 신원. 바뀌면(업데이트·다른 설치) 버전을 다시 읽는다. */
  private identity(): string {
    return CLI_PROVIDERS.map(provider => {
      const path = resolveCliBinary(provider, provider === "claude" ? this.options.claudeBin : this.options.codexBin);
      if (!path) return `${provider}:-`;
      try {
        const real = realpathSync(path);
        const stat = statSync(real);
        return `${provider}:${real}:${stat.size}:${stat.mtimeMs}`;
      } catch { return `${provider}:${path}:?`; }
    }).join("|");
  }

  snapshot(): CliVersionInfo[] | undefined {
    if (this.clock() - this.checkedAt >= (this.options.recheckMs ?? 30_000)) void this.refresh().catch(() => undefined);
    return this.last;
  }

  /** 지금 읽는다. 겹친 부름은 하나로 합친다. 실행 파일이 그대로면 앞 값을 쓴다. */
  refresh(force = false): Promise<CliVersionInfo[]> {
    if (this.inflight) return this.inflight;
    this.checkedAt = this.clock();
    const key = this.identity();
    if (!force && this.last && key === this.key) return Promise.resolve(this.last);
    const run = (async () => {
      const infos = await readCliVersions({ claudeBin: this.options.claudeBin, codexBin: this.options.codexBin, timeoutMs: this.options.timeoutMs });
      let recorded = infos;
      if (this.options.home) {
        const { infos: withSeen, changes } = recordCliVersions(this.options.home, infos, this.options.now?.() ?? new Date());
        recorded = withSeen;
        for (const change of changes) (this.options.onChange ?? logCliVersionChange)(change);
      }
      // 버전을 못 읽었으면(시간 초과 등) 다음 확인 때 다시 묻는다.
      this.key = recorded.some(info => info.installed && !info.version) ? "" : key;
      const changed = JSON.stringify(recorded) !== JSON.stringify(this.last);
      this.last = recorded;
      if (changed) try { this.options.onUpdate?.(recorded); } catch { /* 알림 실패가 버전 기록을 막지 않는다 */ }
      return recorded;
    })().finally(() => { this.inflight = null; });
    this.inflight = run;
    return run;
  }
}

export function logCliVersionChange(change: CliVersionChange): void {
  const name = change.provider === "claude" ? "Claude Code" : "Codex";
  if (change.known) console.info(`[cli] ${name} ${change.version} 처음 확인 — 견본으로 확인된 버전입니다`);
  else console.warn(`[cli] ${name} ${change.version} 처음 확인 — 확인되지 않은 CLI 버전입니다(견본 없음). 화면 해석이 어긋나면 이 버전부터 보세요`);
}

/** 서버 문맥이 들고 다니는 모양. 시험은 가짜를 넣는다. */
export type CliVersionSource = Pick<CliVersionMonitor, "snapshot" | "refresh">;
