// B3 스스로 점검: 판정(사실 → 점검표), 사실 모으기(로그인 기록·자동 시작·백업), GET /api/doctor, `iamceo doctor`(서버가 꺼져 있어도).
// 진짜 launchctl·Claude·Codex·Antigravity CLI 를 부르지 않는다: 판정은 주입한 사실로, 모으기는 임시 홈과 가짜 명령으로 시험한다.
// Antigravity CLI(agy) 자리는 늘 정해 준다(가짜이거나 없는 경로). 비워 두면 설정이 이 Mac 에 깔린 진짜 agy 를 찾아 Gemini 줄이 Mac 마다 달라진다.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DOCTOR_CHECK_IDS, type DoctorReport } from "../shared/types.ts";
import { Bus } from "../server/bus.ts";
import { defaultCoreBin, loadConfig, updateConfigFile, VERSION, type Config } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { askServerDoctor, DOCTOR_GEMINI_CHECK_ID, doctorChecks, doctorReport, formatDoctorReport, geminiLastActiveAt, localDoctorFacts, newestBackupAt, probeLogin, probeService, serverDoctorFacts, type DoctorFacts } from "../server/doctor.ts";
import { geminiStatusFromPayload, geminiStatusPath } from "../server/runner/gemini-status.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const NOW = new Date("2026-11-13T03:00:00.000Z");
const HOUR = 3_600_000;

function temp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** 모두 정상인 Mac. 시험마다 한 군데만 바꾼다. */
function healthy(patch: Partial<DoctorFacts> = {}): DoctorFacts {
  return {
    now: NOW,
    server: { state: "running", ready: true, version: "0.2.4" },
    engine: { installed: true, available: true, version: "0.5.2", detail: null, status: { state: "ok", version: "0.5.2", expectedVersion: "0.5.2" } },
    providers: { claude: { installed: true, login: "yes" }, codex: { installed: true, login: "yes" } },
    codexInUse: true,
    cliVersions: [
      { provider: "claude", installed: true, version: "2.1.322", known: true },
      { provider: "codex", installed: true, version: "0.166.0", known: true },
    ],
    tailscale: { auto: true, address: "100.64.0.7", everOpened: true, status: { state: "ok", lastAddress: "100.64.0.7" } },
    service: { state: "running", pid: 42 },
    backup: { lastSuccessAt: new Date(NOW.getTime() - 3 * HOUR).toISOString(), failing: false, failures: 0, cause: null, intervalMs: 24 * HOUR, homeAgeMs: 30 * 24 * HOUR },
    disk: { freeBytes: 120e9, totalBytes: 500e9 },
    ...patch,
  };
}

const byId = (facts: DoctorFacts, lang: "ko" | "en" = "ko") => Object.fromEntries(doctorChecks(facts, lang).map(check => [check.id, check]));

