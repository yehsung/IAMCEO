// 앱 틀: 프로젝트 목록 · 유리 탭 · 연결 끊김 띠 · 입력칸 자리. 데스크톱(≥1024)은 왼쪽 패널 + 위 탭, 그보다 좁으면 위 제목 + 아래 탭.
// 본문은 유리 탭·입력칸 밑으로 지나가며 스크롤한다(유리가 진짜로 비치도록). 그만큼의 여백은 --top-h · --bottom-h 로 잰다.
// 본문 스크롤 요소에는 data-scroll-root 가 있다(대화 화면의 맨 아래 붙이기 등).
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ProjectSummary } from "@shared/types";
import { Glass, GlassTabs, LocalLight, type GlassTab } from "../glass";
import {
  clearNotice,
  reconnectNow,
  routeHash,
  tabsFor,
  useBootstrap,
  useProject,
  useRoute,
  useStore,
  useSummary,
  type Tab,
} from "../lib/store";
import Composer from "./Composer";
import NewProject from "./NewProject";
import Files from "../screens/Files";
import Home from "../screens/Home";
import Inbox from "../screens/Inbox";
import Settings from "../screens/Settings";
import Team from "../screens/Team";
import Thread from "../screens/Thread";
import { Badge, MQ_DESKTOP, Sheet, useMediaQuery } from "./ui";

const TAB_LABEL: Record<Tab, string> = { home: "홈", inbox: "결재함", team: "팀", thread: "대화", files: "자료" };
const SCREENS: Record<Tab, () => ReactNode> = { home: Home, inbox: Inbox, team: Team, thread: Thread, files: Files };

