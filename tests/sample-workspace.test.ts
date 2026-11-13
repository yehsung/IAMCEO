// F8: 앱의 '샘플로 둘러보기'가 쓰는 자료를 실제 서버에서 만든다.
// 샘플은 앱 안의 가짜 서버(native/Sources/IAMCEO/State/SampleServer.swift)가 이 자료로 답한다. 화면은 실제 서버에 붙은 것과 같은
// 코드(해석기, 대화 페이지, 쓰기 경로)를 그대로 탄다. 자료를 손으로 만들지 않고 이 시험이 실제 Store·HTTP 경로로 만들어
// 서버 응답 모양이 바뀌면 샘플도 따라 바뀐다.
//
// 0.2.5 W: 같은 회사·같은 흐름을 한국어(`json`)와 영어(`english`) 두 벌로 만든다. 앱은 화면 언어에 맞는 벌을 쓴다.
// 두 벌은 id·시각·상태가 모두 같고 글만 다르다(아래 `t(한국어, 영어)`). 영어 벌에는 서버의 상수(대화 글 종류 등)밖에 한글이 남지 않는다.
//
// 기본은 '확인' 모드: 지금 서버로 다시 만든 자료가 앱에 들어 있는 것과 같아야 통과한다(다르면 샘플이 낡은 것).
// 다시 만들기: IAMCEO_UPDATE_SAMPLE=1 bun test tests/sample-workspace.test.ts (시험용 임시 홈에서)
//
// 시각은 고정한 기준 시각(BASE)에서 몇 분 전으로 만든다. 앱은 불러올 때 모든 시각을 '지금' 기준으로 옮긴다.
// 이 Mac 의 경로·이름·포트 같은 기계 고유 값은 자료에 남기지 않는다(마지막에 시험으로 확인).
import { afterAll, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile, VERSION } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer, type ServerContext } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { PushStore } from "../server/push/store.ts";
import type { Runner, RunnerMember, SendResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import { UsageLedger } from "../server/usage.ts";
import type { ActivityKind, MemberStatus } from "../shared/types.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const OUTPUT = resolve(import.meta.dir, "../native/Sources/IAMCEO/State/SampleWorkspaceData.swift");
/** 자료 속 시각의 기준. 앱은 이 시각을 '지금'으로 옮긴다. */
const BASE = Date.parse("2026-01-05T09:00:00.000Z");
/** 자료 속 경로의 홈. 실제 사용자 홈이 남지 않게 모든 경로를 여기로 바꾼다. */
const SAMPLE_HOME = "/Users/sample";
const FORMAT = 1;

type Lang = "ko" | "en";
/** 앱 소스 속 자료 이름(SampleWorkspaceData 의 정적 상수). 한국어가 처음 만든 `json` 이다. */
const BLOCK: Record<Lang, string> = { ko: "json", en: "english" };
/** 서버가 정한 한국어 상수(shared/types.ts MessageKind, 대표 글의 글쓴이 "나"). 앱이 보이는 이름으로 바꿔 그리므로 영어 벌에도 남는다. */
const MESSAGE_KINDS = new Set(["완료", "진행", "질문", "막힘", "알림", "답변", "지시", "직접", "나", "시스템"]);

class SampleRunner implements Runner {
  readonly kind = "core";
  async available() { return { ok: true }; }
  async start(member: RunnerMember) { return { sessionId: member.sessionId ?? randomUUID(), paneId: `sample:${member.id}` }; }
  async send(): Promise<SendResult> { return { ok: true, started: false }; }
  isBusy() { return false; }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async checkStop() {}
  async stop() {}
  async screen() { return ""; }
  on() {}
  async shutdown() {}
  async terminalControl(): Promise<never> { throw new Error("샘플 자료는 터미널을 쓰지 않는다"); }
}

// ---- 작은 PNG(현재 결제 버튼 캡처): 글자 없이 카드·입력칸·버튼 모양만(두 언어가 같은 그림) ----
function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function pngChunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
function paymentButtonPng(): Buffer {
  const width = 390, height = 520;
  type RGB = [number, number, number];
  const bg: RGB = [20, 18, 28], card: RGB = [31, 28, 44], field: RGB = [46, 42, 63], line: RGB = [70, 64, 94], button: RGB = [124, 92, 255], soft: RGB = [92, 84, 120];
  const inRound = (x: number, y: number, left: number, top: number, w: number, h: number, r: number) => {
    if (x < left || y < top || x >= left + w || y >= top + h) return false;
    const cx = Math.min(Math.max(x, left + r), left + w - r - 1), cy = Math.min(Math.max(y, top + r), top + h - r - 1);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const shapes: Array<[number, number, number, number, number, RGB]> = [
    [20, 24, 350, 470, 22, card],
    [44, 56, 180, 14, 7, soft], [44, 84, 120, 10, 5, line],
    [44, 128, 302, 52, 12, field], [44, 196, 145, 52, 12, field], [201, 196, 145, 52, 12, field],
    [44, 264, 302, 52, 12, field], [44, 344, 220, 10, 5, line], [44, 364, 160, 10, 5, line],
    [44, 410, 302, 56, 16, button], [150, 432, 90, 12, 6, [228, 222, 255]],
  ];
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      let color = bg;
      for (const [left, top, w, h, r, fill] of shapes) if (inRound(x, y, left, top, w, h, r)) color = fill;
      raw.set(color, y * (width * 3 + 1) + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(raw, { level: 9 })), pngChunk("IEND", new Uint8Array())]);
}

const ARTIFACT_HTML: Record<Lang, string> = {
  ko: `<!doctype html>
<html lang="ko">
<head><title>완료·실패 화면 시안</title></head>
<body>
<h1>완료·실패 화면 시안</h1>
<p>결제 직후 보이는 첫 화면을 두 안씩 나란히 놓았습니다. <span class="tag good">추천: 완료 A · 실패 B</span></p>

<div class="grid">
  <div class="card"><h3>완료 A</h3><p><strong>결제가 끝났습니다</strong></p><p>영수증은 메일로 보냈습니다. 주문 내역에서도 볼 수 있습니다.</p></div>
  <div class="card"><h3>완료 B</h3><p><strong>감사합니다</strong></p><p>주문이 접수되었습니다.</p></div>
  <div class="card"><h3>실패 A</h3><p><strong>다시 시도해 주세요</strong></p><p>결제가 완료되지 않았습니다.</p></div>
  <div class="card"><h3>실패 B</h3><p><strong>카드를 확인해 주세요</strong></p><p>한도나 인증을 확인한 뒤 다시 결제해 주세요. 고객센터 1588-0000</p></div>
</div>

<div class="callout"><strong>고른 이유:</strong> 고객 문의 1위가 '결제됐나요?'입니다. 첫 줄에서 결과를 바로 말하는 안이 문의를 줄입니다.</div>

<table>
  <thead><tr><th>안</th><th>첫 줄 길이</th><th>결과가 분명한가</th></tr></thead>
  <tbody>
    <tr><td>완료 A</td><td>9자</td><td>예</td></tr>
    <tr><td>완료 B</td><td>5자</td><td>덜 분명함</td></tr>
    <tr><td>실패 B</td><td>10자</td><td>원인까지 안내</td></tr>
  </tbody>
</table>
</body>
</html>`,
  en: `<!doctype html>
<html lang="en">
<head><title>Success and failure screen mockups</title></head>
<body>
<h1>Success and failure screen mockups</h1>
<p>Two options each for the first screen people see after they pay, side by side. <span class="tag good">Recommended: Success A · Failure B</span></p>

<div class="grid">
  <div class="card"><h3>Success A</h3><p><strong>Payment complete</strong></p><p>We've emailed your receipt. You can also find it in your order history.</p></div>
  <div class="card"><h3>Success B</h3><p><strong>Thank you</strong></p><p>We've received your order.</p></div>
  <div class="card"><h3>Failure A</h3><p><strong>Please try again</strong></p><p>Your payment didn't go through.</p></div>
  <div class="card"><h3>Failure B</h3><p><strong>Please check your card</strong></p><p>Check your card limit or verification, then try again. Need help? Call 1-800-555-0100.</p></div>
</div>

<div class="callout"><strong>Why these:</strong> "Did my payment go through?" is our most common support question. Stating the result in the first line cuts those questions down.</div>

<table>
  <thead><tr><th>Option</th><th>First line</th><th>Is the result clear?</th></tr></thead>
  <tbody>
    <tr><td>Success A</td><td>16 characters</td><td>Yes</td></tr>
    <tr><td>Success B</td><td>9 characters</td><td>Less clear</td></tr>
    <tr><td>Failure B</td><td>22 characters</td><td>Also says why</td></tr>
  </tbody>
</table>
</body>
</html>`,
};

