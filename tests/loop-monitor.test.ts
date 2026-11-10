import { expect, test } from "bun:test";
import { LoopMonitor } from "../server/loop-monitor.ts";

test("250ms sample reports >500ms blocking with completed route/timer and coalesces bursts", () => {
  let now = 0;
  const lines: string[] = [];
  const monitor = new LoopMonitor({ now: () => now, log: line => lines.push(line) });
  try {
    monitor.run("GET /api/sync build", () => { now += 800; });
    monitor.sample();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("slow GET /api/sync build count=1 maxMs=800.0");
    expect(lines[1]).toContain("lag work=GET /api/sync build count=1 maxMs=550.0");
    for (let i = 0; i < 3; i++) {
      monitor.run("GET /api/sync build", () => { now += 900; });
      monitor.sample();
    }
    expect(lines).toHaveLength(2);
    monitor.stop();
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain("count=3 maxMs=900.0");
    expect(lines[3]).toContain("count=3 maxMs=650.0");
  } finally { monitor.stop(); }
});

test("real artificial blocking is attributed after the callback returns", async () => {
  const lines: string[] = [];
  const monitor = new LoopMonitor({ log: line => lines.push(line) });
  try {
    monitor.run("timer:onTick", () => {
      const until = performance.now() + 820;
      while (performance.now() < until) { /* deliberate main-thread stall */ }
    });
    await Bun.sleep(20);
    expect(lines.some(line => line.includes("lag work=timer:onTick"))).toBe(true);
    expect(lines.some(line => line.includes("slow timer:onTick"))).toBe(true);
  } finally { monitor.stop(); }
});

test("fast callbacks stay quiet, return/throw unchanged, and stop cancels sampling", async () => {
  let now = 0;
  const lines: string[] = [];
  const monitor = new LoopMonitor({ now: () => now, log: line => lines.push(line) });
  expect(monitor.run("fast", () => 42)).toBe(42);
  expect(() => monitor.run("throw", () => { throw new Error("original"); })).toThrow("original");
  expect(await monitor.runAsync("async", async () => 43)).toBe(43);
  now = 750; // exactly 500ms lag is not over the threshold
  monitor.sample();
  monitor.stop();
  now += 5000;
  monitor.sample();
  expect(lines).toEqual([]);
});

test("an unobserved pause is not blamed on the last fast route", () => {
  let now = 0;
  const lines: string[] = [];
  const monitor = new LoopMonitor({ now: () => now, log: line => lines.push(line) });
  try {
    monitor.run("GET /api/sync", () => { now += 1; });
    now = 900;
    monitor.sample();
    expect(lines).toEqual(["[loop-monitor] lag work=unattributed count=1 maxMs=650.0"]);
  } finally { monitor.stop(); }
});
