// D9: 확인된 CLI 버전마다 실제 화면·기록 견본을 두고, 지금 해석기를 견본마다 돌린다.
// 새 CLI 버전을 확인하면 tests/fixtures/cli/<provider>/<version>/ 에 화면·기록과 manifest.json 을 넣고 VERIFIED_CLI_VERSIONS 에 더한다.
// 해석기를 고쳐 옛 버전 견본이 깨지면 그것이 곧 그 버전과의 약속 위반이다.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseCliVersion, VERIFIED_CLI_VERSIONS } from "../server/cli-version.ts";
import { inputLooksEmpty } from "../server/runner/claude-screen.ts";
import { claudeFolderTrust, codexFolderTrust, looksLikeFolderTrust } from "../server/runner/core-approval.ts";
import { codexDraft, trustDialogLike } from "../server/runner/core.ts";
import { parseCodexSessionMeta, readDeliveryEvidence } from "../server/runner/delivery-evidence.ts";

type Provider = "claude" | "codex";
interface ScreenExpect { inputEmpty?: boolean | null; draft?: string | null; folderTrustLike?: boolean; trustDialogLike?: boolean; folderTrust?: { selected: number; options: string[] } | null }
interface LogExpect { received: string[]; verdict?: string; code?: string; complete?: boolean; sessionMeta?: boolean }
interface Fixture {
  /** observed: 실제 CLI 화면·기록을 옮김. synthetic: 실측 구조로 만든 화면(그것만으로는 버전을 확인했다고 하지 않는다). */
  file: string; kind: "screen" | "log"; origin: "observed" | "synthetic"; cwd: string; bannerVersion?: boolean; note?: string;
  sessionId?: string; markers?: Record<string, string>; expect: ScreenExpect | LogExpect;
}
interface Manifest { provider: Provider; version: string; source: string; fixtures: Fixture[] }

const ROOT = join(import.meta.dir, "fixtures", "cli");
const scratch = mkdtempSync(join(tmpdir(), "iamceo-cli-fixtures-"));
afterAll(() => { /* 임시 폴더는 게이트가 지운다 */ });

function folders(provider: Provider): string[] {
  const dir = join(ROOT, provider);
  return existsSync(dir) ? readdirSync(dir).filter(name => statSync(join(dir, name)).isDirectory()).sort() : [];
}
function manifest(provider: Provider, version: string): Manifest {
  return JSON.parse(readFileSync(join(ROOT, provider, version, "manifest.json"), "utf8")) as Manifest;
}
const all = (["claude", "codex"] as const).flatMap(provider => folders(provider).map(version => ({ provider, version })));

describe("확인된 버전 목록과 견본 폴더", () => {
  test("VERIFIED_CLI_VERSIONS 와 견본 폴더가 정확히 같다(견본 없는 버전을 확인됐다고 하지 않는다)", () => {
    for (const provider of ["claude", "codex"] as const) expect(folders(provider)).toEqual([...VERIFIED_CLI_VERSIONS[provider]].sort());
  });
  test.each(all)("$provider $version: manifest 가 폴더와 맞고 견본 파일이 모두 있다", ({ provider, version }) => {
    const m = manifest(provider, version);
    expect(m.provider).toBe(provider);
    expect(m.version).toBe(version);
    expect(m.source.length).toBeGreaterThan(0);
    expect(m.fixtures.length).toBeGreaterThan(0);
    // 실측 견본이 적어도 하나 있어야 그 버전을 확인했다고 할 수 있다.
    expect(m.fixtures.some(f => f.origin === "observed")).toBe(true);
    const files = readdirSync(join(ROOT, provider, version)).filter(name => name !== "manifest.json").sort();
    expect(m.fixtures.map(f => f.file).sort()).toEqual(files);
  });
});

function screenResults(provider: Provider, screen: string, cwd: string) {
  const trust = provider === "claude" ? claudeFolderTrust(screen, cwd) : codexFolderTrust(screen, cwd);
  return {
    ...(provider === "claude" ? { inputEmpty: inputLooksEmpty(screen) } : { draft: codexDraft(screen) }),
    folderTrustLike: looksLikeFolderTrust(screen),
    trustDialogLike: trustDialogLike(screen, provider),
    folderTrust: trust ? { selected: trust.selected, options: trust.prompt.options.map(option => option.label) } : null,
  };
}

function logResults(provider: Provider, fixture: Fixture, text: string) {
  const home = mkdtempSync(join(scratch, `${provider}-`));
  const path = provider === "claude" ? join(home, "projects", "encoded-cwd", `${fixture.sessionId}.jsonl`) : join(home, "sessions", "2026", "11", "07", `rollout-time-${fixture.sessionId}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  const result = readDeliveryEvidence({ cli: provider, home, path, cwd: fixture.cwd, sessionId: fixture.sessionId!, sessionGeneration: 1,
    markers: Object.entries(fixture.markers ?? {}).map(([deliveryId, marker]) => ({ deliveryId, marker })) });
  const first = JSON.parse(text.split("\n")[0]!) as unknown;
  return { received: result.receivedDeliveryIds, verdict: result.evidence.verdict, code: result.evidence.code, complete: result.evidence.complete,
    sessionMeta: provider === "codex" ? parseCodexSessionMeta(first) !== null : undefined };
}

describe.each(all)("$provider $version 견본을 지금 해석기로 읽는다", ({ provider, version }) => {
  const m = manifest(provider, version);
  test.each(m.fixtures.map(f => [f.file, f] as const))("%s", (_name, fixture) => {
    const text = readFileSync(join(ROOT, provider, version, fixture.file), "utf8");
    // 견본 안에 CLI 가 스스로 적은 버전이 있으면 폴더 이름과 같아야 한다(다른 버전의 화면을 잘못 넣지 않게).
    if (fixture.bannerVersion) expect(parseCliVersion(text)).toBe(version);
    const actual: Record<string, unknown> = fixture.kind === "screen" ? screenResults(provider, text, fixture.cwd) : logResults(provider, fixture, text);
    const expected = fixture.expect as Record<string, unknown>;
    expect(Object.keys(expected).length).toBeGreaterThan(0);
    for (const key of Object.keys(expected)) expect([key, actual[key]]).toEqual([key, expected[key]]);
  });
});
