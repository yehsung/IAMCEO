// bin/iamceo.ts 와 가져오기. 시험 소켓·임시 폴더만 쓰고 launchctl·claude 는 부르지 않는다.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../package.json";
import type { Member, Project, ProjectState } from "../shared/types.ts";
import { buildId, launchdPlist, service, servicePath, waitForReadiness } from "../bin/iamceo.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { renderRole } from "../server/roles.ts";
import { Store } from "../server/store.ts";
import { importArtifact, normalizeCollection, parseWhen } from "../scripts/import-artifact.ts";
import { coreSetup } from "./fixtures/core-harness.ts";
import { thrower } from "./fixtures/settle.ts";

const CLI = resolve(import.meta.dir, "..", "bin", "iamceo.ts");

function cliEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  for (const dir of ["claude", "codex"]) mkdirSync(join(home, dir), { recursive: true, mode: 0o700 });
  // 명령줄 문구는 IAMCEO_LANG → LC_ALL → LANG 으로 고른다. 이 파일의 단언은 한국어 문구를 본다(영어는 cli-language 시험).
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "en_US.UTF-8", IAMCEO_LANG: "ko",
    IAMCEO_HOME: home, IAMCEO_PORT: "0", IAMCEO_HERDR_SOCKET: join(home, "no-herdr.sock"),
    IAMCEO_CORE_SOCKET: join(home, "no-core.sock"), IAMCEO_CORE_BIN: "/usr/bin/false",
    IAMCEO_CLAUDE_BIN: "/usr/bin/false", IAMCEO_CODEX_BIN: "/usr/bin/false",
    CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), IAMCEO_TEST: "1", ...extra };
}

async function cli(home: string, args: string[], opts: { stdin?: string; env?: Record<string, string>; cwd?: string } = {}) {
  const p = Bun.spawn([process.execPath, CLI, ...args], {
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd,
    env: cliEnv(home, opts.env),
  });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code, signal: p.signalCode ?? null };
}

const newHome = () => mkdtempSync(join(tmpdir(), "iamceo-cli-"));
const stops: (() => void | Promise<void>)[] = [];
afterAll(async () => {
  for (const stop of stops) await stop();
});

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port!;
  await probe.stop(true);
  return port === 7878 ? freePort() : port;
}

async function serve(home: string, port: number) {
  updateConfigFile({ hosts: ["127.0.0.1"] }, { IAMCEO_HOME: home });
  const p = Bun.spawn([process.execPath, CLI, "serve"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: cliEnv(home, { IAMCEO_PORT: String(port) }) });
  stops.push(() => {
    if (p.exitCode === null) p.kill("SIGTERM");
    return p.exited.then(() => {});
  });
  const base = `http://127.0.0.1:${port}`;
  const end = Date.now() + 15_000;
  for (;;) {
    const ok = await fetch(`${base}/api/health`).then((r) => r.ok, () => false);
    if (ok) return { base, proc: p };
    if (Date.now() > end) throw new Error(`서버가 뜨지 않았습니다: ${await new Response(p.stderr).text()}`);
    await Bun.sleep(50);
  }
}

