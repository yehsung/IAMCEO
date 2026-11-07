import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname } from "node:path";

export interface LogWriterOptions { maxBytes?: number; generations?: number; maxPendingBytes?: number }

/** Runs in the service supervisor, separately from the HTTP/runner event loop.
 * The queue and each file are bounded in bytes. Overflow is counted, never buffered indefinitely.
 * generations includes the current file: the default disk bound is 10 MiB × 5 per stream.
 */
export class BoundedLogWriter {
  readonly maxBytes: number;
  readonly generations: number;
  readonly maxPendingBytes: number;
  droppedBytes = 0;
  failed = false;
  private fd?: number;
  private size = 0;
  private queue: Buffer[] = [];
  private pending = 0;
  private scheduled?: ReturnType<typeof setImmediate>;
  private closed = false;

  constructor(readonly path: string, options: LogWriterOptions = {}) {
    this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    this.generations = options.generations ?? 5;
    this.maxPendingBytes = options.maxPendingBytes ?? 1024 * 1024;
    for (const value of [this.maxBytes, this.generations, this.maxPendingBytes]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid log bound");
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!lstatSync(dirname(path)).isDirectory() || lstatSync(dirname(path)).isSymbolicLink()) throw new Error("Unsafe log directory");
    this.reopen();
    try {
      // Old unbounded logs are discarded rather than copied into another oversized generation.
      if (this.size > this.maxBytes) this.truncateCurrent();
      for (const name of readdirSync(dirname(path))) {
        if (!name.startsWith(`${basename(path)}.`)) continue;
        const suffix = name.slice(basename(path).length + 1);
        if (/^[1-9]\d*$/.test(suffix) && Number(suffix) >= this.generations) this.remove(`${dirname(path)}/${name}`);
      }
      for (let i = 1; i < this.generations; i++) {
        try {
          const stat = lstatSync(`${this.path}.${i}`);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > this.maxBytes) unlinkSync(`${this.path}.${i}`);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    } catch (error) { if (this.fd !== undefined) closeSync(this.fd); this.fd = undefined; throw error; }
  }

  get pendingBytes(): number { return this.pending; }
  write(chunk: Uint8Array): boolean {
    if (this.closed) throw new Error("Log writer is closed");
    const length = chunk.byteLength;
    if (length === 0) return true;
    if (this.failed || length > this.maxPendingBytes - this.pending) { this.droppedBytes += length; return false; }
    // Copy: a caller may reuse its read buffer before the next drain.
    this.queue.push(Buffer.from(chunk));
    this.pending += length;
    this.scheduled ??= setImmediate(() => { this.scheduled = undefined; this.flush(); });
    return true;
  }

  flush(): void {
    clearImmediate(this.scheduled);
    this.scheduled = undefined;
    const queue = this.queue;
    this.queue = [];
    this.pending = 0;
    for (const chunk of queue) {
      if (this.failed) { this.droppedBytes += chunk.length; continue; }
      let offset = 0;
      try {
        while (offset < chunk.length) {
          if (this.size >= this.maxBytes) this.rotate();
          const count = writeSync(this.fd!, chunk, offset, Math.min(chunk.length - offset, this.maxBytes - this.size));
          if (!count) throw new Error("Log short write");
          offset += count;
          this.size += count;
        }
      } catch {
        this.failed = true;
        this.droppedBytes += chunk.length - offset;
        // Never recursively log a disk failure through the same writer.
        if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined; }
      }
    }
  }

  private reopen(): void {
    const fd = openSync(this.path, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!()) throw new Error("Unsafe log file");
      fchmodSync(fd, 0o600);
      this.fd = fd;
      this.size = stat.size;
    } catch (error) { closeSync(fd); throw error; }
  }
  private remove(path: string): void {
    try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private truncateCurrent(): void {
    closeSync(this.fd!); this.fd = undefined;
    this.remove(this.path);
    this.reopen();
  }
  private rotate(): void {
    // Close BEFORE renaming; every later byte goes to the newly opened inode.
    closeSync(this.fd!); this.fd = undefined;
    if (this.generations === 1) this.remove(this.path);
    else {
      this.remove(`${this.path}.${this.generations - 1}`);
      for (let i = this.generations - 2; i >= 1; i--) {
        try { renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      renameSync(this.path, `${this.path}.1`);
    }
    this.reopen();
  }
  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined; }
  }
}
