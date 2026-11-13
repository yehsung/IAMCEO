// F8: 앱의 '샘플로 둘러보기'가 쓰는 자료를 실제 서버에서 만든다.
// 샘플은 앱 안의 가짜 서버(native/Sources/IAMCEO/State/SampleServer.swift)가 이 자료로 답한다. 화면은 실제 서버에 붙은 것과 같은
// 코드(해석기, 대화 페이지, 쓰기 경로)를 그대로 탄다. 자료를 손으로 만들지 않고 이 시험이 실제 Store·HTTP 경로로 만들어
// 서버 응답 모양이 바뀌면 샘플도 따라 바뀐다.
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
import type { ActivityKind, MemberOrigin, MemberStatus } from "../shared/types.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const OUTPUT = resolve(import.meta.dir, "../native/Sources/IAMCEO/State/SampleWorkspaceData.swift");
/** 자료 속 시각의 기준. 앱은 이 시각을 '지금'으로 옮긴다. */
const BASE = Date.parse("2026-01-05T09:00:00.000Z");
/** 자료 속 경로의 홈. 실제 사용자 홈이 남지 않게 모든 경로를 여기로 바꾼다. */
const SAMPLE_HOME = "/Users/sample";
const FORMAT = 1;

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

// ---- 작은 PNG(현재 결제 버튼 캡처): 글자 없이 카드·입력칸·버튼 모양만 ----
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

const ARTIFACT_HTML = `<!doctype html>
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
</html>`;

let restoreTime = false;
// 사용량의 날짜(YYYY-MM-DD)는 서버가 도는 곳의 시간대로 나뉜다. 자료가 어느 Mac 에서 만들어도 같게 UTC 로 고정한다(앱은 날짜도 오늘로 옮긴다).
const zone = process.env.TZ;
afterAll(() => { if (restoreTime) setSystemTime(); if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });

