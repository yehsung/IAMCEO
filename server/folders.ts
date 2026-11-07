import { constants, type Stats } from "node:fs";
import { access, lstat, mkdir, opendir, realpath, rmdir, stat } from "node:fs/promises";
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
  constructor(private readonly homePath = homedir(), private readonly hooks: {
    beforeMkdir?: () => Promise<void>;
    afterMkdir?: () => Promise<void>;
    onEntry?: () => void;
  } = {}) {}
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
    // Bound enumeration as well as the response, including hidden files and links.
    const children = [];
    let truncated = false;
    try {
      const directory = await opendir(path, { bufferSize: 1 });
      try {
        for (let count = 0; count < 2000; count++) {
          const child = await directory.read();
          if (!child) break;
          this.hooks.onEntry?.();
          children.push(child);
          if (count === 1999) truncated = true;
        }
      } finally { await directory.close(); }
    } catch { throw new ApiError(403, "폴더를 열 수 없습니다"); }
    children.sort((a, b) => a.name.localeCompare(b.name));
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
    const name = folderName(input), checkedParent = await this.directory(parent), path = join(checkedParent, name);
    await this.hooks.beforeMkdir?.();
    try { await mkdir(path, { mode: 0o755 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ApiError(409, "같은 이름의 폴더가 있습니다");
      throw new ApiError(403, "폴더를 만들 수 없습니다");
    }
    let created: Stats | undefined;
    try {
      created = await lstat(path);
      await this.hooks.afterMkdir?.();
      const item = await lstat(path);
      if (item.isSymbolicLink() || !item.isDirectory() || item.dev !== created.dev || item.ino !== created.ino ||
          await this.directory(checkedParent) !== checkedParent || await this.directory(path) !== path) {
        throw new Error("folder changed");
      }
    } catch {
      // Only the newly created, empty item. Never follow links or recurse.
      try {
        const current = await lstat(path);
        if (created && current.dev === created.dev && current.ino === created.ino && !current.isSymbolicLink()) await rmdir(path);
      } catch { /* A replacement or a nonempty item must be preserved. */ }
      throw new ApiError(403, "폴더를 만들 수 없습니다");
    }
    return { name, path };
  }
}
