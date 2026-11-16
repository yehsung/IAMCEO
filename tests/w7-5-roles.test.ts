// 0.2.7 묶음 5: 사용 기록 점검(11-16) D5-1·D5-5·D5-6·D5-8·D5-9·D3-3·D3-8 의 역할 지침과 대표 상시 규칙(`rule` 도구).
// - 지침: 새 규칙은 조각(server/roles/parts)으로만 들어가고, 정해진 절에 실린다. 묶음 1·4 가 만든 이름(urgent·replaces·todo_update)을 그대로 쓴다.
// - 상시 규칙: 대표 원문이 서버 대조로 맞을 때만 남고, 새로 여는 세션의 지침 끝에 실리며, 깨어 있는 세션에는 깨우지 않는 글로 알린다.
//   압축 뒤에도 다시 알린다. 견본 글은 모두 지어낸 것이다.
// 묶음 5 검토: 알림은 대기열에 미리 두지 않고 적어 두었다가, 그 팀장에게 봉투를 실제로 보낼 때 한 건으로 만들어 싣는다
//   (쉬는 팀장의 대기열 수가 1로 남아 앱 '대기열 1'·AI CLI 전환 막힘·잠재울 후보 빠짐이 생겼다).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONDUCTOR_TOOLS, ROOT_TOOLS, WORKER_TOOLS, type Backend, type Member, type MemberKind } from "../shared/types.ts";
import { handleAgentTool, listAgentTools } from "../server/agent-tools.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { MAX_PROJECT_RULES, pendingRuleNotices, projectRules, ruleNoticeText } from "../server/project-rules.ts";
import { textRef } from "../shared/server-text.ts";
import { builtInRole, ENGLISH_REPORT_RULE, OWNER_RULES_HEADING, ownerRulesSection, renderRole, ROLE_PARTS } from "../server/roles.ts";
import type { Runner, RunnerEvent, SendResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import { coreSetup } from "./fixtures/core-harness.ts";

const VARS = { PROJECT: "결제", NAME: "결제 연동", ROLE: "결제 연동", CONDUCTOR: "총괄" };
const KINDS: MemberKind[] = ["conductor", "worker", "root"];

/** 조각 글이 들어간 절 제목. 조각의 첫 줄이 있는 곳 바로 앞의 '## ' 제목. */
function sectionOf(text: string, part: string): string | null {
  const body = ROLE_PARTS[part]!.trim();
  const at = text.indexOf(body);
  if (at < 0) return null;
  const head = body.startsWith("## ") ? body.split("\n")[0]! : text.slice(0, at).split("\n").reverse().find(line => line.startsWith("## "))!;
  return head.slice(3);
}

describe("역할 지침: 새 규칙 조각이 정해진 절에 있다", () => {
  const where: Record<MemberKind, Record<string, string>> = {
    conductor: {
      urgent: "지시", "handoff-lead": "지시", "approval-wording": "보고 받기", "file-versions": "보고 받기", "todo-edit": "보고 받기",
      "ask-card": "질문·승인: 대신 답하지 않는다", "report-wording": "대표에게 말하기", "owner-away": "대표에게 말하기",
      "owner-rules": "상시 규칙 남기기", "model-choice": "세션 관리", "mac-shared": "세션 관리",
    },
    worker: {
      "approval-wording": "보고: `post`", "report-wording": "보고: `post`", handoff: "보고: `post`", "ask-card": "질문: `ask`", "todo-edit": "질문: `ask`",
      "mac-shared": "일하는 법", "owner-rules-worker": "일하는 법", "file-versions": "일하는 법", "urgent-worker": "입력 구분",
    },
    root: {
      "file-versions": "잡다한 일", "ask-card": "대표에게 말하기", "todo-edit": "대표에게 말하기", "report-wording": "대표에게 말하기",
      "approval-wording": "대표에게 말하기", "owner-away-hq": "대표에게 말하기", "owner-rules": "상시 규칙 남기기", "mac-shared": "승인과 일하는 법",
    },
  };
  for (const kind of KINDS) {
    test(`${kind}: 조각마다 정해진 절, 다른 역할의 조각은 없다`, () => {
      const text = builtInRole(kind);
      for (const [part, section] of Object.entries(where[kind])) expect({ kind, part, section: sectionOf(text, part) }).toEqual({ kind, part, section });
      const others = new Set(Object.values(where).flatMap(Object.keys));
      for (const part of others) if (!(part in where[kind])) expect({ kind, part, present: text.includes(ROLE_PARTS[part]!.trim()) }).toEqual({ kind, part, present: false });
      // 마지막 절은 그대로 도구 응답 유실이다(새 절은 그 앞에 든다).
      expect(text.trimEnd().split("\n## ").at(-1)!.startsWith("도구 응답 유실")).toBe(true);
    });
  }

  test("D5-1: 급한 지시는 묶음 1 의 동작(대표 원문·30분·안전할 때만 하던 턴을 멈추고 넣기)대로, 도구 결과대로만 대표에게 전한다", () => {
    const text = ROLE_PARTS.urgent!;
    expect(text).toContain("`team_assign`의 `urgent`");
    expect(text).toContain("대표 원문을 `user_quote`에 글자 그대로 싣는다");
    // 묶음 1 의 조건(URGENT_QUOTE_FRESH_MS 30분, 총괄·그 직원에게 쓴 글, 버튼 글·짧은 글 아님, 한 대표 글로 한 번)
    expect(text).toContain("대표가 30분 안에 너나 그 직원에게 쓴 글과 맞고(버튼 글·짧은 글·다른 직원에게 쓴 글은 근거가 못 된다)");
    expect(text).toContain("같은 대표 글로는 한 직원의 턴을 한 번만 멈추므로 보충 지시에는 `urgent`를 켜지 않는다.");
    expect(text).toContain("하던 턴을 멈추고 이 지시를 먼저 넣는다");
    expect(text).toContain("하던 턴이 끝난 뒤에 들어간다");
    expect(text).toContain("결과를 보기 전에 '급히 넣었다', '멈추고 바로 간다'고 말하지 않는다.");
    expect(text).toContain("빨리 해 달라는 재촉('최대한 빨리', 같은 일을 서두르라는 말)에는 `urgent`를 쓰지 않는다.");
    // 검토 뒤: '일 받기' 5번의 urgent 조건도 같은 기준(하던 일을 끊으라는 말, 재촉 아님)으로 고쳤다(w3-m-roles CHANGED). 첫 문장은 그대로.
    const lead = builtInRole("conductor");
    expect(lead).toContain("5. 일하는 중인 직원에게 끼어들지 않는다. `urgent`는 대표가 하던 일을 끊고 지금 바로 넣으라고 했을 때만 쓴다(빨리 해 달라는 재촉에는 쓰지 않는다).");
    expect(lead).not.toContain("`urgent`는 대표가 \"지금 바로\"라고 했을 때만.");
    // 팀장 쪽: 묶음 1 의 '하던 턴을 멈추게 했습니다' 시스템 글을 받으면 할 일.
    expect(builtInRole("worker")).toContain("`[시스템]`으로 대표의 급한 지시를 먼저 넣으려고 하던 턴을 멈추게 했다는 알림이 오면, 함께 온 그 지시부터 한다.");
  });

  test("D5-5: 화면·소리·브라우저·다운로드 폴더 규칙과 대안이 세 역할 모두에 있고, 서브에이전트에도 넣게 한다", () => {
    for (const kind of KINDS) {
      const text = builtInRole(kind);
      for (const rule of [
        "대표의 화면·소리·폴더를 가로채지 않는다.",
        "서브에이전트·워크플로에 일을 줄 때도 아래 규칙을 넣는다.",
        "창을 앞으로 가져오지 않는 방법(백그라운드 실행, 헤드리스 실행)을 먼저 쓰고",
        "브라우저 조작은 대표가 정한 것(지침 끝 대표 상시 규칙에 있으면 그것, 예: Aside)만 쓴다.",
        "소리를 내지 않는다.",
        "대표의 다운로드·데스크톱·문서 폴더에 파일을 만들지 않는다.",
      ]) expect({ kind, rule, has: text.includes(rule) }).toEqual({ kind, rule, has: true });
    }
  });

  test("D5-6: 제목은 대표가 읽을 완결 문장, 기술 인계는 대표 대화가 아니라 파일·지시로", () => {
    for (const kind of KINDS) expect(builtInRole(kind)).toContain("제목은 무엇이 어떻게 됐는지(또는 무엇을 하는 중인지) 드러나는 완결된 한 문장이다.");
    expect(builtInRole("worker")).toContain("다른 직원이 이어받을 기술 내용(코드·SQL·명령·파일 목록·검토 결과)은 대표 대화(`post`)에 그대로 쓰지 않는다.");
    expect(builtInRole("conductor")).toContain("직원에게 그런 인계 내용을 대표 대화용 `post`로 올리라고 시키지 않는다.");
    const post = listAgentTools({ kind: "worker", origin: "runner" } as Member).find(t => t.name === "post")!;
    expect(JSON.stringify(post.inputSchema)).toContain("대표가 읽을 결과 핵심 한 문장(무엇이 어떻게 됐는지). 시각·번호·이름만 이어 붙이지 않는다");
  });

  test("D5-8: team_add 의 model 은 대표가 그 직원에 대해 말했을 때만, role 에 모델을 적지 않는다", () => {
    expect(builtInRole("conductor")).toContain("`team_add`의 `model`은 대표가 바로 그 직원(그 일)에 대해 모델을 말했을 때만 넣는다.");
    expect(builtInRole("conductor")).toContain("`role`에는 모델 이름을 적지 않는다.");
    const add = listAgentTools({ kind: "conductor", origin: "runner" } as Member).find(t => t.name === "team_add")!;
    const props = (add.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    expect(props.model!.description).toContain("대표가 바로 이 직원(이 일)의 모델을 말했을 때만 넣는다");
    expect(props.model!.description).toContain("앞 일에 준 모델 지시나 다른 직원의 모델을 이어 쓰지 않는다");
    expect(props.role!.description).toContain("모델 이름은 적지 않는다");
    // 검토 뒤: '앞으로 전부'는 rule 이 아니라 앱 설정의 직급 기본 모델(두 번째 기본값 출처를 만들지 않는다).
    expect(builtInRole("conductor")).toContain("앞으로 띄울 직원 전부의 모델을 바꾸라는 말이면 `rule`로 남기지 않는다.");
    expect(builtInRole("conductor")).toContain("앱 설정의 'AI 모델'에서 팀장 기본 모델을 바꾸면 된다고 대표에게 알린다");
    expect(builtInRole("conductor")).not.toContain("앞으로 전부라고 하면 `rule`로 남긴다");
  });

  test("D5-9: 자리 비움 질문에는 일하는 직원의 다음 단계까지 보고, 본사 AI 는 모든 프로젝트를 본다", () => {
    const lead = builtInRole("conductor");
    expect(lead).toContain("열린 결재가 없어도 일하는 직원이 있으면 '정할 것 없음'으로 단정하지 않는다.");
    expect(lead).toContain("모르면 모른다고 적는다.");
    expect(lead).toContain("모든 프로젝트를 한 번에 보려면 본사 AI에게 물으면 된다고 한 줄 덧붙인다.");
    expect(builtInRole("root")).toContain("`project_list`로 모든 프로젝트의 열린 결재·할 일·일하는 팀장 수를 보고 프로젝트마다 한 줄로 답한다.");
  });

  test("D3-8: 결재 카드는 왜 지금인지, 선택지는 대표 말로. 묶음 4 짝(ask replaces·todo_update·file replaces·결재 답 첨부·두 벌 금지)", () => {
    for (const kind of KINDS) {
      const text = builtInRole(kind);
      expect(text).toContain("`detail` 첫머리에 왜 지금 정해야 하는지");
      expect(text).toContain("내부 번호·목록 번호(예: '2·5번 같이')·티켓 id나 개발 용어만으로 된 선택지는 쓰지 않는다.");
      expect(text).toContain("`ask`의 `replaces`에 앞 카드 id를 넣어 고친 카드를 올린다.");
      expect(text).toContain("`todo_update`로 고친다(대표에게 새 알림이 가지 않는다).");
      expect(text).toContain("`file`의 `replaces`에 앞 판의 id를 넣어 올린다.");
      expect(text).toContain("같은 내용을 `html`과 `content`(md) 두 벌로 올리지 않는다.");
      expect(text).toContain("대표의 결재 답에 첨부가 함께 오면 그 첨부도 답의 일부다.");
      // 검토 뒤: 묶음 4 의 실제 제약(자기가 올린 열린 카드만 대신, 답한 카드는 409·남의 카드는 403)과 needs_note.
      expect(text).toContain("`replaces`는 네가 올려 아직 열려 있는 카드에만 쓴다.");
      expect(text).toContain("대표가 이미 답한 카드(메모로 되물은 것 포함)는 그 답을 먼저 읽고, 다시 물을 것이면 `replaces` 없이 새 카드를 올리며 `detail`에 앞 카드 id와 대표가 되물은 것을 적는다.");
      expect(text).toContain("다른 직원의 카드는 대신하지 않는다.");
      expect(text).toContain("`needs_note: true`");
      expect(text).toContain("`needs_note: false`");
    }
    const ask = listAgentTools({ kind: "worker", origin: "runner" } as Member).find(t => t.name === "ask")!;
    expect(JSON.stringify(ask.inputSchema)).toContain("왜 지금 정해야 하는지(마크다운). 내부 번호·개발 용어는 풀어 쓴다");
  });

  test("D3-3 짝: 감지에 걸리던 지침 문장(따옴표로 든 예고 낱말, '승인이 불필요한 이유'로 정정)을 다듬고, 다른 직원 카드는 id 와 함께", () => {
    const worker = builtInRole("worker");
    expect(worker).not.toContain("\"승인 뒤\", \"다시 여쭙겠다\"");
    expect(worker).not.toContain("승인이 불필요한 이유로 보고를 정정한다");
    expect(worker).toContain("나중에 묻겠다는 예고(조건을 단 것 포함)만 남기지 않는다.");
    expect(worker).toContain("물을 것이 없으면 그 지시를 따라 보고를 바로잡는다.");
    for (const kind of KINDS) {
      const text = builtInRole(kind);
      expect(text).toContain("다른 직원이 올린 결재를 보고에서 말할 때는 그 카드 id를 함께 적는다.");
      expect(text).toContain("뺀 문장을 다시 인용하거나 왜 뺐는지 쓰지 않는다.");
    }
  });
});

describe("대표 상시 규칙 절(ownerRulesSection)", () => {
  const rules = [
    { id: "r_a", text: "브라우저 조작은 정해 둔 브라우저 도구로만 한다", quote: "브라우저는 \"그 도구\"로만 써" },
    { id: "r_b", text: "{{PROJECT}} 폴더 밖에 중간 파일을 두지 않는다", quote: "중간 파일은\n폴더 안에" },
  ];

  test("규칙이 없으면 지침은 글자 하나 바뀌지 않는다", () => {
    for (const kind of KINDS) {
      expect(renderRole(kind, { ...VARS, OWNER_RULES: [] })).toBe(renderRole(kind, VARS));
      expect(ownerRulesSection([])).toBe("");
    }
  });

  test("규칙은 지침 맨 끝 절로, 본문·원문을 한 줄로 펴고 원문의 따옴표를 닫지 못하며 자리표시를 다시 치환하지 않는다", () => {
    const text = renderRole("worker", { ...VARS, OWNER_RULES: rules });
    const tail = text.trimEnd().split("\n## ").at(-1)!;
    expect(`## ${tail}`).toBe(ownerRulesSection(rules));
    expect(tail.startsWith(OWNER_RULES_HEADING.slice(3))).toBe(true);
    expect(tail).toContain("위의 승인 규칙을 넓히지 않는다");
    expect(tail).toContain("- 브라우저 조작은 정해 둔 브라우저 도구로만 한다 (대표 원문 \"브라우저는 \\\"그 도구\\\"로만 써\" · #r_a)");
    expect(tail).toContain("- {{PROJECT}} 폴더 밖에 중간 파일을 두지 않는다 (대표 원문 \"중간 파일은 폴더 안에\" · #r_b)");
  });

  test("보고 언어 줄 뒤(그 줄이 덮지 않게), 이 Mac 의 덧붙임 앞(덧붙임이 마지막 말)", () => {
    const dir = mkdtempSync(join(tmpdir(), "iamceo-w75-rules-"));
    writeFileSync(join(dir, "conductor.extra.md"), "## 이 팀의 규칙\n- 커밋 메시지는 한국어로 쓴다.\n");
    const text = renderRole("conductor", { ...VARS, REPORT_LANGUAGE: "en", OWNER_RULES: rules }, dir);
    const english = text.indexOf(ENGLISH_REPORT_RULE), owner = text.indexOf(OWNER_RULES_HEADING), extra = text.indexOf("## 이 팀의 규칙");
    expect(english).toBeGreaterThan(0);
    expect(owner).toBeGreaterThan(english);
    expect(extra).toBeGreaterThan(owner);
    expect(text).toContain("They never widen the approval rules above");
  });
});

/** 세션을 띄우지 않고 받은 글만 적는 core 실행기(tools.test.ts 의 것과 같은 모양). */
class FakeRunner implements Runner {
  readonly kind: Backend = "core";
  readonly interjects = false;
  sent: { memberId: string; text: string }[] = [];
  busy = new Set<string>();
  private cb: (e: RunnerEvent) => void = () => {};
  private terminals = 0;
  constructor(private readonly store: Store) {}
  async available() { return { ok: true }; }
  async start() { return { sessionId: crypto.randomUUID(), paneId: `t${++this.terminals}` }; }
  async send(m: { id: string }, text: string): Promise<SendResult> { this.busy.add(m.id); this.sent.push({ memberId: m.id, text }); return { ok: true }; }
  isBusy(id: string) { return this.busy.has(id); }
  async compact(m: { id: string }): Promise<SendResult> {
    const state = this.store.ensureContextState(m.id);
    this.store.saveContextState({ ...state, measurement: null, compaction: { ...state.compaction!, phase: "running" } }, { contextPct: null });
    return { ok: true, started: false };
  }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop(m: { id: string }) { this.busy.delete(m.id); }
  async screen() { return ""; }
  on(cb: (e: RunnerEvent) => void) { this.cb = cb; }
  async shutdown() {}
  emit(e: RunnerEvent) { this.cb(e); }
  compacted(memberId: string) {
    const state = this.store.ensureContextState(memberId);
    this.store.saveContextState({ ...state, compaction: { ...state.compaction!, phase: "succeeded", finishedAt: new Date().toISOString() } });
    this.cb({ type: "compacted", memberId, runId: state.compaction!.id });
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => { await Promise.all(cleanups.map(c => c())); });

async function waitFor(cond: () => boolean, label: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`${label} 시간 초과`);
    await Bun.sleep(5);
  }
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "iamceo-w75-"));
  const home = join(root, "work"); mkdirSync(home);
  const env = { IAMCEO_HOME: join(root, "state"), IAMCEO_PORT: "0", CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex") };
  mkdirSync(env.CLAUDE_CONFIG_DIR); mkdirSync(env.CODEX_HOME);
  updateConfigFile({ accessCode: "code", hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const store = new Store(openDb(config.dbPath), new Bus());
  const runner = new FakeRunner(store);
  const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["core", runner]]) });
  cleanups.push(async () => { await orch.shutdown(); });
  const project = store.createProject({ name: "시험", cwd: home });
  const lead = await orch.ensureConductor(project.id);
  await orch.pump(lead.id);
  const add = async (name: string, handle: string) => {
    const { member } = await orch.addMember(project.id, { name, handle, role: "시험" });
    await orch.pump(member.id);
    return member;
  };
  const owner = (body: string) => store.createMessage({ projectId: project.id, kind: "나", who: "나", body, mine: true, delivery: "delivered" });
  const call = (member: Member, args: Record<string, unknown>) => handleAgentTool(orch, member, "rule", args);
  const rulesFile = (member: Member) => readFileSync(join(config.home, "run", `${member.id}.rules.md`), "utf8");
  const ruleQueued = (member: Member) => store.listPending(member.id).filter(d => d.text.includes("대표 상시 규칙"));
  const queued = (member: Member) => store.requireMember(member.id).queuedCount;
  /** 깨우는 지시 하나를 넣고 민다. 그 직원이 받은 봉투 글을 돌려준다. */
  const instruct = async (member: Member, text: string) => {
    const before = runner.sent.length;
    store.enqueue({ projectId: project.id, memberId: member.id, kind: "instruction", text });
    await orch.pump(member.id);
    await waitFor(() => runner.sent.slice(before).some(s => s.memberId === member.id), "봉투");
    return runner.sent.slice(before).find(s => s.memberId === member.id)!.text;
  };
  return { config, store, runner, orch, project, lead, add, owner, call, rulesFile, ruleQueued, queued, instruct };
}

