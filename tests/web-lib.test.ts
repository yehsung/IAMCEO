import { describe, expect, test } from "bun:test";
import type { Decision, Member, Message, ProjectState, WsEvent } from "../shared/types";
import { WS_STALE_MS, applyToProject, hasMessageGap, isSocketStale, mergeMessages, parseHash, routeHash, upsertMessage } from "../web/src/lib/store";
import { formatRelative, formatTime } from "../web/src/lib/time";
import { isNumericColumn, parseDelimited, TABLE_COLUMN_LIMIT } from "../web/src/components/viewers/delimited";

const msg = (id: string, at: string, over: Partial<Message> = {}): Message => ({
  id, projectId: "p", at, mine: false, memberId: null, who: "총괄", kind: "진행", title: "", body: id,
  targetMemberId: null, targetName: null, decisionId: null, fileId: null, attachments: [], delivery: null, deliveryNote: null, ...over,
});

describe("주소", () => {
  test("프로젝트·탭·하위 경로를 읽고 되돌린다", () => {
    const r = parseHash("#/p/p_abc/files/f_1");
    expect(r).toEqual({ projectId: "p_abc", tab: "files", sub: "f_1", settings: false });
    expect(routeHash(r)).toBe("#/p/p_abc/files/f_1");
  });
  test("본사에는 팀 탭이 없다(홈으로 간다)", () => {
    expect(parseHash("#/p/hq/team").tab).toBe("home");
    expect(parseHash("#/p/p_a/team").tab).toBe("team");
  });
  test("빈 주소·이상한 주소는 본사 홈", () => {
    for (const h of ["", "#", "#/", "#/x/y", "#/p/"]) expect(parseHash(h)).toEqual({ projectId: "hq", tab: "home", sub: null, settings: false });
    expect(parseHash("#/p/p_a/nope/x")).toEqual({ projectId: "p_a", tab: "home", sub: null, settings: false });
  });
  test("설정·깨진 인코딩", () => {
    expect(parseHash("#/settings").settings).toBe(true);
    expect(parseHash("#/p/%E0%A4%A/inbox").projectId).toBe("%E0%A4%A");
  });
});

