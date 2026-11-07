import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliProvider, Member, PatchMemberReq, Settings, SettingsPatch } from "../shared/types.ts";
import { ApiError } from "./store.ts";
import { CODEX_EFFORTS, EFFORTS, memberRank } from "../shared/types.ts";

export interface ModelOption {
  value: string;
  label: string;
  description?: string;
  efforts: string[];
  defaultEffort?: string;
}
export interface ModelList {
  models: ModelOption[];
  source: "cli" | "default";
  updatedAt?: string;
}
export interface ModelCatalog { claude: ModelList; codex: ModelList }

const validName = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,127}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const description = (value: unknown): { description?: string } => typeof value === "string" ? { description: value } : {};
const defaults = (cli: "claude" | "codex"): ModelList => ({
  source: "default",
  models: cli === "claude"
    ? ["opus", "sonnet", "haiku"].map(value => ({ value, label: value[0]!.toUpperCase() + value.slice(1), efforts: [...EFFORTS] }))
    : ["gpt-6.1-sol", "gpt-6-luna", "gpt-6.1-terra", "gpt-6-astra"].map(value => ({ value, label: value, efforts: [...CODEX_EFFORTS] })),
});

function claudeModels(data: unknown): ModelOption[] {
  // Account settings are never retained in the cache or copied into the response.
  const options = record(data) ? data.additionalModelOptionsCache : undefined;
  if (!Array.isArray(options)) throw new Error("Missing model options");
  const models = defaults("claude").models;
  for (const option of options) {
    if (!record(option) || !validName(option.value) || typeof option.label !== "string") continue;
    if (models.some(model => model.value === option.value)) continue;
    models.push({ value: option.value, label: option.label, ...description(option.description), efforts: [...EFFORTS] });
  }
  return models;
}

function codexModels(data: unknown): ModelOption[] {
  if (!record(data) || !Array.isArray(data.models)) throw new Error("Missing models");
  const models: ModelOption[] = [];
  const visible = data.models.filter(record).filter(model => model.visibility === "list")
    .sort((a, b) => (typeof a.priority === "number" ? a.priority : Infinity) - (typeof b.priority === "number" ? b.priority : Infinity));
  for (const model of visible) {
    if (!validName(model.slug) || !Array.isArray(model.supported_reasoning_levels)) continue;
    const efforts = [...new Set(model.supported_reasoning_levels.filter(record).map(level => level.effort).filter((effort): effort is string => typeof effort === "string" && effort.length > 0))];
    if (models.some(option => option.value === model.slug)) continue;
    models.push({ value: model.slug, label: typeof model.display_name === "string" ? model.display_name : model.slug,
      ...description(model.description), efforts,
      ...(typeof model.default_reasoning_level === "string" && efforts.includes(model.default_reasoning_level) ? { defaultEffort: model.default_reasoning_level } : {}),
    });
  }
  if (!models.length) throw new Error("No usable models");
  return models;
}

/** One cache per server. Stat on each request; parse only when the file changes. */
export class ModelCatalogReader {
  private readonly paths: Record<"claude" | "codex", string>;
  private readonly cache = new Map<string, { stamp: string; list: ModelList }>();

  constructor(homes: { claudeHome?: string; codexHome?: string; userHome?: string } = {}, env: NodeJS.ProcessEnv = process.env) {
    const home = homes.userHome ?? (env.IAMCEO_TEST === "1" ? env.IAMCEO_HOME ?? "/private/tmp/iamceo-model-test-empty" : homedir());
    const claudeHome = homes.claudeHome ?? env.CLAUDE_CONFIG_DIR;
    this.paths = {
      claude: claudeHome ? join(claudeHome, ".claude.json") : join(home, ".claude.json"),
      codex: join(homes.codexHome ?? env.CODEX_HOME ?? join(home, ".codex"), "models_cache.json"),
    };
  }

  read(): ModelCatalog { return { claude: this.readList("claude"), codex: this.readList("codex") }; }

  requireModel(cli: CliProvider, value: string | null | undefined): void {
    if (value == null) return;
    const list = this.read()[cli].models;
    if (list.some(model => model.value === value) ||
        (cli === "claude" && value === "fable" && list.some(model => model.label.toLowerCase() === "fable"))) return;
    throw new ApiError(400, "목록에 없는 모델입니다");
  }

  efforts(cli: CliProvider, value?: string | null): readonly string[] {
    const list = this.read()[cli].models;
    const model = list.find(model => model.value === value) ??
      (cli === "claude" && value === "fable" ? list.find(model => model.label.toLowerCase() === "fable") : undefined);
    return model?.efforts.length ? model.efforts : cli === "codex" ? CODEX_EFFORTS : EFFORTS;
  }

  requireEffort(cli: CliProvider, model: string | null | undefined, effort: string | null | undefined): void {
    if (effort != null && !this.efforts(cli, model).includes(effort)) throw new ApiError(400, `${cli}에서 지원하지 않는 effort입니다`);
  }

  memberPatch(member: Member, input: PatchMemberReq, settings: Settings): { patch: PatchMemberReq; resetOverrides: NonNullable<Member["resetOverrides"]> } {
    const patch = { ...input }, cli = patch.cli ?? member.cli;
    const resetOverrides: NonNullable<Member["resetOverrides"]> = [];
    const switching = cli !== member.cli;
    if (switching && patch.modelOverride === undefined && member.modelOverride != null) {
      try { this.requireModel(cli, member.modelOverride); }
      catch { patch.modelOverride = null; resetOverrides.push("modelOverride"); }
    }
    this.requireModel(cli, patch.modelOverride);
    const rank = (cli === "codex" ? settings.codexRanks : settings.ranks)[memberRank(member.kind)];
    const model = (patch.modelOverride === undefined ? member.modelOverride : patch.modelOverride) ?? rank.model;
    if (switching && patch.effortOverride === undefined && member.effortOverride != null && !this.efforts(cli, model).includes(member.effortOverride)) {
      patch.effortOverride = null; resetOverrides.push("effortOverride");
    }
    this.requireEffort(cli, model, patch.effortOverride === undefined ? member.effortOverride : patch.effortOverride);
    return { patch, resetOverrides };
  }

  requireSettings(patch: SettingsPatch, current?: Settings): void {
    for (const [cli, ranks] of [["claude", patch.ranks], ["codex", patch.codexRanks]] as const) {
      for (const [key, rank] of Object.entries(ranks ?? {})) {
        this.requireModel(cli, rank?.model);
        const model = rank?.model === undefined ? current?.[cli === "codex" ? "codexRanks" : "ranks"][key as keyof Settings["ranks"]].model : rank.model;
        this.requireEffort(cli, model, rank?.effort);
      }
    }
  }

  private readList(cli: "claude" | "codex"): ModelList {
    const path = this.paths[cli];
    let stamp = "missing", updatedAt: string | undefined;
    try {
      const stat = statSync(path);
      stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
      updatedAt = stat.mtime.toISOString();
    } catch { /* Missing/unreadable files use defaults, including after deletion. */ }
    const cached = this.cache.get(path);
    if (cached?.stamp === stamp) return cached.list;
    let list = defaults(cli);
    if (updatedAt) {
      try {
        const data: unknown = JSON.parse(readFileSync(path, "utf8"));
        list = { models: cli === "claude" ? claudeModels(data) : codexModels(data), source: "cli", updatedAt };
      } catch { /* Invalid JSON or schema: keep defaults; never expose file contents. */ }
    }
    this.cache.set(path, { stamp, list });
    return list;
  }
}
