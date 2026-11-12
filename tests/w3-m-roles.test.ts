// 3차 M(E10) 팀장 지침 정리: 세 역할 지침을 공통 조각으로 나눠 조립해도 규칙의 뜻이 하나도 빠지거나 바뀌지 않았는지,
// 사용자 덧붙임(<kind>.extra.md)과 통째 교체 파일의 기준판 표지가 도는지, 대표가 최근에 넣은 규칙이 남는지 본다.
//
// 기준본: tests/fixtures/roles-baseline/*.md 는 정리 직전(7f30d95)의 server/roles/*.md 그대로다. 손대지 않는다.
// 규칙 하나 = 기준본의 문장 하나다(줄을 나누고, 목록 표시를 떼고, 마침표 뒤에서 자른다). 제목 줄은 구조라 뺀다.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCTOR_CHECK_IDS, DOCTOR_ROLES_CHECK_ID, type Member, type MemberKind } from "../shared/types.ts";
import { listAgentTools } from "../server/agent-tools.ts";
import { doctorChecks, type DoctorFacts } from "../server/doctor.ts";
import {
  assembleRole, builtInRole, ENGLISH_REPORT_RULE, EXTRA_RULES_HEADING, exportRoles, hasApprovalRule, readRoleBase, renderRole, ROLE_PARTS, roleBaseHash, roleBaseMarker, roleCustomizations,
} from "../server/roles.ts";

const KINDS: MemberKind[] = ["conductor", "worker", "root"];
const baseline = (kind: MemberKind) => readFileSync(join(import.meta.dir, "fixtures", "roles-baseline", `${kind}.md`), "utf8");

/** 자리표시를 그대로 두고 조립한 결과. 직접 붙인 세션(MANUAL)이면 들어가는 wait 안내까지 펼친다. */
const AS_TEMPLATE = { PROJECT: "{{PROJECT}}", NAME: "{{NAME}}", ROLE: "{{ROLE}}", CONDUCTOR: "{{CONDUCTOR}}", SUBAGENT_EFFORT: "{{SUBAGENT_EFFORT}}" };
const assembled = (kind: MemberKind, manual = true) => renderRole(kind, { ...AS_TEMPLATE, MANUAL: manual });
const VARS = { PROJECT: "결제", NAME: "결제 연동", ROLE: "결제 연동", CONDUCTOR: "총괄" };

function ruleLines(text: string): string[] {
  return text.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#")).map(line => line.replace(/^(?:[-*]|\d+\.)\s+/, ""));
}

function sentences(text: string): string[] {
  return ruleLines(text).flatMap(line => line.split(/(?<=\.)\s+(?=\S)/)).map(s => s.trim()).filter(Boolean);
}

/**
 * 문장을 고친 곳. 세 파일에 따로 있던 같은 규칙을 조각 하나로 합치면서, 문장마다 가장 자세한 판(팀장 판)의 표현으로 맞췄다.
 * 각 줄은 '뜻이 같다'는 주장이다. 사람이 읽고 검토할 수 있게 이유를 붙인다. 여기 없는 문장은 글자 하나 바뀌면 안 된다.
 */
const REWORDED: { kinds: MemberKind[]; from: string; to: string; why: string }[] = [
  { kinds: ["conductor", "root"], from: "짧은 보고는 `post`, 긴 글은 `content`(md).", to: "짧은 보고는 `post`, 긴 글은 `file`의 `content`(md).",
    why: "content 는 file 도구의 인자다. 팀장 판의 표현" },
  { kinds: ["conductor", "root"],
    from: "글로 설명이 길어지거나 비교·흐름·구조·수치·시안처럼 글만으로 보기 힘든 내용은 `html`로 한 페이지를 만들어 올린다.",
    to: "글로 설명이 길어지거나 비교·흐름·구조·수치·시안처럼 글만으로 보기 힘든 내용은 `file`의 `html`로 한 페이지를 만들어 올리고 그 id를 `post`의 `file_ids`에 잇는다.",
    why: "id 를 post 의 file_ids 에 잇는 것은 같은 묶음 첫 문장(결과물은 file 로 올리고 file_ids 에 연결)과 같은 규칙" },
  { kinds: ["conductor", "root"],
    from: "(자체 완결, CDN·일반 외부 요청은 막히고 중첩 iframe 은 지워진다, 스크립트는 인라인만, 격리가 완전하지 않으니 비밀번호·개인정보 같은 민감한 데이터는 싣지 않는다.",
    to: "html 은 자체 완결이어야 한다(CDN·일반 외부 요청은 막히고 중첩 iframe 은 지워진다, 스크립트는 인라인만, 이미지는 data:, 격리가 완전하지 않으니 비밀번호·개인정보 같은 민감한 데이터는 싣지 않는다).",
    why: "'이미지는 data:' 는 외부 요청이 막힌다는 같은 문장의 결과다(file 도구의 html 인자 설명에도 있다)" },
  { kinds: ["conductor", "root"],
    from: "기본 스타일 키트가 깔려 semantic HTML 과 키트 클래스 card, grid, callout, kpi, steps, flow, tabs, tag, compare 만 써도 깔끔하다).",
    to: "기본 스타일 키트가 자동으로 깔리므로 semantic HTML 과 키트 클래스(card, grid, callout, kpi, steps, flow, tabs, tag, compare)만 써도 깔끔하다.",
    why: "같은 뜻. 괄호 자리만 다르다" },
  { kinds: ["root"],
    from: "대표가 읽거나 복사하거나 확인해야 하는 결과물(문서·대본·표·이미지·영상)은 반드시 `file`로 자료에 올리고 반환된 id를 `post`의 `file_ids`에 연결한다.",
    to: "대표가 읽거나 복사하거나 확인해야 하는 결과물(문서·대본·표·이미지·영상)은 반드시 `file` 도구로 자료에 올리고, 반환된 id를 `post`의 `file_ids`에 연결한다.",
    why: "같은 뜻(총괄·팀장 판의 표현)" },
  { kinds: ["root"], from: "로컬 경로만 말하고 끝내지 않는다.", to: "로컬 파일 경로만 말하고 끝내지 않는다.", why: "같은 뜻" },
  { kinds: ["root"], from: "경로는 덧붙일 수 있다.", to: "경로는 자료 연결에 덧붙일 수 있다.", why: "같은 뜻(앞 문장의 자료 연결에 덧붙인다)" },
  { kinds: ["root"],
    from: "바뀐 자료는 도구가 허용하는 방식으로 갱신하거나 새 판을 올려 최신 id를 보고에 연결한다.",
    to: "이미 올린 자료가 바뀌면 도구가 허용하는 방식으로 같은 자료를 갱신하거나 새 판을 `file`로 올려 최신 id를 보고에 연결한다.",
    why: "같은 뜻(총괄·팀장 판의 표현)" },
];