describe("점검 판정", () => {
  test("항목 id 는 약속한 아홉 개이고 순서가 고정이다. 모두 정상이면 고치는 법이 없다", () => {
    expect([...DOCTOR_CHECK_IDS].sort()).toEqual(["backup", "claude", "cli_version", "codex", "disk", "engine", "server", "service", "tailscale"]);
    const checks = doctorChecks(healthy());
    expect(checks.map(check => check.id)).toEqual([...DOCTOR_CHECK_IDS]);
    for (const check of checks) {
      expect(check.state).toBe("ok");
      expect(check.fix).toBeUndefined();
      expect(check.title.length).toBeGreaterThan(0);
    }
    const report = doctorReport(healthy(), "ko", "0.2.4");
    expect(report).toEqual({ checkedAt: NOW.toISOString(), serverVersion: "0.2.4", checks });
    expect(byId(healthy()).claude!.detail).toBe("설치됨 · 2.1.322 · 로그인됨");
    expect(byId(healthy()).cli_version!.detail).toContain("Claude Code 2.1.322 · Codex 0.166.0");
  });

  test("서버: 꺼짐·처음·시작 중·접속 코드 불일치·옛 서버", () => {
    expect(byId(healthy({ server: { state: "down" } })).server).toMatchObject({ state: "fail", detail: "서버에 연결하지 못했습니다(꺼져 있음)" });
    expect(byId(healthy({ server: { state: "down" } })).server!.fix).toContain("이 Mac에서 시작");
    expect(byId(healthy({ server: { state: "missing_home" } })).server!.state).toBe("fail");
    expect(byId(healthy({ server: { state: "starting" } })).server!.state).toBe("warn");
    expect(byId(healthy({ server: { state: "running", ready: false, version: "0.2.4" } })).server!.state).toBe("warn");
    expect(byId(healthy({ server: { state: "auth" } })).server!.state).toBe("fail");
    expect(byId(healthy({ server: { state: "running", ready: true, version: "0.2.3", legacy: true } })).server).toMatchObject({ state: "ok" });
    // 서버가 꺼져 있는데 자동 시작도 등록돼 있지 않으면 그것도 문제다.
    expect(byId(healthy({ server: { state: "down" }, service: { state: "missing" } })).service!.state).toBe("fail");
    expect(byId(healthy({ service: { state: "missing" } })).service!.state).toBe("warn");
  });

  test("실행 엔진: 없음·응답 없음·버전 다름·연결 실패·서버 꺼짐", () => {
    const engine = (patch: Partial<DoctorFacts["engine"]>) => byId(healthy({ engine: { ...healthy().engine, ...patch } })).engine!;
    expect(engine({ installed: false })).toMatchObject({ state: "fail" });
    expect(engine({ installed: false }).fix).toContain("brew reinstall --cask yehsung/tap/iamceo");
    expect(engine({ status: { state: "unresponsive", expectedVersion: "0.5.2" } }).state).toBe("fail");
    const mismatch = engine({ status: { state: "version_mismatch", version: "0.5.1", expectedVersion: "0.5.2" } });
    expect(mismatch.state).toBe("warn");
    expect(mismatch.detail).toContain("0.5.1");
    expect(mismatch.detail).toContain("0.5.2");
    expect(engine({ available: false, status: null, detail: "소켓 없음" })).toMatchObject({ state: "fail", detail: "사용할 수 없음 · 소켓 없음" });
    expect(engine({ available: null, status: null }).state).toBe("unknown");
  });

  test("Claude·Codex: 설치와 로그인. Codex 는 쓰는 팀장이 없으면 선택 기능이다", () => {
    const claude = (p: DoctorFacts["providers"]["claude"]) => byId(healthy({ providers: { ...healthy().providers, claude: p } })).claude!;
    expect(claude({ installed: false, login: "no" }).state).toBe("fail");
    expect(claude({ installed: true, login: "no" })).toMatchObject({ state: "warn", detail: "설치됨 · 2.1.322 · 로그인 기록을 찾지 못했습니다" });
    expect(claude({ installed: true, login: "unknown" }).state).toBe("unknown");
    const codex = (p: DoctorFacts["providers"]["codex"], codexInUse: boolean | null) => byId(healthy({ providers: { ...healthy().providers, codex: p }, codexInUse })).codex!;
    const optional = codex({ installed: false, login: "no" }, false);
    expect(optional.state).toBe("unknown");
    expect(optional.fix).toBeUndefined();
    expect(codex({ installed: false, login: "no" }, null).state).toBe("unknown");
    expect(codex({ installed: false, login: "no" }, true).state).toBe("fail");
    expect(codex({ installed: true, login: "no" }, true).state).toBe("warn");
    expect(codex({ installed: true, login: "no" }, false).state).toBe("unknown");
  });

  test("CLI 버전: 견본이 없는 버전이면 '확인되지 않은 CLI 버전'", () => {
    const unverified = byId(healthy({ cliVersions: [{ provider: "claude", installed: true, version: "2.1.400", known: false }, { provider: "codex", installed: false, version: null, known: false }] })).cli_version!;
    expect(unverified.state).toBe("warn");
    expect(unverified.detail).toBe("확인되지 않은 CLI 버전: Claude Code 2.1.400");
    expect(unverified.fix).toBeDefined();
    expect(byId(healthy({ cliVersions: null })).cli_version!.state).toBe("unknown");
    expect(byId(healthy({ cliVersions: [{ provider: "claude", installed: true, version: null, known: false }] })).cli_version!.state).toBe("unknown");
    expect(byId(healthy({ cliVersions: [{ provider: "claude", installed: false, version: null, known: false }] })).cli_version!.state).toBe("unknown");
  });

  test("Tailscale: 꺼짐은 iPhone 을 쓰던 설치에서만 문제다", () => {
    const ts = (patch: Partial<DoctorFacts["tailscale"]>) => byId(healthy({ tailscale: { ...healthy().tailscale, ...patch } })).tailscale!;
    expect(ts({ status: { state: "off", lastAddress: "100.64.0.7" }, address: null })).toMatchObject({ state: "fail", fix: "메뉴 막대에서 Tailscale을 켜세요." });
    expect(ts({ status: null, address: null, everOpened: true }).state).toBe("fail");
    expect(ts({ status: null, address: null, everOpened: false }).state).toBe("unknown");
    expect(ts({ status: null, address: null, auto: false }).state).toBe("unknown");
    expect(ts({ status: null }).detail).toBe("켜짐 · 100.64.0.7");
  });

  test("합치기(N): HTTPS 주소는 켜 두었을 때만 Tailscale 항목의 설명 끝에 붙고, 판정·항목 수는 그대로다", () => {
    const at = NOW.toISOString();
    const ts = (https: DoctorFacts["tailscale"]["https"], lang: "ko" | "en" = "ko") =>
      doctorReport(healthy({ tailscale: { ...healthy().tailscale, https } }), lang).checks.find(c => c.id === "tailscale")!;
    // 켠 적이 없으면(off, 까닭 없음) 지금과 똑같다.
    expect(ts(null).detail).toBe("켜짐 · 100.64.0.7");
    expect(ts({ state: "off", checkedAt: at }).detail).toBe("켜짐 · 100.64.0.7");
    // 켜짐: 주소(이 Mac 의 tailnet 이름)는 싣지 않는다.
    expect(ts({ state: "on", url: "https://mac.tail0000.ts.net", checkedAt: at })).toMatchObject({ state: "ok", detail: "켜짐 · 100.64.0.7 · HTTPS 주소 켜짐" });
    expect(ts({ state: "on", url: "https://mac.tail0000.ts.net", checkedAt: at }).detail).not.toContain("ts.net");
    expect(ts({ state: "on", checkedAt: at }, "en").detail).toBe("On · 100.64.0.7 · HTTPS address on");
    // 확인이 안 되면 설정 화면의 HTTPS 줄과 같은 문장. 판정(ok)과 고치는 법은 Tailscale 자체의 것 그대로.
    const removed = ts({ state: "off", problem: { code: "tailnet_https_removed", message: "Tailscale에서 HTTPS 설정이 지워져 꺼진 것으로 바꿨습니다. 다시 쓰려면 켜기를 눌러 주세요" }, checkedAt: at });
    expect(removed).toMatchObject({ state: "ok", detail: "켜짐 · 100.64.0.7 · HTTPS 주소 확인 필요: Tailscale에서 HTTPS 설정이 지워져 꺼진 것으로 바꿨습니다. 다시 쓰려면 켜기를 눌러 주세요" });
    expect(removed.fix).toBeUndefined();
    expect(ts({ state: "pending", url: "https://mac.tail0000.ts.net", problem: { code: "tailscale_not_running", message: "꺼짐" }, checkedAt: at }, "en").detail)
      .toBe("On · 100.64.0.7 · HTTPS address needs attention (see the HTTPS address row in Settings › Connection)");
    // Tailscale 이 꺼져 있으면 그 안내만(HTTPS 는 덧붙이지 않는다).
    expect(doctorReport(healthy({ tailscale: { ...healthy().tailscale, status: { state: "off", lastAddress: "100.64.0.7" }, https: { state: "on", checkedAt: at } } }), "ko")
      .checks.find(c => c.id === "tailscale")!.detail).toBe("꺼져 있습니다 · iPhone에서 연결할 수 없습니다");
  });

  test("이 서버의 HTTPS 주소가 Funnel 로 인터넷에 열려 있으면 Tailscale 항목은 확인 필요와 끄는 법이다(리뷰 https-5)", () => {
    const at = NOW.toISOString();
    const funnel = { state: "pending" as const, url: "https://mac.tail0000.ts.net", problem: { code: "tailnet_https_funnel" as const, message: "인터넷에도 열려 있습니다" }, checkedAt: at };
    const ts = (patch: Partial<DoctorFacts["tailscale"]>, lang: "ko" | "en" = "ko") =>
      doctorReport(healthy({ tailscale: { ...healthy().tailscale, https: funnel, ...patch } }), lang).checks.find(c => c.id === "tailscale")!;
    expect(ts({})).toMatchObject({ state: "warn", detail: "켜짐 · 100.64.0.7 · HTTPS 주소 확인 필요: 인터넷에도 열려 있습니다" });
    expect(ts({}).fix).toContain("tailscale funnel --https=443 off");
    expect(ts({}, "en").fix).toContain("tailscale funnel --https=443 off");
    expect(ts({ address: null, auto: false }).state).toBe("warn");
    // Tailscale 이 꺼져 있으면 그 안내가 먼저다.
    expect(ts({ status: { state: "off", lastAddress: "100.64.0.7" } }).state).toBe("fail");
  });

  test("백업·저장 공간", () => {
    const backup = (patch: Partial<NonNullable<DoctorFacts["backup"]>>) => byId(healthy({ backup: { ...healthy().backup!, ...patch } })).backup!;
    expect(backup({ failing: true, failures: 3, cause: "ENOSPC" })).toMatchObject({ state: "fail", detail: "정기 백업이 3번 이어서 실패했습니다 (ENOSPC)" });
    expect(backup({ lastSuccessAt: new Date(NOW.getTime() - 72 * HOUR).toISOString() })).toMatchObject({ state: "warn", detail: "마지막 백업이 3일 전입니다" });
    expect(backup({ lastSuccessAt: null, homeAgeMs: HOUR }).state).toBe("unknown");
    expect(backup({ lastSuccessAt: null, homeAgeMs: 30 * 24 * HOUR }).state).toBe("warn");
    expect(backup({}).detail).toBe("마지막 백업 3시간 전");
    expect(byId(healthy({ backup: null })).backup!.state).toBe("unknown");
    const disk = (freeBytes: number) => byId(healthy({ disk: { freeBytes, totalBytes: 500e9 } })).disk!;
    expect(disk(0.5e9).state).toBe("fail");
    expect(disk(3e9)).toMatchObject({ state: "warn", detail: "남은 공간 3.0 GB" });
    expect(disk(120e9)).toMatchObject({ state: "ok", detail: "남은 공간 120 GB" });
    expect(byId(healthy({ disk: null })).disk!.state).toBe("unknown");
  });

  test("고치는 법은 일반 사용자가 할 수 있는 동작만 가리킨다(개발자 명령 없음). 영어로도 낸다", () => {
    const variants: DoctorFacts[] = [
      healthy({ server: { state: "down" }, service: { state: "missing" }, engine: { installed: false, available: null, version: null, detail: null, status: null } }),
      healthy({ providers: { claude: { installed: false, login: "no" }, codex: { installed: false, login: "no" } }, codexInUse: true }),
      healthy({ tailscale: { auto: true, address: null, everOpened: false, status: null }, backup: { lastSuccessAt: null, failing: true, failures: 1, cause: null, intervalMs: 1, homeAgeMs: 1 }, disk: { freeBytes: 1, totalBytes: 2 } }),
      healthy({ cliVersions: [{ provider: "codex", installed: true, version: "9.9.9", known: false }], service: { state: "not_loaded" }, server: { state: "auth" } }),
    ];
    for (const facts of variants) {
      for (const lang of ["ko", "en"] as const) {
        for (const check of doctorChecks(facts, lang)) {
          const text = `${check.detail ?? ""} ${check.fix ?? ""}`;
          expect(text).not.toMatch(/bun run|setup:core|iamceo open/);
          // 문제나 확인 필요에는 고치는 법이 붙는다.
          if (check.state === "fail" || check.state === "warn") expect(check.fix).toBeDefined();
        }
      }
    }
    const en = byId(healthy({ server: { state: "down" } }), "en");
    expect(en.server).toMatchObject({ title: "Server", state: "fail" });
    expect(en.server!.fix).toContain("Start on this Mac");
  });

  test("명령줄 출력: 표시와 고치는 법, 요약 줄", () => {
    const report = doctorReport(healthy({ server: { state: "down" }, disk: { freeBytes: 3e9, totalBytes: 9e9 } }), "ko", "0.2.4");
    const text = formatDoctorReport(report, "ko");
    expect(text).toContain("✗ 서버 — 서버에 연결하지 못했습니다(꺼져 있음)");
    expect(text).toContain("    고치는 법: Mac 앱의 연결 화면에서 '이 Mac에서 시작'을 누르세요.");
    expect(text).toContain("! 저장 공간 — 남은 공간 3.0 GB");
    expect(text.trim().split("\n").at(-1)).toBe("문제 1 · 확인 필요 1");
    expect(formatDoctorReport(doctorReport(healthy(), "en"), "en").trim().split("\n").at(-1)).toBe("All good.");
  });
});

