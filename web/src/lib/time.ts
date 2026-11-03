// 시각 표시. 저장은 ISO UTC, 표시는 언제나 KST.
const KST = "Asia/Seoul";
const fmtDay = new Intl.DateTimeFormat("en-CA", { timeZone: KST, year: "numeric", month: "2-digit", day: "2-digit" });
const fmtClock = new Intl.DateTimeFormat("en-GB", { timeZone: KST, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const fmtFull = new Intl.DateTimeFormat("ko-KR", { timeZone: KST, dateStyle: "long", timeStyle: "short" });

const parse = (iso: string): Date | null => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** 오늘이면 15:04, 올해면 11월 2일 15:04, 그 전이면 2025년 11월 2일 15:04 */
export function formatTime(iso: string, now: Date = new Date()): string {
  const d = parse(iso);
  if (!d) return "";
  const clock = fmtClock.format(d);
  const key = fmtDay.format(d); // 2026-11-02
  const nowKey = fmtDay.format(now);
  if (key === nowKey) return clock;
  const [y, m, day] = key.split("-").map(Number) as [number, number, number];
  const date = `${m}월 ${day}일`;
  return key.slice(0, 4) === nowKey.slice(0, 4) ? `${date} ${clock}` : `${y}년 ${date} ${clock}`;
}

/** 방금 · 3분 전 · 2시간 전, 하루가 넘으면 formatTime */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const d = parse(iso);
  if (!d) return "";
  const sec = Math.round((now.getTime() - d.getTime()) / 1000);
  if (sec < 60) return "방금";
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  return formatTime(iso, now);
}

/** 마우스를 올렸을 때 보여 줄 전체 시각 */
export function formatFull(iso: string): string {
  const d = parse(iso);
  return d ? fmtFull.format(d) : "";
}
