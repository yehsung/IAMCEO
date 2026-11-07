import { describe, expect, test } from "bun:test";
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoundedLogWriter } from "../server/log-writer.ts";

describe("bounded dedicated log writer", () => {
  test("rotation closes/reopens its FD; bytes after rotation reach a new inode and total disk is bounded", () => {
    const dir = mkdtempSync("/private/tmp/iamceo-log-");
    const path = join(dir, "server.log");
    const writer = new BoundedLogWriter(path, { maxBytes: 16, generations: 3, maxPendingBytes: 256 });
    writer.write(Buffer.from("a".repeat(16))); writer.flush();
    const original = openSync(path, "r");
    try {
      writer.write(Buffer.from("b".repeat(16))); writer.flush();
      expect(fstatSync(original).ino).toBe(statSync(`${path}.1`).ino);
      expect(statSync(path).ino).not.toBe(fstatSync(original).ino);
      expect(readFileSync(path, "utf8")).toBe("b".repeat(16));
      expect(readFileSync(`${path}.1`, "utf8")).toBe("a".repeat(16));
      writer.write(Buffer.from("c".repeat(80))); writer.close();
      expect(readdirSync(dir).sort()).toEqual(["server.log", "server.log.1", "server.log.2"]);
      expect(readdirSync(dir).reduce((sum, file) => sum + statSync(join(dir, file)).size, 0)).toBe(48);
      for (const file of readdirSync(dir)) expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
    } finally { closeSync(original); writer.close(); }
  });

  test("queue overflow is counted, bounded, and caller buffer reuse cannot alter accepted bytes", () => {
    const path = join(mkdtempSync("/private/tmp/iamceo-log-"), "stderr.log");
    const writer = new BoundedLogWriter(path, { maxBytes: 100, maxPendingBytes: 8 });
    const bytes = Buffer.from("accepted");
    expect(writer.write(bytes)).toBe(true);
    bytes.fill(0);
    expect(writer.write(Buffer.from("lost"))).toBe(false);
    expect(writer.pendingBytes).toBe(8); expect(writer.droppedBytes).toBe(4);
    writer.flush();
    expect(writer.pendingBytes).toBe(0);
    expect(readFileSync(path, "utf8")).toBe("accepted");
    writer.close(); writer.close();
    expect(() => writer.write(Buffer.from("late"))).toThrow("closed");
  });

  test("one generation and existing oversized logs remain within bounds; unsafe paths fail", () => {
    const dir = mkdtempSync("/private/tmp/iamceo-log-");
    const path = join(dir, "server.log");
    writeFileSync(path, "legacy".repeat(100));
    const writer = new BoundedLogWriter(path, { maxBytes: 10, generations: 1 });
    writer.write(Buffer.from("abcdefghijklmnopqrstuvw")); writer.close();
    expect(readFileSync(path, "utf8")).toBe("uvw");
    expect(readdirSync(dir)).toEqual(["server.log"]);
    const secret = join(dir, "secret"); writeFileSync(secret, "preserve");
    symlinkSync(secret, join(dir, "link"));
    expect(() => new BoundedLogWriter(join(dir, "link"))).toThrow();
    expect(readFileSync(secret, "utf8")).toBe("preserve");
    expect(() => new BoundedLogWriter(path, { maxBytes: 0 })).toThrow("bound");
  });
});
