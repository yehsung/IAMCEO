// rollout 은 읽기만 한다. 누적 total_token_usage 는 문맥 크기가 아니므로 쓰지 않는다.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONTEXT_SESSION_RE } from "./statusline.ts";
import { validWindow, type ContextReading } from "./context.ts";

const paths = new Map<string, string>();
const TAIL_BYTES = 128 * 1024;
// session_meta 는 지침도 담아 첫 줄이 길 수 있다. 경로 확인 때 한 번만 읽는다.
const META_BYTES = 1024 * 1024;
function slice(path: string, tail: boolean): string {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const start = tail ? Math.max(0, size - TAIL_BYTES) : 0;
    const bytes = Buffer.alloc(Math.min(size, tail ? TAIL_BYTES : META_BYTES));
    const text = bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, start)).toString("utf8");
    return start ? text.slice(text.indexOf("\n") + 1) : text;
  } finally { closeSync(fd); }
}

export function readCodexContext(home: string, sessionId: string): ContextReading | null {
  if (!CONTEXT_SESSION_RE.test(sessionId)) return null;
  const key = `${home}\0${sessionId}`;
  try {
    let path = paths.get(key);
    if (!path) {
      const glob = new Bun.Glob(`*/*/*/rollout-*-${sessionId}.jsonl`);
      for (const candidate of glob.scanSync({ cwd: join(home, "sessions"), absolute: true, onlyFiles: true })) {
        try {
          const meta = JSON.parse(slice(candidate, false).split("\n")[0]!);
          if (meta.type === "session_meta" && meta.payload?.id === sessionId) { path = candidate; break; }
        } catch { /* 부분 기록·다른 세션 */ }
      }
      if (!path) return null;
      paths.set(key, path);
    }
    const lines = slice(path, true).split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const line = JSON.parse(lines[i]!);
        if (line.type !== "event_msg" || line.payload?.type !== "token_count") continue;
        const info = line.payload.info;
        if (!validWindow(info?.model_context_window)) continue;
        const usage = info.last_token_usage;
        const tokens = usage?.total_tokens ?? (typeof usage?.input_tokens === "number" && typeof usage?.output_tokens === "number" ? usage.input_tokens + usage.output_tokens : null);
        const lastTokens = typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : null;
        // TUI 예약량 계산을 가정하지 않는다. 마지막 요청 토큰 / 실측 창 크기.
        return { sessionId, tokens: lastTokens, shownPct: null, model: null, exact: { window: info.model_context_window, source: "codex" } };
      } catch { /* 마지막 줄이 아직 덜 써졌으면 앞의 완성된 이벤트를 쓴다. */ }
    }
  } catch { paths.delete(key); }
  return null;
}