let restoreTime = false;
// 사용량의 날짜(YYYY-MM-DD)는 서버가 도는 곳의 시간대로 나뉜다. 자료가 어느 Mac 에서 만들어도 같게 UTC 로 고정한다(앱은 날짜도 오늘로 옮긴다).
const zone = process.env.TZ;
afterAll(() => { if (restoreTime) setSystemTime(); if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });

/** 한 언어의 샘플 자료를 실제 서버로 만들어 JSON 글로 돌려준다. */
async function buildSample(lang: Lang): Promise<string> {
  /** 같은 자리의 한국어·영어 글. 한국어 벌은 이 시험을 두 벌로 나누기 전과 글자 하나 다르지 않다. */
  const t = (ko: string, en: string) => lang === "ko" ? ko : en;
  const isolated = createIsolatedRuntime();
  const env = { IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0",
    IAMCEO_CORE_SOCKET: isolated.socketPath, IAMCEO_HERDR_SOCKET: isolated.herdrSocketPath,
    IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin };
  updateConfigFile({ accessCode: "sample-workspace", hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  // 시각을 고정한다. 아래의 at(분) 은 '기준 시각에서 몇 분 전'으로 시계를 옮긴다.
  restoreTime = true;
  process.env.TZ = "UTC";
  const at = (minutesAgo: number) => { setSystemTime(new Date(BASE - minutesAgo * 60_000)); return new Date(BASE - minutesAgo * 60_000).toISOString(); };
  at(60 * 30);
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  // 샘플은 처음 쓰는 사람의 첫 실행 질문(권한 방식)을 다시 묻지 않는다: 이미 정해 둔 팀이다.
  // 영어 샘플의 팀은 영어로 보고한다(설정 → 일반 → 보고 언어가 English 로 보인다).
  store.patchSettings({ boardTidyHours: 0, permissionAcknowledged: true, ...(lang === "en" ? { reportLanguage: "en" as const } : {}) });
  const orch = new Orchestrator({ config, store, runners: new Map([["core", new SampleRunner()]]), providerHomes: isolated.providerHomes,
    timings: { tickMs: 60 * 60_000, healthMs: 60 * 60_000 } });
  const context: ServerContext = { config, store, bus, orch, delivery: orch.deliveryRecovery,
    push: { store: new PushStore(store.db), providers: () => [] },
    daemon: () => ({ ready: true, buildId: "sample-build", version: VERSION }) };
  let server: RunningServer | undefined;
  try {
    do { if (server) await server.stop(); server = await startServer(context); } while (server.port === 7878);
    const base = `http://127.0.0.1:${server.port}`;
    orch.setServerUrl(base);
    const auth = { Authorization: `Bearer ${config.accessCode}` };
    const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
      method, headers: { ...auth, "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const read = async (path: string, headers: Record<string, string> = {}) => {
      const response = await request(path, "GET", undefined, headers);
      const text = await response.text();
      if (response.status !== 200) throw new Error(`${path} → ${response.status} ${text}`);
      return JSON.parse(text);
    };

    // 생성된 id 를 읽기 쉬운 고정 id 로 바꾼다(자료가 실행마다 같아야 '낡았는지' 비교할 수 있다).
    const rename = new Map<string, string>();
    const keep = <T extends { id: string }>(value: T, id: string): T => { rename.set(value.id, id); return value; };

    // ---- 프로젝트 ----
    const shop = join(isolated.paths.work, "shop-web"), ir = join(isolated.paths.work, "ir");
    for (const dir of [shop, ir]) Bun.spawnSync(["/bin/mkdir", "-p", dir]);
    at(60 * 26);
    const pay = store.createProject({ id: "sample-pay", name: t("결제 페이지 개편", "Checkout Revamp"), cwd: shop });
    at(60 * 24);
    const deck = store.createProject({ id: "sample-ir", name: t("투자 IR 자료", "Investor Deck"), cwd: ir });
    // 본사의 이름은 서버가 '본사'로 만든다. 영어 샘플은 영어 화면의 이름(HQ)으로 둔다.
    store.patchProject("hq", { now: t("새 프로젝트 요청을 기다립니다.", "Waiting for a new project request."), ...(lang === "en" ? { name: "HQ" } : {}) });
    const pid = pay.id;

    // ---- 팀장(총괄 1 + 팀장 8): 일하는 중·내 답 기다림·쉬는 중·잠듦이 섞인 건강한 팀 ----
    interface Seat { key: string; handle: string; name: string; role: string; kind: "conductor" | "worker"; cli: "claude" | "codex"; model: string | null;
      status: MemberStatus; now: string; next: string; contextPct: number | null; subagents?: number; minutesAgo: number }
    const seats: Seat[] = [
      { key: "m-chief", handle: "chief", name: t("결제 총괄", "Checkout Lead"), role: t("프로젝트 총괄", "Project lead"), kind: "conductor", cli: "claude", model: "opus", status: "working",
        now: t("PG 연동 결과와 문구 결정을 묶어 다음 지시를 정리하는 중", "Turning the payment provider results and copy decisions into next steps"),
        next: t("결재 답이 오면 구현 팀장에게 전달", "Pass your decisions on to the build staff"), contextPct: 38, minutesAgo: 1 },
      { key: "m-pg", handle: "pg", name: t("결제 연동", "Payments Integration"), role: t("PG 시험 연동 · 실패 코드", "Provider sandbox · error codes"), kind: "worker", cli: "codex", model: "gpt-6-astra", status: "waiting",
        now: t("PG 시험 연동 — 실패 응답 코드 정리", "Provider sandbox — sorting out failure codes"),
        next: t("완료 문구가 정해지면 화면에 반영", "Add the confirmation message once it's chosen"), contextPct: 22, minutesAgo: 9 },
      { key: "m-copy", handle: "copy", name: t("화면 문구", "UX Copy"), role: t("완료·실패 화면 문구", "Success and failure screen copy"), kind: "worker", cli: "claude", model: "sonnet", status: "working",
        now: t("완료 화면 문구를 다듬는 중", "Polishing the confirmation screen copy"), next: t("실패 화면 문구", "Failure screen copy"), contextPct: 51, subagents: 2, minutesAgo: 0.5 },
      { key: "m-card", handle: "card", name: t("카드 결제 구현", "Card Checkout"), role: t("카드 결제 화면", "Card payment screen"), kind: "worker", cli: "codex", model: "gpt-6-astra", status: "working",
        now: t("카드 결제 화면 구현 — 결제 버튼과 입력 검증을 잇는 중", "Building the card payment screen — wiring the pay button to input validation"),
        next: t("시험 통과 후 결과 보고", "Report back once the tests pass"), contextPct: 44, subagents: 1, minutesAgo: 2 },
      { key: "m-research", handle: "research", name: t("자료 조사", "Research"), role: t("PG 비교 · 계약 조건", "Provider comparison · contract terms"), kind: "worker", cli: "claude", model: "sonnet", status: "idle",
        now: t("결제 방식 비교표를 정리했다고 보고", "Reported the payment provider comparison"), next: t("PG 결정 뒤 계약 조건 요약", "Summarize contract terms once a provider is chosen"), contextPct: 17, minutesAgo: 20 },
      { key: "m-funnel", handle: "funnel", name: t("이탈률 측정", "Funnel Analytics"), role: t("결제 단계별 이벤트", "Checkout step events"), kind: "worker", cli: "codex", model: "gpt-6-astra", status: "idle",
        now: t("결제 단계별 이탈 이벤트 이름을 정리했다고 보고", "Reported the drop-off event names for each checkout step"), next: t("구현이 끝나면 이벤트 심기", "Add the events once the build is done"), contextPct: 28, minutesAgo: 5 },
      { key: "m-qa", handle: "qa", name: t("결제 QA", "Checkout QA"), role: t("회귀 시험", "Regression tests"), kind: "worker", cli: "claude", model: null, status: "asleep",
        now: "", next: t("구현이 끝나면 결제 회귀 시험", "Run the checkout regression tests once the build is done"), contextPct: null, minutesAgo: 90 },
      { key: "m-mail", handle: "mail", name: t("영수증 메일", "Receipt Email"), role: t("결제 완료 메일", "Order confirmation email"), kind: "worker", cli: "claude", model: "sonnet", status: "idle",
        now: t("영수증 메일 템플릿 초안을 올렸다고 보고", "Reported the first draft of the receipt email template"), next: "", contextPct: 12, minutesAgo: 30 },
      { key: "m-settle", handle: "settle", name: t("정산 리포트", "Settlement Reports"), role: t("일별 정산 요약", "Daily settlement summary"), kind: "worker", cli: "codex", model: null, status: "asleep",
        now: t("지난주 정산 요약을 보고", "Reported last week's settlement summary"), next: "", contextPct: null, minutesAgo: 60 * 20 },
    ];
    const members = new Map<string, string>();
    // 세션 id 도 실행마다 같아야 한다(화면에는 보이지 않는다).
    let sessions = 0;
    const session = () => `00000000-0000-4000-8000-${String(++sessions).padStart(12, "0")}`;
    for (const [index, seat] of seats.entries()) {
      at(60 * 25 - index);
      const created = store.createMember({ projectId: pid, handle: seat.handle, name: seat.name, role: seat.role, kind: seat.kind, cli: seat.cli,
        backend: "core", status: "idle", sessionId: session(), paneId: `sample:${seat.handle}`, cwd: shop });
      members.set(seat.key, keep(created, seat.key).id);
    }
    const irSeats = [
      { key: "m-ir-chief", handle: "chief", name: t("IR 총괄", "Deck Lead"), role: t("프로젝트 총괄", "Project lead"), kind: "conductor" as const, cli: "claude" as const, status: "working" as MemberStatus,
        now: t("재무 요약 슬라이드 순서를 정하는 중", "Deciding the order of the financial summary slides") },
      { key: "m-ir-deck", handle: "deck", name: t("슬라이드 작성", "Slide Writer"), role: t("재무 요약 · 시장 규모", "Financial summary · market size"), kind: "worker" as const, cli: "claude" as const, status: "idle" as MemberStatus,
        now: t("시장 규모 슬라이드를 올렸다고 보고", "Reported the market size slide") },
      { key: "m-ir-num", handle: "numbers", name: t("숫자 검토", "Numbers Check"), role: t("재무 표 검산", "Checking the financial tables"), kind: "worker" as const, cli: "codex" as const, status: "asleep" as MemberStatus, now: "" },
    ];
    for (const [index, seat] of irSeats.entries()) {
      at(60 * 23 - index);
      const created = store.createMember({ projectId: deck.id, handle: seat.handle, name: seat.name, role: seat.role, kind: seat.kind, cli: seat.cli,
        backend: "core", status: "idle", sessionId: session(), paneId: `sample:ir-${seat.handle}`, cwd: ir });
      members.set(seat.key, keep(created, seat.key).id);
    }
    // 본사에는 새 프로젝트를 받아 줄 총괄 하나가 쉬고 있다.
    at(60 * 29);
    members.set("m-hq", keep(store.createMember({ projectId: "hq", handle: "chief", name: t("본사 총괄", "HQ Lead"), role: t("새 프로젝트 준비", "Getting new projects ready"), kind: "conductor", cli: "claude",
      backend: "core", status: "idle", sessionId: session(), paneId: "sample:hq", cwd: SAMPLE_HOME }), "m-hq").id);
    const id = (key: string) => members.get(key)!;
    /** 그 자리의 팀장 이름(결재·할 일·자료의 '누가'). */
    const name = (key: string) => [...seats, ...irSeats].find(seat => seat.key === key)!.name;

    // ---- 자료 ----
    at(60 * 25);
    const png = paymentButtonPng();
    const form = new FormData(); form.append("file", new File([new Uint8Array(png)], "payment-button.png", { type: "image/png" }));
    const uploaded = await fetch(`${base}/api/uploads?project=${pid}`, { method: "POST", headers: auth, body: form });
    expect(uploaded.status).toBe(200);
    const shot = await uploaded.json() as { id: string; url: string; mime: string };
    rename.set(shot.id, "a-shot");
    const shotFile = keep(store.createFile({ projectId: pid, kind: "image", title: t("현재 결제 버튼 캡처", "Current pay button screenshot"), who: name("m-card"), memberId: id("m-card"),
      summary: t("모바일 결제 버튼 현재 상태", "How the mobile pay button looks today"), attachments: [store.getAttachment(shot.id)!] }), "f-shot");
    at(60 * 22);
    const funnel = keep(store.createFile({ projectId: pid, kind: "table", title: t("결제 단계별 이탈률", "Checkout drop-off by step"), who: name("m-funnel"), memberId: id("m-funnel"),
      summary: t("지난 4주 결제 단계별 이탈률", "Drop-off at each checkout step over the last 4 weeks"),
      body: t("단계,방문,이탈률\n장바구니,12840,18%\n주문서,10529,24%\n결제 수단 선택,8002,31%\n결제 완료,5521,-",
        "Step,Visits,Drop-off\nCart,12840,18%\nOrder details,10529,24%\nPayment method,8002,31%\nPayment complete,5521,-") }), "f-funnel");
    at(35);
    keep(store.createFile({ projectId: pid, kind: "code", title: "payment-config.ts", who: name("m-card"), memberId: id("m-card"), path: "src/payment/payment-config.ts",
      summary: t("PG 키와 결제 수단 설정", "Payment provider key and payment methods"),
      body: t("export const payment = {\n  provider: process.env.PG_PROVIDER ?? \"toss\",\n  methods: [\"card\", \"transfer\", \"easy-pay\"],\n  retry: { max: 2, backoffMs: 800 },\n}\n",
        "export const payment = {\n  provider: process.env.PAYMENT_PROVIDER ?? \"stripe\",\n  methods: [\"card\", \"apple-pay\", \"google-pay\"],\n  retry: { max: 2, backoffMs: 800 },\n}\n") }), "f-config");
    at(20);
    const fee = keep(store.createFile({ projectId: pid, kind: "document", title: t("결제 수단별 수수료 비교", "Payment provider fee comparison"), who: name("m-research"), memberId: id("m-research"),
      summary: t("토스페이먼츠·KG이니시스의 수수료, 정산 주기, 연동 난이도를 비교했습니다.", "Compares Stripe and Adyen on fees, payout timing and integration effort."),
      body: t("# 결제 수단별 수수료 비교\n\n## 요약\n토스페이먼츠가 연동 문서와 정산 주기에서 앞서고, KG이니시스는 수수료가 0.2%p 낮습니다.\n\n## 비교\n| PG사 | 수수료 | 정산 | 연동 |\n|---|---:|:-:|---|\n| 토스페이먼츠 | 2.9% | D+2 | 시험 키 즉시 발급, `sandbox` 제공 |\n| KG이니시스 | 2.7% | D+3 | 기존 계약 있음, 시험 키는 2~3일 |\n\n> 결제 금액 1만~5만 원 구간이 전체 결제의 70%입니다.\n\n## 남은 확인\n- [x] 정산 주기 확인\n- [ ] 간편결제 수수료 별도 여부\n- [ ] 해지 위약금\n",
        "# Payment provider fee comparison\n\n## Summary\nStripe is ahead on documentation and payout speed. Adyen's quoted rate is 0.2 points lower.\n\n## Comparison\n| Provider | Fee | Payout | Integration |\n|---|---:|:-:|---|\n| Stripe | 2.9% | 2 days | Test keys right away, full `sandbox` |\n| Adyen | 2.7% | 3 days | Existing contract, test keys in 2–3 days |\n\n> Orders between $10 and $50 make up 70% of all payments.\n\n## Still to check\n- [x] Payout timing\n- [ ] Whether wallet payments carry a separate fee\n- [ ] Early termination fee\n") }), "f-fee");
    at(4);
    const mock = keep(store.createFile({ projectId: pid, kind: "artifact", title: t("완료·실패 화면 시안", "Success and failure screen mockups"), who: name("m-copy"), memberId: id("m-copy"),
      summary: t("완료 화면 2안, 실패 화면 2안을 나란히 비교하는 HTML 시안", "An HTML mockup comparing two success screens and two failure screens side by side"), html: ARTIFACT_HTML[lang] }), "f-copy");
    at(60 * 3);
    keep(store.createFile({ projectId: deck.id, kind: "document", title: t("시장 규모 요약", "Market size summary"), who: name("m-ir-deck"), memberId: id("m-ir-deck"),
      summary: t("국내 간편결제 시장 규모와 성장률을 한 장으로 정리했습니다.", "The US digital wallet market and its growth, on one page."),
      body: t("# 시장 규모 요약\n\n- 국내 간편결제 거래액: 연 280조 원\n- 최근 3년 연평균 성장률: 18%\n- 우리 고객층(20~30대) 비중: 46%\n",
        "# Market size summary\n\n- US digital wallet payments: about $1.7 trillion a year\n- Average annual growth over the last 3 years: 18%\n- Share of our customers aged 20–39: 46%\n") }), "f-ir-market");

    // ---- 결재(열린 2 + 답해서 전달된 3 + 대화로 정리된 1) ----
    at(60 * 5);
    const old = keep(store.createDecision({ projectId: pid, memberId: id("m-research"), who: name("m-research"), title: t("비교 대상에 페이팔을 넣을까요?", "Should we add PayPal to the comparison?"),
      detail: t("해외 결제가 필요하면 넣습니다.", "Only if we need international payments.") }), "d-old");
    at(60 * 4);
    store.closeDecision(old.id, { kind: "decided", reason: t("대화에서 국내 결제만 한다고 정했습니다.", "We agreed in chat to handle domestic payments only."), by: name("m-research"),
      quote: t("해외 결제는 이번엔 빼죠", "Let's leave international payments out this time") });
    at(60 * 3);
    const button = keep(store.createDecision({ projectId: pid, memberId: id("m-card"), who: name("m-card"), title: t("결제 버튼 색을 정해 주세요", "Pick a color for the pay button"),
      detail: t("브랜드 보라와 기본 파랑 중 하나입니다.", "It's either our brand purple or the default blue."),
      options: [{ k: "a", label: t("기본 파랑", "Default blue") }, { k: "b", label: t("브랜드 보라", "Brand purple") }], rec: "a" }), "d-button");
    at(60 * 2);
    store.answerDecision(button.id, { choice: "a", note: t("접근성 대비 기준을 지켜 주세요.", "Make sure it meets the accessibility contrast guidelines."), expectedVersion: store.requireDecision(button.id).updatedAt });
    at(60 * 2 - 1);
    store.setDecisionStatus(button.id, "delivered");
    at(55);
    const fail = keep(store.createDecision({ projectId: pid, memberId: id("m-copy"), who: name("m-copy"), title: t("실패 문구를 골라 주세요", "Pick the failure message"),
      detail: t("실패 화면 첫 줄입니다. 가장 흔한 실패 원인은 카드 한도와 인증 취소입니다.", "This is the first line on the failure screen. The most common causes are a maxed-out card and a canceled verification step."),
      options: [{ k: "a", label: t("다시 시도해 주세요", "Please try again"), desc: t("원인을 말하지 않아 같은 실패가 반복될 수 있습니다.", "Doesn't say why, so people may hit the same failure again.") },
        { k: "b", label: t("카드를 확인해 주세요", "Please check your card"), desc: t("가장 흔한 원인을 바로 안내합니다.", "Points straight to the most common cause.") }], rec: "b" }), "d-fail-copy");
    at(50);
    const receipt = keep(store.createDecision({ projectId: pid, memberId: id("m-pg"), who: name("m-pg"), title: t("영수증 메일을 보낼까요?", "Should we send a receipt email?"),
      detail: t("결제 완료 직후 영수증 메일을 자동 발송할지 정해 주세요.", "Decide whether a receipt email goes out automatically right after payment."),
      options: [{ k: "a", label: t("보낸다", "Send it") }, { k: "b", label: t("보내지 않는다", "Don't send it") }] }), "d-receipt");
    at(32);
    store.answerDecision(receipt.id, { choice: "a", expectedVersion: store.requireDecision(receipt.id).updatedAt });
    at(31);
    store.setDecisionStatus(receipt.id, "delivered");
    at(25);
    keep(store.createDecision({ projectId: pid, memberId: id("m-research"), who: name("m-research"), title: t("PG사를 어디로 할지 정해 주세요", "Which payment provider should we use?"),
      detail: t("결제 연동을 시작하려면 PG사를 하나 정해야 합니다. 비교표를 자료에 올렸습니다.\n\n- 고객 문의 1위가 '결제됐나요?'라서 정산·알림이 빠른 쪽이 유리합니다\n- 기존 KG이니시스 계약은 내년 3월에 끝납니다",
        "We need to pick one provider before the integration can start. The comparison is in Files.\n\n- \"Did my payment go through?\" is our most common support question, so faster payouts and notifications help\n- Our current Adyen contract ends next March"),
      options: [{ k: "a", label: t("토스페이먼츠", "Stripe"), desc: t("수수료 2.9%, 정산 D+2. 연동 문서가 가장 좋아 구현이 이틀 빠릅니다.", "2.9% fee, payout in 2 days. The best documentation, so the build is two days faster.") },
        { k: "b", label: t("KG이니시스", "Adyen"), desc: t("수수료 2.7%, 정산 D+3. 기존 계약을 그대로 씁니다.", "2.7% fee, payout in 3 days. Keeps our existing contract.") },
        { k: "c", label: t("둘 다 붙이고 비교", "Integrate both and compare"), desc: t("구현이 3일 늘고, 2주 뒤 전환율로 고릅니다.", "Adds 3 days to the build. We pick by conversion rate after 2 weeks.") }], rec: "a", fileId: fee.id }), "d-pg");
    at(12);
    const doneCopy = keep(store.createDecision({ projectId: pid, memberId: id("m-pg"), who: name("m-pg"), title: t("결제 완료 문구를 골라 주세요", "Pick the payment confirmation message"),
      detail: t("완료 화면 첫 줄입니다. 사용자가 결제 성공을 바로 알아야 합니다.", "This is the first line on the confirmation screen. People need to see right away that the payment worked."),
      options: [{ k: "a", label: t("결제가 끝났습니다", "Payment complete"), desc: t("결과를 바로 말합니다. 영수증 링크를 아래에 둡니다.", "States the result right away. The receipt link goes below it.") },
        { k: "b", label: t("감사합니다", "Thank you"), desc: t("친근하지만 성공 여부가 덜 분명합니다.", "Friendly, but less clear about whether the payment worked.") }], rec: "a", fileId: mock.id }), "d-done-copy");
    at(9);
    store.answerDecision(fail.id, { choice: "b", note: t("고객센터 번호도 함께 보여 주세요.", "Show the support number as well."), expectedVersion: store.requireDecision(fail.id).updatedAt });
    at(8);
    store.setDecisionStatus(fail.id, "delivered");
    at(60 * 2);
    keep(store.createDecision({ projectId: deck.id, memberId: id("m-ir-deck"), who: name("m-ir-deck"), title: t("첫 장에 넣을 숫자를 골라 주세요", "Pick the number for the first slide"),
      detail: t("투자자가 첫 장에서 기억할 숫자 하나를 정합니다.", "Choose the one number investors should remember from the first slide."),
      options: [{ k: "a", label: t("월 거래액 12억 원", "$1.2M in monthly sales") }, { k: "b", label: t("재구매율 64%", "64% repeat purchase rate") }], rec: "b" }), "d-ir-number");

    // ---- 대표 할 일 ----
    at(60 * 5);
    const contact = keep(store.createTodo({ projectId: pid, who: name("m-chief"), title: t("PG 담당자 연락처 전달", "Share the payment provider's contact") }), "t-done");
    at(60 * 3);
    store.setTodoDone(contact.id, true);
    at(60 * 2);
    keep(store.createTodo({ projectId: pid, memberId: id("m-research"), who: name("m-research"), title: t("개인정보 처리방침 확인", "Review the privacy policy"),
      detail: t("결제 정보 보관 기간 문구를 법무 기준으로 확인해 주세요.", "Please check the wording on how long we keep payment data against our legal guidelines.") }), "t-policy");
    at(30);
    keep(store.createTodo({ projectId: pid, memberId: id("m-card"), who: name("m-card"), title: t("PG 시험 계정 만들어 주기", "Set up a payment sandbox account"),
      detail: t("토스페이먼츠 개발자센터에서 시험 키 발급이 필요합니다. 발급 뒤 키를 대화로 보내 주세요.", "We need test keys from the Stripe dashboard. Once you have them, send them to me in Chat.") }), "t-key");
    at(18);
    keep(store.createTodo({ projectId: pid, memberId: id("m-pg"), who: name("m-pg"), title: t("로고 원본 파일 보내기", "Send the original logo file"),
      detail: t("완료 화면에 넣을 로고가 필요합니다.\n- SVG면 좋습니다\n- 없으면 PNG", "We need the logo for the confirmation screen.\n- SVG if you have it\n- Otherwise PNG") }), "t-logo");

    // ---- 진행판 ----
    const work: Array<[string, "doing" | "next" | "hold" | "done", string, string, string, number]> = [
      ["w9", "done", t("결제 수단 목록 정리", "List the payment methods"), "", name("m-chief"), 60 * 26],
      ["w8", "done", t("영수증 메일 템플릿", "Receipt email template"), "", name("m-mail"), 30],
      ["w7", "done", t("결제 방식 비교표", "Payment provider comparison"), "", name("m-research"), 20],
      ["w1", "doing", t("PG 시험 연동", "Provider sandbox integration"), t("실패 응답 코드 표 정리", "Sorting out the failure response codes"), name("m-pg"), 40],
      ["w2", "doing", t("완료·실패 화면 문구", "Success and failure screen copy"), "", name("m-copy"), 39],
      ["w3", "doing", t("카드 결제 화면 구현", "Build the card payment screen"), t("결제 버튼·입력 검증 연결", "Connect the pay button and input validation"), name("m-card"), 38],
      ["w4", "next", t("이탈률 측정 넣기", "Add drop-off tracking"), "", name("m-funnel"), 37],
      ["w5", "next", t("결제 회귀 시험", "Checkout regression tests"), "", name("m-qa"), 36],
      ["w6", "hold", t("간편결제 추가", "Add Apple Pay and Google Pay"), t("PG 결정 뒤 재개", "Resumes after the provider decision"), name("m-chief"), 35],
    ];
    for (const [key, sec, title, detail, who, minutesAgo] of work) {
      at(minutesAgo);
      keep(store.upsertWork({ projectId: pid, sec, title, detail, who }), key);
    }
    at(60 * 3);
    keep(store.upsertWork({ projectId: deck.id, sec: "doing", title: t("재무 요약 슬라이드", "Financial summary slides"), who: name("m-ir-chief") }), "w-ir-1");

    // ---- 대화(대표의 지시는 모두 전달됨) ----
    type Line = { key: string; minutesAgo: number; member?: string; mine?: boolean; kind: "진행" | "완료" | "질문" | "나"; title?: string; body: string; target?: string; decision?: string; file?: string };
    const lines: Line[] = [
      { key: "x1", minutesAgo: 40, member: "m-chief", kind: "진행", title: t("오늘 계획", "Today's plan"),
        body: t("1. PG사 결정 받기\n2. 완료·실패 문구 확정\n3. 카드 결제 화면 시험 통과", "1. Get a decision on the payment provider\n2. Lock in the success and failure copy\n3. Get the card payment screen through its tests") },
      { key: "x2", minutesAgo: 38, mine: true, kind: "나", body: t("PG 연동은 이번 주 안에 끝내 주세요.", "Please finish the payment provider integration this week.") },
      { key: "x3", minutesAgo: 20, member: "m-research", kind: "완료", title: t("결제 방식 비교표를 올렸습니다", "The payment provider comparison is up"),
        body: t("수수료·정산 주기·연동 난이도를 비교했습니다. PG사 결정은 결재함에 올렸습니다.", "I compared fees, payout timing and integration effort. The provider decision is waiting in your Inbox."), file: fee.id },
      { key: "x4", minutesAgo: 14, member: "m-card", kind: "진행", title: t("카드 결제 화면 1차 구현", "Card payment screen, first pass"),
        body: t("- 카드 번호·유효기간 입력 검증\n- 결제 버튼 상태(대기·진행·완료)\n- 다음: 결제 버튼과 PG 시험 연동 잇기", "- Card number and expiry validation\n- Pay button states (ready, processing, done)\n- Next: connect the pay button to the provider sandbox") },
      { key: "x5", minutesAgo: 12, member: "m-pg", kind: "질문", title: t("결제 완료 문구 결정 요청", "Need your call on the confirmation message"), body: t("두 안 중 하나를 골라 주세요.", "Please pick one of the two options."), decision: doneCopy.id },
      { key: "x6", minutesAgo: 8, mine: true, kind: "나", body: t("실패 화면에는 고객센터 번호도 넣어 주세요.", "Add the support number to the failure screen too."), target: "m-copy" },
      { key: "x7", minutesAgo: 7, mine: true, kind: "나", body: t("이탈 이벤트 이름부터 정리해 주세요.", "Start by settling the drop-off event names."), target: "m-funnel" },
      { key: "x11", minutesAgo: 5, member: "m-funnel", kind: "완료", title: t("이탈 이벤트 이름을 정리했습니다", "The drop-off event names are settled"),
        body: t("장바구니 → 주문서 → 결제 수단 선택 → 결제 완료, 네 단계의 이벤트 이름과 속성을 정했습니다. 지난 4주 이탈률 표는 자료에 있습니다.",
          "I named the events and their properties for all four steps: cart → order details → payment method → payment complete. The drop-off table for the last 4 weeks is in Files."), file: funnel.id },
      { key: "x8", minutesAgo: 4, member: "m-copy", kind: "진행", title: t("완료 화면 문구 초안", "Draft confirmation screen copy"),
        body: t("- 짧게 한 줄\n- 다음 행동 안내 한 줄\n- 영수증 링크는 버튼으로", "- One short line\n- One line on what to do next\n- The receipt link as a button") },
      { key: "x9", minutesAgo: 2, mine: true, kind: "나", body: t("결제 버튼은 화면 아래에 고정해 주세요.", "Pin the pay button to the bottom of the screen."), target: "m-card" },
      { key: "x10", minutesAgo: 1, mine: true, kind: "나", body: t("문구 결정은 오늘 오후에 할게요.", "I'll decide on the copy this afternoon.") },
    ];
    for (const line of lines) {
      const sentAt = at(line.minutesAgo);
      const seat = line.member ? seats.find(s => s.key === line.member) : undefined;
      const target = line.target ? seats.find(s => s.key === line.target) : undefined;
      // 대표 글의 글쓴이 "나"는 서버가 쓰는 상수다(server/flows/owner.ts). 앱은 대표 글에 이 값을 그리지 않는다.
      store.createMessage({ id: line.key, projectId: pid, at: sentAt, kind: line.kind, title: line.title, body: line.body,
        mine: line.mine, who: line.mine ? "나" : seat?.name, memberId: line.member ? id(line.member) : null,
        targetMemberId: target ? id(target.key) : null, targetName: target?.name ?? null,
        decisionId: line.decision ?? null, fileId: line.file ?? null, delivery: line.mine ? "delivered" : null });
    }
    const irLine = at(60 * 3);
    store.createMessage({ id: "x-ir-1", projectId: deck.id, at: irLine, kind: "진행", title: t("재무 요약 슬라이드 작성 중", "Writing the financial summary slides"),
      body: t("매출·거래액·재구매율 세 장으로 나눴습니다.", "I split it into three slides: revenue, sales volume and repeat purchase rate."), who: name("m-ir-chief"), memberId: id("m-ir-chief") });
    // 이미지 자료를 올렸다는 보고(첨부가 대화에서도 보인다).
    void shotFile;

    // ---- 활동(팀장 상세의 '활동') ----
    const activity: Array<[string, ActivityKind, string, number]> = [
      ["m-copy", "turn_start", t("지시를 받았습니다: 실패 화면에 고객센터 번호 넣기", "Got the instruction: add the support number to the failure screen"), 8],
      ["m-copy", "tool", t("읽기 src/pages/checkout/complete.tsx", "Read src/pages/checkout/complete.tsx"), 6],
      ["m-copy", "text", t("완료 화면 첫 줄을 '결제가 끝났습니다'로 두고 다음 행동 안내를 아래에 붙입니다.", "Keeping 'Payment complete' as the first line of the confirmation screen and adding next steps below it."), 4],
      ["m-copy", "tool", t("고치기 src/pages/checkout/complete.tsx", "Edit src/pages/checkout/complete.tsx"), 1],
      ["m-card", "turn_start", t("지시를 받았습니다: 결제 버튼을 화면 아래에 고정", "Got the instruction: pin the pay button to the bottom of the screen"), 2],
      ["m-card", "tool", t("읽기 src/payment/PayButton.tsx", "Read src/payment/PayButton.tsx"), 2],
      ["m-card", "text", t("버튼을 안전 영역 위에 고정하고 키보드가 올라오면 함께 올라가게 합니다.", "Pinning the button above the safe area so it moves up with the keyboard."), 1],
      ["m-chief", "text", t("결재 두 건(PG사, 완료 문구)의 답을 기다리는 동안 구현 순서를 정리합니다.", "Planning the build order while two decisions (provider and confirmation message) wait for an answer."), 1],
      ["m-pg", "turn_end", t("실패 응답 코드 표를 정리했습니다. 완료 문구 결정을 기다립니다.", "Finished the failure response code table. Waiting on the confirmation message decision."), 9],
    ];
    for (const [member, kind, text, minutesAgo] of activity) { at(minutesAgo); store.appendActivity(id(member), kind, text); }

    // ---- 팀장 상태(마지막에 놓아 위의 기록이 상태를 바꾸지 못하게) ----
    for (const seat of seats) {
      const seen = at(seat.minutesAgo);
      if (seat.model) store.setAppliedConfig(id(seat.key), { model: seat.model, effort: null, staffModel: null, staffEffort: null });
      store.patchMember(id(seat.key), { status: seat.status, now: seat.now, next: seat.next, nowAt: seat.now ? seen : null,
        contextPct: seat.contextPct, subagents: seat.subagents ?? 0,
        statusObservation: { source: "core", observedAt: new Date(BASE).toISOString(), freshness: "fresh", ownership: "verified", consecutiveFailures: 0, error: null },
        subagentState: { quality: "exact", count: seat.subagents ?? 0, observedAt: new Date(BASE).toISOString(), sessionGeneration: store.memberRevisions(id(seat.key)).sessionGeneration } });
      // 문맥 사용량은 CLI 가 보고한 실측으로 둔다(팀장 상세의 '문맥'과 '문맥 압축'이 실제와 같이 보인다).
      if (seat.contextPct !== null) {
        const member = store.requireMember(id(seat.key));
        const context = store.ensureContextState(member.id);
        const window = seat.cli === "claude" ? 200_000 : 400_000;
        store.saveContextState({ ...context, measurement: { sessionId: member.sessionId!, sessionGeneration: context.generation, turn: 4, model: seat.model,
          tokens: Math.round(window * seat.contextPct / 100), window, source: seat.cli === "claude" ? "statusline" : "codex", quality: "exact", measuredAt: seen, fresh: true } },
          { contextPct: seat.contextPct, contextWindow: window, contextWindowSource: seat.cli === "claude" ? "statusline" : "codex" });
      }
    }
    for (const seat of irSeats) {
      const seen = at(60 * 2);
      store.patchMember(id(seat.key), { status: seat.status, now: seat.now, nowAt: seat.now ? seen : null,
        statusObservation: { source: "core", observedAt: new Date(BASE).toISOString(), freshness: "fresh", ownership: "verified", consecutiveFailures: 0, error: null } });
    }
    store.patchMember(id("m-hq"), { status: "idle", now: t("새 프로젝트 요청을 기다립니다.", "Waiting for a new project request."), nowAt: at(60 * 3),
      statusObservation: { source: "core", observedAt: new Date(BASE).toISOString(), freshness: "fresh", ownership: "verified", consecutiveFailures: 0, error: null } });
    at(6);
    store.patchProject(pid, { now: t("**자료 조사**가 결제 방식 비교표를 올렸고, **카드 결제 구현**은 결제 화면을 만들고 있습니다. PG사와 완료 문구 결정 2건이 대표의 답을 기다립니다.",
      "**Research** posted the payment provider comparison, and **Card Checkout** is building the payment screen. Two decisions — the provider and the confirmation message — are waiting for you.") });
    at(60 * 2);
    store.patchProject(deck.id, { now: t("재무 요약 슬라이드 작성 중", "Writing the financial summary slides") });

    // ---- 사용량(T): CLI 가 보고한 세션 누적값을 지난 2주 동안 날마다 넣는다. Claude 는 비용·토큰, Codex 는 토큰만 ----
    const ledger = new UsageLedger(store.db);
    const sessionOf = (key: string) => store.requireMember(id(key)).sessionId!;
    const usageSeats: Array<[string, "claude" | "codex", number]> = [
      ["m-chief", "claude", 1.9], ["m-copy", "claude", 1.3], ["m-card", "codex", 1.6], ["m-pg", "codex", 1.1], ["m-research", "claude", 0.9],
      ["m-funnel", "codex", 0.6], ["m-mail", "claude", 0.4], ["m-ir-chief", "claude", 0.8], ["m-ir-deck", "claude", 0.5],
    ];
    for (const [key, cli, weight] of usageSeats) {
      const member = store.requireMember(id(key));
      let cost = 0, input = 0, output = 0;
      for (let daysAgo = 13; daysAgo >= 0; daysAgo--) {
        // 주말(이틀)은 덜 쓴다. 숫자는 정해 두어 자료가 실행마다 같다.
        const quiet = daysAgo % 7 === 5 || daysAgo % 7 === 6;
        const share = weight * (quiet ? 0.3 : 1) * (1 + ((daysAgo * 7 + key.length) % 5) / 10);
        cost += Math.round(share * 2.4 * 100) / 100; input += Math.round(share * 410_000); output += Math.round(share * 52_000);
        const sampleAt = BASE - daysAgo * 86_400_000 - 30 * 60_000;
        const limits = daysAgo === 0 ? (cli === "claude"
          ? [{ window: "five_hour", windowMinutes: 300, usedPct: 34, resetsAt: new Date(BASE + 2 * 3_600_000).toISOString() },
            { window: "seven_day", windowMinutes: 10_080, usedPct: 18, resetsAt: new Date(BASE + 3 * 86_400_000).toISOString() }]
          : [{ window: "primary", windowMinutes: 300, usedPct: 22, resetsAt: new Date(BASE + 3 * 3_600_000).toISOString() },
            { window: "secondary", windowMinutes: 10_080, usedPct: 9, resetsAt: new Date(BASE + 4 * 86_400_000).toISOString() }]) : [];
        ledger.ingest({ provider: cli, sessionId: sessionOf(key), at: sampleAt, costUsd: cli === "claude" ? Math.round(cost * 100) / 100 : null,
          inputTokens: input, outputTokens: output, limits }, { id: member.id, projectId: member.projectId, name: member.name, kind: member.kind }, BASE);
      }
    }

    // ---- 기준 시각에서 실제 서버 응답을 받는다 ----
    at(0);
    const appHeaders = {};
    const bootstrap = await read("/api/bootstrap", appHeaders);
    const projectsOut: Record<string, unknown> = {};
    const filesOut: Record<string, unknown> = {};
    const artifacts: Record<string, string> = {};
    // 앱의 시안 화면은 ?render=1 로 감싼 문서와 격리 정책 머리글을 받아야 연다. 샘플 서버도 그것을 그대로 준다.
    const artifactDocuments: Record<string, string> = {};
    let artifactPolicy = "";
    for (const project of [store.requireProject("hq"), pay, deck]) {
      const p = `/api/projects/${project.id}`;
      const state = await read(`${p}/state`);
      const sync = await read(`/api/sync?projectId=${project.id}`);
      const page = await read(`${p}/messages/page?limit=500&scope=project`);
      const done = await read(`${p}/decisions?status=done&limit=50`);
      const notices = await read(`${p}/delivery-notices`);
      const activityOut: Record<string, unknown> = {};
      const memberNotices: Record<string, unknown> = {};
      for (const member of state.members as Array<{ id: string }>) {
        activityOut[member.id] = await read(`/api/members/${member.id}/activity?limit=100`);
        memberNotices[member.id] = await read(`/api/members/${member.id}/delivery-notices?limit=20`);
      }
      for (const file of state.files as Array<{ id: string; kind: string }>) {
        filesOut[file.id] = await read(`/api/files/${file.id}`);
        if (file.kind === "artifact") {
          artifacts[file.id] = (await read(`/api/files/${file.id}/artifact`)).html;
          const rendered = await request(`/api/files/${file.id}/artifact?render=1`);
          expect(rendered.status).toBe(200);
          expect(rendered.headers.get("content-type") ?? "").toStartWith("text/html");
          artifactPolicy = rendered.headers.get("content-security-policy") ?? "";
          artifactDocuments[file.id] = await rendered.text();
        }
      }
      expect(page.hasOlder).toBe(false);
      projectsOut[project.id] = { state, revisions: sync.revisions, messages: page.items, decisionsDone: done, deliveryNotices: notices, activity: activityOut, memberNotices };
    }
    const shotPath = new URL(shot.url, base).pathname;
    const shotBytes = await (await fetch(base + shotPath, { headers: auth })).arrayBuffer();
    expect(Buffer.from(shotBytes).equals(png)).toBe(true);
    const settingsRevision = (await read("/api/sync")).revisions.settings;

    const raw = {
      format: FORMAT,
      baseTime: new Date(BASE).toISOString(),
      capabilities: await read("/api/capabilities"),
      models: await read("/api/models"),
      runtime: await read("/api/runtime"),
      bootstrap,
      settingsRevision,
      projects: projectsOut,
      files: filesOut,
      artifacts,
      artifactDocuments,
      artifactPolicy,
      blobs: { [shotPath]: { mime: shot.mime, base64: png.toString("base64") } },
      // T(F6): 앱이 고르는 기간(오늘·7일·30일)마다의 사용량 보고.
      usage: Object.fromEntries(await Promise.all([1, 7, 30].map(async days => [String(days), await read(`/api/usage?days=${days}`)] as const))),
    };

    // ---- 기계 고유 값 지우기와 id 고정 ----
    let text = JSON.stringify(raw);
    // 긴 id 부터 바꿔 한 id 가 다른 id 의 일부를 먼저 바꾸는 일이 없게 한다.
    for (const [from, to] of [...rename.entries()].sort((a, b) => b[0].length - a[0].length)) text = text.split(from).join(to);
    const machine = [isolated.paths.work, join(isolated.paths.work, ".."), homedir()].map(path => resolve(path));
    text = text.split(join(isolated.paths.work, "shop-web")).join(`${SAMPLE_HOME}/Projects/shop-web`)
      .split(join(isolated.paths.work, "ir")).join(`${SAMPLE_HOME}/Projects/ir`);
    for (const path of machine) text = text.split(path).join(SAMPLE_HOME);
    text = text.split(base).join("https://sample.iamceo.invalid").split(`127.0.0.1:${server.port}`).join("sample.iamceo.invalid");
    const data = JSON.parse(text) as Record<string, any>;
    // 샘플은 이 Mac 의 서버가 아니다. 이 Mac 에만 있는 값(실행 엔진·Tailscale·주소·CLI 버전)과 실행마다 다른 값은 빼거나 고정한다.
    const scrubBootstrap = (value: Record<string, any>) => {
      for (const key of ["urls", "tailnet", "engine", "cli", "server", "compat", "home"]) delete value[key];
      value.version = "sample";
      if (value.runtime) value.runtime = data.runtime;
      return value;
    };
    data.bootstrap = scrubBootstrap(data.bootstrap);
    // 사용량의 시간대는 이 Mac 의 것이다(Bun 이 실행 중 바꾼 TZ 를 늘 따르지는 않는다). 날짜는 UTC 로 만들었으니 그렇게 적고, 앱이 기기의 시간대로 바꾼다.
    for (const report of Object.values(data.usage as Record<string, Record<string, unknown>>)) report.timeZone = "UTC";
    data.runtime = scrubRuntime(data.runtime);
    data.bootstrap.runtime = data.runtime;
    // 시안을 감싸는 서버 문서의 언어 표시는 늘 ko 다(shared/artifact-kit.ts). 영어 샘플의 시안은 영어 문서로 둔다(글꼴·줄바꿈 규칙).
    if (lang === "en") {
      for (const [fid, document] of Object.entries(data.artifactDocuments as Record<string, string>)) {
        expect(document.startsWith('<!doctype html><html lang="ko">')).toBe(true);
        data.artifactDocuments[fid] = '<!doctype html><html lang="en">' + document.slice('<!doctype html><html lang="ko">'.length);
      }
    }
    const json = JSON.stringify(data, null, 1);

    // 사용자 홈·계정 이름·임시 경로·실제 포트가 남지 않는다.
    const leaks = [homedir(), "/private/tmp", `:${server.port}`, "127.0.0.1", ...(userInfo().username.length >= 4 ? [userInfo().username] : [])];
    expect(leaks.filter(leak => json.includes(leak))).toEqual([]);
    // 화면이 보여 줄 것이 실제로 실렸다.
    const main = data.projects["sample-pay"];
    expect(main.state.members.length).toBe(9);
    expect(main.state.decisions.filter((d: any) => d.status === "open").length).toBe(2);
    expect(main.state.messages.filter((m: any) => m.mine).every((m: any) => m.delivery === "delivered")).toBe(true);
    expect(main.state.members.every((m: any) => !["blocked", "error", "offline"].includes(m.status))).toBe(true);
    const mockTitle = t("완료·실패 화면 시안", "Success and failure screen mockups");
    expect(data.artifacts["f-copy"]).toContain(mockTitle);
    expect(data.artifactDocuments["f-copy"]).toContain(mockTitle);
    expect(data.artifactPolicy).toContain("sandbox allow-scripts");
    expect(Object.keys(data.blobs)).toHaveLength(1);
    expect(data.bootstrap.settings.reportLanguage).toBe(lang);
    return json;
  } finally {
    await server?.stop();
    await orch.shutdown();
    store.db.close();
    await isolated.stop();
    setSystemTime();
    restoreTime = false;
  }
}

for (const lang of ["ko", "en"] as const) {
  test(`샘플 모드의 자료(${lang})를 실제 서버 응답으로 만든다(앱에 든 자료가 낡지 않았는지 확인)`, async () => {
    const json = await buildSample(lang);
    const fresh = JSON.parse(json);
    if (lang === "en") {
      // 영어 벌에는 서버의 한국어 상수(대화 글 종류, 대표 글의 글쓴이 "나")밖에 한글이 없다. 심사자가 읽는 글이 모두 영어다.
      expect(hangulOutsideConstants(fresh)).toEqual([]);
    }
    if (process.env.IAMCEO_UPDATE_SAMPLE === "1") writeBlock(lang, json);
    const blocks = readBlocks();
    const inApp = blocks[lang] ? JSON.parse(blocks[lang]!) : null;
    // 다르면 서버 응답 모양이 바뀐 것이다. 위 머리말의 명령으로 샘플 자료를 다시 만든다.
    if (!Bun.deepEquals(inApp, fresh)) console.error(`앱에 든 샘플 자료(${lang})가 지금 서버 응답과 다릅니다. 다시 만들기: IAMCEO_UPDATE_SAMPLE=1 bun test tests/sample-workspace.test.ts`);
    expect(inApp).toEqual(fresh);
    if (lang === "en" && blocks.ko) {
      // 두 벌은 같은 회사·같은 흐름이다: id·종류·상태·시각이 모두 같고 글만 다르다(화면 견본 인자 `--open d-pg` 등이 두 언어에서 같다).
      expect(skeleton(fresh)).toEqual(skeleton(JSON.parse(blocks.ko)));
    }
  }, 60_000);
}

/** 영어 벌에서 서버 상수가 아닌 한글이 있는 곳(경로와 글). */
function hangulOutsideConstants(value: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown, path: string[]) => {
    if (Array.isArray(node)) { node.forEach((item, index) => walk(item, [...path, String(index)])); return; }
    if (node && typeof node === "object") { for (const [key, item] of Object.entries(node)) walk(item, [...path, key]); return; }
    if (typeof node !== "string" || !/[가-힣]/.test(node)) return;
    const key = path[path.length - 1];
    if (key === "kind" && MESSAGE_KINDS.has(node)) return;
    if (key === "who" && node === "나") return;
    found.push(`${path.join(".")}: ${node.slice(0, 80)}`);
  };
  walk(value, []);
  return found;
}

/** 글을 뺀 뼈대: id·상태·종류·시각 같은 값과 숫자·참거짓·배열 길이·열쇠는 그대로 두고, 사람이 읽는 글은 자리표로 바꾼다. */
function skeleton(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map(item => skeleton(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([name]) => !SKELETON_SKIP.has(name)).map(([name, item]) => [name, skeleton(item, name)]));
  }
  if (typeof value === "string") {
    const structural = SKELETON_KEEP.has(key) || /(Id|Ids|At)$/.test(key) || /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/.test(value);
    return structural ? value : "·";
  }
  return value;
}
/** 두 벌에서 같아야 하는 문자열 칸. */
const SKELETON_KEEP = new Set(["id", "status", "kind", "sec", "delivery", "rec", "k", "choice", "cli", "provider", "handle", "mime", "model", "outcome", "closeKind", "window", "day", "phase", "source", "quality", "freshness", "ownership", "backend", "permissionMode"]);
/** 글의 길이·언어에 따라 달라지는 값(크기, 발췌, 보고 언어 설정). */
const SKELETON_SKIP = new Set(["size", "bytes", "sizeBytes", "chars", "lineCount", "excerpt", "reportLanguage"]);