/**
 * 문장은 그대로인데 줄이 나뉘거나 다른 줄과 합쳐진 곳. 여기 없는 기준본의 줄은 새 지침에 한 줄 그대로 있어야 한다.
 * 나눈 줄의 문장은 같은 절 안에서 같은 순서로 이어져야 한다. reordered 는 공통 조각으로 합치며 같은 절 안에서 자리만 옮긴 문장이다
 * (서로 독립한 규칙이라 순서가 뜻을 바꾸지 않는다). 그 문장도 같은 절 안에는 있어야 한다.
 */
const RESTRUCTURED: { kind: MemberKind; startsWith: string; why: string; reordered?: string[] }[] = [
  { kind: "conductor", startsWith: "판 맞추기:", why: "962자 한 항목을 하위 항목 여섯으로 나눴다(문장·순서 그대로)" },
  { kind: "conductor", startsWith: "대표가 읽거나 복사하거나", why: "자료 규칙을 공통 조각(deliverables)과 총괄 몫 한 줄로 나눴다",
    reordered: ["보고서 전문은 직원이 올리고, 네가 만든 산출물도 같은 기준을 따른다.", "외부 사이트에 따로 게시하지 않는다."] },
  { kind: "worker", startsWith: "대표가 읽거나 복사하거나", why: "자료 규칙을 공통 조각(deliverables)과 팀장 몫 한 줄로 나눴다",
    reordered: ["외부 사이트에 따로 게시하지 않는다."] },
  { kind: "root", startsWith: "한 번에 끝나는 조사", why: "자료 규칙을 공통 조각(deliverables)으로 옮겼다",
    reordered: ["외부 사이트에 따로 게시하지 않는다."] },
  { kind: "root", startsWith: "대표가 읽거나 복사하거나", why: "자료 규칙을 공통 조각(deliverables)으로 합쳤다" },
];

/**
 * 직접 붙인 세션(MANUAL)에만 들어가는 문장(parts/manual-session.md). 기준본 worker.md 의 wait 단락 다섯 문장을 글자 그대로 적는다.
 * 서버가 띄우는 세션(MANUAL=false)에서 빠져도 되는 문장은 이것뿐이다. 다른 규칙을 이 조각으로 옮기면 아래 대조가 잡는다(리뷰 roles-1).
 */
const MANUAL_ONLY = [
  "`wait` 도구가 있으면 네가 직접 띄워진 세션이다.",
  "`ask`는 답이 올 때까지 결과로 돌아오고, 일이 끝나면 `wait`로 다음 지시 batch를 받는다.",
  "batch의 내용을 읽고 `wait({ack_batch_id: \"받은 batch id\"})`로 ACK한 뒤 처리한다.",
  "ACK 전 재조회는 같은 batch이며 같은 deliveryId를 중복 실행하지 않는다.",
  "ACK는 수신 확인이며 업무 완료가 아니다.",
];

/**
 * 기준본에서 절 밖으로 붙어 있던 줄(파일 끝 '## 도구 응답 유실' 뒤)을 제 절로 옮긴 곳. 여기 없는 기준본 줄은 같은 절·같은 들여쓰기·같은
 * 목록 표시(번호 포함)로, 같은 절 안의 순서 그대로 있어야 한다(리뷰 roles-2). 옮긴 줄은 문단에서 목록 항목이 되기도 했다.
 */
const MOVED: { kind: MemberKind; startsWith: string; from: string; to: string; why: string }[] = [
  { kind: "conductor", startsWith: "아티팩트 공통 계약", from: "## 도구 응답 유실", to: "## 보고 받기", why: "결과물 규칙(deliverables) 바로 뒤로" },
  { kind: "conductor", startsWith: "판 정리 때 3일 넘은", from: "## 도구 응답 유실", to: "## 보고 받기", why: "할 일 정리는 보고 받기의 판 정리 규칙과 함께" },
  { kind: "conductor", startsWith: "지시를 다시 보낼 때", from: "## 도구 응답 유실", to: "## 지시", why: "지시 거두기는 지시 절의 일" },
  { kind: "worker", startsWith: "아티팩트 공통 계약", from: "## 도구 응답 유실", to: "## 일하는 법", why: "결과물 규칙(deliverables) 바로 뒤로" },
  { kind: "worker", startsWith: "네가 `todo`로 부탁한 일이 다시 필요해지면", from: "## 도구 응답 유실", to: "## 질문: `ask`", why: "todo 부탁은 질문 절의 일" },
  { kind: "root", startsWith: "직원 보고로만 깨어난 확인 턴은", from: "## 도구 응답 유실", to: "## 대표에게 말하기", why: "확인 턴의 보고 규칙" },
  { kind: "root", startsWith: "아티팩트 공통 계약", from: "## 도구 응답 유실", to: "## 잡다한 일", why: "결과물 규칙(deliverables) 바로 뒤로" },
];

