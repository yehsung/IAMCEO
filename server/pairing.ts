import { randomInt } from "node:crypto";

/** 헷갈리는 글자(0·O·1·I·L)를 뺀 32자. 8자리 = 40비트. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const PAIR_CODE_LENGTH = 8;
export const PAIR_CODE_TTL_MS = 5 * 60_000;
const MAX_OPEN_CODES = 5;
const FAIL_WINDOW_MS = 5 * 60_000;
const MAX_FAILS = 10;

export type ClaimResult = "ok" | "invalid" | "limited";

/**
 * 폰 짝 맺기. Mac 화면의 QR 에는 5분 동안 한 번만 쓰는 코드만 담고, 접속 코드는 그 코드를 낸 기기에만 돌려준다.
 * 서버가 다시 켜지면 코드는 사라진다(화면에서 새 QR 을 만들면 된다).
 */
export class Pairing {
  private readonly codes = new Map<string, number>();
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** 전역 인증 회전 시 미사용 QR도 모두 폐기한다. 실패 제한은 유지한다. */
  invalidate(): void {
    this.codes.clear();
  }

  start(): { code: string; expiresAt: number } {
    this.prune();
    while (this.codes.size >= MAX_OPEN_CODES) {
      const oldest = this.codes.keys().next().value;
      if (oldest === undefined) break;
      this.codes.delete(oldest);
    }
    let code = "";
    do {
      code = Array.from({ length: PAIR_CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    } while (this.codes.has(code));
    const expiresAt = this.now() + PAIR_CODE_TTL_MS;
    this.codes.set(code, expiresAt);
    return { code, expiresAt };
  }

  /** 맞으면 코드를 지운다(한 번만). 같은 주소에서 5분에 10번 틀리면 잠시 막는다. */
  claim(raw: string, from: string): ClaimResult {
    const t = this.now();
    const recent = (this.failures.get(from) ?? []).filter((at) => t - at < FAIL_WINDOW_MS);
    if (recent.length >= MAX_FAILS) {
      this.failures.set(from, recent);
      return "limited";
    }
    this.prune();
    const code = normalizePairCode(raw);
    if (code.length === PAIR_CODE_LENGTH && this.codes.has(code)) {
      this.codes.delete(code);
      this.failures.delete(from);
      return "ok";
    }
    recent.push(t);
    this.failures.set(from, recent);
    return "invalid";
  }

  private prune(): void {
    const t = this.now();
    for (const [code, expiresAt] of this.codes) if (expiresAt <= t) this.codes.delete(code);
  }
}

export function normalizePairCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/** 폰이 닿을 수 있는 Tailscale 주소만 고른다(100.64.0.0/10, fd7a:115c:a1e0::/48). */
export function tailnetUrls(urls: string[]): string[] {
  return urls.filter((url) => {
    try {
      const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
      if (host.startsWith("fd7a:115c:a1e0:")) return true;
      const parts = host.split(".").map(Number);
      return parts.length === 4 && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
    } catch {
      return false;
    }
  });
}

type Reverse = (ip: string) => Promise<string[]>;

const defaultReverse: Reverse = async (ip) => {
  const { Resolver } = await import("node:dns/promises");
  const resolver = new Resolver({ timeout: 1500, tries: 1 });
  resolver.setServers(["100.100.100.100"]); // Tailscale MagicDNS
  return resolver.reverse(ip);
};

const nameCache = new Map<string, { name: string | null; at: number }>();
const NAME_TTL_MS = 5 * 60_000;

/**
 * 폰(iOS)은 100.x 주소로 가는 평문 HTTP 를 막는다(ATS). MagicDNS 이름(<기기>.<tailnet>.ts.net)은 앱이 ts.net 에만
 * 예외를 걸 수 있으므로, Tailscale IPv4 주소마다 그 이름 주소를 앞에 붙인다. 이름을 못 찾으면 IP 주소만 남긴다.
 */
export async function withMagicDnsNames(urls: string[], reverse: Reverse = defaultReverse, now: () => number = Date.now): Promise<string[]> {
  const named: string[] = [];
  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    const ip = parsed.hostname;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) continue;
    let cached = nameCache.get(ip);
    if (!cached || now() - cached.at > NAME_TTL_MS) {
      const names = await reverse(ip).catch(() => [] as string[]);
      const name = names.map((n) => n.replace(/\.$/, "").toLowerCase()).find((n) => n.endsWith(".ts.net")) ?? null;
      cached = { name, at: now() };
      nameCache.set(ip, cached);
    }
    if (cached.name) named.push(`${parsed.protocol}//${cached.name}${parsed.port ? `:${parsed.port}` : ""}`);
  }
  return [...new Set([...named, ...urls])];
}
