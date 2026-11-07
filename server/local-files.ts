import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { isSecretPath, rejectHardLink } from "./secret-paths.ts";
import { ApiError, type Store } from "./store.ts";

export const LOCAL_TEXT_MAX = 2 * 1024 * 1024;
export const LOCAL_IMAGE_MAX = 20 * 1024 * 1024;
const imageMimes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic" };
const textExtensions = new Set("md markdown txt csv tsv json jsonl yaml yml html htm css scss js jsx ts tsx mjs cjs swift py rb sh bash zsh fish sql xml toml ini conf log c h cpp hpp rs go java kt vue svelte r dart graphql gitignore dockerfile".split(" "));
export interface LocalFileInfo { name: string; path: string; size: number; modifiedAt: string; mime: string; kind: "text" | "image" | "other"; content?: string }
export interface LocalFile {
  info: LocalFileInfo;
  bytes?: Buffer;
  identity: { dev: number; ino: number; mtimeMs: number; ctimeMs: number };
}

function checkPath(home: string, path: string, protectedRoots: readonly string[]): void {
  const rel = relative(home, path);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new ApiError(403, "서버 사용자 홈 밖의 파일은 열 수 없습니다");
  if (isSecretPath(path, home, protectedRoots)) throw new ApiError(403, "인증 정보가 있는 민감한 파일이나 위치는 열 수 없습니다");
}

/** Also validate the canonical source used by the attachment publication. */
export function checkLocalImportPath(path: string, userHome = homedir(), protectedRoots: readonly string[] = []): void {
  const home = realpathSync(userHome);
  checkPath(home, path, protectedRoots);
  checkPath(home, realpathSync(path), protectedRoots);
}

const localFileFS = { closeSync, fstatSync, openSync, readSync, realpathSync, statSync };
export type LocalFileFS = typeof localFileFS;

/** Resolve only project/member working directories; inspect both the named path and its real target. */
export function readLocalFile(store: Store, projectId: string, input: string, userHome = homedir(), protectedRoots: readonly string[] = [], fs: LocalFileFS = localFileFS): LocalFile {
  const { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } = fs;
  const project = store.requireProject(projectId);
  if (!input.trim() || input.includes("\0") || input.length > 8192) throw new ApiError(400, "파일 경로가 올바르지 않습니다");
  const home = realpathSync(userHome);
  const paths = input.startsWith("~/") ? [resolve(home, input.slice(2))] : isAbsolute(input) ? [resolve(input)] : [project.cwd, ...store.listMembers(projectId).map(m => m.cwd)].map(cwd => resolve(cwd, input));
  for (const path of [...new Set(paths)]) {
    checkPath(home, path, protectedRoots);
    let real: string;
    try { real = realpathSync(path); } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw new ApiError(403, "파일을 읽을 권한이 없습니다");
    }
    checkPath(home, real, protectedRoots);
    if (!statSync(real).isFile()) throw new ApiError(403, "디렉터리나 특수 파일은 열 수 없습니다");
    let fd: number;
    try { fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { throw new ApiError(403, "파일을 읽을 수 없습니다"); }
    try {
      const stat = fstatSync(fd);
      rejectHardLink(stat);
      // One observation supplies both the policy path and the identity comparison.
      const currentPath = realpathSync(path);
      checkPath(home, currentPath, protectedRoots);
      const current = statSync(currentPath);
      if (!stat.isFile() || stat.ino !== current.ino || stat.dev !== current.dev) throw new ApiError(403, "검사 중 파일이 바뀌었습니다. 다시 열어 주세요");
      const identity = { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
      const ext = extname(real).toLowerCase();
      const image = imageMimes[ext];
      const knownBinary = /\.(mp4|mov|m4v|webm|avi|mkv|mp3|wav|m4a|ogg|pdf|zip|gz|tar|7z|dmg|exe|sqlite|db|woff2?|ttf|docx|xlsx|pptx)$/i.test(real);
      const text = textExtensions.has(ext.slice(1)) || (!image && !knownBinary && stat.size <= LOCAL_TEXT_MAX);
      const info: LocalFileInfo = { name: basename(real), path: real, size: stat.size, modifiedAt: stat.mtime.toISOString(), mime: image ?? (text ? ((Bun.file(real).type && Bun.file(real).type !== "application/octet-stream" ? Bun.file(real).type : "text/plain; charset=utf-8")) : "application/octet-stream"), kind: image ? "image" : text ? "text" : "other" };
      if (!text && !image) return { info, identity };
      const limit = image ? LOCAL_IMAGE_MAX : LOCAL_TEXT_MAX;
      if (stat.size > limit) throw new ApiError(413, image ? "이미지는 20MB 까지 미리 볼 수 있습니다" : "텍스트는 2MB 까지 열 수 있습니다");
      // Read at most limit+1 even when a file grows after stat.
      const bytes = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
      let count = 0, n = 0;
      while (count < bytes.length && (n = readSync(fd, bytes, count, bytes.length - count, null)) > 0) count += n;
      const after = fstatSync(fd);
      rejectHardLink(after);
      if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new ApiError(409, "읽는 중 파일이 바뀌었습니다. 다시 열어 주세요");
      const content = bytes.subarray(0, count);
      if (image) return { info, bytes: content, identity };
      try {
        info.content = new TextDecoder("utf-8", { fatal: true }).decode(content);
        if (info.content.includes("\0")) throw new Error("binary");
        if (!textExtensions.has(ext.slice(1))) info.mime = "text/plain; charset=utf-8";
      } catch { delete info.content; info.kind = "other"; info.mime = "application/octet-stream"; }
      return { info, identity };
    } finally { closeSync(fd); }
  }
  throw new ApiError(404, "파일을 찾을 수 없습니다", "LOCAL_FILE_NOT_FOUND");
}