/** Gemini 팀장의 상태줄 기록을 래퍼가 하듯 둔다. */
function putGeminiStatus(home: string, memberId: string, at: Date, payload: Record<string, unknown>): void {
  const path = geminiStatusPath(home, memberId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(geminiStatusFromPayload(memberId, payload, at)), { mode: 0o600 });
}
const CONVERSATION = "0b6f6a52-3c1e-4d7a-9a51-7f2d5c1e8a90";

describe("점검 판정: Gemini(Antigravity CLI)", () => {
  const AGY = { provider: "gemini" as const, installed: true, version: "1.5.14", known: true };
  const withGemini = (patch: Partial<DoctorFacts> = {}) => healthy({
    providers: { ...healthy().providers, gemini: { installed: true, login: "unknown" } },
    cliVersions: [...healthy().cliVersions!, AGY], ...patch,
  });
  const ids = (facts: DoctorFacts) => doctorChecks(facts).map(check => check.id);
  const WITH_GEMINI = ["server", "engine", "claude", "codex", "gemini", "cli_version", "tailscale", "service", "backup", "disk"];

  test("깔려 있지 않고 쓰는 팀장도 없으면 항목이 없다(점검표가 예전 그대로다)", () => {
    expect(DOCTOR_GEMINI_CHECK_ID).toBe("gemini");
    expect([...DOCTOR_CHECK_IDS]).not.toContain(DOCTOR_GEMINI_CHECK_ID);
    for (const facts of [
      healthy(), healthy({ geminiInUse: false }), healthy({ geminiInUse: null }),
      healthy({ providers: { ...healthy().providers, gemini: { installed: false, login: "unknown" } }, geminiInUse: false }),
      // 버전 목록에 '설치되지 않음' 줄이 실려 와도 마찬가지다.
      healthy({ cliVersions: [...healthy().cliVersions!, { provider: "gemini", installed: false, version: null, known: false }] }),
    ]) {
      expect(ids(facts)).toEqual([...DOCTOR_CHECK_IDS]);
      for (const check of doctorChecks(facts)) expect(check.state).toBe("ok");
      expect(byId(facts).cli_version!.detail).toBe("Claude Code 2.1.322 · Codex 0.166.0 (확인된 버전)");
    }
  });

  test("깔려 있으면 Codex 다음 줄에 붙는다. 로그인은 판정하지 않고, 쓰지 않으면 아무것도 권하지 않는다", () => {
    expect(ids(withGemini())).toEqual(WITH_GEMINI);
    const idle = byId(withGemini({ geminiInUse: false })).gemini!;
    expect(idle).toEqual({ id: "gemini", state: "unknown", title: "Gemini", detail: "Antigravity CLI 설치됨 · 1.5.14 · 로그인은 세션을 열 때 확인합니다" });
    // 로그인 사실(login)이 무엇이든 판정에 쓰지 않는다: Codex 의 기준이 흘러들어와도 '로그인됨'·'로그인 기록 없음'이라 하지 않는다.
    for (const login of ["yes", "no", "unknown"] as const) {
      const check = byId(withGemini({ providers: { ...healthy().providers, gemini: { installed: true, login } }, geminiInUse: false })).gemini!;
      expect(check).toEqual(idle);
    }
    // 버전을 못 읽었으면 버전 없이 적는다.
    expect(byId(withGemini({ cliVersions: healthy().cliVersions })).gemini!.detail).toBe("Antigravity CLI 설치됨 · 로그인은 세션을 열 때 확인합니다");
    expect(byId(withGemini({ geminiInUse: false }), "en").gemini).toEqual({ id: "gemini", state: "unknown", title: "Gemini", detail: "Antigravity CLI installed · 1.5.14 · sign-in is checked when a session starts" });
    // 나머지 항목은 그대로 정상이다.
    for (const check of doctorChecks(withGemini())) if (check.id !== "gemini") expect(check.state).toBe("ok");
  });

  test("쓰는 팀장이 있으면: 없을 때는 문제, 있을 때는 첫 설정 안내, 최근에 대화가 돌았으면 정상", () => {
    const missing = byId(healthy({ geminiInUse: true })).gemini!;
    expect(missing).toMatchObject({ state: "fail", title: "Gemini", detail: "Gemini를 쓰는 총괄·팀장이 있는데 Antigravity CLI(agy)를 찾지 못했습니다" });
    expect(missing.fix).toBe("Antigravity CLI를 설치한 뒤(curl -fsSL https://antigravity.google/cli/install.sh | bash) 이 Mac의 터미널에서 agy를 한 번 실행해 로그인과 첫 설정(약관 동의)을 끝내세요.");
    expect(ids(healthy({ geminiInUse: true }))).toEqual(WITH_GEMINI);
    const en = byId(healthy({ geminiInUse: true }), "en").gemini!;
    expect(en.detail).toBe("Some sessions use Gemini, but the Antigravity CLI (agy) was not found");
    expect(en.fix).toBe("Install the Antigravity CLI (curl -fsSL https://antigravity.google/cli/install.sh | bash), then run agy once in Terminal on this Mac to sign in and finish the first-run setup (terms).");

    const waiting = byId(withGemini({ geminiInUse: true })).gemini!;
    expect(waiting).toMatchObject({ state: "unknown", detail: "Antigravity CLI 설치됨 · 1.5.14 · 로그인은 세션을 열 때 확인합니다" });
    expect(waiting.fix).toBe("Gemini 팀장이 시작하지 못하고 멈추면 이 Mac의 터미널에서 agy를 한 번 실행해 로그인과 첫 설정(약관 동의)을 끝내세요.");
    expect(byId(withGemini({ geminiInUse: true }), "en").gemini!.fix)
      .toBe("If a Gemini session stops right after starting, run agy once in Terminal on this Mac to sign in and finish the first-run setup (terms).");

    const active = byId(withGemini({ geminiInUse: true, geminiActiveAt: new Date(NOW.getTime() - 3 * HOUR).toISOString() })).gemini!;
    expect(active).toEqual({ id: "gemini", state: "ok", title: "Gemini", detail: "Antigravity CLI 설치됨 · 1.5.14 · 마지막 대화 3시간 전" });
    expect(byId(withGemini({ geminiInUse: true, geminiActiveAt: new Date(NOW.getTime() - 3 * HOUR).toISOString() }), "en").gemini!.detail)
      .toBe("Antigravity CLI installed · 1.5.14 · last conversation 3 h ago");
    // 오래된 흔적(7일 넘음)이나 깨진 시각은 근거로 치지 않는다.
    for (const stale of [new Date(NOW.getTime() - 8 * 24 * HOUR).toISOString(), "not-a-date"]) {
      expect(byId(withGemini({ geminiInUse: true, geminiActiveAt: stale })).gemini!.state).toBe("unknown");
    }
  });

  test("CLI 버전: Antigravity CLI 는 이름이 Codex 로 적히지 않고, 쓰는 팀장이 있을 때만 '확인되지 않은 버전'으로 알린다", () => {
    expect(byId(withGemini()).cli_version).toMatchObject({ state: "ok", detail: "Claude Code 2.1.322 · Codex 0.166.0 · Antigravity CLI 1.5.14 (확인된 버전)" });
    const newer = [...healthy().cliVersions!, { provider: "gemini" as const, installed: true, version: "1.6.0", known: false }];
    const inUse = byId(withGemini({ cliVersions: newer, geminiInUse: true })).cli_version!;
    expect(inUse).toMatchObject({ state: "warn", detail: "확인되지 않은 CLI 버전: Antigravity CLI 1.6.0" });
    expect(inUse.fix).toBeDefined();
    // 깔려만 있고 쓰지 않으면(또는 모르면) 버전이 달라도 알리지 않는다.
    for (const geminiInUse of [false, null, undefined]) {
      expect(byId(withGemini({ cliVersions: newer, geminiInUse })).cli_version).toMatchObject({ state: "ok", detail: "Claude Code 2.1.322 · Codex 0.166.0 (확인된 버전)" });
    }
    // Claude·Codex 의 알림은 그대로다(Gemini 를 쓰든 말든).
    const codexNew = [{ provider: "claude" as const, installed: true, version: "2.1.322", known: true }, { provider: "codex" as const, installed: true, version: "9.9.9", known: false }, AGY];
    expect(byId(withGemini({ cliVersions: codexNew, geminiInUse: false })).cli_version!.detail).toBe("확인되지 않은 CLI 버전: Codex 9.9.9");
  });

  test("고치는 법에 개발자 명령이 없고, 문제·확인 필요에는 고치는 법이 붙는다", () => {
    const variants = [healthy({ geminiInUse: true }), withGemini({ geminiInUse: true }), withGemini({ geminiInUse: false }),
      withGemini({ geminiInUse: true, cliVersions: [{ provider: "gemini", installed: true, version: "1.6.0", known: false }] })];
    for (const facts of variants) for (const lang of ["ko", "en"] as const) for (const check of doctorChecks(facts, lang)) {
      expect(`${check.detail ?? ""} ${check.fix ?? ""}`).not.toMatch(/bun run|setup:core|iamceo open/);
      if (check.state === "fail" || check.state === "warn") expect(check.fix).toBeDefined();
      for (const key of Object.keys(check)) expect(["id", "state", "title", "detail", "fix"]).toContain(key);
    }
    const text = formatDoctorReport(doctorReport(healthy({ geminiInUse: true }), "ko", "0.2.10"), "ko");
    expect(text).toContain("✗ Gemini — Gemini를 쓰는 총괄·팀장이 있는데 Antigravity CLI(agy)를 찾지 못했습니다");
    expect(text.trim().split("\n").at(-1)).toBe("문제 1 · 확인 필요 0");
  });
});

