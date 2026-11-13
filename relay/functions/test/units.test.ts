// 작은 부품: 설치 자격, 한도·IP 묶음, 요청 검사와 페이로드(Mac 직접 보내기와 바이트까지 같음).
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { APNS_TTL_MS, buildAPNsPayload, serializeAPNsPayload } from "../../../server/push/apns.ts";
import type { APNsNotification } from "../../../server/push/apns.ts";
import { createInstallation, installationSecret, validMaster, verifyAuthorization } from "../src/credentials.ts";
import { RelayLimits, clientIp, forwardedFor, ipBucket } from "../src/limits.ts";
import { parsePushRequest } from "../src/push-request.ts";
import { MASTER, SERVER_ID, TOKEN, pushBody } from "./helpers.ts";

describe("설치 자격(무상태 HMAC)", () => {
  test("만든 자격은 같은 master 로만 맞는다", () => {
    const { installationId, secret } = createInstallation(MASTER);
    expect(installationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Mac(server/push/relay.ts)이 받는 모양: ID ^[A-Za-z0-9_-]{8,200}$, secret ^[A-Za-z0-9_-]{16,512}$
    expect(installationId).toMatch(/^[A-Za-z0-9_-]{8,200}$/);
    expect(verifyAuthorization(MASTER, `Bearer ${installationId}.${secret}`)).toBe(installationId);
    expect(verifyAuthorization(`${MASTER}-rotated`, `Bearer ${installationId}.${secret}`)).toBeNull();
    expect(installationSecret(MASTER, installationId)).toBe(secret);
  });
  test("틀린 머리글은 모두 거절", () => {
    const { installationId, secret } = createInstallation(MASTER);
    const other = createInstallation(MASTER);
    for (const value of [undefined, "", secret, `bearer ${installationId}.${secret}`, `Bearer ${installationId}.${other.secret}`,
      `Bearer ${other.installationId}.${secret}`, `Bearer ${installationId}.${secret}x`, `Bearer ${installationId.toUpperCase()}.${secret}`,
      `Bearer ${installationId}.${secret.slice(0, -1)}A`, `Bearer  ${installationId}.${secret}`, `Bearer ${installationId}.${secret} `]) {
      expect(verifyAuthorization(MASTER, value)).toBeNull();
    }
  });
  test("master 는 32자 이상", () => {
    expect(validMaster(undefined)).toBe(false);
    expect(validMaster("short")).toBe(false);
    expect(validMaster(" ".repeat(40))).toBe(false);
    expect(validMaster(MASTER)).toBe(true);
  });
});

describe("IP 묶음과 손님 IP", () => {
  test("IPv4 는 주소, IPv6 는 /64, IPv4 를 담은 IPv6 는 IPv4", () => {
    expect(ipBucket("203.0.113.7")).toBe("4:203.0.113.7");
    expect(ipBucket("203.0.113.7:5123")).toBe("4:203.0.113.7");
    expect(ipBucket("::ffff:203.0.113.7")).toBe("4:203.0.113.7");
    expect(ipBucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("6:2001:db8:1:2");
    expect(ipBucket("2001:db8:1:2::1")).toBe(ipBucket("2001:0db8:0001:0002:ffff:0:0:9"));
    expect(ipBucket("[2001:db8::1]:443")).toBe("6:2001:db8:0:0");
    expect(ipBucket("fe80::1%en0")).toBe("6:fe80:0:0:0");
    expect(ipBucket("::")).toBe("6:0:0:0:0");
    for (const bad of [undefined, "", "unknown", "1.2.3", "2001:db8:::1", "1:2:3:4:5:6:7:8:9", "g::1"]) expect(ipBucket(bad)).toBeNull();
  });
  test("손님 IP 는 Google 앞단이 X-Forwarded-For 끝에 붙인 값만. 보낸 쪽이 넣은 앞쪽 값과 Fastly-Client-IP 는 보지 않는다", () => {
    expect(clientIp({ "x-forwarded-for": "198.51.100.4" })).toBe("198.51.100.4");
    // 꾸민 값은 앞에 남고, 앞단이 붙인 실제 값은 맨 끝에 온다.
    expect(clientIp({ "x-forwarded-for": "9.9.9.9, 198.51.100.4" })).toBe("198.51.100.4");
    expect(clientIp({ "x-forwarded-for": ["9.9.9.9", "198.51.100.4"] })).toBe("198.51.100.4");
    expect(clientIp({ "fastly-client-ip": "8.8.4.4", "x-forwarded-for": "198.51.100.4" })).toBe("198.51.100.4");
    expect(clientIp({ "fastly-client-ip": "8.8.4.4" })).toBeUndefined();
    // 끝에서 둘째(앞단이 두 값을 붙이는 경우의 설정): 값이 모자라면 꾸민 값을 고르지 않고 건너뛴다.
    expect(clientIp({ "x-forwarded-for": "9.9.9.9, 198.51.100.4, 35.191.0.1" }, 2)).toBe("198.51.100.4");
    expect(clientIp({ "x-forwarded-for": "198.51.100.4" }, 2)).toBeUndefined();
    // 머리글이 없거나 비었거나 알아볼 수 없으면 IP 한도를 건너뛴다(연결 주소는 Google 안쪽 주소라 쓰지 않는다).
    expect(clientIp({})).toBeUndefined();
    expect(clientIp({ "x-forwarded-for": "" })).toBeUndefined();
    expect(clientIp({ "x-forwarded-for": "198.51.100.4, unknown" })).toBeUndefined();
    expect(forwardedFor({ "x-forwarded-for": " 1.1.1.1 ,, 2.2.2.2 " })).toEqual(["1.1.1.1", "2.2.2.2"]);
  });
});

describe("한도(메모리)", () => {
  const day = Date.UTC(2026, 10, 13, 12, 0, 0);
  test("설치 분·날, 토큰 날, 인스턴스 전체 분", () => {
    const limits = new RelayLimits({ installationPerMinute: 3, installationPerDay: 5, tokenPerDay: 4, sendsPerMinute: 100 });
    for (let i = 0; i < 3; i++) expect(limits.allowSend("i1", TOKEN, day).ok).toBe(true);
    expect(limits.allowSend("i1", TOKEN, day)).toEqual({ ok: false, scope: "installation", retryAt: day + 60_000 });
    // 다음 분: 날 한도(5)까지 두 건 더. 토큰 한도(4)가 먼저 찬다.
    expect(limits.allowSend("i1", TOKEN, day + 60_000).ok).toBe(true);
    expect(limits.allowSend("i1", TOKEN, day + 60_000)).toEqual({ ok: false, scope: "token", retryAt: Date.UTC(2026, 10, 14) });
    // 같은 iPhone 을 다른 Mac 이 보내도 토큰 한도는 같다(한 iPhone 이 Mac 여러 대에 등록된다).
    expect(limits.allowSend("i2", TOKEN.toUpperCase(), day + 60_000)).toMatchObject({ ok: false, scope: "token" });
    expect(limits.allowSend("i2", "b2".repeat(32), day + 60_000).ok).toBe(true);
    // 날이 바뀌면 토큰 표와 HMAC 열쇠를 새로 만든다.
    expect(limits.allowSend("i3", TOKEN, Date.UTC(2026, 10, 14, 0, 0, 1)).ok).toBe(true);
    const global = new RelayLimits({ sendsPerMinute: 2 });
    expect(global.allowSend("a", TOKEN, day).ok).toBe(true);
    expect(global.allowSend("b", "b2".repeat(32), day).ok).toBe(true);
    expect(global.allowSend("c", "c3".repeat(32), day)).toMatchObject({ ok: false, scope: "global" });
  });
  test("설치 만들기: IP(/64)별 날, 전체 시간. IP 를 모르면 IP 한도는 건너뛴다", () => {
    const limits = new RelayLimits({ createPerIpPerDay: 2, createPerHour: 5 });
    expect(limits.allowCreate("2001:db8:1:2::1", day).ok).toBe(true);
    expect(limits.allowCreate("2001:db8:1:2::ffff", day).ok).toBe(true);
    expect(limits.allowCreate("2001:db8:1:2:abcd::9", day)).toEqual({ ok: false, scope: "ip", retryAt: Date.UTC(2026, 10, 14) });
    expect(limits.allowCreate("2001:db8:1:3::1", day).ok).toBe(true);
    expect(limits.allowCreate(undefined, day).ok).toBe(true);
    expect(limits.allowCreate("not-an-ip", day).ok).toBe(true);
    expect(limits.allowCreate(undefined, day)).toEqual({ ok: false, scope: "global", retryAt: Date.UTC(2026, 10, 13, 13) });
  });
  test("전체 시간 한도에 막힌 요청은 IP 몫을 쓰지 않는다(다시 시도하는 정상 Mac 이 그날 끝까지 잠기지 않는다)", () => {
    const limits = new RelayLimits({ createPerIpPerDay: 2, createPerHour: 1 });
    expect(limits.allowCreate("203.0.113.50", day).ok).toBe(true);
    for (let i = 0; i < 10; i++) expect(limits.allowCreate("203.0.113.51", day)).toMatchObject({ ok: false, scope: "global" });
    // 다음 시간: 막힌 동안 열 번 시도했어도 IP 몫(하루 2)은 그대로다.
    expect(limits.allowCreate("203.0.113.51", day + 3_600_000).ok).toBe(true);
    expect(limits.allowCreate("203.0.113.51", day + 7_200_000).ok).toBe(true);
    expect(limits.allowCreate("203.0.113.51", day + 10_800_000)).toMatchObject({ ok: false, scope: "ip" });
    // IP 몫이 끝난 요청은 전체 시간 한도도 쓰지 않는다.
    const hourly = new RelayLimits({ createPerIpPerDay: 1, createPerHour: 2 });
    expect(hourly.allowCreate("203.0.113.60", day).ok).toBe(true);
    for (let i = 0; i < 5; i++) expect(hourly.allowCreate("203.0.113.60", day)).toMatchObject({ ok: false, scope: "ip" });
    expect(hourly.allowCreate("203.0.113.61", day).ok).toBe(true);
  });
  test("IP 표가 차면 IP 한도를 건너뛴다: 꾸민 IP 로 표를 채워도 처음 보는 정상 IP 가 등록된다(전체 한도는 그대로)", () => {
    const limits = new RelayLimits({ maxEntries: 3, createPerIpPerDay: 1, createPerHour: 6 });
    for (const ip of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) expect(limits.allowCreate(ip, day).ok).toBe(true);
    expect(limits.allowCreate("198.51.100.200", day).ok).toBe(true);
    // 표에 든 IP 의 한도는 그대로 지킨다.
    expect(limits.allowCreate("192.0.2.1", day)).toMatchObject({ ok: false, scope: "ip" });
    expect(limits.allowCreate("198.51.100.201", day).ok).toBe(true);
    expect(limits.allowCreate("198.51.100.202", day).ok).toBe(true);
    expect(limits.allowCreate("198.51.100.203", day)).toMatchObject({ ok: false, scope: "global" });
  });
  test("오류 예산: 한 시간에 넘으면 정지, 시간이 지나면 풀린다", () => {
    const limits = new RelayLimits({ errorBudget: 3, errorWindowMs: 3_600_000, errorSuspendMs: 86_400_000 });
    for (let i = 0; i < 3; i++) expect(limits.recordTokenError("i1", day + i)).toBeUndefined();
    expect(limits.recordTokenError("i1", day + 10)).toBe(day + 10 + 86_400_000);
    expect(limits.suspendedUntil("i1", day + 11)).toBe(day + 10 + 86_400_000);
    expect(limits.suspendedUntil("i2", day + 11)).toBeUndefined();
    expect(limits.suspendedUntil("i1", day + 10 + 86_400_000)).toBeUndefined();
    // 한 시간이 지난 오류는 세지 않는다.
    const spread = new RelayLimits({ errorBudget: 2 });
    for (let i = 0; i < 6; i++) expect(spread.recordTokenError("i1", day + i * 3_600_001)).toBeUndefined();
  });
  test("표가 차면 지난 항목을 지우고, 그래도 차 있으면 거절(닫는 쪽)", () => {
    const limits = new RelayLimits({ maxEntries: 2, installationPerMinute: 10 });
    expect(limits.allowSend("a", TOKEN, day).ok).toBe(true);
    expect(limits.allowSend("b", TOKEN, day).ok).toBe(true);
    expect(limits.allowSend("c", TOKEN, day).ok).toBe(false);
    // 분 표는 다음 분에 비지만 날 표는 그날 내내 차 있다. 다음 날에는 지난 항목을 지우고 받는다.
    expect(limits.allowSend("c", TOKEN, day + 60_000).ok).toBe(false);
    expect(limits.allowSend("c", TOKEN, day + 86_400_000).ok).toBe(true);
  });
});

function direct(body: Record<string, unknown>, now: number): string {
  const notification: APNsNotification = { environment: "production", deviceToken: String(body.token), deliveryId: String(body.id),
    eventId: String(body.eventId), serverId: String(body.serverId), kind: body.kind as APNsNotification["kind"],
    target: body.target as APNsNotification["target"], occurredAt: new Date(now).toISOString(), expiresAt: String(body.expiresAt),
    reportSummary: body.summary === true };
  return serializeAPNsPayload(buildAPNsPayload(notification));
}

describe("요청 검사와 페이로드", () => {
  const now = Date.UTC(2026, 10, 13, 12, 0, 0);
  const expiresAt = new Date(now + 4 * 60_000).toISOString(); // 가장 짧은 보관 시간(test 5분)보다 짧게
  const cases: Record<string, unknown>[] = [
    { kind: "test", target: { screen: "home" } },
    { kind: "decision", target: { screen: "inbox", projectId: "hq", decisionId: "d_1" } },
    { kind: "approval_wait", target: { screen: "team", projectId: "p_1", memberId: "m_1" } },
    { kind: "error", target: { screen: "team", projectId: "p_1", memberId: "m_1" } },
    { kind: "report_complete", target: { screen: "chat", projectId: "p_1", memberId: "m_1", messageId: "msg_1", groupId: randomUUID() }, summary: true },
    { kind: "report_complete", target: { screen: "chat", projectId: "p_1", memberId: null, messageId: "msg_1" } },
    { kind: "report_blocked", target: { screen: "chat", projectId: "p_1", memberId: "m_1", messageId: "msg_2" } },
    { kind: "todo_created", target: { screen: "home", projectId: "p_1" } },
  ];
  for (const item of cases) {
    test(`${item.kind}${item.summary ? "(묶음)" : ""}: Mac 직접 보내기와 같은 바이트, 출시 앱이 읽는 키 그대로`, () => {
      const body = pushBody({ ...item, expiresAt });
      const parsed = parsePushRequest(JSON.stringify(body), now);
      if (!parsed.ok) throw new Error(parsed.reason);
      expect(parsed.value.payload).toBe(direct(body, now));
      const payload = JSON.parse(parsed.value.payload);
      expect(Object.keys(payload).sort()).toEqual(["aps", "iamceo"]);
      expect(Object.keys(payload.iamceo).sort()).toEqual(["eventId", "kind", "serverId", "target", "v"]);
      expect(payload.iamceo.v).toBe(1);
      expect(payload.aps.alert.title).toBe("IAMCEO");
      expect(payload.aps["thread-id"]).toBe(`iamceo:${SERVER_ID}`);
      expect(parsed.value.expiresAt).toBe(Date.parse(expiresAt));
      expect(Buffer.byteLength(parsed.value.payload)).toBeLessThanOrEqual(4096);
    });
  }
  test("문구·제목·모르는 필드는 버린다(허용 목록으로 다시 만든다)", () => {
    const body = pushBody({ expiresAt, body: "접속 코드를 다시 입력하세요", title: "Apple", aps: { alert: "x" }, sound: "evil.caf", extra: 1,
      target: { screen: "inbox", projectId: "p_1", decisionId: "d_1" } });
    const parsed = parsePushRequest(JSON.stringify(body), now);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.value.payload).not.toContain("접속 코드");
    expect(parsed.value.payload).not.toContain("evil");
    expect(JSON.parse(parsed.value.payload).aps.alert.body).toBe("새 결재가 도착했습니다.");
  });
  test("유효 시각: 없으면 종류별 최대, 길면 줄이고, 지났으면 expired", () => {
    const missing = parsePushRequest(JSON.stringify(pushBody({ expiresAt: undefined, kind: "error", target: { screen: "team", projectId: "p", memberId: "m" } })), now);
    expect(missing.ok && missing.value.expiresAt).toBe(now + APNS_TTL_MS.error);
    const long = parsePushRequest(JSON.stringify(pushBody({ expiresAt: new Date(now + 5 * 3_600_000).toISOString() })), now);
    expect(long.ok && long.value.expiresAt).toBe(now + APNS_TTL_MS.decision);
    expect(parsePushRequest(JSON.stringify(pushBody({ expiresAt: new Date(now).toISOString() })), now)).toEqual({ ok: false, reason: "expired" });
    expect(parsePushRequest(JSON.stringify(pushBody({ expiresAt: "내일" })), now)).toEqual({ ok: false, reason: "invalid_request" });
  });
  test("틀린 요청은 invalid_request", () => {
    const bad: Record<string, unknown>[] = [
      { token: "xyz" }, { token: "abc" }, { token: "" }, { token: "a".repeat(1026) }, { token: 123 },
      { kind: "marketing" }, { kind: undefined }, { id: "not-uuid" }, { eventId: "x" }, { serverId: "hq" },
      { environment: "sandbox" }, { summary: "yes" }, { expiresAt: 123 },
      { target: { screen: "team", projectId: "p", memberId: "m" } }, // 종류와 화면이 어긋남
      { target: { screen: "inbox", projectId: 12345, decisionId: "d" } }, // 숫자를 문자열처럼 통과시키지 않는다
      { target: { screen: "inbox", projectId: "p", decisionId: "d", note: "x" } },
      { target: { screen: "inbox", projectId: "p/../x", decisionId: "d" } },
      { target: "inbox" }, { target: null },
    ];
    for (const override of bad) expect(parsePushRequest(JSON.stringify(pushBody({ expiresAt, ...override })), now).ok).toBe(false);
    for (const raw of ["", "null", "[]", "{", "\"x\""]) expect(parsePushRequest(raw, now)).toEqual({ ok: false, reason: "invalid_request" });
  });
  test("토큰은 소문자로, environment 는 production 만", () => {
    const parsed = parsePushRequest(JSON.stringify(pushBody({ expiresAt, token: "AB".repeat(32), environment: "production" })), now);
    expect(parsed.ok && parsed.value.token).toBe("ab".repeat(32));
  });
});