describe("이벤트 적용", () => {
  const base = { project: { id: "p" }, members: [], decisions: [], todos: [], work: [], messages: [], files: [] } as unknown as ProjectState;
  test("다른 프로젝트 이벤트는 그대로 같은 객체를 돌려준다", () => {
    const e: WsEvent = { type: "message", message: msg("m", "2026-01-01T00:00:00Z", { projectId: "other" }) };
    expect(applyToProject(base, e)).toBe(base);
  });
  test("같은 id 는 바꾸고, 지운 직원은 뺀다", () => {
    const m = { id: "m1", projectId: "p", status: "idle" } as never;
    let s = applyToProject(base, { type: "member", member: m });
    s = applyToProject(s, { type: "member", member: { ...(m as object), status: "working" } as never });
    expect(s.members.map((x) => x.status)).toEqual(["working"]);
    s = applyToProject(s, { type: "member_removed", projectId: "p", memberId: "m1" });
    expect(s.members).toEqual([]);
  });
  test("서버가 되돌린 결재(answered → open)는 화면도 되돌리고, 판 번호가 낮은 늦은 응답은 무시한다", () => {
    const d = (status: string, updatedAt: string) => ({ id: "d1", projectId: "p", status, updatedAt }) as never as Decision;
    const start = { project: { id: "p", updatedAt: "" }, members: [], decisions: [d("delivered", "2026-01-01T00:00:03Z")], todos: [], work: [], messages: [], files: [] } as never as ProjectState;
    let s = applyToProject(start, { type: "decision", decision: d("answered", "2026-01-01T00:00:04Z") });
    expect(s.decisions[0]!.status).toBe("answered");
    s = applyToProject(s, { type: "decision", decision: d("open", "2026-01-01T00:00:05Z") });
    expect(s.decisions[0]!.status).toBe("open");
    // 먼저 만들어진 REST 응답이 뒤늦게 온다.
    s = applyToProject(s, { type: "decision", decision: d("delivered", "2026-01-01T00:00:02Z") });
    expect(s.decisions[0]!.status).toBe("open");
  });

  test("본사의 팀 주소는 직원 상세일 때만 열린다", () => {
    expect(parseHash("#/p/hq/team/m_1")).toMatchObject({ projectId: "hq", tab: "team", sub: "m_1" });
    expect(parseHash("#/p/hq/team")).toMatchObject({ projectId: "hq", tab: "home", sub: null });
  });

  test("늦게 도착한 REST 응답은 이벤트로 받은 새 상태를 되돌리지 못한다", () => {
    const decision = { id: "d1", projectId: "p", status: "delivered" } as never as Decision;
    const member = { id: "m1", projectId: "p", status: "working", updatedAt: "2026-01-01T00:00:02Z" } as never as Member;
    const start = { project: { id: "p", updatedAt: "2026-01-01T00:00:02Z", now: "새" }, members: [member], decisions: [decision], todos: [], work: [], messages: [], files: [] } as never as ProjectState;

    let s = applyToProject(start, { type: "decision", decision: { ...decision, status: "answered" } });
    expect(s.decisions[0]!.status).toBe("delivered");
    s = applyToProject(s, { type: "decision", decision: { ...decision, status: "closed" } });
    expect(s.decisions[0]!.status).toBe("closed");

    s = applyToProject(s, { type: "member", member: { ...member, status: "idle", updatedAt: "2026-01-01T00:00:01Z" } });
    expect(s.members[0]!.status).toBe("working");
    s = applyToProject(s, { type: "member", member: { ...member, status: "idle", updatedAt: "2026-01-01T00:00:03Z" } });
    expect(s.members[0]!.status).toBe("idle");

    s = applyToProject(s, { type: "project", project: { ...s.project, now: "옛", updatedAt: "2026-01-01T00:00:01Z" } });
    expect(s.project.now).toBe("새");
  });
  test("글은 시각순으로 끼우고 같은 id 는 덮어쓴다", () => {
    let l = [msg("a", "2026-01-01T00:00:01Z"), msg("c", "2026-01-01T00:00:03Z")];
    l = upsertMessage(l, msg("b", "2026-01-01T00:00:02Z"));
    expect(l.map((m) => m.id)).toEqual(["a", "b", "c"]);
    l = upsertMessage(l, msg("b", "2026-01-01T00:00:02Z", { delivery: "delivered" }));
    expect(l.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(l[1]!.delivery).toBe("delivered");
  });
  test("재동기화는 더 오래된 글과 서버에 아직 없는 글을 잃지 않고 서버 값을 앞세운다", () => {
    const local = [msg("old", "2026-01-01T00:00:00Z"), msg("x", "2026-01-01T00:00:05Z", { delivery: "queued" }), msg("draft", "2026-01-01T00:00:09Z", { delivery: "failed" })];
    const fresh = [msg("x", "2026-01-01T00:00:05Z", { delivery: "delivered" }), msg("y", "2026-01-01T00:00:07Z")];
    const merged = mergeMessages(local, fresh);
    expect(merged.map((m) => m.id)).toEqual(["old", "x", "y", "draft"]);
    expect(merged[1]!.delivery).toBe("delivered");
  });
});

describe("시각(KST)", () => {
  const now = new Date("2026-11-02T06:00:00Z"); // KST 15:00
  test("오늘·올해·작년", () => {
    expect(formatTime("2026-11-02T05:04:00Z", now)).toBe("14:04");
    expect(formatTime("2026-11-01T14:59:00Z", now)).toBe("11월 1일 23:59");
    expect(formatTime("2026-11-01T15:00:00Z", now)).toBe("00:00"); // UTC 로는 어제지만 KST 로는 오늘
    expect(formatTime("2025-03-09T00:30:00Z", now)).toBe("2025년 3월 9일 09:30");
  });
  test("상대 시각과 잘못된 값", () => {
    expect(formatRelative("2026-11-02T05:59:30Z", now)).toBe("방금");
    expect(formatRelative("2026-11-02T05:45:00Z", now)).toBe("15분 전");
    expect(formatRelative("2026-11-02T03:00:00Z", now)).toBe("3시간 전");
    expect(formatTime("nonsense", now)).toBe("");
  });
});

describe("재접속 동기화", () => {
  test("끊긴 동안 한 쪽 분량을 넘게 쌓이면 틈으로 본다", () => {
    const local = [msg("a", "2026-01-01T00:00:00Z"), msg("b", "2026-01-01T00:00:01Z")];
    const page = [msg("x", "2026-01-02T00:00:00Z"), msg("y", "2026-01-02T00:00:01Z")];
    expect(hasMessageGap(local, page, 2)).toBe(true);
    // 이어지면 틈이 아니다.
    expect(hasMessageGap(local, [msg("b", "2026-01-01T00:00:01Z"), msg("y", "2026-01-02T00:00:01Z")], 2)).toBe(false);
    // 다 받은 쪽이면 틈이 있을 수 없다.
    expect(hasMessageGap(local, page, 3)).toBe(false);
    expect(hasMessageGap([], page, 2)).toBe(false);
    // 보내는 중·실패한 내 글은 서버에 없을 수 있어 기준이 아니다.
    expect(hasMessageGap([msg("n", "2026-01-03T00:00:00Z", { delivery: "failed" })], page, 2)).toBe(false);
  });

  test("소켓이 45초 조용하면 멈춘 것으로 본다", () => {
    expect(isSocketStale(0, WS_STALE_MS)).toBe(false);
    expect(isSocketStale(0, WS_STALE_MS + 1)).toBe(true);
  });

  test("설정 주소에 프로젝트가 들어간다", () => {
    expect(routeHash({ projectId: "p_1", tab: "inbox", settings: true })).toBe("#/settings");
    expect(parseHash("#/settings/p_1")).toMatchObject({ projectId: "p_1", settings: true });
    expect(parseHash("#/settings")).toMatchObject({ projectId: "hq", settings: true });
  });
});

describe("표 해석 상한", () => {
  test("넓은 첫 줄 + 많은 행(1MB 이하)에서 행 × 열 만큼 메모리가 늘지 않는다", () => {
    const text = `${",".repeat(300_000)}\n${"a\n".repeat(340_000)}`;
    const started = performance.now();
    const t = parseDelimited(text);
    for (let c = 0; c < t.header.length; c++) isNumericColumn(t.rows, c);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(t.header).toHaveLength(TABLE_COLUMN_LIMIT);
    expect(t.hiddenColumns).toBe(300_001 - TABLE_COLUMN_LIMIT);
    expect(t.rows).toHaveLength(340_000);
    expect(t.rows[0]).toEqual(["a"]);
  });

  test("쉼표 100만 개 한 줄도 상한까지만 읽는다", () => {
    const t = parseDelimited(",".repeat(1_000_000));
    expect(t.header).toHaveLength(TABLE_COLUMN_LIMIT);
    expect(t.hiddenColumns).toBe(1_000_001 - TABLE_COLUMN_LIMIT);
  });

  test("상한 안이면 그대로다", () => {
    expect(parseDelimited("a,b\n1\n1,2,3")).toEqual({ header: ["a", "b", ""], rows: [["1"], ["1", "2", "3"]] });
  });
});