/** 앱 소스(SampleWorkspaceData.swift)에 든 두 벌. 없는 벌은 undefined. */
function readBlocks(): Partial<Record<Lang, string>> {
  const source = readFileSync(OUTPUT, "utf8");
  const blocks: Partial<Record<Lang, string>> = {};
  for (const lang of ["ko", "en"] as const) {
    const match = new RegExp(`static let ${BLOCK[lang]} = ##"""\\n([\\s\\S]*?)\\n"""##`).exec(source);
    if (match) blocks[lang] = match[1];
  }
  return blocks;
}

function writeBlock(lang: Lang, json: string) {
  let blocks: Partial<Record<Lang, string>> = {};
  try { blocks = readBlocks(); } catch { /* 파일이 없으면 새로 만든다 */ }
  blocks[lang] = json;
  writeFileSync(OUTPUT, renderSwift(blocks.ko ?? "{}", blocks.en ?? "{}"));
}

/** 진단 값에서 이 Mac 의 실행 파일 경로·버전 같은 것을 뺀다. 화면은 실행 엔진이 '준비됨'인지만 읽는다. */
function scrubRuntime(runtime: Record<string, any>): Record<string, any> {
  return JSON.parse(JSON.stringify(runtime, (key, value) => {
    if (typeof value === "string" && (key.toLowerCase().includes("path") || key.toLowerCase().includes("bin") || key === "socket")) return undefined;
    return value;
  }));
}

function renderSwift(korean: string, english: string): string {
  for (const json of [korean, english]) if (json.includes('"""##')) throw new Error("샘플 자료에 Swift 문자열 끝 표시가 들어 있습니다");
  return `// 이 파일은 tests/sample-workspace.test.ts 가 실제 서버 응답으로 만든다. 손으로 고치지 않는다.
// 다시 만들기: IAMCEO_UPDATE_SAMPLE=1 bun test tests/sample-workspace.test.ts
// 샘플 모드의 가짜 서버(SampleServer.swift)가 이 자료로 답한다. 앱 화면 언어가 영어면 \`english\`, 아니면 \`json\`(한국어).

enum SampleWorkspaceData {
    static let json = ##"""
${korean}
"""##

    static let english = ##"""
${english}
"""##
}
`;
}
