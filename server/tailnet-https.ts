// C8: iPhone 연결을 Tailscale 의 HTTPS 주소로.
//
// 대표가 설정에서 켤 때만 `tailscale serve` 로 이 Mac 의 서버를 tailnet 안의 https://<기기>.<tailnet>.ts.net 에 낸다
// (443 → http://127.0.0.1:<서버 포트>). 이 Mac 의 Tailscale 설정을 바꾸는 일이라 서버가 스스로 켜지 않는다.
// 켜져 있고 확인되면 연결 QR 의 주소 맨 앞에 그 주소를 싣는다(출시된 Mac·iPhone 앱도 고치지 않고 그 순서대로 쓴다).
// 끄기도 같은 자리에서 하며, 이 서버를 가리키는 설정만 지운다. 443 을 다른 설정이 쓰고 있으면 건드리지 않는다.
//
// 기존 http 주소(Tailscale 주소의 7878)는 그대로 듣는다. 이미 http 로 연결한 iPhone 은 끊기지 않고, 새 QR 로 다시 연결하면 https 로 옮겨 간다.
// 시험은 `run` 을 바꿔 넣는다. IAMCEO_TEST=1 에서는 넣지 않았어도 진짜 tailscale 명령을 부르지 않는다.
import { existsSync } from "node:fs";
import { ERROR_CODES } from "../shared/error-codes.ts";
import type { TailnetHttpsProblem, TailnetHttpsProblemCode, TailnetHttpsStatus } from "../shared/types.ts";
import { TAILSCALE_CLI_PATHS } from "./config.ts";

export interface TailscaleResult {
  /** 끝난 코드. 시간이 지나 끊었거나 띄우지 못했으면 null. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  /** tailscale 명령을 찾지 못했다. */
  missing?: boolean;
}
export type TailscaleRunner = (args: string[], timeoutMs: number) => Promise<TailscaleResult>;

/**
 * 서버가 켠 HTTPS 주소의 기록(settings 표의 키 하나. DB 판 번호를 올리지 않는다).
 * home 은 켠 설치의 데이터 폴더다. 기록은 DB 에 있어 사본(백업·'설치 전 실제 흐름 확인'의 시험 서버)으로 옮겨 가므로,
 * 같은 데이터 폴더에서 켠 기록일 때만 그 포트를 '이 서버의 옛 포트'로 믿는다(아래 classifyServe 의 savedPort).
 */
export interface SavedTailnetHttps { url: string; port: number; at: string; home?: string }

/** settings 표의 키. */
export const TAILNET_HTTPS_KEY = "tailnetHttps";

/** settings 의 HTTPS 기록 한 줄을 읽는다. 모양이 어긋난 값은 없는 것으로 본다(저장소와 수명 명령이 함께 쓴다). */
export function parseTailnetHttpsRecord(value: string): SavedTailnetHttps | null {
  try {
    const saved = JSON.parse(value) as { url?: unknown; port?: unknown; at?: unknown; home?: unknown } | null;
    return saved && typeof saved.url === "string" && saved.url.startsWith("https://") && typeof saved.port === "number" && Number.isInteger(saved.port)
      && typeof saved.at === "string" ? { url: saved.url, port: saved.port, at: saved.at, ...(typeof saved.home === "string" ? { home: saved.home } : {}) } : null;
  } catch { return null; }
}

export interface TailnetHttpsDeps {
  /** 서버가 듣는 포트. serve 가 넘길 곳이다. */
  port: () => number;
  /** 서버가 127.0.0.1 에서 듣는가. serve 는 이 Mac 안의 127.0.0.1 로 넘긴다. */
  loopbackListening: () => boolean;
  load(): SavedTailnetHttps | null;
  save(value: SavedTailnetHttps | null): void;
  /** 이 서버의 데이터 폴더(config.home). 켠 기록에 함께 남기고, 기록의 포트를 믿을지 가린다. */
  home?: string;
  run?: TailscaleRunner;
  now?: () => number;
  log?: (line: string) => void;
}

/** 이 정도 지난 상태는 다시 본다. 설정 화면과 QR 이 연달아 물어도 tailscale 명령을 매번 띄우지 않는다. */
export const TAILNET_HTTPS_CACHE_MS = 10_000;
/** 짧은 조회(status·serve status)의 제한 시간. */
const QUICK_TIMEOUT_MS = 5_000;
/** 처음 켤 때 인증서를 받는 데 걸리는 시간(Let's Encrypt). 넘기면 '인증서를 받지 못했습니다'. */
const CERT_TIMEOUT_MS = 90_000;
const SERVE_TIMEOUT_MS = 20_000;
export const TAILNET_ADMIN_DNS_URL = "https://login.tailscale.com/admin/dns";

