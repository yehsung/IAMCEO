// iamceo uninstall · '이 Mac에서 완전히 멈추기'(B5). 가짜 launchctl·가짜 서버 응답·가짜 실행 엔진만 쓴다.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { launchdPlist } from "../bin/iamceo.ts";
import { Bus } from "../server/bus.ts";
import { updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { acquireHomeOwner } from "../server/home-owner.ts";
import { defaultCoreControl, purgeHome, uninstall, type CoreControl, type UninstallDeps } from "../server/lifecycle/uninstall.ts";
import { Store } from "../server/store.ts";

// 이 파일의 단언은 한국어 문구를 본다. bun 은 여러 시험 파일을 한 프로세스에서 돌리므로 끝나면 원래 값으로 돌려 놓는다.
const savedLang = process.env.IAMCEO_LANG;
beforeAll(() => { process.env.IAMCEO_LANG = "ko"; });
afterAll(() => { if (savedLang === undefined) delete process.env.IAMCEO_LANG; else process.env.IAMCEO_LANG = savedLang; });
const entry = resolve(import.meta.dir, "../bin/iamceo.ts");
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture(options: { serviceHome?: string; home?: (root: string) => string; program?: (root: string) => string[] | null; https?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-uninstall-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const userHome = join(root, "user"), home = options.home?.(root) ?? join(userHome, ".iamceo");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...process.env, IAMCEO_HOME: home, IAMCEO_PORT: "47999", IAMCEO_TEST: "1" };
  updateConfigFile({ accessCode: "uninstall-fixture-code", hosts: ["127.0.0.1"] }, env);
  const db = openDb(join(home, "iamceo.db"));
  const store = new Store(db, new Bus());
  store.createProject({ name: "멈출 프로젝트", cwd: root });
  // 대표가 설정에서 켠 HTTPS 주소(tailscale serve)의 기록.
  if (options.https) store.rememberTailnetHttps({ url: "https://sample-mac.tail0000.ts.net", port: 47999, at: "2026-11-13T00:00:00.000Z", home });
  db.close();
  const plistPath = join(userHome, "Library", "LaunchAgents", "com.iamceo.server.plist");
  mkdirSync(dirname(plistPath), { recursive: true });
  // 앱 자리는 시험 폴더 안의 없는 경로다. 이 Mac 에 설치된 실제 앱을 가리키지 않는다.
  const runtime = join(root, "Applications", "IAMCEO.app", "Contents", "Resources", "runtime");
  const program = options.program ? options.program(root) : [join(runtime, "iamceo"), "serve"];
  if (program) writeFileSync(plistPath, launchdPlist({ program, home: userHome, logDir: join(home, "logs"),
    workingDir: userHome, env: { IAMCEO_HOME: options.serviceHome ?? home, IAMCEO_CORE_BIN: join(runtime, "Herdr Core.app", "Contents", "MacOS", "herdr-core") } }));
  let loaded = !!program, serverUp = true, serverOutsideService = false;
  const launchctl: string[] = [];
  const control = (...args: string[]) => {
    launchctl.push(args[0]!);
    if (args[0] === "print") return { ok: loaded, output: "" };
    if (args[0] === "bootout") { loaded = false; if (!serverOutsideService) serverUp = false; return { ok: true, output: "" }; }
    return { ok: false, output: "unexpected" };
  };
  const sleeps: { id: string; body: unknown }[] = [];
  const httpsCalls: unknown[] = [];
  let httpsReply: () => Response = () => Response.json({ state: "off", checkedAt: "2026-11-13T00:00:00.000Z" });
  const members: Record<string, { id: string; name: string; origin: string; status: string }[]> = {
    hq: [{ id: "m_root", name: "본사 AI", origin: "runner", status: "idle" }],
    p1: [
      { id: "m_lead", name: "총괄", origin: "runner", status: "working" },
      { id: "m_manual", name: "직접 띄운 세션", origin: "manual", status: "idle" },
      { id: "m_sleep", name: "잠든 팀장", origin: "runner", status: "asleep" },
      { id: "m_draft", name: "초안 팀장", origin: "runner", status: "idle" },
    ],
  };
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!serverUp) throw new TypeError("Unable to connect. Is the computer able to access the url?");
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/api/health") return json({ ok: true, version: "0.2.3" });
    if (new Headers(init?.headers).get("authorization") !== "Bearer uninstall-fixture-code") return json({ error: "인증이 필요합니다" }, 401);
    if (url.pathname === "/api/bootstrap") return json({ projects: [{ id: "hq" }, { id: "p1" }] });
    if (url.pathname === "/api/tailnet/https" && init?.method === "POST") { httpsCalls.push(JSON.parse(String(init.body))); return httpsReply(); }
    const state = /^\/api\/projects\/([^/]+)\/state$/.exec(url.pathname);
    if (state) return json({ members: members[state[1]!] ?? [] });
    const sleep = /^\/api\/members\/([^/]+)\/sleep$/.exec(url.pathname);
    if (sleep && init?.method === "POST") {
      sleeps.push({ id: sleep[1]!, body: JSON.parse(String(init.body)) });
      return sleep[1] === "m_draft" ? json({ error: "입력칸에 쓰던 글이 있어 잠재울 수 없습니다" }, 409) : json({ id: sleep[1], status: "asleep" });
    }
    return json({ error: "없는 경로입니다" }, 404);
  }) as typeof fetch;
  const core = { answering: true, killed: [] as string[], stopped: 0, listFails: false, stopWorks: true };
  const coreControl: CoreControl = {
    answers: async () => core.answering,
    terminals: async () => {
      if (core.listFails) throw new Error("응답 시간 초과(8000ms)");
      return [{ address: "t1", state: "live", labels: { "iamceo.member": "m_lead" } }, { address: "t2", state: "finished" }, { address: "t3", state: "live" }];
    },
    kill: async address => { core.killed.push(address); },
    stop: async () => { core.stopped++; if (core.stopWorks) core.answering = false; return core.stopWorks; },
  };
  const logs: string[] = [];
  const deps = (extra: Partial<UninstallDeps> = {}): UninstallDeps => ({
    launchctl: control, userHome, uid: 501, env, sleep: async () => {}, log: line => logs.push(line), fetch: fakeFetch, core: coreControl,
    confirm: async () => { throw new Error("확인 없이 진행해야 한다"); }, stopTimeoutMs: 50, ...extra,
  });
  return { root, userHome, home, env, plistPath, launchctl, sleeps, core, logs, deps, httpsCalls,
    setHttpsReply(reply: () => Response) { httpsReply = reply; },
    get loaded() { return loaded; }, downServer() { serverUp = false; }, keepServerOutsideService() { serverOutsideService = true; } };
}

