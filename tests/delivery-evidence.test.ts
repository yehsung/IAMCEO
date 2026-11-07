import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, renameSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createIsolatedRuntime, type IsolatedRuntime } from "./fixtures/isolated-runtime.ts";
import { hasExactMarker, parseProviderUserText, readDeliveryEvidence, readJsonlRange, type DeliveryEvidenceOptions } from "../server/runner/delivery-evidence.ts";

let runtime: IsolatedRuntime;
beforeEach(() => { runtime = createIsolatedRuntime(); });
afterEach(async () => { await runtime.stop(); });
const marker = "#iamceo_abcdefghijklmnopqrstuv";
const other = "#iamceo_ABCDEFGHIJKLMNOPQRSTUV";
const bundleMarker = "#iamceo_b_0123456789012345678901";
function line(value: unknown): string { return JSON.stringify(value) + "\n"; }
function claude(content: unknown = marker, extra: Record<string, unknown> = {}) {
  return { type: "user", sessionId: "session", cwd: runtime.paths.work, uuid: "event", message: { role: "user", content }, ...extra };
}
function meta(id = "session", extra: Record<string, unknown> = {}) { return { type: "session_meta", payload: { id, cwd: runtime.paths.work, source: "cli", ...extra } }; }
function codex(text = marker, extra: Record<string, unknown> = {}) { return { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }], ...extra } }; }
function fixture(cli: "claude" | "codex" = "claude", rows: unknown[] = []): DeliveryEvidenceOptions {
  const home = cli === "claude" ? runtime.paths.claudeHome : runtime.paths.codexHome;
  const path = cli === "claude" ? join(home, "projects", "encoded-cwd", "session.jsonl") : join(home, "sessions", "2026/11/07", "rollout-time-session.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map(line).join(""));
  return { cli, home, path, cwd: runtime.paths.work, sessionId: "session", sessionGeneration: 3, markers: [{ deliveryId: "d1", marker }, { deliveryId: "d2", marker: other }] };
}

describe("direct user evidence", () => {
  test("Claude string/text arrays count; sidechain, meta, roles, tools and quotes do not", () => {
    for (const row of [claude(marker, { isSidechain: true }), claude(marker, { isMeta: true }), claude(marker, { type: "assistant" }),
      claude([{ type: "tool_result", content: marker }]), claude(marker, { message: { role: "assistant", content: marker } })]) {
      const result = readDeliveryEvidence(fixture("claude", [row]));
      expect(result.receivedDeliveryIds).toEqual([]);
    }
    expect(readDeliveryEvidence(fixture("claude", [claude([{ type: "text", text: marker }])])).receivedDeliveryIds).toEqual(["d1"]);
    expect(readDeliveryEvidence(fixture("claude", [claude()])).evidence).toMatchObject({ verdict: "present", location: "received_input" });
  });
  test("Codex response_item and compatibility user_message deduplicate per generation/delivery", () => {
    const opts = fixture("codex", [meta(), codex(), { type: "event_msg", payload: { type: "user_message", message: marker } }]);
    const result = readDeliveryEvidence(opts);
    expect(result.receivedDeliveryIds).toEqual(["d1"]);
    expect(result.evidence.complete).toBe(true);
    expect(readDeliveryEvidence({ ...opts, cursor: JSON.parse(JSON.stringify(result.cursor)) }).receivedDeliveryIds).toEqual(["d1"]);
  });
  test("Codex assistant/developer/tool text and nested tool results are excluded", () => {
    const opts = fixture("codex", [meta(), codex(marker, { role: "assistant" }), codex(marker, { role: "developer" }),
      { type: "response_item", payload: { type: "function_call_output", output: marker } },
      codex(marker, { content: [{ type: "tool_result", text: marker, content: [{ type: "input_text", text: marker }] }] })]);
    expect(readDeliveryEvidence(opts).evidence).toMatchObject({ verdict: "absent", complete: true });
  });
  test("bundle marker covers exactly the saved items; individual markers cover only their item", () => {
    expect(readDeliveryEvidence(fixture("claude", [claude()])).receivedDeliveryIds).toEqual(["d1"]);
    expect(readDeliveryEvidence({ ...fixture("claude", [claude(bundleMarker)]), bundleMarker }).receivedDeliveryIds).toEqual(["d1", "d2"]);
  });
  test("exact boundaries and Unicode are not normalized", () => {
    for (const text of [`x${marker}`, `${marker}x`, `${marker}_`, `${marker}-`, `${marker}한`, `한${marker}`, `𐐀${marker}`, marker.replace("a", "ａ"), marker.replace("_", " _")]) expect(hasExactMarker(text, marker)).toBe(false);
    for (const text of [marker, `\n${marker}\n`, `(${marker})`]) expect(hasExactMarker(text, marker)).toBe(true);
    expect(hasExactMarker(marker, "")).toBe(false);
    expect(readDeliveryEvidence({ ...fixture("claude", [claude()]), markers: [{ deliveryId: "d1", marker: "#msg_old" }] }).evidence.verdict).toBe("unknown");
  });
  test("other native session/cwd produces conflict, never target receipt or absence", () => {
    for (const row of [claude(marker, { sessionId: "other" }), claude(marker, { cwd: "/other" })]) {
      expect(readDeliveryEvidence(fixture("claude", [row]))).toMatchObject({ receivedDeliveryIds: [], evidence: { verdict: "unknown", code: "session_conflict" } });
    }
    expect(readDeliveryEvidence(fixture("codex", [meta("other"), codex()])).evidence.code).toBe("session_conflict");
    expect(readDeliveryEvidence(fixture("codex", [meta("session", { session_id: "other" }), codex()])).receivedDeliveryIds).toEqual([]);
  });
  test("no metadata/unknown records and subagent metadata cannot prove target absence", () => {
    for (const rows of [[codex()], [meta("session", { source: { subagent: "parent" } }), codex()], [{ type: "new_provider_format", text: marker }]]) {
      expect(readDeliveryEvidence(fixture("codex", rows)).evidence.verdict).toBe("unknown");
    }
    expect(readDeliveryEvidence(fixture("claude", [])).evidence.verdict).toBe("unknown");
    expect(parseProviderUserText("claude", null)).toBeNull();
  });
  test("future user text layouts cannot prove absence", () => {
    for (const content of [{ text: marker }, [{ type: "future_text", value: marker }], [{ type: "text", text: { value: marker } }]]) {
      expect(readDeliveryEvidence(fixture("claude", [claude(content)])).evidence.verdict).toBe("unknown");
      expect(readDeliveryEvidence(fixture("codex", [meta(), codex(marker, { content })])).evidence.verdict).toBe("unknown");
    }
  });
});

describe("Claude Code 2.1.31x transcript layout (observed in a real 2.1.319 session)", () => {
  const cwdOf = () => runtime.paths.work;
  const metaRows = () => [
    { type: "mode", mode: "normal", sessionId: "session" },
    { type: "permission-mode", permissionMode: "bypassPermissions", sessionId: "session" },
    { type: "session-owner", accountUuid: "a", organizationUuid: "o", sessionId: "session" },
    { type: "atis-latch", atis: "", sessionId: "session" },
    { type: "attachment", sessionId: "session", cwd: cwdOf(), uuid: "att", attachment: { type: "hook_success", hookName: "SessionStart:startup", content: "" } },
    { type: "attachment", sessionId: "session", cwd: cwdOf(), uuid: "att2", attachment: { type: "prompt_snapshot", systemPrompt: [marker] } },
    { type: "api-request-shape", sessionId: "session", shape: { system: [] }, shapeHash: "h" },
    { type: "api-request", sessionId: "session", id: "r", params: { model: "claude-haiku-5-5" }, tail: ["h1"] },
    { type: "tools-used", sessionId: "session", tools: ["ToolSearch"] },
  ];
  const pasted = (text: string) => `\n\n<pasted_content id="a135">\n[시스템] 지금 상황: 연습\n${text}\n</pasted_content>`;
  test("metadata records do not hide a marker in the user record, including the pasted_content wrapper", () => {
    const result = readDeliveryEvidence(fixture("claude", [...metaRows(), claude(pasted(marker))]));
    expect(result.receivedDeliveryIds).toEqual(["d1"]);
    expect(result.evidence).toMatchObject({ verdict: "present", code: "marker_in_user_input" });
  });
  test("metadata-only range plus a recognized user record without the marker proves absence", () => {
    const result = readDeliveryEvidence(fixture("claude", [...metaRows(), claude(pasted("다른 지시 #iamceo_zzzzzzzzzzzzzzzzzzzzzz"))]));
    expect(result.evidence).toMatchObject({ verdict: "absent", complete: true, code: "complete_range_without_marker" });
  });
  test("a marker only in an API request copy is never absence", () => {
    const blob = { type: "api-request-blob", sessionId: "session", hash: "h1", message: { role: "user", content: [{ type: "text", text: pasted(marker) }] } };
    const result = readDeliveryEvidence(fixture("claude", [...metaRows(), claude(pasted("다른 글")), blob]));
    expect(result.receivedDeliveryIds).toEqual([]);
    expect(result.evidence).toMatchObject({ verdict: "unknown", complete: false, code: "marker_outside_user_input" });
    const both = readDeliveryEvidence(fixture("claude", [...metaRows(), claude(pasted(marker)), blob]));
    expect(both.evidence).toMatchObject({ verdict: "present", code: "marker_in_user_input" });
  });
  test("a still-unknown record type keeps the range unsupported", () => {
    const result = readDeliveryEvidence(fixture("claude", [...metaRows(), { type: "queued-input-v9", sessionId: "session", text: marker }, claude("다른 글")]));
    expect(result.evidence).toMatchObject({ verdict: "unknown", code: "unrecognized_layout" });
  });
});

describe("range and identity safety", () => {
  test("baseline byte offset and event id exclude old/replayed inputs", () => {
    const opts = fixture("claude", [claude()]);
    const first = readDeliveryEvidence(opts);
    const log = first.cursor!.log!;
    const baseline = { path: opts.path, fileIdentity: log.fileIdentity, offset: log.offset, eventId: "event" };
    appendFileSync(opts.path, line(claude(marker)) + line(claude(marker, { uuid: "old", isReplay: true })));
    expect(readDeliveryEvidence({ ...opts, baseline }).evidence.verdict).toBe("absent");
    appendFileSync(opts.path, line(claude(marker, { uuid: "new" })));
    expect(readDeliveryEvidence({ ...opts, baseline }).receivedDeliveryIds).toEqual(["d1"]);
    expect(readDeliveryEvidence({ ...opts, baseline: { ...baseline, offset: 1 } }).evidence.verdict).toBe("unknown");
  });
  test("Codex baseline revalidates metadata; timestamp excludes resumed old input", () => {
    const opts = fixture("codex", [meta(), codex()]);
    const log = readDeliveryEvidence(opts).cursor!.log!;
    const baseline = { path: opts.path, fileIdentity: log.fileIdentity, offset: log.offset, eventId: null };
    appendFileSync(opts.path, line({ ...codex(), timestamp: "2025-01-01T00:00:00Z" }));
    expect(readDeliveryEvidence({ ...opts, baseline, since: "2026-01-01T00:00:00Z" }).evidence.verdict).toBe("absent");
    expect(readDeliveryEvidence({ ...opts, baseline: { ...baseline, fileIdentity: null } }).evidence.code).toBe("invalid_baseline");
  });
  test("cursor is bound to generation, session, cwd, path and immutable marker set", () => {
    const opts = fixture("claude", [claude()]), cursor = readDeliveryEvidence(opts).cursor;
    for (const patch of [{ sessionGeneration: 4 }, { sessionId: "other" }, { cwd: "/other" }, { markers: [{ deliveryId: "d1", marker: other }] }]) {
      expect(readDeliveryEvidence({ ...opts, ...patch, cursor }).evidence).toMatchObject({ verdict: "unknown", code: "generation_changed" });
    }
  });
  test("incremental scan preserves split UTF-8 and partial final JSON until newline", () => {
    const opts = fixture("claude");
    const bytes = Buffer.from(line(claude(`한글🙂\n${marker}`)));
    const split = bytes.indexOf(Buffer.from("🙂")) + 2;
    writeFileSync(opts.path, bytes.subarray(0, split));
    const first = readDeliveryEvidence(opts);
    expect(first.evidence.verdict).toBe("unknown");
    expect(first.cursor!.log!.offset).toBe(0);
    appendFileSync(opts.path, bytes.subarray(split, bytes.length - 1));
    const second = readDeliveryEvidence({ ...opts, cursor: JSON.parse(JSON.stringify(first.cursor)) });
    expect(second.receivedDeliveryIds).toEqual([]);
    appendFileSync(opts.path, "\n");
    const third = readDeliveryEvidence({ ...opts, cursor: JSON.parse(JSON.stringify(second.cursor)) });
    expect(third.receivedDeliveryIds).toEqual(["d1"]);
    expect(third.cursor!.log!.offset).toBe(bytes.length);
  });
  test("4MiB budget resumes to a marker beyond the first pass without false absence", () => {
    const opts = fixture("claude");
    const filler = line(claude("x".repeat(60_000)));
    writeFileSync(opts.path, filler.repeat(73) + line(claude(marker, { uuid: "last" })));
    const first = readDeliveryEvidence(opts);
    expect(first.evidence).toMatchObject({ verdict: "unknown", code: "scan_pending", complete: false });
    expect(first.cursor!.log!.readOffset).toBe(4 * 1024 * 1024);
    const second = readDeliveryEvidence({ ...opts, cursor: JSON.parse(JSON.stringify(first.cursor)) });
    expect(second.receivedDeliveryIds).toEqual(["d1"]);
    expect(second.evidence.complete).toBe(true);
  });
  test("giant lines are skipped with permanent unknown, subsequent positive evidence still works", () => {
    const opts = fixture("claude");
    writeFileSync(opts.path, line(claude("x".repeat(4 * 1024 * 1024 + 100))));
    const first = readDeliveryEvidence(opts);
    const second = readDeliveryEvidence({ ...opts, cursor: JSON.parse(JSON.stringify(first.cursor)) });
    expect(second.evidence.verdict).toBe("unknown");
    appendFileSync(opts.path, line(claude()));
    expect(readDeliveryEvidence({ ...opts, cursor: second.cursor })).toMatchObject({ receivedDeliveryIds: ["d1"], evidence: { verdict: "present", complete: false } });
  });
  test("malformed/invalid UTF-8 rows permanently invalidate absence", () => {
    const opts = fixture("claude", [claude("no marker")]);
    appendFileSync(opts.path, Buffer.from([0xff, 10]));
    const first = readDeliveryEvidence(opts);
    expect(first.evidence).toMatchObject({ verdict: "unknown", code: "corrupt_log" });
    expect(readDeliveryEvidence({ ...opts, cursor: first.cursor }).evidence.verdict).toBe("unknown");
  });
  test("zero/negative budgets never scan or prove absence; each completed chunk matches whole scan", () => {
    const opts = fixture("codex", [meta(), codex("no marker"), codex(marker)]);
    for (const maxBytes of [0, -10]) {
      const result = readDeliveryEvidence({ ...opts, maxBytes });
      expect(result.evidence.verdict).toBe("unknown"); expect(result.cursor!.log!.readOffset).toBe(0);
    }
    let result = readDeliveryEvidence({ ...opts, maxBytes: 7 });
    for (let i = 0; i < 200 && !result.evidence.complete; i++) result = readDeliveryEvidence({ ...opts, maxBytes: 7, cursor: JSON.parse(JSON.stringify(result.cursor)) });
    expect(result.evidence.complete).toBe(true); expect(result.receivedDeliveryIds).toEqual(["d1"]);
  });
  test("old event ids repeated in the scan cannot become new receipts", () => {
    const opts = fixture("claude", [claude("no marker"), claude(marker)]);
    expect(readDeliveryEvidence(opts).evidence.verdict).toBe("absent");
  });
  test("rotation, move, truncate, rewrite and missing file never preserve cached receipt", () => {
    const opts = fixture("claude", [claude()]), first = readDeliveryEvidence(opts);
    renameSync(opts.path, opts.path + ".old");
    expect(readDeliveryEvidence({ ...opts, cursor: first.cursor }).evidence.verdict).toBe("unknown");
    writeFileSync(opts.path, line(claude()));
    expect(readDeliveryEvidence({ ...opts, cursor: first.cursor }).evidence.code).toBe("file_changed");
    const next = readDeliveryEvidence(opts);
    truncateSync(opts.path, 0);
    expect(readDeliveryEvidence({ ...opts, cursor: next.cursor }).evidence.code).toBe("file_changed");
    writeFileSync(opts.path, line(claude()));
    const third = readDeliveryEvidence(opts);
    writeFileSync(opts.path, line(claude("z".repeat(marker.length))));
    expect(readDeliveryEvidence({ ...opts, cursor: third.cursor }).evidence.code).toBe("file_changed");
  });
  test("symlink escapes, sibling prefix and non-log provider directories are refused", () => {
    const opts = fixture("claude", [claude()]);
    const outside = join(runtime.paths.work, "outside.jsonl");
    writeFileSync(outside, line(claude()));
    const link = join(dirname(opts.path), "linked.jsonl");
    symlinkSync(outside, link);
    expect(readDeliveryEvidence({ ...opts, path: link }).evidence.verdict).toBe("unknown");
    expect(readDeliveryEvidence({ ...opts, path: outside }).evidence.verdict).toBe("unknown");
    const config = join(opts.home, "config.jsonl"); writeFileSync(config, line(claude()));
    expect(readDeliveryEvidence({ ...opts, path: config }).evidence.verdict).toBe("unknown");
    expect(readJsonlRange(opts.home, dirname(opts.path)).complete).toBe(false);
  });
});
