// 0.2.11: CLI 새 판 알림의 iPhone 푸시(kind cli_update). 판마다 한 번, 기기의 알림 켜기만 따른다(종류별 설정 칸 없음).
// 문구는 종류별 틀에 CLI 이름과 판만 넣는다(대화 내용은 싣지 않는다). target 은 {screen:"home", cli, version} 세 열쇠.
// Mac 이 직접 보낼 때와 알림 중계가 만들 때 바이트까지 같다(relay/functions 는 같은 buildAPNsPayload 를 쓴다).
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { APNS_TTL_MS, buildAPNsPayload, serializeAPNsPayload, type APNsNotification } from "../server/push/apns.ts";
import { relayPushBody } from "../server/push/relay.ts";
import { PushStore } from "../server/push/store.ts";
import { Store } from "../server/store.ts";
import { parsePushRequest } from "../relay/functions/src/push-request.ts";
import { DEFAULT_PUSH_BUNDLE_ID, pushPreferenceOf } from "../shared/push.ts";

const cleanups: (() => unknown)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function notification(target: Record<string, unknown>, lang?: "ko" | "en"): APNsNotification {
  const now = Date.now();
  return { environment: "sandbox", deviceToken: "ab", deliveryId: randomUUID(), eventId: randomUUID(), serverId: randomUUID(), kind: "cli_update",
    target: target as APNsNotification["target"], occurredAt: new Date(now).toISOString(), expiresAt: new Date(now + APNS_TTL_MS.cli_update).toISOString(), ...(lang ? { lang } : {}) };
}

describe("cli_update 알림 글", () => {
  test("CLI 이름과 판만 넣은 한 줄(한국어·영어). 누르면 첫 화면, target 은 세 열쇠 그대로", () => {
    const ko = buildAPNsPayload(notification({ screen: "home", cli: "claude", version: "2.1.332" }));
    expect(ko.aps.alert).toEqual({ title: "IAMCEO", body: "Claude Code 2.1.332 업데이트가 있습니다." });
    expect(ko.iamceo).toMatchObject({ kind: "cli_update", target: { screen: "home", cli: "claude", version: "2.1.332" } });
    expect(Object.keys(ko.iamceo.target).sort()).toEqual(["cli", "screen", "version"]);
    const en = buildAPNsPayload(notification({ screen: "home", cli: "gemini", version: "1.5.17" }, "en"));
    expect(en.aps.alert.body).toBe("Antigravity CLI 1.5.17 update is available.");
    expect(buildAPNsPayload(notification({ screen: "home", cli: "codex", version: "0.172.0" })).aps.alert.body).toBe("Codex 0.172.0 업데이트가 있습니다.");
  });
  test("모르는 CLI·판 같지 않은 값·다른 화면·더 붙은 열쇠는 만들지 않는다", () => {
    for (const target of [{ screen: "home", cli: "other", version: "1.0.0" }, { screen: "home", cli: "claude", version: "2.1" },
      { screen: "home", cli: "claude", version: "2.1.332 <b>" }, { screen: "team", cli: "claude", version: "2.1.332" }, { screen: "home" },
      { screen: "home", cli: "claude", version: "2.1.332", projectId: "p_1" }]) {
      expect(() => buildAPNsPayload(notification(target))).toThrow("invalid_payload");
    }
  });
  test("기기의 종류별 설정과 상관없이(알림을 켠 기기면) 보낸다", () => {
    expect(pushPreferenceOf("cli_update")).toBeNull();
  });
});

describe("cli_update 사건", () => {
  function boot() {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-cli-update-push-")));
    const store = new Store(openDb(join(home, "db.sqlite")), new Bus());
    cleanups.push(() => store.db.close());
    const providers = () => [{ environment: "sandbox" as const, bundleId: DEFAULT_PUSH_BUNDLE_ID, state: "ready" as const, lastError: null }];
    const push = new PushStore(store.db, { providers });
    const device = (preferences: Record<string, boolean> = {}) => {
      const value = push.registerDevice(randomUUID(), { expectedRevision: null, platform: "ios", bundleId: DEFAULT_PUSH_BUNDLE_ID, environment: "sandbox", deviceToken: "ab", authorization: "authorized" });
      return push.patchDevice(value.id, { expectedRevision: value.revision, enabled: true, ...(Object.keys(preferences).length ? { preferences } : {}) });
    };
    return { push, device };
  }
  test("판마다 한 번 남고(같은 sourceKey 는 하나), 실행 문제 알림을 끈 기기에도 간다. 거두면 나가지 않는다", () => {
    const { push, device } = boot();
    const quiet = device({ error: false, decision: false, approval_wait: false, report_complete: false, todo_created: false, report_blocked: false });
    const input = { sourceKey: "cli-update:claude:2.1.332", kind: "cli_update" as const, projectId: null, memberId: null,
      target: { screen: "home" as const, cli: "claude" as const, version: "2.1.332" }, occurredAt: push.timestamp() };
    const event = push.recordEvent(input);
    expect(push.recordEvent(input).id).toBe(event.id);
    expect(event).toMatchObject({ kind: "cli_update", target: { screen: "home", cli: "claude", version: "2.1.332" } });
    expect(push.listDeliveries(event.id).map(d => [d.deviceId, d.state])).toEqual([[quiet.id, "queued"]]);
    push.cancelSource("cli-update:claude:2.1.332");
    expect(push.listDeliveries(event.id).map(d => d.state)).toEqual(["cancelled"]);
  });
  test("알림 중계가 받아 같은 바이트로 만든다", () => {
    const n = notification({ screen: "home", cli: "claude", version: "2.1.332" }, "en");
    const parsed = parsePushRequest(JSON.stringify({ ...relayPushBody({ ...n, environment: "production" }), environment: "production" }), Date.now());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.payload).toBe(serializeAPNsPayload(buildAPNsPayload({ ...n, environment: "production" })));
  });
});