/** 머리줄의 지금 상황은 한 줄 글이다. 총괄이 쓴 마크다운 기호를 그대로 보이지 않는다. */
const plainNow = (now: string): string => now.replace(/[*_`#]+/g, "").trim();

/** 잠깐의 끊김(화면 복귀·서버 재시작)에 띠가 번쩍이지 않게 기다린다 */
const OFFLINE_GRACE_MS = 1500;

function ProjectTabs({ refract }: { refract: boolean }) {
  const route = useRoute();
  const summary = useSummary();
  // 홈은 내 할 일, 결재함은 결재와 승인 창 앞 세션을 센다.
  const counts: Partial<Record<Tab, number>> = {
    home: summary?.todoCount ?? 0,
    inbox: (summary?.decisionCount ?? 0) + (summary?.blockedCount ?? 0),
  };
  const tabs: GlassTab[] = tabsFor(route.projectId).map((t) => ({
    key: t,
    href: routeHash({ projectId: route.projectId, tab: t }),
    label: (
      <span className="gtabs__label">
        {TAB_LABEL[t]}
        {counts[t] ? <span className="gtabs__count t-tabular">{counts[t]}</span> : null}
      </span>
    ),
  }));
  // key: 칸 수가 바뀌면(본사 4 · 프로젝트 5) 물방울 크기가 달라져 굴절 맵을 새로 만들어야 한다
  return <GlassTabs key={tabs.length} tabs={tabs} active={route.tab} ariaLabel="화면" refract={refract} className="shell-tabs" />;
}

function ProjectList({ onPicked, onAdd }: { onPicked?: () => void; onAdd: () => void }) {
  const bootstrap = useBootstrap();
  const route = useRoute();
  const projects = bootstrap?.projects ?? [];
  const hq = projects.filter((p) => p.isHq);
  const rest = projects.filter((p) => !p.isHq);
  const row = (p: ProjectSummary) => {
    const on = !route.settings && p.id === route.projectId;
    return (
      <li key={p.id}>
        <a
          className="pj"
          href={routeHash({ projectId: p.id, tab: tabsFor(p.id).includes(route.tab) ? route.tab : "home" })}
          aria-current={on ? "page" : undefined}
          onClick={onPicked}
        >
          <span className="pj__main">
            <span className="pj__name">{p.name}</span>
            <span className="pj__sub">{projectLine(p)}</span>
          </span>
          {p.inboxCount + p.blockedCount > 0 ? (
            <Badge tone={p.blockedCount > 0 ? "danger" : "accent"} className="t-tabular">
              {p.inboxCount + p.blockedCount}
            </Badge>
          ) : null}
        </a>
      </li>
    );
  };
  return (
    <nav aria-label="프로젝트" className="pj-nav">
      <ul className="pj-list">{hq.map(row)}</ul>
      {rest.length > 0 ? <p className="pj-heading">프로젝트</p> : null}
      <ul className="pj-list">{rest.map(row)}</ul>
      <button type="button" className="pj pj--add" onClick={onAdd}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        새 프로젝트
      </button>
    </nav>
  );
}

function projectLine(p: ProjectSummary): string {
  // 대표가 풀어 줘야 하는 상태가 먼저다.
  if (p.blockedCount > 0) return `승인 창 앞 ${p.blockedCount}명`;
  if (p.errorCount > 0) return `오류 ${p.errorCount}명`;
  if (p.workingCount > 0) return `${p.workingCount}명 일하는 중`;
  if (!p.isHq && !p.runnerEnabled) return "총괄 시작 전";
  if (p.memberCount > 0) return `${p.memberCount}명 대기`;
  return "대기";
}

function ConnectionMark() {
  const connection = useStore((s) => s.connection);
  const text = connection === "online" ? "서버 연결됨" : connection === "connecting" ? "서버 연결 중" : "서버 끊김";
  return (
    <span className="conn" data-state={connection}>
      <i aria-hidden="true" />
      {text}
    </span>
  );
}

function OfflineBand() {
  const connection = useStore((s) => s.connection);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (connection !== "offline") {
      setShow(false);
      return;
    }
    const t = setTimeout(() => setShow(true), OFFLINE_GRACE_MS);
    return () => clearTimeout(t);
  }, [connection]);
  if (!show) return null;
  return (
    <div className="offline-band" role="status">
      <span>서버와 연결이 끊겼습니다. 다시 잇는 중입니다.</span>
      <button type="button" className="offline-band__retry" onClick={reconnectNow}>
        지금 다시 연결
      </button>
    </div>
  );
}

/** 입력칸 높이가 글에 따라 변하므로 본문 아래 여백을 실제 높이에 맞춘다 */
function useMeasuredVar(name: string) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const host = el?.closest<HTMLElement>(".shell");
    if (!el || !host) return;
    const ro = new ResizeObserver(() => host.style.setProperty(name, `${el.offsetHeight}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      host.style.removeProperty(name);
    };
  }, [name]);
  return ref;
}

/**
 * iOS 는 키보드가 떠도 100dvh 가 줄지 않는다. 보이는 영역 높이를 직접 재고, 키보드가 떠 있으면 아래 탭을 접는다.
 * Android Chrome(resizes-content)은 창 높이도 함께 줄어 둘을 빼면 언제나 0 이다. 입력칸에 초점이 없을 때의 전체 높이를 기준으로 잰다.
 */
function useVisualViewport(): boolean {
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    let fullHeight = window.innerHeight;
    const onRotate = () => {
      fullHeight = window.innerHeight;
    };
    const sync = () => {
      // 핀치 확대도 보이는 영역을 줄인다. 키보드가 아니므로 틀을 다시 짜지 않는다.
      if (Math.abs(vv.scale - 1) > 0.01) return;
      root.style.setProperty("--app-h", `${vv.height}px`);
      const typing = document.activeElement?.matches("input, textarea, select, [contenteditable]") ?? false;
      fullHeight = typing ? Math.max(fullHeight, window.innerHeight) : window.innerHeight;
      setKeyboard(typing && fullHeight - vv.height > 120);
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    // 초점이 옮겨 가면 키보드 판단이 바뀐다.
    window.addEventListener("focusin", sync);
    window.addEventListener("focusout", sync);
    window.addEventListener("orientationchange", onRotate);
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
      window.removeEventListener("focusin", sync);
      window.removeEventListener("focusout", sync);
      window.removeEventListener("orientationchange", onRotate);
      root.style.removeProperty("--app-h");
    };
  }, []);
  return keyboard;
}

