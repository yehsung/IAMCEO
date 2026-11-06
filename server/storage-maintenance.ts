import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { readBackupJson } from "./backup.ts";
import { publicationManifestSchema, writePublicationManifest, type FileReferences, type PublicationManifest } from "./files.ts";
import type { Store } from "./store.ts";

export const STAGING_GRACE_MS = 7 * 86_400_000;
export const QUARANTINE_GRACE_MS = 86_400_000;
export interface StorageUsage { bytes: number; files: number; symlinks: number }
export interface StorageMaintenanceOptions {
  uploadsDir: string;
  inboxDir: string;
  backupDir: string;
  references: FileReferences;
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
    for (const project of store.listProjects({ includeArchived: true })) {
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
    }
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

  sweep(now = Date.now()): { quarantined: string[]; removed: string[]; retained: string[]; errors: string[] } {
    if (!Number.isFinite(now) || now < 0) throw new Error("Invalid maintenance time");
    const result = { quarantined: [] as string[], removed: [] as string[], retained: [] as string[], errors: [] as string[] };
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
