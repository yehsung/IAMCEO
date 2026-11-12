// 이 Mac 의 Tailscale 이 꺼져 있는지 본다. 꺼져 있으면 iPhone 에서 서버에 닿지 못하는데, 서버는 127.0.0.1 로 멀쩡히 떠 있어
// 아무도 까닭을 모른다. 주소를 여는 일은 http.ts 의 syncHosts 가 하고, 여기서는 그 관측으로 '꺼짐'만 판정한다.
import type { TailnetStatus } from "../shared/types.ts";

/** 부팅 직후 Tailscale 이 늦게 올라오는 동안에는 알리지 않는다. */
export const TAILNET_OFF_GRACE_MS = 60_000;
export const TAILNET_OFF_TITLE = "IAMCEO · Tailscale이 꺼져 있습니다";
export const TAILNET_OFF_BODY = "iPhone에서 연결할 수 없습니다. 이 Mac의 Tailscale을 켜 주세요.";

/** 이 설치가 Tailscale 주소를 연 적이 있다는 기록. 연 적이 없으면 Tailscale 을 쓰지 않는 사람이라 영원히 조용하다. */
export interface TailnetSeen { address: string; at: string }

export interface TailnetWatchDeps {
  /** 서버가 Tailscale 주소를 스스로 찾는 설치인가(config.hostsAuto). 주소를 직접 정한 설치는 보지 않는다. */
  auto: boolean;
  seen(): TailnetSeen | null;
  remember(seen: TailnetSeen): void;
  /** 운영 안내를 Mac 알림으로 띄운다. 실제로 띄웠으면 true(스크립트 알림을 끈 설치는 false). */
  notify(title: string, body: string): boolean;
  /** 판정이 바뀌었다. 열려 있는 화면이 스냅샷을 다시 읽게 한다. */
  changed(): void;
  now?: () => number;
  graceMs?: number;
}

export class TailnetWatch {
  private readonly now: () => number;
  private readonly graceMs: number;
  private seen: TailnetSeen | null;
  private missingSince: number | null = null;
  private off = false;
  private macNotified = false;

  constructor(private readonly deps: TailnetWatchDeps) {
    this.now = deps.now ?? Date.now;
    this.graceMs = deps.graceMs ?? TAILNET_OFF_GRACE_MS;
    this.seen = deps.auto ? deps.seen() : null;
  }

  /**
   * 주소 동기화 한 번의 관측. detected 는 지금 확인된 Tailscale 주소, bound 는 서버가 듣고 있는 주소다.
   * 판정은 detected 로만 한다: 인터페이스가 사라져도 전에 연 소켓은 bound 에 남아 있다.
   */
  observe(detected: readonly string[], bound: readonly string[]): void {
    if (!this.deps.auto) return;
    const open = detected.find(address => bound.includes(address));
    if (open && this.seen?.address !== open) {
      const seen = { address: open, at: new Date(this.now()).toISOString() };
      this.deps.remember(seen);
      this.seen = seen;
    }
    if (!this.seen) return;
    if (detected.length > 0) {
      this.missingSince = null;
      if (!this.off) return;
      this.off = false;
      this.macNotified = false;
      console.warn("[hosts] Tailscale 이 다시 켜졌습니다");
      this.deps.changed();
      return;
    }
    this.missingSince ??= this.now();
    if (this.off || this.now() - this.missingSince < this.graceMs) return;
    this.off = true;
    console.warn(`[hosts] Tailscale 주소가 ${Math.round(this.graceMs / 1000)}초 넘게 잡히지 않습니다. 켜질 때까지 iPhone 에서 연결할 수 없습니다`);
    // 꺼짐마다 한 번. 서버를 다시 띄운 뒤 같은 꺼짐에 한 번 더 가는 것은 괜찮다.
    this.macNotified = this.deps.notify(TAILNET_OFF_TITLE, TAILNET_OFF_BODY);
    this.deps.changed();
  }

  /** Tailscale 주소를 연 적이 없거나 주소를 직접 정한 설치면 null(API 에 싣지 않는다). */
  status(): TailnetStatus | null {
    if (!this.seen) return null;
    if (!this.off) return { state: "ok", lastAddress: this.seen.address };
    return { state: "off", lastAddress: this.seen.address, since: new Date(this.missingSince!).toISOString(), ...(this.macNotified ? { macNotified: true } : {}) };
  }
}
