// 아티팩트(자료의 한 페이지 HTML)를 격리 칸에 그리는 원본. 서버와 화면이 함께 쓴다. 브라우저에서도 돌아야 하므로 node 모듈을 쓰지 않는다.
//
// 그리는 법(화면):
//   <iframe sandbox="allow-scripts" src="/artifact-frame"> 를 만든다. 부모 페이지의 CSP(script-src 'self')를 물려받는 srcdoc 은 인라인 스크립트가 돌지 않는다.
//   칸이 {iamceoFrameReady:true} 를 보내면(e.source 확인) GET /api/files/:id/artifact 로 받은 html 을
//   contentWindow.postMessage({iamceoSrcdoc: buildArtifactSrcdoc(html, {title})}, "*") 로 넣는다.
//   칸은 {iamceoHeight:n}·{iamceoLink:url}·{iamceoEscape:true} 를 보낸다(e.source 확인·값 검사 뒤에만 쓴다. 작성자 글도 보낼 수 있다). sandbox 에 allow-same-origin·allow-top-navigation 을 넣지 않는다.

/**
 * 칸 안에서 쓸 수 있는 것. 일반 요청(fetch·이미지 등)·폼 제출은 막고, 인라인 스크립트·스타일과 data: 자원만 허용한다.
 * CSP 로 못 막는 길이 있다: WebRTC(STUN UDP)는 Chromium·WebKit 모두 나가고 WebKit 은 preconnect TCP 도 나간다(실측). 그래서 앞머리에서 RTCPeerConnection 을 지우고, 중첩 칸(새 realm)과 link 를 글에서 무력화하고 스크립트로 넣어도 지운다. 중첩 칸은 서로 다른 불투명 출처라 부모 스크립트가 꺼내 쓰지 못한다. 그래도 WebKit 은 스크립트가 넣은 link 로 넣는 즉시 TCP 로 접속하고(실측, 요청 내용 없음) 이는 페이지 쪽에서 막을 방법이 없으므로 민감한 데이터는 아티팩트에 싣지 않는다.
 */
export const ARTIFACT_CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

/** 빈 칸의 주소와 iframe sandbox 값. */
export const ARTIFACT_FRAME_PATH = "/artifact-frame";
export const ARTIFACT_SANDBOX = "allow-scripts";