describe("접근 범위", () => {
  test("setup --hosts: lan·직접 적기·기본, 0.0.0.0 은 거부", async () => {
    const home = mkdtempSync(join(tmpdir(), "iamceo-cli-hosts-"));
    const readHosts = () => (JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { hosts?: string[] }).hosts;
    const bad = await cli(home, ["setup", "--backend", "core", "--port", "7878", "--hosts", "0.0.0.0"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("0.0.0.0");
    const custom = await cli(home, ["setup", "--backend", "core", "--port", "7878", "--hosts", "127.0.0.1,192.168.0.9"]);
    expect(custom.code).toBe(0);
    expect(readHosts()).toEqual(["127.0.0.1", "192.168.0.9"]);
    expect(custom.stdout).toContain("http://192.168.0.9:7878");
    const local = await cli(home, ["setup", "--backend", "core", "--port", "7878", "--hosts", "local"]);
    expect(local.code).toBe(0);
    expect(readHosts()).toBeUndefined();
  });
});

describe("serve·status·open·join", () => {
  test("실제 서버를 띄우고 health·status·join 을 거친 뒤 SIGTERM 으로 끝난다", async () => {
    const home = newHome();
    const port = await freePort();
    const { base, proc } = await serve(home, port);
    expect(await (await fetch(`${base}/api/health`)).json()).toMatchObject({ ok: true, version: pkg.version });

    const opened = await cli(home, ["open"], { env: { IAMCEO_PORT: String(port) } });
    const code = /접속 코드: (\S+)/.exec(opened.stdout)![1]!;
    expect(opened.stdout).toContain(base);
    expect(code).toBe(loadConfig({ IAMCEO_HOME: home }).accessCode);
    const headers = { Authorization: `Bearer ${code}`, "Content-Type": "application/json" };

    const status = await cli(home, ["status"], { env: { IAMCEO_PORT: String(port) } });
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("실행 중");
    expect(status.stdout).toContain("본사 (hq)");

    const project = (await (await fetch(`${base}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "합류 시험", cwd: home }) })).json()) as Project;

    const missing = await cli(home, ["join"], { env: { IAMCEO_PORT: String(port) } });
    expect(missing.code).toBe(1);
    const joined = await cli(home, ["join", "--project", project.id, "--name", "내 세션", "--role", "조사"], { env: { IAMCEO_PORT: String(port) } });
    expect(joined.code).toBe(0);
    const token = /IAMCEO_TOKEN=(tk_\S+)/.exec(joined.stdout)![1]!;
    expect(joined.stdout).toContain(`IAMCEO_URL=${base}`);
    // --env 는 값을 여러 개 받는 옵션이라 서버 이름이 그 뒤에 오면 claude 가 거부한다(실측). 이름이 옵션보다 앞이어야 한다.
    expect(joined.stdout).toContain("claude mcp add iamceo --transport stdio --scope local --env IAMCEO_URL=");
    expect(joined.stdout).toMatch(/--env IAMCEO_TOKEN=tk_\S+ -- \S+ \S*iamceo\.ts mcp/);
    const rulesFile = /규칙 파일: (.+)/.exec(joined.stdout)![1]!.trim();
    expect(readFileSync(rulesFile, "utf8")).toContain("'합류 시험' 프로젝트의 직원 내 세션");

    const tools = (await (await fetch(`${base}/agent/tools`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { name: string }[];
    expect(tools.map((t) => t.name)).toContain("wait");
    const state = (await (await fetch(`${base}/api/projects/${project.id}/state`, { headers })).json()) as ProjectState;
    expect(state.members.find((m: Member) => m.name === "내 세션")).toMatchObject({ origin: "manual", role: "조사" });

    const root = await fetch(`${base}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toStartWith("text/plain");
    expect(await root.text()).toContain("Mac·iPhone 앱");

    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
    const down = await cli(home, ["status"], { env: { IAMCEO_PORT: String(port) } });
    expect(down.code).toBe(1);
    expect(down.stderr).toContain("서버가 꺼져 있습니다");
  }, 40_000);

  test("같은 포트로 또 켜면 이유를 말하고 끝난다", async () => {
    const home = newHome();
    const port = await freePort();
    await serve(home, port);
    const other = newHome();
    updateConfigFile({ hosts: ["127.0.0.1"] }, { IAMCEO_HOME: other });
    const second = await cli(other, ["serve"], { env: { IAMCEO_PORT: String(port) } });
    expect(second.code).toBe(1);
    expect(second.stderr).toContain(`포트 ${port}`);
  }, 30_000);

  test("모르는 명령·잘못된 인자", async () => {
    const home = newHome();
    expect((await cli(home, ["없는명령"])).code).toBe(1);
    expect((await cli(home, ["help"])).stdout).toContain("쓰는 법");
    const bad = await cli(home, ["setup", "--모름"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).not.toContain("at ");
  });
});

describe("setup", () => {
  test("입력으로 고른 실행 방식·포트를 저장한다", async () => {
    const home = newHome();
    const r = await cli(home, ["setup"], { stdin: "7999\n" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("설정했습니다: herdr-core, 포트 7999");
    expect(/접속 코드: (\S+)/.exec(r.stdout)![1]).toBe(loadConfig({ IAMCEO_HOME: home }).accessCode);
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).port).toBe(7999);
    const store = new Store(openDb(join(home, "iamceo.db")), new Bus());
    expect(store.getSettings().backend).toBe("core");
  });

  test("인자로도, 입력 없이 기본값으로도 끝난다", async () => {
    const home = newHome();
    expect((await cli(home, ["setup", "--backend", "core", "--port", "7001"])).code).toBe(0);
    expect(new Store(openDb(join(home, "iamceo.db")), new Bus()).getSettings().backend).toBe("core");
    expect((await cli(newHome(), ["setup"], { stdin: "" })).code).toBe(0);
    const bad = await cli(newHome(), ["setup", "--backend", "tmux"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("herdr-core 하나");
  });
});

describe("service", () => {
  test("plist: 경로·PATH·KeepAlive·이스케이프, plutil 통과", async () => {
    const plist = launchdPlist({ program: ["/bin/bun", "/a&b/iamceo.ts", "serve"], home: "/Users/u", logDir: "/Users/u/.iamceo/logs", workingDir: "/Users/u", env: { IAMCEO_HOME: "/x<y" } });
    expect(plist).toContain("<string>com.iamceo.server</string>");
    expect(plist).toContain("/Users/u/.npm-global/bin");
    expect(plist).toContain("/opt/homebrew/bin");
    expect(plist).toContain("/Users/u/.local/bin");
    expect(plist).toContain("<key>StandardOutPath</key>\n  <string>/dev/null</string>");
    // 등급을 비우면 launchd 가 서버를 낮은 우선순위로 돌린다.
    expect(plist).toContain("<key>ProcessType</key>\n  <string>Interactive</string>");
    expect(plist).toContain("/a&amp;b/iamceo.ts");
    expect(plist).toContain("/x&lt;y");
    const file = join(newHome(), "t.plist");
    writeFileSync(file, plist);
    const lint = Bun.spawnSync(["plutil", "-lint", file]);
    expect(lint.exitCode).toBe(0);
  });

  test("--dry-run 은 아무것도 등록하지 않고, IAMCEO_TEST 에서는 실제 등록을 거부한다", async () => {
    const home = newHome();
    const dry = await cli(home, ["service", "install", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("launchctl bootstrap gui/");
    expect(dry.stdout).toContain(join(home, "logs", "server.log"));
    expect(dry.stdout).toMatch(/iamceo\.ts<\/string>\s+<string>serve<\/string>/);
    const refused = await cli(home, ["service", "install"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("IAMCEO_TEST");
    expect((await cli(home, ["service", "uninstall"])).code).toBe(1);
    expect((await cli(home, ["service", "uninstall", "--dry-run"])).stdout).toContain("launchctl bootout");
    expect((await cli(home, ["service", "모름"])).code).toBe(1);
  });

  test("서비스 PATH: 등록할 때 찾은 claude·herdr 폴더를 앞에 두고, 겹치거나 없는 것은 뺀다", () => {
    const path = servicePath("/Users/u", ["/Users/u/.nvm/versions/node/v22/bin/claude", null, "/opt/homebrew/bin/herdr", "claude"]).split(":");
    expect(path[0]).toBe("/Users/u/.nvm/versions/node/v22/bin");
    expect(path.filter((p) => p === "/opt/homebrew/bin")).toHaveLength(1);
    expect(path).toContain("/Users/u/.local/bin");
    expect(path).not.toContain(".");
  });
});

test("version 은 package.json 의 버전을 찍는다", async () => {
  const out = await cli(newHome(), ["version"]);
  expect(out.code).toBe(0);
  expect(out.stdout.trim()).toBe(JSON.parse(readFileSync(resolve(import.meta.dir, "..", "package.json"), "utf8")).version);
});

describe("역할 템플릿", () => {
  const vars = { PROJECT: "랜딩", NAME: "철수", ROLE: "개발", CONDUCTOR: "총괄" };

  test("자리표시가 다 치환되고 쓸 도구만 가리킨다", () => {
    for (const kind of ["worker", "conductor", "root"] as const) {
      const text = renderRole(kind, vars);
      expect(text).not.toMatch(/\{\{/);
      expect(text).not.toMatch(/herdr agent|SendMessage|ArtifactData|CronCreate|운영판|registry|row\.py/);
    }
  });

  test("핵심 규칙이 빠지지 않았다", () => {
    const worker = renderRole("worker", vars);
    for (const rule of ["[대표 직접]", "[대표 답(원문)", "[총괄]", "[시스템]", "AskUserQuestion", "서버 확인", "총괄 인용(미확인)", "승인이 아니다", "`post`", "`ask`", "`file`", "rm -rf", "이름을 바꾸지", "병렬"]) {
      expect(worker).toContain(rule);
    }
    const conductor = renderRole("conductor", vars);
    for (const rule of ["직접 하지 않는다", "대기열", "2호", "끼어들지", "user_quote", "대신 답하지", "`parallel`", "상한", "`team_sleep`", "`team_resume`", "압축은 서버가 자동", "`post`", "임시 폴더", "[보고 "]) {
      expect(conductor).toContain(rule);
    }
    const root = renderRole("root", vars);
    for (const rule of ["`project_create`", "`project_list`", "mkdir -p", "잡다한 일", "임시 폴더"]) {
      expect(root).toContain(rule);
    }
  });
});

describe("가져오기", () => {
  const DUMP = {
    meta: { board: { asof: "2026-11-01T00:00:00Z", by: "총괄", now: "지금 상황 글", title: "내 운영판" }, inbox: { at: "x" } },
    sessions: {
      insta: { order: 2, name: "인스타", role: "콘텐츠", state: "작업 중", now: "릴스 3편", queue: "4편", updated: "10-17 03:10" },
      "대문자": { order: 1, name: "조사", role: "경쟁사", state: "대기", now: "", queue: "—" },
    },
    docs: {
      d1: { order: 1, title: "옛 보고서", who: "인스타", when: "10-15", summary: "요약", body: "본문", path: "/x/old.md", images: [{ url: "/_blob/a", caption: "캡처" }] },
      d2: { order: 2, title: "새 보고서", who: "조사", body: "본문2" },
    },
    items: {
      q1: { sec: "decide", order: 1, title: "톤 정하기", detail: "배경", who: "인스타", group: "콘텐츠", options: [{ k: "a", label: "밝게", desc: "조회수" }, { k: "b", label: "차분하게" }], rec: "a", docId: "d1", when: "10-20" },
      q2: { sec: "decide", order: 2, title: "열린 결정", detail: "배경2", who: "조사", options: [{ k: "x", label: "예" }], rec: "없는값" },
      q3: { sec: "decide", order: 3, title: "메모로만 답함", detail: "", who: "모르는 사람" },
      t1: { sec: "todo", order: 4, title: "로그인 해 주세요", detail: "폰", group: "직접 하실 일", who: "인스타" },
      t2: { sec: "todo", order: 5, title: "다음 릴스", group: "콘텐츠", who: "인스타", link: "https://e.com", linkLabel: "참고" },
      w1: { sec: "doing", order: 6, title: "하는 일", who: "조사", docId: "d2" },
      h1: { sec: "hold", order: 7, title: "멈춘 일" },
      f1: { sec: "done", order: 8, title: "끝난 일", group: "10-30", who: "인스타" },
      u1: { sec: "이상함", order: 9, title: "모르는 칸" },
    },
    answers: {
      q1: { choice: "a", note: "좋아요", at: "2026-10-21T01:00:00Z", batch: true },
      q3: { note: "알아서", at: "2026-10-22T01:00:00Z" },
    },
    feed: {
      n2: { at: "2026-10-20T02:00:00Z", who: "조사", kind: "질문", title: "물음", body: "b", itemId: "q2" },
      n1: { at: "2026-10-19T02:00:00Z", who: "인스타", kind: "완료", title: "릴스 끝", body: "b", docId: "d1", images: [{ url: "https://e.com/a.png", caption: "시안" }] },
      n3: { at: "2026-10-23T02:00:00Z", who: "총괄", kind: "모름", title: "이상한 종류" },
    },
    messages: {
      m1: { text: "처리된 말", at: "2026-10-24T00:00:00Z", seen: "2026-10-24T00:05:00Z" },
      m2: { text: "아직 안 본 말", at: "2026-10-25T00:00:00Z" },
    },
  };
  const NOW = new Date("2026-11-02T00:00:00Z");

  function fresh() {
    const home = newHome();
    return { home, store: new Store(openDb(join(home, "iamceo.db")), new Bus()) };
  }

  test("덤프 모양: 맵·배열·문서 포장 모두 읽는다", () => {
    expect(normalizeCollection({ a: { x: 1 } })).toEqual([{ x: 1, id: "a" }]);
    expect(normalizeCollection([{ id: "a", x: 1 }])).toEqual([{ id: "a", x: 1 }]);
    expect(normalizeCollection([{ id: "a", data: { x: 1 }, updatedAt: "t" }])[0]).toMatchObject({ id: "a", x: 1, updatedAt: "t" });
    expect(normalizeCollection(undefined)).toEqual([]);
  });

  test("짧은 날짜는 가장 가까운 과거 해의 KST 로 읽는다", () => {
    expect(parseWhen("10-30", NOW)).toBe("2026-10-29T15:00:00.000Z");
    expect(parseWhen("12-25 03:10", NOW)).toBe("2025-12-24T18:10:00.000Z");
    expect(parseWhen("2026-10-21T01:00:00Z", NOW)).toBe("2026-10-21T01:00:00.000Z");
    expect(parseWhen("어제", NOW)).toBeNull();
    expect(parseWhen(undefined, NOW)).toBeNull();
  });

  test("도메인으로 변환하고 실행은 꺼 둔다", () => {
    const { home, store } = fresh();
    const s = importArtifact(store, DUMP, { cwd: home, fallbackName: "파일 이름", now: NOW });
    expect(s).toMatchObject({ name: "내 운영판", members: 2, decisions: 3, answered: 2, todos: 1, work: 5, files: 2, feed: 3, userMessages: 2, heldMessages: 1 });

    const state = store.projectState(s.projectId);
    expect(state.project).toMatchObject({ runnerEnabled: false, now: "지금 상황 글", cwd: home });

    expect(state.members.map((m) => m.handle).sort()).toEqual(["insta", "s1"]);
    const insta = store.findMember(s.projectId, "인스타")!;
    expect(insta).toMatchObject({ origin: "adopted", kind: "worker", status: "offline", role: "콘텐츠", now: "릴스 3편", next: "대기열: 4편", paneId: null, sessionId: null });
    expect(store.findMember(s.projectId, "조사")!.next).toBe("");

    const byTitle = (t: string) => state.decisions.find((d) => d.title === t)!;
    const tone = byTitle("톤 정하기");
    expect(tone).toMatchObject({ status: "delivered", choice: "a", note: "좋아요", batch: true, rec: "a", group: "콘텐츠", memberId: insta.id, who: "인스타", answeredAt: "2026-10-21T01:00:00.000Z" });
    expect(tone.options[0]).toEqual({ k: "a", label: "밝게", desc: "조회수" });
    expect(tone.createdAt).toBe("2026-10-19T15:00:00.000Z");
    expect(store.getFile(tone.fileId!)!.title).toBe("옛 보고서");
    expect(byTitle("열린 결정")).toMatchObject({ status: "open", rec: null, choice: null });
    expect(byTitle("메모로만 답함")).toMatchObject({ status: "delivered", choice: null, note: "알아서", memberId: null });

    expect(state.todos).toHaveLength(1);
    expect(state.todos[0]).toMatchObject({ title: "로그인 해 주세요", who: "인스타", memberId: insta.id, done: false });

    const work = Object.fromEntries(state.work.map((w) => [w.title, w]));
    expect(work["다음 릴스"]!.sec).toBe("next");
    expect(work["다음 릴스"]!.detail).toContain("[참고](https://e.com)");
    expect(work["다음 릴스"]!.detail).toContain("영역: 콘텐츠");
    expect(work["하는 일"]!.sec).toBe("doing");
    expect(work["멈춘 일"]!.sec).toBe("hold");
    expect(work["모르는 칸"]!.sec).toBe("hold");
    expect(work["끝난 일"]).toMatchObject({ sec: "done", doneAt: "2026-10-29T15:00:00.000Z" });

    expect(state.files.map((f) => f.title)).toEqual(["새 보고서", "옛 보고서"]);
    const old = state.files[1]!;
    expect(old).toMatchObject({ summary: "요약", path: "/x/old.md", who: "인스타", memberId: insta.id, createdAt: "2026-10-14T15:00:00.000Z" });
    expect(old.body).toContain("본문");
    expect(old.body).toContain("(이미지: 캡처, 원본 /_blob/a)");

    const messages = state.messages;
    expect(messages.map((m) => m.title || m.body)).toEqual(["릴스 끝", "물음", "이상한 종류", "처리된 말", "아직 안 본 말"]);
    expect(messages[0]).toMatchObject({ kind: "완료", fileId: old.id, at: "2026-10-19T02:00:00.000Z", memberId: insta.id });
    expect(messages[0]!.body).toContain("![시안](https://e.com/a.png)");
    expect(messages[1]).toMatchObject({ kind: "질문", decisionId: byTitle("열린 결정").id });
    expect(messages[2]!.kind).toBe("알림");
    expect(messages[3]).toMatchObject({ mine: true, kind: "나", delivery: "delivered" });
    expect(messages[4]).toMatchObject({ mine: true, delivery: "held", deliveryNote: "총괄을 시작하면 전달됩니다" });
    expect(store.listUndelivered(s.projectId)).toHaveLength(0);
  });

  test("같은 이름을 다시 가져오면 거부, 실패하면 아무것도 안 남는다", () => {
    const { home, store } = fresh();
    importArtifact(store, DUMP, { cwd: home, fallbackName: "x", now: NOW });
    expect(() => importArtifact(store, DUMP, { cwd: home, fallbackName: "x", now: NOW })).toThrow("이미 있습니다");
    const count = store.listProjects().length;
    const broken = { ...DUMP, meta: {}, sessions: { a: { name: "같은 이름" }, b: { name: "같은 이름" } } };
    expect(() => importArtifact(store, broken, { cwd: home, fallbackName: "새 이름", now: NOW })).toThrow("이미 있는 이름");
    expect(store.listProjects()).toHaveLength(count);
    expect(() => importArtifact(store, [1], { cwd: home, fallbackName: "y" })).toThrow("JSON 객체");
  });

  test("CLI: iamceo import, 폴더·파일 오류", async () => {
    const home = newHome();
    const file = join(home, "운영판.json");
    writeFileSync(file, JSON.stringify({ ...DUMP, meta: {} }));
    const r = await cli(home, ["import", file, "--cwd", home]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("가져왔습니다: '운영판'");
    expect(r.stdout).toContain("실행 꺼짐");
    // 끝 안내는 지금 되는 길만 적는다: 없어진 herdr·편입을 가리키지 않고, 가져온 자리는 총괄을 시작한 뒤 일을 맡기면 새 세션으로 열린다.
    expect(r.stdout).toContain("총괄을 시작하기 전에는 어떤 세션도 움직이지 않습니다.");
    expect(r.stdout).toContain("가져온 팀원 자리는 세션이 없습니다. 총괄을 시작한 뒤 일을 맡기거나 깨우면 새 세션으로 열립니다.");
    expect(r.stdout).not.toMatch(/herdr|편입/);
    expect((await cli(home, ["import"])).code).toBe(1);
    expect((await cli(home, ["import", file, "--name", "다른", "--cwd", join(home, "없음")])).stderr).toContain("폴더가 없습니다");
    expect((await cli(home, ["import", join(home, "없음.json")])).stderr).toContain("덤프를 읽을 수 없습니다");
    const store = new Store(openDb(join(home, "iamceo.db")), new Bus());
    expect(store.listProjects().map((p) => p.name)).toEqual(["본사", "운영판"]);
  });

  test("예약된 이름·핸들의 세션을 가져와도 바꿔 받아 나중에 총괄이 뜰 수 있다", () => {
    const home = newHome();
    const store = new Store(openDb(join(home, "iamceo.db")), new Bus());
    const dump = { meta: { board: { title: "예약" } }, sessions: { lead: { name: "총괄", role: "x" }, root: { name: "대표", role: "y" } } };
    const s = importArtifact(store, dump, { cwd: home, fallbackName: "x", now: NOW });
    const members = store.listMembers(s.projectId);
    expect(members.map((m) => m.handle).sort()).toEqual(["s1", "s2"]);
    expect(members.map((m) => m.name).sort()).toEqual(["직원 대표", "직원 총괄"]);
  });

  test("roles export 가 기본 템플릿을 example 로 꺼내고 사용법에 있다", async () => {
    const home = newHome();
    const out = await cli(home, ["roles", "export"]);
    expect(out.stdout).toContain("worker.example.md");
    expect(readFileSync(join(home, "roles", "worker.example.md"), "utf8")).toContain("## 승인");
    expect((await cli(home, ["help"])).stdout).toContain("roles export");
  });

  // 옛 시험: "가져온 프로젝트는 대표 말·서버 복구로 세션을 띄우지 않고, 편입은 그 직원 자리를 잇는다".
  // 뒤 절반(편입: herdr 칸 넘겨받기)은 옛 실행기 전용이라 지웠다. 앞 절반을 운영과 같은 실행기 종류(core)로 본다.
  test("가져온 프로젝트는 대표 말·서버 복구로 세션을 띄우지 않는다", async () => {
    // live: false — 가져온 뒤의 첫 복구를 보는 시험이라 틀이 미리 복구를 돌리지 않게 한다.
    const t = await coreSetup({ live: false, agentTools: { listAgentTools: () => [], handleAgentTool: async () => ({ text: "" }) } });
    stops.push(() => t.close());
    const { projectId } = importArtifact(t.store, DUMP, { cwd: t.home, fallbackName: "x", now: NOW });
    await t.orch.recover();
    const message = await t.orch.sendUserMessage(projectId, { text: "안녕" });
    expect(message.delivery).toBe("held");
    // 옛 가짜 실행기의 start·send 자리: CLI 를 띄우지도, 글을 넣지도 않았다.
    expect(t.core.calls.filter(c => c.method === "terminal.run" || c.method === "terminal.send")).toEqual([]);
    expect(t.runs()).toEqual([]);
    expect(t.turns()).toEqual([]);
    expect(t.store.getConductor(projectId)).toBeNull();
  }, 15_000);
});

describe("운영 CLI readiness·등록·복원", () => {
  test("복원 운영은 조정 → 명시 재개 → serve 순서이며 잠금·조정 실패는 발신을 열지 않는다", async () => {
    const home = newHome();
    expect((await cli(home, ["setup", "--port", "7003", "--hosts", "127.0.0.1"])).code).toBe(0);
    const backup = await cli(home, ["backup"]);
    expect(backup.code).toBe(0);
    const snapshot = backup.stdout.trim().replace("백업 검증 완료: ", "");
    const destination = join(newHome(), "restored");
    expect((await cli(home, ["restore", snapshot, "--destination", destination])).code).toBe(0);
    const early = await cli(destination, ["restore", "resume"]);
    expect(early.code).toBe(1);
    expect(early.stderr).toContain("조정이 끝나지");
    const blocked = await cli(destination, ["serve"]);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain("발신 꺼짐");
    expect(blocked.stdout).not.toContain("IAMCEO 서버:");
    const { acquireHomeOwner } = await import("../server/home-owner.ts");
    using owner = acquireHomeOwner(destination);
    expect((await cli(destination, ["restore", "reconcile"])).stderr).toContain("다른 작업");
    owner.release();
    const reconciled = await cli(destination, ["restore", "reconcile"]);
    expect(reconciled.code).toBe(0);
    expect(reconciled.stdout).toContain("조정 완료");
    expect(reconciled.stdout).toContain("발신 꺼짐");
    expect((await cli(destination, ["serve"])).code).toBe(1);
    const resumed = await cli(destination, ["restore", "resume"]);
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain("재개 허용");
    expect((await cli(destination, ["restore", "resume"])).code).toBe(0);
    const { proc } = await serve(destination, await freePort());
    expect((await cli(destination, ["restore", "resume"])).stderr).toContain("다른 작업");
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
    expect((await cli(destination, ["restore", "resume"])).code).toBe(0);
    for (const command of ["reconcile", "resume"]) {
      expect((await cli(destination, ["restore", command, "--clone"])).code).toBe(1);
      const unrelated = newHome();
      expect((await cli(unrelated, ["restore", command])).code).toBe(1);
      expect(existsSync(join(unrelated, "iamceo.db"))).toBe(false);
      expect(existsSync(join(unrelated, "config.json"))).toBe(false);
    }
  }, 30_000);

  // 리뷰 docs-4·docs-9: 문서가 안내하는 백업·복원 명령. 서버가 홈을 쥐면 호출 기록 없이 한 줄로, 복원 뒤에는 serve 대신 앱의
  // '이 Mac에서 시작'(기본 자리) 또는 그 홈을 지정한 service install(다른 자리)로 켜라고 한다.
  test("백업·복원의 거절은 한 줄이고, 복원 뒤에는 '이 Mac에서 시작' 또는 service install 로 켜라고 한다", async () => {
    const home = newHome();
    expect((await cli(home, ["setup", "--port", "7005", "--hosts", "127.0.0.1"])).code).toBe(0);
    const { acquireHomeOwner } = await import("../server/home-owner.ts");
    {
      using _owner = acquireHomeOwner(home);
      const held = await cli(home, ["backup"]);
      expect(held.code).toBe(1);
      expect(held.stderr).toContain("켜져 있는 서버가 데이터 폴더를 쓰고 있어");
      expect(held.stderr).toContain("매일 스스로 백업합니다");
      expect(held.stderr.trim().split("\n")).toHaveLength(1);
      expect(held.stderr).not.toContain("    at ");
      const english = await cli(home, ["backup"], { env: { IAMCEO_LANG: "en" } });
      expect(english.stderr).toContain("The running server is using the data folder");
    }
    const backup = await cli(home, ["backup"]);
    expect(backup.code).toBe(0);
    const snapshot = backup.stdout.trim().replace("백업 검증 완료: ", "");
    // 새 Mac 의 기본 자리(~/.iamceo)에 복원: 앱의 버튼으로 켠다.
    const user = newHome(), usual = join(user, ".iamceo");
    const restored = await cli(home, ["restore", snapshot, "--destination", usual], { env: { HOME: user } });
    expect(restored.code, restored.stderr).toBe(0);
    expect(restored.stdout).toContain("‘이 Mac에서 시작’");
    expect(restored.stdout).not.toContain("IAMCEO_HOME=");
    expect(restored.stdout).not.toContain("serve 순서");
    expect(restored.stdout).not.toContain("lease");
    expect((await cli(usual, ["restore", "reconcile"], { env: { HOME: user } })).code).toBe(0);
    const resumed = await cli(usual, ["restore", "resume"], { env: { HOME: user } });
    expect(resumed.stdout).toContain("‘이 Mac에서 시작’");
    expect(resumed.stdout).not.toContain("iamceo serve");
    // 다른 자리: 앱이 쓰지 않는 홈이라 그 홈을 지정한 service install 을 안내한다.
    const other = join(newHome(), "restored");
    const elsewhere = await cli(home, ["restore", snapshot, "--destination", other], { env: { HOME: user } });
    // 복원은 실제 경로(/var → /private/var 처럼 링크를 푼 경로)를 알린다.
    expect(elsewhere.stdout).toContain(`IAMCEO_HOME=${realpathSync(other)}`);
    expect(elsewhere.stdout).toContain("iamceo service install");
    expect((await cli(other, ["restore", "reconcile"], { env: { HOME: user } })).code).toBe(0);
    expect((await cli(other, ["restore", "resume"], { env: { HOME: user } })).stdout).toContain(`IAMCEO_HOME=${realpathSync(other)} iamceo service install`);
    // 서버가 꺼져 있을 때의 안내도 같은 말이다.
    const down = await cli(home, ["status"]);
    // 2026-11-14 전체 실행 한 번에서 이 자식의 stderr 가 비었다(다시 돌리면 통과). 다음에 나면 까닭이 보이게 종료 코드·신호·stdout 을 함께 남긴다.
    expect(down.stderr, `exit=${down.code} signal=${down.signal} stdout=${JSON.stringify(down.stdout.slice(0, 400))}`).toContain("‘이 Mac에서 시작’");
    expect(down.stderr).not.toContain("iamceo serve 로 켜세요");
  }, 30_000);

  test("인증된 준비 확인: health만 성공하는 구형 데몬, 다른 build와 미복구 상태는 성공이 아니다", async () => {
    const home = newHome();
    const config = loadConfig({ IAMCEO_HOME: home, IAMCEO_PORT: "0" });
    let mode = "old";
    const expected = await buildId();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      expect(req.headers.get("authorization")).toBe(`Bearer ${config.accessCode}`);
      expect(new URL(req.url).pathname).toBe("/api/bootstrap");
      if (mode === "auth") return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json(mode === "old" ? { version: `${pkg.version}-old` } : { runtime: { daemon: {
        ready: mode !== "recovering", version: mode === "old-version" ? `${pkg.version}-old` : pkg.version,
        buildId: mode === "mismatch" ? "old-build" : expected,
      } } });
    } });
    if (server.port === 7878) { await server.stop(true); throw new Error("fixture port forbidden"); }
    try {
      const settings = { ...config, port: server.port! };
      for (const value of ["old", "old-version", "mismatch", "recovering", "auth"]) {
        mode = value;
        expect(await thrower(waitForReadiness(settings, { expectedBuildId: expected, timeoutMs: 25, pollMs: 1 }))).toThrow();
      }
      mode = "ready";
      await waitForReadiness(settings, { expectedBuildId: expected, timeoutMs: 100 });
    } finally { await server.stop(true); }
  });

  test("등록·업데이트는 mock launchctl과 인증 readiness를 모두 통과해야 한다; 실패를 전파한다", async () => {
    const home = newHome();
    const config = loadConfig({ IAMCEO_HOME: home, IAMCEO_PORT: "0" });
    const calls: string[] = [];
    let loaded = false, fail = false, ready = false;
    const dependencies = { home, config, program: ["/fixture/iamceo", "service-run"],
      launchctl: (...args: string[]) => {
        calls.push(args[0]!);
        if (args[0] === "print") return { ok: loaded, output: "" };
        if (args[0] === "bootstrap") { if (fail) return { ok: false, output: "mock bootstrap failed" }; loaded = true; }
        if (args[0] === "bootout") loaded = false;
        return { ok: true, output: "" };
      },
      readiness: async () => { calls.push("readiness"); if (!ready) throw new Error("mock build mismatch"); },
    };
    expect(await thrower(service(["install"], dependencies))).toThrow("build mismatch");
    expect(calls).toEqual(["print", "bootstrap", "readiness"]);
    calls.length = 0; ready = true;
    await service(["install"], dependencies);
    expect(calls).toEqual(["print", "readiness"]);
    calls.length = 0;
    await service(["install", "--restart"], dependencies);
    // bootout 뒤에는 서비스가 다 내려갔는지 print 로 확인하고 올린다.
    expect(calls).toEqual(["print", "bootout", "print", "bootstrap", "readiness"]);
    expect(readFileSync(join(home, "Library/LaunchAgents/com.iamceo.server.plist"), "utf8")).toContain("service-run");
    calls.length = 0; fail = true;
    // 프로세스 안에서 부르는 함수라 문구는 시험 실행 환경의 언어를 따른다(server/cli-text.ts).
    expect(await thrower(service(["install", "--restart"], dependencies))).toThrow(/등록 실패|Registering with launchd failed/);
    // 마지막 print 는 실패 안내에 서비스가 내려가 있는지 적기 위한 확인이다.
    expect(calls).toEqual(["print", "bootout", "print", "bootstrap", "print"]);
  });

  test("백업/별도 경로 복원을 CLI로 실행하며 복원본의 발신은 격리되고 사용 중 홈은 거부한다", async () => {
    const home = newHome();
    expect((await cli(home, ["setup", "--port", "7003", "--hosts", "127.0.0.1"])).code).toBe(0);
    const backup = await cli(home, ["backup"]);
    expect(backup.code).toBe(0);
    const snapshot = backup.stdout.trim().replace("백업 검증 완료: ", "");
    const destination = join(newHome(), "restore");
    const restored = await cli(home, ["restore", snapshot, "--destination", destination, "--clone"]);
    expect(restored.code).toBe(0); expect(restored.stdout).toContain("발신 꺼짐");
    const db = openDb(join(destination, "iamceo.db"));
    try {
      expect(db.query("SELECT 1 FROM projects WHERE runner_enabled=1").get()).toBeNull();
      expect(db.query("SELECT 1 FROM push_devices WHERE enabled=1").get()).toBeNull();
    } finally { db.close(); }
    expect((await cli(home, ["restore", snapshot, "--destination", home])).code).toBe(1);
    const { acquireHomeOwner } = await import("../server/home-owner.ts");
    using owner = acquireHomeOwner(home);
    expect((await cli(home, ["backup"])).stderr).toContain("다른 작업");
    expect((await cli(home, ["setup", "--port", "7003"])).stderr).toContain("다른 작업");
  });

});

test("같은 홈의 다른 포트 데몬은 DB/복구 전에 거부하고 종료 뒤 다시 소유할 수 있다", async () => {
  const home = newHome(); const port = await freePort();
  const first = await serve(home, port);
  const second = await cli(home, ["serve"], { env: { IAMCEO_PORT: "0" } });
  expect(second.code).toBe(1); expect(second.stderr).toContain("다른 작업");
  first.proc.kill("SIGTERM"); expect(await first.proc.exited).toBe(0);
  const { acquireHomeOwner } = await import("../server/home-owner.ts");
  using owner = acquireHomeOwner(home);
});

test("컴파일 산출물의 서비스 감독 프로세스가 로그·build ID·port0·SIGTERM 정리를 연결한다", async () => {
  const home = newHome(); const binary = join(home, "iamceo");
  const compile = Bun.spawn([process.execPath, "build", CLI, "--compile", "--outfile", binary], { stdout: "ignore", stderr: "pipe" });
  const diagnostics = new Response(compile.stderr).text();
  expect(await compile.exited, await diagnostics).toBe(0);
  updateConfigFile({ hosts: ["127.0.0.1"] }, { IAMCEO_HOME: home });
  const identity = Bun.spawn([binary, "build-id"], { stdout: "pipe", stderr: "pipe", env: cliEnv(home) });
  const expected = (await new Response(identity.stdout).text()).trim();
  expect(await identity.exited).toBe(0); expect(expected).toMatch(/^[a-f0-9]{64}$/);
  const child = Bun.spawn([binary, "serve"], { stdin: "ignore", stdout: "ignore", stderr: "pipe", env: cliEnv(home, { IAMCEO_LOG_WRITER: "1" }) });
  try {
    const log = join(home, "logs/server.log"); const end = Date.now() + 10_000;
    let origin = "";
    while (Date.now() < end && child.exitCode === null) {
      origin = existsSync(log) ? /http:\/\/127\.0\.0\.1:(\d+)/.exec(readFileSync(log, "utf8"))?.[0] ?? "" : "";
      if (origin) break;
      await Bun.sleep(20);
    }
    expect(origin).not.toBe(""); expect(new URL(origin).port).not.toBe("7878");
    const config = loadConfig({ IAMCEO_HOME: home });
    const response = await fetch(`${origin}/api/bootstrap`, { headers: { Authorization: `Bearer ${config.accessCode}` } });
    expect(response.status).toBe(200);
    const body = await response.json() as { runtime: { daemon: { buildId: string; ready: boolean } } };
    expect(body.runtime.daemon).toMatchObject({ buildId: expected, ready: true });
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    const { acquireHomeOwner } = await import("../server/home-owner.ts");
    using owner = acquireHomeOwner(home);
    expect(readFileSync(log, "utf8")).toContain("IAMCEO 서버");
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
  }
}, 30_000);
