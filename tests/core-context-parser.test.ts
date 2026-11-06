import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createIsolatedRuntime, type IsolatedRuntime } from "./fixtures/isolated-runtime.ts";
import { readCodexContext, readCodexContextFile, parseCodexTokenCount } from "../server/runner/codex-context.ts";
import { codexBindingMarker, coreContextMeasurement, discoverCodexSession, observeCompactBoundary, type CompactBoundaryBaseline } from "../server/runner/core-context.ts";
import { readDeliveryEvidence, readJsonlRange } from "../server/runner/delivery-evidence.ts";

let runtime: IsolatedRuntime;
beforeEach(() => { runtime = createIsolatedRuntime(); });
afterEach(async () => { await runtime.stop(); });
const nonce = "abcdefghijklmnopqrstuv";
function line(value: unknown) { return JSON.stringify(value) + "\n"; }
function meta(id = "session", extra: Record<string, unknown> = {}) { return { type: "session_meta", payload: { id, cwd: runtime.paths.work, source: "cli", ...extra } }; }
function user(text = codexBindingMarker(nonce)) { return { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }; }
function token(usage: unknown = { total_tokens: 49_096 }, window: unknown = 258_400) {
  return { type: "event_msg", timestamp: "2026-11-07T01:02:03Z", payload: { type: "token_count", info: { model_context_window: window, last_token_usage: usage, total_token_usage: { total_tokens: 9_999_999 } } } };
}
function rollout(id = "session", rows: unknown[] = [], date = "2026/11/07") {
  const path = join(runtime.paths.codexHome, "sessions", date, `rollout-time-${id}.jsonl`);
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, rows.map(line).join("")); return path;
}
function binding(cursor?: ReturnType<typeof discoverCodexSession>["cursor"]) { return discoverCodexSession({ home: runtime.paths.codexHome, cwd: runtime.paths.work, generation: 4, nonce, cursor }); }

