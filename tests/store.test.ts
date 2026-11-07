import { afterEach, describe, expect, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import type { WsEvent } from "../shared/types.ts";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.db.close(); });

function fixture() {
  const bus = new Bus();
  const store = new Store(openDb(":memory:"), bus);
  stores.push(store);
  const project = store.createProject({ name: "활동 시험", cwd: "/fixture" });
  const member = store.createMember({ projectId: project.id, handle: "worker", name: "직원", kind: "worker", sessionId: "session", paneId: "pane" });
  // 같은 밀리초에 갱신되어도 updatedAt 회귀를 놓치지 않는다.
  store.db.query("UPDATE members SET updated_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", member.id);
  const events: WsEvent[] = [];
  bus.subscribe(event => events.push(event));
  return { store, project, member: store.requireMember(member.id), events };
}

describe("Member.lastActiveAt", () => {
  for (const kind of ["turn_start", "turn_end", "tool", "tool_result"] as const) {
    test(`${kind} updates only the activity timestamp and preserves existing activity notifications`, () => {
      const { store, member, events } = fixture();
      expect(member.lastActiveAt).toBeNull();
      const revision = store.memberRevisions(member.id);
      const activity = store.appendActivity(member.id, kind, "실제 작업");
      expect(store.requireMember(member.id)).toMatchObject({ lastActiveAt: activity.at, updatedAt: member.updatedAt });
      expect(store.memberRevisions(member.id)).toEqual(revision);
      expect(events).toEqual([{ type: "activity", projectId: member.projectId, activity }]);
    });
  }

  for (const kind of ["system", "error", "text", "compact"] as const) {
    test(`${kind} never counts as CLI work`, () => {
      const { store, member } = fixture();
      store.appendActivity(member.id, kind, "기록만");
      expect(store.requireMember(member.id).lastActiveAt).toBeNull();
      const active = store.appendActivity(member.id, "tool", "작업");
      store.appendActivity(member.id, kind, "이후 기록");
      expect(store.requireMember(member.id)).toMatchObject({ lastActiveAt: active.at, updatedAt: member.updatedAt });
    });
  }

  test("100 tools add no member/project notifications; the next normal member event includes the value", () => {
    const { store, member, events } = fixture();
    for (let i = 0; i < 100; i++) store.appendActivity(member.id, i % 2 ? "tool" : "tool_result", `작업 ${i}`);
    expect(events).toHaveLength(100);
    expect(events.every(event => event.type === "activity")).toBe(true);
    expect(store.requireMember(member.id).updatedAt).toBe(member.updatedAt);
    const lastActiveAt = store.listActivity(member.id).at(-1)!.at;
    const patched = store.patchMember(member.id, { status: "asleep" });
    expect(patched.lastActiveAt).toBe(lastActiveAt);
    expect(events.filter(event => event.type === "member")).toEqual([{ type: "member", member: patched }]);
  });

  test("all member lookups and project state serialize the cached value without consulting activity", () => {
    const { store, project, member } = fixture();
    const lead = store.createMember({ projectId: project.id, handle: "lead", name: "총괄", kind: "conductor" });
    expect(lead.lastActiveAt).toBeNull();
    const leadActivity = store.appendActivity(lead.id, "turn_end", "총괄 작업");
    const activity = store.appendActivity(member.id, "turn_start", "작업 시작");
    store.db.exec("DROP TABLE activity");
    const results = [store.getMember(member.id), store.getMemberByHandle(project.id, member.handle),
      store.findMember(project.id, member.name), store.getMemberBySession("session"), store.getMemberByPane("pane"),
      store.getMemberByToken(store.getMemberToken(member.id)), store.listMembers(project.id)[0],
      store.listAllMembers().find(m => m.id === member.id), store.projectState(project.id).members[0]];
    for (const result of results) expect(result?.lastActiveAt).toBe(activity.at);
    expect(store.getConductor(project.id)?.lastActiveAt).toBe(leadActivity.at);
  });

  test("out-of-order clock and idempotent replay cannot move the latest timestamp", () => {
    const { store, member, events } = fixture();
    const first = store.appendActivity(member.id, "tool", "작업", "unique-tool");
    const future = "2099-01-01T00:00:00.000Z";
    store.db.query("UPDATE members SET last_active_at = ? WHERE id = ?").run(future, member.id);
    expect(store.appendActivity(member.id, "tool", "재시도", "unique-tool")).toEqual(first);
    store.appendActivity(member.id, "turn_end", "작업 끝");
    expect(store.requireMember(member.id).lastActiveAt).toBe(future);
    expect(events).toHaveLength(2);
  });

  test("timestamp, activity and notifications roll back together on an update failure", () => {
    const { store, member, events } = fixture();
    store.db.exec("CREATE TRIGGER reject_active BEFORE UPDATE OF last_active_at ON members BEGIN SELECT RAISE(ABORT, 'reject active'); END");
    expect(() => store.appendActivity(member.id, "tool", "실패")).toThrow("reject active");
    expect(store.listActivity(member.id)).toEqual([]);
    expect(store.requireMember(member.id)).toMatchObject({ lastActiveAt: null, updatedAt: member.updatedAt });
    expect(events).toEqual([]);
  });
});
