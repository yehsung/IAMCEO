// glass/GlassTabs.tsx: 물방울 유리 탭(랜딩 FeatureStage 의 세그먼트). 칸은 링크라 주소·뒤로 가기·새 탭이 그대로 동작한다.
// 활성 칸이 바뀌면 물방울이 스프링으로 미끄러지고, 움직이는 동안 가로로 늘었다 줄어든다(WAAPI scale). 감속 모션이면 늘이지 않는다.
// refract 는 데스크톱 Chromium 에서만 실제로 켜지고 그 밖은 맑은 알약이다.
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { cx, glassClass } from "./Glass";
import { useRefraction } from "./useRefraction";

export interface GlassTab {
  key: string;
  label: ReactNode;
  href: string;
}

export function GlassTabs({
  tabs,
  active,
  ariaLabel,
  refract = true,
  className,
  onSelect,
}: {
  tabs: GlassTab[];
  active: string;
  ariaLabel: string;
  refract?: boolean;
  className?: string;
  onSelect?: (key: string) => void;
}) {
  const dropRef = useRef<HTMLSpanElement>(null);
  const index = Math.max(0, tabs.findIndex((t) => t.key === active));
  const prev = useRef(index);

  // 랜딩 값은 scale 30 이지만 여기는 칸에 배지가 있어, 가운데 글자가 림으로 끌려와 색 조각처럼 보였다(실측). 끌어오는 거리를 글자 앞까지로 줄인다.
  useRefraction(dropRef, { level: "regular", band: 12, scale: 18, aberration: 0.08, rimBlur: 0.5, enabled: refract });

  useEffect(() => {
    const from = prev.current;
    prev.current = index;
    const drop = dropRef.current;
    if (from === index || !drop || typeof drop.animate !== "function") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const sx = 1 + 0.16 * Math.min(Math.abs(index - from), 3);
    drop.animate(
      [{ scale: "1 1" }, { scale: `${sx} 0.84`, offset: 0.36 }, { scale: "1.02 0.98", offset: 0.7 }, { scale: "1 1" }],
      { duration: 620, easing: "cubic-bezier(.3,.7,.2,1)" },
    );
  }, [index]);

  return (
    <div className={cx("gtabs-wrap", className)} style={{ "--n": tabs.length, "--active": index } as CSSProperties}>
      <span aria-hidden="true" className="gtabs-glow" />
      <nav aria-label={ariaLabel} className={cx(glassClass("regular"), "gtabs")}>
        <span ref={dropRef} aria-hidden="true" className={cx(glassClass("regular"), "gtabs__drop")} />
        <ol className="gtabs__list">
          {tabs.map((t, i) => (
            <li key={t.key}>
              <a
                href={t.href}
                className="gtabs__link"
                aria-current={i === index ? "page" : undefined}
                onClick={onSelect ? () => onSelect(t.key) : undefined}
              >
                {t.label}
              </a>
            </li>
          ))}
        </ol>
      </nav>
    </div>
  );
}
