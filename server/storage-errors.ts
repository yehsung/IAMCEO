export type StorageErrorCode = "storage_full" | "storage_permission" | "storage_io";

/** Only structured OS/SQLite codes count; arbitrary error text is not evidence. */
export function classifyStorageError(error: unknown): StorageErrorCode | null {
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    if (error instanceof StorageError) return error.code;
    const value = error as { code?: unknown; errno?: unknown; errcode?: unknown; cause?: unknown };
    if (["ENOSPC", "EDQUOT", "SQLITE_FULL"].includes(String(value.code)) ||
        (typeof value.errcode === "number" && (value.errcode & 255) === 13)) return "storage_full";
    if (["EACCES", "EPERM"].includes(String(value.code))) return "storage_permission";
    if (["EIO", "EROFS", "SQLITE_IOERR"].includes(String(value.code)) ||
        (typeof value.errcode === "number" && (value.errcode & 255) === 10)) return "storage_io";
    error = value.cause;
  }
  return null;
}

export function isStorageFull(error: unknown): boolean {
  return classifyStorageError(error) === "storage_full";
}

export class StorageError extends Error {
  readonly status: number;
  constructor(readonly code: StorageErrorCode, operation: string, cause: unknown) {
    super(`${operation}: ${code}`, { cause });
    this.name = "StorageError";
    this.status = code === "storage_full" ? 507 : 500;
  }
}

export function toStorageError(error: unknown, operation: string): Error {
  if (error instanceof StorageError) return error;
  const code = classifyStorageError(error);
  return code ? new StorageError(code, operation, error) : error instanceof Error ? error : new Error(operation, { cause: error });
}
