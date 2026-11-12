import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { readBackupJson } from "./backup.ts";
import { publicationManifestSchema, writePublicationManifest, type FileReferences, type PublicationManifest } from "./files.ts";
import type { RecordPruneResult, Store } from "./store.ts";

export const STAGING_GRACE_MS = 7 * 86_400_000;
export const QUARANTINE_GRACE_MS = 86_400_000;
/** E4: 끝난 봉투의 보낸 글 사본을 비우기까지. */
export const WIRE_TEXT_RETENTION_MS = 30 * 86_400_000;
/** E4: 끝난 실행·생명주기 기록과 영수증을 지우기까지. 대화·결재·할 일·자료는 기한이 없다. */
export const RECORD_RETENTION_MS = 90 * 86_400_000;
/** 정리 한 번이 서버를 붙잡는 최대 시간. 남은 것은 다음 정리(한 시간 뒤) 때 이어 한다. */
export const RECORD_PRUNE_BUDGET_MS = 250;
/** B5: 서버가 내보내기 도중에 꺼져 남은 임시 zip 을 치우기까지. 쓰는 동안에는 수정 시각이 계속 새로 바뀐다. */
export const EXPORT_TEMP_GRACE_MS = 3_600_000;
/** server/lifecycle/project-data.ts 가 만드는 내보내기 임시 파일 이름. 이것 말고는 exports/ 에서 아무것도 지우지 않는다. */
export const EXPORT_TEMP_NAME = /^\.export-[0-9a-f-]{36}\.zip$/;
export interface StorageUsage { bytes: number; files: number; symlinks: number }
export interface StorageMaintenanceOptions {
  uploadsDir: string;
  inboxDir: string;
  backupDir: string;
  references: FileReferences;
  /** E4: 안쪽 기록의 보존 기한 정리. 없으면 파일 정리만 한다. */
  records?: Pick<Store, "pruneInternalRecords">;
  /** B5: 프로젝트 내보내기의 임시 파일 폴더(<홈>/exports). 1시간 넘은 `.export-*.zip` 만 치운다. 업그레이드 기록(<홈>/upgrades)은 넘기지 않는다. */
  exportsDir?: string;
  /** 시험용. 기본은 위 기한. */
  retention?: { wireTextMs?: number; recordMs?: number; budgetMs?: number; batch?: number };
}

/** Logical bytes per area (hard-linked inbox copies count in each area); never follows links. */
export function measureStorage(directory: string): StorageUsage {
  const usage = { bytes: 0, files: 0, symlinks: 0 };
  if (!existsSync(directory)) return usage;
  const visit = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) usage.symlinks++;
    else if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
    else if (stat.isFile()) { usage.files++; usage.bytes += stat.size; }
  };
  visit(directory);
  return usage;
}

/** Use Store's public read ports, including all history and archives, without owning SQL. */
export function createStorageReferences(store: Store, inboxDir: string): FileReferences {
  return { isReferenced(file) {
    // Every completed attachment row may belong to a persistent, unsent client draft.
    if (store.getAttachment(file.id)) return true;
    if (existsSync(inboxDir) && (!lstatSync(inboxDir).isDirectory() || lstatSync(inboxDir).isSymbolicLink())) return true;
    const mentions = (value: unknown) => {
      const encoded = JSON.stringify(value);
      return encoded.includes(file.id) || encoded.includes(JSON.stringify(file.path).slice(1, -1));
    };
    // One read snapshot per project: paging the whole history must not reload its deliveries for every page.
    const projectMentions = (project: { id: string; archived: boolean }) => store.withDeliveryRead(project.id, () => {
      if (store.listFiles(project.id).some(mentions) || store.listDecisions(project.id).some(mentions)) return true;
      let cursor: string | undefined;
      do {
        const page = project.archived ? store.listArchiveMessagePage(project.id, { cursor, limit: 200 }) : store.listMessagePage(project.id, { cursor, limit: 200 });
        if (page.items.some(mentions)) return true;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      for (const member of store.listMembers(project.id)) {
        const dir = join(inboxDir, member.id);
        if (existsSync(dir)) {
          // A non-directory/symlink is uncertain, so fail closed instead of following it.
          if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) return true;
          if (readdirSync(dir).some((name) => name.startsWith(`${file.id}-`))) return true;
        }
        if (store.listDispatches(member.id).some(mentions)) return true;
      }
      return false;
    });
    for (const project of store.listProjects({ includeArchived: true })) if (projectMentions(project)) return true;
    // Includes failed/held/unknown and deleted-member deliveries, with no recent-row cap.
    return store.listDeliveries().some(mentions) || store.listDeliveryRecoveries().some(mentions);
  } };
}

