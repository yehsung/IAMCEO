import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";

export interface Vitals {
  rssMb: number; heapMb: number; dbMb: number; walMb: number;
  rows: Record<string, number>;
}

const TABLES = ["deliveries", "delivery_dispatches", "agent_operation_receipts", "messages", "files", "activity"] as const;
const mb = (bytes: number) => Math.round(bytes / 1024 / 1024 * 10) / 10;
const size = (path: string) => { try { return statSync(path).size; } catch { return 0; } };

/** 서버가 스스로 커지는지(메모리·DB·WAL·쌓이는 표) 볼 수 있는 값. 내용은 읽지 않고 크기와 행 수만 센다. */
export function readVitals(db: Database, dbPath: string, memory: () => { rss: number; heapUsed: number } = () => process.memoryUsage()): Vitals {
  const used = memory();
  const rows: Record<string, number> = {};
  for (const table of TABLES) {
    try { rows[table] = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0; } catch { /* 옛 스키마에 없는 표 */ }
  }
  return { rssMb: mb(used.rss), heapMb: mb(used.heapUsed), dbMb: mb(size(dbPath)), walMb: mb(size(`${dbPath}-wal`)), rows };
}

/** 느려지는 원인이 서버가 커진 탓인지 가릴 수 있게 주기적으로 한 줄을 남긴다. 크게 넘으면 경고로 적는다. */
export function vitalsLine(vitals: Vitals): { line: string; warn: boolean } {
  const warn = vitals.rssMb > 1024 || vitals.walMb > 256;
  return { warn, line: `[vitals] rssMb=${vitals.rssMb} heapMb=${vitals.heapMb} dbMb=${vitals.dbMb} walMb=${vitals.walMb} ${Object.entries(vitals.rows).map(([table, n]) => `${table}=${n}`).join(" ")}${warn ? " — 메모리나 WAL 이 평소보다 큽니다" : ""}` };
}
