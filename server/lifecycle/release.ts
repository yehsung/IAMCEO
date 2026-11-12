// 설치판 업그레이드의 '릴리스 파일' 받기. install.sh 와 같은 확인을 같은 순서로 한다:
// SHA256SUMS 의 체크섬 → 읽기 전용 마운트 → 배포자 서명 요구 사항 → Gatekeeper(공증) → 앱 버전.
// 확인을 모두 통과한 앱만 설치 폴더 옆의 임시 자리에 복사한다. 설치된 앱은 아직 건드리지 않는다.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { say } from "../cli-text.ts";
import { LifecycleError } from "./launchd.ts";

/** install.sh 와 같은 요구 사항: IAMCEO 배포자(Apple 팀 MQ2KQK37WD)의 Developer ID 로 서명한 com.iamceo.native.mac. */
export const SIGN_REQUIREMENT = '=identifier "com.iamceo.native.mac" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "MQ2KQK37WD"';
export const RELEASE_BASE = "https://github.com/yehsung/IAMCEO/releases";

/** 디스크 이미지를 다루는 도구. 시험은 가짜를 넣는다(실제 마운트·서명 확인을 하지 않는다). */
export interface ReleaseTools {
  /** 읽기 전용으로 붙이고 붙인 자리를 돌려준다. */
  attach(dmg: string, mountPoint: string): void;
  detach(mountPoint: string): void;
  /** 서명 요구 사항과 Gatekeeper. 통과하지 못하면 이유를 던진다. */
  verify(app: string): void;
  appVersion(app: string): string;
  copy(source: string, target: string): void;
}