/** Independent service; the runtime owner schedules sweep under the data-home lock. */
export class StorageMaintenance {
  private readonly uploadsDir: string;
  constructor(private readonly options: StorageMaintenanceOptions) {
    this.uploadsDir = resolve(options.uploadsDir);
  }

  usage(): { uploads: StorageUsage; inbox: StorageUsage; backups: StorageUsage; staging: StorageUsage; quarantine: StorageUsage } {
    return {
      uploads: measureStorage(this.uploadsDir), inbox: measureStorage(this.options.inboxDir), backups: measureStorage(this.options.backupDir),
      staging: measureStorage(join(this.uploadsDir, ".staging")), quarantine: measureStorage(join(this.uploadsDir, ".quarantine")),
    };
  }

  /**
   * E4: 끝난 지 오래된 안쪽 기록(보낸 글 사본 30일, 실행 기록·영수증 90일)을 정리한다.
   * 정리 대상과 남기는 것의 정의는 Store.pruneInternalRecords 에 있다. 실패해도 파일 정리는 이어 간다.
   */
  pruneRecords(now = Date.now()): RecordPruneResult | null {
    if (!this.options.records) return null;
    const retention = this.options.retention ?? {};
    const result = this.options.records.pruneInternalRecords({ now, wireTextMs: retention.wireTextMs ?? WIRE_TEXT_RETENTION_MS,
      recordMs: retention.recordMs ?? RECORD_RETENTION_MS, budgetMs: retention.budgetMs ?? RECORD_PRUNE_BUDGET_MS, ...(retention.batch ? { batch: retention.batch } : {}) });
    const total = result.wireTexts + result.executions + result.lifecycles + result.receipts + result.agentReceipts + result.recoveryOperations;
    if (total) console.info(`[storage] 오래된 안쪽 기록 정리: 보낸 글 사본 ${result.wireTexts}, 실행 기록 ${result.executions}, 생명주기 기록 ${result.lifecycles}, 영수증 ${result.receipts + result.agentReceipts + result.recoveryOperations}${result.complete ? "" : " (남은 것은 다음 정리 때)"}`);
    return result;
  }

