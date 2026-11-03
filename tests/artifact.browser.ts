// 아티팩트가 실제 브라우저에서 돌고, 격리를 뚫지 못하는지 본다. 페이지·빈 칸·CSP 는 실제 서버의 것이다.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit, type Browser, type BrowserType, type Page } from "playwright";
import { ARTIFACT_FRAME_PATH, ARTIFACT_SANDBOX, buildArtifactSrcdoc } from "../shared/artifact-kit.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";

let server: RunningServer;
let orch: Orchestrator;
let base = "";

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "iamceo-artifact-"));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "비밀접속코드", hosts: ["127.0.0.1"], claudeBin: "/bin/false" }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  orch = new Orchestrator({ config, store, runners: new Map() });
  server = await startServer({ config, store, bus, orch });
  base = server.urls[0]!;
});

afterAll(async () => {
  await orch.shutdown();
  await server.stop();
});

interface Run {
  messages: Record<string, unknown>[];
  frameHeight: number;
  firstHeadChild: string;
  logs: string[];
}

/** 진짜 화면처럼 CSP 가 걸린 페이지에서 빈 칸을 만들고 문서를 넣는다. 작성자 스크립트는 parent.postMessage 로 결과를 알린다. */
async function render(page: Page, html: string, width = 700, rawDoc?: string): Promise<Run> {
  await page.setViewportSize({ width: 1000, height: 800 });
  const logs: string[] = [];
  page.on("console", (m) => logs.push(m.text()));
  await page.goto(`${base}/api/health`);
  const shell = await page.goto(`${base}/`);
  // 시험의 뜻이 여기 있다: 화면과 같은 CSP 아래에서 돌려야 한다.
  expect(shell!.headers()["content-security-policy"]).toContain("script-src 'self'");
  await page.evaluate(() => localStorage.setItem("iamceo.accessCode", "비밀접속코드"));
  const out = await page.evaluate(
    async ({ path, sandbox, doc, width }) => {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", sandbox);
      frame.style.width = `${width}px`;
      frame.src = path;
      const messages: Record<string, unknown>[] = [];
      addEventListener("message", (e) => {
        if (e.source !== frame.contentWindow) return;
        messages.push(e.data);
        if (e.data?.iamceoFrameReady) frame.contentWindow!.postMessage({ iamceoSrcdoc: doc }, "*");
        if (typeof e.data?.iamceoHeight === "number") frame.style.height = `${e.data.iamceoHeight}px`;
      });
      document.body.append(frame);
      await new Promise((r) => setTimeout(r, 1200));
      return { messages, frameHeight: frame.getBoundingClientRect().height };
    },
    { path: ARTIFACT_FRAME_PATH, sandbox: ARTIFACT_SANDBOX, doc: rawDoc ?? buildArtifactSrcdoc(html, { title: "시험" }), width },
  );
  return { ...out, firstHeadChild: "", logs };
}

const report = (run: Run) => run.messages.filter((m) => "probe" in m).map((m) => m.probe as Record<string, unknown>);

const PROBE = `<script>
(async function(){
  var p={origin:String(self.origin)};
  try{p.cookie=document.cookie}catch(e){p.cookie="차단"}
  try{p.storage=localStorage.getItem("iamceo.accessCode")}catch(e){p.storage="차단"}
  try{p.parentDoc=parent.document.title}catch(e){p.parentDoc="차단"}
  try{var r=await fetch("/api/bootstrap");p.fetch=r.status}catch(e){p.fetch="차단"}
  try{var r2=await fetch("https://example.com/");p.outside=r2.status}catch(e){p.outside="차단"}
  p.rtc=typeof RTCPeerConnection;
  p.first=document.head.firstElementChild&&document.head.firstElementChild.getAttribute("http-equiv");
  p.metaCount=document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').length;
  parent.postMessage({probe:p},"*");
})();
</script>`;

