// 1차 작업(서버): 100.64.0.0/10 대역이라고 Tailscale 로 가정하지 않고 실제로 확인한다.
import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_VERSION, detectTailscaleIp, isTailscaleV4, isTailscaleV6, probeTailscale } from "../server/config.ts";
import { buildIpRule, isIpAllowed, listensOnTailnet } from "../server/http.ts";

const v4 = (address: string) => ({ address, family: "IPv4" });
const v6 = (address: string) => ({ address, family: "IPv6" });
const never = () => { throw new Error("tailscale 명령을 부르면 안 되는 경우다"); };

describe("Tailscale 주소 확인", () => {
  test("터널 인터페이스에 Tailscale 의 두 주소가 같이 있으면 명령 없이 확인한다(Mac App Store 판 포함)", () => {
    const probe = probeTailscale({ interfaces: () => ({ lo0: [v4("127.0.0.1")], en0: [v4("192.168.0.4")], utun5: [v4("100.92.10.20"), v6("fd7a:115c:a1e0::1234")] }), cliAddresses: never });
    expect(probe).toEqual({ ip: "100.92.10.20", via: "interface", unverified: [], reason: null });
  });

  test("이름이 tailscale 로 시작하는 인터페이스(Linux)는 그대로 확인한다", () => {
    expect(probeTailscale({ interfaces: () => ({ tailscale0: [v4("100.101.102.103")] }), cliAddresses: never })).toMatchObject({ ip: "100.101.102.103", via: "interface" });
  });

  test("통신사·공유기가 준 같은 대역 주소는 Tailscale 로 보지 않는다", () => {
    const cgnat = { en0: [v4("100.64.3.9")] };
    expect(probeTailscale({ interfaces: () => cgnat, cliAddresses: () => null })).toEqual({ ip: null, via: null, unverified: ["100.64.3.9"], reason: "Tailscale 인터페이스로 확인되지 않고 tailscale 명령도 답하지 않습니다" });
    // 같은 망의 누군가가 Tailscale 대역의 IPv6 를 광고해 붙게 해도, 터널 인터페이스가 아니면 믿지 않는다.
    expect(probeTailscale({ interfaces: () => ({ en0: [v4("100.64.3.9"), v6("fd7a:115c:a1e0::bad")] }), cliAddresses: () => null }).ip).toBeNull();
    // tailscale 명령이 다른 주소를 알려 주면 그 주소가 아니므로 열지 않는다.
    expect(probeTailscale({ interfaces: () => cgnat, cliAddresses: () => ["100.92.10.20"] })).toMatchObject({ ip: null, unverified: ["100.64.3.9"], reason: "tailscale 명령이 알려 준 주소와 다릅니다" });
  });

  test("인터페이스로 확인되지 않으면 tailscale 명령의 답으로 확인한다", () => {
    // IPv6 를 끈 tailnet: 터널 인터페이스에 100.x 주소만 있다.
    const table = { utun3: [v4("100.92.10.20")] };
    expect(probeTailscale({ interfaces: () => table, cliAddresses: () => ["100.92.10.20"] })).toEqual({ ip: "100.92.10.20", via: "cli", unverified: [], reason: null });
    expect(probeTailscale({ interfaces: () => table, cliAddresses: () => null }).ip).toBeNull();
    // 다른 터널 프로그램이 같은 대역을 쓰는 경우.
    expect(probeTailscale({ interfaces: () => table, cliAddresses: () => ["100.70.1.1"] }).ip).toBeNull();
  });

  test("둘이 같이 있으면 확인된 주소만 고르고 나머지는 열지 않을 주소로 남긴다", () => {
    const probe = probeTailscale({ interfaces: () => ({ en0: [v4("100.64.3.9")], utun5: [v4("100.92.10.20"), v6("fd7a:115c:a1e0::1")] }), cliAddresses: never });
    expect(probe).toEqual({ ip: "100.92.10.20", via: "interface", unverified: ["100.64.3.9"], reason: null });
  });

  test("그 대역의 주소가 없으면 명령을 부르지 않는다", () => {
    expect(probeTailscale({ interfaces: () => ({ lo0: [v4("127.0.0.1")], en0: [v4("192.168.0.4"), v4("100.63.255.255"), v4("100.128.0.1")] }), cliAddresses: never })).toEqual({ ip: null, via: null, unverified: [], reason: null });
  });

  test("확인하지 못한 주소는 돌려주지 않고 까닭을 주소마다 한 번만 로그에 남긴다", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const deps = { interfaces: () => ({ en7: [v4("100.64.77.7")] }), cliAddresses: () => null };
      expect(detectTailscaleIp(deps)).toBeNull();
      expect(detectTailscaleIp(deps)).toBeNull();
      const lines = warn.mock.calls.map(call => String(call[0])).filter(line => line.includes("100.64.77.7"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("열지 않습니다");
      expect(detectTailscaleIp({ interfaces: () => ({ utun9: [v4("100.92.10.20"), v6("fd7a:115c:a1e0::1")] }), cliAddresses: never })).toBe("100.92.10.20");
    } finally { warn.mockRestore(); }
  });

  test("대역 판정 함수는 대역만 본다", () => {
    expect(["100.64.0.0", "100.127.255.255", "100.63.255.255", "100.128.0.0", "garbage"].map(isTailscaleV4)).toEqual([true, true, false, false, false]);
    expect(["fd7a:115c:a1e0::1", "FD7A:115C:A1E0:ab12::9", "fd7a:115c:a1e1::1", "::1"].map(isTailscaleV6)).toEqual([true, true, false, false]);
  });
});

describe("상대 주소 허용", () => {
  test("Tailscale 대역의 상대는 이 서버가 Tailscale 주소에서 듣고 있을 때만 받는다", () => {
    expect(listensOnTailnet(["127.0.0.1"])).toBe(false);
    expect(listensOnTailnet(["127.0.0.1", "192.168.0.4", "0.0.0.0"])).toBe(false);
    expect(listensOnTailnet(["127.0.0.1", "100.92.10.20"])).toBe(true);
    expect(listensOnTailnet(["fd7a:115c:a1e0::1"])).toBe(true);
    const local = buildIpRule(["127.0.0.1", "192.168.7.10"]);
    expect(local.tailnet).toBe(false);
    for (const peer of ["100.64.3.10", "100.92.10.99", "fd7a:115c:a1e0::77"]) expect([peer, isIpAllowed(peer, local)]).toEqual([peer, false]);
    expect(isIpAllowed("192.168.7.99", local)).toBe(true);
    const tailnet = buildIpRule(["127.0.0.1", "100.92.10.20"]);
    for (const peer of ["100.64.3.10", "100.92.10.99", "fd7a:115c:a1e0::77", "127.0.0.1"]) expect([peer, isIpAllowed(peer, tailnet)]).toEqual([peer, true]);
    expect(isIpAllowed("192.168.7.99", tailnet)).toBe(false);
  });
});

describe("실행 엔진 고정 버전", () => {
  test("버전은 release-lock.json 한 곳에서 읽고 서버 코드에 따로 적지 않는다", () => {
    const root = join(import.meta.dir, "..");
    const lock = JSON.parse(readFileSync(join(root, "vendor", "herdr-core", "release-lock.json"), "utf8")) as { version: string };
    expect(CORE_VERSION).toBe(lock.version);
    for (const file of ["server/config.ts", "server/orchestrator.ts", "server/runner/core.ts", "server/core-supervisor.ts"]) {
      expect([file, readFileSync(join(root, file), "utf8").includes(lock.version)]).toEqual([file, false]);
    }
  });
});