interface RuleLine { section: string; depth: number; marker: string; text: string }
/** 줄마다 절 제목, 들여쓰기 깊이, 목록 표시(번호는 그대로), 글. 제목·빈 줄은 뺀다(ruleLines 와 같은 줄을 낸다). */
function structuredLines(text: string): RuleLine[] {
  let section = "(맨 앞)";
  const out: RuleLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) { section = line; continue; }
    const m = /^([ \t]*)((?:[-*]|\d+\.)\s+)?(.*)$/.exec(raw.replace(/\s+$/, ""))!;
    out.push({ section, depth: m[1]!.length, marker: (m[2] ?? "").trim(), text: m[3]!.trim() });
  }
  return out;
}

/** a 가 b 의 부분 수열인가(순서 그대로). 아니면 처음 어긋난 a 의 항목. */
function firstOutOfOrder(a: string[], b: string[]): string | null {
  let at = 0;
  for (const item of a) {
    const found = b.indexOf(item, at);
    if (found < 0) return item;
    at = found + 1;
  }
  return null;
}

/**
 * 이 정리 뒤에 새로 더한 규칙 조각(예: 도구 승인 설명). 이 조각의 문장은 '기준본에 없던 문장' 검사에서 뺀다.
 * 새 규칙은 역할 템플릿에 직접 쓰지 말고 조각으로 만들어 여기에 이름을 더한다.
 */
const LATER_PARTS: string[] = [];

function multiset(items: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) out.set(item, (out.get(item) ?? 0) + 1);
  return out;
}

function take(bag: Map<string, number>, item: string): boolean {
  const n = bag.get(item) ?? 0;
  if (!n) return false;
  if (n === 1) bag.delete(item); else bag.set(item, n - 1);
  return true;
}

function laterSentences(kind: MemberKind): string[] {
  const text = builtInRole(kind);
  return LATER_PARTS.filter(name => text.includes(ROLE_PARTS[name]!.trim())).flatMap(name => sentences(ROLE_PARTS[name]!));
}