for (const [label, type] of [["chromium", chromium], ["webkit", webkit]] as [string, BrowserType][]) {
  describe(`아티팩트 격리: ${label}`, () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await type.launch();
    });
    afterAll(async () => {
      await browser.close();
    });

    test("페이지 CSP 아래에서도 작성자 인라인 스크립트와 높이 보고가 돈다", async () => {
      const page = await browser.newPage();
      const run = await render(page, `<div id="x">글</div><div style="height:640px"></div><script>parent.postMessage({probe:{ran:true}},"*")</script>`);
      expect(report(run)).toEqual([{ ran: true }]);
      expect(run.messages.some((m) => m.iamceoFrameReady === true)).toBe(true);
      const heights = run.messages.flatMap((m) => (typeof m.iamceoHeight === "number" ? [m.iamceoHeight] : []));
      expect(Math.max(...heights)).toBeGreaterThan(640);
      expect(run.frameHeight).toBeGreaterThan(640);
      await page.close();
    }, 30_000);

    test("접속 코드·부모 문서·서버 API·바깥 요청 모두 막힌다", async () => {
      const page = await browser.newPage();
      const run = await render(page, PROBE);
      const [p] = report(run);
      expect(p).toBeDefined();
      expect(p!.origin).toBe("null");
      expect(p!.storage).toBe("차단");
      expect(p!.cookie).toBe("차단");
      expect(p!.parentDoc).toBe("차단");
      expect(p!.fetch).toBe("차단");
      expect(p!.outside).toBe("차단");
      expect(p!.rtc).toBe("undefined");
      expect(JSON.stringify(run.messages)).not.toContain("비밀접속코드");
      await page.close();
    }, 30_000);

    test("doctype·html·head 를 다 써도 메타가 머리 맨 앞이고, CSP 를 넓히거나 base 를 바꾸지 못한다", async () => {
      const page = await browser.newPage();
      const attack = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval'; connect-src *"><base href="https://evil.example/"><title>제목</title></head><body>${PROBE}<script>parent.postMessage({probe:{base:document.baseURI.indexOf("evil.example")>=0}},"*")</script></body></html>`;
      const run = await render(page, attack);
      const all = Object.assign({}, ...report(run));
      expect(all.first).toBe("Content-Security-Policy");
      expect(all.fetch).toBe("차단");
      expect(all.outside).toBe("차단");
      expect(all.base).toBe(false);
      await page.close();
    }, 30_000);

    test("중첩 칸·link 로 STUN·preconnect 패킷이 나가지 않는다", async () => {
      let udp = 0;
      let tcp = 0;
      const stun = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0, socket: { data() { udp++; } } });
      const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() { tcp++; }, data() {} } });
      const rtc = `new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${stun.port}'}]})`;
      const inner = `<script>var c=${rtc};c.createDataChannel('x');c.createOffer().then(function(o){return c.setLocalDescription(o)})</` + `script>`;
      const staticFrame = `<iframe srcdoc="${inner}"></iframe>`;
      const counted = async (doc: string, raw = false) => {
        udp = 0;
        tcp = 0;
        const page = await browser.newPage();
        await render(page, doc, 700, raw ? doc : undefined);
        await new Promise((r) => setTimeout(r, 1500));
        await page.close();
        return { udp, tcp };
      };
      try {
        // 대조군: 키트 없이는 실제로 나간다. 시험 장치가 살아 있다는 뜻이다.
        expect((await counted(`<!doctype html><script>var c=${rtc};c.createDataChannel('x');c.createOffer().then(function(o){return c.setLocalDescription(o)})</script>`, true)).udp).toBeGreaterThan(0);
        expect((await counted(staticFrame)).udp).toBe(0);
        const dynamic = `<div id="d"></div><script>document.getElementById('d').innerHTML=${JSON.stringify(staticFrame).replaceAll("</", "<\\/")}</script>`;
        expect((await counted(dynamic)).udp).toBe(0);
        // 관찰자를 피하려는 시도: 같은 틱에 새 realm 에서 생성자 꺼내기, remove 바꿔치기, 그림자 DOM 에 숨기기.
        const syncRealm = `<script>Element.prototype.remove=function(){};var f=document.createElement('if'+'rame');document.body.append(f);var R=window[0].RTCPeerConnection;var c=new R({iceServers:[{urls:'stun:127.0.0.1:${stun.port}'}]});c.createDataChannel('x');c.createOffer().then(function(o){return c.setLocalDescription(o)})</script>`;
        expect((await counted(syncRealm)).udp).toBe(0);
        const shadow = `<div id="h"></div><script>try{document.getElementById('h').attachShadow({mode:'open'}).innerHTML=${JSON.stringify(staticFrame).replaceAll("</", "<\\\\/")}}catch(e){}</script>`;
        expect((await counted(shadow)).udp).toBe(0);
        const links = `<link rel="preconnect" href="http://127.0.0.1:${listener.port}"><LINK REL=dns-prefetch href="http://127.0.0.1:${listener.port}">`;
        expect((await counted(links)).tcp).toBe(0);
        const dynamicLink = `<script>var l=document.createElement('li'+'nk');l.rel='preconnect';l.href='http://127.0.0.1:${listener.port}';document.head.appendChild(l)</script>`;
        // 알려진 한계: WebKit 은 스크립트가 넣은 link 를 넣는 즉시 접속한다(TCP 1건, 요청 내용 없음). 관찰자는 그 뒤에 돈다. docs/spec.md 참고.
        expect((await counted(dynamicLink)).tcp).toBe(label === "webkit" ? 1 : 0);
      } finally {
        stun.close();
        listener.stop(true);
      }
    }, 60_000);

    test("주석·닫는 태그로 앞머리를 깨지 못한다", async () => {
      const page = await browser.newPage();
      for (const prefix of ["--></style></script></head>", "<!--", "</body></html>", "<plaintext>"]) {
        const run = await render(page, `${prefix}${PROBE}`);
        // 뒤의 글이 주석·plaintext 로 삼켜지면 스크립트가 안 돌 뿐 CSP 는 그대로다. 돌면 차단이 그대로여야 한다.
        for (const p of report(run)) {
          expect(p.fetch).toBe("차단");
          expect(p.first).toBe("Content-Security-Policy");
        }
        expect(run.messages.some((m) => typeof m.iamceoHeight === "number")).toBe(true);
      }
      await page.close();
    }, 60_000);

    test("빈 칸을 주소로 직접 열어도 서버 출처를 얻지 못한다", async () => {
      const page = await browser.newPage();
      const direct = await page.goto(`${base}${ARTIFACT_FRAME_PATH}`);
      expect(direct!.status()).toBe(200);
      expect(await page.evaluate(() => String(self.origin))).toBe("null");
      await page.close();
    }, 30_000);
  });
}

describe("키트", () => {
  test("폰 폭에서 가로로 넘치지 않고, 작성자 CSS 가 키트를 덮는다", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const body = `<style>.card{background:rgb(1,2,3)}</style><div class="grid"><div class="card">하나</div><div class="kpi"><b>12</b><small>수치</small></div></div><div class="compare"><div>가</div><div class="pick">나</div></div><table><tr><th>길고긴제목길고긴제목길고긴제목길고긴제목길고긴제목</th><th>둘</th></tr></table><ol class="steps"><li>첫째</li></ol><p class="callout warn">주의</p><span class="tag good">태그</span>
<script>var c=getComputedStyle(document.querySelector(".card"));var g=getComputedStyle(document.querySelector(".grid"));parent.postMessage({probe:{bg:c.backgroundColor,border:c.borderRadius,columns:g.gridTemplateColumns.split(" ").length,over:document.documentElement.scrollWidth>innerWidth}},"*")</script>`;
    const run = await render(page, body, 360);
    const [p] = report(run);
    expect(p).toEqual({ bg: "rgb(1, 2, 3)", border: "16px", columns: 1, over: false });
    await browser.close();
  }, 30_000);
});