describe("uninstall", () => {
  test("팀장 재우기 → 서비스 해제 → 실행 엔진의 터미널 종료·엔진 종료. 데이터는 남긴다", async () => {
    const f = fixture();
    const outcome = await uninstall({ yes: true }, f.deps());
    // 관리하는 팀장만, 강제로(그래도 재우기) 재운다. 직접 띄운 세션과 이미 잠든 팀장은 건드리지 않는다.
    expect(f.sleeps).toEqual([{ id: "m_root", body: { force: true } }, { id: "m_lead", body: { force: true } }, { id: "m_draft", body: { force: true } }]);
    expect(outcome.members).toEqual({ reachable: true, stopped: 2, failed: ["초안 팀장: 입력칸에 쓰던 글이 있어 잠재울 수 없습니다"] });
    expect(f.launchctl).toContain("bootout");
    expect(f.loaded).toBe(false);
    expect(existsSync(f.plistPath)).toBe(false);
    expect(outcome.service).toBe("removed");
    // 끝나지 않은 터미널만 끝내고 엔진을 끈다.
    expect(f.core.killed).toEqual(["t1", "t3"]);
    expect(f.core.stopped).toBe(1);
    expect(outcome.core).toEqual({ absent: false, killed: 2, stopped: true });
    expect(outcome.purged).toBe(false);
    expect(existsSync(join(f.home, "iamceo.db"))).toBe(true);
    expect(f.logs.join("\n")).toContain("데이터는 그대로 남아 있습니다");
  });

  test("--purge 는 따로 한 번 더 확인하고 지운다. 확인 글이 다르면 지우지 않는다", async () => {
    const f = fixture();
    const asked: string[] = [];
    let answer = "y";
    const confirm = async (question: string, expected: string) => { asked.push(question); const ok = answer === expected; answer = "아니오"; return ok; };
    const kept = await uninstall({ purge: true }, f.deps({ confirm }));
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain("'지우기'");
    expect(kept.purged).toBe(false);
    expect(existsSync(join(f.home, "iamceo.db"))).toBe(true);
    const g = fixture();
    let replies = ["y", "지우기"];
    const removed = await uninstall({ purge: true }, g.deps({ confirm: async (_q, expected) => replies.shift() === expected }));
    expect(removed.purged).toBe(true);
    expect(existsSync(g.home)).toBe(false);
    replies = [];
  });

  describe("켜 둔 HTTPS 주소(tailscale serve, 리뷰 https-2)", () => {
    const DNS = "sample-mac.tail0000.ts.net";
    const RUNNING = { BackendState: "Running", Self: { DNSName: `${DNS}.` }, CertDomains: [DNS] };
    const servedAt = (port: number) => ({ TCP: { "443": { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } } });
    /** 가짜 tailscale: serve 끄기를 적고, 끄면 serve status 를 비운다. */
    function fakeTailscale(serve: unknown, offWorks = true) {
      const calls: string[] = [];
      let current = serve;
      const run = async (args: string[]) => {
        const key = args.join(" ");
        calls.push(key);
        if (key === "status --json") return { code: 0, stdout: JSON.stringify(RUNNING), stderr: "" };
        if (key === "serve status --json") return { code: 0, stdout: JSON.stringify(current), stderr: "" };
        if (key === "serve --https=443 off") { if (!offWorks) return { code: 1, stdout: "", stderr: "denied" }; current = {}; return { code: 0, stdout: "", stderr: "" }; }
        return { code: 1, stdout: "", stderr: `unexpected ${key}` };
      };
      return { run, calls };
    }
    const recordOf = (home: string) => {
      const db = openDb(join(home, "iamceo.db"));
      try { return new Store(db, new Bus()).tailnetHttps(); } finally { db.close(); }
    };

    test("서버가 떠 있으면 서버에게 끄게 하고(팀장 재우기 전), 계획에도 보인다", async () => {
      const f = fixture({ https: true });
      await uninstall({ dryRun: true }, f.deps());
      expect(f.logs.join("\n")).toContain("켜 둔 HTTPS 주소(이 서버가 만든 tailscale serve 설정)를 끄고");
      expect(f.httpsCalls).toEqual([]);
      const outcome = await uninstall({ yes: true }, f.deps());
      expect(f.httpsCalls).toEqual([{ enabled: false }]);
      expect(outcome.tailnetHttps).toBe("off");
      expect(f.logs.join("\n")).toContain("HTTPS 주소(tailscale serve)를 껐습니다");
      expect(f.logs.findIndex(line => line.includes("HTTPS 주소(tailscale serve)를 껐습니다"))).toBeLessThan(f.logs.findIndex(line => line.includes("팀장 2명을 재웠습니다")));
    });

    test("서버가 꺼져 있으면 DB 의 기록으로 이 서버의 설정일 때만 직접 끄고 기록을 지운다. 남의 설정은 건드리지 않는다", async () => {
      const f = fixture({ https: true });
      f.downServer();
      const tailscale = fakeTailscale(servedAt(47999));
      const outcome = await uninstall({ yes: true }, f.deps({ tailscale: tailscale.run }));
      expect(tailscale.calls).toContain("serve --https=443 off");
      expect(outcome.tailnetHttps).toBe("off");
      expect(recordOf(f.home)).toBeNull();

      const g = fixture({ https: true });
      g.downServer();
      const foreign = fakeTailscale(servedAt(3000));
      expect((await uninstall({ yes: true }, g.deps({ tailscale: foreign.run }))).tailnetHttps).toBe("off");
      expect(foreign.calls).not.toContain("serve --https=443 off");
    });

    test("끄지 못하면 남은 명령을 알리고 나머지는 계속한다", async () => {
      const f = fixture({ https: true });
      f.downServer();
      const tailscale = fakeTailscale(servedAt(47999), false);
      const outcome = await uninstall({ yes: true }, f.deps({ tailscale: tailscale.run }));
      expect(outcome.tailnetHttps).toBe("failed");
      expect(f.logs.join("\n")).toContain("tailscale serve --https=443 off 로 끄세요");
      expect(outcome.core.stopped).toBe(true);
      // 서버가 끄지 못했다고 답해도 같다.
      const g = fixture({ https: true });
      g.setHttpsReply(() => Response.json({ state: "pending", url: "https://sample-mac.tail0000.ts.net", problem: { code: "tailnet_https_off_failed", message: "Tailscale의 HTTPS 설정을 지우지 못했습니다" } }));
      const failed = await uninstall({ yes: true }, g.deps());
      expect(failed.tailnetHttps).toBe("failed");
      expect(g.logs.join("\n")).toContain("Tailscale의 HTTPS 설정을 지우지 못했습니다");
    });

    test("켠 기록이 없으면 HTTPS 단계는 없다(서버에도 tailscale 에도 묻지 않는다)", async () => {
      const f = fixture();
      const tailscale = fakeTailscale(servedAt(47999));
      const outcome = await uninstall({ yes: true }, f.deps({ tailscale: tailscale.run }));
      expect(outcome.tailnetHttps).toBe("none");
      expect(f.httpsCalls).toEqual([]);
      expect(tailscale.calls).toEqual([]);
    });
  });

  test("확인을 받지 못하면 아무것도 멈추지 않는다", async () => {
    const f = fixture();
    await expect(uninstall({}, f.deps({ confirm: async () => false }))).rejects.toThrow("멈추지 않았습니다");
    expect(f.sleeps).toEqual([]);
    expect(f.launchctl).not.toContain("bootout");
    expect(f.core.killed).toEqual([]);
  });

  test("다른 데이터 폴더를 쓰는 서비스는 건드리지 않는다", async () => {
    const f = fixture({ serviceHome: "/somewhere/else" });
    f.downServer();
    const outcome = await uninstall({ yes: true }, f.deps());
    expect(outcome.service).toBe("foreign");
    expect(f.launchctl).not.toContain("bootout");
    expect(existsSync(f.plistPath)).toBe(true);
    expect(outcome.members.reachable).toBe(false);
    expect(f.core.killed).toEqual(["t1", "t3"]);
  });

  test("서비스 밖에서 도는 서버가 있으면 실행 엔진을 건드리지 않고 멈춘다(엔진을 끄면 그 서버가 다시 띄운다)", async () => {
    const f = fixture();
    f.keepServerOutsideService();
    await expect(uninstall({ yes: true }, f.deps())).rejects.toThrow("서비스 밖에서 실행 중인 IAMCEO 서버");
    expect(f.core.killed).toEqual([]);
    expect(f.core.stopped).toBe(0);
  });

  // 리뷰 safety-1: 소스 체크아웃에서 도는 서비스(대표 라이브)는 홈이 같아도 '내 것'이 아니다. 앱의 '멈추기'가 그 서비스를 내리면 안 된다.
  test("소스 체크아웃 서비스는 건드리지 않고 아무것도 하지 않는다. --include-checkout 이면 내리되 서비스 설정은 사본으로 남긴다", async () => {
    const live = (root: string) => [join(root, "bun"), join(root, "live", "bin", "iamceo.ts"), "serve"];
    const f = fixture({ program: live });
    await expect(uninstall({ yes: true }, f.deps())).rejects.toThrow("소스 체크아웃에서 도는 서버라 이 명령으로 끄지 않습니다");
    expect(f.sleeps).toEqual([]);
    expect(f.launchctl).not.toContain("bootout");
    expect(existsSync(f.plistPath)).toBe(true);
    expect(f.core.killed).toEqual([]);
    expect(f.core.stopped).toBe(0);
    const preview = await uninstall({ dryRun: true }, { ...f.deps(), launchctl: undefined });
    expect(preview.service).toBe("foreign");
    expect(f.logs.join("\n")).toContain("--include-checkout");

    const g = fixture({ program: live });
    const plist = readFileSync(g.plistPath, "utf8");
    const outcome = await uninstall({ yes: true, includeCheckout: true }, g.deps());
    expect(outcome.service).toBe("removed");
    expect(g.launchctl).toContain("bootout");
    expect(existsSync(g.plistPath)).toBe(false);
    expect(outcome.serviceCopy).toStartWith(join(g.userHome, "Library", "Application Support", "IAMCEO", "service-backup", "com.iamceo.server."));
    expect(readFileSync(outcome.serviceCopy!, "utf8")).toBe(plist);
    expect(g.core.killed).toEqual(["t1", "t3"]);
  });

  // 리뷰 safety-5: 끌 수 없는 서버면 팀장을 재우기 전에 거절한다.
  test("옛 설치의 서비스나 서비스 밖에서 직접 띄운 서버가 떠 있으면 팀장을 재우기 전에 아무것도 하지 않고 거절한다", async () => {
    const old = fixture({ program: () => ["/opt/homebrew/bin/iamceo", "serve"] });
    await expect(uninstall({ yes: true }, old.deps())).rejects.toThrow("다른 설치(옛 명령줄 설치 등)의 것이라 이 명령으로 끌 수 없습니다");
    expect(old.sleeps).toEqual([]);
    expect(old.launchctl).not.toContain("bootout");
    expect(old.core.killed).toEqual([]);

    const direct = fixture({ program: () => null });
    await expect(uninstall({ yes: true }, direct.deps())).rejects.toThrow("서비스 밖에서 직접 실행 중인 IAMCEO 서버가 있습니다");
    expect(direct.sleeps).toEqual([]);
    expect(direct.core.killed).toEqual([]);
    expect(direct.core.stopped).toBe(0);
    // 그 서버가 꺼져 있으면 엔진을 끄고 끝낸다.
    direct.downServer();
    const outcome = await uninstall({ yes: true }, direct.deps());
    expect(outcome).toMatchObject({ service: "absent", members: { reachable: false } });
    expect(direct.core.killed).toEqual(["t1", "t3"]);
  });

  // 리뷰 safety-6: 터미널 목록을 읽지 못해도 엔진 끄기로 넘어간다. 서비스는 이미 내려갔기 때문이다.
  test("실행 엔진의 터미널 목록을 읽지 못해도 엔진을 끈다. 그래도 엔진이 답하면 다시 시작하라고 알린다", async () => {
    const f = fixture();
    f.core.listFails = true;
    const outcome = await uninstall({ yes: true }, f.deps());
    expect(f.core.stopped).toBe(1);
    expect(outcome.core).toEqual({ absent: false, killed: 0, stopped: true });
    expect(f.logs.join("\n")).toContain("터미널 목록을 읽지 못했습니다");

    const g = fixture();
    g.core.listFails = true;
    g.core.stopWorks = false;
    await expect(uninstall({ yes: true }, g.deps())).rejects.toThrow("실행 엔진을 끄지 못했습니다");
    expect(g.core.stopped).toBe(1);
    expect(existsSync(g.plistPath)).toBe(false);
  });

  // 리뷰 safety-7: 기본 자리가 아닌 데이터 폴더는 --yes 여도 경로를 직접 입력해야 지운다.
  test("기본 자리도 서비스의 폴더도 아닌 데이터 폴더는 경로를 그대로 입력해야 지운다", async () => {
    const custom = (root: string) => join(root, "custom-home");
    const f = fixture({ home: custom, serviceHome: "/somewhere/else" });
    f.downServer();
    const asked: string[] = [];
    const kept = await uninstall({ yes: true, purge: true }, f.deps({ confirm: async (question, answer) => { asked.push(answer); return false; } }));
    expect(kept.purged).toBe(false);
    expect(asked).toEqual([f.home]);
    expect(existsSync(join(f.home, "iamceo.db"))).toBe(true);
    const removed = await uninstall({ yes: true, purge: true }, f.deps({ confirm: async (_question, answer) => answer === f.home }));
    expect(removed.purged).toBe(true);
    expect(existsSync(f.home)).toBe(false);
  });

  test("시험 환경에서는 실제 launchd 를 부르지 않는다. 미리 보기는 계획만 보여 준다", async () => {
    const f = fixture();
    await expect(uninstall({ yes: true }, { ...f.deps(), launchctl: undefined })).rejects.toThrow("IAMCEO_TEST=1");
    const preview = await uninstall({ dryRun: true, purge: true }, { ...f.deps(), launchctl: undefined });
    expect(preview.purged).toBe(false);
    expect(f.logs.join("\n")).toContain("데이터 폴더를 지웁니다");
    expect(f.sleeps).toEqual([]);
    expect(existsSync(f.plistPath)).toBe(true);
  });
});