/** 결정할 일을 탭 제목과 앱 배지로도 알린다. 다른 창을 보고 있어도 눈에 띈다. */
function useInboxTitle(): void {
  // 승인 창 앞에서 멈춘 세션도 대표가 할 일이다.
  const total = useBootstrap()?.projects.reduce((n, p) => n + p.inboxCount + p.blockedCount, 0) ?? 0;
  useEffect(() => {
    document.title = total > 0 ? `(${total}) IAMCEO` : "IAMCEO";
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    void (total > 0 ? nav.setAppBadge?.(total) : nav.clearAppBadge?.())?.catch(() => {});
  }, [total]);
}

function NoticeBand() {
  const notice = useStore((s) => s.notice);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(clearNotice, 6000);
    return () => clearTimeout(t);
  }, [notice]);
  return notice ? (
    <div className="offline-band" role="status">
      <span>{notice}</span>
    </div>
  ) : null;
}

function Body() {
  const route = useRoute();
  const project = useProject();
  const loading = useStore((s) => s.projectLoading);
  const error = useStore((s) => s.projectError);
  if (route.settings) return <Settings />;
  if (!project || project.project.id !== route.projectId) {
    return <p className="body-note">{error ?? (loading ? "불러오는 중입니다" : "")}</p>;
  }
  const Screen = SCREENS[route.tab];
  return <Screen />;
}

function Scroller() {
  const route = useRoute();
  const ref = useRef<HTMLDivElement>(null);
  // 보던 위치는 화면마다 다르다: 탭·프로젝트가 바뀌면 맨 위부터. 대화는 바닥에서 시작하며 자기가 잡는다(부모 효과가 자식보다 늦게 돈다).
  useEffect(() => {
    if (route.tab !== "thread" || route.settings) ref.current?.scrollTo(0, 0);
  }, [route.projectId, route.tab, route.settings]);
  return (
    <div
      ref={ref}
      className="shell__body"
      data-scroll-root=""
      onScroll={(e) => e.currentTarget.closest(".shell")?.toggleAttribute("data-scrolled", e.currentTarget.scrollTop > 4)}
    >
      <div className="shell__column">
        <Body />
      </div>
    </div>
  );
}

function SettingsLink({ onPicked }: { onPicked?: () => void }) {
  const { settings: on, projectId } = useRoute();
  return (
    <a className="pj pj--foot" href={routeHash({ projectId, tab: "home", settings: true })} aria-current={on ? "page" : undefined} onClick={onPicked}>
      설정
    </a>
  );
}

function DesktopShell({ onAdd }: { onAdd: () => void }) {
  const route = useRoute();
  const summary = useSummary();
  const topRef = useMeasuredVar("--top-h");
  const bottomRef = useMeasuredVar("--bottom-h");
  const title = route.settings ? "설정" : (summary?.name ?? "");
  // 홈·팀 화면은 지금 상황을 판으로 크게 보여 주므로 머리줄에 또 쓰지 않는다
  const now = route.settings || route.tab === "team" || route.tab === "home" ? "" : plainNow(summary?.now ?? "");
  return (
    <div className="shell shell--desk">
      <Glass as="aside" level="regular" tint className="rail" aria-label="프로젝트 목록">
        <div className="rail__brand">
          <BrandMark />
          IAMCEO
        </div>
        <div className="rail__scroll">
          <ProjectList onAdd={onAdd} />
        </div>
        <div className="rail__foot">
          <SettingsLink />
          <ConnectionMark />
        </div>
      </Glass>
      <main className="shell__stage">
        <LocalLight tone="violet" x="60%" y="0%" size="min(980px, 80%)" aspect={0.42} strength={0.34} />
        <LocalLight tone="orchid" x="66%" y="100%" size="min(860px, 70%)" aspect={0.38} strength={0.28} />
        <Scroller />
        <div ref={topRef} className="shell__top">
          <div className="shell__headline">
            <h1 className="shell__title">{title}</h1>
            {now ? <p className="shell__now" title={now}>{now}</p> : null}
          </div>
          {route.settings ? <span /> : <ProjectTabs refract />}
          <span className="shell__top-spacer" />
          <NoticeBand />
          <OfflineBand />
        </div>
        <div ref={bottomRef} className="shell__bottom">
          {route.settings ? null : <Composer />}
        </div>
      </main>
    </div>
  );
}