describe("Codex context reuse", () => {
  test("current usage, exact nonstandard windows, null and zero remain distinct", () => {
    const path = rollout("session", [meta(), { type: "turn_context", payload: { model: "gpt-fixture" } }, token()]);
    expect(readCodexContext(runtime.paths.codexHome, "session")).toMatchObject({ tokens: 49_096, model: "gpt-fixture", exact: { window: 258_400, source: "codex" } });
    appendFileSync(path, line(token({ input_tokens: 10, cached_input_tokens: 500, output_tokens: 2 }, 475_001)));
    expect(readCodexContext(runtime.paths.codexHome, "session")).toMatchObject({ tokens: 12, exact: { window: 475_001 } });
    appendFileSync(path, line(token(null, 1_000_000)));
    expect(readCodexContext(runtime.paths.codexHome, "session")?.tokens).toBeNull();
    appendFileSync(path, line(token({ total_tokens: 0 })));
    expect(readCodexContext(runtime.paths.codexHome, "session")?.tokens).toBe(0);
    for (const usage of [{ total_tokens: -1 }, { total_tokens: null, input_tokens: 10, output_tokens: 2 }, { total_tokens: "100" }, { input_tokens: 1 }]) expect(parseCodexTokenCount(token(usage), "session")?.tokens).toBeNull();
    expect(parseCodexTokenCount(token({}, 0), "session")?.exact).toBeNull();
  });
  test("partial UTF-8/JSON is retained; model change and compact invalidate old usage", () => {
    const path = rollout("session", [meta(), token()]);
    const first = readCodexContextFile(runtime.paths.codexHome, path, "session");
    const bytes = Buffer.from(line({ type: "turn_context", payload: { model: "모델🙂" } }));
    const split = bytes.indexOf(Buffer.from("🙂")) + 1;
    appendFileSync(path, bytes.subarray(0, split));
    const second = readCodexContextFile(runtime.paths.codexHome, path, "session", first.cursor);
    expect(second.reading?.tokens).toBe(49_096); expect(second.complete).toBe(false);
    appendFileSync(path, bytes.subarray(split));
    const third = readCodexContextFile(runtime.paths.codexHome, path, "session", JSON.parse(JSON.stringify(second.cursor)));
    expect(third.reading).toBeNull(); expect(third.cursor?.model).toBe("모델🙂");
    appendFileSync(path, line(token()) + line({ type: "compacted", payload: {} }));
    expect(readCodexContextFile(runtime.paths.codexHome, path, "session", third.cursor).reading).toBeNull();
  });
  test("W0 fixture with large metadata, whitespace and partial trailing line remains supported", () => {
    const path = rollout("session", [meta("session", { base_instructions: "fixture".repeat(10000) })]);
    appendFileSync(path, " ".repeat(150_000) + "\n" + line(token({ total_tokens: 190_000 }, 475_000)) + '{"partial":');
    expect(readCodexContext(runtime.paths.codexHome, "session")).toMatchObject({ tokens: 190_000, exact: { window: 475_000 } });
    appendFileSync(path, "\n" + line(token(null, 272_000)));
    expect(readCodexContext(runtime.paths.codexHome, "session")).toMatchObject({ tokens: null, exact: { window: 272_000 } });
  });
  test("new same-model turn/user input and missing token info never reuse previous request usage", () => {
    const path = rollout("session", [meta(), token()]);
    const first = readCodexContextFile(runtime.paths.codexHome, path, "session");
    appendFileSync(path, line(user("new work")));
    const second = readCodexContextFile(runtime.paths.codexHome, path, "session", first.cursor);
    expect(second.reading).toBeNull();
    appendFileSync(path, line(token()) + line({ type: "event_msg", payload: { type: "token_count", info: null } }));
    expect(readCodexContextFile(runtime.paths.codexHome, path, "session", second.cursor).reading).toMatchObject({ tokens: null, exact: null });
  });
  test("tail approximation does not hide early delivery evidence", () => {
    const marker = "#iamceo_abcdefghijklmnopqrstuv";
    const path = rollout("session", [meta(), user(marker), token()]);
    appendFileSync(path, line({ type: "event_msg", payload: { type: "unknown", text: "x".repeat(60_000) } }).repeat(23));
    expect(readCodexContext(runtime.paths.codexHome, "session")).toBeNull();
    expect(readDeliveryEvidence({ cli: "codex", home: runtime.paths.codexHome, path, cwd: runtime.paths.work, sessionId: "session", sessionGeneration: 4, markers: [{ deliveryId: "d", marker }] }).receivedDeliveryIds).toEqual(["d"]);
  });
  test("filename, duplicate native ID, subagent and symlink cannot select a session", () => {
    rollout("wrong", [meta("session"), token()]);
    expect(readCodexContext(runtime.paths.codexHome, "wrong")).toBeNull();
    rollout("session", [meta(), token()]);
    rollout("session", [meta(), token()], "2026/11/08");
    expect(readCodexContext(runtime.paths.codexHome, "session")).toBeNull();
    rollout("child", [meta("child", { source: { subagent: "parent" } }), token()]);
    expect(readCodexContext(runtime.paths.codexHome, "child")).toBeNull();
    const outside = join(runtime.paths.work, "outside.jsonl"); writeFileSync(outside, line(meta("escape")) + line(token()));
    symlinkSync(outside, join(dirname(rollout("placeholder")), "rollout-time-escape.jsonl"));
    expect(readCodexContext(runtime.paths.codexHome, "escape")).toBeNull();
    expect(readCodexContext(runtime.paths.codexHome, "../escape")).toBeNull();
  });
  test("rotation/rewrite revalidates metadata and clears prior tokens", () => {
    const path = rollout("session", [meta(), token()]);
    expect(readCodexContext(runtime.paths.codexHome, "session")?.tokens).toBe(49_096);
    renameSync(path, path + ".old"); writeFileSync(path, line(meta("other")) + line(token({ total_tokens: 1 })));
    expect(readCodexContext(runtime.paths.codexHome, "session")).toBeNull();
    writeFileSync(path, line(meta()) + line(token({ total_tokens: 2 })));
    expect(readCodexContext(runtime.paths.codexHome, "session")?.tokens).toBe(2);
  });
});