describe("규칙 대조: 지금 지침의 규칙이 새 지침에 모두 있다", () => {
  for (const kind of KINDS) {
    test(`${kind}: 기준본의 문장이 하나도 빠지거나 바뀌지 않았고, 없던 문장도 생기지 않았다`, () => {
      const expected = multiset(sentences(baseline(kind)));
      for (const change of REWORDED.filter(c => c.kinds.includes(kind))) {
        expect({ kind, missing: change.from, found: take(expected, change.from) }).toEqual({ kind, missing: change.from, found: true });
        expected.set(change.to, (expected.get(change.to) ?? 0) + 1);
      }
      const actual = multiset(sentences(assembled(kind)));
      for (const later of laterSentences(kind)) take(actual, later);
      const lost = [...expected].flatMap(([s, n]) => Array(Math.max(0, n - (actual.get(s) ?? 0))).fill(s));
      const added = [...actual].flatMap(([s, n]) => Array(Math.max(0, n - (expected.get(s) ?? 0))).fill(s));
      expect({ kind, lost, added }).toEqual({ kind, lost: [], added: [] });
    });

    test(`${kind}: 서버가 띄우는 세션(MANUAL=false)도 기준본과 대조한다. 빠져도 되는 문장은 직접 붙인 세션의 wait 안내(MANUAL_ONLY)뿐이다`, () => {
      const expected = multiset(sentences(baseline(kind)));
      for (const change of REWORDED.filter(c => c.kinds.includes(kind))) {
        expect(take(expected, change.from)).toBe(true);
        expected.set(change.to, (expected.get(change.to) ?? 0) + 1);
      }
      if (kind === "worker") for (const only of MANUAL_ONLY) expect({ kind, only, inBaseline: take(expected, only) }).toEqual({ kind, only, inBaseline: true });
      const actual = multiset(sentences(assembled(kind, false)));
      for (const later of laterSentences(kind)) take(actual, later);
      const lost = [...expected].flatMap(([s, n]) => Array(Math.max(0, n - (actual.get(s) ?? 0))).fill(s));
      const added = [...actual].flatMap(([s, n]) => Array(Math.max(0, n - (expected.get(s) ?? 0))).fill(s));
      expect({ kind, lost, added }).toEqual({ kind, lost: [], added: [] });
    });

    test(`${kind}: 손대지 않은 줄은 한 줄 그대로 남아 있다(문맥이 바뀌지 않았다)`, () => {
      const now = new Set(ruleLines(assembled(kind)));
      const exempt = RESTRUCTURED.filter(r => r.kind === kind);
      const missing = ruleLines(baseline(kind)).filter(line => !now.has(line) && !exempt.some(r => line.startsWith(r.startsWith)));
      expect({ kind, missing }).toEqual({ kind, missing: [] });
    });

    test(`${kind}: 손대지 않은 줄은 같은 절·같은 들여쓰기·같은 목록 표시로, 절 안의 순서 그대로 있다(옮긴 줄은 MOVED 표대로)`, () => {
      const before = structuredLines(baseline(kind)), after = structuredLines(assembled(kind));
      const moved = MOVED.filter(m => m.kind === kind), restructured = RESTRUCTURED.filter(r => r.kind === kind);
      const exempt = (text: string) => moved.some(m => text.startsWith(m.startsWith)) || restructured.some(r => text.startsWith(r.startsWith));
      // 1) 같은 글의 줄이 같은 절에 같은 깊이·표시로 있다(번호 목록은 번호까지 같아야 순서가 같다).
      const misplaced = before.filter(line => !exempt(line.text)).filter(line => !after.some(n => n.text === line.text && n.section === line.section && n.depth === line.depth && n.marker === line.marker))
        .map(line => ({ section: line.section, depth: line.depth, marker: line.marker, text: line.text.slice(0, 40) }));
      expect({ kind, misplaced }).toEqual({ kind, misplaced: [] });
      // 2) 절마다 기준본 줄의 순서가 그대로다(다른 줄이 끼어든 것은 된다).
      for (const section of new Set(before.map(line => line.section))) {
        const want = before.filter(line => line.section === section && !exempt(line.text)).map(line => line.text);
        const have = after.filter(line => line.section === section).map(line => line.text);
        expect({ kind, section, outOfOrder: firstOutOfOrder(want, have) }).toEqual({ kind, section, outOfOrder: null });
      }
      // 3) 옮긴 줄은 표에 적은 절에서 왔고 표에 적은 절에 있다.
      for (const m of moved) {
        expect({ kind, line: m.startsWith, from: before.find(line => line.text.startsWith(m.startsWith))?.section }).toEqual({ kind, line: m.startsWith, from: m.from });
        expect({ kind, line: m.startsWith, to: after.filter(line => line.text.startsWith(m.startsWith)).map(line => line.section) }).toEqual({ kind, line: m.startsWith, to: [m.to] });
      }
      // 4) 나눈 줄(RESTRUCTURED)의 문장은 같은 절 안에서 같은 순서로 이어진다(고친 문장은 고친 뒤의 글로 본다).
      for (const r of restructured) {
        const line = before.find(item => item.text.startsWith(r.startsWith))!;
        const reworded = (text: string) => REWORDED.find(c => c.kinds.includes(kind) && c.from === text)?.to ?? text;
        const want = sentences(line.text).map(reworded);
        const have = after.filter(item => item.section === line.section).flatMap(item => sentences(item.text));
        for (const moved of r.reordered ?? []) expect({ kind, line: r.startsWith, moved, sameSection: want.includes(moved) && have.includes(moved) }).toMatchObject({ sameSection: true });
        expect({ kind, line: r.startsWith, outOfOrder: firstOutOfOrder(want.filter(item => !r.reordered?.includes(item)), have) }).toEqual({ kind, line: r.startsWith, outOfOrder: null });
      }
    });
  }

  test("MOVED 표의 줄은 모두 쓰인다", () => {
    for (const m of MOVED) expect({ m, used: structuredLines(baseline(m.kind)).some(line => line.text.startsWith(m.startsWith)) }).toMatchObject({ used: true });
  });

  test("고친 문장·나눈 줄 목록에 쓰이지 않는 항목이 없다", () => {
    for (const change of REWORDED) for (const kind of change.kinds) {
      expect({ kind, from: change.from, inBaseline: sentences(baseline(kind)).includes(change.from) }).toMatchObject({ inBaseline: true });
      expect({ kind, to: change.to, inNew: sentences(assembled(kind)).includes(change.to) }).toMatchObject({ inNew: true });
    }
    for (const r of RESTRUCTURED) expect({ r, used: ruleLines(baseline(r.kind)).some(line => line.startsWith(r.startsWith)) }).toMatchObject({ used: true });
  });

  test("서버가 띄우는 세션은 wait 안내만 빠진다(그 세션에는 wait 도구가 없다)", () => {
    // manual-session.md 는 정확히 기준본의 wait 단락 다섯 문장이다. 다른 규칙이 이 조각에 들어가면 서버가 띄우는 세션에서 빠진다.
    expect(sentences(readFileSync(join(import.meta.dir, "..", "server", "roles", "parts", "manual-session.md"), "utf8"))).toEqual(MANUAL_ONLY);
    expect(sentences(baseline("worker")).filter(s => MANUAL_ONLY.includes(s))).toEqual(MANUAL_ONLY);
    for (const kind of KINDS) {
      const withManual = multiset(sentences(assembled(kind, true)));
      if (kind === "worker") for (const s of MANUAL_ONLY) expect(take(withManual, s)).toBe(true);
      expect(sentences(assembled(kind, false)).sort()).toEqual([...withManual].flatMap(([s, n]) => Array(n).fill(s)).sort());
    }
    expect(renderRole("worker", VARS)).not.toContain("`wait` 도구가 있으면");
    expect(renderRole("worker", { ...VARS, MANUAL: true })).toContain("`wait({ack_batch_id: \"받은 batch id\"})`로 ACK한 뒤 처리한다.");
    // 서버가 띄우는 세션에는 wait 도구가 없다. 직접 붙인 세션에만 있다.
    const tools = (origin: Member["origin"]) => listAgentTools({ kind: "worker", origin } as Member).map(t => t.name);
    expect(tools("runner")).not.toContain("wait");
    expect(tools("manual")).toContain("wait");
  });

  test("여러 역할에 같은 글로 있던 묶음은 조각 하나에만 있고, 조립이 끝나면 조각 표시가 남지 않는다", () => {
    for (const kind of KINDS) {
      const text = builtInRole(kind);
      expect(text).not.toContain("{{>");
      for (const name of ["deliverables", "artifact-contract", "tool-retry"]) expect(text).toContain(ROLE_PARTS[name]!.trim());
    }
    for (const kind of ["conductor", "root"] as const) expect(builtInRole(kind)).toContain(ROLE_PARTS["ack-turn"]!.trim());
    for (const kind of KINDS) {
      const raw = readFileSync(join(import.meta.dir, "..", "server", "roles", `${kind}.md`), "utf8");
      expect(raw).not.toContain("아티팩트 공통 계약");
      expect(raw).not.toContain("MCP bridge가 전송 전에");
    }
    expect(() => assembleRole("앞\n{{> missing-part}}\n뒤")).toThrow("역할 조각이 없습니다");
    expect(() => assembleRole("앞 {{> deliverables}} 뒤")).toThrow("조립하지 못한 조각 표시");
    expect(assembleRole("앞\n{{> x}}\n뒤", { x: "조각\n\n" })).toBe("앞\n조각\n뒤");
  });

  test("파일 끝에 절 밖으로 붙어 있던 항목이 제 절 안으로 들어갔다", () => {
    const section = (text: string, line: string) => {
      const before = text.slice(0, text.indexOf(line));
      return before.slice(before.lastIndexOf("\n## ") + 4).split("\n")[0];
    };
    const conductor = builtInRole("conductor");
    expect(section(conductor, "- 지시를 다시 보낼 때")).toBe("지시");
    expect(section(conductor, "- 판 정리 때 3일 넘은")).toBe("보고 받기");
    expect(section(conductor, "- 아티팩트 공통 계약")).toBe("보고 받기");
    expect(section(builtInRole("worker"), "- 네가 `todo`로 부탁한 일이 다시 필요해지면")).toBe("질문: `ask`");
    expect(section(builtInRole("root"), "- 직원 보고로만 깨어난 확인 턴은")).toBe("대표에게 말하기");
    // 마지막 절은 언제나 도구 응답 유실이다.
    for (const kind of KINDS) expect(builtInRole(kind).trimEnd().split("\n## ").at(-1)!.startsWith("도구 응답 유실")).toBe(true);
  });
});