describe("사실 모으기", () => {
  test("Gemini 의 로그인은 판정하지 않는다: Codex 의 기준(OPENAI_API_KEY·auth.json)으로도, ~/.gemini 의 파일로도 보지 않는다", () => {
    const home = temp("iamceo-doctor-gemini-login-");
    const codexHome = temp("iamceo-doctor-gemini-codex-");
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { id_token: "x" } }));
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(join(home, ".gemini", "oauth_creds.json"), JSON.stringify({ access_token: "x" }));
    writeFileSync(join(home, ".gemini", "google_accounts.json"), JSON.stringify({ active: "x" }));
    // 같은 사실로 Codex 는 '로그인됨'이다. Gemini 는 어느 것으로도 판정하지 않는다.
    expect(probeLogin("codex", { userHome: home, codexHome }, {} as NodeJS.ProcessEnv)).toBe("yes");
    expect(probeLogin("gemini", { userHome: home, codexHome }, {} as NodeJS.ProcessEnv)).toBe("unknown");
    expect(probeLogin("gemini", { userHome: home, codexHome }, { OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "k" } as NodeJS.ProcessEnv)).toBe("unknown");
    expect(probeLogin("gemini", { userHome: temp("iamceo-doctor-gemini-empty-") }, {} as NodeJS.ProcessEnv)).toBe("unknown");
  });

  test("Gemini 팀장의 상태줄 기록에서 대화가 돌던 마지막 시각을 읽는다(로그인 대기·오류·대화 없는 기록은 세지 않는다)", () => {
    const home = temp("iamceo-doctor-gemini-status-");
    expect(geminiLastActiveAt(home, [])).toBeNull();
    expect(geminiLastActiveAt(home, ["m_none"])).toBeNull();
    const at = (hours: number) => new Date(NOW.getTime() - hours * HOUR);
    putGeminiStatus(home, "m_old", at(30), { conversation_id: CONVERSATION, agent_state: "idle" });
    putGeminiStatus(home, "m_new", at(2), { conversation_id: CONVERSATION, agent_state: "working" });
    // 더 새롭지만 근거가 아닌 기록들: 대화가 아직 없다, 로그인을 기다린다, 오류다, 시작하는 중이다.
    putGeminiStatus(home, "m_fresh", at(1), { session_id: "", agent_state: "idle" });
    putGeminiStatus(home, "m_auth", at(1), { conversation_id: CONVERSATION, agent_state: "authenticating" });
    putGeminiStatus(home, "m_error", at(1), { conversation_id: CONVERSATION, agent_state: "error" });
    putGeminiStatus(home, "m_init", at(1), { conversation_id: CONVERSATION, agent_state: "initializing" });
    writeFileSync(geminiStatusPath(home, "m_broken"), "{");
    const all = ["m_old", "m_new", "m_fresh", "m_auth", "m_error", "m_init", "m_broken", "m_none", "../escape"];
    expect(geminiLastActiveAt(home, all)).toBe(at(2).toISOString());
    expect(geminiLastActiveAt(home, ["m_old"])).toBe(at(30).toISOString());
    expect(geminiLastActiveAt(home, ["m_fresh", "m_auth", "m_error", "m_init", "m_broken"])).toBeNull();
    // 상태를 알려 주지 않은 기록(agent_state 없음)도 대화가 있으면 센다.
    putGeminiStatus(home, "m_plain", at(0.5), { conversation_id: CONVERSATION });
    expect(geminiLastActiveAt(home, [...all, "m_plain"])).toBe(at(0.5).toISOString());
  });

  test("서버 안에서 모으기: Gemini 는 서버가 아는 값(runtime)에 있을 때만 깔린 것으로 보고, 쓰는 팀장과 마지막 대화를 싣는다", async () => {
    const home = temp("iamceo-doctor-gemini-facts-");
    const bin = join(home, "bin");
    mkdirSync(bin);
    const agy = join(bin, "agy");
    writeFileSync(agy, "#!/bin/sh\nexit 97\n", { mode: 0o755 });
    const config = { home, dbPath: join(home, "iamceo.db"), claudeBin: join(bin, "no-claude"), codexBin: join(bin, "no-codex"), geminiBin: agy };
    const asked: unknown[] = [];
    const probes = {
      service: async () => ({ state: "unknown" as const }), disk: () => null, tailscaleAddress: () => null,
      login: (provider: string) => { asked.push(provider); return "yes" as const; },
      cliVersions: async (bins: unknown) => { asked.push(bins); return null; },
    };
    const base = { config, ready: true, engine: null, tailnet: null, tailnetSeen: false, detectedTailnet: [], codexInUse: false, probes, now: NOW };
    const core = { installed: true, available: true, version: "0.5.2", detail: null };
    const without = await serverDoctorFacts({ ...base, runtime: { backend: "core", core, providers: { claude: { installed: true }, codex: { installed: false } } } });
    expect(without.providers.gemini).toBeUndefined();
    expect([without.geminiInUse, without.geminiActiveAt]).toEqual([null, null]);
    // 버전 읽기에는 설정의 gemini 실행 파일을 넘긴다(codex 실행 파일로 읽지 않는다).
    expect(asked).toContainEqual({ claudeBin: config.claudeBin, codexBin: config.codexBin, geminiBin: agy });
    expect(asked).not.toContain("gemini");
    const installed = await serverDoctorFacts({ ...base, geminiMemberIds: [],
      runtime: { backend: "core", core, providers: { claude: { installed: true }, codex: { installed: false }, gemini: { installed: true } } } });
    expect(installed.providers.gemini).toEqual({ installed: true, login: "yes" });
    expect([installed.geminiInUse, installed.geminiActiveAt]).toEqual([false, null]);
    // 서버 값이 없으면(runtime null) 설정이 찾아 둔 실행 파일이 있는지만 본다. 설정에 없으면 찾지 않는다.
    expect((await serverDoctorFacts({ ...base, runtime: null })).providers.gemini).toEqual({ installed: true, login: "yes" });
    expect((await serverDoctorFacts({ ...base, runtime: null, config: { ...config, geminiBin: join(bin, "no-agy") } })).providers.gemini).toBeUndefined();
    expect((await serverDoctorFacts({ ...base, runtime: null, config: { ...config, geminiBin: undefined } })).providers.gemini).toBeUndefined();
    // 쓰는 팀장과 그 상태줄 기록.
    putGeminiStatus(home, "m_lead", new Date(NOW.getTime() - HOUR), { conversation_id: CONVERSATION, agent_state: "idle" });
    const used = await serverDoctorFacts({ ...base, runtime: null, geminiMemberIds: ["m_lead", "m_other"] });
    expect([used.geminiInUse, used.geminiActiveAt]).toEqual([true, new Date(NOW.getTime() - HOUR).toISOString()]);
    expect(byId(used).gemini).toMatchObject({ state: "ok", detail: "Antigravity CLI 설치됨 · 마지막 대화 1시간 전" });
  });

  test("명령줄에서 모으기: 설정이 없으면 IAMCEO_GEMINI_BIN, 그것도 없으면 agy 를 찾는다(gemini 라는 이름으로 찾지 않는다)", async () => {
    const home = temp("iamceo-doctor-gemini-local-");
    const looked: string[] = [];
    const bins: unknown[] = [];
    const probes = {
      service: async () => ({ state: "unknown" as const }), disk: () => null, tailscaleAddress: () => null, login: () => "unknown" as const,
      run: async () => ({ code: 1, stdout: "" }),
      installed: (binary: string) => { looked.push(binary); return binary.endsWith("/agy"); },
      cliVersions: async (given: unknown) => { bins.push(given); return null; },
    };
    const env = { IAMCEO_CLAUDE_BIN: "/x/claude", IAMCEO_CODEX_BIN: "/x/codex", IAMCEO_CORE_BIN: "/x/core" } as NodeJS.ProcessEnv;
    const byName = await localDoctorFacts({ home, config: null, server: { state: "missing_home" }, env, probes, now: NOW });
    expect(looked).toContain("agy");
    expect(looked).not.toContain("gemini");
    expect(bins.at(-1)).toEqual({ claudeBin: "/x/claude", codexBin: "/x/codex", geminiBin: "agy" });
    expect(byName.providers.gemini).toBeUndefined();
    expect([byName.geminiInUse, byName.geminiActiveAt]).toEqual([null, null]);
    expect(doctorChecks(byName).map(check => check.id)).toEqual([...DOCTOR_CHECK_IDS]);
    const pinned = await localDoctorFacts({ home, config: null, server: { state: "missing_home" }, env: { ...env, IAMCEO_GEMINI_BIN: "/x/agy" }, probes, now: NOW });
    expect(bins.at(-1)).toEqual({ claudeBin: "/x/claude", codexBin: "/x/codex", geminiBin: "/x/agy" });
    expect(pinned.providers.gemini).toEqual({ installed: true, login: "unknown" });
    expect(doctorChecks(pinned).map(check => check.id)).toContain("gemini");
  });

  test("로그인 기록: Claude 는 oauthAccount·credentials·환경 변수, Codex 는 auth.json. 내용은 읽어 두지 않는다", () => {
    const home = temp("iamceo-doctor-login-");
    const env = {} as NodeJS.ProcessEnv;
    expect(probeLogin("claude", { userHome: home }, env)).toBe("no");
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ numStartups: 3 }));
    expect(probeLogin("claude", { userHome: home }, env)).toBe("no");
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ numStartups: 3, oauthAccount: { accountUuid: "x" } }));
    expect(probeLogin("claude", { userHome: home }, env)).toBe("yes");
    const configDir = temp("iamceo-doctor-claude-dir-");
    expect(probeLogin("claude", { userHome: home, claudeHome: configDir }, env)).toBe("no");
    writeFileSync(join(configDir, ".credentials.json"), "{}");
    expect(probeLogin("claude", { userHome: home, claudeHome: configDir }, env)).toBe("yes");
    expect(probeLogin("claude", { userHome: temp("iamceo-doctor-empty-") }, { ANTHROPIC_API_KEY: "k" } as NodeJS.ProcessEnv)).toBe("yes");

    const codexHome = temp("iamceo-doctor-codex-");
    expect(probeLogin("codex", { userHome: home, codexHome }, env)).toBe("no");
    writeFileSync(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
    expect(probeLogin("codex", { userHome: home, codexHome }, env)).toBe("unknown");
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { id_token: "x" } }));
    expect(probeLogin("codex", { userHome: home, codexHome }, env)).toBe("yes");
  });

  test("자동 시작: launchctl print·plutil 의 답으로 판정한다(진짜 launchctl 은 부르지 않는다)", async () => {
    const userHome = temp("iamceo-doctor-service-");
    const dataHome = join(userHome, ".iamceo");
    mkdirSync(dataHome);
    const calls: string[][] = [];
    const runner = (answers: { plutil?: { code: number; stdout: string }; print: { code: number; stdout: string } }) => async (command: string[]) => {
      calls.push(command);
      return command[0]!.endsWith("plutil") ? answers.plutil ?? { code: 1, stdout: "" } : answers.print;
    };
    const opts = { userHome, uid: 501, platform: "darwin" };
    expect(await probeService(dataHome, { ...opts, run: runner({ print: { code: 113, stdout: "" } }) })).toEqual({ state: "missing" });
    expect(calls.at(-1)).toEqual(["/bin/launchctl", "print", "gui/501/com.iamceo.server"]);
    mkdirSync(join(userHome, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(userHome, "Library", "LaunchAgents", "com.iamceo.server.plist"), "<plist/>");
    const ours = { code: 0, stdout: JSON.stringify({ EnvironmentVariables: { IAMCEO_HOME: dataHome } }) };
    expect(await probeService(dataHome, { ...opts, run: runner({ plutil: ours, print: { code: 113, stdout: "" } }) })).toEqual({ state: "not_loaded" });
    const printed = "gui/501/com.iamceo.server = {\n\tactive count = 1\n\tstate = running\n\tpid = 4242\n\tenvironment = {\n\t\tPATH => /usr/bin\n\t}\n}\n";
    expect(await probeService(dataHome, { ...opts, run: runner({ plutil: ours, print: { code: 0, stdout: printed } }) })).toEqual({ state: "running", pid: 4242 });
    const stopped = "gui/501/com.iamceo.server = {\n\tstate = not running\n\tlast exit code = 78: EX_CONFIG\n}\n";
    expect(await probeService(dataHome, { ...opts, run: runner({ plutil: ours, print: { code: 0, stdout: stopped } }) })).toEqual({ state: "loaded", lastExitCode: 78 });
    const other = { code: 0, stdout: JSON.stringify({ EnvironmentVariables: { IAMCEO_HOME: join(userHome, "elsewhere") } }) };
    expect(await probeService(dataHome, { ...opts, run: runner({ plutil: other, print: { code: 0, stdout: printed } }) })).toEqual({ state: "other_home" });
    // IAMCEO_HOME 이 없는 서비스는 기본 홈(~/.iamceo)을 쓴다.
    const defaultHome = { code: 0, stdout: JSON.stringify({ EnvironmentVariables: {} }) };
    expect(await probeService(dataHome, { ...opts, run: runner({ plutil: defaultHome, print: { code: 0, stdout: printed } }) })).toEqual({ state: "running", pid: 4242 });
    expect(await probeService(dataHome, { ...opts, platform: "linux", run: runner({ print: { code: 0, stdout: printed } }) })).toEqual({ state: "unknown" });
    // 시험 환경에서 run 을 주지 않으면 진짜 launchctl 을 부르지 않는다.
    expect(process.env.IAMCEO_TEST).toBe("1");
    expect(await probeService(dataHome, { userHome, platform: "darwin" })).toEqual({ state: "unknown" });
  });

  test("가장 새 백업: 다 만든(manifest.json 이 있는) 것만 센다", () => {
    const dir = temp("iamceo-doctor-backup-");
    expect(newestBackupAt(join(dir, "none"))).toBeNull();
    const older = Date.parse("2026-11-10T00:00:00.000Z"), newer = Date.parse("2026-11-12T00:00:00.000Z"), partial = Date.parse("2026-11-13T00:00:00.000Z");
    const name = (ms: number, n: number) => `snapshot-${String(ms).padStart(13, "0")}-0000000${n}-0000-0000-0000-000000000000`;
    for (const [ms, n, done] of [[older, 1, true], [newer, 2, true], [partial, 3, false]] as const) {
      mkdirSync(join(dir, name(ms, n)));
      if (done) writeFileSync(join(dir, name(ms, n), "manifest.json"), "{}");
    }
    mkdirSync(join(dir, "not-a-snapshot"));
    expect(newestBackupAt(dir)).toBe(new Date(newer).toISOString());
  });
});