describe("rule 도구", () => {
  test("총괄·본사 AI 만 쓴다(직원 목록에는 없다)", async () => {
    expect(CONDUCTOR_TOOLS).toContain("rule");
    expect(ROOT_TOOLS).toContain("rule");
    expect(WORKER_TOOLS as readonly string[]).not.toContain("rule");
    const f = await setup();
    const w = await f.add("화면 문구", "copy");
    expect(await handleAgentTool(f.orch, w, "rule", { action: "list" })).toEqual({ text: "쓸 수 없는 도구입니다: rule", isError: true });
    expect(await f.call(f.lead, { action: "list" })).toEqual({ text: "[]" });
  });

  test("대표 원문이 없거나, 대표 글에 없거나, 버튼 글·아주 짧은 글이면 남기지 않는다", async () => {
    const f = await setup();
    f.owner("네");
    expect(await f.call(f.lead, { action: "add", text: "늘 헤드리스 브라우저를 쓴다" })).toMatchObject({ isError: true, text: expect.stringContaining("user_quote 에 대표가 그렇게 정한 말") });
    expect(await f.call(f.lead, { action: "add", text: "늘 헤드리스 브라우저를 쓴다", user_quote: "총괄이 지어낸 말이다" })).toMatchObject({ isError: true, text: expect.stringContaining("인용을 대표 글에서 찾지 못해") });
    expect(await f.call(f.lead, { action: "add", text: "늘 헤드리스 브라우저를 쓴다", user_quote: "네" })).toMatchObject({ isError: true, text: expect.stringContaining("버튼 글이나 아주 짧은 글") });
    expect(await f.call(f.lead, { action: "add", user_quote: "네" })).toMatchObject({ isError: true, text: expect.stringContaining("add 에는 text") });
    expect(await f.call(f.lead, { action: "remove", user_quote: "네" })).toMatchObject({ isError: true, text: expect.stringContaining("remove 에는 id") });
    expect(projectRules(f.store).list(f.project.id)).toEqual([]);
  });

  test("남기면 새로 여는 세션의 지침 끝에 실리고, 깨어 있는 다른 세션에는 다음 봉투에 함께 실어 알린다. 잠든 세션과 남긴 총괄 자신은 빼고", async () => {
    const f = await setup();
    const awake = await f.add("화면 문구", "copy");
    const sleeper = await f.add("자료 정리", "docs");
    await f.orch.sleepMember(sleeper.id);
    expect(f.rulesFile(awake)).not.toContain(OWNER_RULES_HEADING);
    f.owner("아니 브라우저 창 띄우지 마. 앞으로 브라우저 일은 정해 둔 도구로만 해");
    const sentBefore = f.runner.sent.length;
    const added = await f.call(f.lead, { action: "add", text: "브라우저 조작은 정해 둔 도구로만 한다", user_quote: "앞으로 브라우저 일은 정해 둔 도구로만 해" });
    expect(added.isError).toBeUndefined();
    expect(added.text).toContain("깨어 있는 1명에게는 다음 입력과 함께 알리고, 잠든 1명은 다음에 열 때 지침에 들어 있습니다");
    const [rule] = projectRules(f.store).list(f.project.id);
    expect(rule).toMatchObject({ text: "브라우저 조작은 정해 둔 도구로만 한다", quote: "앞으로 브라우저 일은 정해 둔 도구로만 해", addedBy: f.lead.name });
    // 알릴 것은 깨어 있는 직원 하나에만 적힌다. 대기열에는 아무것도 없다(대기열 수 0, 깨우지 않음).
    expect(pendingRuleNotices(f.store, awake.id)).toEqual([{ kind: "add", ruleId: rule!.id }]);
    expect(pendingRuleNotices(f.store, sleeper.id)).toEqual([]);
    expect(pendingRuleNotices(f.store, f.lead.id)).toEqual([]);
    expect(f.ruleQueued(awake)).toEqual([]);
    expect(f.queued(awake)).toBe(0);
    await f.orch.pump(awake.id);
    expect(f.runner.sent.length).toBe(sentBefore);
    // 다음 지시의 봉투에 바뀐 것·지금 규칙 전체·승인 안전 줄이 지시보다 먼저 실린다(묶음 5 검토: 세션 중간 알림에도 안전 줄).
    const envelope = await f.instruct(awake, "안내 문구를 고쳐라");
    expect(envelope).toContain(`[시스템] 대표 상시 규칙이 바뀌었습니다:\n- 더함 #${rule!.id}: "브라우저 조작은 정해 둔 도구로만 한다" (대표 원문 "앞으로 브라우저 일은 정해 둔 도구로만 해", ${f.lead.name}`);
    expect(envelope).toContain("지침의 승인 규칙을 넓히지 않는다(승인이 필요한 일은 규칙이 있어도 그때마다 묻는다). 규칙과 대표 원문의 뜻이 다르면 원문을 따른다.");
    expect(envelope).toContain(`- 브라우저 조작은 정해 둔 도구로만 한다 (대표 원문 "앞으로 브라우저 일은 정해 둔 도구로만 해" · #${rule!.id})`);
    expect(envelope.indexOf("대표 상시 규칙이 바뀌었습니다")).toBeLessThan(envelope.indexOf("안내 문구를 고쳐라"));
    // 한 번 실으면 지운다(다음 봉투에 또 싣지 않는다).
    expect(pendingRuleNotices(f.store, awake.id)).toEqual([]);
    expect(f.ruleQueued(awake).filter(d => d.status === "queued" || d.status === "held")).toEqual([]);
    // 새로 여는 세션(새 직원·깨운 직원)의 지침 파일에 실린다.
    const fresh = await f.add("결제 연동", "pay");
    expect(f.rulesFile(fresh)).toContain(`${OWNER_RULES_HEADING}\n`);
    expect(f.rulesFile(fresh)).toContain(`- 브라우저 조작은 정해 둔 도구로만 한다 (대표 원문 "앞으로 브라우저 일은 정해 둔 도구로만 해" · #${rule!.id})`);
    expect(pendingRuleNotices(f.store, fresh.id)).toEqual([]);
    await f.orch.resumeMember(sleeper.id);
    await waitFor(() => f.store.requireMember(sleeper.id).status !== "asleep", "깨움");
    expect(f.rulesFile(sleeper)).toContain(`#${rule!.id})`);
    // 같은 규칙은 두 번 남지 않는다. 목록에 보인다.
    expect(await f.call(f.lead, { action: "add", text: " 브라우저 조작은  정해 둔 도구로만 한다", user_quote: "앞으로 브라우저 일은 정해 둔 도구로만 해" })).toMatchObject({ isError: true, text: expect.stringContaining(`같은 상시 규칙이 이미 있습니다 #${rule!.id}`) });
    expect(JSON.parse((await f.call(f.lead, { action: "list" })).text)).toEqual([{ id: rule!.id, text: rule!.text, quote: rule!.quote, addedBy: f.lead.name, createdAt: rule!.createdAt }]);
  });

  test("빼기도 대표 원문이 있어야 하고, 뺀 뒤 새 세션에는 실리지 않으며 깨어 있는 세션에는 다음 봉투에 '뺌'과 남은 규칙 없음을 싣는다", async () => {
    const f = await setup();
    const awake = await f.add("화면 문구", "copy");
    f.owner("소리 나는 건 앞으로 절대 틀지 마");
    await f.call(f.lead, { action: "add", text: "소리를 내지 않는다", user_quote: "소리 나는 건 앞으로 절대 틀지 마" });
    const [rule] = projectRules(f.store).list(f.project.id);
    expect(await f.call(f.lead, { action: "remove", id: rule!.id })).toMatchObject({ isError: true, text: expect.stringContaining("user_quote") });
    expect(await f.call(f.lead, { action: "remove", id: "r_none", user_quote: "소리 나는 건 앞으로 절대 틀지 마" })).toMatchObject({ isError: true, text: expect.stringContaining("상시 규칙을 찾을 수 없습니다") });
    f.owner("소리 규칙은 이제 빼도 돼");
    const removed = await f.call(f.lead, { action: "remove", id: rule!.id, user_quote: "소리 규칙은 이제 빼도 돼" });
    expect(removed.isError).toBeUndefined();
    expect(projectRules(f.store).list(f.project.id)).toEqual([]);
    expect(pendingRuleNotices(f.store, awake.id)).toEqual([{ kind: "add", ruleId: rule!.id }, { kind: "remove", ruleId: rule!.id }]);
    expect(f.queued(awake)).toBe(0);
    const envelope = await f.instruct(awake, "안내 문구를 고쳐라");
    expect(envelope).toContain(`- 더함 #${rule!.id}: "소리를 내지 않는다"`);
    expect(envelope).toContain(`- 뺌 #${rule!.id}: "소리를 내지 않는다" (대표 원문 "소리 규칙은 이제 빼도 돼", ${f.lead.name}`);
    expect(envelope).toContain("이제 남은 대표 상시 규칙은 없다. 지침 끝의 '대표 상시 규칙'은 더 따르지 않는다.");
    const fresh = await f.add("결제 연동", "pay");
    expect(f.rulesFile(fresh)).not.toContain(OWNER_RULES_HEADING);
    // 뺀 규칙의 행과 근거는 남는다.
    expect(f.store.db.query("SELECT removed_by, remove_quote FROM project_rules WHERE id = ?").get(rule!.id)).toEqual({ removed_by: f.lead.name, remove_quote: "소리 규칙은 이제 빼도 돼" });
  });

  test("묶음 5 검토: 쉬는 팀장의 대기열 수·명부·잠재울 후보가 규칙 알림으로 바뀌지 않는다", async () => {
    const f = await setup();
    f.store.patchSettings({ maxAwakeWorkers: 2 });
    const copy = await f.add("화면 문구", "copy");
    const docs = await f.add("자료 정리", "docs");
    f.owner("앞으로 중간 파일은 작업 폴더 안에만 둬");
    expect((await f.call(f.lead, { action: "add", text: "중간 파일은 작업 폴더 안에 둔다", user_quote: "앞으로 중간 파일은 작업 폴더 안에만 둬" })).isError).toBeUndefined();
    for (const m of [copy, docs]) {
      expect(f.queued(m)).toBe(0);
      expect(pendingRuleNotices(f.store, m.id)).toHaveLength(1);
    }
    const roster = JSON.parse((await handleAgentTool(f.orch, f.lead, "roster", {})).text) as { name: string; queued: number }[];
    expect(roster.filter(r => r.name === "화면 문구" || r.name === "자료 정리").map(r => r.queued)).toEqual([0, 0]);
    // 상한을 넘기면 총괄에게 가는 후보 안내에 쉬는 두 팀장이 그대로 있다(예전: '지금 잠재울 수 있는 직원이 없습니다').
    await f.add("결제 연동", "pay");
    const notice = f.store.listPending(f.lead.id).map(d => d.text).find(t => t.includes("상한 2명을 넘었습니다"));
    expect(notice).toContain("잠재울 후보(오래된 순): 화면 문구, 자료 정리");
    expect(notice).not.toContain("지금 잠재울 수 있는 직원이 없습니다");
  });

  test("직접 붙인 세션(iamceo join)은 서버가 봉투를 보내지 않으니 wait 로 받게 대기열에 바로 넣는다(안전 줄 포함)", async () => {
    const f = await setup();
    const manual = f.store.createMember({ projectId: f.project.id, handle: "hand", name: "직접 세션", kind: "worker", origin: "manual", status: "idle" });
    f.owner("앞으로 결과 자료는 하나로만 올려");
    await f.call(f.lead, { action: "add", text: "결과 자료는 하나로만 올린다", user_quote: "앞으로 결과 자료는 하나로만 올려" });
    const [rule] = projectRules(f.store).list(f.project.id);
    expect(pendingRuleNotices(f.store, manual.id)).toEqual([]);
    const [notice] = f.ruleQueued(manual);
    expect(notice).toMatchObject({ kind: "system", wake: false });
    expect(notice!.text).toContain(`대표 상시 규칙이 하나 늘었습니다 #${rule!.id}: "결과 자료는 하나로만 올린다"`);
    expect(notice!.text).toContain("지침의 승인 규칙을 넓히지 않는다");
  });

  test(`프로젝트마다 ${MAX_PROJECT_RULES}개까지, 다른 프로젝트의 규칙은 보이지도 빠지지도 않는다`, async () => {
    const f = await setup();
    f.owner("앞으로 이 목록 규칙들을 다 지켜");
    for (let i = 0; i < MAX_PROJECT_RULES; i++) expect((await f.call(f.lead, { action: "add", text: `규칙 ${i}`, user_quote: "앞으로 이 목록 규칙들을 다 지켜" })).isError).toBeUndefined();
    expect(await f.call(f.lead, { action: "add", text: "하나 더", user_quote: "앞으로 이 목록 규칙들을 다 지켜" })).toMatchObject({ isError: true, text: expect.stringContaining(`${MAX_PROJECT_RULES}개까지`) });
    const other = f.store.createProject({ name: "다른 일", cwd: join(f.config.home, "..") });
    const otherLead = await f.orch.ensureConductor(other.id);
    expect(await handleAgentTool(f.orch, otherLead, "rule", { action: "list" })).toEqual({ text: "[]" });
    const id = projectRules(f.store).list(f.project.id)[0]!.id;
    f.store.createMessage({ projectId: other.id, kind: "나", who: "나", body: "그 규칙은 이제 빼", mine: true, delivery: "delivered" });
    expect(await handleAgentTool(f.orch, otherLead, "rule", { action: "remove", id, user_quote: "그 규칙은 이제 빼" })).toMatchObject({ isError: true, text: expect.stringContaining("상시 규칙을 찾을 수 없습니다") });
    expect(projectRules(f.store).list(f.project.id)).toHaveLength(MAX_PROJECT_RULES);
  });

  test("본사 AI 도 본사 프로젝트의 규칙을 남긴다", async () => {
    const f = await setup();
    const root = await f.orch.ensureConductor("hq");
    expect(root.kind).toBe("root");
    f.store.createMessage({ projectId: "hq", kind: "나", who: "나", body: "앞으로 정리 자료는 표 하나로만 만들어", mine: true, delivery: "delivered" });
    expect((await handleAgentTool(f.orch, root, "rule", { action: "add", text: "정리 자료는 표 하나로 만든다", user_quote: "앞으로 정리 자료는 표 하나로만 만들어" })).isError).toBeUndefined();
    expect(projectRules(f.store).list("hq")).toHaveLength(1);
    expect(projectRules(f.store).list(f.project.id)).toHaveLength(0);
  });
});

