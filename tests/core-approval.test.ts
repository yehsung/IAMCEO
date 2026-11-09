import { expect, test } from "bun:test";
import { claudeFolderTrust, codexFolderTrust } from "../server/runner/core-approval.ts";
import { folderTrustPathCases } from "./fixtures/folder-trust-paths.ts";
import { wrappedTrustScreens } from "./fixtures/folder-trust-160.ts";

function screen(cli: "claude" | "codex", rows: readonly string[]): string {
  return cli === "claude"
    ? ` Accessing workspace:\n${rows.join("\n")}\n Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel\n`
    : `  Folder access\n${rows.join("\n")}\n  Trust this folder? Codex can read, edit, and run files here. Your trust decision will be saved.\n› 1. Trust and continue\n  2. Quit\n  enter continue · esc quit\n`;
}

for (const cli of ["claude", "codex"] as const) {
  const parse = cli === "claude" ? claudeFolderTrust : codexFolderTrust;
  for (const item of folderTrustPathCases) test(`${cli}: ${item.name}`, () => {
    const rows = [...item.rows];
    if (cli === "codex" && rows[0]!.startsWith(" ")) rows[0] = " " + rows[0];
    const raw = screen(cli, rows);
    const result = parse(raw, item.cwd);
    if (!item.accepted) { expect(result).toBeNull(); return; }
    expect(result).toMatchObject({ selected: 0, prompt: { title: "폴더 신뢰 확인", body: expect.stringContaining(item.cwd + "\n") } });
    for (const other of [item.cwd + "/other", item.cwd.slice(0, -1), item.cwd.replace("/tmp/", "/elsewhere/")]) {
      expect(parse(raw, other)).toBeNull();
    }
    expect(parse(raw.replace("\n", "\r\n"), item.cwd)).not.toBeNull();
    expect(parse("\x1b[0m" + raw, item.cwd)).toBeNull();
    expect(parse(raw.replace(cli === "claude" ? "❯" : "›", " "), item.cwd)).toBeNull();
    expect(parse(raw.replace(cli === "claude" ? "Yes, I trust this folder" : "2. Quit", "Unknown option"), item.cwd)).toBeNull();
  });

  for (const snapshot of wrappedTrustScreens) test(`${cli}: existing ${snapshot.pathRows}-row 160-column snapshot`, () => {
    for (const padded of [false, true]) {
      const raw = padded ? snapshot[cli].split("\n").map(row => row.padEnd(160)).join("\n") : snapshot[cli];
      expect(parse(raw, snapshot.cwd)).toBeNull();
      expect(parse(raw, snapshot.cwd + "/other")).toBeNull();
      expect(parse(raw, snapshot.cwd.slice(0, -1))).toBeNull();
      expect(parse(raw, snapshot.cwd.replace("long project", "longproject"))).toBeNull();
    }
  });
}
