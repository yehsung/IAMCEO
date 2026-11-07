import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalogReader } from "../server/models.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { startServer } from "../server/http.ts";
import type { OrchestratorApi } from "../server/orchestrator-api.ts";
import { Store } from "../server/store.ts";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "iamceo-models-"));
  const claudeHome = join(home, "claude"), codexHome = join(home, "codex");
  mkdirSync(claudeHome); mkdirSync(codexHome);
  const claudePath = join(claudeHome, ".claude.json"), codexPath = join(codexHome, "models_cache.json");
  const reader = new ModelCatalogReader({ userHome: home, claudeHome, codexHome });
  return { home, claudeHome, codexHome, claudePath, codexPath, reader };
}

const model = (slug: string, priority: number, visibility = "list") => ({
  slug, display_name: `Label ${slug}`, description: `About ${slug}`, priority, visibility,
  supported_in_api: false, supported_reasoning_levels: [{ effort: "low", description: "Quick" }, { effort: "xhigh", description: "Deep" }],
  default_reasoning_level: "xhigh",
});

describe("CLI model catalog (isolated fake homes only)", () => {
  test("projects only listed Codex models in priority order with their reasoning levels", () => {
    const f = fixture();
    writeFileSync(f.codexPath, JSON.stringify({ fetched_at: "2026-01-01", identity: { secret: "codex-account-secret" }, models: [model("late", 8), model("hidden", 0, "hide"), model("first", 1)] }));
    const list = f.reader.read().codex;
    expect(list.source).toBe("cli");
    expect(list.models.map(m => m.value)).toEqual(["first", "late"]);
    expect(list.models[0]).toEqual({ value: "first", label: "Label first", description: "About first", efforts: ["low", "xhigh"], defaultEffort: "xhigh" });
    expect(list.updatedAt).toBeDefined();
    expect(JSON.stringify(list)).not.toContain("codex-account-secret");
  });

  test("Claude aliases plus additional options; unrelated account keys never enter response", () => {
    const f = fixture();
    writeFileSync(f.claudePath, JSON.stringify({ oauthAccount: { emailAddress: "private-account-secret" }, arbitrary: "do-not-export", additionalModelOptionsCache: [
      { value: "claude-fable-5-1[1m]", label: "Fable", description: "Extra", accountSecret: "nested-secret" },
      { value: "opus", label: "duplicate" }, { value: "--bad", label: "Invalid" },
    ] }));
    const list = f.reader.read().claude;
    expect(list.source).toBe("cli");
    expect(list.models.map(m => m.value)).toEqual(["opus", "sonnet", "haiku", "claude-fable-5-1[1m]"]);
    expect(list.models[3]).toEqual({ value: "claude-fable-5-1[1m]", label: "Fable", description: "Extra", efforts: ["low", "medium", "high", "xhigh", "max"] });
    for (const secret of ["private-account-secret", "do-not-export", "nested-secret", "oauthAccount"]) expect(JSON.stringify(list)).not.toContain(secret);
  });

  test("missing, broken JSON and malformed schema use defaults", () => {
    const f = fixture();
    for (const content of [undefined, "{broken", "null", '{"models":{},"additionalModelOptionsCache":{}}']) {
      if (content !== undefined) { writeFileSync(f.codexPath, content); writeFileSync(f.claudePath, content); }
      const catalog = f.reader.read();
      expect(catalog.claude.source).toBe("default");
      expect(catalog.codex.source).toBe("default");
      expect(catalog.claude.models.map(m => m.value)).toEqual(["opus", "sonnet", "haiku"]);
      expect(catalog.codex.models.map(m => m.value)).toEqual(["gpt-6.1-sol", "gpt-6-luna", "gpt-6.1-terra", "gpt-6-astra"]);
    }
  });

  test("unchanged files reuse parsed lists; file changes, repair and deletion invalidate cache", () => {
    const f = fixture();
    writeFileSync(f.codexPath, JSON.stringify({ models: [model("before", 1)] }));
    writeFileSync(f.claudePath, JSON.stringify({ additionalModelOptionsCache: [] }));
    const before = f.reader.read();
    expect(f.reader.read().codex).toBe(before.codex);
    expect(f.reader.read().claude).toBe(before.claude);
    writeFileSync(f.codexPath, JSON.stringify({ models: [model("after", 1)] }));
    utimesSync(f.codexPath, new Date(), new Date(Date.now() + 2000));
    writeFileSync(f.claudePath, JSON.stringify({ additionalModelOptionsCache: [{ value: "new", label: "New" }] }));
    const after = f.reader.read();
    expect(after.codex.models[0]!.value).toBe("after");
    expect(after.codex.updatedAt).not.toBe(before.codex.updatedAt);
    expect(after.claude.models.at(-1)!.value).toBe("new");
    writeFileSync(f.codexPath, "broken");
    expect(f.reader.read().codex.source).toBe("default");
    writeFileSync(f.codexPath, JSON.stringify({ models: [model("repaired", 1)] }));
    expect(f.reader.read().codex.source).toBe("cli");
    unlinkSync(f.codexPath); unlinkSync(f.claudePath);
    expect(f.reader.read().codex.source).toBe("default");
    expect(f.reader.read().claude.source).toBe("default");
  });

  test("Codex caches with no usable models fall back, including internally damaged entries", () => {
    const f = fixture();
    for (const models of [[], [null], [{ visibility: "list" }], [{ slug: "broken", visibility: "list", supported_reasoning_levels: null }], [model("hidden", 1, "hide")]]) {
      writeFileSync(f.codexPath, JSON.stringify({ models }));
      expect(f.reader.read().codex.source).toBe("default");
      expect(f.reader.read().codex.models.length).toBeGreaterThan(0);
      expect(() => f.reader.requireModel("codex", "gpt-6.1-sol")).not.toThrow();
    }
    writeFileSync(f.codexPath, JSON.stringify({ models: [{ visibility: "list" }, model("good", 2)] }));
    expect(f.reader.read().codex.source).toBe("cli");
    expect(f.reader.read().codex.models.map(m => m.value)).toEqual(["good"]);
  });

  test("default user-home paths and configured/env homes resolve without real CLI files", () => {
    const f = fixture();
    mkdirSync(join(f.home, ".codex"));
    writeFileSync(join(f.home, ".codex", "models_cache.json"), JSON.stringify({ models: [model("user-home", 1)] }));
    writeFileSync(join(f.home, ".claude.json"), JSON.stringify({ additionalModelOptionsCache: [{ value: "extra", label: "Extra" }] }));
    const reader = new ModelCatalogReader({ userHome: f.home }, {});
    expect(reader.read().codex.models[0]!.value).toBe("user-home");
    expect(reader.read().claude.models.at(-1)!.value).toBe("extra");
    const env = { IAMCEO_HOME: join(f.home, "app"), IAMCEO_PORT: "0", CLAUDE_CONFIG_DIR: f.claudeHome, CODEX_HOME: f.codexHome };
    updateConfigFile({ claudeHome: "file-claude", codexHome: "file-codex" }, env);
    expect(loadConfig(env).claudeHome).toBe(f.claudeHome);
    expect(loadConfig(env).codexHome).toBe(f.codexHome);
    expect(loadConfig({ IAMCEO_HOME: env.IAMCEO_HOME }).claudeHome).toBe("file-claude");
    expect(loadConfig({ IAMCEO_HOME: env.IAMCEO_HOME }).codexHome).toBe("file-codex");
  });

  test("GET /api/models shares API authentication and observes file updates", async () => {
    const f = fixture();
    const env = { IAMCEO_HOME: join(f.home, "app"), IAMCEO_PORT: "0", CLAUDE_CONFIG_DIR: f.claudeHome, CODEX_HOME: f.codexHome };
    updateConfigFile({ accessCode: "models-test", hosts: ["127.0.0.1"] }, env);
    const config = loadConfig(env), bus = new Bus(), store = new Store(openDb(config.dbPath), bus);
    const orch: Pick<OrchestratorApi, "patchMemberConfig" | "updateSettings" | "patchMemberConfigV2" | "updateSettingsV2" | "herdrInfo"> = {
      async patchMemberConfig(id, patch) { return store.patchMember(id, patch); },
      async updateSettings(patch) { return store.patchSettings(patch); },
      async herdrInfo() { return { installed: false, running: false, version: null, protocol: null, compatible: false, warning: null }; },
      async patchMemberConfigV2(id, patch) { return { member: store.patchMember(id, patch), ...store.memberRevisions(id) }; },
      async updateSettingsV2(patch) { return { settings: store.patchSettings(patch), revision: store.settingsRevision() }; },
    };
    const server = await startServer({ config, bus, store, orch: orch as OrchestratorApi });
    try {
      const base = `http://127.0.0.1:${server.port}/api/models`;
      expect((await fetch(base)).status).toBe(401);
      expect((await fetch(base, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
      const headers = { Authorization: "Bearer models-test" };
      const response = await fetch(base, { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await response.json()).codex.source).toBe("default");
      writeFileSync(f.codexPath, JSON.stringify({ models: [model("fresh", 1)] }));
      expect((await (await fetch(base, { headers })).json()).codex.models[0].value).toBe("fresh");
      expect((await fetch(base, { method: "POST", headers })).status).toBe(405);
      const project = store.createProject({ name: "model compatibility", cwd: f.home });
      const writeHeaders = { ...headers, "Content-Type": "application/json" };
      writeFileSync(f.claudePath, JSON.stringify({ additionalModelOptionsCache: [{ value: "claude-fable-5-1[1m]", label: "Fable" }] }));
      for (const v2 of [false, true]) {
        const contractHeaders = v2 ? { ...writeHeaders, "X-IAMCEO-Contract": "2", "If-Match": '"1"' } : writeHeaders;
        for (const cli of ["claude", "codex"] as const) {
          const member = store.createMember({ projectId: project.id, name: `${cli}-${v2}`, handle: `${cli}-${v2}`, kind: "worker", cli, modelOverride: "retired-model[1m]" });
          const memberURL = `http://127.0.0.1:${server.port}/api/members/${member.id}`;
          expect((await (await fetch(memberURL, { headers })).json()).modelOverride).toBe("retired-model[1m]");
          const invalid = await fetch(memberURL, { method: "PATCH", headers: contractHeaders, body: JSON.stringify({ modelOverride: "retired-model[1m]" }) });
          expect(invalid.status).toBe(400);
          expect((await invalid.json()).error).toBe("목록에 없는 모델입니다");
          expect(store.requireMember(member.id).modelOverride).toBe("retired-model[1m]");
          for (const value of cli === "claude" ? ["opus", "fable", "claude-fable-5-1[1m]", null] : ["fresh", null]) {
            const res = await fetch(memberURL, { method: "PATCH", headers: contractHeaders, body: JSON.stringify({ modelOverride: value }) });
            expect(res.status).toBe(200);
            const body = await res.json();
            expect((v2 ? body.member : body).modelOverride).toBe(value);
          }
          // Provider-specific catalog, including a provider switch in the same PATCH.
          expect((await fetch(memberURL, { method: "PATCH", headers: contractHeaders, body: JSON.stringify({ cli: cli === "claude" ? "codex" : "claude", modelOverride: cli === "claude" ? "opus" : "fresh" }) })).status).toBe(400);
        }
        const settingsURL = `http://127.0.0.1:${server.port}/api/settings`;
        store.patchSettings({ ranks: { lead: { model: "old-claude" } }, codexRanks: { lead: { model: "old-codex" } } });
        const bootstrap = await (await fetch(`http://127.0.0.1:${server.port}/api/bootstrap`, { headers })).json();
        expect(bootstrap.settings.ranks.lead.model).toBe("old-claude");
        expect(bootstrap.settings.codexRanks.lead.model).toBe("old-codex");
        for (const [key, valid] of [["ranks", "opus"], ["codexRanks", "fresh"]] as const) {
          expect(store.getSettings()[key].lead.model).toBe(key === "ranks" ? "old-claude" : "old-codex");
          const bad = await fetch(settingsURL, { method: "PUT", headers: contractHeaders, body: JSON.stringify({ [key]: { lead: { model: "unlisted" } } }) });
          expect(bad.status).toBe(400); expect((await bad.json()).error).toBe("목록에 없는 모델입니다");
          for (const value of [valid, null]) {
            const res = await fetch(settingsURL, { method: "PUT", headers: contractHeaders, body: JSON.stringify({ [key]: { lead: { model: value } } }) });
            expect(res.status).toBe(200); const body = await res.json(); expect((v2 ? body.settings : body)[key].lead.model).toBe(value);
          }
        }
        for (const invalid of ["--flag", "two words", ""]) {
          const res = await fetch(settingsURL, { method: "PUT", headers: contractHeaders, body: JSON.stringify({ ranks: { lead: { model: invalid } } }) });
          expect(res.status).toBe(400); expect((await res.json()).error).toBe("목록에 없는 모델입니다");
        }
      }
    } finally { await server.stop(); store.db.close(); }
  });
});

// F4/F6: shared string efforts and normalization are exercised without CLI processes.
test("rank model-only normalization clears incompatible efforts, preserves compatible/explicit values, and does not mutate input", () => {
  const f = fixture();
  writeFileSync(f.codexPath, JSON.stringify({ models: [
    { ...model("future", 1), supported_reasoning_levels: [{ effort: "ultra" }] },
    { ...model("other", 2), supported_reasoning_levels: [{ effort: "tiny" }] },
    { ...model("compatible", 3), supported_reasoning_levels: [{ effort: "ultra" }] },
  ] }));
  const store = new Store(openDb(join(f.home, "test.db")), new Bus());
  try {
    const current = store.patchSettings({ codexRanks: { manager: { model: "future", effort: "ultra" }, lead: { model: "future", effort: "ultra" }, staff: { model: "future", effort: "ultra" } } });
    const input = { codexRanks: { manager: { model: "other" }, lead: { model: "compatible" }, staff: { model: "other", effort: "tiny" } } };
    const normalized = f.reader.settingsPatch(input, current);
    expect(normalized.patch.codexRanks).toEqual({ manager: { model: "other", effort: null }, lead: { model: "compatible" }, staff: { model: "other", effort: "tiny" } });
    expect(normalized.resetEfforts).toEqual(["codexRanks.manager.effort"]);
    expect(input.codexRanks.manager).toEqual({ model: "other" });
    expect(store.getSettings().codexRanks.manager.effort).toBe("ultra");
    expect(() => f.reader.settingsPatch({ codexRanks: { manager: { model: "other", effort: "ultra" } } }, current)).toThrow("지원하지 않는 effort");
    expect(() => f.reader.settingsPatch({ codexRanks: { manager: { effort: "tiny" } } }, current)).toThrow("지원하지 않는 effort");
    const saved = store.patchSettings(normalized.patch);
    expect(saved.codexRanks.manager.effort).toBeNull(); expect(saved.codexRanks.lead.effort).toBe("ultra");
    expect(saved.codexRanks.staff.effort).toBe("tiny"); expect(saved.resetEfforts).toBeUndefined();
  } finally { store.db.close(); }
});
