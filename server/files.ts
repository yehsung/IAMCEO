import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync, existsSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { newId } from "./db.ts";
import { cleanText } from "./text.ts";
import { toStorageError } from "./storage-errors.ts";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** 아티팩트(자체 완결 HTML) 한 장의 상한. 화면이 통째로 받아 격리 칸에 넣는다. */
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

export interface SavedFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  path: string;
}

const MAX_NAME_BYTES = 180;
const encoder = new TextEncoder();

function truncateToBytes(s: string, max: number): string {
  let out = "";
  let used = 0;
  for (const ch of s) {
    used += encoder.encode(ch).length;
    if (used > max) break;
    out += ch;
  }
  return out;
}

/**
 * 사용자·에이전트가 준 이름에서 경로와 위험한 글자를 없앤다. 맥의 NFD 한글도 NFC 로 맞춘다.
 * 이름은 전달 글의 `첨부:` 줄에 그대로 들어간다. 메일로 받은 파일의 이름을 정한 외부인이 줄을 끊거나 `[대표 직접]` 을 지어내지 못하게 한다.
 */
export function sanitizeName(raw: string): string {
  const base = cleanText(raw).normalize("NFC").split(/[/\\]/).pop() ?? "";
  const clean = base
    .replace(/[\u0000-\u001f\u007f<>:"|?*\[\]'`]/g, "")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  if (!clean) return "file";
  const ext = extname(clean);
  if (encoder.encode(clean).length <= MAX_NAME_BYTES) return clean;
  const stem = clean.slice(0, clean.length - ext.length);
  const keptExt = encoder.encode(ext).length <= 20 ? ext : "";
  return truncateToBytes(stem, MAX_NAME_BYTES - encoder.encode(keptExt).length) + keptExt;
}

/** target 이 base 안에 실제로 있을 때만(심볼릭 링크를 따라간 뒤) 진짜 경로를 돌려준다. */
export function resolveInside(base: string, target: string): string | null {
  try {
    const realBase = realpathSync(base);
    const real = realpathSync(target);
    return real.startsWith(realBase + sep) ? real : null;
  } catch {
    return null;
  }
}

function guessMime(name: string, given?: string): string {
  const type = given?.split(";")[0]?.trim();
  if (type && type !== "application/octet-stream") return type;
  return Bun.file(name).type.split(";")[0] || "application/octet-stream";
}

function isHeic(name: string, mime: string): boolean {
  return /^image\/hei[cf]/.test(mime) || /\.hei[cf]$/i.test(name);
}

/** 맥에서만 된다. 실패하면 null(원본을 그대로 쓴다). */
async function heicToJpeg(src: string, dest: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    const proc = Bun.spawn(["sips", "-s", "format", "jpeg", src, "--out", dest], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0 && statSync(dest).size > 0;
  } catch {
    return false;
  }
}

async function finish(id: string, dir: string, name: string, mime: string): Promise<SavedFile> {
  const path = join(dir, name);
  if (isHeic(name, mime)) {
    const jpegName = `${basename(name, extname(name)) || "image"}.jpg`;
    const jpegPath = join(dir, jpegName);
    if (await heicToJpeg(path, jpegPath)) {
      rmSync(path, { force: true });
      return { id, name: jpegName, mime: "image/jpeg", size: statSync(jpegPath).size, path: jpegPath };
    }
  }
  return { id, name, mime, size: statSync(path).size, path };
}

/** A failed manifest is evidence of a settled failure; age alone never establishes failure. */
export const publicationManifestSchema = z.object({
  version: z.literal(1), id: z.string().regex(/^publication_[A-Za-z0-9]{12}$/),
  state: z.enum(["active", "failed", "published"]),
  createdAt: z.number().finite().nonnegative(), failedAt: z.number().finite().nonnegative().nullable(),
  quarantinedAt: z.number().finite().nonnegative().nullable(),
  files: z.array(z.object({ id: z.string().regex(/^a_[A-Za-z0-9]{12}$/), name: z.string().min(1), mime: z.string(), size: z.number().int().nonnegative(), path: z.string() }).strict()),
}).strict();
export type PublicationManifest = z.infer<typeof publicationManifestSchema>;
export interface PreparedImport extends Omit<SavedFile, "path"> { source: string; dev: number; ino: number; mtimeMs: number; ctimeMs: number }
export interface FileReferences { isReferenced(file: SavedFile): boolean }

/** No writes: callers validate every input before creating a publication. */
export function prepareImport(srcPath: string, name?: string): PreparedImport {
  const source = realpathSync(srcPath);
  const stat = statSync(source);
  if (!stat.isFile()) throw new Error(`파일이 아닙니다: ${srcPath}`);
  if (stat.size > MAX_UPLOAD_BYTES) throw new Error(`파일은 50MB 까지 올릴 수 있습니다: ${srcPath}`);
  const safe = sanitizeName(name ?? basename(source));
  return { id: newId("a_"), source, name: safe, mime: guessMime(safe), size: stat.size, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

/** Persist on the same volume. A failed replacement leaves the last conservative state intact. */
export function writePublicationManifest(directory: string, manifest: PublicationManifest): void {
  const temp = join(directory, "manifest.next");
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(manifest)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, join(directory, "manifest.json"));
  const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

/** Filesystem publication and SQLite commit are separate; an active crash is never GC evidence. */
export class FilePublication {
  readonly directory: string;
  readonly uploadsDir: string;
  private manifest: PublicationManifest;
  private moved = new Set<string>();
  private ready = new Set<string>();
  private published = false;
  private settled = false;

  constructor(uploadsDir: string) {
    this.uploadsDir = resolve(uploadsDir);
    const id = newId("publication_");
    this.directory = join(this.uploadsDir, ".staging", id);
    this.manifest = { version: 1, id, state: "active", createdAt: Date.now(), failedAt: null, quarantinedAt: null, files: [] };
    mkdirSync(this.uploadsDir, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.uploadsDir).isDirectory() || lstatSync(this.uploadsDir).isSymbolicLink()) throw new Error("Uploads must be a real directory");
    const staging = join(this.uploadsDir, ".staging");
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    if (!lstatSync(staging).isDirectory() || lstatSync(staging).isSymbolicLink()) throw new Error("Staging must be a real directory");
    mkdirSync(this.directory, { mode: 0o700 });
    writePublicationManifest(this.directory, this.manifest);
  }

  private slot(id: string, name: string, mime: string, size: number): string {
    if (this.settled || this.published || this.moved.size) throw new Error("Publication is no longer staging");
    const dir = join(this.directory, id);
    this.manifest.files.push({ id, name, mime, size, path: join(this.uploadsDir, id, name) });
    writePublicationManifest(this.directory, this.manifest);
    mkdirSync(dir, { mode: 0o700 });
    return dir;
  }

  async stagePath(input: PreparedImport): Promise<SavedFile> {
    const dir = this.slot(input.id, input.name, input.mime, input.size);
    const source = openSync(input.source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(source);
      if (!before.isFile() || before.dev !== input.dev || before.ino !== input.ino || before.size !== input.size || before.mtimeMs !== input.mtimeMs || before.ctimeMs !== input.ctimeMs) throw new Error("파일이 검증 후 변경되었습니다");
      const dest = openSync(join(dir, input.name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const buffer = Buffer.alloc(1024 * 1024);
        let size = 0;
        for (let count; (count = readSync(source, buffer, 0, buffer.length, null)) > 0;) {
          size += count;
          if (size > input.size || size > MAX_UPLOAD_BYTES) throw new Error("파일이 복사 중 변경되었습니다");
          let offset = 0;
          while (offset < count) {
            const written = writeSync(dest, buffer, offset, count - offset);
            if (!written) throw new Error("File short write");
            offset += written;
          }
        }
        const after = fstatSync(source);
        if (size !== input.size || after.size !== input.size || after.mtimeMs !== input.mtimeMs || after.ctimeMs !== input.ctimeMs) throw new Error("파일이 복사 중 변경되었습니다");
        fsyncSync(dest);
      } finally { closeSync(dest); }
    } finally { closeSync(source); }
    return this.finishSlot(input.id, dir, input.name, input.mime);
  }

  async stageUpload(file: File): Promise<SavedFile> {
    if (file.size > MAX_UPLOAD_BYTES) throw new Error("파일은 50MB 까지 올릴 수 있습니다");
    const id = newId("a_");
    const name = sanitizeName(file.name);
    const mime = guessMime(name, file.type);
    const dir = this.slot(id, name, mime, file.size);
    const fd = openSync(join(dir, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, Buffer.from(await file.arrayBuffer())); fsyncSync(fd); } finally { closeSync(fd); }
    return this.finishSlot(id, dir, name, mime);
  }

  private async finishSlot(id: string, dir: string, name: string, mime: string): Promise<SavedFile> {
    const staged = await finish(id, dir, name, mime);
    if (staged.size > MAX_UPLOAD_BYTES) throw new Error("파일은 50MB 까지 올릴 수 있습니다");
    const saved = { ...staged, path: join(this.uploadsDir, id, staged.name) };
    this.manifest.files[this.manifest.files.findIndex((f) => f.id === id)] = saved;
    writePublicationManifest(this.directory, this.manifest);
    this.ready.add(id);
    return saved;
  }

  /** Synchronous: caller can publish immediately before its synchronous Store.transaction. */
  publish(): void {
    if (this.settled) throw new Error("Publication is settled");
    if (this.manifest.files.some((file) => !this.ready.has(file.id))) throw new Error("Publication has unfinished files");
    for (const file of this.manifest.files) {
      if (this.moved.has(file.id)) continue;
      if (existsSync(join(this.uploadsDir, file.id))) throw new Error("Attachment slot already exists");
      renameSync(join(this.directory, file.id), join(this.uploadsDir, file.id));
      this.moved.add(file.id);
    }
    this.published = true;
  }

  complete(): void {
    if (this.settled || !this.published) throw new Error("Publication is not awaiting commit");
    this.settled = true;
    this.manifest.state = "published";
    // DB commit is already successful: a journal failure must not report a failed publication.
    try { writePublicationManifest(this.directory, this.manifest); } catch { /* Active journal remains protected. */ }
  }

  fail(references: FileReferences): void {
    if (this.settled) return;
    // Only our own slots, and only after the caller's transaction has rolled back.
    for (const file of this.manifest.files) {
      if (references.isReferenced(file)) continue;
      if (this.moved.has(file.id)) renameSync(join(this.uploadsDir, file.id), join(this.directory, file.id));
    }
    this.manifest.state = "failed";
    this.manifest.failedAt = Date.now();
    writePublicationManifest(this.directory, this.manifest);
    this.settled = true;
  }
}

/** Legacy callers still receive an upload path; their subsequent DB write owns its own boundary. */
export async function saveUpload(uploadsDir: string, file: File): Promise<SavedFile> {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("파일은 50MB 까지 올릴 수 있습니다");
  let publication: FilePublication | undefined;
  try {
    publication = new FilePublication(uploadsDir);
    const saved = await publication.stageUpload(file);
    publication.publish();
    publication.complete();
    return saved;
  } catch (error) {
    try { publication?.fail({ isReferenced: () => false }); } catch { /* Preserve an uncertain journal. */ }
    throw toStorageError(error, "파일 저장");
  }
}

export async function importPath(uploadsDir: string, srcPath: string, name?: string): Promise<SavedFile> {
  let publication: FilePublication | undefined;
  try {
    const input = prepareImport(srcPath, name);
    publication = new FilePublication(uploadsDir);
    const saved = await publication.stagePath(input);
    publication.publish();
    publication.complete();
    return saved;
  } catch (error) {
    try { publication?.fail({ isReferenced: () => false }); } catch { /* Preserve an uncertain journal. */ }
    throw toStorageError(error, "파일 복사");
  }
}
