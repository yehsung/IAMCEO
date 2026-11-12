// launchd 서비스(com.iamceo.server)를 다루는 작은 도구. 업그레이드·되돌리기·제거가 함께 쓴다.
// 서비스 등록(service install)은 bin/iamceo.ts 의 몫이고, 여기서는 이미 등록된 서비스를 읽고 내리고 다시 올린다.
import { existsSync, lstatSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { say } from "../cli-text.ts";

export const SERVICE_LABEL = "com.iamceo.server";

export type Launchctl = (...args: string[]) => { ok: boolean; output: string };

export function realLaunchctl(...args: string[]): { ok: boolean; output: string } {
  const p = Bun.spawnSync(["/bin/launchctl", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, output: `${p.stdout.toString()}${p.stderr.toString()}`.trim() };
}

export class LifecycleError extends Error {}

export function servicePlistPath(userHome: string = homedir()): string {
  return join(userHome, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

export function serviceDomain(uid: number = userInfo().uid): string {
  return `gui/${uid}`;
}

export interface ServicePlist {
  path: string;
  label: string | null;
  program: string[];
  env: Record<string, string>;
}

/** plist 를 JSON 으로 바꿔 읽는다. 없거나 심볼릭 링크면 null. 읽지 못하면 오류. */
export function readServicePlist(path: string): ServicePlist | null {
  try { if (lstatSync(path).isSymbolicLink()) return null; } catch { return null; }
  const converted = Bun.spawnSync(["/usr/bin/plutil", "-convert", "json", "-o", "-", path], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let value: { Label?: unknown; ProgramArguments?: unknown; Program?: unknown; EnvironmentVariables?: unknown };
  try { value = JSON.parse(converted.stdout.toString()); }
  catch { throw new LifecycleError(say("서비스 설정(plist)을 읽지 못했습니다", "Could not read the service settings (plist)")); }
  const program = Array.isArray(value.ProgramArguments) && value.ProgramArguments.every(item => typeof item === "string")
    ? value.ProgramArguments as string[] : typeof value.Program === "string" ? [value.Program] : [];
  const env = value.EnvironmentVariables && typeof value.EnvironmentVariables === "object" && !Array.isArray(value.EnvironmentVariables)
    ? Object.fromEntries(Object.entries(value.EnvironmentVariables).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
  return { path, label: typeof value.Label === "string" ? value.Label : null, program, env };
}

/** 서비스가 쓰는 데이터 폴더. plist 에 IAMCEO_HOME 이 없으면 기본 ~/.iamceo 다. */
export function serviceHome(plist: ServicePlist, userHome: string = homedir()): string {
  return resolve(plist.env.IAMCEO_HOME ?? join(userHome, ".iamceo"));
}

const RUNTIME_DAEMON = /^(.+\.app)\/Contents\/Resources\/runtime\/iamceo$/;

/**
 * 서비스가 무엇을 실행하는가.
 * - release: 앱 묶음 안의 컴파일된 실행 파일(설치판). 바꿀 때는 앱 묶음을 통째로 바꾼다.
 * - git: git 체크아웃의 소스를 bun 으로 실행(대표 라이브). 바꿀 때는 커밋을 옮긴다.
 */
export type Installation =
  | { kind: "release"; plist: ServicePlist; home: string; app: string; daemon: string }
  | { kind: "git"; plist: ServicePlist; home: string; checkout: string; bun: string; entry: string };

export function detectInstallation(plist: ServicePlist, userHome: string = homedir()): Installation {
  if (plist.label !== SERVICE_LABEL) throw new LifecycleError(say("다른 프로그램의 서비스라 건드리지 않았습니다", "This service belongs to another program; nothing was changed"));
  const last = plist.program.at(-1);
  if (last !== "serve" && last !== "service-run") throw new LifecycleError(say("IAMCEO 서버를 실행하는 서비스가 아니라 건드리지 않았습니다", "This service does not run the IAMCEO server; nothing was changed"));
  const home = serviceHome(plist, userHome);
  const release = plist.program.length === 2 ? RUNTIME_DAEMON.exec(plist.program[0]!) : null;
  if (release) return { kind: "release", plist, home, app: release[1]!, daemon: plist.program[0]! };
  const entryIndex = plist.program.findIndex(arg => arg.startsWith("/") && basename(arg) === "iamceo.ts" && basename(dirname(arg)) === "bin");
  if (entryIndex >= 0 && entryIndex === plist.program.length - 2) {
    const entry = plist.program[entryIndex]!;
    const bun = entryIndex === 1 ? plist.program[0]! : (Bun.which("bun") ?? process.execPath);
    return { kind: "git", plist, home, checkout: dirname(dirname(entry)), bun, entry };
  }
  throw new LifecycleError(say("이 설치 방식은 알아볼 수 없어 바꾸지 않았습니다", "This installation type is not recognised; nothing was changed"));
}

export interface ServiceControl {
  launchctl: Launchctl;
  domain: string;
  plistPath: string;
  sleep: (ms: number) => Promise<unknown>;
}

export function serviceLoaded(control: ServiceControl): boolean {
  return control.launchctl("print", `${control.domain}/${SERVICE_LABEL}`).ok;
}

/** 내린다. 이미 내려가 있으면 그대로 성공이다. 다 내려갈 때까지(최대 timeoutMs) 기다린다. */
export async function stopService(control: ServiceControl, timeoutMs = 30_000): Promise<void> {
  if (!serviceLoaded(control)) return;
  const result = control.launchctl("bootout", `${control.domain}/${SERVICE_LABEL}`);
  // 서버가 내려가는 동안(최대 15초) bootout 은 36(in progress)을 준다. 실패가 아니라 기다릴 일이다.
  if (!result.ok && !/failed: 36\b|in progress|No such process|Could not find/i.test(result.output)) {
    throw new LifecycleError(say(`서비스를 내리지 못했습니다: ${result.output}`, `Could not stop the service: ${result.output}`));
  }
  const deadline = Date.now() + timeoutMs;
  while (serviceLoaded(control)) {
    if (Date.now() >= deadline) throw new LifecycleError(say("서비스가 제한 시간 안에 내려가지 않았습니다", "The service did not stop in time"));
    await control.sleep(500);
  }
}

/** 등록된 plist 로 다시 올린다. 앞 인스턴스 정리가 덜 끝나 거절되면 잠깐 뒤 다시 건다. */
export async function startService(control: ServiceControl): Promise<void> {
  if (!existsSync(control.plistPath)) throw new LifecycleError(say("서비스 설정 파일이 없습니다", "The service settings file is missing"));
  let loaded = control.launchctl("bootstrap", control.domain, control.plistPath);
  for (let i = 0; i < 8 && !loaded.ok && /failed: (5|37)\b|Input\/output error|already|in progress/i.test(loaded.output); i++) {
    await control.sleep(1000);
    if (serviceLoaded(control)) return;
    loaded = control.launchctl("bootstrap", control.domain, control.plistPath);
  }
  if (!loaded.ok && !serviceLoaded(control)) throw new LifecycleError(say(`서비스를 올리지 못했습니다: ${loaded.output}`, `Could not start the service: ${loaded.output}`));
}
