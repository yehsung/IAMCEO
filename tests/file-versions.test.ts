// 0.2.10 자료 판 잇기: 제목 정규화·자동 잇기 규칙(server/file-versions.ts), 판 연결을 html 넘침 페이지 없이 읽기, file 도구의
// 자동 잇기·new_item·find·unchain·original, iamceo files tidy(계획·적용·되돌리기)와 그 HTTP·명령줄 길.
// 견본 제목·글은 같은 모양의 가짜 글이다(대표의 실제 자료 제목은 넣지 않는다).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAgentTool } from "../server/agent-tools.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { ensureFileVersionSchema, FILE_VERSION_SCHEMA, MIGRATIONS, openDb } from "../server/db.ts";
import { compareVersions, pickPrevious, planTidy, SAME_TITLE_WINDOW_MS, titleParts, tidyPlanId, unchainedKey, type ChainFile } from "../server/file-versions.ts";
import { startServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import type { Runner, RunnerEvent, SendResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import type { Backend, FileDoc, Member } from "../shared/types.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

class QuietRunner implements Runner {
  readonly kind: Backend = "core";
  readonly interjects = false;
  async available() { return { ok: true }; }
  async start() { return { sessionId: crypto.randomUUID(), paneId: null }; }
  async send(_member: { id: string }, _text: string): Promise<SendResult> { return { ok: true }; }
  isBusy() { return false; }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop() {}
  async screen() { return ""; }
  async shutdown() {}
  on(_listener: (event: RunnerEvent) => void) {}
}

function testHome(prefix: string): string {
  if (!process.env.IAMCEO_TEST || !process.env.IAMCEO_HOME) throw new Error("Use bun run test:server");
  return mkdtempSync(join(process.env.IAMCEO_HOME, prefix));
}

async function setup() {
  const home = testHome("w11-versions-");
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code", hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env), bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["core", new QuietRunner()]]), notifier: () => {} });
  const server = await startServer({ config, store, bus, orch });
  const url = server.urls[0]!;
  orch.setServerUrl(url);
  cleanups.push(async () => { await orch.shutdown(); await server.stop(); store.db.close(); });
  // 작업 폴더는 데이터 폴더 밖이어야 file 도구가 path 를 읽는다(데이터 폴더는 비밀이 있는 곳으로 막힌다).
  const work = realpathSync(mkdtempSync(join(tmpdir(), "w11-work-")));
  const project = store.createProject({ name: "판 잇기", cwd: work });
  const lead = await orch.ensureConductor(project.id);
  await orch.pump(lead.id);
  const worker = store.createMember({ projectId: project.id, handle: "deck", name: "발표 자료", kind: "worker", backend: "core" });
  const other = store.createMember({ projectId: project.id, handle: "copy", name: "글 다듬기", kind: "worker", backend: "core" });
  const tool = (member: Member, name: string, args: Record<string, unknown>) => handleAgentTool(orch, store.requireMember(member.id), name, args);
  const publish = async (member: Member, args: Record<string, unknown>) => {
    const result = await tool(member, "file", args);
    expect({ error: result.isError ?? false, text: result.isError ? result.text : "" }).toEqual({ error: false, text: "" });
    return { id: /#(f_[A-Za-z0-9]+)/.exec(result.text)![1]!, text: result.text };
  };
  const auth = { Authorization: "Bearer code" };
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${url}${path}`, { headers: { ...auth, ...headers }, signal: AbortSignal.timeout(5000) });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${url}${path}`, {
    method: "POST", headers: { ...auth, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  return { home, work, config, store, orch, url, project, lead, worker, other, tool, publish, get, post };
}

/** 고정물: created_at 을 정해 둔 자료(시간 창을 시험한다). */
function backdate(store: Store, id: string, at: Date) {
  store.db.query("UPDATE files SET created_at = ? WHERE id = ?").run(at.toISOString(), id);
}

const file = (id: string, title: string, at: number, extra: Partial<ChainFile> = {}): ChainFile => ({
  id, projectId: "p", memberId: "m", kind: "document", title, createdAt: new Date(Date.UTC(2026, 10, 1) + at).toISOString(), replaces: null, replacedBy: null, ...extra,
});

describe("제목 정규화", () => {
  test("판 표시를 걷고 번호를 읽는다(v12·V3·v1.2·3판·제3판·판 3·새 판 4·2차 시안·버전 2·초안·최종·(수정)·(최신))", () => {
    const cases: [string, string, number[] | null][] = [
      ["발표 자료 v12", "발표 자료", [12]],
      ["발표 자료 V3", "발표 자료", [3]],
      ["Deck v1.2 (preview)", "deck", [1, 2]],
      ["발표 자료 3판", "발표 자료", [3]],
      ["제3판 운영 안내", "운영 안내", [3]],
      ["판 3 운영 안내", "운영 안내", [3]],
      ["발표 자료 새 판 4", "발표 자료", [4]],
      ["기획안 2차 시안", "기획안", [2]],
      ["보고서 버전 2", "보고서", [2]],
      ["기획서 초안", "기획서", null],
      ["기획서 최종", "기획서", null],
      ["기획서 (수정)", "기획서", null],
      ["기획서 (최신)", "기획서", null],
      ["기획서 [최신]", "기획서", null],
      ["덱_v2_final", "덱", [2]],
      ["발표 자료 v3 (pptx, 미리보기)", "발표 자료", [3]],
    ];
    for (const [title, full, version] of cases) {
      const parts = titleParts(title);
      expect({ title, full: parts.full, marked: parts.marked, version: parts.version }).toEqual({ title, full, marked: true, version });
    }
  });

  test("판 표시가 아닌 숫자·낱말은 남긴다(영어 1·2, 1차 기출, 2차 회의, 판매·판단, 오류 수정 내역, 1-2 단원)", () => {
    const kept: [string, string][] = [
      ["편입기출 영어 1", "편입기출 영어 1"],
      ["편입기출 영어 2", "편입기출 영어 2"],
      ["1차 기출 정리", "1차 기출 정리"],
      ["2차 회의록", "2차 회의록"],
      ["판매 전략", "판매 전략"],
      ["판단 기준", "판단 기준"],
      ["오류 수정 내역", "오류 수정 내역"],
      ["새판매장 안내", "새판매장 안내"],
      ["1-2 발표", "1-2 발표"],
      ["업데이트 공지 문안", "업데이트 공지 문안"],
    ];
    for (const [title, full] of kept) expect({ title, ...pick(titleParts(title)) }).toEqual({ title, full, marked: false });
    expect(titleParts("판매 전략 3판")).toMatchObject({ full: "판매 전략", version: [3] });
  });

  test("날짜는 판 표시가 아니지만 줄기에서 걷고 M-D 로 맞춘다(괄호 안·연월일·월일). 괄호 밖 '1-2'는 날짜가 아니다", () => {
    expect(titleParts("주간 보고 (11-17)")).toMatchObject({ full: "주간 보고", marked: false, dates: ["11-17"] });
    expect(titleParts("주간 보고 2026-11-17 v2")).toMatchObject({ full: "주간 보고", marked: true, dates: ["11-17"], version: [2] });
    expect(titleParts("11월 17일 회의록")).toMatchObject({ full: "회의록", dates: ["11-17"] });
    expect(titleParts("주간 보고 (11/24 기준)")).toMatchObject({ stem: "주간 보고", dates: ["11-24"] });
    expect(titleParts("1-2 발표 v2")).toMatchObject({ full: "1-2 발표", dates: [] });
    expect(titleParts("주간 보고 (13-40)").dates).toEqual([]);
  });

  test("날짜임이 분명한 꼴(연도·M월 D일·괄호 속 M/D)만 datesClear. 괄호 속 '1-2'·'1.3' 은 단원 번호일 수 있다", () => {
    expect(titleParts("주간 보고 2026-11-17").datesClear).toBe(true);
    expect(titleParts("11월 17일 회의록").datesClear).toBe(true);
    expect(titleParts("주간 보고 (11/17)").datesClear).toBe(true);
    expect(titleParts("주간 보고").datesClear).toBe(true);
    expect(titleParts("강의 자료 (1-2) v1")).toMatchObject({ dates: ["1-2"], datesClear: false });
    expect(titleParts("강의 자료 [1.3] v1")).toMatchObject({ dates: ["1-3"], datesClear: false });
  });

  test("꼬리의 순번(N화·Part N·#N·N/M)은 표시하고, '12장'처럼 분량은 순번이 아니다", () => {
    expect(titleParts("대본 v2 (3화)")).toMatchObject({ stem: "대본", ordinal: true });
    expect(titleParts("강의안 v2 (Part 2)").ordinal).toBe(true);
    expect(titleParts("발표 자료 v2 (pptx, 12장)").ordinal).toBe(false);
  });

  test("판 번호 비교: 1.2 < 1.10, 없으면 비교하지 않는다", () => {
    expect(compareVersions([1, 2], [1, 10])).toBe(-1);
    expect(compareVersions([2], [2, 0])).toBe(0);
    expect(compareVersions(null, [1])).toBeNull();
  });
});

function pick(parts: ReturnType<typeof titleParts>) { return { full: parts.full, marked: parts.marked }; }

describe("자동 잇기 규칙(pickPrevious)", () => {
  test("판 표시 + 같은 제목: 같은 팀장·같은 종류의 가장 새 최신 판", () => {
    const heads = [file("a", "발표 자료 v1", 0), file("b", "발표 자료 v2", HOUR)];
    expect(pickPrevious(file("n", "발표 자료 v3", 2 * HOUR), heads)).toMatchObject({ chain: true, to: { id: "b" }, basis: "marker+full" });
  });

  test("판 표시 + 같은 앞부분(괄호 꼬리가 달라도): 후보가 하나이고 두 제목 모두 판 번호가 있어 새 판 번호가 클 때만", () => {
    const one = [file("a", "분기 실적 발표 v3 (오프닝 수정)", 0)];
    expect(pickPrevious(file("n", "분기 실적 발표 v4 (클로징 추가)", HOUR), one)).toMatchObject({ chain: true, to: { id: "a" }, basis: "marker+stem" });
    expect(pickPrevious(file("n", "결제 설계 v3 (화면)", HOUR), [file("a", "결제 설계 v2", 0)])).toMatchObject({ chain: true, basis: "marker+stem" });
    const two = [file("a", "분기 실적 발표 (영업)", 0), file("b", "분기 실적 발표 (개발)", HOUR)];
    expect(pickPrevious(file("n", "분기 실적 발표 v2 (요약)", 2 * HOUR), two)).toMatchObject({ chain: false, why: "ambiguous" });
  });

  test("판 번호가 계속 오르는 정상 판은 잇는다('결제 설계 v2'→'v3', '(요약) v1'→'(요약) v2')", () => {
    expect(pickPrevious(file("n", "결제 설계 v3", HOUR), [file("a", "결제 설계 v2", 0)])).toMatchObject({ chain: true, basis: "marker+full" });
    expect(pickPrevious(file("n", "IR 자료 (요약) v2", HOUR), [file("a", "IR 자료 (요약) v1", 0)])).toMatchObject({ chain: true, basis: "marker+full" });
  });

  test("줄기만 같고 판 번호로 새 판임을 알 수 없으면 잇지 않는다(낱말 판 표시 '최종'·'초안'·'수정본'·final, 한쪽만 번호)", () => {
    const pairs: [string, string][] = [
      ["IR 자료 (요약) 최종", "IR 자료 (전체) 최종"],
      ["사업계획서 (요약본) 최종", "사업계획서 (전체본) 최종"],
      ["경쟁사 분석 (토스) 초안", "경쟁사 분석 (카카오페이) 초안"],
      ["랜딩 페이지 (시안 A) 최종", "랜딩 페이지 (시안 B) 최종"],
      ["면접 질문지 (개발) final", "면접 질문지 (디자인) final"],
      ["팀 회의록 (월요일) 수정본", "팀 회의록 (화요일) 수정본"],
      ["마케팅 전략: 인스타그램", "마케팅 전략: 유튜브 초안"],
      ["경쟁사 분석: 토스", "경쟁사 분석: 카카오페이 v1"],
      ["IR 자료 (요약) v1", "IR 자료 (전체) 최종"],
    ];
    for (const [before, after] of pairs) {
      expect({ before, after, verdict: pickPrevious(file("n", after, HOUR), [file("a", before, 0)]) }).toMatchObject({ before, after, verdict: { chain: false, why: "different-tail" } });
    }
    expect(pickPrevious(file("n", "결제 오류 (Android) 수정", HOUR), [file("a", "결제 오류 (iOS) 수정", 0)])).toMatchObject({ chain: false, why: "different-tail" });
    expect(pickPrevious(file("n", "IR 자료 (전체) v1", HOUR), [file("a", "IR 자료 (요약) v1", 0)])).toMatchObject({ chain: false, why: "same-number-different-tail" });
    expect(planTidy([file("s", "사업계획서 (요약본) 최종", 0), file("t", "사업계획서 (전체본) 최종", HOUR)])).toMatchObject({ links: [], skipped: { "different-tail": 1 } });
  });

  test("판 표시 없이 같은 제목으로 다시 올림: 사진·영상이 아니고 48시간 안이면 잇는다. 사진은 잇지 않는다", () => {
    expect(pickPrevious(file("n", "결제 연동 설계", HOUR), [file("a", "결제 연동 설계", 0)])).toMatchObject({ chain: true, basis: "same-title" });
    expect(pickPrevious(file("n", "결제 연동 설계", 48 * HOUR), [file("a", "결제 연동 설계", 0)])).toMatchObject({ chain: true, basis: "same-title" });
    expect(pickPrevious(file("n", "결제 연동 화면", HOUR, { kind: "image" }), [file("a", "결제 연동 화면", 0, { kind: "image" })])).toMatchObject({ chain: false, why: "no-marker" });
  });

  test("같은 이름으로 거듭 올리는 보고는 48시간이 지나면 잇지 않는다(판 표시가 있으면 14일 그대로)", () => {
    expect(SAME_TITLE_WINDOW_MS).toBe(48 * HOUR);
    expect(pickPrevious(file("n", "일일 보고", 49 * HOUR), [file("a", "일일 보고", 0)])).toMatchObject({ chain: false, why: "no-marker" });
    expect(pickPrevious(file("n", "테스트 결과", 3 * DAY), [file("a", "테스트 결과", 0)])).toMatchObject({ chain: false, why: "no-marker" });
    expect(pickPrevious(file("n", "결제 설계 v3", 10 * DAY), [file("a", "결제 설계 v2", 0)])).toMatchObject({ chain: true, basis: "marker+full" });
  });

  test("잇지 않는다: 다른 팀장·다른 종류·이미 옛 판·14일 넘음·대표가 올림·종류 없는 옛 자료", () => {
    const next = file("n", "발표 자료 v2", 20 * DAY);
    expect(pickPrevious(next, [file("a", "발표 자료 v1", 19 * DAY, { memberId: "other" })]).chain).toBe(false);
    expect(pickPrevious(next, [file("a", "발표 자료 v1", 19 * DAY, { kind: "artifact" })]).chain).toBe(false);
    expect(pickPrevious(next, [file("a", "발표 자료 v1", 19 * DAY, { replacedBy: "z" })]).chain).toBe(false);
    expect(pickPrevious(next, [file("a", "발표 자료 v1", 5 * DAY)]).chain).toBe(false);
    expect(pickPrevious(file("n", "발표 자료 v2", HOUR, { memberId: null }), [file("a", "발표 자료 v1", 0, { memberId: null })])).toMatchObject({ chain: false, why: "no-uploader" });
    expect(pickPrevious(file("n", "발표 자료 v2", HOUR, { kind: null }), [file("a", "발표 자료 v1", 0, { kind: null })])).toMatchObject({ chain: false, why: "no-kind" });
  });

  test("숫자만 다른 다른 자료는 따로 둔다('편입기출 영어 1'과 '영어 2', 3화와 2화)", () => {
    expect(pickPrevious(file("n", "편입기출 영어 2", HOUR), [file("a", "편입기출 영어 1", 0)]).chain).toBe(false);
    expect(pickPrevious(file("n", "편입기출 영어 2 v2", HOUR), [file("a", "편입기출 영어 1 v1", 0)]).chain).toBe(false);
    expect(pickPrevious(file("n", "드라마 대본 v2 (3화)", HOUR), [file("a", "드라마 대본 v1 (2화)", 0)])).toMatchObject({ chain: false, why: "ordinal-tail" });
  });

  test("판 번호가 거꾸로 가거나, 같은 번호에 꼬리가 다르면 잇지 않는다", () => {
    expect(pickPrevious(file("n", "발표 자료 v2", HOUR), [file("a", "발표 자료 v3", 0)])).toMatchObject({ chain: false, why: "version-went-down" });
    expect(pickPrevious(file("n", "분기 실적 발표 v1 (클로징)", HOUR), [file("a", "분기 실적 발표 v1 (오프닝)", 0)])).toMatchObject({ chain: false, why: "same-number-different-tail" });
  });

  test("날짜가 다른 같은 제목은 다른 자료다(주간 보고). 판 번호가 분명히 오르고 날짜임이 분명한 꼴이면 그 날짜는 고친 날로 본다", () => {
    expect(pickPrevious(file("n", "주간 보고 (11-24) 수정본", HOUR), [file("a", "주간 보고 (11-17)", 0)])).toMatchObject({ chain: false, why: "different-date" });
    expect(pickPrevious(file("n", "주간 보고 (11-17) 수정본", HOUR), [file("a", "주간 보고 (11-17)", 0)])).toMatchObject({ chain: true });
    expect(pickPrevious(file("n", "분기 실적 발표 v4 (11/18)", HOUR), [file("a", "분기 실적 발표 v3 (11/17)", 0)])).toMatchObject({ chain: true });
    expect(pickPrevious(file("n", "분기 실적 발표 2026-11-18 v4", HOUR), [file("a", "분기 실적 발표 2026-11-17 v3", 0)])).toMatchObject({ chain: true });
    expect(pickPrevious(file("n", "분기 실적 발표 11월 18일 v4", HOUR), [file("a", "분기 실적 발표 11월 17일 v3", 0)])).toMatchObject({ chain: true });
  });

  test("날짜 구멍: 한쪽에만 날짜가 있으면 판 번호가 오를 때만, 괄호 속 '1-2'→'1-3'(단원 번호일 수 있음)은 판 번호가 올라도 잇지 않는다", () => {
    expect(pickPrevious(file("n", "주간 보고 (11/22) 초안", HOUR), [file("a", "주간 보고 최종", 0)])).toMatchObject({ chain: false, why: "different-date" });
    expect(pickPrevious(file("n", "주간 보고 최종", HOUR), [file("a", "주간 보고 (11/22) 초안", 0)])).toMatchObject({ chain: false, why: "different-date" });
    expect(pickPrevious(file("n", "주간 보고 (11/22) v2", HOUR), [file("a", "주간 보고 v1", 0)])).toMatchObject({ chain: true });
    expect(pickPrevious(file("n", "강의 자료 (1-3) v2", HOUR), [file("a", "강의 자료 (1-2) v1", 0)])).toMatchObject({ chain: false, why: "different-date" });
    expect(pickPrevious(file("n", "강의 자료 (1-3) 최종", HOUR), [file("a", "강의 자료 (1-2) 최종", 0)])).toMatchObject({ chain: false, why: "different-date" });
    expect(pickPrevious(file("n", "분기 실적 발표 v4 (11-18)", HOUR), [file("a", "분기 실적 발표 v3 (11-17)", 0)])).toMatchObject({ chain: false, why: "different-date" });
  });

  test("너무 짧은 제목은 잇지 않는다", () => {
    expect(pickPrevious(file("n", "덱 v2", HOUR), [file("a", "덱 v1", 0)])).toMatchObject({ chain: false, why: "too-short" });
    expect(pickPrevious(file("n", "메모", HOUR), [file("a", "메모", 0)])).toMatchObject({ chain: false, why: "too-short" });
  });

  test("정리 계획: 오래된 것부터 한 줄로 잇고, 이미 이은 판은 건드리지 않으며, 계획 번호는 링크로만 정해진다", () => {
    const files = [
      file("a", "발표 자료 v1", 0), file("b", "발표 자료 v2", HOUR), file("c", "발표 자료 v3", 2 * HOUR),
      file("x", "운영 안내 v1", 0, { replacedBy: "y" }), file("y", "운영 안내 v2", HOUR, { replaces: "x" }), file("z", "운영 안내 v3", 2 * HOUR),
      file("q", "다른 문서", 0),
    ];
    const plan = planTidy(files);
    expect(plan.links.map((l) => `${l.previous.id}>${l.next.id}`)).toEqual(["a>b", "b>c", "y>z"]);
    expect(plan.planId).toBe(tidyPlanId(plan.links));
    expect(planTidy([...files].reverse()).planId).toBe(plan.planId);
  });

  test("정리 계획: 팀장이 끊은 쌍과 '새 자료'라고 밝힌 자료는 다시 잇지 않는다(까닭 unchained·new-item). 그 자료의 뒤 판은 잇는다", () => {
    const files = [
      file("a", "결제 연동 설계", 0), file("b", "결제 연동 설계", HOUR),
      file("c", "사업계획서 v1", 0), file("d", "사업계획서 v2", HOUR), file("e", "사업계획서 v3", 2 * HOUR),
    ];
    expect(planTidy(files).links.map((l) => `${l.previous.id}>${l.next.id}`)).toEqual(["a>b", "c>d", "d>e"]);
    const plan = planTidy(files, { unchained: new Set([unchainedKey("b", "a")]), newItems: new Set(["d"]) });
    expect(plan.links.map((l) => `${l.previous.id}>${l.next.id}`)).toEqual(["d>e"]);
    expect(plan.skipped).toMatchObject({ unchained: 1, "new-item": 1 });
    // 끊은 쌍만 막는다: 끊은 판 b 의 뒤 판은 b 에 잇는다.
    const more = planTidy([...files, file("f", "결제 연동 설계", 2 * HOUR)], { unchained: new Set([unchainedKey("b", "a")]), newItems: new Set() });
    expect(more.links.map((l) => `${l.previous.id}>${l.next.id}`)).toContain("b>f");
  });

  test("정리 계획: 시각이 뒤바뀐 판 갈이를 거꾸로 이어 고리를 만들지 않는다(올린 순서 sort_order 를 먼저 보고, 뒤 판 사슬은 후보에서 뺀다)", () => {
    // B 가 replaces 로 A 를 대신했는데 시계가 뒤로 가 B 의 시각이 A 보다 앞선다.
    const a = file("a", "결제 연동 설계", HOUR, { replacedBy: "b", order: 1 });
    const b = file("b", "결제 연동 설계", 0, { replaces: "a", order: 2 });
    expect(planTidy([a, b]).links).toEqual([]);
    // 순서 정보가 없어도(시각만 보면 B 가 먼저) A 의 뒤 판 B 는 A 의 앞 판 후보가 아니다.
    expect(planTidy([{ ...a, order: undefined }, { ...b, order: undefined }]).links).toEqual([]);
  });
});

/** 0.2.7 의 읽기(판 열을 표에서 바로 읽음). 새 읽기와 결과가 글자까지 같은지 본다. */
function legacyListFiles(store: Store, projectId: string): unknown[] {
  return store.db.query(`SELECT id, kind, project_id, title, who, member_id, summary, body, path, attachments, created_at, sort_order, replaces, replaced_by
    FROM files WHERE project_id = ? ORDER BY sort_order DESC, rowid DESC`).all(projectId).map((r: any) => ({
    id: r.id, kind: r.kind ?? (r.body ? "document" : "file"), projectId: r.project_id, title: r.title, who: r.who, memberId: r.member_id, summary: r.summary, body: r.body, path: r.path,
    attachments: JSON.parse(r.attachments), createdAt: r.created_at, order: r.sort_order, ...(r.replaces ? { replaces: r.replaces } : {}), ...(r.replaced_by ? { replacedBy: r.replaced_by } : {}),
  }));
}

describe("판 연결 읽기(html 넘침 페이지를 지나가지 않는다)", () => {
  function fixture() {
    const home = testHome("w11-links-");
    const db = openDb(join(home, "iamceo.db"));
    const store = new Store(db, new Bus());
    cleanups.push(() => db.close());
    const project = store.createProject({ name: "읽기", cwd: home });
    const big = `<main>${"가".repeat(300_000)}</main>`;
    const v1 = store.createFile({ projectId: project.id, title: "화면 v1", kind: "artifact", html: big, memberId: null });
    const v2 = store.createFile({ projectId: project.id, title: "화면 v2", kind: "artifact", html: big, replaces: v1.id });
    const v3 = store.createFile({ projectId: project.id, title: "화면 v3", kind: "artifact", html: big, replaces: v2.id });
    const doc = store.createFile({ projectId: project.id, title: "안내", body: "# 안내" });
    return { home, db, store, project, ids: [v1.id, v2.id, v3.id, doc.id] };
  }

  test("목록·한 건·판 목록이 0.2.7 의 읽기와 글자까지 같다(색인이 있을 때와 없을 때 모두)", () => {
    const { store, db, project, ids } = fixture();
    expect(JSON.stringify(store.listFiles(project.id))).toBe(JSON.stringify(legacyListFiles(store, project.id)));
    for (const id of ids) expect(JSON.stringify(store.getFile(id))).toBe(JSON.stringify(legacyListFiles(store, project.id).find((f: any) => f.id === id)));
    const withIndex = { list: store.listFilesWithVersions(project.id), versions: store.listFileVersions(ids[0]!) };
    db.exec("DROP INDEX files_revisions");
    const noIndex = new Store(db, new Bus());
    expect(JSON.stringify(noIndex.listFiles(project.id))).toBe(JSON.stringify(legacyListFiles(store, project.id)));
    expect({ list: noIndex.listFilesWithVersions(project.id), versions: noIndex.listFileVersions(ids[0]!) }).toEqual(withIndex);
    expect(withIndex.list.find((f) => f.id === ids[2])).toMatchObject({ replaces: ids[1], versions: 3 });
  });

  test("판 연결은 덮는 색인만 읽는다(쿼리 계획: COVERING INDEX files_revisions)", () => {
    const { db, project, ids } = fixture();
    const plan = (sql: string, ...args: string[]) => (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((r) => r.detail).join(" / ");
    expect(plan("SELECT id, replaces, replaced_by FROM files INDEXED BY files_revisions WHERE project_id = ? AND (replaces IS NOT NULL OR replaced_by IS NOT NULL)", project.id)).toContain("COVERING INDEX files_revisions");
    expect(plan("SELECT replaces, replaced_by FROM files INDEXED BY files_revisions WHERE project_id = ? AND id = ?", project.id, ids[0]!)).toContain("COVERING INDEX files_revisions");
    expect(plan(`SELECT f.id FROM files f WHERE f.project_id = ? AND f.member_id = ? AND f.created_at >= ?
      AND NOT EXISTS (SELECT 1 FROM files r INDEXED BY files_revisions WHERE r.project_id = f.project_id AND r.id = f.id AND r.replaced_by IS NOT NULL)`, project.id, "m", "2026")).toContain("files_member_recent");
  });

  test("색인·기록 표는 판 번호 없이 IF NOT EXISTS 로 만든다(옛 서버도 같은 DB 를 연다). 표 files 의 열은 그대로다", () => {
    const { home, db } = fixture();
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(MIGRATIONS.length);
    expect(FILE_VERSION_SCHEMA.every((sql) => /^CREATE (?:INDEX|TABLE) IF NOT EXISTS /.test(sql))).toBe(true);
    expect(ensureFileVersionSchema(db)).toEqual([]);
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(files)").all().map((c) => c.name);
    expect(columns).toEqual(["id", "project_id", "title", "who", "member_id", "summary", "body", "path", "attachments", "created_at", "sort_order", "kind", "html", "replaces", "replaced_by"]);
    db.close();
    cleanups.pop();
    // 다시 열어도(이전 판이 만든 DB 를 새 판이 여는 것과 같은 길) 그대로다.
    const again = openDb(join(home, "iamceo.db"));
    cleanups.push(() => again.close());
    expect(again.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  test("색인을 만들지 못해도 DB 는 열리고 같은 결과를 낸다", () => {
    const { db } = fixture();
    db.exec("DROP INDEX files_revisions");
    db.exec("CREATE TABLE files_revisions (x)");
    const warn = console.warn; const lines: string[] = []; console.warn = (line: string) => { lines.push(line); };
    try { expect(ensureFileVersionSchema(db)).toEqual(["files_revisions"]); } finally { console.warn = warn; }
    expect(lines[0]).toContain("files_revisions");
  });
});

describe("file 도구: 자동 잇기·new_item·find·unchain", () => {
  test("replaces 를 빼고 같은 제목의 새 판을 올리면 서버가 잇고 답에 밝힌다. 화면 목록은 보통 판 갈이처럼 보인다. 열린 결재의 근거는 옮기지 않는다", async () => {
    const t = await setup();
    const v1 = await t.publish(t.worker, { title: "분기 실적 발표 v1", content: "# 1" });
    expect(v1.text).toBe(`자료를 올렸습니다 #${v1.id}. post 의 file_ids 에 ${v1.id} 를 넣으면 대화에 이어집니다`);
    const asked = await t.tool(t.worker, "ask", { title: "이 발표로 갈까요?", detail: "가짜 배경", file_id: v1.id });
    const decisionId = /#(d_[A-Za-z0-9]+)/.exec(asked.text)![1]!;
    const v2 = await t.publish(t.worker, { title: "분기 실적 발표 v2", content: "# 2" });
    expect(v2.text).toContain(`앞 판 #${v1.id} '분기 실적 발표 v1' 에 새 판으로 이었습니다(판 2)`);
    expect(v2.text).toContain(`unchain: "${v2.id}"`);
    const v3 = await t.publish(t.worker, { title: "분기 실적 발표 v3", content: "# 3" });
    expect(v3.text).toContain("(판 3)");
    const state = await (await t.get(`/api/projects/${t.project.id}/state`)).json() as { files: FileDoc[] };
    expect(state.files.map((f) => f.id)).toEqual([v3.id, v2.id, v1.id]);
    expect(state.files[0]).toMatchObject({ replaces: v2.id, versions: 3 });
    expect(state.files[2]).toMatchObject({ replacedBy: v2.id });
    expect(t.store.requireDecision(decisionId).fileId).toBe(v1.id);
    expect(t.store.db.query("SELECT source, basis FROM file_chain_journal WHERE file_id = ?").all(v2.id)).toEqual([{ source: "auto", basis: "marker+full" }]);
  });

  test("replaces 를 주면 예전처럼(열린 결재도 새 판으로). new_item 이면 잇지 않고, replaces 와 함께면 거절한다", async () => {
    const t = await setup();
    const v1 = await t.publish(t.worker, { title: "결제 연동 설계", content: "가짜" });
    const asked = await t.tool(t.worker, "ask", { title: "이 설계로 갈까요?", detail: "가짜 배경", file_id: v1.id });
    const decisionId = /#(d_[A-Za-z0-9]+)/.exec(asked.text)![1]!;
    const fresh = await t.publish(t.worker, { title: "결제 연동 설계", content: "다른 자료", new_item: true });
    expect(t.store.getFile(fresh.id)!.replaces).toBeUndefined();
    expect(t.store.getFile(v1.id)!.replacedBy).toBeUndefined();
    const explicit = await t.publish(t.worker, { title: "결제 연동 설계(고침)", content: "가짜", replaces: v1.id });
    expect(explicit.text).toBe(`자료를 올렸습니다 #${explicit.id} (옛 판 #${v1.id} 를 대신합니다). post 의 file_ids 에 ${explicit.id} 를 넣으면 대화에 이어집니다`);
    expect(t.store.requireDecision(decisionId).fileId).toBe(explicit.id);
    const both = await t.tool(t.worker, "file", { title: "가짜", content: "가짜", replaces: explicit.id, new_item: true });
    expect(both).toMatchObject({ isError: true, text: "replaces 와 new_item 은 함께 줄 수 없습니다" });
  });

  test("경계: 다른 팀장·다른 프로젝트의 같은 제목에는 잇지 않는다. 직원은 남의 판을 끊지 못하고 총괄은 끊는다. 닫힌 팀장의 자료는 직원도 replaces 로 잇는다", async () => {
    const t = await setup();
    const mine = await t.publish(t.worker, { title: "분기 실적 발표 v1", content: "가짜" });
    const theirs = await t.publish(t.other, { title: "분기 실적 발표 v2", content: "가짜" });
    expect(t.store.getFile(theirs.id)!.replaces).toBeUndefined();
    const elsewhere = t.store.createProject({ name: "다른", cwd: t.home });
    const outsider = t.store.createMember({ projectId: elsewhere.id, handle: "deck", name: "발표 자료", kind: "worker", backend: "core" });
    const far = await t.publish(outsider, { title: "분기 실적 발표 v2", content: "가짜" });
    expect(t.store.getFile(far.id)!.replaces).toBeUndefined();
    const v2 = await t.publish(t.worker, { title: "분기 실적 발표 v2", content: "가짜" });
    expect(t.store.getFile(v2.id)!.replaces).toBe(mine.id);
    expect(await t.tool(t.other, "file", { unchain: v2.id })).toMatchObject({ isError: true, text: "직원은 자기가 올린 자료의 판 잇기만 끊을 수 있습니다" });
    expect(await t.tool(outsider, "file", { unchain: v2.id })).toMatchObject({ isError: true });
    const byLead = await t.tool(t.lead, "file", { unchain: v2.id });
    expect(byLead.text).toBe(`자료 #${v2.id} 와 앞 판 #${mine.id} 의 잇기를 끊었습니다. 두 자료가 따로 대표 자료 목록에 보입니다`);
    expect(t.store.getFile(mine.id)!.replacedBy).toBeUndefined();
    expect(t.store.db.query("SELECT undone_at IS NOT NULL AS undone FROM file_chain_journal WHERE file_id = ?").get(v2.id)).toEqual({ undone: 1 });
    expect(await t.tool(t.lead, "file", { unchain: v2.id })).toMatchObject({ isError: true, text: `앞 판에 이어진 자료가 아닙니다: ${v2.id}` });
    // 남이 올린 자료는 여전히 403, 닫힌 팀장의 자료는 잇는다.
    expect((await t.tool(t.worker, "file", { title: "가짜", content: "가짜", replaces: theirs.id })).isError).toBe(true);
    const leaver = t.store.createMember({ projectId: t.project.id, handle: "gone", name: "떠난 일", kind: "worker", backend: "core" });
    const left = await t.publish(leaver, { title: "넘겨받을 문서", content: "가짜" });
    t.store.removeMember(leaver.id);
    const takeover = await t.publish(t.worker, { title: "넘겨받을 문서", content: "고침", replaces: left.id });
    expect(t.store.getFile(left.id)!.replacedBy).toBe(takeover.id);
    const ownerFile = t.store.createFile({ projectId: t.project.id, title: "대표가 올린 문서", body: "가짜" });
    expect(await t.tool(t.worker, "file", { title: "가짜", content: "가짜", replaces: ownerFile.id })).toMatchObject({ isError: true, text: "직원은 자기가 올린 자료만 새 판으로 바꿀 수 있습니다" });
  });

  test("같은 제목의 앞 판이 여럿이면 잇지 않고 후보를 알려 준다", async () => {
    const t = await setup();
    const a = await t.publish(t.worker, { title: "분기 실적 발표 (영업)", content: "가짜" });
    const b = await t.publish(t.worker, { title: "분기 실적 발표 (개발)", content: "가짜" });
    const n = await t.publish(t.worker, { title: "분기 실적 발표 v2 (요약)", content: "가짜" });
    expect(n.text).toContain("같은 제목의 앞 판이 여럿이라 잇지 않았습니다");
    expect(n.text).toContain(a.id);
    expect(n.text).toContain(b.id);
    expect(t.store.getFile(n.id)!.replaces).toBeUndefined();
  });

  test("find: 최신 판만, 제목 낱말이 모두 든 것, 새것부터. 내가 올린 것은 mine. 다른 인자와 함께 줄 수 없다", async () => {
    const t = await setup();
    const v1 = await t.publish(t.worker, { title: "분기 실적 발표 v1", content: "가짜" });
    const v2 = await t.publish(t.worker, { title: "분기 실적 발표 v2", content: "가짜" });
    const note = await t.publish(t.other, { title: "분기 회의 메모", content: "가짜" });
    const found = JSON.parse((await t.tool(t.worker, "file", { find: "분기 발표" })).text) as { files: { id: string; versions?: number; mine?: boolean }[] };
    expect(found.files).toEqual([expect.objectContaining({ id: v2.id, versions: 2, mine: true })]);
    const all = JSON.parse((await t.tool(t.other, "file", { find: "" })).text) as { files: { id: string; mine?: boolean }[] };
    expect(all.files.map((f) => f.id)).toEqual([note.id, v2.id]);
    expect(all.files[0]!.mine).toBe(true);
    expect(all.files.map((f) => f.id)).not.toContain(v1.id);
    const mixed = await t.tool(t.worker, "file", { find: "발표", title: "가짜" });
    expect(mixed.isError).toBe(true);
    expect(mixed.text).toContain("find 는 다른 인자(title)와 함께 줄 수 없습니다");
    expect((await t.tool(t.worker, "file", { content: "제목 없음" })).text).toContain("title");
  });
});

describe("file 도구: 원본과 html 미리보기를 한 자료로(original)", () => {
  test("html + original 은 아티팩트 한 줄이고 원본이 첫 첨부다(앱이 원본 칩으로 열고 받는다). .html path 와도 된다", async () => {
    const t = await setup();
    const deck = join(t.work, "발표.pptx");
    writeFileSync(deck, "PK가짜 슬라이드");
    const before = t.store.listFiles(t.project.id).length;
    const one = await t.publish(t.worker, { title: "분기 실적 발표 v1", html: "<h1>미리보기</h1>", original: deck });
    expect(t.store.listFiles(t.project.id)).toHaveLength(before + 1);
    const doc = t.store.getFile(one.id)!;
    expect(doc).toMatchObject({ kind: "artifact", path: deck });
    expect(doc.attachments.map((a) => a.name)).toEqual(["발표.pptx"]);
    expect(t.store.getFileHtml(one.id)).toBe("<h1>미리보기</h1>");
    const page = join(t.work, "발표.html");
    writeFileSync(page, "<h1>미리보기 2</h1>");
    const two = await t.publish(t.worker, { title: "분기 실적 발표 v2", path: page, original: deck });
    expect(t.store.getFile(two.id)).toMatchObject({ kind: "artifact", path: page, replaces: one.id });
    expect(t.store.getFile(two.id)!.attachments.map((a) => a.name)).toEqual(["발표.pptx"]);
  });

  test("original 은 html 미리보기와 함께만, html 이 아닌 파일만", async () => {
    const t = await setup();
    const deck = join(t.work, "발표.pptx");
    writeFileSync(deck, "PK가짜");
    expect(await t.tool(t.worker, "file", { title: "가짜", content: "가짜", original: deck })).toMatchObject({ isError: true, text: "original 은 html 미리보기(html 또는 .html path)와 함께 줍니다" });
    expect(await t.tool(t.worker, "file", { title: "가짜", path: deck, original: deck })).toMatchObject({ isError: true, text: "original 은 html 미리보기(html 또는 .html path)와 함께 줍니다" });
    const page = join(t.work, "다른.html");
    writeFileSync(page, "<p>가짜</p>");
    expect(await t.tool(t.worker, "file", { title: "가짜", html: "<p>가짜</p>", original: page })).toMatchObject({ isError: true, text: "original 에는 html 이 아닌 원본 파일(pptx·pdf 등)을 줍니다" });
    mkdirSync(join(t.work, "..", "밖"), { recursive: true });
    const outside = join(t.work, "..", "밖", "발표.pptx");
    writeFileSync(outside, "PK가짜");
    expect((await t.tool(t.worker, "file", { title: "가짜", html: "<p>가짜</p>", original: outside })).isError).toBe(true);
  });
});

describe("iamceo files tidy: 계획·적용·되돌리기", () => {
  function seed(t: Awaited<ReturnType<typeof setup>>) {
    const at = Date.now() - 3 * DAY;
    const make = (title: string, member: Member | null, offset: number, extra: { kind?: FileDoc["kind"] } = {}) => {
      const created = t.store.createFile({ projectId: t.project.id, title, body: "가짜", memberId: member?.id ?? null, who: member?.name ?? "", kind: extra.kind ?? "document" });
      backdate(t.store, created.id, new Date(at + offset));
      return created.id;
    };
    const ids = {
      a1: make("분기 실적 발표 v1", t.worker, 0), a2: make("분기 실적 발표 v2", t.worker, HOUR), a3: make("분기 실적 발표 v3", t.worker, 2 * HOUR),
      b1: make("운영 안내 초안", t.other, 0), b2: make("운영 안내 최종", t.other, HOUR),
      c1: make("편입기출 영어 1", t.worker, 0), c2: make("편입기출 영어 2", t.worker, HOUR),
      owner: make("대표 메모 v2", null, 0),
    };
    return ids;
  }

  test("계획은 바꾸지 않고 개수만(제목은 titles=1 일 때만). 적용은 한 거래, 열린 결재는 그대로, 되돌리기는 그대로인 잇기만 푼다", async () => {
    const t = await setup();
    const ids = seed(t);
    const decision = t.store.createDecision({ projectId: t.project.id, memberId: t.worker.id, who: t.worker.name, title: "가짜", detail: "가짜", fileId: ids.a1 });
    const plain = await (await t.get("/api/file-tidy")).json() as { planId: string; links: number; families: number; projects: { titles?: unknown; sizes: number[] }[]; batches: unknown[] };
    expect(plain).toMatchObject({ links: 3, families: 2, batches: [] });
    expect(plain.projects[0]!.sizes).toEqual([3, 2]);
    expect(JSON.stringify(plain)).not.toContain("분기");
    expect(plain.projects[0]!.titles).toBeUndefined();
    expect(t.store.getFile(ids.a1)!.replacedBy).toBeUndefined();
    const titled = await (await t.get("/api/file-tidy?titles=1")).json() as { projects: { titles: string[][] }[] };
    expect(titled.projects[0]!.titles).toContainEqual(["분기 실적 발표 v1", "분기 실적 발표 v2", "분기 실적 발표 v3"]);
    expect((await t.post("/api/file-tidy", { planId: "000000000000" })).status).toBe(409);
    const applied = await (await t.post("/api/file-tidy", { planId: plain.planId })).json() as { batchId: string; links: number; families: number };
    expect(applied).toMatchObject({ links: 3, families: 2 });
    expect(t.store.getFile(ids.a3)).toMatchObject({ replaces: ids.a2 });
    expect(t.store.getFile(ids.a1)).toMatchObject({ replacedBy: ids.a2 });
    expect(t.store.getFile(ids.b2)).toMatchObject({ replaces: ids.b1 });
    expect(t.store.getFile(ids.c2)!.replaces).toBeUndefined();
    expect(t.store.getFile(ids.owner)!.replaces).toBeUndefined();
    expect(t.store.requireDecision(decision.id).fileId).toBe(ids.a1);
    // 다시 계획하면 이을 것이 없다. 지난 적용이 보인다.
    const after = await (await t.get("/api/file-tidy")).json() as { links: number; batches: { batchId: string; links: number }[] };
    expect(after.links).toBe(0);
    expect(after.batches).toEqual([expect.objectContaining({ batchId: applied.batchId, links: 3, undone: 0 })]);
    // 그사이 팀장이 한 잇기를 끊었으면 그것은 건너뛴다.
    t.store.unchainFile(ids.b2);
    const undone = await (await t.post("/api/file-tidy/undo", { batchId: applied.batchId })).json();
    expect(undone).toEqual({ undone: 2, skipped: 0 });
    expect(t.store.getFile(ids.a3)!.replaces).toBeUndefined();
    expect(t.store.getFile(ids.a1)!.replacedBy).toBeUndefined();
    expect((await t.post("/api/file-tidy/undo", { batchId: "tb_none" })).status).toBe(404);
  });

  test("팀장이 끊은 잇기(서버가 이은 것·명시한 replaces 모두)와 new_item 으로 올린 자료는 기록에 남고, 정리가 다시 잇지 않는다", async () => {
    const t = await setup();
    const a = await t.publish(t.worker, { title: "결제 연동 설계 (서버)", content: "가짜" });
    const b = await t.publish(t.worker, { title: "결제 연동 설계 (서버)", content: "가짜" });
    expect(t.store.getFile(b.id)!.replaces).toBe(a.id);
    expect((await t.tool(t.worker, "file", { unchain: b.id })).isError ?? false).toBe(false);
    const c = await t.publish(t.worker, { title: "사업계획서 v1", content: "가짜" });
    const d = await t.publish(t.worker, { title: "사업계획서 v2", content: "가짜", new_item: true });
    const e = await t.publish(t.other, { title: "운영 안내 v1", content: "가짜" });
    const f = await t.publish(t.other, { title: "운영 안내 v2", content: "가짜", replaces: e.id });
    expect((await t.tool(t.lead, "file", { unchain: f.id })).isError ?? false).toBe(false);
    expect(t.store.db.query("SELECT source, file_id AS file, replaces, basis, undone_at IS NOT NULL AS undone FROM file_chain_journal ORDER BY seq").all()).toEqual([
      { source: "auto", file: b.id, replaces: a.id, basis: "same-title", undone: 1 },
      { source: "unchain", file: b.id, replaces: a.id, basis: "unchain", undone: 0 },
      { source: "new_item", file: d.id, replaces: "*", basis: "new_item", undone: 0 },
      { source: "unchain", file: f.id, replaces: e.id, basis: "unchain", undone: 0 },
    ]);
    const plan = t.store.planFileTidy();
    expect(plan.links).toEqual([]);
    expect(plan.skipped).toMatchObject({ unchained: 2, "new-item": 1 });
    const report = await (await t.get("/api/file-tidy")).json() as { links: number; skipped: Record<string, number>; batches: unknown[] };
    expect(report).toMatchObject({ links: 0, skipped: { unchained: 2, "new-item": 1 }, batches: [] });
    const { formatTidy } = await import("../bin/iamceo.ts");
    const text = formatTidy({ kind: "plan", report: report as never }, { kind: "plan", titles: false });
    expect(text).toMatch(/팀장이 끊은 잇기 2|link the staff removed 2/);
    expect(text).toMatch(/팀장이 새 자료라고 밝힘 1|staff marked it as a new file 1/);
    // 막는 것은 그 쌍·그 자료뿐이다: 같은 제목의 뒤 판은 그대로 잇는다.
    const g = await t.publish(t.worker, { title: "사업계획서 v3", content: "가짜" });
    expect(t.store.getFile(g.id)!.replaces).toBe(d.id);
    expect(t.store.getFile(c.id)!.replacedBy).toBeUndefined();
  });

  test("시각이 뒤바뀐 판 갈이를 거꾸로 이어 고리를 만들지 않는다. 계획이 고리를 내도 적용은 409 file_tidy_cycle 로 막고 바꾸지 않는다", async () => {
    const t = await setup();
    const a = t.store.createFile({ projectId: t.project.id, title: "결제 연동 설계", body: "가짜", memberId: t.worker.id, kind: "document" });
    const b = t.store.createFile({ projectId: t.project.id, title: "결제 연동 설계", body: "가짜", memberId: t.worker.id, kind: "document", replaces: a.id });
    backdate(t.store, b.id, new Date(Date.parse(a.createdAt) - 1000));
    expect(t.store.planFileTidy().links).toEqual([]);
    // 가드 시험: 계획이 B → A(A.replaces = B)를 내도 A 는 B 의 앞 판 사슬에 있어 고리가 된다.
    const files = t.store.fileChainFiles();
    const links = [{ projectId: t.project.id, previous: files.find((x) => x.id === b.id)!, next: files.find((x) => x.id === a.id)!, basis: "same-title" as const }];
    const forged = { planId: tidyPlanId(links), links, skipped: {} };
    t.store.planFileTidy = () => forged;
    let error: unknown;
    try { t.store.applyFileTidy(forged.planId); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ status: 409, code: "file_tidy_cycle" });
    expect(t.store.getFile(a.id)).toMatchObject({ replacedBy: b.id });
    expect(t.store.getFile(a.id)!.replaces).toBeUndefined();
    expect(t.store.getFile(b.id)).toMatchObject({ replaces: a.id });
    expect(t.store.getFile(b.id)!.replacedBy).toBeUndefined();
    expect(t.store.db.query("SELECT COUNT(*) AS n FROM file_chain_journal WHERE source = 'tidy'").get()).toEqual({ n: 0 });
  });

  test("이 Mac 밖에서 온 요청은 거절한다", async () => {
    const t = await setup();
    const response = await t.get("/api/file-tidy", { "X-Forwarded-For": "100.64.0.9" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "LOCAL_ONLY" });
  });

  test("계획 뒤 자료가 바뀌면 적용을 거절한다(대표가 본 계획만 적용)", async () => {
    const t = await setup();
    seed(t);
    const { planId } = t.store.planFileTidy();
    t.store.createFile({ projectId: t.project.id, title: "분기 실적 발표 v4", body: "가짜", memberId: t.worker.id, kind: "document" });
    expect(() => t.store.applyFileTidy(planId)).toThrow("확인한 뒤로 자료가 바뀌었습니다");
  });
});

describe("명령줄 iamceo files tidy", () => {
  const cli = (home: string, args: string[], port = "0") => Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "bin", "iamceo.ts"), "files", "tidy", ...args], {
    env: { ...process.env, IAMCEO_HOME: home, IAMCEO_PORT: port, IAMCEO_LANG: "ko" }, stdout: "pipe", stderr: "pipe",
  });

  function offlineHome() {
    const home = testHome("w11-cli-");
    updateConfigFile({ accessCode: "code", hosts: ["127.0.0.1"] }, { IAMCEO_HOME: home, IAMCEO_PORT: "0" });
    const config = loadConfig({ IAMCEO_HOME: home, IAMCEO_PORT: "0" });
    const db = openDb(config.dbPath);
    const store = new Store(db, new Bus());
    const project = store.createProject({ name: "명령줄", cwd: home });
    const member = store.createMember({ projectId: project.id, handle: "deck", name: "발표 자료", kind: "worker", backend: "core" });
    const a = store.createFile({ projectId: project.id, title: "분기 실적 발표 v1", body: "가짜", memberId: member.id, kind: "document" });
    const b = store.createFile({ projectId: project.id, title: "분기 실적 발표 v2", body: "가짜", memberId: member.id, kind: "document" });
    db.close();
    return { home, config, a: a.id, b: b.id };
  }

  test("서버가 꺼져 있으면 데이터 폴더를 쥐고 바로 연다: 계획(개수만) → --apply --plan → --undo", () => {
    const { home, config, a, b } = offlineHome();
    const dry = cli(home, []);
    expect(dry.exitCode).toBe(0);
    const out = dry.stdout.toString();
    expect(out).toContain("판 정리 계획(아직 바꾼 것 없음)");
    expect(out).toContain("명령줄: 판 묶음 1개 · 옛 판 1개");
    expect(out).not.toContain("분기 실적");
    const planId = /계획 번호 ([0-9a-f]{12})/.exec(out)![1]!;
    expect(cli(home, ["--show-titles"]).stdout.toString()).toContain("분기 실적 발표 v1  →  분기 실적 발표 v2");
    expect(cli(home, ["--apply"]).stderr.toString()).toContain("--apply 에는 확인한 계획 번호가 필요합니다");
    const applied = cli(home, ["--apply", "--plan", planId]);
    expect(applied.exitCode).toBe(0);
    const batch = /--undo (tb_[A-Za-z0-9]+)/.exec(applied.stdout.toString())![1]!;
    const check = () => { const db = openDb(config.dbPath); try { return new Store(db, new Bus()).getFile(b)?.replaces ?? null; } finally { db.close(); } };
    expect(check()).toBe(a);
    const undone = cli(home, ["--undo", batch]);
    expect(undone.stdout.toString()).toContain("잇기 1개를 풀었습니다");
    expect(check()).toBeNull();
    const json = JSON.parse(cli(home, ["--json"]).stdout.toString()) as { kind: string; report: { links: number; batches: unknown[] } };
    expect(json).toMatchObject({ kind: "plan", report: { links: 1 } });
    expect(json.report.batches).toHaveLength(1);
  });

  test("다른 작업(켜져 있는 서버)이 데이터 폴더를 쥐고 있으면 DB 를 직접 열지 않고 서버를 거친다(닿지 않으면 바꾸지 않고 멈춘다)", async () => {
    const { home, config, b } = offlineHome();
    const { acquireHomeOwner } = await import("../server/home-owner.ts");
    const owner = acquireHomeOwner(home);
    try {
      const planId = (() => { const db = openDb(config.dbPath); try { return new Store(db, new Bus()).planFileTidy().planId; } finally { db.close(); } })();
      const refused = cli(home, ["--apply", "--plan", planId], "1");
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr.toString()).toContain("결과를 확인하지 못했습니다");
    } finally { owner.release(); }
    const db = openDb(config.dbPath);
    try { expect(new Store(db, new Bus()).getFile(b)!.replaces).toBeUndefined(); } finally { db.close(); }
  });

  test("서버를 거치는 길: 같은 계획·적용 결과", async () => {
    const t = await setup();
    t.store.createFile({ projectId: t.project.id, title: "분기 실적 발표 v1", body: "가짜", memberId: t.worker.id, kind: "document" });
    t.store.createFile({ projectId: t.project.id, title: "분기 실적 발표 v2", body: "가짜", memberId: t.worker.id, kind: "document" });
    const { fileTidyViaServer, formatTidy } = await import("../bin/iamceo.ts");
    const config = { ...t.config, port: Number(new URL(t.url).port) };
    const plan = await fileTidyViaServer(config, { kind: "plan", titles: false });
    if (plan.kind !== "plan") throw new Error("plan");
    expect(plan.report).toMatchObject({ links: 1, families: 1 });
    expect(formatTidy(plan, { kind: "plan", titles: false })).toContain(`iamceo files tidy --apply --plan ${plan.report.planId}`);
    const applied = await fileTidyViaServer(config, { kind: "apply", planId: plan.report.planId });
    expect(applied).toMatchObject({ kind: "apply", links: 1, families: 1 });
  });
});

test("역할 규칙과 file 도구 설명이 같은 말을 한다: 고친 판은 replaces, 모르면 find, 빠뜨리면 서버가 잇고 unchain 으로 끊는다, 새 자료는 new_item, 제목에 '최신' 금지, 원본+미리보기는 original", async () => {
  const rule = readFileSync(join(import.meta.dir, "..", "server", "roles", "parts", "file-versions.md"), "utf8");
  const { listAgentTools } = await import("../server/agent-tools.ts");
  const description = listAgentTools({ kind: "worker", origin: "runner" } as Member).find((tool) => tool.name === "file")!.description;
  for (const word of ["`replaces`", "`find`", "`unchain`", "`new_item: true`", "'최신'·latest", "`original`"]) expect(rule).toContain(word);
  for (const word of ["replaces 에 앞 판 id", "find 로 찾는다", "unchain", "new_item: true", "'최신'·latest 를 붙이지 않는다", "original 로 원본을 붙인다"]) expect(description).toContain(word);
  expect(description).not.toContain("바뀌면 새 판을 올려 최신 id를 연결한다");
});