describe("one nonce binding port", () => {
  test("same cwd concurrency and date boundary bind only the full user nonce", () => {
    rollout("wrong", [meta("wrong"), user("similar " + codexBindingMarker(nonce) + " suffix")], "2026/11/06");
    rollout("right", [meta("right"), user("real work\n" + codexBindingMarker(nonce))], "2026/11/07");
    rollout("child", [meta("child", { source: { subagent: "right" } }), user()]);
    expect(binding()).toMatchObject({ outcome: "bound", sessionId: "right" });
  });
  test("assistant/system/tool nonce and partial nonce are not bindings", () => {
    const response = user();
    rollout("session", [meta(), { ...response, payload: { ...response.payload, role: "assistant" } },
      { type: "response_item", payload: { type: "function_call_output", output: codexBindingMarker(nonce) } }, user(codexBindingMarker(nonce).slice(0, -1))]);
    expect(binding().sessionId).toBeNull();
    expect(() => codexBindingMarker("bad\nnonce")).toThrow();
  });
  test("8-file budget must finish all candidates before uniqueness; ninth conflict is found", () => {
    for (let i = 0; i < 9; i++) rollout(`s${i}`, [meta(`s${i}`), user(i === 0 || i === 8 ? codexBindingMarker(nonce) : "unrelated")]);
    const first = binding(); expect(first.outcome).toBe("pending"); expect(first.cursor.next).toBe(8);
    const second = binding(JSON.parse(JSON.stringify(first.cursor)));
    expect(second.outcome).toBe("conflict"); expect(second.sessionId).toBeNull();
  });
  test("large file advances at most 1MiB per tick; partial records resume", () => {
    const path = rollout("session", [meta()]);
    appendFileSync(path, line({ type: "event_msg", payload: { type: "unknown", text: "x".repeat(60_000) } }).repeat(23));
    const text = line(user()); appendFileSync(path, text.slice(0, -1));
    const first = binding(); expect(first.outcome).toBe("pending"); expect(first.cursor.files[0]!.log!.readOffset).toBe(1024 * 1024);
    const second = binding(first.cursor); expect(second.sessionId).toBeNull();
    appendFileSync(path, "\n");
    expect(binding(JSON.parse(JSON.stringify(second.cursor)))).toMatchObject({ outcome: "bound", sessionId: "session" });
  });
  test("generation changes and replaced candidates never retain a cached binding", () => {
    const path = rollout("session", [meta(), user()]), first = binding();
    expect(first.outcome).toBe("bound");
    expect(discoverCodexSession({ home: runtime.paths.codexHome, cwd: runtime.paths.work, generation: 5, nonce, cursor: first.cursor }).outcome).toBe("unknown");
    renameSync(path, path + ".old"); writeFileSync(path, line(meta()) + line(user("unrelated")));
    const second = binding(first.cursor); expect(second.outcome).toBe("pending");
    expect(binding(second.cursor).sessionId).toBeNull();
  });
  test("empty/partial candidate prevents uniqueness and a later appended conflict is discovered", () => {
    const firstPath = rollout("a", [meta("a"), user()]);
    rollout("b", []);
    expect(binding().outcome).toBe("unknown");
    writeFileSync(firstPath, line(meta("a")) + line(user()));
    rollout("b", [meta("b"), user("unrelated")]);
    const bound = binding(); expect(bound.outcome).toBe("bound");
    appendFileSync(rollout("c", [meta("c")]), line(user()));
    expect(binding(bound.cursor).outcome).toBe("conflict");
  });
});

const identity = { sessionId: "session", generation: 4, terminalId: "t1", turn: 2, model: "model" };
describe("measurement identity and quality", () => {
  const hints = { learned: null, fallback: 1_000_000 };
  test("190k/1M is exact 19%; null/overflow is never fresh auto evidence", () => {
    const reading = { sessionId: "session", model: "model", tokens: 190_000, shownPct: null, exact: { window: 1_000_000, source: "codex" as const } };
    const opts = { complete: true, fresh: true, measuredAt: "2026-11-07T00:00:00Z" };
    expect(coreContextMeasurement(reading, identity, identity, hints, opts)).toMatchObject({ tokens: 190_000, window: 1_000_000, quality: "exact", fresh: true });
    expect(coreContextMeasurement({ ...reading, tokens: null }, identity, identity, hints, opts)?.fresh).toBe(false);
    expect(coreContextMeasurement({ ...reading, tokens: 2_000_000 }, identity, identity, hints, opts)).toMatchObject({ quality: "estimated", fresh: false });
    expect(coreContextMeasurement(reading, identity, identity, hints, { ...opts, complete: false })?.fresh).toBe(false);
    expect(coreContextMeasurement({ ...reading, model: null }, { ...identity, model: null }, { ...identity, model: null }, hints, opts)?.fresh).toBe(false);
    expect(coreContextMeasurement(reading, { ...identity, turn: null }, { ...identity, turn: null }, hints, opts)?.fresh).toBe(false);
  });
  test("late generation, model, terminal, session and completed-turn samples are rejected", () => {
    const reading = { sessionId: "session", model: "model", tokens: 0, shownPct: null, exact: { window: 1_000_000, source: "codex" as const } };
    for (const patch of [{ generation: 5 }, { sessionId: "other" }, { terminalId: "t2" }, { model: "new" }, { turn: 3 }]) expect(coreContextMeasurement(reading, identity, { ...identity, ...patch }, hints, { complete: true, fresh: true, measuredAt: "now" })).toBeNull();
    expect(coreContextMeasurement(reading, identity, identity, hints, { complete: true, fresh: true, measuredAt: "now" })).toMatchObject({ tokens: 0, fresh: true });
  });
  test("estimated measurements retain the shared fallback denominator", () => {
    expect(coreContextMeasurement({ tokens: 190_000, shownPct: null, model: "model" }, identity, identity, hints, { complete: true, fresh: true, measuredAt: "now" })).toMatchObject({ window: 1_000_000, source: "default", quality: "estimated", fresh: false });
  });
});