describe("대표가 최근에 넣은 규칙이 남는다", () => {
  const lead = { kind: "conductor", origin: "runner" } as Member;
  const tool = (name: string) => listAgentTools(lead).find(t => t.name === name)!.description;

  test("사용 한도로 멈춘 팀장: 새로 띄우지 않고 기다리며, 모델은 대표가 시킬 때만 team_model 로 바꾼다", () => {
    const conductor = renderRole("conductor", VARS);
    for (const rule of [
      "직원이 사용 한도로 멈추면 기다린다.",
      "한도가 풀리면 서버가 그 직원에게 이어서 하게 한다.",
      "새로 띄우거나(`team_add`) 재우거나 스스로 모델을 바꾸지 않는다.",
      "대표가 모델을 바꾸라고 하면 `team_model`로 그 직원의 모델을 바꾼다.",
      "같은 대화를 이어 열고, 멈춘 일은 서버가 그 직원에게 이어서 하게 하니 같은 일을 다시 맡기지 않는다.",
    ]) expect(conductor).toContain(rule);
    expect(tool("team_model").startsWith("대표가 모델을 바꾸라고 했을 때만 쓴다.")).toBe(true);
    expect(tool("team_add")).toContain("사용 한도로 멈춘 직원의 일을 넘기려고 새로 띄우지 않는다.");
    expect(tool("roster")).toContain("대표가 바꾸라고 할 때만 team_model 로 바꾼다");
  });

  test("이름은 맡은 일로, 사람 이름은 붙이지 않는다", () => {
    expect(renderRole("conductor", VARS)).toContain("이름은 맡은 일로 짓는다(예: `결제 연동`, `화면 문구`). 사람 이름을 붙이지 않는다.");
    expect(tool("team_add")).toContain("역할이 맞는 직원이 없을 때만");
  });

  test("보고 언어 줄은 기본 규칙(통째 교체 파일 포함) 끝에 한 번만 붙고, 사용자 덧붙임은 그 뒤에 와서 대체되지 않는다", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-w3m-lang-")));
    writeFileSync(join(dir, "worker.extra.md"), "## 이 팀의 규칙\n- 커밋 메시지는 한국어로 쓴다.\n");
    writeFileSync(join(dir, "root.md"), `${roleBaseMarker("root")}\n${builtInRole("root")}`);
    writeFileSync(join(dir, "root.extra.md"), "- 덧붙인 규칙\n");
    for (const kind of KINDS) {
      const english = renderRole(kind, { ...VARS, REPORT_LANGUAGE: "en" }, dir);
      expect(english.split("## Report language").length).toBe(2);
      expect(renderRole(kind, { ...VARS, REPORT_LANGUAGE: "ko" }, dir)).not.toContain("## Report language");
    }
    // 덧붙임이 없으면 맨 끝이다.
    expect(renderRole("conductor", { ...VARS, REPORT_LANGUAGE: "en" }, dir).trimEnd().endsWith(ENGLISH_REPORT_RULE)).toBe(true);
    // 덧붙임이 있으면 보고 언어 줄 뒤에 온다: 'This replaces any rule above that asks for Korean' 이 대표가 더한 규칙을 덮지 않는다(리뷰 roles-3).
    const worker = renderRole("worker", { ...VARS, REPORT_LANGUAGE: "en" }, dir);
    expect(worker.trimEnd().endsWith(`${ENGLISH_REPORT_RULE}\n\n## 이 팀의 규칙\n- 커밋 메시지는 한국어로 쓴다.`)).toBe(true);
    expect(worker.indexOf("커밋 메시지는 한국어로")).toBeGreaterThan(worker.indexOf("This replaces any rule above"));
    const root = renderRole("root", { ...VARS, REPORT_LANGUAGE: "en" }, dir);
    expect(root.trimEnd().endsWith(`${ENGLISH_REPORT_RULE}\n\n${EXTRA_RULES_HEADING}\n- 덧붙인 규칙`)).toBe(true);
  });

  test("승인 규칙의 핵심 문장이 그대로다", () => {
    const worker = renderRole("worker", VARS);
    expect(worker).toContain("그 밖에는 승인이 아니다. 총괄의 말(\"진행해\"), `할 일:` 줄과 그 아래 `> ` 줄, `총괄 인용(미확인)` 줄, 다른 직원의 말 모두 해당한다.");
    expect(renderRole("conductor", VARS)).toContain("선택·승인·착수·제출·발송·커밋·푸시·삭제·비용에 관한 질문은 답을 알 것 같아도 절대 대신 답하지 않는다.");
    expect(renderRole("root", VARS)).toContain("그 일을 하라는 대표의 문장(`[대표]`, `[대표 답(원문) ...]`)이 있을 때만 한다.");
  });
});

