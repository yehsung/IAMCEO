// 공용 작은 컴포넌트: StatusDot · Badge · Markdown · Time · Modal · Sheet · Empty · copyText · useMediaQuery
import DOMPurify from "dompurify";
import { Marked } from "marked";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { MemberStatus } from "@shared/types";
import { cx, glassClass } from "../glass/Glass";
import { formatFull, formatRelative, formatTime } from "../lib/time";

// ---- 반응형 ----

export const MQ_DESKTOP = "(min-width: 1024px)";

export function useMediaQuery(query: string): boolean {
  const mql = useMemo(() => window.matchMedia(query), [query]);
  return useSyncExternalStore(
    (fn) => {
      mql.addEventListener("change", fn);
      return () => mql.removeEventListener("change", fn);
    },
    () => mql.matches,
  );
}

// ---- 상태 ----

export const STATUS_LABEL: Record<MemberStatus, string> = {
  working: "일하는 중",
  waiting: "내 답 기다림",
  idle: "대기",
  blocked: "승인 창 앞",
  asleep: "잠듦",
  offline: "안 보임",
  error: "오류",
};

export function StatusDot({ status, label = false, className }: { status: MemberStatus; label?: boolean; className?: string }) {
  return (
    <span className={cx("status", className)} data-status={status}>
      <i className="status__dot" aria-hidden="true" />
      <span className={label ? undefined : "sr-only"}>{STATUS_LABEL[status]}</span>
    </span>
  );
}

export type BadgeTone = "neutral" | "accent" | "ok" | "warn" | "danger";

export function Badge({ tone = "neutral", className, children }: { tone?: BadgeTone; className?: string; children: ReactNode }) {
  return (
    <span className={cx("badge", className)} data-tone={tone}>
      {children}
    </span>
  );
}

// ---- 마크다운 ----

// 링크는 앱 밖으로 연다(폰 PWA 에서 앱 창이 바깥 페이지로 넘어가면 돌아올 길이 없다)
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  const href = node.tagName === "A" ? node.getAttribute("href") : null;
  // #/ 로 시작하면 앱 안 이동이다(대화의 자료 링크).
  if (href && !href.startsWith("#/")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 같은 출처의 첨부와 data: 만 그림으로 그린다. 바깥 주소는 결재함을 여는 순간 요청이 나가므로 링크로 둔다. */
function isLocalImage(href: string): boolean {
  return /^data:image\//i.test(href) || (/^\/(?!\/)/.test(href) && !href.includes("\\"));
}

// 글 속의 꺾쇠는 글자다. HTML 로 해석하면 '<Button>' 같은 낱말이 사라지거나 진짜 버튼이 그려지고, 직원 글이 화면을 꾸밀 수 있다.
const markdown = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  tokenizer: {
    // 한국어의 범위 표기(3~5만원, 7~9일)가 취소선이 되어 '35만원 79일'로 읽힌다. 취소선은 ~~ 만 인정한다.
    del(src) {
      const m = /^~~(?=[^\s~])((?:[^~]|~(?!~))*?[^\s~])~~(?!~)/.exec(src);
      if (!m) return undefined;
      return { type: "del", raw: m[0], text: m[1]!, tokens: this.lexer.inlineTokens(m[1]!) };
    },
  },
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    image({ href, text }) {
      if (isLocalImage(href)) return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}">`;
      return `<a href="${escapeHtml(href)}">${escapeHtml(text || href)}</a>`;
    },
  },
});

export function renderMarkdown(text: string): string {
  const html = markdown.parse(text) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["target"],
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed", "video", "audio", "dialog", "svg", "math"],
    // style·class·id 가 있으면 직원 글이 화면 전체를 덮거나 결재 버튼을 가린다.
    FORBID_ATTR: ["style", "class", "id", "name", "srcset"],
  });
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className={cx("md", className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ---- 시각(KST) ----

export { formatRelative, formatTime };

export function Time({ iso, relative = false, className }: { iso: string | null | undefined; relative?: boolean; className?: string }) {
  if (!iso) return null;
  const text = relative ? formatRelative(iso) : formatTime(iso);
  if (!text) return null;
  return (
    <time dateTime={iso} title={formatFull(iso)} className={cx("t-tabular", className)}>
      {text}
    </time>
  );
}

// ---- 빈 화면 ----

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {children ? <div className="empty__body">{children}</div> : null}
    </div>
  );
}

