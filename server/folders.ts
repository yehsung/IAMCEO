import { constants, type Stats } from "node:fs";
import { access, lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ApiError } from "./store.ts";

export function folderName(input: string): string {
  const name = input.trim();
  if (![...name].length || [...name].length > 100 || name.startsWith(".") || /[\/\p{Cc}]/u.test(name)) {
    throw new ApiError(400, "폴더 이름은 점으로 시작하지 않는 1~100자로 입력하세요. /와 제어문자는 쓸 수 없습니다");
  }
  return name;
}

export class Folders {
  constructor(private readonly homePath = homedir()) {}
  async home(): Promise<string> { return realpath(this.homePath); }
  async directory(input?: string): Promise<string> {
    const home = await this.home();
    if (input?.split("/").includes("..")) throw new ApiError(403, "서버의 홈 폴더 안에서 골라 주세요");
    const expanded = input === undefined || input === "~" ? home : input.startsWith("~/") ? join(home, input.slice(2)) : input;
    if (!isAbsolute(expanded) || expanded.includes("\0")) throw new ApiError(400, "절대 폴더 경로가 필요합니다");
    const inside = (path: string) => { const rel = relative(home, path); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
    if (!inside(resolve(expanded))) throw new ApiError(403, "서버의 홈 폴더 안에서 골라 주세요");
    try {
      const path = await realpath(expanded);
      if (!inside(path)) throw new ApiError(403, "서버의 홈 폴더 안에서 골라 주세요");
      if (!(await stat(path)).isDirectory()) throw new ApiError(400, "폴더가 아닙니다");
      await access(path, constants.R_OK | constants.X_OK);
      return path;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError((error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 403, "폴더를 열 수 없습니다");
    }
  }
  async list(input?: string) {
    const path = await this.directory(input), home = await this.home();
    const entries: { name: string; path: string }[] = [];
    // Sort before the cap so the same first 500 folders appear on each visit.
    let children;
    try { children = await readdir(path, { withFileTypes: true }); }
    catch { throw new ApiError(403, "폴더를 열 수 없습니다"); }
    children.sort((a, b) => a.name.localeCompare(b.name));
    let truncated = false;
    for (const child of children) {
      if (child.name.startsWith(".") || (!child.isDirectory() && !child.isSymbolicLink())) continue;
      try {
        const canonical = await this.directory(join(path, child.name));
        if (entries.length === 500) { truncated = true; break; }
        entries.push({ name: child.name, path: canonical });
      } catch { /* inaccessible folders and external symlinks stay invisible */ }
    }
    return { path, parent: path === home ? null : dirname(path), home, entries, ...(truncated ? { truncated: true } : {}) };
  }
  async create(parent: string, input: string): Promise<{ name: string; path: string }> {
    const name = folderName(input), path = join(await this.directory(parent), name);
    try { await mkdir(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ApiError(409, "같은 이름의 폴더가 있습니다");
      throw new ApiError(403, "폴더를 만들 수 없습니다");
    }
    return { name, path };
  }
  /** Only the directory reserved by this job may be removed after a failed clone. */
  async stillOwned(path: string, identity: Stats): Promise<boolean> {
    try {
      if (await this.directory(dirname(path)) !== dirname(path)) return false;
      const current = await lstat(path);
      return current.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino;
    } catch { return false; }
  }
}
