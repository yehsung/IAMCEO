// 업그레이드 기록. 한 번의 업그레이드마다 <홈>/upgrades/<id>/ 폴더 하나에 직전 판의 정보·plist 사본·DB 사본·이전 앱을 둔다.
// `iamceo rollback` 은 가장 최근의 끝난(done) 기록으로 되돌린다.
import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const side = z.object({
  version: z.string().min(1),
  buildId: z.string().nullable(),
  /** git 판의 커밋. 설치판은 없다. */
  rev: z.string().optional(),
});

export const upgradeRecordSchema = z.object({
  format: z.literal(1),
  id: z.string().regex(/^u-\d{8}T\d{6}Z-[a-f0-9]{8}$/),
  mode: z.enum(["release", "git"]),
  phase: z.enum(["prepared", "stopped", "replaced", "started", "done", "rolled_back", "rollback_failed", "aborted"]),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  rolledBackAt: z.string().optional(),
  home: z.string(),
  from: side.extend({ schemaVersion: z.number().int().nullable() }),
  to: side,
  /** 업그레이드 직전의 서비스 설정 사본. */
  plist: z.string(),
  /** 서버를 내린 뒤 만든 DB 사본(스키마가 바뀌었으면 되돌릴 때 쓴다). */
  database: z.string().nullable(),
  /** 설치판: 앱이 놓인 자리와 직전 앱을 보관한 자리. */
  installedApp: z.string().optional(),
  previousApp: z.string().optional(),
  /** git 판: 체크아웃 폴더. */
  checkout: z.string().optional(),
  error: z.string().optional(),
}).strict();

export type UpgradeRecord = z.infer<typeof upgradeRecordSchema>;

export function upgradesRoot(home: string): string { return join(home, "upgrades"); }
export function upgradeDir(home: string, id: string): string { return join(upgradesRoot(home), id); }

export function newUpgradeId(now: Date = new Date()): string {
  return `u-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}-${randomBytes(4).toString("hex")}`;
}

/** 0600 임시 파일 → fsync → 이름 바꾸기. 중간에 꺼져도 반쯤 쓴 기록이 남지 않는다. */
export function saveUpgradeRecord(record: UpgradeRecord): void {
  const parsed = upgradeRecordSchema.parse(record);
  const dir = upgradeDir(parsed.home, parsed.id);
  const path = join(dir, "upgrade.json"), temp = join(dir, `.upgrade-${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(parsed, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}

export function readUpgradeRecord(path: string): UpgradeRecord | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    return upgradeRecordSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch { return null; }
}

/** 기록을 새것부터. 읽지 못하는 폴더는 건너뛴다(지우지 않는다). */
export function listUpgradeRecords(home: string): UpgradeRecord[] {
  const root = upgradesRoot(home);
  if (!existsSync(root)) return [];
  const records: UpgradeRecord[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^u-\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(entry.name)) continue;
    const record = readUpgradeRecord(join(root, entry.name, "upgrade.json"));
    if (record && record.id === entry.name) records.push(record);
  }
  return records.sort((a, b) => b.id.localeCompare(a.id));
}

/**
 * 되돌릴 수 있는 가장 최근 업그레이드. 끝난 것(done)과, 도중에 멈춘 것(stopped·replaced·started)이 대상이다.
 * 그보다 새 기록이 되돌림·실패로 끝났으면 되돌릴 것이 없다. 아무것도 바꾸지 않은 기록(prepared·aborted)은 넘어간다.
 */
export function latestRollbackTarget(home: string): UpgradeRecord | null {
  for (const record of listUpgradeRecords(home)) {
    if (["done", "stopped", "replaced", "started"].includes(record.phase)) return record;
    if (record.phase === "rolled_back" || record.phase === "rollback_failed") return null;
  }
  return null;
}

/**
 * 되돌리기가 옆으로 빼 둔 DB(업그레이드 뒤에 쌓인 대화·결재)를 담은 폴더 이름의 앞머리. 대표의 데이터라 정리하지 않는다.
 * - after-upgrade-<시각>/: 되돌릴 때 빼 둔 그때의 DB
 * - rollback-attempt-<시각>/: 되돌리기가 실패해 원래대로 돌릴 때 빼 둔, 되돌린 판이 잠깐 쓴 DB
 */
export const KEPT_ASIDE_PREFIXES = ["after-upgrade-", "rollback-attempt-"] as const;
const keptAside = (name: string) => KEPT_ASIDE_PREFIXES.some(prefix => name.startsWith(prefix));

/**
 * 오래된 업그레이드 폴더(앱·DB 사본이 커서)는 최근 keep 개만 남긴다. 진행 중이던 것은 지우지 않는다.
 * 옆으로 빼 둔 DB 가 든 폴더는 통째로 지우지 않고, 그 DB 와 기록(upgrade.json)만 남긴 채 큰 사본(앱·업그레이드 전 DB)만 지운다.
 * 돌려주는 값은 통째로 지운 기록의 id.
 */
export function pruneUpgradeRecords(home: string, keep = 2): string[] {
  const removed: string[] = [];
  const records = listUpgradeRecords(home);
  for (const record of records.slice(keep)) {
    if (!["done", "rolled_back", "aborted"].includes(record.phase)) continue;
    const dir = upgradeDir(home, record.id);
    try {
      const entries = readdirSync(dir);
      if (!entries.some(keptAside)) { rmSync(dir, { recursive: true }); removed.push(record.id); continue; }
      for (const name of entries) if (name !== "upgrade.json" && !keptAside(name)) rmSync(join(dir, name), { recursive: true, force: true });
    } catch { /* 다음 업그레이드 때 다시 본다 */ }
  }
  return removed;
}

/** 이 기록 폴더 안에 남아 있는 옆 사본 폴더들(절대 경로). */
export function keptAsideCopies(home: string, id: string): string[] {
  const dir = upgradeDir(home, id);
  try { return readdirSync(dir).filter(keptAside).map(name => join(dir, name)); } catch { return []; }
}
