// 3차 M(E10) 팀장 지침 정리: 세 역할 지침을 공통 조각으로 나눠 조립해도 규칙의 뜻이 하나도 빠지거나 바뀌지 않았는지,
// 사용자 덧붙임(<kind>.extra.md)과 통째 교체 파일의 기준판 표지가 도는지, 대표가 최근에 넣은 규칙이 남는지 본다.
//
// 기준본: tests/fixtures/roles-baseline/*.md 는 정리 직전(7f30d95)의 server/roles/*.md 그대로다. 손대지 않는다.
// 규칙 하나 = 기준본의 문장 하나다(줄을 나누고, 목록 표시를 떼고, 마침표 뒤에서 자른다). 제목 줄은 구조라 뺀다.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCTOR_CHECK_IDS, DOCTOR_ROLES_CHECK_ID, type Member, type MemberKind } from "../shared/types.ts";
import { listAgentTools } from "../server/agent-tools.ts";
import { doctorChecks, type DoctorFacts } from "../server/doctor.ts";
import {
  assembleRole, builtInRole, ENGLISH_REPORT_RULE, exportRoles, readRoleBase, renderRole, ROLE_PARTS, roleBaseHash, roleBaseMarker, roleCustomizations,
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

/** 문장은 그대로인데 줄이 나뉘거나 다른 줄과 합쳐진 곳. 여기 없는 기준본의 줄은 새 지침에 한 줄 그대로 있어야 한다. */
const RESTRUCTURED: { kind: MemberKind; startsWith: string; why: string }[] = [
  { kind: "conductor", startsWith: "판 맞추기:", why: "962자 한 항목을 하위 항목 여섯으로 나눴다(문장·순서 그대로)" },
  { kind: "conductor", startsWith: "대표가 읽거나 복사하거나", why: "자료 규칙을 공통 조각(deliverables)과 총괄 몫 한 줄로 나눴다" },
  { kind: "worker", startsWith: "대표가 읽거나 복사하거나", why: "자료 규칙을 공통 조각(deliverables)과 팀장 몫 한 줄로 나눴다" },
  { kind: "root", startsWith: "한 번에 끝나는 조사", why: "자료 규칙을 공통 조각(deliverables)으로 옮겼다" },
  { kind: "root", startsWith: "대표가 읽거나 복사하거나", why: "자료 규칙을 공통 조각(deliverables)으로 합쳤다" },
];

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

    test(`${kind}: 손대지 않은 줄은 한 줄 그대로 남아 있다(문맥이 바뀌지 않았다)`, () => {
      const now = new Set(ruleLines(assembled(kind)));
      const exempt = RESTRUCTURED.filter(r => r.kind === kind);
      const missing = ruleLines(baseline(kind)).filter(line => !now.has(line) && !exempt.some(r => line.startsWith(r.startsWith)));
      expect({ kind, missing }).toEqual({ kind, missing: [] });
    });
  }

  test("고친 문장·나눈 줄 목록에 쓰이지 않는 항목이 없다", () => {
    for (const change of REWORDED) for (const kind of change.kinds) {
      expect({ kind, from: change.from, inBaseline: sentences(baseline(kind)).includes(change.from) }).toMatchObject({ inBaseline: true });
      expect({ kind, to: change.to, inNew: sentences(assembled(kind)).includes(change.to) }).toMatchObject({ inNew: true });
    }
    for (const r of RESTRUCTURED) expect({ r, used: ruleLines(baseline(r.kind)).some(line => line.startsWith(r.startsWith)) }).toMatchObject({ used: true });
  });

  test("서버가 띄우는 세션은 wait 안내만 빠진다(그 세션에는 wait 도구가 없다)", () => {
    const manualOnly = sentences(readFileSync(join(import.meta.dir, "..", "server", "roles", "parts", "manual-session.md"), "utf8"));
    expect(manualOnly[0]).toBe("`wait` 도구가 있으면 네가 직접 띄워진 세션이다.");
    for (const kind of KINDS) {
      const withManual = multiset(sentences(assembled(kind, true)));
      if (kind === "worker") for (const s of manualOnly) expect(take(withManual, s)).toBe(true);
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

  test("보고 언어 줄은 기본·통째 교체·덧붙임 어느 경우에도 맨 끝에 한 번만 붙는다", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-w3m-lang-")));
    writeFileSync(join(dir, "worker.extra.md"), "## 이 팀의 규칙\n- 커밋 메시지는 한국어로 쓴다.\n");
    writeFileSync(join(dir, "root.md"), `${roleBaseMarker("root")}\n${builtInRole("root")}`);
    writeFileSync(join(dir, "root.extra.md"), "- 덧붙인 규칙\n");
    for (const kind of KINDS) {
      const english = renderRole(kind, { ...VARS, REPORT_LANGUAGE: "en" }, dir);
      expect(english.trimEnd().endsWith(ENGLISH_REPORT_RULE)).toBe(true);
      expect(english.split("## Report language").length).toBe(2);
      expect(renderRole(kind, { ...VARS, REPORT_LANGUAGE: "ko" }, dir)).not.toContain("## Report language");
    }
    expect(renderRole("worker", { ...VARS, REPORT_LANGUAGE: "en" }, dir)).toContain("- 커밋 메시지는 한국어로 쓴다.\n\n## Report language");
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
    expect(value).toBe("승인 없이 커밋하지 않는다. 결제 연동\n\n- 덧붙인 규칙\n");
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
});