function tool(command: string[], failure: string): string {
  const result = Bun.spawnSync(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new LifecycleError(failure);
  return result.stdout.toString().trim();
}

export const macReleaseTools: ReleaseTools = {
  attach: (dmg, mountPoint) => { tool(["/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mountPoint, dmg], say("디스크 이미지를 붙이지 못했습니다", "Could not mount the disk image")); },
  detach: (mountPoint) => { tool(["/usr/bin/hdiutil", "detach", mountPoint], say("디스크 이미지를 떼지 못했습니다", "Could not unmount the disk image")); },
  verify: (app) => {
    tool(["/usr/bin/codesign", "--verify", "--deep", "--strict", "-R", SIGN_REQUIREMENT, app],
      say("받은 앱의 서명이 IAMCEO 배포자의 것이 아니거나 서명 뒤에 바뀌었습니다. 아무것도 바꾸지 않았습니다.", "The downloaded app is not signed by the IAMCEO publisher, or it changed after signing. Nothing was changed."));
    tool(["/usr/sbin/spctl", "-a", "-t", "execute", app],
      say("macOS 가 받은 앱을 통과시키지 않았습니다(공증 확인 실패). 아무것도 바꾸지 않았습니다.", "macOS Gatekeeper rejected the downloaded app (notarization check failed). Nothing was changed."));
  },
  appVersion: (app) => tool(["/usr/bin/plutil", "-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(app, "Contents", "Info.plist")], say("앱 버전을 읽지 못했습니다", "Could not read the app version")),
  copy: (source, target) => { tool(["/usr/bin/ditto", source, target], say("앱을 복사하지 못했습니다", "Could not copy the app")); },
};

export interface ReleaseSource {
  /** 릴리스 자산 폴더(SHA256SUMS 와 DMG 가 있는 곳). https:// 또는 file:// 또는 로컬 폴더. */
  base: string;
  /** 정한 버전(0.2.4). 없으면 SHA256SUMS 에 있는 DMG 하나. */
  version: string | null;
}

/** install.sh 와 같은 규칙. IAMCEO_DOWNLOAD_URL 이 있으면 그것을 쓴다(file:// 도 된다). */
export function releaseSource(options: { from?: string; version?: string; env?: NodeJS.ProcessEnv }): ReleaseSource {
  const version = options.version ? options.version.replace(/^v/, "") : null;
  if (version !== null && !/^\d+\.\d+\.\d+$/.test(version)) throw new LifecycleError(say("--version 은 v0.2.4 같은 정식 버전이어야 합니다", "--version must be a release version such as v0.2.4"));
  const override = options.from ?? options.env?.IAMCEO_DOWNLOAD_URL;
  // 주소(https://, file:// 등)가 아니면 폴더 경로다. 상대 경로는 지금 폴더 기준의 절대 경로로 바꾼다(그대로 두면 'https 여야 합니다'로 거절됐다).
  if (override) return { base: (/^[a-z][a-z0-9+.-]*:\/\//i.test(override) ? override : resolve(override)).replace(/\/+$/, ""), version };
  return { base: version ? `${RELEASE_BASE}/download/v${version}` : `${RELEASE_BASE}/latest/download`, version };
}

async function fetchTo(base: string, name: string, target: string, fetchImpl: typeof fetch): Promise<void> {
  if (base.startsWith("/") || base.startsWith("file://")) {
    const dir = base.startsWith("file://") ? decodeURIComponent(new URL(base).pathname) : base;
    const path = join(dir, name);
    if (!existsSync(path)) throw new LifecycleError(say(`릴리스 파일이 없습니다: ${name}`, `Release file not found: ${name}`));
    writeFileSync(target, readFileSync(path), { mode: 0o600 });
    return;
  }
  if (!base.startsWith("https://")) throw new LifecycleError(say("릴리스 주소는 https:// 여야 합니다", "The release address must use https://"));
  const response = await fetchImpl(`${base}/${name}`, { redirect: "follow", signal: AbortSignal.timeout(600_000) });
  if (!response.ok || !response.body) throw new LifecycleError(say(`릴리스 파일을 받지 못했습니다: ${name} (HTTP ${response.status})`, `Could not download ${name} (HTTP ${response.status})`));
  await Bun.write(target, response);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** SHA256SUMS 에서 받을 DMG 이름과 체크섬을 고른다. 정한 버전이 없으면 DMG 가 꼭 하나여야 한다. */
export function pickReleaseAsset(sums: string, version: string | null): { asset: string; version: string; sha256: string } {
  const lines = sums.split("\n").map(line => line.trim().split(/\s+/)).filter(parts => parts.length === 2) as [string, string][];
  const dmgs = lines.filter(([, name]) => /^IAMCEO-\d+\.\d+\.\d+-arm64\.dmg$/.test(name));
  const chosen = version ? dmgs.filter(([, name]) => name === `IAMCEO-${version}-arm64.dmg`) : dmgs;
  if (chosen.length !== 1) throw new LifecycleError(version
    ? say(`SHA256SUMS 에 IAMCEO-${version}-arm64.dmg 가 하나 있어야 합니다`, `SHA256SUMS must list IAMCEO-${version}-arm64.dmg exactly once`)
    : say("릴리스에 설치할 Mac DMG 가 하나 있어야 합니다", "The release must contain exactly one Mac DMG"));
  const [digest, asset] = chosen[0]!;
  if (!/^[a-fA-F0-9]{64}$/.test(digest)) throw new LifecycleError(say("SHA256SUMS 의 체크섬이 잘못되었습니다", "SHA256SUMS has an invalid checksum"));
  return { asset, version: asset.slice("IAMCEO-".length, -"-arm64.dmg".length), sha256: digest.toLowerCase() };
}

export interface StagedRelease { app: string; version: string; asset: string; cleanup(): void }

/**
 * 릴리스를 받아 확인한 뒤 stageDir/IAMCEO.app 에 둔다. stageDir 는 설치된 앱과 같은 볼륨(같은 부모 폴더)이어야 이름 바꾸기로 교체된다.
 * 실패하면 받은 것과 붙인 것을 모두 치우고, 설치된 앱은 그대로다.
 */
export async function stageRelease(source: ReleaseSource, stageDir: string, options: { tools?: ReleaseTools; fetch?: typeof fetch; scratch?: string; log?: (line: string) => void } = {}): Promise<StagedRelease> {
  const tools = options.tools ?? macReleaseTools;
  const temp = mkdtempSync(join(options.scratch ?? tmpdir(), "iamceo-release-"));
  const mount = join(temp, "mount");
  let mounted = false;
  try {
    mkdirSync(mount);
    await fetchTo(source.base, "SHA256SUMS", join(temp, "SHA256SUMS"), options.fetch ?? fetch);
    const picked = pickReleaseAsset(readFileSync(join(temp, "SHA256SUMS"), "utf8"), source.version);
    options.log?.(say(`받는 중: ${source.base}/${picked.asset}`, `Downloading ${source.base}/${picked.asset}`));
    const dmg = join(temp, picked.asset);
    await fetchTo(source.base, picked.asset, dmg, options.fetch ?? fetch);
    if (await sha256(dmg) !== picked.sha256) throw new LifecycleError(say("받은 DMG 의 SHA-256 이 맞지 않습니다", "The downloaded DMG does not match its SHA-256"));
    tools.attach(dmg, mount);
    mounted = true;
    const mountedApp = join(mount, "IAMCEO.app");
    if (!existsSync(mountedApp)) throw new LifecycleError(say("DMG 에 IAMCEO.app 이 없습니다", "The DMG does not contain IAMCEO.app"));
    options.log?.(say("서명과 공증을 확인하는 중입니다", "Verifying the signature and notarization"));
    tools.verify(mountedApp);
    if (tools.appVersion(mountedApp) !== picked.version) throw new LifecycleError(say("DMG 이름과 앱 버전이 다릅니다", "The DMG name and the app version differ"));
    mkdirSync(stageDir, { recursive: true, mode: 0o700 });
    const app = join(stageDir, "IAMCEO.app");
    tools.copy(mountedApp, app);
    tools.detach(mount);
    mounted = false;
    return { app, version: picked.version, asset: picked.asset, cleanup: () => { try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* 다음 업그레이드가 다시 치운다 */ } } };
  } catch (error) {
    try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* 없으면 그만 */ }
    throw error;
  } finally {
    if (mounted) { try { tools.detach(mount); mounted = false; } catch { /* 붙인 채 남으면 아래에서 지우지 않는다 */ } }
    // 붙인 볼륨 안을 지우지 않는다: 떼지 못했으면 임시 폴더를 남긴다.
    if (!mounted) rmSync(temp, { recursive: true, force: true });
  }
}

/** 0.2.10 > 0.2.9. 정식 버전 세 자리만 비교한다. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}