function PhoneShell({ onAdd }: { onAdd: () => void }) {
  const route = useRoute();
  const summary = useSummary();
  const bootstrap = useBootstrap();
  const keyboard = useVisualViewport();
  const [sheet, setSheet] = useState(false);
  const topRef = useMeasuredVar("--top-h");
  const bottomRef = useMeasuredVar("--bottom-h");
  const title = route.settings ? "설정" : (summary?.name ?? "");
  const elsewhere = (bootstrap?.projects ?? []).reduce((n, p) => (p.id === route.projectId ? n : n + p.inboxCount + p.blockedCount), 0);
  return (
    <div className="shell shell--phone" data-keyboard={keyboard ? "" : undefined}>
      <LocalLight tone="violet" x="50%" y="100%" size="150%" aspect={0.62} strength={0.34} />
      <LocalLight tone="orchid" x="86%" y="0%" size="110%" aspect={0.5} strength={0.2} />
      <Scroller />
      <div ref={topRef} className="shell__top">
        <Glass as="header" level="thin" className="ph-head" style={{ "--g-tint": "rgb(16 11 38 / .55)" } as CSSProperties}>
          <button type="button" className="ph-switch" aria-haspopup="dialog" aria-expanded={sheet} onClick={() => setSheet(true)}>
            <span className="ph-switch__name">{title}</span>
            {elsewhere > 0 ? (
              <Badge tone="accent" className="t-tabular">
                {elsewhere}
              </Badge>
            ) : null}
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <ConnectionMark />
        </Glass>
        {!route.settings && route.tab !== "team" && route.tab !== "home" && summary?.now ? <p className="ph-now">{plainNow(summary.now)}</p> : null}
        <NoticeBand />
        <OfflineBand />
      </div>
      <div ref={bottomRef} className="shell__bottom">
        {route.settings ? null : <Composer />}
        {route.settings || keyboard ? null : <ProjectTabs refract={false} />}
      </div>
      <Sheet open={sheet} onClose={() => setSheet(false)} title="프로젝트">
        <ProjectList
          onPicked={() => setSheet(false)}
          onAdd={() => {
            setSheet(false);
            onAdd();
          }}
        />
        <div className="sheet-foot">
          <SettingsLink onPicked={() => setSheet(false)} />
        </div>
      </Sheet>
    </div>
  );
}

function BrandMark() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" className="brand-mark">
      <defs>
        <linearGradient id="brand-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#CDBEFF" />
          <stop offset="1" stopColor="#7A5BFF" />
        </linearGradient>
      </defs>
      <rect x="1" y="5" width="18" height="10" rx="5" fill="url(#brand-g)" />
    </svg>
  );
}

export default function Shell() {
  const desktop = useMediaQuery(MQ_DESKTOP);
  const [adding, setAdding] = useState(false);
  const add = () => setAdding(true);
  useInboxTitle();
  return (
    <>
      {desktop ? <DesktopShell onAdd={add} /> : <PhoneShell onAdd={add} />}
      <NewProject open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