describe("compact boundary observation", () => {
  function setup(cli: "claude" | "codex") {
    const home = cli === "claude" ? runtime.paths.claudeHome : runtime.paths.codexHome;
    const path = cli === "codex" ? rollout("session", [meta(), { type: "compacted", payload: {} }]) : join(home, "projects", "cwd", "session.jsonl");
    if (cli === "claude") { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, line({ type: "system", subtype: "compact_boundary", sessionId: "session", cwd: runtime.paths.work })); }
    const log = readJsonlRange(home, path).cursor!;
    const baseline: CompactBoundaryBaseline = { ...identity, path, fileIdentity: log.fileIdentity, offset: log.offset };
    return { cli, home, cwd: runtime.paths.work, baseline, current: { ...identity, turn: 3 }, settled: false, providerError: false };
  }
  test("old boundary, token decrease and OSC settling alone cannot succeed", () => {
    const opts = setup("codex");
    appendFileSync(opts.baseline.path, line(token({ total_tokens: 1 })));
    expect(observeCompactBoundary({ ...opts, settled: true }).outcome).toBe("pending");
  });
  test("Claude and Codex require new complete boundary plus same-owner settled return", () => {
    for (const cli of ["claude", "codex"] as const) {
      const opts = setup(cli);
      const boundary = cli === "codex" ? { type: "compacted", payload: {} } : { type: "system", subtype: "compact_boundary", sessionId: "session", cwd: runtime.paths.work };
      appendFileSync(opts.baseline.path, line(boundary).slice(0, -1));
      const partial = observeCompactBoundary(opts); expect(partial.outcome).toBe("unknown");
      appendFileSync(opts.baseline.path, "\n");
      const pending = observeCompactBoundary({ ...opts, cursor: partial.cursor }); expect(pending.outcome).toBe("pending");
      expect(observeCompactBoundary({ ...opts, cursor: pending.cursor, settled: true }).outcome).toBe("succeeded");
      expect(observeCompactBoundary({ ...opts, cursor: pending.cursor, settled: true, providerError: true }).outcome).toBe("unknown");
      expect(observeCompactBoundary({ ...opts, current: { ...opts.current, generation: 5 }, settled: true }).outcome).toBe("unknown");
      expect(observeCompactBoundary({ ...opts, cwd: "/other", cursor: pending.cursor, settled: true }).outcome).toBe("unknown");
    }
  });
  test("wrong Claude session, sidechain, compatibility compact text and replaced file are not success", () => {
    const opts = setup("claude");
    appendFileSync(opts.baseline.path, line({ type: "system", subtype: "compact_boundary", sessionId: "other", cwd: runtime.paths.work }) + line({ type: "system", subtype: "compact_boundary", sessionId: "session", cwd: runtime.paths.work, isSidechain: true }));
    expect(observeCompactBoundary({ ...opts, settled: true }).outcome).toBe("pending");
    renameSync(opts.baseline.path, opts.baseline.path + ".old"); writeFileSync(opts.baseline.path, "\n");
    expect(observeCompactBoundary({ ...opts, settled: true }).outcome).toBe("unknown");
    const codex = setup("codex"); appendFileSync(codex.baseline.path, line({ type: "event_msg", payload: { type: "context_compacted" } }));
    expect(observeCompactBoundary({ ...codex, settled: true }).outcome).toBe("pending");
  });
});