  /**
   * B5: 서버가 내보내기 도중에 꺼지면 `<홈>/exports/.export-<uuid>.zip` 이 남는다(정상이면 열어 둔 채 바로 지운다).
   * 이름이 맞고, 링크가 아닌 보통 파일이고, 마지막으로 쓴 지 1시간이 넘은 것만 지운다. 폴더가 링크면 아무것도 하지 않는다.
   */
  sweepExports(now = Date.now()): { removed: string[]; errors: string[] } {
    const out = { removed: [] as string[], errors: [] as string[] };
    const dir = this.options.exportsDir;
    if (!dir || !existsSync(dir)) return out;
    const root = lstatSync(dir);
    if (!root.isDirectory() || root.isSymbolicLink()) { out.errors.push(dir); return out; }
    for (const name of readdirSync(dir)) {
      if (!EXPORT_TEMP_NAME.test(name)) continue;
      const path = join(dir, name);
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
        if (stat.mtimeMs > now || now - stat.mtimeMs <= EXPORT_TEMP_GRACE_MS) continue;
        unlinkSync(path);
        out.removed.push(name);
      } catch { out.errors.push(name); }
    }
    return out;
  }

  sweep(now = Date.now()): { quarantined: string[]; removed: string[]; retained: string[]; errors: string[]; records?: RecordPruneResult; exports?: string[] } {
    if (!Number.isFinite(now) || now < 0) throw new Error("Invalid maintenance time");
    const result: { quarantined: string[]; removed: string[]; retained: string[]; errors: string[]; records?: RecordPruneResult; exports?: string[] } =
      { quarantined: [] as string[], removed: [] as string[], retained: [] as string[], errors: [] as string[] };
    if (this.options.records) {
      try { result.records = this.pruneRecords(now)!; }
      catch { result.errors.push("records"); }
    }
    if (this.options.exportsDir) {
      try {
        const leftovers = this.sweepExports(now);
        result.exports = leftovers.removed;
        for (const error of leftovers.errors) result.errors.push(`exports:${error}`);
      } catch { result.errors.push("exports"); }
    }
    if (!existsSync(this.uploadsDir)) return result;
    if (!lstatSync(this.uploadsDir).isDirectory() || lstatSync(this.uploadsDir).isSymbolicLink()) throw new Error("Uploads must be a real directory");
    // Process old quarantine first: a single sweep can never skip the 24-hour hold.
    for (const area of [".quarantine", ".staging"] as const) {
      const root = join(this.uploadsDir, area);
      if (!existsSync(root)) continue;
      if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) { result.errors.push(root); continue; }
      for (const id of readdirSync(root)) {
        const directory = join(root, id);
        try {
          const manifest = this.readCandidate(directory, id);
          if (manifest.state !== "failed" || manifest.failedAt === null || manifest.failedAt < manifest.createdAt || manifest.failedAt > now || now - manifest.failedAt < STAGING_GRACE_MS) {
            result.retained.push(id); continue;
          }
          if (area === ".quarantine" && (manifest.quarantinedAt === null || manifest.quarantinedAt < manifest.failedAt + STAGING_GRACE_MS || now - manifest.quarantinedAt < QUARANTINE_GRACE_MS)) {
            result.retained.push(id); continue;
          }
          // Synchronous fresh reads immediately before rename/unlink; any uncertainty retains bytes.
          if (manifest.files.some((file) => this.options.references.isReferenced(file) || existsSync(join(this.uploadsDir, file.id)))) {
            result.retained.push(id); continue;
          }
          const entries = this.deletionInventory(directory);
          if (area === ".staging") {
            const quarantine = join(this.uploadsDir, ".quarantine");
            // The root is created only when an eligible candidate actually exists.
            this.ensureQuarantine(quarantine);
            const target = join(quarantine, id);
            if (existsSync(target)) throw new Error("Quarantine slot collision");
            writePublicationManifest(directory, { ...manifest, quarantinedAt: now });
            renameSync(directory, target);
            result.quarantined.push(id);
          } else {
            // Reference inspection and the inventory contain no await points.
            for (const entry of entries) {
              if (entry.directory) rmdirSync(entry.path);
              else unlinkSync(entry.path);
            }
            rmdirSync(directory);
            result.removed.push(id);
          }
        } catch { result.errors.push(id); }
      }
    }
    return result;
  }

  private readCandidate(directory: string, id: string): PublicationManifest {
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Invalid staging directory");
    const manifest = publicationManifestSchema.parse(readBackupJson(join(directory, "manifest.json")));
    if (manifest.id !== id || new Set(manifest.files.map((file) => file.id)).size !== manifest.files.length) throw new Error("Invalid publication identity");
    for (const file of manifest.files) {
      if (file.name === "." || file.name === ".." || /[/\\]/.test(file.name) || file.path !== join(this.uploadsDir, file.id, file.name)) throw new Error("Invalid publication path");
    }
    const allowed = new Set(["manifest.json", "manifest.next", ...manifest.files.map((file) => file.id)]);
    if (readdirSync(directory).some((name) => !allowed.has(name))) throw new Error("Untracked staging data");
    return manifest;
  }

  private ensureQuarantine(path: string): void {
    mkdirSync(path, { mode: 0o700, recursive: true });
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error("Invalid quarantine directory");
  }

  /** Validate the whole tree before touching it; symlinks/special files/hard links retain it. */
  private deletionInventory(root: string): { path: string; directory: boolean }[] {
    const entries: { path: string; directory: boolean }[] = [];
    const visit = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink > 1)) throw new Error("Uncertain staging tree");
        if (stat.isDirectory()) visit(path);
        entries.push({ path, directory: stat.isDirectory() });
      }
    };
    visit(root);
    return entries;
  }
}
