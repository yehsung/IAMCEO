import Foundation

/// The web board's artifact kit, for the native protected preview. Staff write artifacts against it (dark page, 15/1.65
/// body, `.card` `.grid` `.kpi` `.callout` `.compare` `.steps` `.flow` `.tag` `.tabs` and table styles), so an artifact
/// shown without it falls back to WebKit defaults (white page, serif text, no cards).
///
/// `css` is `ARTIFACT_KIT_CSS` from shared/artifact-kit.ts, character for character (ArtifactKitTests compares them).
/// Every selector sits in `:where()`, so the author's own CSS always wins.
enum ArtifactKit {
    static let css = """
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
"""

    /// Inline scripts run only inside sandbox="allow-scripts"; no origin, network, form or base access.
    static let policy = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'\">"

    /// Put the native policy and kit before any author markup. Never load this outside sandboxDocument.
    static func document(_ html: String, title: String? = nil) -> String {
        var head = "<!doctype html><html lang=\"ko\"><head>" + policy
        head += "<meta http-equiv=\"x-dns-prefetch-control\" content=\"off\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        if let title, !title.isEmpty { head += "<title>" + escape(title) + "</title>" }
        head += "<style>" + css + "</style>"
        // CSP cannot stop STUN. Disable WebRTC in the page realm before author scripts, as the server kit does.
        head += "<script>" + isolationScript + "</script></head><body>"
        var body = html.replacingOccurrences(of: "\u{0}", with: "")
        body = blocked.stringByReplacingMatches(in: body, range: NSRange(body.startIndex..., in: body), withTemplate: "<$1x-blocked-$2")
        return head + body + "</body></html>"
    }

    /// srcdoc has an opaque origin: no allow-same-origin, top navigation, forms, downloads or popups.
    /// The fetched render=1 response's CSP is enforced again here because URLSession headers do not follow HTML strings.
    static func sandboxDocument(_ html: String, title: String? = nil, fitted: Bool = false) -> String {
        let page = escape(document(html, title: title))
        return "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; frame-src about:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>html,body{margin:0;width:100%;height:100%;background:#090713}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><iframe id=\"artifact\" sandbox=\"allow-scripts\" referrerpolicy=\"no-referrer\" srcdoc=\"" + page + "\"></iframe></body></html>"
    }

    static func externalURL(_ value: String) -> URL? {
        guard let parts = URLComponents(string: value), let scheme = parts.scheme?.lowercased(),
              ["https", "http"].contains(scheme), let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil else { return nil }
        return parts.url
    }

    private static let isolationScript = #"""
    (function(){["RTCPeerConnection","webkitRTCPeerConnection"].forEach(function(k){try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false})}catch(e){}});var E=Element.prototype;[[E,"attachShadow"],[E,"setHTMLUnsafe"],[Document,"parseHTMLUnsafe"],[Document.prototype,"write"],[Document.prototype,"writeln"]].forEach(function(x){try{delete x[0][x[1]]}catch(e){}});var q=E.querySelectorAll,m=E.matches,r=E.remove;new MutationObserver(function(list){list.forEach(function(c){c.addedNodes.forEach(function(n){if(n.nodeType!==1)return;if(m.call(n,"iframe,frame,link"))r.call(n);else q.call(n,"iframe,frame,link").forEach(function(e){r.call(e)})})})}).observe(document,{childList:true,subtree:true})})()
    """#

    private static let blocked = try! NSRegularExpression(pattern: "<(/?)(iframe|frameset|frame|link)(?=[\\s/>])", options: [.caseInsensitive])

    private static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }
}