test("샘플 모드의 자료를 실제 서버 응답으로 만든다(앱에 든 자료가 낡지 않았는지 확인)", async () => {
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
  store.patchSettings({ boardTidyHours: 0, permissionAcknowledged: true });
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
    const pay = store.createProject({ id: "sample-pay", name: "결제 페이지 개편", cwd: shop });
    at(60 * 24);
    const deck = store.createProject({ id: "sample-ir", name: "투자 IR 자료", cwd: ir });
    store.patchProject("hq", { now: "새 프로젝트 요청을 기다립니다." });
    const pid = pay.id;

    // ---- 팀장(총괄 1 + 팀장 8): 일하는 중·내 답 기다림·쉬는 중·잠듦이 섞인 건강한 팀 ----
    interface Seat { key: string; handle: string; name: string; role: string; kind: "conductor" | "worker"; cli: "claude" | "codex"; model: string | null;
      status: MemberStatus; now: string; next: string; contextPct: number | null; subagents?: number; minutesAgo: number }
    const seats: Seat[] = [
      { key: "m-chief", handle: "chief", name: "결제 총괄", role: "프로젝트 총괄", kind: "conductor", cli: "claude", model: "opus", status: "working",
        now: "PG 연동 결과와 문구 결정을 묶어 다음 지시를 정리하는 중", next: "결재 답이 오면 구현 팀장에게 전달", contextPct: 38, minutesAgo: 1 },
      { key: "m-pg", handle: "pg", name: "결제 연동", role: "PG 시험 연동 · 실패 코드", kind: "worker", cli: "codex", model: "gpt-6-astra", status: "waiting",
        now: "PG 시험 연동 — 실패 응답 코드 정리", next: "완료 문구가 정해지면 화면에 반영", contextPct: 22, minutesAgo: 9 },
      { key: "m-copy", handle: "copy", name: "화면 문구", role: "완료·실패 화면 문구", kind: "worker", cli: "claude", model: "sonnet", status: "working",
        now: "완료 화면 문구를 다듬는 중", next: "실패 화면 문구", contextPct: 51, subagents: 2, minutesAgo: 0.5 },
      { key: "m-card", handle: "card", name: "카드 결제 구현", role: "카드 결제 화면", kind: "worker", cli: "codex", model: "gpt-6-astra", status: "working",
        now: "카드 결제 화면 구현 — 결제 버튼과 입력 검증을 잇는 중", next: "시험 통과 후 결과 보고", contextPct: 44, subagents: 1, minutesAgo: 2 },
      { key: "m-research", handle: "research", name: "자료 조사", role: "PG 비교 · 계약 조건", kind: "worker", cli: "claude", model: "sonnet", status: "idle",
        now: "결제 방식 비교표를 정리했다고 보고", next: "PG 결정 뒤 계약 조건 요약", contextPct: 17, minutesAgo: 20 },
      { key: "m-funnel", handle: "funnel", name: "이탈률 측정", role: "결제 단계별 이벤트", kind: "worker", cli: "codex", model: "gpt-6-astra", status: "idle",
        now: "결제 단계별 이탈 이벤트 이름을 정리했다고 보고", next: "구현이 끝나면 이벤트 심기", contextPct: 28, minutesAgo: 5 },
      { key: "m-qa", handle: "qa", name: "결제 QA", role: "회귀 시험", kind: "worker", cli: "claude", model: null, status: "asleep",
        now: "", next: "구현이 끝나면 결제 회귀 시험", contextPct: null, minutesAgo: 90 },
      { key: "m-mail", handle: "mail", name: "영수증 메일", role: "결제 완료 메일", kind: "worker", cli: "claude", model: "sonnet", status: "idle",
        now: "영수증 메일 템플릿 초안을 올렸다고 보고", next: "", contextPct: 12, minutesAgo: 30 },
      { key: "m-settle", handle: "settle", name: "정산 리포트", role: "일별 정산 요약", kind: "worker", cli: "codex", model: null, status: "asleep",
        now: "지난주 정산 요약을 보고", next: "", contextPct: null, minutesAgo: 60 * 20 },
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
      { key: "m-ir-chief", handle: "chief", name: "IR 총괄", role: "프로젝트 총괄", kind: "conductor" as const, cli: "claude" as const, status: "working" as MemberStatus, now: "재무 요약 슬라이드 순서를 정하는 중" },
      { key: "m-ir-deck", handle: "deck", name: "슬라이드 작성", role: "재무 요약 · 시장 규모", kind: "worker" as const, cli: "claude" as const, status: "idle" as MemberStatus, now: "시장 규모 슬라이드를 올렸다고 보고" },
      { key: "m-ir-num", handle: "numbers", name: "숫자 검토", role: "재무 표 검산", kind: "worker" as const, cli: "codex" as const, status: "asleep" as MemberStatus, now: "" },
    ];
    for (const [index, seat] of irSeats.entries()) {
      at(60 * 23 - index);
      const created = store.createMember({ projectId: deck.id, handle: seat.handle, name: seat.name, role: seat.role, kind: seat.kind, cli: seat.cli,
        backend: "core", status: "idle", sessionId: session(), paneId: `sample:ir-${seat.handle}`, cwd: ir });
      members.set(seat.key, keep(created, seat.key).id);
    }
    // 본사에는 새 프로젝트를 받아 줄 총괄 하나가 쉬고 있다.
    at(60 * 29);
    members.set("m-hq", keep(store.createMember({ projectId: "hq", handle: "chief", name: "본사 총괄", role: "새 프로젝트 준비", kind: "conductor", cli: "claude",
      backend: "core", status: "idle", sessionId: session(), paneId: "sample:hq", cwd: SAMPLE_HOME }), "m-hq").id);
    const id = (key: string) => members.get(key)!;

    // ---- 자료 ----
    at(60 * 25);
    const png = paymentButtonPng();
    const form = new FormData(); form.append("file", new File([new Uint8Array(png)], "payment-button.png", { type: "image/png" }));
    const uploaded = await fetch(`${base}/api/uploads?project=${pid}`, { method: "POST", headers: auth, body: form });
    expect(uploaded.status).toBe(200);
    const shot = await uploaded.json() as { id: string; url: string; mime: string };
    rename.set(shot.id, "a-shot");
    const shotFile = keep(store.createFile({ projectId: pid, kind: "image", title: "현재 결제 버튼 캡처", who: "카드 결제 구현", memberId: id("m-card"),
      summary: "모바일 결제 버튼 현재 상태", attachments: [store.getAttachment(shot.id)!] }), "f-shot");
    at(60 * 22);
    const funnel = keep(store.createFile({ projectId: pid, kind: "table", title: "결제 단계별 이탈률", who: "이탈률 측정", memberId: id("m-funnel"),
      summary: "지난 4주 결제 단계별 이탈률", body: "단계,방문,이탈률\n장바구니,12840,18%\n주문서,10529,24%\n결제 수단 선택,8002,31%\n결제 완료,5521,-" }), "f-funnel");
    at(35);
    keep(store.createFile({ projectId: pid, kind: "code", title: "payment-config.ts", who: "카드 결제 구현", memberId: id("m-card"), path: "src/payment/payment-config.ts",
      summary: "PG 키와 결제 수단 설정",
      body: "export const payment = {\n  provider: process.env.PG_PROVIDER ?? \"toss\",\n  methods: [\"card\", \"transfer\", \"easy-pay\"],\n  retry: { max: 2, backoffMs: 800 },\n}\n" }), "f-config");
    at(20);
    const fee = keep(store.createFile({ projectId: pid, kind: "document", title: "결제 수단별 수수료 비교", who: "자료 조사", memberId: id("m-research"),
      summary: "토스페이먼츠·KG이니시스의 수수료, 정산 주기, 연동 난이도를 비교했습니다.",
      body: "# 결제 수단별 수수료 비교\n\n## 요약\n토스페이먼츠가 연동 문서와 정산 주기에서 앞서고, KG이니시스는 수수료가 0.2%p 낮습니다.\n\n## 비교\n| PG사 | 수수료 | 정산 | 연동 |\n|---|---:|:-:|---|\n| 토스페이먼츠 | 2.9% | D+2 | 시험 키 즉시 발급, `sandbox` 제공 |\n| KG이니시스 | 2.7% | D+3 | 기존 계약 있음, 시험 키는 2~3일 |\n\n> 결제 금액 1만~5만 원 구간이 전체 결제의 70%입니다.\n\n## 남은 확인\n- [x] 정산 주기 확인\n- [ ] 간편결제 수수료 별도 여부\n- [ ] 해지 위약금\n" }), "f-fee");
    at(4);
    const mock = keep(store.createFile({ projectId: pid, kind: "artifact", title: "완료·실패 화면 시안", who: "화면 문구", memberId: id("m-copy"),
      summary: "완료 화면 2안, 실패 화면 2안을 나란히 비교하는 HTML 시안", html: ARTIFACT_HTML }), "f-copy");
    at(60 * 3);
    keep(store.createFile({ projectId: deck.id, kind: "document", title: "시장 규모 요약", who: "슬라이드 작성", memberId: id("m-ir-deck"),
      summary: "국내 간편결제 시장 규모와 성장률을 한 장으로 정리했습니다.",
      body: "# 시장 규모 요약\n\n- 국내 간편결제 거래액: 연 280조 원\n- 최근 3년 연평균 성장률: 18%\n- 우리 고객층(20~30대) 비중: 46%\n" }), "f-ir-market");

    // ---- 결재(열린 2 + 답해서 전달된 3 + 대화로 정리된 1) ----
    at(60 * 5);
    const old = keep(store.createDecision({ projectId: pid, memberId: id("m-research"), who: "자료 조사", title: "비교 대상에 페이팔을 넣을까요?", detail: "해외 결제가 필요하면 넣습니다." }), "d-old");
    at(60 * 4);
    store.closeDecision(old.id, { kind: "decided", reason: "대화에서 국내 결제만 한다고 정했습니다.", by: "자료 조사", quote: "해외 결제는 이번엔 빼죠" });
    at(60 * 3);
    const button = keep(store.createDecision({ projectId: pid, memberId: id("m-card"), who: "카드 결제 구현", title: "결제 버튼 색을 정해 주세요", detail: "브랜드 보라와 기본 파랑 중 하나입니다.",
      options: [{ k: "a", label: "기본 파랑" }, { k: "b", label: "브랜드 보라" }], rec: "a" }), "d-button");
    at(60 * 2);
    store.answerDecision(button.id, { choice: "a", note: "접근성 대비 기준을 지켜 주세요.", expectedVersion: store.requireDecision(button.id).updatedAt });
    at(60 * 2 - 1);
    store.setDecisionStatus(button.id, "delivered");
    at(55);
    const fail = keep(store.createDecision({ projectId: pid, memberId: id("m-copy"), who: "화면 문구", title: "실패 문구를 골라 주세요", detail: "실패 화면 첫 줄입니다. 가장 흔한 실패 원인은 카드 한도와 인증 취소입니다.",
      options: [{ k: "a", label: "다시 시도해 주세요", desc: "원인을 말하지 않아 같은 실패가 반복될 수 있습니다." }, { k: "b", label: "카드를 확인해 주세요", desc: "가장 흔한 원인을 바로 안내합니다." }], rec: "b" }), "d-fail-copy");
    at(50);
    const receipt = keep(store.createDecision({ projectId: pid, memberId: id("m-pg"), who: "결제 연동", title: "영수증 메일을 보낼까요?", detail: "결제 완료 직후 영수증 메일을 자동 발송할지 정해 주세요.",
      options: [{ k: "a", label: "보낸다" }, { k: "b", label: "보내지 않는다" }] }), "d-receipt");
    at(32);
    store.answerDecision(receipt.id, { choice: "a", expectedVersion: store.requireDecision(receipt.id).updatedAt });
    at(31);
    store.setDecisionStatus(receipt.id, "delivered");
    at(25);
    keep(store.createDecision({ projectId: pid, memberId: id("m-research"), who: "자료 조사", title: "PG사를 어디로 할지 정해 주세요",
      detail: "결제 연동을 시작하려면 PG사를 하나 정해야 합니다. 비교표를 자료에 올렸습니다.\n\n- 고객 문의 1위가 '결제됐나요?'라서 정산·알림이 빠른 쪽이 유리합니다\n- 기존 KG이니시스 계약은 내년 3월에 끝납니다",
      options: [{ k: "a", label: "토스페이먼츠", desc: "수수료 2.9%, 정산 D+2. 연동 문서가 가장 좋아 구현이 이틀 빠릅니다." },
        { k: "b", label: "KG이니시스", desc: "수수료 2.7%, 정산 D+3. 기존 계약을 그대로 씁니다." },
        { k: "c", label: "둘 다 붙이고 비교", desc: "구현이 3일 늘고, 2주 뒤 전환율로 고릅니다." }], rec: "a", fileId: fee.id }), "d-pg");
    at(12);
    const doneCopy = keep(store.createDecision({ projectId: pid, memberId: id("m-pg"), who: "결제 연동", title: "결제 완료 문구를 골라 주세요", detail: "완료 화면 첫 줄입니다. 사용자가 결제 성공을 바로 알아야 합니다.",
      options: [{ k: "a", label: "결제가 끝났습니다", desc: "결과를 바로 말합니다. 영수증 링크를 아래에 둡니다." }, { k: "b", label: "감사합니다", desc: "친근하지만 성공 여부가 덜 분명합니다." }], rec: "a", fileId: mock.id }), "d-done-copy");
    at(9);
    store.answerDecision(fail.id, { choice: "b", note: "고객센터 번호도 함께 보여 주세요.", expectedVersion: store.requireDecision(fail.id).updatedAt });
    at(8);
    store.setDecisionStatus(fail.id, "delivered");
    at(60 * 2);
    keep(store.createDecision({ projectId: deck.id, memberId: id("m-ir-deck"), who: "슬라이드 작성", title: "첫 장에 넣을 숫자를 골라 주세요", detail: "투자자가 첫 장에서 기억할 숫자 하나를 정합니다.",
      options: [{ k: "a", label: "월 거래액 12억 원" }, { k: "b", label: "재구매율 64%" }], rec: "b" }), "d-ir-number");

    // ---- 대표 할 일 ----
    at(60 * 5);
    const contact = keep(store.createTodo({ projectId: pid, who: "결제 총괄", title: "PG 담당자 연락처 전달" }), "t-done");
    at(60 * 3);
    store.setTodoDone(contact.id, true);
    at(60 * 2);
    keep(store.createTodo({ projectId: pid, memberId: id("m-research"), who: "자료 조사", title: "개인정보 처리방침 확인", detail: "결제 정보 보관 기간 문구를 법무 기준으로 확인해 주세요." }), "t-policy");
    at(30);
    keep(store.createTodo({ projectId: pid, memberId: id("m-card"), who: "카드 결제 구현", title: "PG 시험 계정 만들어 주기", detail: "토스페이먼츠 개발자센터에서 시험 키 발급이 필요합니다. 발급 뒤 키를 대화로 보내 주세요." }), "t-key");
    at(18);
    keep(store.createTodo({ projectId: pid, memberId: id("m-pg"), who: "결제 연동", title: "로고 원본 파일 보내기", detail: "완료 화면에 넣을 로고가 필요합니다.\n- SVG면 좋습니다\n- 없으면 PNG" }), "t-logo");

    // ---- 진행판 ----
    const work: Array<[string, "doing" | "next" | "hold" | "done", string, string, string, number]> = [
      ["w9", "done", "결제 수단 목록 정리", "", "결제 총괄", 60 * 26],
      ["w8", "done", "영수증 메일 템플릿", "", "영수증 메일", 30],
      ["w7", "done", "결제 방식 비교표", "", "자료 조사", 20],
      ["w1", "doing", "PG 시험 연동", "실패 응답 코드 표 정리", "결제 연동", 40],
      ["w2", "doing", "완료·실패 화면 문구", "", "화면 문구", 39],
      ["w3", "doing", "카드 결제 화면 구현", "결제 버튼·입력 검증 연결", "카드 결제 구현", 38],
      ["w4", "next", "이탈률 측정 넣기", "", "이탈률 측정", 37],
      ["w5", "next", "결제 회귀 시험", "", "결제 QA", 36],
      ["w6", "hold", "간편결제 추가", "PG 결정 뒤 재개", "결제 총괄", 35],
    ];
    for (const [key, sec, title, detail, who, minutesAgo] of work) {
      at(minutesAgo);
      keep(store.upsertWork({ projectId: pid, sec, title, detail, who }), key);
    }
    at(60 * 3);
    keep(store.upsertWork({ projectId: deck.id, sec: "doing", title: "재무 요약 슬라이드", who: "IR 총괄" }), "w-ir-1");

    // ---- 대화(대표의 지시는 모두 전달됨) ----
    type Line = { key: string; minutesAgo: number; member?: string; mine?: boolean; kind: "진행" | "완료" | "질문" | "나"; title?: string; body: string; target?: string; decision?: string; file?: string };
    const lines: Line[] = [
      { key: "x1", minutesAgo: 40, member: "m-chief", kind: "진행", title: "오늘 계획", body: "1. PG사 결정 받기\n2. 완료·실패 문구 확정\n3. 카드 결제 화면 시험 통과" },
      { key: "x2", minutesAgo: 38, mine: true, kind: "나", body: "PG 연동은 이번 주 안에 끝내 주세요." },
      { key: "x3", minutesAgo: 20, member: "m-research", kind: "완료", title: "결제 방식 비교표를 올렸습니다", body: "수수료·정산 주기·연동 난이도를 비교했습니다. PG사 결정은 결재함에 올렸습니다.", file: fee.id },
      { key: "x4", minutesAgo: 14, member: "m-card", kind: "진행", title: "카드 결제 화면 1차 구현", body: "- 카드 번호·유효기간 입력 검증\n- 결제 버튼 상태(대기·진행·완료)\n- 다음: 결제 버튼과 PG 시험 연동 잇기" },
      { key: "x5", minutesAgo: 12, member: "m-pg", kind: "질문", title: "결제 완료 문구 결정 요청", body: "두 안 중 하나를 골라 주세요.", decision: doneCopy.id },
      { key: "x6", minutesAgo: 8, mine: true, kind: "나", body: "실패 화면에는 고객센터 번호도 넣어 주세요.", target: "m-copy" },
      { key: "x7", minutesAgo: 7, mine: true, kind: "나", body: "이탈 이벤트 이름부터 정리해 주세요.", target: "m-funnel" },
      { key: "x11", minutesAgo: 5, member: "m-funnel", kind: "완료", title: "이탈 이벤트 이름을 정리했습니다", body: "장바구니 → 주문서 → 결제 수단 선택 → 결제 완료, 네 단계의 이벤트 이름과 속성을 정했습니다. 지난 4주 이탈률 표는 자료에 있습니다.", file: funnel.id },
      { key: "x8", minutesAgo: 4, member: "m-copy", kind: "진행", title: "완료 화면 문구 초안", body: "- 짧게 한 줄\n- 다음 행동 안내 한 줄\n- 영수증 링크는 버튼으로" },
      { key: "x9", minutesAgo: 2, mine: true, kind: "나", body: "결제 버튼은 화면 아래에 고정해 주세요.", target: "m-card" },
      { key: "x10", minutesAgo: 1, mine: true, kind: "나", body: "문구 결정은 오늘 오후에 할게요." },
    ];
    for (const line of lines) {
      const sentAt = at(line.minutesAgo);
      const seat = line.member ? seats.find(s => s.key === line.member) : undefined;
      const target = line.target ? seats.find(s => s.key === line.target) : undefined;
      store.createMessage({ id: line.key, projectId: pid, at: sentAt, kind: line.kind, title: line.title, body: line.body,
        mine: line.mine, who: line.mine ? "나" : seat?.name, memberId: line.member ? id(line.member) : null,
        targetMemberId: target ? id(target.key) : null, targetName: target?.name ?? null,
        decisionId: line.decision ?? null, fileId: line.file ?? null, delivery: line.mine ? "delivered" : null });
    }
    const irLine = at(60 * 3);
    store.createMessage({ id: "x-ir-1", projectId: deck.id, at: irLine, kind: "진행", title: "재무 요약 슬라이드 작성 중", body: "매출·거래액·재구매율 세 장으로 나눴습니다.", who: "IR 총괄", memberId: id("m-ir-chief") });
    // 이미지 자료를 올렸다는 보고(첨부가 대화에서도 보인다).
    void shotFile;

    // ---- 활동(팀장 상세의 '활동') ----
    const activity: Array<[string, ActivityKind, string, number]> = [
      ["m-copy", "turn_start", "지시를 받았습니다: 실패 화면에 고객센터 번호 넣기", 8],
      ["m-copy", "tool", "읽기 src/pages/checkout/complete.tsx", 6],
      ["m-copy", "text", "완료 화면 첫 줄을 '결제가 끝났습니다'로 두고 다음 행동 안내를 아래에 붙입니다.", 4],
      ["m-copy", "tool", "고치기 src/pages/checkout/complete.tsx", 1],
      ["m-card", "turn_start", "지시를 받았습니다: 결제 버튼을 화면 아래에 고정", 2],
      ["m-card", "tool", "읽기 src/payment/PayButton.tsx", 2],
      ["m-card", "text", "버튼을 안전 영역 위에 고정하고 키보드가 올라오면 함께 올라가게 합니다.", 1],
      ["m-chief", "text", "결재 두 건(PG사, 완료 문구)의 답을 기다리는 동안 구현 순서를 정리합니다.", 1],
      ["m-pg", "turn_end", "실패 응답 코드 표를 정리했습니다. 완료 문구 결정을 기다립니다.", 9],
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
    store.patchMember(id("m-hq"), { status: "idle", now: "새 프로젝트 요청을 기다립니다.", nowAt: at(60 * 3),
      statusObservation: { source: "core", observedAt: new Date(BASE).toISOString(), freshness: "fresh", ownership: "verified", consecutiveFailures: 0, error: null } });
    at(6);
    store.patchProject(pid, { now: "**자료 조사**가 결제 방식 비교표를 올렸고, **카드 결제 구현**은 결제 화면을 만들고 있습니다. PG사와 완료 문구 결정 2건이 대표의 답을 기다립니다." });
    at(60 * 2);
    store.patchProject(deck.id, { now: "재무 요약 슬라이드 작성 중" });

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
    const json = JSON.stringify(data, null, 1);

    // 사용자 홈·계정 이름·임시 경로·실제 포트가 남지 않는다.
    const leaks = [homedir(), "/private/tmp", `:${server.port}`, "127.0.0.1"];
    expect(leaks.filter(leak => json.includes(leak))).toEqual([]);
    // 계정 이름은 제품 어휘와 겹칠 수 있어 자리를 보고 찾는다(accountNameLeaks). 겹치는 이름으로도 진짜 새는 자리는 잡는지 먼저 확인한다.
    expect(accountNameLeaks({ origin: "runner", runnerEnabled: true, cwd: "/Users/runner/work/x", host: "runners-MacBook-Pro", owner: "runner", runner: 1 }, "runner"))
      .toEqual(["$.cwd", "$.host", "$.owner", "$.runner (키)"]);
    const account = userInfo().username;
    if (account.length >= 4) expect(accountNameLeaks(data, account)).toEqual([]);
    // 화면이 보여 줄 것이 실제로 실렸다.
    const main = data.projects["sample-pay"];
    expect(main.state.members.length).toBe(9);
    expect(main.state.decisions.filter((d: any) => d.status === "open").length).toBe(2);
    expect(main.state.messages.filter((m: any) => m.mine).every((m: any) => m.delivery === "delivered")).toBe(true);
    expect(main.state.members.every((m: any) => !["blocked", "error", "offline"].includes(m.status))).toBe(true);
    expect(data.artifacts["f-copy"]).toContain("완료·실패 화면 시안");
    expect(data.artifactDocuments["f-copy"]).toContain("완료·실패 화면 시안");
    expect(data.artifactPolicy).toContain("sandbox allow-scripts");
    expect(Object.keys(data.blobs)).toHaveLength(1);

    const swift = renderSwift(json);
    if (process.env.IAMCEO_UPDATE_SAMPLE === "1") writeFileSync(OUTPUT, swift);
    const current = readFileSync(OUTPUT, "utf8");
    const embedded = /##"""\n([\s\S]*)\n"""##/.exec(current)?.[1];
    // 다르면 서버 응답 모양이 바뀐 것이다. 위 머리말의 명령으로 샘플 자료를 다시 만든다.
    const inApp = embedded ? JSON.parse(embedded) : null, fresh = JSON.parse(json);
    if (!Bun.deepEquals(inApp, fresh)) console.error("앱에 든 샘플 자료가 지금 서버 응답과 다릅니다. 다시 만들기: IAMCEO_UPDATE_SAMPLE=1 bun test tests/sample-workspace.test.ts");
    expect(inApp).toEqual(fresh);
  } finally {
    await server?.stop();
    await orch.shutdown();
    store.db.close();
    await isolated.stop();
    setSystemTime();
    restoreTime = false;
  }
}, 60_000);

