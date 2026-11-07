import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliProvider, SettingsPatch } from "../shared/types.ts";
import { ApiError } from "./store.ts";
import { CODEX_EFFORTS, EFFORTS } from "../shared/types.ts";

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

  requireSettings(patch: SettingsPatch): void {
    for (const [cli, ranks] of [["claude", patch.ranks], ["codex", patch.codexRanks]] as const) {
      for (const rank of Object.values(ranks ?? {})) this.requireModel(cli, rank?.model);
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