/** 문제 코드마다 대표에게 보일 문장. 문장은 shared/error-codes.ts 한 곳에 둔다. */
export function tailnetHttpsProblem(code: TailnetHttpsProblemCode): TailnetHttpsProblem {
  return { code, message: ERROR_CODES[code].ko, ...(code === "tailnet_https_disabled" || code === "tailnet_https_cert_failed" ? { link: TAILNET_ADMIN_DNS_URL } : {}) };
}

// ---- tailscale 명령 ----

function findTailscale(): string | null {
  const found = Bun.which("tailscale");
  for (const bin of [...new Set([...(found ? [found] : []), ...TAILSCALE_CLI_PATHS])]) if (existsSync(bin)) return bin;
  return null;
}

/** 기본 실행기. 표준 입력을 닫아 대화형 질문(예: 'serve 를 켜려면 이 주소에서 허락하세요')에서 멈추지 않게 하고, 제한 시간에 끊는다. */
export const runTailscale: TailscaleRunner = async (args, timeoutMs) => {
  if (process.env.IAMCEO_TEST === "1") return { code: null, stdout: "", stderr: "", missing: true };
  const bin = findTailscale();
  if (!bin) return { code: null, stdout: "", stderr: "", missing: true };
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    return { code: null, stdout: "", stderr: "", missing: true };
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* 이미 끝났다 */ } }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout as ReadableStream).text(),
      new Response(child.stderr as ReadableStream).text(),
      child.exited,
    ]);
    return { code: timedOut ? null : code, stdout, stderr, ...(timedOut ? { timedOut } : {}) };
  } finally { clearTimeout(timer); }
};

// ---- 상태 읽기 ----

interface ServeHandler { Proxy?: unknown }
interface ServeConfig {
  TCP?: Record<string, { HTTPS?: unknown; TCPForward?: unknown } | undefined>;
  Web?: Record<string, { Handlers?: Record<string, ServeHandler | undefined> } | undefined>;
  AllowFunnel?: Record<string, unknown>;
}

/**
 * 443 의 serve 설정이 누구 것인가. ours: 이 서버의 지금 포트를 가리킨다. ours_other_port: 이 서버가 전에 켠 기록의 포트를
 * 가리킨다(그 뒤 서버 포트가 바뀌었다). ours_funnel: 이 서버(지금 포트나 기록의 포트)를 가리키는데 Funnel 로 인터넷에도 열려 있다
 * (IAMCEO 는 Funnel 을 켜지 않는다. 누가 켰다). 그 밖에 127.0.0.1 의 다른 포트를 가리키는 것은 남의 서비스일 수 있어 other 다.
 */
export type Serve443 = "none" | "ours" | "ours_other_port" | "ours_funnel" | "other";

function proxyPort(target: unknown): number | null {
  if (typeof target !== "string") return null;
  const m = /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):(\d{1,5})\/?$/i.exec(target.trim());
  return m ? Number(m[1]) : null;
}

/** `tailscale serve status --json` 의 답에서 443 을 읽는다. 모르는 모양은 '다른 설정'으로 본다(건드리지 않는다). */
export function classifyServe(raw: unknown, dnsName: string, port: number, savedPort?: number): Serve443 {
  if (!raw || typeof raw !== "object") return "none";
  const config = raw as ServeConfig;
  const host = `${dnsName}:443`;
  const tcp = config.TCP?.["443"];
  const webEntries = Object.entries(config.Web ?? {}).filter(([key, value]) => value && key.toLowerCase().endsWith(":443"));
  if (!tcp && webEntries.length === 0) return "none";
  // 다른 이름·여러 경로·TCP 넘기기는 이 서버가 만든 모양이 아니다.
  if (!tcp || tcp.HTTPS !== true || tcp.TCPForward !== undefined) return "other";
  if (webEntries.length !== 1 || webEntries[0]![0].toLowerCase() !== host) return "other";
  const handlers = Object.entries(webEntries[0]![1]?.Handlers ?? {});
  if (handlers.length !== 1 || handlers[0]![0] !== "/") return "other";
  const target = proxyPort(handlers[0]![1]?.Proxy);
  if (target === null) return "other";
  const mine: Serve443 = target === port ? "ours" : savedPort !== undefined && target === savedPort ? "ours_other_port" : "other";
  // 인터넷에 연 설정(funnel). 이 서버를 가리키면 '지워짐'으로 보지 않고 따로 알린다(이 서버가 인터넷에 열려 있다).
  const funnel = !!config.AllowFunnel && Object.entries(config.AllowFunnel).some(([key, on]) => on === true && key.toLowerCase().endsWith(":443"));
  return funnel && mine !== "other" ? "ours_funnel" : mine;
}