describe("데이터 폴더 지우기의 안전장치", () => {
  test("홈 폴더 자체·표식 없는 폴더·심볼릭 링크·쓰는 중인 폴더는 지우지 않는다", () => {
    const f = fixture();
    expect(() => purgeHome(f.userHome, f.userHome)).toThrow("데이터 폴더로 보이지 않는");
    const plain = join(f.root, "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, "notes.txt"), "keep");
    expect(() => purgeHome(plain, f.userHome)).toThrow("IAMCEO 데이터 폴더가 아니라");
    // 표식 하나만으로는 지우지 않는다(리뷰 safety-7): config.json 하나, DB 처럼 보이지 않는 iamceo.db, 접속 코드 없는 설정.
    writeFileSync(join(plain, "config.json"), JSON.stringify({ accessCode: "x" }));
    expect(() => purgeHome(plain, f.userHome)).toThrow("IAMCEO 데이터 폴더가 아니라");
    writeFileSync(join(plain, "iamceo.db"), "not a database");
    expect(() => purgeHome(plain, f.userHome)).toThrow("IAMCEO 데이터 폴더가 아니라");
    const halfway = join(f.root, "halfway");
    mkdirSync(halfway);
    openDb(join(halfway, "iamceo.db")).close();
    writeFileSync(join(halfway, "config.json"), JSON.stringify({ port: 7878 }));
    expect(() => purgeHome(halfway, f.userHome)).toThrow("IAMCEO 데이터 폴더가 아니라");
    expect(existsSync(join(halfway, "iamceo.db"))).toBe(true);
    const link = join(f.root, "link");
    symlinkSync(f.home, link);
    expect(() => purgeHome(link, f.userHome)).toThrow("심볼릭 링크");
    {
      using _owner = acquireHomeOwner(f.home);
      expect(() => purgeHome(f.home, f.userHome)).toThrow("다른 작업이 데이터 폴더를 쓰고 있어");
    }
    expect(existsSync(join(f.home, "iamceo.db"))).toBe(true);
    expect(purgeHome(f.home, f.userHome)).toBe(true);
    expect(existsSync(f.home)).toBe(false);
    expect(readFileSync(join(plain, "notes.txt"), "utf8")).toBe("keep");
  });
});

describe("실행 엔진과 말하기(기본 구현)", () => {
  test("terminal.list → terminal.kill → server stop(엔진 실행 파일, IAMCEO 전용 소켓·세션)", async () => {
    const dir = realpathSync(mkdtempSync("/private/tmp/iqu-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const socket = join(dir, "c.sock"), home = join(dir, "home"), record = join(dir, "stop.txt");
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const server = Bun.listen({ unix: socket, socket: {
      data(conn, data) {
        for (const line of data.toString().split("\n").filter(Boolean)) {
          const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
          calls.push({ method: request.method, params: request.params });
          const result = request.method === "hello" ? { generation: 1, version: "0.1.18", methods: [], features: [] }
            : request.method === "terminal.list" ? { terminals: [{ address: "a1", state: "live", labels: {} }, { address: "a2", state: "finished", labels: {} }] }
            : { address: request.params.terminal, state: "finished" };
          conn.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
        }
      },
    } });
    cleanups.push(() => server.stop(true));
    const bin = join(dir, "herdr-core");
    writeFileSync(bin, `#!/bin/sh\nprintf '%s %s|%s|%s|%s\\n' "$1" "$2" "$HC_SOCKET" "$HC_SESSION" "$XDG_STATE_HOME" > ${JSON.stringify(record)}\nrm -f "$HC_SOCKET"\n`, { mode: 0o755 });
    const core = defaultCoreControl(socket, bin, home);
    expect(await core.answers()).toBe(true);
    const terminals = await core.terminals();
    expect(terminals.map(terminal => terminal.address)).toEqual(["a1", "a2"]);
    await core.kill("a1");
    expect(calls.at(-1)).toEqual({ method: "terminal.kill", params: { terminal: "a1" } });
    expect(await core.stop()).toBe(true);
    expect(readFileSync(record, "utf8").trim()).toBe(`server stop|${socket}|iamceo|${join(home, "core-state")}`);
    expect(await core.answers()).toBe(false);
    expect(await defaultCoreControl(socket, null, home).stop()).toBe(false);
  });
});

describe("명령줄", () => {
  test("uninstall --dry-run 은 계획만 보이고, 시험 환경의 실제 실행은 거절한다", () => {
    const f = fixture();
    const run = (args: string[]) => {
      const result = Bun.spawnSync([process.execPath, entry, ...args], { env: { ...f.env, HOME: f.userHome, IAMCEO_LANG: "ko" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() };
    };
    const dry = run(["uninstall", "--dry-run", "--purge"]);
    expect(dry.code, dry.out).toBe(0);
    expect(dry.out).toContain("로그인 서비스를 해제합니다");
    expect(dry.out).toContain(`데이터 폴더를 지웁니다: ${f.home}`);
    const refused = run(["uninstall", "--yes"]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("IAMCEO_TEST=1");
    expect(refused.out).not.toContain("    at ");
    expect(existsSync(f.plistPath)).toBe(true);
    expect(existsSync(join(f.home, "iamceo.db"))).toBe(true);
    const upgradeDry = run(["upgrade", "--dry-run"]);
    expect(upgradeDry.code).toBe(1);
    expect(upgradeDry.out).toContain("실행 파일이 버전을 답하지 않습니다");
    expect(run(["rollback", "--dry-run"]).out).toContain("되돌릴 업그레이드 기록이 없습니다");
    expect(run(["upgrade", "--timeout", "3"]).out).toContain("--timeout");
  });
});
