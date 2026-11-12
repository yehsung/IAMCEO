// D5: 앱이 보내는 버전 머리글을 읽고, 앱과 서버가 실제로 맞지 않을 때만 안내를 싣는다.
// 머리글이 없는 요청은 출시된 옛 앱(0.2.2·0.2.3)이다. 그 앱에는 새 필드를 하나도 싣지 않는다.
import { API_LEVEL, APP_HEADERS, MIN_APP_API_LEVEL, type AppClientInfo, type Bootstrap, type CompatNotice, type SeenAppClient } from "../shared/types.ts";

const VERSION_TEXT = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const BUILD_TEXT = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;

/**
 * 머리글에서 앱 정보를 읽는다. 버전·플랫폼·API 단계 가운데 하나라도 없거나 모양이 어긋나면 null(옛 앱처럼 다룬다).
 * 값은 로그와 진단에만 쓰고 그대로 응답에 되돌리지 않는다.
 */
export function readAppClient(headers: Headers): AppClientInfo | null {
  const version = headers.get(APP_HEADERS.version)?.trim() ?? "";
  const platform = headers.get(APP_HEADERS.platform)?.trim().toLowerCase() ?? "";
  const level = headers.get(APP_HEADERS.apiLevel)?.trim() ?? "";
  const build = headers.get(APP_HEADERS.build)?.trim() ?? "";
  if (!VERSION_TEXT.test(version) || (platform !== "macos" && platform !== "ios") || !/^[1-9][0-9]{0,3}$/.test(level)) return null;
  return { version, build: BUILD_TEXT.test(build) ? build : null, platform, apiLevel: Number(level) };
}

export interface CompatLevels { apiLevel: number; minAppApiLevel: number }
const LEVELS: CompatLevels = { apiLevel: API_LEVEL, minAppApiLevel: MIN_APP_API_LEVEL };

/** 앱 단계와 서버 단계를 견준다. 맞으면 null. levels 는 시험에서만 바꾼다. */
export function compatNotice(client: AppClientInfo, serverVersion: string, levels: CompatLevels = LEVELS): CompatNotice | null {
  if (client.apiLevel < levels.minAppApiLevel) {
    return { state: "app_outdated", message: client.platform === "ios"
      ? `이 앱(${client.version})은 서버(${serverVersion})보다 오래된 버전이라 맞지 않습니다. App Store에서 IAMCEO를 업데이트해 주세요.`
      : `이 앱(${client.version})은 서버(${serverVersion})보다 오래된 버전이라 맞지 않습니다. IAMCEO 앱을 최신 버전으로 업데이트해 주세요.` };
  }
  if (client.apiLevel > levels.apiLevel) {
    return { state: "server_outdated", message: `서버(${serverVersion})가 이 앱(${client.version})보다 오래된 버전이라 맞지 않습니다. 서버가 도는 Mac의 IAMCEO를 최신 버전으로 업데이트해 주세요.` };
  }
  return null;
}

/**
 * Bootstrap 에 덧붙일 선택 필드. 머리글이 없으면 빈 객체라 옛 앱의 응답은 한 글자도 바뀌지 않는다.
 * 머리글이 있으면 server 는 늘, compat 은 실제로 어긋날 때만.
 */
export function compatFields(client: AppClientInfo | null, serverVersion: string, levels: CompatLevels = LEVELS): Pick<Bootstrap, "server" | "compat"> {
  if (!client) return {};
  const compat = compatNotice(client, serverVersion, levels);
  return { server: { version: serverVersion, apiLevel: levels.apiLevel }, ...(compat ? { compat } : {}) };
}

/**
 * 이 서버 프로세스에 붙은 앱 버전들. 처음 보는 조합이면 서버 로그에 한 줄 남긴다(값은 머리글 검사를 통과한 짧은 글자뿐).
 * 대화·기기 식별 정보는 담지 않는다. 프로세스가 끝나면 사라진다.
 */
export class SeenApps {
  private readonly seen = new Map<string, SeenAppClient>();
  constructor(private readonly limit = 8, private readonly log: (line: string) => void = line => console.log(line), private readonly now: () => Date = () => new Date()) {}
  note(client: AppClientInfo | null): void {
    if (!client) return;
    const key = `${client.platform}/${client.version}/${client.build ?? ""}/${client.apiLevel}`;
    const first = !this.seen.has(key);
    this.seen.delete(key);
    this.seen.set(key, { ...client, lastSeenAt: this.now().toISOString() });
    while (this.seen.size > this.limit) this.seen.delete(this.seen.keys().next().value!);
    if (first) this.log(`앱 접속: ${client.platform} ${client.version}${client.build ? ` (빌드 ${client.build})` : ""} · API 단계 ${client.apiLevel}`);
  }
  list(): SeenAppClient[] { return [...this.seen.values()].reverse(); }
}
