import { classifyStorageError } from "./storage-errors.ts";

export interface CrashGuardOptions {
  /** 같은 오류가 짧은 시간에 쏟아질 때 한 번만 부른다. 정상 종료 절차를 밟고 내려가면 서비스 관리자가 다시 띄운다. */
  restart: (reason: string) => void;
  log?: (line: string) => void;
  now?: () => number;
  /** windowMs 안에 이 횟수를 넘으면 restart 를 부른다. */
  limit?: number;
  windowMs?: number;
}

type Kind = "uncaughtException" | "unhandledRejection";

/**
 * 타이머 콜백의 예외나 놓친 Promise 거부 한 번에 서버 전체가 죽지 않게 한다(Bun 은 둘 다 exit 1).
 * 기록하고 계속 돌되, 같은 창에서 계속 쏟아지면 상태가 어긋난 것으로 보고 정상 종료 절차로 내려간다.
 * 저장 공간·디스크 오류는 다시 띄워도 같은 자리에서 실패하므로 재시작 사유로 세지 않는다.
 */
export function createCrashGuard(options: CrashGuardOptions) {
  const log = options.log ?? (line => console.error(line));
  const now = options.now ?? Date.now;
  const limit = Math.max(1, options.limit ?? 20), windowMs = Math.max(1, options.windowMs ?? 10 * 60_000);
  const recent: number[] = [];
  const seen = new Map<string, { at: number; suppressed: number }>();
  let restarting = false;
  const handle = (kind: Kind, error: unknown): void => {
    try {
      const at = now();
      const name = error instanceof Error ? error.name : typeof error;
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      const storage = classifyStorageError(error);
      const key = `${kind}:${name}:${message}`;
      const before = seen.get(key);
      if (before && at - before.at < 60_000) before.suppressed++;
      else {
        if (seen.size >= 200) seen.clear();
        seen.set(key, { at, suppressed: 0 });
        const stack = error instanceof Error && error.stack ? error.stack.split("\n").slice(0, 12).join("\n") : `${name}: ${message}`;
        log(`[crash-guard] ${new Date(at).toISOString()} ${kind}${storage ? ` storage=${storage}` : ""}${before?.suppressed ? ` repeated=${before.suppressed}` : ""} — 서버는 계속 돕니다\n${stack}`);
      }
      if (storage || restarting) return;
      recent.push(at);
      while (recent.length && at - recent[0]! > windowMs) recent.shift();
      if (recent.length <= limit) return;
      restarting = true;
      const reason = `처리되지 않은 오류가 ${Math.round(windowMs / 60_000)}분 안에 ${recent.length}번 났습니다`;
      log(`[crash-guard] ${reason}. 정상 종료 절차로 다시 시작합니다`);
      options.restart(reason);
    } catch { /* 안전망 자체가 프로세스를 죽이면 안 된다 */ }
  };
  return {
    handle,
    /** 등록을 푸는 함수를 돌려준다. */
    install(target: Pick<NodeJS.Process, "on" | "off"> = process): () => void {
      const exception = (error: unknown) => handle("uncaughtException", error);
      const rejection = (error: unknown) => handle("unhandledRejection", error);
      target.on("uncaughtException", exception);
      target.on("unhandledRejection", rejection);
      return () => { target.off("uncaughtException", exception); target.off("unhandledRejection", rejection); };
    },
  };
}