interface Inspection {
  problem?: TailnetHttpsProblemCode;
  /** 이 기기의 MagicDNS 이름(끝 점 없음, 소문자). */
  dnsName?: string;
  /** tailnet 이 이 기기의 HTTPS 인증서를 내줄 수 있는가(CertDomains). */
  certificates?: boolean;
  serve?: Serve443;
}

function tooOld(result: TailscaleResult): boolean {
  return /flag provided but not defined|unknown flag/i.test(result.stderr);
}

export class TailnetHttps {
  private readonly run: TailscaleRunner;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private cached: { status: TailnetHttpsStatus; at: number } | null = null;
  private refreshing: Promise<TailnetHttpsStatus> | null = null;
  /** 켜기·끄기는 한 번에 하나. 그동안 조회는 'pending' 으로 답한다. */
  private operation: Promise<TailnetHttpsStatus> | null = null;
  /** 바깥에서 설정이 지워져 꺼진 것으로 바꿨다는 알림. 대표가 다시 켜거나 끌 때까지 꺼진 상태에 붙인다(메모리에만). */
  private removedNotice = false;

  constructor(private readonly deps: TailnetHttpsDeps) {
    this.run = deps.run ?? runTailscale;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (line => console.warn(line));
  }

  private stamp(status: Omit<TailnetHttpsStatus, "checkedAt">): TailnetHttpsStatus {
    return { ...status, checkedAt: new Date(this.now()).toISOString() };
  }

  private off(problem?: TailnetHttpsProblemCode): TailnetHttpsStatus {
    return this.stamp({ state: "off", ...(problem ? { problem: tailnetHttpsProblem(problem) } : {}) });
  }

  /** tailscale 의 상태와 443 의 serve 설정을 읽는다. 아무것도 바꾸지 않는다. */
  private async inspect(): Promise<Inspection> {
    const status = await this.run(["status", "--json"], QUICK_TIMEOUT_MS);
    if (status.missing) return { problem: "tailscale_cli_missing" };
    let parsed: { BackendState?: unknown; Self?: { DNSName?: unknown }; CertDomains?: unknown } | null = null;
    try { parsed = JSON.parse(status.stdout); } catch { parsed = null; }
    if (!parsed || typeof parsed !== "object") return { problem: status.code === 0 ? "tailnet_https_failed" : "tailscale_not_running" };
    if (parsed.BackendState !== "Running") return { problem: "tailscale_not_running" };
    const dnsName = typeof parsed.Self?.DNSName === "string" ? parsed.Self.DNSName.replace(/\.$/, "").toLowerCase() : "";
    if (!dnsName.endsWith(".ts.net")) return { problem: "tailnet_https_disabled" };
    const domains = Array.isArray(parsed.CertDomains) ? parsed.CertDomains.filter((d): d is string => typeof d === "string").map(d => d.replace(/\.$/, "").toLowerCase()) : [];
    const certificates = domains.includes(dnsName);
    const serve = await this.run(["serve", "status", "--json"], QUICK_TIMEOUT_MS);
    if (serve.missing || serve.code !== 0) return { dnsName, certificates, problem: tooOld(serve) ? "tailscale_too_old" : "tailnet_https_failed" };
    let config: unknown = {};
    const text = serve.stdout.trim();
    if (text) {
      try { config = JSON.parse(text); } catch { return { dnsName, certificates, problem: "tailnet_https_failed" }; }
    }
    // 기록의 포트는 같은 데이터 폴더에서 켠 기록일 때만 믿는다. 라이브 DB 사본으로 띄운 시험 서버가 라이브의 설정을 '내 옛 포트'로 보고
    // 끄거나(serve off) 가져가지(지우고 제 포트로 다시 켜기) 않게 한다.
    const saved = this.deps.load();
    const savedPort = saved && saved.home === this.deps.home ? saved.port : undefined;
    return { dnsName, certificates, serve: classifyServe(config, dnsName, this.deps.port(), savedPort) };
  }

  private urlOf(dnsName: string): string { return `https://${dnsName}`; }