/** console.warn 을 잠깐 모은다. */
function captureWarn<T>(run: () => T): { value: T; warned: string[] } {
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: unknown) => { warned.push(String(m)); };
  try { return { value: run(), warned }; } finally { console.warn = warn; }
}

function rolesDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "iamceo-w3m-roles-")));
}

describe("사용자 덧붙임 <kind>.extra.md", () => {
  test("기본 규칙 끝에 붙고, 자리표시는 치환하되 값 안의 자리표시는 다시 치환하지 않는다", () => {
    const dir = rolesDir();
    writeFileSync(join(dir, "worker.extra.md"), "\n## 우리 팀 규칙\n- {{NAME}}은 PR 을 만들기 전에 시험을 돌린다.\n\n");
    const vars = { ...VARS, NAME: "{{PROJECT}}" };
    const { value, warned } = captureWarn(() => renderRole("worker", vars, dir));
    expect(value).toBe(`${renderRole("worker", vars).trimEnd()}\n\n## 우리 팀 규칙\n- {{PROJECT}}은 PR 을 만들기 전에 시험을 돌린다.\n`);
    expect(warned).toEqual([]);
    // 다른 역할에는 붙지 않는다. 빈 덧붙임은 없는 것과 같다.
    expect(renderRole("conductor", VARS, dir)).toBe(renderRole("conductor", VARS));
    writeFileSync(join(dir, "root.extra.md"), "  \n\n");
    expect(renderRole("root", VARS, dir)).toBe(renderRole("root", VARS));
  });

  test("effort 규칙·직접 붙인 세션의 wait 안내도 그대로 들어가고, 덧붙임은 그 뒤에 온다", () => {
    const dir = rolesDir();
    writeFileSync(join(dir, "worker.extra.md"), "- 덧붙인 규칙\n");
    const rule = "- 서브에이전트·워크플로를 부를 때 effort=low 을 넘긴다.";
    const text = renderRole("worker", { ...VARS, SUBAGENT_EFFORT: rule, MANUAL: true }, dir);
    expect(text).toContain(rule);
    expect(text).toContain("`wait` 도구가 있으면 네가 직접 띄워진 세션이다.");
    expect(text.trimEnd().endsWith("- 덧붙인 규칙")).toBe(true);
  });

  test("통째 교체 파일에도 덧붙는다", () => {
    const dir = rolesDir();
    writeFileSync(join(dir, "worker.md"), "승인 없이 커밋하지 않는다. {{NAME}}\n");
    writeFileSync(join(dir, "worker.extra.md"), "- 덧붙인 규칙\n");
    const { value } = captureWarn(() => renderRole("worker", VARS, dir));
    expect(value).toBe(`승인 없이 커밋하지 않는다. 결제 연동\n\n${EXTRA_RULES_HEADING}\n- 덧붙인 규칙\n`);
  });

  test("제목 없이 쓴 덧붙임은 '## 이 Mac에서 더한 규칙' 절에 들어가 기본 지침의 마지막 절(도구 응답 유실) 안으로 섞이지 않는다", () => {
    const dir = rolesDir();
    writeFileSync(join(dir, "worker.extra.md"), "- 커밋 메시지는 한국어로 쓴다.\n");
    writeFileSync(join(dir, "conductor.extra.md"), "# 우리 회사 규칙\n- 금요일에는 배포하지 않는다.\n");
    const sectionOf = (text: string, needle: string) => structuredLines(text).find(line => line.text.includes(needle))!.section;
    for (const language of ["ko", "en"] as const) {
      const worker = renderRole("worker", { ...VARS, REPORT_LANGUAGE: language }, dir);
      expect(sectionOf(worker, "커밋 메시지는 한국어로")).toBe(EXTRA_RULES_HEADING);
      expect(worker.trimEnd().endsWith(`${EXTRA_RULES_HEADING}\n- 커밋 메시지는 한국어로 쓴다.`)).toBe(true);
      // 제목으로 시작하는 덧붙임은 그대로 둔다.
      const conductor = renderRole("conductor", { ...VARS, REPORT_LANGUAGE: language }, dir);
      expect(sectionOf(conductor, "금요일에는 배포하지 않는다")).toBe("# 우리 회사 규칙");
      expect(conductor).not.toContain(EXTRA_RULES_HEADING);
    }
    // 덧붙임이 없으면 제목도 없다.
    expect(renderRole("root", VARS, dir)).not.toContain(EXTRA_RULES_HEADING);
  });

  test("덧붙임 파일을 읽지 못하면(폴더·권한 없음) 띄우기·전달을 막지 않고 덧붙임 없이 만든다. 로그에 한 번, 점검표에 알린다", () => {
    const dir = rolesDir();
    mkdirSync(join(dir, "worker.extra.md"));
    const first = captureWarn(() => renderRole("worker", VARS, dir));
    expect(first.value).toBe(renderRole("worker", VARS));
    expect(first.warned).toHaveLength(1);
    expect(first.warned[0]).toContain(join(dir, "worker.extra.md"));
    expect(captureWarn(() => renderRole("worker", VARS, dir)).warned).toEqual([]);
    expect(roleCustomizations(dir)).toEqual([{ kind: "worker", replacement: null, extra: { path: join(dir, "worker.extra.md"), unreadable: true } }]);
  });

  test("점검 목록에 덧붙임만 있으면 정상으로 보인다", () => {
    const dir = rolesDir();
    writeFileSync(join(dir, "conductor.extra.md"), "- 덧붙인 규칙\n");
    expect(roleCustomizations(dir)).toEqual([{ kind: "conductor", replacement: null, extra: { path: join(dir, "conductor.extra.md") } }]);
  });
});

