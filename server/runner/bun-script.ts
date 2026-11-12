// 훅·상태줄 스크립트를 Bun 으로 돌리는 명령의 앞부분(statusline.ts·hooks.ts·permission-hook.ts 가 함께 쓴다).
//
// Claude Code 는 이 명령들을 팀장의 작업 폴더(남이 만든 저장소일 수 있다)에서 돌린다. Bun 은 기본으로 작업 폴더의
// bunfig.toml(preload 포함)과 .env 를 읽는다. 그러면 그 저장소의 코드가 우리 스크립트보다 먼저 돌아 출력(승인 훅의 허용·거절 답)을
// 위조하거나 깨뜨리고, .env 의 HTTP_PROXY 같은 값이 이 Mac 의 서버로 가는 요청(팀장 열쇠가 실린)을 다른 곳으로 돌린다.
// 비어 있는 설정 파일(--config)과 --no-env-file 로 둘 다 막는다. 컴파일 실행 파일도 BUN_BE_BUN=1 이면 같은 Bun 명령이라 같게 듣는다.
import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** run/ 안의 빈 Bun 설정 파일. 작업 폴더의 bunfig.toml 대신 이것을 읽게 한다. */
export const EMPTY_BUNFIG = "iamceo-empty-bunfig.toml";

export function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }

/** run/iamceo-empty-bunfig.toml 이 비어 있게 둔다(없거나 누가 고쳤으면 다시 쓴다). 경로를 돌려준다. */
export function emptyBunfig(runDir: string): string {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const path = join(runDir, EMPTY_BUNFIG);
  let empty = false;
  try { empty = readFileSync(path, "utf8") === ""; } catch { /* 처음 */ }
  if (!empty) {
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    try { writeFileSync(tmp, "", { mode: 0o600 }); renameSync(tmp, path); }
    finally { try { unlinkSync(tmp); } catch { /* rename 성공 */ } }
  }
  chmodSync(path, 0o600);
  return path;
}

/**
 * `BUN_BE_BUN=1 <실행 파일> --config=<빈 설정> --no-env-file <스크립트>`. 스크립트 뒤의 인자와 셸 꼬리(출력 버리기, `; exit 0`)는 부르는 쪽이 붙인다.
 * 작업 폴더의 bunfig.toml·.env 를 읽지 않는다(위 설명).
 */
export function bunScriptCommand(execPath: string, runDir: string, script: string): string {
  return `BUN_BE_BUN=1 ${shellQuote(execPath)} --config=${shellQuote(emptyBunfig(runDir))} --no-env-file ${shellQuote(script)}`;
}