  private record(url: string, at: string): SavedTailnetHttps {
    return { url, port: this.deps.port(), at, ...(this.deps.home !== undefined ? { home: this.deps.home } : {}) };
  }

  /** 기록과 지금 설정을 맞춰 본 상태. 켠 기록이 없으면 명령을 부르지 않는다. */
  private async refresh(): Promise<TailnetHttpsStatus> {
    const saved = this.deps.load();
    if (!saved) return this.off(this.removedNotice ? "tailnet_https_removed" : undefined);
    const seen = await this.inspect();
    if (seen.problem) {
      // Tailscale 이 꺼졌거나 답하지 않는다. 켠 기록은 두고, 확인될 때까지 QR 에는 싣지 않는다.
      return this.stamp({ state: "pending", url: saved.url, problem: tailnetHttpsProblem(seen.problem) });
    }
    if (seen.serve === "none" || seen.serve === "other") {
      // 누군가 지웠거나(tailscale serve reset) 다른 설정으로 바꿨다. 기록을 지운다. 다른 설정은 건드리지 않는다.
      this.deps.save(null);
      this.removedNotice = true;
      this.log(`[https] Tailscale 의 HTTPS 설정이 이 서버를 가리키지 않아 꺼진 것으로 봅니다(${seen.serve})`);
      return this.off("tailnet_https_removed");
    }
    const url = this.urlOf(seen.dnsName!);
    // 이 서버가 인터넷에 열려 있다. 기록은 지우지 않고(이 서버의 설정이다) QR 에는 싣지 않으며 끄는 법을 알린다.
    if (seen.serve === "ours_funnel") {
      this.log("[https] 이 서버를 가리키는 Tailscale HTTPS 설정이 Funnel 로 인터넷에 열려 있습니다");
      return this.stamp({ state: "pending", url, problem: tailnetHttpsProblem("tailnet_https_funnel") });
    }
    if (seen.serve === "ours_other_port") return this.stamp({ state: "pending", url, problem: tailnetHttpsProblem("tailnet_https_port_changed") });
    if (!seen.certificates) return this.stamp({ state: "pending", url, problem: tailnetHttpsProblem("tailnet_https_disabled") });
    if (url !== saved.url || saved.port !== this.deps.port() || saved.home !== this.deps.home) this.deps.save(this.record(url, saved.at));
    return this.stamp({ state: "on", url });
  }

