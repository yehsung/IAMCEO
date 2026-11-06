import { describe, expect, test } from "bun:test";
import type { RuntimeInfo } from "../shared/types";
import { providerName, runtimeBlock } from "../web/src/lib/runtime";

const healthy = (): RuntimeInfo => ({
  backend: "core",
  core: { installed: true, available: true, version: "0.1.18", detail: null },
  providers: { claude: { installed: true }, codex: { installed: true } },
});

describe("web runtime launch gate", () => {
  test("unknown diagnosis blocks starting instead of reporting success", () => {
    expect(runtimeBlock(null)).toContain("확인");
    expect(runtimeBlock(null, "codex")).not.toBeNull();
  });
  test("installed core that cannot connect still blocks and preserves actionable detail", () => {
    const runtime = healthy();
    runtime.core.available = false;
    runtime.core.detail = "서버 실행 환경 연결 실패";
    expect(runtimeBlock(runtime, "claude")).toBe(runtime.core.detail);
  });
  test("missing chosen CLI blocks while the installed provider stays available", () => {
    const runtime = healthy();
    runtime.providers.codex.installed = false;
    expect(runtimeBlock(runtime, "codex")).toContain("Codex CLI");
    expect(runtimeBlock(runtime, "claude")).toBeNull();
  });
  test("healthy core and selected installed provider permit a real server launch", () => {
    for (const cli of ["claude", "codex"] as const) {
      expect(runtimeBlock(healthy(), cli)).toBeNull();
      expect(providerName(cli)).toBe(cli === "claude" ? "Claude Code" : "Codex");
    }
  });
});