describe("압축 뒤 대표 상시 규칙 다시 알리기", () => {
  const compactOnce = async (f: Awaited<ReturnType<typeof setup>>, w: Member) => {
    const done = f.store.listActivity(w.id).filter(a => a.text === "압축 완료").length;
    await f.orch.compactMember(w.id);
    await waitFor(() => f.store.getContextState(w.id)?.compaction?.phase === "running", "압축 시작");
    f.runner.compacted(w.id);
    await waitFor(() => f.store.listActivity(w.id).filter(a => a.text === "압축 완료").length >= done + 1, "압축 끝");
  };

  test("규칙이 없으면 적지 않는다", async () => {
    const f = await setup();
    const w = await f.add("화면 문구", "copy");
    await compactOnce(f, w);
    expect(pendingRuleNotices(f.store, w.id)).toEqual([]);
    expect(ruleNoticeText(f.store, f.project.id, [{ kind: "compacted", ruleId: null }])).toBeNull();
  });

  test("규칙이 있으면 압축이 끝난 세션의 다음 봉투에 지금 목록을 한 번 싣는다(다시 압축해도 한 번, 대기열 수는 그대로)", async () => {
    const f = await setup();
    f.owner("다운로드 폴더에 파일 두지 마. 앞으로 작업 폴더 안에서만 해");
    await f.call(f.lead, { action: "add", text: "내려받은 파일은 작업 폴더 안에 둔다", user_quote: "앞으로 작업 폴더 안에서만 해" });
    // 규칙 뒤에 띄운 직원: 지침 끝에 이미 있어 바뀐 것 알림은 없다.
    const w = await f.add("화면 문구", "copy");
    expect(pendingRuleNotices(f.store, w.id)).toEqual([]);
    await compactOnce(f, w);
    await compactOnce(f, w);
    expect(pendingRuleNotices(f.store, w.id)).toEqual([{ kind: "compacted", ruleId: null }]);
    expect(f.queued(w)).toBe(0);
    const envelope = await f.instruct(w, "안내 문구를 고쳐라");
    expect(envelope.split("압축 뒤 이 프로젝트의 대표 상시 규칙을 다시 보냅니다.")).toHaveLength(2);
    expect(envelope).toContain("- 내려받은 파일은 작업 폴더 안에 둔다 (대표 원문 \"앞으로 작업 폴더 안에서만 해\"");
    expect(envelope).toContain("지침의 승인 규칙을 넓히지 않는다");
    expect(envelope).not.toContain("대표 상시 규칙이 바뀌었습니다");
    expect(pendingRuleNotices(f.store, w.id)).toEqual([]);
  });

  test("묶음 5 검토: Claude 가 쉬는 동안 스스로 압축했다는 사건(activity.claude_idle_compacted)에도 다시 알리게 적는다", async () => {
    const f = await setup();
    f.owner("앞으로 화면 녹화는 하지 마");
    await f.call(f.lead, { action: "add", text: "화면 녹화를 하지 않는다", user_quote: "앞으로 화면 녹화는 하지 마" });
    const w = await f.add("화면 문구", "copy");
    f.runner.emit({ type: "activity", memberId: w.id, kind: "system", notice: true, text: textRef("activity.compact_done") });
    await waitFor(() => f.store.listActivity(w.id).some(a => a.text === "압축 완료"), "다른 활동");
    expect(pendingRuleNotices(f.store, w.id)).toEqual([]);
    f.runner.emit({ type: "activity", memberId: w.id, kind: "system", notice: true, text: textRef("activity.claude_idle_compacted") });
    await waitFor(() => pendingRuleNotices(f.store, w.id).length > 0, "알릴 것");
    expect(pendingRuleNotices(f.store, w.id)).toEqual([{ kind: "compacted", ruleId: null }]);
  });
});

