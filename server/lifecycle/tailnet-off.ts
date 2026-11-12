// 수명 명령(uninstall·'완전히 멈추기', rollback, 낮은 판으로 바꾸는 upgrade)이 Tailscale 의 HTTPS 주소(tailscale serve)를 끈다.
//
// `tailscale serve --bg` 설정은 서버가 아니라 tailscaled 에 남는다. 그래서
// - 제거한 뒤에도 https://<기기>.ts.net(443) → 127.0.0.1:<포트> 가 tailnet 에 열려 있고, --purge 는 그 기록까지 지워 다시 설치하면 '꺼짐'으로 보인다.
// - 이 설정을 모르는 옛 판(HTTPS 이전)으로 되돌리면, serve 를 거친 tailnet 기기의 요청을 그 판이 127.0.0.1(이 Mac)의 요청으로 본다
//   (옛 판의 접속 코드 교체·모두 끊기는 실제 상대 주소만 본다).
// 서버가 답하면 이 Mac 에서 POST /api/tailnet/https {enabled:false} 로 끄게 하고, 답하지 않거나 그 경로를 모르면(404, 옛 서버)
// DB 의 기록을 읽어 TailnetHttps.disable() 과 같은 판정으로 이 서버가 만든 설정일 때만 `tailscale serve --https=443 off` 를 직접 부른다.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { parseTailnetHttpsRecord, TAILNET_HTTPS_KEY, TailnetHttps, type SavedTailnetHttps, type TailscaleRunner } from "../tailnet-https.ts";
import type { TailnetHttpsStatus } from "../../shared/types.ts";
import { localBase } from "./runtime.ts";

/** 끄지 못했을 때 대표에게 알리는 남은 명령. */
export const TAILNET_SERVE_OFF_COMMAND = "tailscale serve --https=443 off";

/** none: 켠 기록이 없다(할 일 없음). off: 껐거나 이 서버의 설정이 남아 있지 않다. failed: 끄지 못했다(detail 은 까닭). */
export interface TailnetOffResult { state: "none" | "off" | "failed"; detail?: string }

export interface TailnetOffDeps {
  fetch?: typeof fetch;
  /** 서버가 답하지 않을 때 직접 부르는 tailscale. 시험은 가짜를 넣는다(IAMCEO_TEST=1 이면 기본 실행기도 진짜를 부르지 않는다). */
  run?: TailscaleRunner;
  log?: (line: string) => void;
}

function dbPath(home: string): string { return join(home, "iamceo.db"); }

/** 데이터 폴더의 DB 에서 HTTPS 기록을 읽는다(읽기 전용). DB·표·기록이 없거나 읽지 못하면 null. */
export function savedTailnetHttps(home: string): SavedTailnetHttps | null {
  if (!existsSync(dbPath(home))) return null;
  let db: Database | undefined;
  try {
    db = new Database(dbPath(home), { readonly: true });
    const row = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(TAILNET_HTTPS_KEY);
    return row ? parseTailnetHttpsRecord(row.value) : null;
  } catch { return null; } finally { db?.close(); }
}

/** 서버 없이 끈 뒤 DB 의 기록을 지운다. 못 지우면 다음에 뜬 서버가 '지워짐'으로 보고 지운다(그래서 실패를 알리지 않는다). */
function clearSaved(home: string): void {
  let db: Database | undefined;
  try {
    db = new Database(dbPath(home), { readwrite: true, create: false });
    db.exec("PRAGMA busy_timeout = 2000");
    db.query("DELETE FROM settings WHERE key = ?").run(TAILNET_HTTPS_KEY);
  } catch { /* 위 설명 */ } finally { db?.close(); }
}

function failed(status: TailnetHttpsStatus | null, fallback: string): TailnetOffResult {
  return { state: "failed", detail: status?.problem?.message ?? fallback };
}

/** 켠 기록이 있으면 HTTPS 주소를 끈다. 기록이 없으면 아무것도 부르지 않는다. */
export async function turnOffTailnetHttps(config: Config, home: string, deps: TailnetOffDeps = {}): Promise<TailnetOffResult> {
  const saved = savedTailnetHttps(home);
  if (!saved) return { state: "none" };
  const fetchImpl = deps.fetch ?? fetch;
  // 1. 서버가 답하면 서버에게 끄게 한다(이 Mac 의 loopback 요청. 서버가 켠 상태·기록을 함께 정리한다).
  try {
    const response = await fetchImpl(`${localBase(config)}/api/tailnet/https`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(90_000),
      headers: { Authorization: `Bearer ${config.accessCode}`, "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }),
    });
    if (response.status !== 404) {
      const body = await response.json().catch(() => null) as TailnetHttpsStatus | null;
      if (response.ok && body?.state === "off" && !body.problem) return { state: "off" };
      return failed(response.ok ? body : null, `HTTP ${response.status}`);
    }
  } catch { /* 서버가 답하지 않는다: 아래에서 직접 끈다 */ }
  // 2. 서버 없이(또는 이 경로를 모르는 옛 서버): 같은 판정으로 이 서버가 만든 설정일 때만 지운다. 남의 설정은 건드리지 않는다.
  let record: SavedTailnetHttps | null = saved;
  const https = new TailnetHttps({ port: () => config.port, loopbackListening: () => true, home: config.home,
    load: () => record, save: value => { record = value; }, ...(deps.run ? { run: deps.run } : {}), log: deps.log ?? (() => {}) });
  const status = await https.disable();
  if (status.state === "off" && !status.problem) { clearSaved(home); return { state: "off" }; }
  return failed(status, "tailscale");
}