// ---- 모달·시트 ----

// 네이티브 <dialog>: 상단 층(잘림·z-index 걱정 없음), 초점 가두기, Esc, 뒤 inert, 닫으면 초점 복귀를 브라우저가 맡는다.
function Dialog({
  open,
  onClose,
  title,
  className,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  className: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      // React 의 autoFocus 는 showModal 전에 돌아 무효가 된다
      // 지정이 없으면 판 자체로 옮긴다: 첫 버튼(닫기)에 초점 고리가 뜨지 않게
      (el.querySelector<HTMLElement>("[data-autofocus]") ?? el).focus();
    } else if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onDialogClose = () => closeRef.current();
    // 바깥(::backdrop)을 눌러 닫기: 눌린 곳과 뗀 곳이 모두 판 밖일 때만.
    // 글자를 끌어 선택하다 판 밖에서 놓으면 click 이 공통 조상인 dialog 로 오지만, 바깥을 누른 것이 아니다.
    let downOutside = false;
    const onDown = (e: MouseEvent) => {
      downOutside = e.target === el;
    };
    const onClick = (e: MouseEvent) => {
      if (e.target === el && downOutside) closeRef.current();
      downOutside = false;
    };
    el.addEventListener("close", onDialogClose);
    el.addEventListener("mousedown", onDown);
    el.addEventListener("click", onClick);
    return () => {
      el.removeEventListener("close", onDialogClose);
      el.removeEventListener("mousedown", onDown);
      el.removeEventListener("click", onClick);
    };
  }, []);

  return (
    <dialog ref={ref} tabIndex={-1} className={cx("dialog", className)} aria-label={title}>
      {open ? (
        <div className={cx(glassClass("thick", { tint: true }), "dialog__panel")}>
          {title ? (
            <header className="dialog__head">
              <h2 className="dialog__title">{title}</h2>
              <button type="button" className="dialog__close" aria-label="닫기" onClick={onClose}>
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                  <path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </header>
          ) : null}
          <div className="dialog__body">{children}</div>
          {footer ? <footer className="dialog__foot">{footer}</footer> : null}
        </div>
      ) : null}
    </dialog>
  );
}

export interface OverlayProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
}

/** 가운데 뜨는 판 */
export const Modal = (p: OverlayProps) => <Dialog {...p} className="dialog--modal" />;
/** 아래에서 올라오는 판(폰) */
export const Sheet = (p: OverlayProps) => <Dialog {...p} className="dialog--sheet" />;

// ---- 한 번 더 눌러 확인 ----

export const CONFIRM_MS = 4000;
/** 두 번째 누름을 확인으로 치기 전에 읽을 시간. 더블클릭은 이 안에 끝난다. */
export const CONFIRM_MIN_MS = 600;

/** 되돌리기 어려운 버튼. 첫 누름은 묻기만 하고, 읽을 틈이 지난 둘째 누름만 실행한다. 한동안 안 누르면 풀린다. */
export function useConfirmPress(): { armed: boolean; press: (run: () => void) => void } {
  const [armed, setArmed] = useState(false);
  const armedAt = useRef(0);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), CONFIRM_MS);
    return () => clearTimeout(t);
  }, [armed]);
  return {
    armed,
    press: (run) => {
      if (!armed) {
        armedAt.current = Date.now();
        setArmed(true);
        return;
      }
      if (Date.now() - armedAt.current < CONFIRM_MIN_MS) return;
      setArmed(false);
      run();
    },
  };
}

// ---- 복사 ----

/** 평문 http(Tailscale IP 접속)에서는 navigator.clipboard 가 없어 옛 방식으로 되돌아간다. */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 권한 거부면 아래 방식을 시도한다
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  // 모달 안에서 부르면 <dialog> 밖 요소는 inert 라 선택이 안 된다
  (document.querySelector("dialog[open]") ?? document.body).appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}