describe("묶음 5 검토: 실제 core 경로(가짜 core)", () => {
  test("규칙 알림은 다음 지시와 같은 봉투로 팀장 CLI 에 들어가고, 직접 붙이는 세션은 join 응답으로 규칙을 받는다", async () => {
    const t = await coreSetup({ timings: { tickMs: 15, retryMs: 5, inputBusyRetryMs: 5 } });
    cleanups.push(() => t.close());
    const lead = t.store.createMember({ projectId: t.project.id, handle: "lead", name: "총괄", kind: "conductor", origin: "runner", status: "asleep" });
    const before = await (await t.api("POST", "/agent/join", { project: t.project.id, name: "직접 세션" })).json() as { member: Member; ownerRules?: unknown };
    expect(before.ownerRules).toBeUndefined();
    const { member: w } = await t.orch.addMember(t.project.id, { name: "화면 문구", handle: "copy", role: "시험" });
    await t.idle(w.id);
    t.store.createMessage({ projectId: t.project.id, kind: "나", who: "나", body: "앞으로 브라우저는 헤드리스로만 써", mine: true, delivery: "delivered" });
    expect((await handleAgentTool(t.orch, lead, "rule", { action: "add", text: "브라우저는 헤드리스로만 쓴다", user_quote: "앞으로 브라우저는 헤드리스로만 써" })).isError).toBeUndefined();
    const [rule] = projectRules(t.store).list(t.project.id);
    expect(t.member(w.id).queuedCount).toBe(0);
    await t.orch.assign(t.project.id, "copy", { text: "안내 문구를 고쳐라 @fake:post=고쳤음" });
    const turn = await t.waitFor("지시 턴", () => t.turns(w.id).find(c => c.prompt.includes("안내 문구를 고쳐라")));
    expect(turn.prompt).toContain(`대표 상시 규칙이 바뀌었습니다:\n- 더함 #${rule!.id}`);
    expect(turn.prompt.indexOf("대표 상시 규칙이 바뀌었습니다")).toBeLessThan(turn.prompt.indexOf("안내 문구를 고쳐라"));
    expect(pendingRuleNotices(t.store, w.id)).toEqual([]);
    // 직접 붙인 세션: 남길 때 대기열로 받고(wait), 다시 붙으면 join 응답에 지금 규칙이 실린다(bin/iamceo.ts 가 지침 끝에 싣는다).
    expect(t.store.listPending(before.member.id).some(d => d.text.includes(`대표 상시 규칙이 하나 늘었습니다 #${rule!.id}`))).toBe(true);
    const again = await (await t.api("POST", "/agent/join", { project: t.project.id, name: "직접 세션" })).json() as { ownerRules?: unknown };
    expect(again.ownerRules).toEqual([{ id: rule!.id, text: "브라우저는 헤드리스로만 쓴다", quote: "앞으로 브라우저는 헤드리스로만 써" }]);
   }, 30_000);
});