// ---- GET /api/doctor ----

function freshConfig(): Config {
  const home = temp("iamceo-doctor-http-");
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code" }, env);
  // Claude Code 는 설치된 Mac 으로 둔다: 이 시험 홈에 둔 실행 파일 자리다(부르지 않는다). 기본 설정은 PATH·/opt/homebrew/bin 에서 진짜 claude 를
  // 찾으므로, 그대로 두면 Claude 가 깔린 Mac 에서만 'ok' 이고 Claude 가 없는 CI(GitHub macOS 러너)에서는 '찾지 못함'(fail)이 된다.
  const claudeBin = join(home, "bin", "claude");
  mkdirSync(join(home, "bin"));
  writeFileSync(claudeBin, "#!/bin/sh\nexit 97\n", { mode: 0o755 });
  // Codex 는 설치되지 않은 Mac 으로 둔다(쓰는 팀장이 있을 때만 문제인지 본다).
  // Antigravity CLI 도 설치되지 않은 Mac 으로 둔다. 정해 주지 않으면 설정이 이 Mac 의 진짜 agy 를 찾아, agy 가 깔린 Mac 에서만 Gemini 줄이 생긴다.
  return { ...loadConfig(env), hosts: ["127.0.0.1"], hostsAuto: true, claudeBin, codexBin: join(home, "no-such-codex"), geminiBin: join(home, "no-such-agy") };
}

