// glass/AuroraField.tsx — 바탕 오로라 장(랜딩 설계 §4.1). App 이 한 번 마운트한다(페이지마다 두지 말 것).
// position:fixed 전체 화면 층(z -1): 큰 빛 덩어리 다섯(violet 가장 크게 · orchid · indigo 아래 · violet 왼쪽 · rose 작게) +
// 노이즈 결. 빛은 부드러운 방사 그라디언트(filter:blur 없음), transform 으로 40–70초 주기 표류. 탭 숨김·감속 모션이면 정지.
import { useEffect, type CSSProperties } from 'react';

type Blob = { c: string; a: number; x: string; y: string; w: string; h: string; drift: 'aurora-a' | 'aurora-b' | 'aurora-c'; dur: number; delay: number };

/** 1440×900 기준 배치. 랜딩과 같은 자리·색이되 업무 화면의 글 대비를 위해 세기(a)는 CSS --aurora-k 로 낮춘다. */
const BLOBS: Blob[] = [
  { c: 'var(--violet-rgb)', a: 0.5, x: '66%', y: '34%', w: '92vmax', h: '68vmax', drift: 'aurora-a', dur: 58, delay: -12 },
  { c: 'var(--orchid-rgb)', a: 0.34, x: '92%', y: '8%', w: '54vmax', h: '42vmax', drift: 'aurora-b', dur: 47, delay: -20 },
  { c: 'var(--indigo-rgb)', a: 0.42, x: '20%', y: '96%', w: '86vmax', h: '56vmax', drift: 'aurora-c', dur: 66, delay: -8 },
  { c: 'var(--violet-rgb)', a: 0.24, x: '4%', y: '30%', w: '52vmax', h: '52vmax', drift: 'aurora-b', dur: 53, delay: -31 },
  { c: 'var(--rose-rgb)', a: 0.13, x: '80%', y: '84%', w: '32vmax', h: '24vmax', drift: 'aurora-a', dur: 41, delay: -5 },
];

/** 탭이 숨으면 <html data-tab-hidden> → 표류(animation)를 멈춘다. */
function useAuroraPause() {
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => root.toggleAttribute('data-tab-hidden', document.visibilityState === 'hidden');
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      root.removeAttribute('data-tab-hidden');
    };
  }, []);
}

export function AuroraField() {
  useAuroraPause();
  return (
    <div aria-hidden="true" className="aurora" data-aurora="">
      {BLOBS.map((b, i) => (
        <i
          key={i}
          className="aurora__blob"
          style={
            {
              '--c': b.c,
              '--a': `calc(${b.a} * var(--aurora-k, 1))`,
              '--x': b.x,
              '--y': b.y,
              '--w': b.w,
              '--h': b.h,
              '--drift': b.drift,
              '--dur': `${b.dur}s`,
              '--delay': `${b.delay}s`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
