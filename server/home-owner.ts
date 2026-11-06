import { dlopen, read } from "bun:ffi";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getSystemErrorName } from "node:util";
import { toStorageError } from "./storage-errors.ts";

/** Canonicalize existing ancestors too, so a not-yet-created home has one name. */
export function normalizeHome(home: string): string {
  const path = resolve(home);
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(normalizeHome(parent), path.slice(parent.length));
  }
}

function libc() {
  if (process.platform !== "darwin") throw new Error("Home ownership requires macOS libc flock");
  return dlopen("/usr/lib/libSystem.B.dylib", {
    flock: { args: ["i32", "i32"], returns: "i32" },
    __error: { args: [], returns: "ptr" },
  });
}
let library: ReturnType<typeof libc> | undefined;
const owners = new Map<string, { owner: HomeOwner; validate(): void }>();

export interface HomeOwner {
  readonly home: string;
  readonly lockPath: string;
  /** Idempotent. Never unlink/rename the lock inode, including after a crash. */
  release(): void;
  [Symbol.dispose](): void;
}

export class HomeOwnershipError extends Error {
  readonly code = "home_in_use";
  readonly status = 409;
  constructor(readonly home: string) {
    super(`데이터 홈을 다른 작업이 사용 중입니다: ${home}`);
    this.name = "HomeOwnershipError";
  }
}

/** Acquire before DB/recovery/restore; keep the handle until shutdown completes. */
export function acquireHomeOwner(home: string): HomeOwner {
  let fd: number | undefined;
  try {
    home = normalizeHome(home);
    if (owners.has(home)) throw new HomeOwnershipError(home);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    home = realpathSync(home);
    const lockPath = join(home, ".owner.lock");
    // Node/Bun openSync sets close-on-exec. NOFOLLOW prevents a foreign lock target.
    fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!()) throw new Error(`안전하지 않은 홈 잠금 파일: ${lockPath}`);
    const symbols = (library ??= libc()).symbols;
    // Darwin LOCK_EX=2, LOCK_NB=4. Read thread-local errno immediately after failure.
    while (symbols.flock(fd, 2 | 4) !== 0) {
      const errno = read.i32(symbols.__error()!);
      if (errno === 4) continue; // EINTR
      if (errno === 35) throw new HomeOwnershipError(home); // EWOULDBLOCK
      throw Object.assign(new Error(`flock failed: ${lockPath}`), { code: getSystemErrorName(-errno), errno });
    }
    const current = lstatSync(lockPath);
    if (current.dev !== stat.dev || current.ino !== stat.ino) throw new Error("Home lock inode changed");
    fchmodSync(fd, 0o600);
    const homeFd = openSync(home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (fstatSync(homeFd).uid !== process.getuid!()) throw new Error(`다른 사용자의 데이터 홈: ${home}`);
      fchmodSync(homeFd, 0o700);
    } finally { closeSync(homeFd); }
    const ownedFd = fd;
    let released = false;
    const owner: HomeOwner = {
      home, lockPath,
      release() {
        if (released) return;
        released = true;
        owners.delete(home);
        // close alone releases flock; an explicit unlock could release a shared FD.
        closeSync(ownedFd);
      },
      [Symbol.dispose]() { this.release(); },
    };
    owners.set(home, { owner, validate() {
      const current = lstatSync(lockPath);
      if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.nlink !== 1) throw new Error("Home lock inode changed");
    } });
    fd = undefined;
    return owner;
  } catch (error) { throw toStorageError(error, "홈 소유권 확보 실패"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Synchronous config writes may borrow this process's lifetime owner. */
export function withHomeOwner<T>(home: string, action: (home: string) => T): T {
  home = normalizeHome(home);
  const existing = owners.get(home);
  if (existing) { existing.validate(); return action(existing.owner.home); }
  const owner = acquireHomeOwner(home);
  try { return action(owner.home); }
  finally { owner.release(); }
}