  /** 설정 화면이 읽는 상태. maxAgeMs 안에 본 것이면 다시 묻지 않는다. 겹친 조회는 하나로 합친다. */
  async status(maxAgeMs = TAILNET_HTTPS_CACHE_MS): Promise<TailnetHttpsStatus> {
    if (this.operation) return this.stamp({ ...(this.cached?.status ?? this.off()), state: "pending" });
    if (this.cached && this.now() - this.cached.at < maxAgeMs) return this.cached.status;
    this.refreshing ??= this.refresh().then(status => { this.cached = { status, at: this.now() }; return status; })
      .finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** 연결 QR 에 맨 앞에 실을 HTTPS 주소. 켜져 있고 지금 확인될 때만. 켠 기록이 없으면 명령을 부르지 않는다. */
  async pairingUrl(): Promise<string | null> {
    if (!this.deps.load()) return null;
    const status = await this.status(60_000);
    return status.state === "on" && status.url ? status.url : null;
  }

  enable(): Promise<TailnetHttpsStatus> { return this.exclusive(() => this.turnOn()); }
  disable(): Promise<TailnetHttpsStatus> { return this.exclusive(() => this.turnOff()); }

  private exclusive(run: () => Promise<TailnetHttpsStatus>): Promise<TailnetHttpsStatus> {
    const previous = this.operation ?? Promise.resolve(null);
    const next = previous.catch(() => null).then(() => { this.removedNotice = false; return run(); })
      .then(status => { this.cached = { status, at: this.now() }; return status; });
    this.operation = next;
    void next.finally(() => { if (this.operation === next) this.operation = null; }).catch(() => undefined);
    return next;
  }

  private async turnOn(): Promise<TailnetHttpsStatus> {
    const seen = await this.inspect();
    if (seen.problem) return this.off(seen.problem);
    if (!seen.certificates) return this.off("tailnet_https_disabled");
    // 이 서버를 가리키지만 인터넷에 열려 있다. 그 위에 겹쳐 켜지 않고 끄는 법을 알린다.
    if (seen.serve === "ours_funnel") return this.off("tailnet_https_funnel");
    if (seen.serve === "other") return this.off("tailnet_https_port_taken");
    if (!this.deps.loopbackListening()) return this.off("tailnet_https_no_loopback");
    const dnsName = seen.dnsName!;
    // 인증서를 먼저 받아 둔다. 처음 붙는 iPhone 이 인증서를 기다리다 시간이 지나 QR 을 버리지 않게 한다.
    // 인증서(공개 정보)만 표준 출력으로 받고 개인 키는 어디에도 쓰지 않는다. 출력은 기록에 남기지 않는다.
    const cert = await this.run(["cert", "--cert-file", "-", dnsName], CERT_TIMEOUT_MS);
    if (cert.missing) return this.off("tailscale_cli_missing");
    if (cert.code !== 0 || !cert.stdout.includes("BEGIN CERTIFICATE")) {
      this.log(`[https] HTTPS 인증서를 받지 못했습니다(${cert.timedOut ? "시간 초과" : `종료 ${cert.code}`})`);
      return this.off(tooOld(cert) ? "tailscale_too_old" : "tailnet_https_cert_failed");
    }
    const port = this.deps.port();
    if (seen.serve !== "ours") {
      // 이 서버가 전에 만든 설정이 옛 포트를 가리키면 먼저 지운다(같은 443 에 겹쳐 쓰지 않는다).
      if (seen.serve === "ours_other_port") await this.run(["serve", "--https=443", "off"], SERVE_TIMEOUT_MS);
      const serve = await this.run(["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`], SERVE_TIMEOUT_MS);
      if (serve.missing) return this.off("tailscale_cli_missing");
      if (serve.code !== 0) {
        this.log(`[https] tailscale serve 를 켜지 못했습니다(${serve.timedOut ? "시간 초과" : `종료 ${serve.code}`})`);
        return this.off(tooOld(serve) ? "tailscale_too_old" : "tailnet_https_failed");
      }
    }
    // 켠 뒤 다시 읽어 이 서버를 가리키는지 본다. 아니면 켠 것으로 치지 않는다.
    const after = await this.inspect();
    if (after.problem || after.serve !== "ours" || after.dnsName !== dnsName) {
      this.log(`[https] 켠 뒤 확인에서 이 서버를 가리키는 설정을 찾지 못했습니다(${after.problem ?? after.serve ?? "?"})`);
      return this.off(after.problem ?? "tailnet_https_failed");
    }
    const url = this.urlOf(dnsName);
    this.deps.save(this.record(url, new Date(this.now()).toISOString()));
    this.log(`[https] ${url} → http://127.0.0.1:${port} 를 켰습니다`);
    return this.stamp({ state: "on", url });
  }

  private async turnOff(): Promise<TailnetHttpsStatus> {
    const saved = this.deps.load();
    const seen = await this.inspect();
    if (seen.problem === "tailscale_cli_missing") {
      // 명령이 없으면 Tailscale 쪽 설정도 없다. 기록만 지운다.
      this.deps.save(null);
      return this.off();
    }
    if (seen.problem) return this.stamp({ state: saved ? "pending" : "off", ...(saved ? { url: saved.url } : {}), problem: tailnetHttpsProblem(seen.problem) });
    if (seen.serve === "ours" || seen.serve === "ours_other_port" || seen.serve === "ours_funnel") {
      // Funnel 이 붙은 이 서버의 설정도 지운다(대표가 끄기를 골랐고, 지우면 인터넷 공개도 닫힌다). 못 지우면 Funnel 을 끄는 법을 알린다.
      const result = await this.run(["serve", "--https=443", "off"], SERVE_TIMEOUT_MS);
      const after = result.code === 0 ? await this.inspect() : null;
      if (!after || after.problem || (after.serve !== "none" && after.serve !== "other")) {
        this.log(`[https] tailscale serve 를 끄지 못했습니다(${result.timedOut ? "시간 초과" : `종료 ${result.code}`})`);
        const problem = seen.serve === "ours_funnel" || after?.serve === "ours_funnel" ? "tailnet_https_funnel" : "tailnet_https_off_failed";
        return this.stamp({ state: saved ? "pending" : "off", ...(saved ? { url: saved.url } : {}), problem: tailnetHttpsProblem(problem) });
      }
      this.log("[https] Tailscale 의 HTTPS 설정을 껐습니다");
    }
    // 'other' 는 이 서버가 만든 설정이 아니다. 건드리지 않고 기록만 지운다.
    this.deps.save(null);
    return this.off();
  }
}