async function boot(options: { ready?: boolean; agy?: boolean } = {}) {
  const config = freshConfig();
  if (options.agy) {
    // Antigravity CLI 가 깔린 Mac: 이 시험 홈에 둔 실행 파일 자리다(부르지 않는다).
    config.geminiBin = join(config.home, "bin", "agy");
    writeFileSync(config.geminiBin, "#!/bin/sh\nexit 97\n", { mode: 0o755 });
  }
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  const orch = new Orchestrator({ config, store, runners: new Map(), notifier: () => {} });
  let ready = options.ready ?? true;
  const context = {
    config, store, bus, orch, detectHosts: () => [],
    daemon: () => ({ ready, buildId: "build", version: VERSION }),
    doctorProbes: {
      service: async () => ({ state: "running" as const, pid: 7 }),
      disk: () => ({ freeBytes: 50e9, totalBytes: 100e9 }),
      login: () => "yes" as const,
      cliVersions: async () => [{ provider: "claude" as const, installed: true, version: "2.1.322", known: true }, { provider: "codex" as const, installed: false, version: null, known: false }],
    },
  };
  let server: RunningServer = await startServer(context);
  while (server.port === 7878) { await server.stop(); server = await startServer(context); }
  cleanups.push(async () => { await server.stop(); await orch.shutdown(); store.db.close(); });
  const request = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${server.port}${path}`, { ...init, headers: { Authorization: "Bearer code", ...init.headers } });
  return { config, store, server, request, setReady: (value: boolean) => { ready = value; } };
}

describe("GET /api/doctor", () => {
  test("약속한 모양의 점검표를 준다. 서버가 아는 값과 주입한 사실을 쓴다", async () => {
    const t = await boot();
    const response = await t.request("/api/doctor");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const report = await response.json() as DoctorReport;
    expect(report.serverVersion).toBe(VERSION);
    expect(new Date(report.checkedAt).toISOString()).toBe(report.checkedAt);
    expect(report.checks.map(check => check.id)).toEqual([...DOCTOR_CHECK_IDS]);
    const checks = Object.fromEntries(report.checks.map(check => [check.id, check]));
    expect(checks.server).toMatchObject({ state: "ok", title: "서버", detail: `실행 중 · ${VERSION}` });
    expect(checks.service).toMatchObject({ state: "ok" });
    expect(checks.disk).toMatchObject({ state: "ok", detail: "남은 공간 50.0 GB" });
    expect(checks.claude!.state).toBe("ok");
    // 실행기 없는 시험 조립이라 실행 엔진은 붙어 있지 않다.
    expect(["fail", "unknown"]).toContain(checks.engine!.state);
    // 쓰는 팀장이 없으니 Codex 가 없어도 문제가 아니다.
    expect(checks.codex).toMatchObject({ state: "unknown" });
    // Tailscale 주소를 연 적이 없는 설치다.
    expect(checks.tailscale!.state).toBe("unknown");
    // 막 만든 DB 라 백업이 없는 것은 아직 문제가 아니다.
    expect(checks.backup!.state).toBe("unknown");
    for (const check of report.checks) for (const key of Object.keys(check)) expect(["id", "state", "title", "detail", "fix"]).toContain(key);
  });

  test("Codex 를 쓰는 팀장이 있는데 Codex 가 없으면 문제다. 영어로도 준다", async () => {
    const t = await boot();
    const project = t.store.createProject({ name: "코덱스", cwd: t.config.home });
    t.store.createMember({ projectId: project.id, handle: "cx", name: "코덱스 팀장", kind: "worker", cli: "codex" });
    const report = await (await t.request("/api/doctor?lang=en")).json() as DoctorReport;
    const codex = report.checks.find(check => check.id === "codex")!;
    expect(codex.state).toBe("fail");
    expect(codex.fix).toContain("npm install -g @openai/codex");
    expect(report.checks.find(check => check.id === "server")!.title).toBe("Server");
  });

  test("Gemini: Antigravity CLI 가 깔려 있으면 Codex 다음 줄에 붙고, 쓰는 팀장의 최근 대화가 있으면 정상이다", async () => {
    const t = await boot({ agy: true });
    const read = async (lang = "ko") => (await (await t.request(`/api/doctor?lang=${lang}`)).json() as DoctorReport).checks;
    const idle = await read();
    expect(idle.map(check => check.id)).toEqual(["server", "engine", "claude", "codex", "gemini", "cli_version", "tailscale", "service", "backup", "disk"]);
    // 주입한 로그인 사실(yes)을 쓰지 않는다. 쓰는 팀장이 없으니 권하는 것도 없다.
    expect(idle.find(check => check.id === "gemini")).toEqual({ id: "gemini", state: "unknown", title: "Gemini", detail: "Antigravity CLI 설치됨 · 로그인은 세션을 열 때 확인합니다" });
    const project = t.store.createProject({ name: "제미나이", cwd: t.config.home });
    const member = t.store.createMember({ projectId: project.id, handle: "gm", name: "자료 조사", kind: "worker", cli: "gemini" });
    const waiting = (await read()).find(check => check.id === "gemini")!;
    expect(waiting.state).toBe("unknown");
    expect(waiting.fix).toContain("agy를 한 번 실행해");
    expect((await read("en")).find(check => check.id === "gemini")!.fix).toContain("run agy once in Terminal");
    putGeminiStatus(t.config.home, member.id, new Date(Date.now() - 5 * 60_000), { conversation_id: CONVERSATION, agent_state: "idle" });
    expect((await read()).find(check => check.id === "gemini")).toEqual({ id: "gemini", state: "ok", title: "Gemini", detail: "Antigravity CLI 설치됨 · 마지막 대화 5분 전" });
    // 보관한 프로젝트의 팀장은 '쓰는 팀장'으로 치지 않는다.
    t.store.patchProject(project.id, { archived: true });
    expect((await read()).find(check => check.id === "gemini")!.fix).toBeUndefined();
  });

  test("Gemini: 쓰는 팀장이 있는데 Antigravity CLI 가 없으면 문제다. 팀장이 없으면 줄이 없다", async () => {
    const t = await boot();
    expect(((await (await t.request("/api/doctor")).json()) as DoctorReport).checks.some(check => check.id === "gemini")).toBe(false);
    const project = t.store.createProject({ name: "제미나이", cwd: t.config.home });
    t.store.createMember({ projectId: project.id, handle: "gm", name: "자료 조사", kind: "worker", cli: "gemini" });
    const report = await (await t.request("/api/doctor")).json() as DoctorReport;
    expect(report.checks.find(check => check.id === "gemini")).toMatchObject({ state: "fail", detail: "Gemini를 쓰는 총괄·팀장이 있는데 Antigravity CLI(agy)를 찾지 못했습니다" });
    // Codex 줄은 Gemini 팀장 때문에 문제가 되지 않는다.
    expect(report.checks.find(check => check.id === "codex")).toMatchObject({ state: "unknown" });
  });

  test("인증·검증·시작 중", async () => {
    const t = await boot();
    expect((await fetch(`http://127.0.0.1:${t.server.port}/api/doctor`)).status).toBe(401);
    expect((await t.request("/api/doctor?x=1")).status).toBe(400);
    expect((await t.request("/api/doctor", { method: "POST" })).status).toBe(405);
    t.setReady(false);
    const starting = await t.request("/api/doctor");
    expect(starting.status).toBe(503);
    expect((await starting.json() as { code?: string }).code).toBe("STARTING");
  });

  test("명령줄의 서버 묻기: 점검표·옛 서버·시작 중·꺼짐을 가른다", async () => {
    const t = await boot();
    const base = `http://127.0.0.1:${t.server.port}`;
    const answer = await askServerDoctor(base, "code", "ko");
    expect(answer.kind).toBe("report");
    expect((await askServerDoctor(base, "wrong", "ko")).kind).toBe("auth");
    const legacy: typeof fetch = Object.assign(async (input: RequestInfo | URL) => String(input).includes("/api/doctor")
      ? new Response(JSON.stringify({ error: "없는 경로입니다" }), { status: 404 })
      : Response.json({ ok: true, version: "0.2.3" }), { preconnect: () => {} });
    expect(await askServerDoctor(base, "code", "ko", legacy)).toEqual({ kind: "legacy", version: "0.2.3" });
    t.setReady(false);
    expect((await askServerDoctor(base, "code", "ko")).kind).toBe("starting");
    expect((await askServerDoctor("http://127.0.0.1:1", "code", "ko", fetch, 1_000)).kind).toBe("down");
  });
});