// 모든 선택자를 :where 로 감싸 우선순위를 0 으로 둔다. 작성자 CSS 가 무엇이든 키트를 덮는다.
export const ARTIFACT_KIT_CSS = `
:where(*,*::before,*::after){box-sizing:border-box}
:where(html){color-scheme:dark;-webkit-text-size-adjust:100%}
:where(body){margin:0;padding:24px;background:#090713;color:#F5F2FF;font:15px/1.65 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR","Segoe UI",sans-serif;word-break:keep-all;overflow-wrap:anywhere}
:where(h1,h2,h3,h4){margin:1.6em 0 .6em;line-height:1.3;font-weight:650;color:#F5F2FF}
:where(h1){font-size:1.6rem;margin-top:0}
:where(h2){font-size:1.25rem}
:where(h3){font-size:1.05rem}
:where(h4){font-size:.95rem;color:#C2BBDF}
:where(p,ul,ol,dl,blockquote,pre,table,figure){margin:0 0 1em}
:where(ul,ol){padding-left:1.4em}
:where(li+li){margin-top:.25em}
:where(a){color:#B9A8FF}
:where(strong){color:#F5F2FF}
:where(hr){border:0;border-top:1px solid rgba(255,255,255,.12);margin:1.5em 0}
:where(blockquote){padding:.2em 0 .2em 1em;border-left:3px solid rgba(185,168,255,.5);color:#C2BBDF}
:where(img,svg,video,canvas){max-width:100%;height:auto}
:where(code,kbd,samp){font:.9em/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:rgba(255,255,255,.08);padding:.1em .35em;border-radius:5px}
:where(pre){padding:14px 16px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:12px;overflow:auto}
:where(pre code){background:none;padding:0}
:where(table){width:100%;border-collapse:collapse;font-size:.93em;display:block;overflow-x:auto}
:where(.kit-table){margin:0 0 1em;overflow-x:auto}
:where(.kit-table>table){display:table;margin:0}
:where(th,td){padding:9px 12px;border-bottom:1px solid rgba(255,255,255,.1);text-align:left;vertical-align:top;overflow-wrap:break-word}
:where(th){color:#C2BBDF;font-weight:600;background:rgba(255,255,255,.04);white-space:nowrap}
:where(.card){padding:18px 20px;margin:0 0 14px;background:linear-gradient(160deg,rgba(255,255,255,.08),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.12);border-radius:16px;box-shadow:0 8px 24px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.1)}
:where(.card>:last-child,.callout>:last-child){margin-bottom:0}
:where(.card>:first-child,.callout>:first-child){margin-top:0}
:where(.grid){display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 14px}
:where(.grid>.card){margin:0}
:where(.callout){padding:14px 16px;margin:0 0 14px;background:rgba(185,168,255,.1);border:1px solid rgba(185,168,255,.28);border-left-width:4px;border-radius:12px}
:where(.callout.warn){background:rgba(255,183,77,.1);border-color:rgba(255,183,77,.35)}
:where(.callout.bad){background:rgba(255,107,107,.1);border-color:rgba(255,107,107,.35)}
:where(.callout.good){background:rgba(92,214,160,.1);border-color:rgba(92,214,160,.35)}
:where(.kpi){display:flex;flex-direction:column;gap:4px;padding:16px 18px;background:linear-gradient(160deg,rgba(255,255,255,.08),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.12);border-radius:16px}
:where(.kpi b,.kpi strong){font-size:1.7rem;line-height:1.2;font-weight:680;color:#F5F2FF;font-variant-numeric:tabular-nums}
:where(.kpi small,.kpi span){color:#A9A2C9;font-size:.85em}
:where(.steps){list-style:none;counter-reset:step;padding:0;margin:0 0 14px}
:where(.steps>li){counter-increment:step;position:relative;padding:0 0 14px 40px;margin:0}
:where(.steps>li)::before{content:counter(step);position:absolute;left:0;top:0;width:26px;height:26px;display:grid;place-items:center;border-radius:50%;background:rgba(185,168,255,.18);color:#D5CBFF;font-size:.82em;font-weight:650}
:where(.steps>li:not(:last-child))::after{content:"";position:absolute;left:12.5px;top:30px;bottom:4px;width:1px;background:rgba(255,255,255,.14)}
:where(.tag){display:inline-block;padding:.1em .6em;border-radius:999px;font-size:.8em;line-height:1.6;background:rgba(255,255,255,.1);color:#C2BBDF;border:1px solid rgba(255,255,255,.12)}
:where(.tag.good){background:rgba(92,214,160,.16);color:#9ee8c6}
:where(.tag.warn){background:rgba(255,183,77,.16);color:#ffd08a}
:where(.tag.bad){background:rgba(255,107,107,.16);color:#ffb0b0}
:where(.compare){display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin:0 0 14px}
:where(.compare>*){padding:16px 18px;margin:0;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:14px}
:where(.compare>.pick){border-color:rgba(185,168,255,.55);background:rgba(185,168,255,.1)}
:where(.compare>*>:last-child){margin-bottom:0}
:where(.compare>*>:first-child){margin-top:0}
:where(.flow){display:flex;flex-wrap:wrap;gap:10px 26px;list-style:none;padding:0;margin:0 0 14px}
:where(.flow>*){position:relative;flex:1 1 130px;margin:0;padding:12px 14px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:12px}
:where(.flow>*:not(:last-child))::after{content:"→";position:absolute;right:-20px;top:50%;transform:translateY(-50%);color:#A9A2C9}
:where(.flow>*>:last-child){margin-bottom:0}
:where(.flow>*>:first-child){margin-top:0}
:where(button){font:inherit;color:inherit}
:where(.tabs){display:flex;flex-wrap:wrap;gap:4px;padding:4px;margin:0 0 14px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:14px}
:where(.tabs>button){flex:1 1 auto;min-height:44px;padding:0 14px;background:none;border:0;border-radius:10px;color:#C2BBDF;font-weight:600;cursor:pointer}
:where(.tabs>button:hover){background:rgba(255,255,255,.06)}
:where(.tabs>button[aria-selected="true"]){background:rgba(122,91,255,.42);color:#fff}
@media (max-width:520px){:where(body){padding:16px;font-size:14.5px}:where(h1){font-size:1.35rem}:where(.grid,.compare){grid-template-columns:1fr}:where(.flow){flex-direction:column;gap:22px}:where(.flow>*){flex:none}:where(.flow>*:not(:last-child))::after{content:"↓";right:auto;left:50%;top:auto;bottom:-22px;transform:translateX(-50%)}}
`.trim();

