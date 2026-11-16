// 이 Mac 의 Tailscale 이 꺼져 있는지 본다. 꺼져 있으면 iPhone 에서 서버에 닿지 못하는데, 서버는 127.0.0.1 로 멀쩡히 떠 있어
// 아무도 까닭을 모른다. 주소를 여는 일은 http.ts 의 syncHosts 가 하고, 여기서는 그 관측으로 '꺼짐'만 판정한다.
import type { TailnetStatus } from "../shared/types.ts";

/** 부팅 직후 Tailscale 이 늦게 올라오는 동안에는 알리지 않는다. */
export const TAILNET_OFF_GRACE_MS = 60_000;
export const TAILNET_OFF_TITLE = "IAMCEO · Tailscale이 꺼져 있습니다";
export const TAILNET_OFF_BODY = "iPhone에서 연결할 수 없습니다. 이 Mac의 Tailscale을 켜 주세요.";
/**
 * 0.2.7(D4-3): 꺼진 채 이만큼 이어지면 iPhone 에도 알린다(APNs·알림 중계는 Tailscale 없이 간다). Mac 알림(60초)보다 늦게 둔다:
 * 잠깐 끊겼다 붙는 것까지 iPhone 을 울리지 않게. 예전에는 Mac 화면 알림뿐이라 Mac 앞에 없으면 아무도 몰랐다(11-13 17:51~20:30).
 */
export const TAILNET_PHONE_GRACE_MS = 180_000;

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
  /**
   * D4-3: iPhone 알림을 한 번 내고, 냈다는 것을 남긴다(phoneAlerted 가 돌려줄 값). since 는 이 꺼짐이 시작된 시각(같은 꺼짐을 가르는 열쇠).
   * 알림 저장소가 없는 서버(시험)는 넣지 않는다.
   */
  alertPhone?(since: string): void;
  /** D4-3: 다시 켜졌다. 그 꺼짐의 알림이 아직 나가지 않았으면 거두고, 냈다는 기록을 지운다. */
  clearPhone?(since: string): void;
  /**
   * D4-3: 앞 서버가 지금 이어지는 꺼짐에 iPhone 알림을 이미 냈으면 그 열쇠(since). 꺼진 채 서버를 다시 띄워도(배포·재시작) 같은 꺼짐에 다시 알리지 않는다.
   * 서버가 내려가 있는 동안 켜졌다 다시 꺼진 것은 가를 수 없어 같은 꺼짐으로 본다.
   */
  phoneAlerted?(): string | null;
  now?: () => number;
  graceMs?: number;
  phoneGraceMs?: number;
}

export class TailnetWatch {
  private readonly now: () => number;
  private readonly graceMs: number;
  private seen: TailnetSeen | null;
  private missingSince: number | null = null;
  private off = false;
  private macNotified = false;
  /** 이 꺼짐에 낸 iPhone 알림의 열쇠(꺼짐 시작 시각). 앞 서버가 낸 것도 이어받는다(deps.phoneAlerted). */
  private phoneSince: string | null;
  private readonly phoneGraceMs: number;

  constructor(private readonly deps: TailnetWatchDeps) {
    this.now = deps.now ?? Date.now;
    this.graceMs = deps.graceMs ?? TAILNET_OFF_GRACE_MS;
    this.phoneGraceMs = Math.max(this.graceMs, deps.phoneGraceMs ?? TAILNET_PHONE_GRACE_MS);
    this.seen = deps.auto ? deps.seen() : null;
    this.phoneSince = deps.auto ? deps.phoneAlerted?.() ?? null : null;
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
      // 이 꺼짐(앞 서버 때 시작한 것도)의 iPhone 알림: 아직 나가지 않았으면 거두고 기록을 지운다. 다음 꺼짐은 새로 센다.
      const alerted = this.phoneSince;
      this.phoneSince = null;
      if (alerted !== null) this.deps.clearPhone?.(alerted);
      if (!this.off) return;
      this.off = false;
      this.macNotified = false;
      console.warn("[hosts] Tailscale 이 다시 켜졌습니다");
      this.deps.changed();
      return;
    }
    this.missingSince ??= this.now();
    if (!this.off && this.now() - this.missingSince >= this.graceMs) {
      this.off = true;
      console.warn(`[hosts] Tailscale 주소가 ${Math.round(this.graceMs / 1000)}초 넘게 잡히지 않습니다. 켜질 때까지 iPhone 에서 연결할 수 없습니다`);
      // 꺼짐마다 한 번. Mac 알림은 서버를 다시 띄운 뒤 같은 꺼짐에 한 번 더 가는 것은 괜찮다(Mac 앞에 있는 사람에게만 보인다. iPhone 알림은 아래에서 기록으로 막는다).
      this.macNotified = this.deps.notify(TAILNET_OFF_TITLE, TAILNET_OFF_BODY);
      this.deps.changed();
    }
    // D4-3: 더 오래 꺼져 있으면 iPhone 에도 한 번(꺼짐마다, 서버를 다시 띄워도). 화면 필드는 그대로다.
    if (this.off && this.phoneSince === null && this.deps.alertPhone && this.now() - this.missingSince >= this.phoneGraceMs) {
      this.phoneSince = new Date(this.missingSince).toISOString();
      this.deps.alertPhone(this.phoneSince);
    }
  }

  /** Tailscale 주소를 연 적이 없거나 주소를 직접 정한 설치면 null(API 에 싣지 않는다). */
  status(): TailnetStatus | null {
    if (!this.seen) return null;
    if (!this.off) return { state: "ok", lastAddress: this.seen.address };
    return { state: "off", lastAddress: this.seen.address, since: new Date(this.missingSince!).toISOString(), ...(this.macNotified ? { macNotified: true } : {}) };
  }
}