describe("통째 교체 파일의 기준판 표지", () => {
  test("roles export 는 첫 줄에 지금 기본 규칙의 표지를 넣고, 그대로 쓰면 기본과 같은 지침이 나오며 경고가 없다", () => {
    const dir = rolesDir();
    const paths = exportRoles(dir);
    expect(paths.map(p => p.split("/").at(-1))).toEqual(["conductor.example.md", "root.example.md", "worker.example.md"]);
    for (const kind of KINDS) {
      const example = readFileSync(join(dir, `${kind}.example.md`), "utf8");
      const [first, ...rest] = example.split("\n");
      expect(readRoleBase(first!)).toEqual({ kind, hash: roleBaseHash(kind) });
      expect(rest.join("\n")).toBe(builtInRole(kind));
      writeFileSync(join(dir, `${kind}.md`), example);
      const { value, warned } = captureWarn(() => renderRole(kind, { ...VARS, SUBAGENT_EFFORT: "", MANUAL: kind === "worker" }, dir));
      expect(value).toBe(renderRole(kind, { ...VARS, SUBAGENT_EFFORT: "", MANUAL: kind === "worker" }));
      expect(value).not.toContain("iamceo-role-base");
      expect(warned).toEqual([]);
    }
    expect(roleCustomizations(dir).map(c => [c.kind, c.replacement?.base, c.replacement?.approval])).toEqual([
      ["conductor", "current", true], ["worker", "current", true], ["root", "current", true],
    ]);
  });

  test("기본 규칙이 바뀐 뒤의 옛 표지, 표지 없음, 다른 역할의 표지는 로그에 한 번씩 경고한다", () => {
    const dir = rolesDir();
    const stale = `<!-- iamceo-role-base: worker@000000000000 · 이 줄은 지우지 마세요 -->\n${builtInRole("worker")}`;
    writeFileSync(join(dir, "worker.md"), stale);
    writeFileSync(join(dir, "conductor.md"), "승인 규칙은 그대로 둔 고친 지침 {{NAME}}");
    writeFileSync(join(dir, "root.md"), `${roleBaseMarker("worker")}\n승인 규칙`);
    const first = captureWarn(() => KINDS.map(kind => renderRole(kind, VARS, dir)));
    expect(first.warned.some(w => w.includes(join(dir, "worker.md")) && w.includes("이전 기본 규칙"))).toBe(true);
    expect(first.warned.some(w => w.includes(join(dir, "conductor.md")) && w.includes("기준판 표지가 없어"))).toBe(true);
    expect(first.warned.some(w => w.includes(join(dir, "root.md")) && w.includes("다른 역할(worker)"))).toBe(true);
    expect(first.warned).toHaveLength(3);
    // 표지 줄은 세션에 넘기지 않는다.
    expect(first.value[1]).toBe(renderRole("worker", VARS));
    // 같은 문제는 서버가 도는 동안 다시 남기지 않는다.
    expect(captureWarn(() => KINDS.map(kind => renderRole(kind, VARS, dir))).warned).toEqual([]);
    expect(roleCustomizations(dir).map(c => [c.kind, c.replacement?.base])).toEqual([["conductor", "unmarked"], ["worker", "stale"], ["root", "other_kind"]]);
  });

  test("승인 규칙이 빠진 교체 파일의 기존 경고는 그대로다", () => {
    const dir = rolesDir();
    writeFileSync(join(dir, "worker.md"), `${roleBaseMarker("worker")}\n맞춤 {{NAME}}`);
    const { value, warned } = captureWarn(() => renderRole("worker", VARS, dir));
    expect(value).toBe("맞춤 결제 연동");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("승인 규칙이 없습니다");
  });
});

