// Gemini(Antigravity CLI) 모델 목록: `agy models` 출력 해석, 캐시 파일, 뒤 갱신, 목록 검증(모델·effort·직급표).
// 실제 agy 를 띄우지 않는다. 띄우는 부분은 가짜를 넣거나, 임시 폴더의 가짜 실행 파일(sh 스크립트)만 쓴다.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import {
  GEMINI_MODELS_REFRESH_MS, GEMINI_MODELS_RETRY_STEPS_MS, GEMINI_MODELS_TIMEOUT_MS, GeminiModelsRefresher, geminiModelsCachePath, ModelCatalogReader, parseAgyModels, refreshGeminiModels, writeGeminiModelsCache,
  type AgyModelsRun, type ModelOption,
} from "../server/models.ts";
import { Store } from "../server/store.ts";
import { GEMINI_EFFORTS, type Member } from "../shared/types.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "iamceo-gemini-models-"));
  roots.push(root);
  return root;
}
/** 가짜 실행 파일. 내용은 sh 스크립트이고 시험이 직접 띄우거나(기본 실행), 있기만 하면 된다(가짜 실행을 넣을 때). */
function fakeBin(root: string, script = "#!/bin/sh\nexit 97\n", name = "agy"): string {
  const path = join(root, name);
  writeFileSync(path, script, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

// 설계 요약 2절의 실제 출력 줄들(agy 1.5.14).
const AGY_OUTPUT = [
  "Fetching available models...",
  "gemini-4-neon-low\tGemini 4 Neon (Low)",
  "gemini-4-neon-medium\tGemini 4 Neon (Medium)",
  "gemini-4-neon-high\tGemini 4 Neon (High)",
  "gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)",
  "gemini-pro-orchestrator-neon\tOrchestrator (Neon)",
  "claude-opus-5-5-low\tClaude Opus 5.5 (Low)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
  "",
].join("\n");
const PARSED: ModelOption[] = [
  { value: "gemini-4-neon", label: "Gemini 4 Neon", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
  { value: "gemini-pro-orchestrator-neon", label: "Orchestrator (Neon)", efforts: [] },
  { value: "claude-opus-5-5", label: "Claude Opus 5.5", efforts: ["low"] },
  { value: "gpt-oss-120b", label: "GPT-OSS 120B", efforts: ["medium"], defaultEffort: "medium" },
];

describe("parseAgyModels: `agy models` 출력 해석", () => {
  test("기본 id 로 묶고 effort 를 모은다. 첫 줄 안내는 버리고, effort 가 붙지 않은 모델은 efforts 가 비며, 순서는 agy 가 준 순서다", () => {
    expect(parseAgyModels(AGY_OUTPUT)).toEqual(PARSED);
  });

  test("effort 는 agy 가 어떤 순서로 주든 낮은 것부터 늘어놓는다. medium 이 없으면 defaultEffort 를 적지 않는다", () => {
    const text = "gemini-4-argon-high\tGemini 4 Argon (High)\ngemini-4-argon-max\tGemini 4 Argon (Max)\ngemini-4-argon-low\tGemini 4 Argon (Low)\n";
    expect(parseAgyModels(text)).toEqual([{ value: "gemini-4-argon", label: "Gemini 4 Argon", efforts: ["low", "high", "max"] }]);
    expect(parseAgyModels("gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n")).toEqual([{ value: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: ["medium"], defaultEffort: "medium" }]);
  });

  test("id 끝과 이름 끝의 effort 가 같은 값일 때만 effort 로 본다. 맞지 않으면 그 id 그대로 effort 없는 모델이다", () => {
    expect(parseAgyModels("turbo-max\tTurbo Max\n")).toEqual([{ value: "turbo-max", label: "Turbo Max", efforts: [] }]);
    expect(parseAgyModels("turbo-max\tTurbo (High)\n")).toEqual([{ value: "turbo-max", label: "Turbo (High)", efforts: [] }]);
    expect(parseAgyModels("turbo\tTurbo (High)\n")).toEqual([{ value: "turbo", label: "Turbo (High)", efforts: [] }]);
    // 이름의 effort 표기는 대소문자를 가리지 않는다.
    expect(parseAgyModels("turbo-xhigh\tTurbo (xhigh)\n")).toEqual([{ value: "turbo", label: "Turbo", efforts: ["xhigh"] }]);
  });

  test("탭이 없는 줄, 이름이 빈 줄, 명령줄 인자로 쓸 수 없는 id 는 버린다. CRLF·색 코드·겹친 줄은 견딘다", () => {
    const text = [
      "Fetching available models...",
      "warning: something happened",
      "--model\tInjected",
      "two words\tSpaced id",
      "\tNo id",
      "empty-name\t",
      // 색 코드가 낀 줄도 읽는다(이 줄만 xhigh 를 알려 준다).
      "\x1b[1mgemini-4-neon-xhigh\x1b[0m\t\x1b[2mGemini 4 Neon (XHigh)\x1b[0m\r",
      "gemini-4-neon-high\tGemini 4 Neon (High)\r",
      "gemini-4-neon-high\tGemini 4 Neon (High)\r",
      "gemini-4-neon-low\tGemini 4 Neon (Low)\r",
    ].join("\n");
    expect(parseAgyModels(text)).toEqual([{ value: "gemini-4-neon", label: "Gemini 4 Neon", efforts: ["low", "high", "xhigh"] }]);
    expect(parseAgyModels("")).toEqual([]);
    expect(parseAgyModels("Fetching available models...\n")).toEqual([]);
    expect(parseAgyModels("error: not signed in\n")).toEqual([]);
  });

  test("이름의 제어 문자는 빈칸으로 바꾸고 길이를 자른다. 모델은 200개까지만 싣는다", () => {
    expect(parseAgyModels(`odd\tOdd\x07 name\x00 here\t(tabbed)\n`)[0]).toEqual({ value: "odd", label: "Odd name here (tabbed)", efforts: [] });
    expect(parseAgyModels(`long\t${"가".repeat(500)}\n`)[0]!.label).toHaveLength(120);
    const many = Array.from({ length: 260 }, (_, i) => `model-${i}\tModel ${i}`).join("\n");
    const parsed = parseAgyModels(many);
    expect(parsed).toHaveLength(200);
    expect(parsed[0]!.value).toBe("model-0");
    expect(parsed.at(-1)!.value).toBe("model-199");
  });
});

describe("캐시 파일과 목록 읽기", () => {
  test("캐시가 없으면 기본 목록이다(늘 채운다). Config.home 을 넘기면 <home>/cache/gemini-models.json 을 본다", () => {
    const home = tempRoot();
    const reader = new ModelCatalogReader({ userHome: join(home, "user"), home }, {});
    const list = reader.read().gemini;
    expect(list.source).toBe("default");
    expect(list.updatedAt).toBeUndefined();
    expect(list.models).toEqual([
      { value: "gemini-4-neon", label: "Gemini 4 Neon", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
      { value: "gemini-4-argon", label: "Gemini 4 Argon", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
      { value: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
      { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    ]);
    // 캐시를 쓰면 같은 reader 가 그 목록을 낸다(자리는 geminiModelsCachePath 와 같다).
    expect(geminiModelsCachePath(home)).toBe(join(home, "cache", "gemini-models.json"));
    writeGeminiModelsCache(geminiModelsCachePath(home), PARSED, new Date("2026-11-21T00:00:00Z"));
    const cached = reader.read().gemini;
    expect(cached.source).toBe("cli");
    expect(cached.models).toEqual(PARSED);
    expect(cached.updatedAt).toBeDefined();
    // 다른 CLI 의 목록은 그대로다.
    expect(reader.read().claude.models.map(m => m.value)).toEqual(["opus", "sonnet", "haiku"]);
    expect(reader.read().codex.models.map(m => m.value)).toEqual(["gpt-6.1-sol", "gpt-6-luna", "gpt-6.1-terra", "gpt-6-astra"]);
  });

  test("캐시 자리를 모르면(데이터 홈을 넘기지 않음) 기본 목록만 낸다", () => {
    const home = tempRoot();
    const reader = new ModelCatalogReader({ userHome: home }, {});
    expect(reader.read().gemini.source).toBe("default");
    expect(reader.read().gemini).toBe(reader.read().gemini);
    expect(reader.listed("gemini", "gemini-4-neon")).toBe(true);
  });

  test("쓴 캐시는 0600 이고 임시 파일을 남기지 않는다. 폴더가 없으면 만든다", () => {
    const home = tempRoot();
    const path = join(home, "nested", "cache", "gemini-models.json");
    writeGeminiModelsCache(path, PARSED, new Date("2026-11-21T01:02:03Z"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(home, "nested", "cache"))).toEqual(["gemini-models.json"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ v: 1, updatedAt: "2026-11-21T01:02:03.000Z", models: PARSED });
  });

  test("깨진 캐시·모르는 모양·쓸 모델이 없는 캐시는 기본 목록이다. 고치면 다시 읽고, 바뀌지 않은 파일은 다시 풀지 않는다", () => {
    const home = tempRoot();
    const path = join(home, "gemini.json");
    const reader = new ModelCatalogReader({ userHome: home, geminiModelsCache: path }, {});
    mkdirSync(home, { recursive: true });
    let tick = 0;
    const put = (content: string) => { writeFileSync(path, content); utimesSync(path, new Date(), new Date(Date.now() + 2000 * ++tick)); };
    for (const content of ["{broken", "null", "[]", JSON.stringify({ v: 2, models: PARSED }), JSON.stringify({ v: 1, models: {} }), JSON.stringify({ v: 1, models: [] }),
      JSON.stringify({ v: 1, models: [null, { value: "--flag", label: "Bad", efforts: [] }, { value: "ok" }, { value: "ok", label: "", efforts: [] }] })]) {
      put(content);
      expect(reader.read().gemini.source).toBe("default");
      expect(reader.read().gemini.models.map(m => m.value)).toEqual(["gemini-4-neon", "gemini-4-argon", "gemini-4-hydrogen", "gemini-3.8-flash"]);
    }
    // 쓸 수 있는 줄만 남기고, effort 는 글이 아닌 값·이상한 값을 버린 뒤 낮은 것부터 놓는다. defaultEffort 는 파일이 아니라 규칙(medium)으로 정한다.
    put(JSON.stringify({ v: 1, updatedAt: "x", extra: "secret-token", models: [
      { value: "a", label: "A", efforts: ["high", 3, "--x", "low", "medium"], defaultEffort: "high", note: "secret-token" },
      { value: "a", label: "Duplicate", efforts: [] },
      { value: "b", label: "B", efforts: [] },
    ] }));
    const list = reader.read().gemini;
    expect(list.source).toBe("cli");
    expect(list.models).toEqual([{ value: "a", label: "A", efforts: ["low", "medium", "high"], defaultEffort: "medium" }, { value: "b", label: "B", efforts: [] }]);
    expect(JSON.stringify(list)).not.toContain("secret-token");
    expect(reader.read().gemini).toBe(list);
    rmSync(path);
    expect(reader.read().gemini.source).toBe("default");
  });
});

describe("모델·effort 검증", () => {
  function fixture() {
    const home = tempRoot();
    const reader = new ModelCatalogReader({ userHome: join(home, "user"), home }, {});
    writeGeminiModelsCache(geminiModelsCachePath(home), PARSED, new Date());
    return { home, reader };
  }

  test("Gemini 목록에 있는 값만 받는다. 다른 CLI 의 모델 이름은 목록에 없는 모델이다", () => {
    const { reader } = fixture();
    expect(reader.listed("gemini", "gemini-4-neon")).toBe(true);
    expect(reader.listed("gemini", "claude-opus-5-5")).toBe(true);
    // effort 가 붙은 id 는 값이 아니다(기본 id + effort 로 넘긴다).
    expect(reader.listed("gemini", "gemini-4-neon-high")).toBe(false);
    for (const other of ["opus", "fable", "gpt-6.1-sol", "sonnet"]) {
      expect(reader.listed("gemini", other)).toBe(false);
      expect(() => reader.requireModel("gemini", other)).toThrow("목록에 없는 모델입니다");
    }
    expect(() => reader.requireModel("gemini", null)).not.toThrow();
    // Gemini 의 모델이 Claude·Codex 목록에 섞이지 않는다.
    expect(reader.listed("claude", "gemini-4-neon")).toBe(false);
    expect(reader.listed("codex", "gemini-4-neon")).toBe(false);
  });

  test("effort 는 그 모델의 것만. effort 가 붙지 않는 모델과 모델을 정하지 않은 경우는 effort 지정을 거절한다", () => {
    const { reader } = fixture();
    expect(reader.efforts("gemini", "gemini-4-neon")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(reader.efforts("gemini", "gemini-pro-orchestrator-neon")).toEqual([]);
    expect(() => reader.requireEffort("gemini", "gemini-4-neon", "xhigh")).not.toThrow();
    expect(() => reader.requireEffort("gemini", "gemini-4-neon", "max")).toThrow("지원하지 않는 effort");
    expect(() => reader.requireEffort("gemini", "gemini-pro-orchestrator-neon", "high")).toThrow("지원하지 않는 effort");
    expect(() => reader.requireEffort("gemini", "gemini-pro-orchestrator-neon", null)).not.toThrow();
    // 모델을 정하지 않으면 effort 도 받지 않는다. agy 에 --effort 만 주면 agy 가 사용자 설정의 기본 모델로 따진다
    // (agy 1.5.14 실측: 기본이 gemini-4-neon 인 Mac 에서 `--effort max` 는 시작 전에 종료 코드 1). 그 기본 모델을 서버는 모른다.
    expect(reader.efforts("gemini", null)).toEqual([]);
    expect(reader.efforts("gemini", undefined)).toEqual([]);
    expect(reader.efforts("gemini")).toEqual([]);
    for (const effort of [...GEMINI_EFFORTS, "minimal"]) expect(() => reader.requireEffort("gemini", null, effort)).toThrow("지원하지 않는 effort");
    expect(() => reader.requireEffort("gemini", undefined, "medium")).toThrow("지원하지 않는 effort");
    // effort 를 정하지 않는 것은 언제나 된다.
    expect(() => reader.requireEffort("gemini", null, null)).not.toThrow();
    expect(() => reader.requireEffort("gemini", undefined, undefined)).not.toThrow();
    // 목록에 없는 모델 이름(목록이 바뀌어 사라진 옛 값)은 지금까지처럼 agy 가 받는 값 전부로 본다. 모델 자체는 requireModel 이 거절한다.
    expect(reader.efforts("gemini", "gemini-removed-model")).toEqual([...GEMINI_EFFORTS]);
    expect(() => reader.requireModel("gemini", "gemini-removed-model")).toThrow("목록에 없는 모델입니다");
    // Claude·Codex 의 규칙은 그대로다: 모델을 정하지 않았거나 effort 목록이 빈 모델은 그 CLI 의 기본 값들로 본다.
    expect(reader.efforts("claude", "opus")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(reader.efforts("claude", null)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(reader.efforts("claude")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(reader.efforts("codex", null)).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(reader.efforts("codex", "gpt-6.1-sol")).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(() => reader.requireEffort("claude", null, "max")).not.toThrow();
    expect(() => reader.requireEffort("codex", null, "minimal")).not.toThrow();
    expect(() => reader.requireEffort("codex", null, "max")).toThrow("지원하지 않는 effort");
  });

  test("설정의 직급표: geminiRanks 는 Gemini 목록으로 검증하고, 모델만 바꿔 맞지 않게 된 effort 는 비운다", () => {
    const { home, reader } = fixture();
    const store = new Store(openDb(join(home, "test.db")), new Bus());
    try {
      expect(() => reader.settingsPatch({ geminiRanks: { lead: { model: "opus" } } }, store.getSettings())).toThrow("목록에 없는 모델입니다");
      expect(() => reader.settingsPatch({ geminiRanks: { lead: { model: "gemini-4-neon", effort: "max" } } }, store.getSettings())).toThrow("지원하지 않는 effort");
      // Claude 직급표에 Gemini 모델을 넣을 수 없다(직급표마다 그 CLI 의 목록).
      expect(() => reader.settingsPatch({ ranks: { lead: { model: "gemini-4-neon" } } }, store.getSettings())).toThrow("목록에 없는 모델입니다");
      const first = reader.settingsPatch({ geminiRanks: { lead: { model: "gemini-4-neon", effort: "xhigh" }, manager: { model: "claude-opus-5-5", effort: "low" } } }, store.getSettings());
      expect(first.resetEfforts).toEqual([]);
      const current = store.patchSettings(first.patch);
      expect(current.geminiRanks.lead).toEqual({ model: "gemini-4-neon", effort: "xhigh" });
      // 모델만 바꾼다: orchestrator 는 effort 를 못 고르므로 물려받은 xhigh 를 비우고 알린다.
      const input = { geminiRanks: { lead: { model: "gemini-pro-orchestrator-neon" } } };
      const normalized = reader.settingsPatch(input, current);
      expect(normalized.patch.geminiRanks).toEqual({ lead: { model: "gemini-pro-orchestrator-neon", effort: null } });
      expect(normalized.resetEfforts).toEqual(["geminiRanks.lead.effort"]);
      expect(input.geminiRanks.lead).toEqual({ model: "gemini-pro-orchestrator-neon" });
      // 함께 준 effort 가 맞지 않으면 비우지 않고 거절한다.
      expect(() => reader.settingsPatch({ geminiRanks: { lead: { model: "gemini-pro-orchestrator-neon", effort: "low" } } }, current)).toThrow("지원하지 않는 effort");
      const saved = store.patchSettings(normalized.patch);
      expect(saved.geminiRanks.lead).toEqual({ model: "gemini-pro-orchestrator-neon", effort: null });
      expect(saved.geminiRanks.manager).toEqual({ model: "claude-opus-5-5", effort: "low" });
      // 다른 직급표는 건드리지 않았다.
      expect(saved.ranks).toEqual(store.getSettings().ranks);
      expect(saved.codexRanks.lead).toEqual({ model: null, effort: null });
    } finally { store.db.close(); }
  });

  test("설정의 직급표: 모델을 정하지 않은 Gemini 직급에는 effort 를 정할 수 없다. 모델을 비우면 남은 effort 도 비운다", () => {
    const { home, reader } = fixture();
    const store = new Store(openDb(join(home, "rank-effort.db")), new Bus());
    try {
      // 기본값(모델 없음)에 effort 만: 거절. 모델 없음을 함께 적어 보내도 같다.
      for (const rank of ["manager", "lead", "staff"] as const) {
        expect(() => reader.settingsPatch({ geminiRanks: { [rank]: { effort: "high" } } }, store.getSettings())).toThrow("지원하지 않는 effort");
        expect(() => reader.settingsPatch({ geminiRanks: { [rank]: { model: null, effort: "low" } } }, store.getSettings())).toThrow("지원하지 않는 effort");
      }
      // 지금 설정을 모르고 부른 검증(current 없음)도 같다.
      expect(() => reader.requireSettings({ geminiRanks: { lead: { effort: "medium" } } })).toThrow("지원하지 않는 effort");
      // effort 를 비우는 것과 모델만 정하는 것은 된다.
      expect(reader.settingsPatch({ geminiRanks: { lead: { effort: null }, manager: { model: "gemini-4-neon" } } }, store.getSettings()).resetEfforts).toEqual([]);
      const current = store.patchSettings({ geminiRanks: { lead: { model: "gemini-4-neon", effort: "xhigh" } } });
      // 모델만 비운다: 물려받은 effort 를 그대로 두면 '모델 없음 + effort' 가 된다. 비우고 알린다.
      const cleared = reader.settingsPatch({ geminiRanks: { lead: { model: null } } }, current);
      expect(cleared.patch.geminiRanks).toEqual({ lead: { model: null, effort: null } });
      expect(cleared.resetEfforts).toEqual(["geminiRanks.lead.effort"]);
      // 모델을 비우면서 effort 를 함께 주면 비우지 않고 거절한다.
      expect(() => reader.settingsPatch({ geminiRanks: { lead: { model: null, effort: "xhigh" } } }, current)).toThrow("지원하지 않는 effort");
      // Claude·Codex 직급표는 예전 그대로: 모델 없이 effort 만 정할 수 있고, 모델을 비워도 effort 는 남는다.
      const others = reader.settingsPatch({ ranks: { lead: { effort: "max" } }, codexRanks: { lead: { effort: "minimal" } } }, current);
      expect(others.resetEfforts).toEqual([]);
      const withOthers = store.patchSettings({ ranks: { lead: { model: "opus", effort: "max" } }, codexRanks: { lead: { model: "gpt-6.1-sol", effort: "minimal" } } });
      const emptied = reader.settingsPatch({ ranks: { lead: { model: null } }, codexRanks: { lead: { model: null } } }, withOthers);
      expect(emptied.resetEfforts).toEqual([]);
      expect(emptied.patch).toEqual({ ranks: { lead: { model: null } }, codexRanks: { lead: { model: null } } });
    } finally { store.db.close(); }
  });

  test("팀장 설정: Gemini 팀장의 effort 는 geminiRanks 의 직급 모델로 따지고, CLI 를 Gemini 로 바꾸면 맞지 않는 지정을 되돌린다", () => {
    const { home, reader } = fixture();
    const store = new Store(openDb(join(home, "member.db")), new Bus());
    try {
      const project = store.createProject({ name: "모델", cwd: home });
      // Claude 직급은 opus·max, Gemini 직급은 orchestrator(effort 없음).
      store.patchSettings({ ranks: { lead: { model: "opus", effort: "max" } }, geminiRanks: { lead: { model: "gemini-pro-orchestrator-neon" } } });
      const gemini: Member = store.createMember({ projectId: project.id, name: "자료 조사", handle: "research", kind: "worker", cli: "gemini" });
      // 직급 모델이 orchestrator 라 effort 만 지정하면 거절된다(Claude 직급표의 opus 로 따지면 통과했을 것이다).
      expect(() => reader.memberPatch(gemini, { effortOverride: "high" }, store.getSettings())).toThrow("지원하지 않는 effort");
      expect(reader.memberPatch(gemini, { modelOverride: "gemini-4-neon", effortOverride: "high" }, store.getSettings())).toEqual({ patch: { modelOverride: "gemini-4-neon", effortOverride: "high" }, resetOverrides: [] });
      expect(() => reader.memberPatch(gemini, { modelOverride: "opus" }, store.getSettings())).toThrow("목록에 없는 모델입니다");
      // Claude 팀장(opus·max 지정)을 Gemini 로 바꾼다: 모델 지정은 Gemini 목록에 없어 되돌리고, effort max 는 Gemini 직급 모델에 없어 되돌린다.
      const claude = store.createMember({ projectId: project.id, name: "화면 개발", handle: "ui", kind: "worker", cli: "claude", modelOverride: "opus" });
      store.patchMember(claude.id, { effortOverride: "max" });
      const switched = reader.memberPatch(store.requireMember(claude.id), { cli: "gemini" }, store.getSettings());
      expect(switched.patch).toEqual({ cli: "gemini", modelOverride: null, effortOverride: null });
      expect(switched.resetOverrides).toEqual(["modelOverride", "effortOverride"]);
    } finally { store.db.close(); }
  });

  test("팀장 설정: 모델을 정하지 않은 Gemini 팀장에는 effort 를 정할 수 없고, CLI 를 Gemini 로 바꾸면 모델과 함께 effort 지정도 되돌린다", () => {
    const { home, reader } = fixture();
    const store = new Store(openDb(join(home, "member-effort.db")), new Bus());
    try {
      const project = store.createProject({ name: "effort", cwd: home });
      // Gemini 직급표는 기본값(모델 없음)이다.
      const settings = () => store.getSettings();
      const gemini: Member = store.createMember({ projectId: project.id, name: "자료 조사", handle: "research", kind: "worker", cli: "gemini" });
      for (const effort of GEMINI_EFFORTS) {
        expect(() => reader.memberPatch(gemini, { effortOverride: effort }, settings())).toThrow("지원하지 않는 effort");
        expect(() => reader.memberPatch(gemini, { modelOverride: null, effortOverride: effort }, settings())).toThrow("지원하지 않는 effort");
      }
      expect(reader.memberPatch(gemini, { effortOverride: null }, settings())).toEqual({ patch: { effortOverride: null }, resetOverrides: [] });
      expect(reader.memberPatch(gemini, { modelOverride: "gemini-4-neon", effortOverride: "xhigh" }, settings())).toEqual({ patch: { modelOverride: "gemini-4-neon", effortOverride: "xhigh" }, resetOverrides: [] });
      // 모델과 effort 를 정한 팀장에서 모델만 기본값으로 돌리면(effort 는 적지 않음) 남은 effort 지정이 맞지 않게 된다: 거절하지 않고 그 지정도 되돌린다
      // (직급표의 처리와 같다). 거절하면 team_model 의 model: null 과, 직급 모델을 비운 뒤의 모든 팀장 요청이 effort 때문에 막힌다.
      const tuned = store.patchMember(gemini.id, { modelOverride: "gemini-4-neon", effortOverride: "xhigh" });
      expect(reader.memberPatch(tuned, { modelOverride: null }, settings())).toEqual({ patch: { modelOverride: null, effortOverride: null }, resetOverrides: ["effortOverride"] });
      expect(reader.memberPatch(tuned, { modelOverride: null, effortOverride: null }, settings()).patch).toEqual({ modelOverride: null, effortOverride: null });
      // 모델을 그 effort 를 받지 않는 것으로 바꿔도 같다(이 목록의 Claude Opus 5.5 는 low 만 받는다). 받는 모델이면 그대로 둔다.
      expect(reader.memberPatch(tuned, { modelOverride: "claude-opus-5-5" }, settings())).toEqual({ patch: { modelOverride: "claude-opus-5-5", effortOverride: null }, resetOverrides: ["effortOverride"] });
      const low = store.patchMember(gemini.id, { modelOverride: "gemini-4-neon", effortOverride: "low" });
      expect(reader.memberPatch(low, { modelOverride: "claude-opus-5-5" }, settings())).toEqual({ patch: { modelOverride: "claude-opus-5-5" }, resetOverrides: [] });
      // effort 를 함께 적은 요청은 되돌리지 않고 거절한다(보낸 쪽이 그 값을 원했다).
      expect(() => reader.memberPatch(tuned, { modelOverride: null, effortOverride: "xhigh" }, settings())).toThrow("지원하지 않는 effort");
      // Claude·Codex 는 같은 CLI 안에서 되돌리지 않는다(예전 그대로 거절하거나 받는다).
      const fixedClaude = store.createMember({ projectId: project.id, name: "검수", handle: "review", kind: "worker", cli: "claude", modelOverride: "opus" });
      expect(reader.memberPatch(store.patchMember(fixedClaude.id, { effortOverride: "max" }), { modelOverride: null }, settings())).toEqual({ patch: { modelOverride: null }, resetOverrides: [] });

      // Claude 팀장(opus·max 지정)을 Gemini 로: 모델 지정은 Gemini 목록에 없어 되돌리고, 모델이 없어졌으니 effort 지정도 되돌린다.
      const claude = store.createMember({ projectId: project.id, name: "화면 개발", handle: "ui", kind: "worker", cli: "claude", modelOverride: "opus" });
      for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
        const switched = reader.memberPatch(store.patchMember(claude.id, { effortOverride: effort }), { cli: "gemini" }, settings());
        expect(switched.patch).toEqual({ cli: "gemini", modelOverride: null, effortOverride: null });
        expect(switched.resetOverrides).toEqual(["modelOverride", "effortOverride"]);
      }
      // 모델 지정 없이 effort 만 정한 Claude 팀장도 같다(effort 만 되돌린다).
      const plain = store.createMember({ projectId: project.id, name: "문서 정리", handle: "docs", kind: "worker", cli: "claude" });
      const plainSwitched = reader.memberPatch(store.patchMember(plain.id, { effortOverride: "high" }), { cli: "gemini" }, settings());
      expect(plainSwitched).toEqual({ patch: { cli: "gemini", effortOverride: null }, resetOverrides: ["effortOverride"] });
      // Codex 팀장도 같다.
      const codex = store.createMember({ projectId: project.id, name: "서버 개발", handle: "api", kind: "worker", cli: "codex", modelOverride: "gpt-6.1-sol" });
      expect(reader.memberPatch(store.patchMember(codex.id, { effortOverride: "xhigh" }), { cli: "gemini" }, settings()).resetOverrides).toEqual(["modelOverride", "effortOverride"]);
      // 보낸 쪽이 effort 를 함께 적었으면 되돌리지 않고 거절한다.
      expect(() => reader.memberPatch(store.requireMember(claude.id), { cli: "gemini", modelOverride: null, effortOverride: "high" }, settings())).toThrow("지원하지 않는 effort");
      // Gemini 직급에 모델이 있으면 그 모델이 받는 effort 지정은 남는다(받지 않는 것만 되돌린다).
      store.patchSettings({ geminiRanks: { lead: { model: "gemini-4-neon" } } });
      expect(reader.memberPatch(store.patchMember(claude.id, { effortOverride: "xhigh" }), { cli: "gemini" }, settings()).resetOverrides).toEqual(["modelOverride"]);
      expect(reader.memberPatch(store.patchMember(claude.id, { effortOverride: "max" }), { cli: "gemini" }, settings()).resetOverrides).toEqual(["modelOverride", "effortOverride"]);
      // Claude ↔ Codex 전환은 예전 그대로다: 모델을 정하지 않아도 그 CLI 의 값이면 effort 지정이 남는다.
      expect(reader.memberPatch(store.patchMember(plain.id, { effortOverride: "high" }), { cli: "codex" }, settings())).toEqual({ patch: { cli: "codex" }, resetOverrides: [] });
      expect(reader.memberPatch(store.patchMember(plain.id, { effortOverride: "max" }), { cli: "codex" }, settings())).toEqual({ patch: { cli: "codex", effortOverride: null }, resetOverrides: ["effortOverride"] });
    } finally { store.db.close(); }
  });
});

describe("refreshGeminiModels: 캐시 갱신", () => {
  const ok = (stdout: string): AgyModelsRun => ({ exitCode: 0, stdout });

  test("성공하면 캐시를 새로 쓴다. 넘긴 실행 파일과 제한 시간으로 한 번만 띄운다", async () => {
    const root = tempRoot();
    const bin = fakeBin(root), cachePath = join(root, "cache", "gemini-models.json");
    const calls: { bin: string; timeoutMs: number }[] = [];
    const result = await refreshGeminiModels({ bin, cachePath, now: () => new Date("2026-11-21T03:00:00Z"), spawn: async (path, timeoutMs) => { calls.push({ bin: path, timeoutMs }); return ok(AGY_OUTPUT); } });
    expect(result).toEqual({ ok: true, count: 4 });
    expect(calls).toEqual([{ bin, timeoutMs: GEMINI_MODELS_TIMEOUT_MS }]);
    expect(GEMINI_MODELS_TIMEOUT_MS).toBe(15_000);
    expect(JSON.parse(readFileSync(cachePath, "utf8"))).toEqual({ v: 1, updatedAt: "2026-11-21T03:00:00.000Z", models: PARSED });
    expect(new ModelCatalogReader({ userHome: root, geminiModelsCache: cachePath }, {}).read().gemini.models).toEqual(PARSED);
  });

  test("실패하면 예전 캐시를 그대로 둔다: 오류 종료, 시간 초과, 빈 출력, 띄우기 실패", async () => {
    const root = tempRoot();
    const bin = fakeBin(root), cachePath = join(root, "gemini-models.json");
    writeGeminiModelsCache(cachePath, PARSED, new Date("2026-11-20T00:00:00Z"));
    const before = readFileSync(cachePath, "utf8"), beforeStat = statSync(cachePath);
    const cases: [string, () => Promise<AgyModelsRun>][] = [
      ["failed", async () => ({ exitCode: 1, stdout: "error: invalid model selection (x)\n" })],
      ["failed", async () => ({ exitCode: 1, stdout: AGY_OUTPUT })],
      ["timeout", async () => ({ exitCode: null, stdout: "" })],
      ["empty", async () => ok("Fetching available models...\n")],
      ["empty", async () => ok("")],
      ["failed", async () => { throw new Error("spawn failed"); }],
    ];
    for (const [reason, spawn] of cases) {
      expect(await refreshGeminiModels({ bin, cachePath, spawn })).toEqual({ ok: false, reason: reason as "failed" });
      expect(readFileSync(cachePath, "utf8")).toBe(before);
      expect(statSync(cachePath).mtimeMs).toBe(beforeStat.mtimeMs);
    }
    expect(readdirSync(root).sort()).toEqual(["agy", "gemini-models.json"]);
    expect(new ModelCatalogReader({ userHome: root, geminiModelsCache: cachePath }, {}).read().gemini.models).toEqual(PARSED);
  });

  test("캐시를 쓰지 못해도 던지지 않고 예전 파일을 남긴다", async () => {
    const root = tempRoot();
    const bin = fakeBin(root);
    // 캐시 자리의 부모가 폴더가 아니라 파일이다: 쓰기가 실패한다.
    writeFileSync(join(root, "blocked"), "not a directory");
    const result = await refreshGeminiModels({ bin, cachePath: join(root, "blocked", "gemini-models.json"), spawn: async () => ok(AGY_OUTPUT) });
    expect(result).toEqual({ ok: false, reason: "write_failed" });
    expect(readFileSync(join(root, "blocked"), "utf8")).toBe("not a directory");
  });

  test("실행 파일이 없으면 띄우지 않는다(설정이 없거나, 적은 경로에 파일이 없거나, 실행할 수 없는 파일)", async () => {
    const root = tempRoot();
    let spawned = 0;
    const spawn = async () => { spawned++; return ok(AGY_OUTPUT); };
    const cachePath = join(root, "gemini-models.json");
    writeFileSync(join(root, "not-executable"), "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    for (const bin of [undefined, "", join(root, "missing", "agy"), join(root, "not-executable")]) {
      expect(await refreshGeminiModels({ bin, cachePath, spawn })).toEqual({ ok: false, reason: "not_installed" });
    }
    expect(spawned).toBe(0);
    expect(existsSync(cachePath)).toBe(false);
  });

  test("기본 실행: 가짜 실행 파일을 `<bin> models` 로 띄워 출력을 읽는다. 0 아닌 종료와 제한 시간 초과는 실패다", async () => {
    const root = tempRoot();
    const cachePath = join(root, "gemini-models.json");
    // 인자가 models 일 때만 목록을 낸다(다른 인자로 불렀으면 실패한다).
    const good = fakeBin(root, `#!/bin/sh\n[ "$1" = "models" ] && [ "$#" = 1 ] || exit 64\nprintf 'Fetching available models...\\n'\nprintf 'gemini-4-neon-high\\tGemini 4 Neon (High)\\n'\nprintf 'gemini-4-neon-low\\tGemini 4 Neon (Low)\\n'\n`, "agy-good");
    expect(await refreshGeminiModels({ bin: good, cachePath })).toEqual({ ok: true, count: 1 });
    const written = readFileSync(cachePath, "utf8");
    expect(JSON.parse(written).models).toEqual([{ value: "gemini-4-neon", label: "Gemini 4 Neon", efforts: ["low", "high"] }]);
    const failing = fakeBin(root, "#!/bin/sh\nprintf 'gemini-4-argon-low\\tGemini 4 Argon (Low)\\n'\nexit 1\n", "agy-failing");
    expect(await refreshGeminiModels({ bin: failing, cachePath })).toEqual({ ok: false, reason: "failed" });
    const slow = fakeBin(root, "#!/bin/sh\nexec sleep 5\n", "agy-slow");
    const started = Date.now();
    expect(await refreshGeminiModels({ bin: slow, cachePath, timeoutMs: 150 })).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(readFileSync(cachePath, "utf8")).toBe(written);
  });
});

describe("GeminiModelsRefresher: 뒤 갱신 일정", () => {
  test("start 는 곧바로 한 번 갱신하고, 6시간 타이머는 프로세스를 붙잡지 않는다. 겹쳐 불러도 한 번만 띄운다", async () => {
    const root = tempRoot();
    const bin = fakeBin(root), cachePath = join(root, "cache", "gemini-models.json");
    let spawned = 0;
    let release!: (run: AgyModelsRun) => void;
    const refresher = new GeminiModelsRefresher({ bin, cachePath, spawn: () => { spawned++; return new Promise<AgyModelsRun>(resolve => { release = resolve; }); } });
    try {
      expect(GEMINI_MODELS_REFRESH_MS).toBe(6 * 60 * 60_000);
      refresher.start();
      refresher.start();
      const again = refresher.refresh();
      // 도는 중에는 ensure 도 새로 띄우지 않는다.
      refresher.ensure();
      await Bun.sleep(20);
      expect(spawned).toBe(1);
      release({ exitCode: 0, stdout: AGY_OUTPUT });
      expect(await again).toEqual({ ok: true, count: 4 });
      expect(existsSync(cachePath)).toBe(true);
    } finally { refresher.stop(); }
    // 멈춘 뒤에는 띄우지 않는다.
    expect(await refresher.refresh()).toEqual({ ok: false, reason: "failed" });
    refresher.start();
    refresher.ensure();
    await Bun.sleep(20);
    expect(spawned).toBe(1);
  });

  test("ensure 는 캐시가 없을 때만, 그리고 재시도 간격이 지났을 때만 다시 건다. 실패해도 던지지 않는다", async () => {
    const root = tempRoot();
    const bin = fakeBin(root), cachePath = join(root, "gemini-models.json");
    let clock = 1_000_000, spawned = 0, output = "";
    const refresher = new GeminiModelsRefresher({ bin, cachePath, retryStepsMs: [600_000, 600_000], now: () => clock, spawn: async () => { spawned++; return { exitCode: 0, stdout: output }; } });
    const settle = () => Bun.sleep(20);
    try {
      refresher.ensure();
      await settle();
      expect(spawned).toBe(1);
      expect(existsSync(cachePath)).toBe(false);
      // 간격 안에서는 다시 띄우지 않는다(틱마다 불려도).
      for (let i = 0; i < 5; i++) refresher.ensure();
      clock += 599_999;
      refresher.ensure();
      await settle();
      expect(spawned).toBe(1);
      // 간격이 지나면 다시 건다. 이번에는 목록이 나와 캐시가 생긴다.
      clock += 1;
      output = AGY_OUTPUT;
      refresher.ensure();
      await settle();
      expect(spawned).toBe(2);
      expect(existsSync(cachePath)).toBe(true);
      // 캐시가 있으면 간격이 지나도 ensure 는 띄우지 않는다(주기 갱신은 타이머가 한다).
      clock += 10 * 600_000;
      refresher.ensure();
      await settle();
      expect(spawned).toBe(2);
      // 실패하는 갱신도 결과로 돌려준다.
      output = "";
      expect(await refresher.refresh()).toEqual({ ok: false, reason: "empty" });
      expect(JSON.parse(readFileSync(cachePath, "utf8")).models).toEqual(PARSED);
    } finally { refresher.stop(); }
  });

  test("캐시를 못 얻는 동안은 다시 해 보는 간격을 벌린다(10분·30분·1시간·2시간, 그 뒤 6시간). 성공하면 처음 간격으로 돌아간다", async () => {
    expect(GEMINI_MODELS_RETRY_STEPS_MS).toEqual([600_000, 1_800_000, 3_600_000, 7_200_000]);
    const root = tempRoot();
    const bin = fakeBin(root), cachePath = join(root, "gemini-models.json");
    let clock = 5_000_000, spawned = 0, output = "error: sign in required\n";
    const refresher = new GeminiModelsRefresher({ bin, cachePath, now: () => clock, spawn: async () => { spawned++; return { exitCode: output.includes("error") ? 1 : 0, stdout: output }; } });
    const settle = () => Bun.sleep(20);
    /** 그 시간만큼 지난 뒤 ensure 가 새로 띄웠는가. */
    const firesAfter = async (ms: number) => { const before = spawned; clock += ms; refresher.ensure(); await settle(); return spawned > before; };
    try {
      refresher.ensure();
      await settle();
      expect(spawned).toBe(1);
      // 한 번 실패: 다음은 30분 뒤(둘째 칸).
      expect(await firesAfter(1_800_000 - 1)).toBe(false);
      expect(await firesAfter(1)).toBe(true);
      // 두 번 실패: 1시간 뒤.
      expect(await firesAfter(3_600_000 - 1)).toBe(false);
      expect(await firesAfter(1)).toBe(true);
      // 세 번 실패: 2시간 뒤.
      expect(await firesAfter(7_200_000 - 1)).toBe(false);
      expect(await firesAfter(1)).toBe(true);
      // 네 번 넘게 실패: 6시간(갱신 간격)에 한 번.
      expect(await firesAfter(GEMINI_MODELS_REFRESH_MS - 1)).toBe(false);
      expect(await firesAfter(1)).toBe(true);
      expect(await firesAfter(GEMINI_MODELS_REFRESH_MS - 1)).toBe(false);
      expect(spawned).toBe(5);
      // 성공하면 처음 간격으로 돌아간다: 캐시가 다시 없어지면 10분 뒤에 본다.
      output = AGY_OUTPUT;
      expect(await refresher.refresh()).toEqual({ ok: true, count: 4 });
      rmSync(cachePath);
      expect(await firesAfter(600_000 - 1)).toBe(false);
      expect(await firesAfter(1)).toBe(true);
      expect(existsSync(cachePath)).toBe(true);
    } finally { refresher.stop(); }
  });

  test("쓰는 근거(wanted)가 없으면 start·ensure 가 agy 를 띄우지 않는다. 근거가 생기면 다음 ensure 가 건너뛴 갱신을 한 번 한다", async () => {
    const root = tempRoot();
    const bin = fakeBin(root), cachePath = join(root, "gemini-models.json");
    let wanted = false, asked = 0, clock = 1_000_000, spawned = 0;
    const refresher = new GeminiModelsRefresher({ bin, cachePath, retryStepsMs: [600_000], now: () => clock, wanted: () => { asked++; return wanted; }, spawn: async () => { spawned++; return { exitCode: 0, stdout: AGY_OUTPUT }; } });
    const settle = () => Bun.sleep(20);
    try {
      // agy 를 깔아만 두고 쓰지 않는 Mac: 서버가 떠도(start), 틱이 돌아도(ensure), 시간이 지나도 띄우지 않는다.
      refresher.start();
      for (let i = 0; i < 5; i++) { refresher.ensure(); clock += 700_000; }
      await settle();
      expect(spawned).toBe(0);
      expect(asked).toBeGreaterThan(0);
      expect(existsSync(cachePath)).toBe(false);
      // Gemini 팀장을 만들었다: 다음 ensure(틱)가 건너뛴 첫 갱신을 한다.
      wanted = true;
      refresher.ensure();
      await settle();
      expect(spawned).toBe(1);
      expect(existsSync(cachePath)).toBe(true);
      // 한 번뿐이다: 그 뒤의 ensure 는 캐시가 있어 띄우지 않는다(주기 갱신은 타이머가 한다).
      for (let i = 0; i < 3; i++) { clock += 700_000; refresher.ensure(); }
      await settle();
      expect(spawned).toBe(1);
      // 근거가 다시 없어지면 캐시가 없어져도 띄우지 않고, 돌아오면 그다음 ensure 가 띄운다(다시 볼 때를 밀어 두지 않았다).
      wanted = false;
      rmSync(cachePath);
      for (let i = 0; i < 3; i++) { clock += 700_000; refresher.ensure(); }
      await settle();
      expect(spawned).toBe(1);
      wanted = true;
      refresher.ensure();
      await settle();
      expect(spawned).toBe(2);
      // 직접 부른 refresh 는 이 조건을 보지 않는다.
      wanted = false;
      expect(await refresher.refresh()).toEqual({ ok: true, count: 4 });
      expect(spawned).toBe(3);
    } finally { refresher.stop(); }
  });

  test("쓰는 근거가 없는 동안 건너뛴 갱신은 캐시가 있어도(오래된 목록) 근거가 생기면 한다. 근거를 읽지 못하면 없는 것으로 본다", async () => {
    const root = tempRoot();
    const bin = fakeBin(root), cachePath = join(root, "gemini-models.json");
    writeGeminiModelsCache(cachePath, [{ value: "gemini-old", label: "Old", efforts: [] }], new Date("2026-01-01T00:00:00Z"));
    let wanted: boolean | "throw" = false, spawned = 0;
    const refresher = new GeminiModelsRefresher({ bin, cachePath, wanted: () => { if (wanted === "throw") throw new Error("database is closed"); return wanted; }, spawn: async () => { spawned++; return { exitCode: 0, stdout: AGY_OUTPUT }; } });
    const settle = () => Bun.sleep(20);
    try {
      refresher.start();
      refresher.ensure();
      await settle();
      expect(spawned).toBe(0);
      expect(JSON.parse(readFileSync(cachePath, "utf8")).models[0].value).toBe("gemini-old");
      // 저장소가 닫히는 중처럼 근거를 읽지 못하면 띄우지 않는다(던지지도 않는다).
      wanted = "throw";
      expect(() => refresher.ensure()).not.toThrow();
      await settle();
      expect(spawned).toBe(0);
      wanted = true;
      refresher.ensure();
      await settle();
      expect(spawned).toBe(1);
      expect(JSON.parse(readFileSync(cachePath, "utf8")).models).toEqual(PARSED);
    } finally { refresher.stop(); }
  });

  test("주기 갱신도 쓰는 근거가 있을 때만 돈다. 근거 없이 지나간 주기는 띄우지 않는다", async () => {
    const root = tempRoot();
    const bin = fakeBin(root), cachePath = join(root, "gemini-models.json");
    let wanted = false, spawned = 0;
    const refresher = new GeminiModelsRefresher({ bin, cachePath, intervalMs: 25, wanted: () => wanted, spawn: async () => { spawned++; return { exitCode: 0, stdout: AGY_OUTPUT }; } });
    try {
      refresher.start();
      await Bun.sleep(150);
      expect(spawned).toBe(0);
      wanted = true;
      const end = Date.now() + 3000;
      while (spawned === 0 && Date.now() < end) await Bun.sleep(10);
      expect(spawned).toBeGreaterThan(0);
      expect(existsSync(cachePath)).toBe(true);
    } finally { refresher.stop(); }
    const after = spawned;
    await Bun.sleep(80);
    expect(spawned).toBe(after);
  });

  test("agy 가 없으면 start·ensure 가 아무것도 띄우지 않는다", async () => {
    const root = tempRoot();
    let spawned = 0;
    const refresher = new GeminiModelsRefresher({ bin: join(root, "no-agy"), cachePath: join(root, "gemini-models.json"), retryStepsMs: [0], spawn: async () => { spawned++; return { exitCode: 0, stdout: AGY_OUTPUT }; } });
    try {
      refresher.start();
      refresher.ensure();
      expect(await refresher.refresh()).toEqual({ ok: false, reason: "not_installed" });
      await Bun.sleep(20);
      refresher.ensure();
      await Bun.sleep(20);
      expect(spawned).toBe(0);
      expect(existsSync(join(root, "gemini-models.json"))).toBe(false);
    } finally { refresher.stop(); }
  });
});