// ---- iamceo doctor ----

const BIN = resolve(import.meta.dir, "..", "bin", "iamceo.ts");

function cliEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const userHome = temp("iamceo-doctor-user-");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return {
    ...env, IAMCEO_HOME: home, IAMCEO_PORT: "0", IAMCEO_TEST: "1", HOME: userHome,
    CLAUDE_CONFIG_DIR: join(userHome, ".claude"), CODEX_HOME: join(userHome, ".codex"),
    IAMCEO_CLAUDE_BIN: "/usr/bin/false", IAMCEO_CODEX_BIN: "/usr/bin/false", IAMCEO_CORE_BIN: "/usr/bin/false",
    // Antigravity CLI 는 깔려 있지 않은 Mac 으로 둔다(없는 경로). 물려받은 값이나 이 Mac 의 진짜 agy 를 쓰지 않는다.
    IAMCEO_GEMINI_BIN: join(userHome, "no-such-agy"), IAMCEO_GEMINI_HOME: join(userHome, "gemini-home"), ...extra,
  };
}

async function runCli(args: string[], env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, BIN, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

describe("iamceo doctor", () => {
  test("서버가 꺼져 있어도 돈다: server 는 fail, 종료 코드 1, --json 은 같은 모양", async () => {
    const home = temp("iamceo-doctor-cli-");
    updateConfigFile({ accessCode: "code" }, { IAMCEO_HOME: home });
    const result = await runCli(["doctor", "--json"], cliEnv(home));
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as DoctorReport;
    expect(report.checks.map(check => check.id)).toEqual([...DOCTOR_CHECK_IDS]);
    expect(report.serverVersion).toBe(VERSION);
    const checks = Object.fromEntries(report.checks.map(check => [check.id, check]));
    expect(checks.server!.state).toBe("fail");
    // 시험 환경이라 launchctl 을 부르지 않는다.
    expect(checks.service!.state).toBe("unknown");
    // 가짜 실행 엔진(/usr/bin/false)은 있지만 서버가 꺼져 있어 동작은 모른다.
    expect(checks.engine!.state).toBe("unknown");
  }, 30_000);

  test("사람용 출력은 언어를 따른다. 처음인 Mac 에는 데이터 폴더를 만들지 않는다", async () => {
    const home = join(temp("iamceo-doctor-fresh-"), "never-started");
    const ko = await runCli(["doctor"], cliEnv(home, { IAMCEO_LANG: "ko" }));
    expect(ko.code).toBe(1);
    expect(ko.stdout).toContain("✗ 서버 — 이 Mac에서 IAMCEO를 아직 시작한 적이 없습니다");
    expect(ko.stdout).toContain("고치는 법: ");
    expect(existsSync(home)).toBe(false);
    const en = await runCli(["doctor"], cliEnv(home, { IAMCEO_LANG: "en" }));
    expect(en.stdout).toContain("✗ Server — IAMCEO has not been started on this Mac yet");
    expect(en.stdout).toContain("Fix: ");
    expect(existsSync(home)).toBe(false);
    const help = await runCli(["help"], cliEnv(home, { IAMCEO_LANG: "ko" }));
    expect(help.stdout).toContain("doctor [--json]");
    expect(help.stdout).toContain("diagnose");
  }, 30_000);
});

describe("iamceo doctor: Gemini", () => {
  test("Antigravity CLI 자리에 가짜 agy 를 두면 Gemini 줄과 버전이 나온다. 서버가 꺼져 있어도, 처음인 Mac 에서도", async () => {
    const bin = temp("iamceo-doctor-agy-");
    const agy = join(bin, "agy");
    // 진짜 agy 처럼 --version 에 버전 번호 한 줄만 찍는다. 다른 인자로 부르면 실패한다(버전 말고는 부르지 않는지 본다).
    writeFileSync(agy, `#!/bin/sh\necho "$@" >> '${join(bin, "calls")}'\n[ "$1" = "--version" ] || exit 9\necho 1.5.14\n`, { mode: 0o755 });
    const home = temp("iamceo-doctor-cli-gemini-");
    updateConfigFile({ accessCode: "code" }, { IAMCEO_HOME: home });
    const result = await runCli(["doctor", "--json"], cliEnv(home, { IAMCEO_GEMINI_BIN: agy, IAMCEO_LANG: "ko" }));
    const report = JSON.parse(result.stdout) as DoctorReport;
    expect(report.checks.map(check => check.id)).toEqual(["server", "engine", "claude", "codex", "gemini", "cli_version", "tailscale", "service", "backup", "disk"]);
    expect(report.checks.find(check => check.id === "gemini")).toEqual({ id: "gemini", state: "unknown", title: "Gemini", detail: "Antigravity CLI 설치됨 · 1.5.14 · 로그인은 세션을 열 때 확인합니다" });
    // 처음인 Mac(설정 파일 없음)에서도 환경 변수의 실행 파일을 본다.
    const fresh = await runCli(["doctor", "--json"], cliEnv(join(temp("iamceo-doctor-fresh-gemini-"), "never-started"), { IAMCEO_GEMINI_BIN: agy, IAMCEO_LANG: "en" }));
    expect((JSON.parse(fresh.stdout) as DoctorReport).checks.find(check => check.id === "gemini")).toMatchObject({ state: "unknown", detail: "Antigravity CLI installed · 1.5.14 · sign-in is checked when a session starts" });
    // --version 으로만 불렀다.
    expect([...new Set(readFileSync(join(bin, "calls"), "utf8").trim().split("\n"))]).toEqual(["--version"]);
  }, 30_000);
});

// 리뷰 docs-2·app-8: 앱 설치의 runtime/iamceo 로 점검·제거를 돌리면(서비스 설정 없이) 엔진을 PATH 에서 찾다가 '실행 엔진 없음'으로 판정했다.
describe("앱 묶음 안의 실행 엔진 자리", () => {
  test("실행 파일 옆 runtime/Herdr Core.app 의 엔진을 기본 후보로 찾는다", () => {
    const app = temp("iamceo-core-bin-");
    cleanups.push(() => rmSync(app, { recursive: true, force: true }));
    const runtime = join(app, "IAMCEO.app", "Contents", "Resources", "runtime");
    const engine = join(runtime, "Herdr Core.app", "Contents", "MacOS", "herdr-core");
    mkdirSync(join(engine, ".."), { recursive: true });
    writeFileSync(join(runtime, "iamceo"), "", { mode: 0o755 });
    const nowhere = join(app, "no-source");
    expect(defaultCoreBin(join(runtime, "iamceo"), nowhere)).toBe("herdr-core");
    writeFileSync(engine, "", { mode: 0o755 });
    expect(defaultCoreBin(join(runtime, "iamceo"), nowhere)).toBe(engine);
    // 바로 옆의 herdr-core 가 있으면(예전 묶음 모양) 그것이 먼저다.
    writeFileSync(join(runtime, "herdr-core"), "", { mode: 0o755 });
    expect(defaultCoreBin(join(runtime, "iamceo"), nowhere)).toBe(join(runtime, "herdr-core"));
  });
});