describe("묶음 5 검토(D3-3 짝): 지침이 가르치는 결재 문장은 결재 누락 감지에 걸리지 않는다", () => {
  test("approval-wording 조각과 worker.md 의 고친 두 문장, 대표 원문을 `> ` 인용 줄로 옮긴 보고", async () => {
    const f = await setup();
    const w = await f.add("화면 문구", "copy");
    const instruction = "열린 결재 카드가 없다";
    const post = async (body: string) => (await handleAgentTool(f.orch, w, "post", { kind: "완료", title: "안내 문구를 고쳤습니다", body })).text;
    // 감지는 살아 있다(대조군).
    expect(await post("남은 것: 대표 승인 뒤 배포")).toContain(instruction);
    for (const body of [
      ROLE_PARTS["approval-wording"]!,
      "나중에 묻겠다는 예고(조건을 단 것 포함)만 남기지 않는다.",
      "`post` 응답에 결재 누락 시스템 지시가 오면 지금 물을 것은 카드로 올리고, 물을 것이 없으면 그 지시를 따라 보고를 바로잡는다.",
      // owner-rules-worker: 다른 직원도 지킬 대표 원문은 `> ` 인용 줄로 옮긴다(인용 줄은 감지에서 뺀다).
      "다른 직원도 지켜야 할 대표의 말입니다.\n> 앞으로 배포는 대표 승인 뒤에 해",
    ]) expect({ body, flagged: (await post(body)).includes(instruction) }).toEqual({ body, flagged: false });
  });
});

test("표가 없는 DB(이주 도중 넘겨받은 것)도 처음 쓸 때 만든다", () => {
  const dir = mkdtempSync(join(tmpdir(), "iamceo-w75-db-"));
  const path = join(dir, "x.db");
  const db = openDb(path);
  db.exec("DROP TABLE project_rule_notices");
  db.exec("DROP TABLE project_rules");
  const store = new Store(db, new Bus());
  expect(existsSync(path)).toBe(true);
  expect(projectRules(store).list("hq")).toEqual([]);
  expect(db.query("SELECT name FROM sqlite_schema WHERE name IN ('project_rules', 'project_rule_notices') ORDER BY name").all()).toEqual([{ name: "project_rule_notices" }, { name: "project_rules" }]);
});