describe("점검표의 '고쳐 쓴 역할 지침'", () => {
  const NOW = new Date("2026-11-13T03:00:00.000Z");
  const facts = (roles: DoctorFacts["roles"]): DoctorFacts => ({
    now: NOW,
    server: { state: "running", ready: true, version: "0.2.4" },
    engine: { installed: true, available: true, version: "0.5.2", detail: null, status: null },
    providers: { claude: { installed: true, login: "yes" }, codex: { installed: true, login: "yes" } },
    codexInUse: false,
    cliVersions: null,
    tailscale: { auto: true, address: "100.64.0.7", everOpened: true, status: null },
    service: { state: "running" },
    backup: null,
    disk: null,
    roles,
  });

  test("고친 지침이 없으면 항목이 없다(고정 목록 그대로)", () => {
    expect(doctorChecks(facts(undefined)).map(c => c.id)).toEqual([...DOCTOR_CHECK_IDS]);
    expect(doctorChecks(facts([])).map(c => c.id)).toEqual([...DOCTOR_CHECK_IDS]);
    expect(doctorChecks(facts(roleCustomizations(rolesDir()))).map(c => c.id)).toEqual([...DOCTOR_CHECK_IDS]);
  });

  test("덧붙임과 지금 표지의 교체 파일은 정상, 옛 표지·표지 없음·승인 규칙 없음은 확인 필요와 고치는 법", () => {
    const dir = rolesDir();
    writeFileSync(join(dir, "worker.extra.md"), "- 덧붙인 규칙\n");
    writeFileSync(join(dir, "root.md"), `${roleBaseMarker("root")}\n${builtInRole("root")}`);
    const ok = doctorChecks(facts(roleCustomizations(dir))).at(-1)!;
    expect(ok).toEqual({ id: DOCTOR_ROLES_CHECK_ID, state: "ok", title: "고쳐 쓴 역할 지침", detail: "팀장: 덧붙임 · 본사 AI: 통째 교체" });

    writeFileSync(join(dir, "conductor.md"), "고친 지침");
    const warn = doctorChecks(facts(roleCustomizations(dir))).at(-1)!;
    expect(warn.state).toBe("warn");
    expect(warn.detail).toBe("총괄: 통째 교체, 기준판 표지 없음, 승인 규칙 없음 · 팀장: 덧붙임 · 본사 AI: 통째 교체");
    expect(warn.fix).toContain("iamceo roles export");
    expect(warn.fix).toContain("conductor.extra.md");
    expect(warn.fix).not.toContain("root.extra.md");
    const english = doctorChecks(facts(roleCustomizations(dir)), "en").at(-1)!;
    expect(english.title).toBe("Edited role rules");
    expect(english.detail).toBe("lead: replaced, no base marker, no approval rule · staff: additions · HQ agent: replaced");
  });

  test("승인 규칙만 빠졌으면 승인 절을 남기라고 하고, 표지를 바꾸라고 하지 않는다. 영어로 옮긴 파일의 Approval 은 승인 규칙으로 본다(리뷰 roles-6)", () => {
    const dir = rolesDir();
    // 지금 표지 + 승인 절을 지운 교체 파일.
    writeFileSync(join(dir, "worker.md"), `${roleBaseMarker("worker")}\n## 일하는 법\n- 맡은 일을 끝까지 한다.\n`);
    const warn = doctorChecks(facts(roleCustomizations(dir))).at(-1)!;
    expect(warn).toMatchObject({ state: "warn", detail: "팀장: 통째 교체, 승인 규칙 없음" });
    expect(warn.fix).toContain("승인 절을 그대로 남기세요");
    expect(warn.fix).toContain("worker.md");
    expect(warn.fix).not.toContain("기준판 표지를 새 파일의 것으로 바꾸세요");
    expect(doctorChecks(facts(roleCustomizations(dir)), "en").at(-1)!.fix).toBe("Keep the approval section of the default rules in worker.md (it is in the file iamceo roles export writes). Without it, sessions may act without your approval.");
    // 그 고치는 법대로 승인 절을 남기면 경고가 사라진다.
    writeFileSync(join(dir, "worker.md"), `${roleBaseMarker("worker")}\n${builtInRole("worker")}`);
    expect(doctorChecks(facts(roleCustomizations(dir))).at(-1)!.state).toBe("ok");
    // 영어로 옮긴 교체 파일(승인 절 'Approval').
    writeFileSync(join(dir, "worker.md"), `${roleBaseMarker("worker")}\n## Approval\n- Only the owner's own words approve work.\n`);
    expect(roleCustomizations(dir)[0]!.replacement!.approval).toBe(true);
    expect(doctorChecks(facts(roleCustomizations(dir))).at(-1)!.state).toBe("ok");
    expect(hasApprovalRule("approve before pushing")).toBe(true);
    expect(hasApprovalRule(`${roleBaseMarker("worker")}\n맡은 일만 한다`)).toBe(false);
  });

  test("읽지 못하는 덧붙임은 확인 필요와 그 파일 이름으로 보인다(리뷰 roles-5)", () => {
    const dir = rolesDir();
    mkdirSync(join(dir, "conductor.extra.md"));
    writeFileSync(join(dir, "worker.extra.md"), "- 덧붙인 규칙\n");
    const check = doctorChecks(facts(roleCustomizations(dir))).at(-1)!;
    expect(check).toMatchObject({ state: "warn", detail: "총괄: 덧붙임을 읽지 못함 · 팀장: 덧붙임" });
    expect(check.fix).toBe("conductor.extra.md 를 읽을 수 없어 넣지 않았습니다(폴더이거나 읽기 권한이 없음). 글 파일로 고치거나 지우세요.");
    expect(doctorChecks(facts(roleCustomizations(dir)), "en").at(-1)!.detail).toBe("lead: additions unreadable · staff: additions");
  });
});