/** 닫힌 목록인 값 자리. 이 자리의 값은 서버가 정한 낱말이라 기계에서 온 값이 아니다. */
const PRODUCT_VALUES: Record<string, readonly string[]> = { origin: ["runner", "adopted", "manual"] satisfies MemberOrigin[] };

/**
 * 자료에서 계정 이름이 든 자리(JSON 경로). 이름은 제품 어휘와 겹칠 수 있다: GitHub macOS 러너의 계정은 'runner' 이고, 자료에는 직원 출처
 * "origin": "runner" 와 키 "runnerEnabled" 가 늘 있다. 그래서 글 전체에서 낱말을 찾지 않고, 키와 글 값마다 찾되 두 자리만 뺀다:
 * 낙타 표기의 합성 필드 이름(runnerEnabled 처럼 이름 + 다른 낱말인 키)과 닫힌 목록 값 자리(PRODUCT_VALUES)의 목록 안 값.
 * 그 밖에는 이름이 어디에 들어 있어도(경로 /Users/<이름>/…, 호스트 <이름>s-MacBook-Pro, 값 자체, 키 자체) 잡는다.
 */
function accountNameLeaks(value: unknown, name: string, path = "$"): string[] {
  if (typeof value === "string") return value.includes(name) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => accountNameLeaks(item, name, `${path}[${index}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const child = `${path}.${key}`;
    const fieldName = key !== name && /^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(key);
    const keyLeak = key.includes(name) && !fieldName ? [`${child} (키)`] : [];
    if (typeof item === "string" && PRODUCT_VALUES[key]?.includes(item)) return keyLeak;
    return [...keyLeak, ...accountNameLeaks(item, name, child)];
  });
}

/** 진단 값에서 이 Mac 의 실행 파일 경로·버전 같은 것을 뺀다. 화면은 실행 엔진이 '준비됨'인지만 읽는다. */
function scrubRuntime(runtime: Record<string, any>): Record<string, any> {
  return JSON.parse(JSON.stringify(runtime, (key, value) => {
    if (typeof value === "string" && (key.toLowerCase().includes("path") || key.toLowerCase().includes("bin") || key === "socket")) return undefined;
    return value;
  }));
}

function renderSwift(json: string): string {
  if (json.includes('"""##')) throw new Error("샘플 자료에 Swift 문자열 끝 표시가 들어 있습니다");
  return `// 이 파일은 tests/sample-workspace.test.ts 가 실제 서버 응답으로 만든다. 손으로 고치지 않는다.
// 다시 만들기: IAMCEO_UPDATE_SAMPLE=1 bun test tests/sample-workspace.test.ts
// 샘플 모드의 가짜 서버(SampleServer.swift)가 이 자료로 답한다.

enum SampleWorkspaceData {
    static let json = ##"""
${json}
"""##
}
`;
}