// 칸의 앞머리 스크립트. 작성자 스크립트보다 먼저 돌아 ResizeObserver·postMessage 를 바꿔치기 전에 잡아 둔다.
// - 높이: body 기준으로 잰다. documentElement.scrollHeight 는 칸 높이 아래로 내려가지 않아, 탭을 바꿔 글이 짧아져도 칸이 안 줄어든다.
// - 표: 가로 스크롤 상자로 감싼다. 표 자체를 display:block 으로 두면 칸 폭을 채우지 못한다.
// - 링크: 칸이 바깥 주소로 넘어가면(부모 CSP 가 막아) 빈 칸이 된다. 대신 부모에게 알려 대표가 열지 고르게 한다. # 링크는 그대로 둔다.
// - Esc: 초점이 칸 안이면 전체 화면이 안 닫힌다.
// - WebRTC·preconnect: CSP 로 안 막히므로 생성자를 지우고, 나중에 들어온 중첩 칸·link 를 지운다(보조책, ARTIFACT_CSP 설명 참고).
//   관찰자가 못 보는 그림자 DOM 과, 조각내 칸을 숨겨 넣을 수 있는 document.write 도 함께 지운다.
const HEIGHT_SCRIPT = `(function(){["RTCPeerConnection","webkitRTCPeerConnection"].forEach(function(k){try{delete window[k];window[k]=undefined}catch(e){}});var Q="iframe,frame,link",E=Element.prototype,Rm=E.remove,Mt=E.matches,Qa=E.querySelectorAll;function strip(n){if(n.nodeType!==1)return;if(Mt.call(n,Q))Rm.call(n);else Qa.call(n,Q).forEach(function(x){Rm.call(x)})}new MutationObserver(function(l){l.forEach(function(r){r.addedNodes.forEach(strip)})}).observe(document,{childList:true,subtree:true});[[E,"attachShadow"],[E,"setHTMLUnsafe"],[Document,"parseHTMLUnsafe"],[Document.prototype,"write"],[Document.prototype,"writeln"]].forEach(function(x){try{delete x[0][x[1]]}catch(e){}});var P=parent,O=ResizeObserver,last=-1,S=getComputedStyle;function send(){var b=document.body,d=document.documentElement,n=0;if(b){var c=S(b);n=b.scrollHeight+(parseFloat(c.marginTop)||0)+(parseFloat(c.marginBottom)||0)}else if(d){n=d.scrollHeight}n=Math.ceil(n);if(n!==last){last=n;P.postMessage({iamceoHeight:n},"*")}}var r=new O(send);if(document.documentElement)r.observe(document.documentElement);send();addEventListener("DOMContentLoaded",function(){if(document.body)r.observe(document.body);document.querySelectorAll("table").forEach(function(t){if(t.parentElement&&t.parentElement.classList.contains("kit-table"))return;var w=document.createElement("div");w.className="kit-table";t.parentNode.insertBefore(w,t);w.appendChild(t)});send()});addEventListener("load",send);addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;var h=a.getAttribute("href")||"";if(h.charAt(0)==="#")return;e.preventDefault();P.postMessage({iamceoLink:a.href},"*")},true);addEventListener("keydown",function(e){if(e.key==="Escape")P.postMessage({iamceoEscape:true},"*")},true)})()`;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export interface ArtifactOpts {
  title?: string;
  lang?: string;
}

/**
 * 격리 칸에 넣을 전체 문서. CSP 메타가 문서의 가장 앞에 오고 키트·높이 보고가 뒤따른 다음 작성자 글이 온다.
 * 앞머리는 고정 글이고 작성자 글은 언제나 그 뒤라, <!doctype>·<html>·<head>·주석·닫는 태그를 어떻게 써도 메타보다 앞서지 못한다.
 * 브라우저는 그 뒤의 doctype·html·head 시작 태그를 무시하므로 온전한 문서를 그대로 줘도 된다. 작성자가 넣은 CSP 는 더 조일 수만 있다.
 */
export function buildArtifactSrcdoc(html: string, opts: ArtifactOpts = {}): string {
  const lang = /^[A-Za-z-]{1,20}$/.test(opts.lang ?? "") ? opts.lang! : "ko";
  const head = [
    `<!doctype html><html lang="${lang}"><head>`,
    `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`,
    `<meta http-equiv="x-dns-prefetch-control" content="off"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`,
    opts.title ? `<title>${escapeHtml(opts.title)}</title>` : "",
    `<style>${ARTIFACT_KIT_CSS}</style>`,
    `<script>${HEIGHT_SCRIPT}</script>`,
    `</head><body>`,
  ].join("");
  // 널 글자는 파서마다 다르게 다룬다. 작성자 글에 쓸 일이 없다.
  // 중첩 칸은 지운 RTCPeerConnection 이 살아 있는 새 realm 이고, link 는 파서가 넣는 즉시 preconnect 가 나간다. CSP 아래 둘 다 쓸모가 없으니 파서에 닿기 전에 이름을 바꾼다.
  const body = html.replaceAll("\0", "").replace(/<(\/?)(iframe|frameset|frame|link)(?=[\s/>])/gi, "<$1x-blocked-$2");
  return `${head}${body}</body></html>`;
}
