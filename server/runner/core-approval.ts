import { createHash } from "node:crypto";
import type { ApprovalPrompt } from "../../shared/types.ts";

/** Claude Code 2.1.319's observed plain-text setup menu only. No inferred Codex menus. */
export function claudeFolderTrust(screen: string, cwd: string): { prompt: ApprovalPrompt; selected: number } | null {
  if (screen.includes("\x1b")) return null;
  const rawLines = screen.split(/\r?\n/);
  const lines = rawLines.map((line) => line.trim());
  const heading = lines.indexOf("Accessing workspace:");
  if (heading < 0) return null;
  const question = lines.findIndex((line, i) => i > heading + 1 && line.startsWith("Quick safety check: Is this a project you created or one you trust?"));
  if (question < 0 || !matchesWorkspacePath(rawLines, heading, question, cwd, 1)) return null;
  const options = lines.flatMap((line, i) => {
    if (i <= question) return [];
    const match = /^(❯\s*)?(No, exit|Yes, I trust this folder)$/.exec(line);
    return match ? [{ index: i, label: match[2]!, selected: !!match[1] }] : [];
  });
  if (options.length !== 2 || options[0]!.label !== "No, exit" || options[1]!.label !== "Yes, I trust this folder" ||
      options.filter((option) => option.selected).length !== 1 || options[1]!.index !== options[0]!.index + 1) return null;
  if (lines.slice(options[1]!.index + 1).filter(Boolean).join("\n") !== "Enter to confirm · Esc to cancel") return null;
  return {
    selected: options.findIndex((option) => option.selected),
    prompt: {
      title: "폴더 신뢰 확인",
      body: `${cwd}\n이 폴더에서 AI가 파일을 읽고 고치고 실행할 수 있게 됩니다`,
      question: "Is this a project you created or one you trust?",
      options: options.map((option, i) => ({ n: i + 1, label: option.label, reject: i === 0 })),
      fingerprint: createHash("sha256").update(screen).digest("hex").slice(0, 24),
    },
  };
}

/** Observed Codex 0.166 folder menu; only an explicit owner answer sends keys. */
export function codexFolderTrust(screen: string, cwd: string): { prompt: ApprovalPrompt; selected: number } | null {
  if (screen.includes("\x1b")) return null;
  const rawLines = screen.split(/\r?\n/);
  const lines = rawLines.map(line => line.trim());
  const heading = lines.indexOf("Folder access");
  if (heading < 0) return null;
  const question = lines.slice(heading + 2).findIndex(line => line.startsWith("Trust this folder?"));
  if (question < 0) return null;
  const start = heading + 2 + question;
  if (!matchesWorkspacePath(rawLines, heading, start, cwd, 2)) return null;
  const options = lines.flatMap((line, i) => {
    if (i <= start) return [];
    const match = /^(›\s*)?([12])\. (Trust and continue|Quit)$/.exec(line);
    return match ? [{ index: i, n: Number(match[2]), label: match[3]!, selected: !!match[1] }] : [];
  });
  if (options.length !== 2 || options.some((o, i) => o.n !== i + 1) || options[0]!.label !== "Trust and continue" || options[1]!.label !== "Quit" ||
      options.filter(o => o.selected).length !== 1 || options[1]!.index !== options[0]!.index + 1 ||
      lines.slice(options[1]!.index + 1).filter(Boolean).join("\n") !== "enter continue · esc quit") return null;
  const explanation = lines.slice(start, options[0]!.index).filter(Boolean).join(" ");
  if (!explanation.includes("Codex can read, edit, and run files here") || !explanation.endsWith("Your trust decision will be saved.")) return null;
  return { selected: options.findIndex(o => o.selected), prompt: {
    title: "폴더 신뢰 확인", body: `${cwd}\n${explanation}`, question: "Trust this folder?",
    options: options.map(o => ({ n: o.n, label: o.label, reject: o.label === "Quit" })),
    fingerprint: createHash("sha256").update(screen).digest("hex").slice(0, 24),
  } };
}

/** Never reconstruct wrapped paths or remove potentially real path whitespace. */
function matchesWorkspacePath(lines: string[], heading: number, question: number, cwd: string, indent: number): boolean {
  if (!cwd.startsWith("/") || unsafePathCharacters.test(cwd) || cwd.endsWith(" ")) return false;
  const rows = lines.slice(heading + 1, question);
  while (rows.length && /^ *$/.test(rows[0]!)) rows.shift();
  while (rows.length && /^ *$/.test(rows.at(-1)!)) rows.pop();
  if (rows.length !== 1) return false;
  const row = rows[0]!;
  // A full-width row may continue on a blank/space-only row. Trailing spaces
  // may be padding or a different folder name; neither establishes this cwd.
  if (unsafePathCharacters.test(row) || Bun.stringWidth(row) >= 160 || / $/.test(row)) return false;
  return row === cwd || row === " ".repeat(indent) + cwd;
}

const unsafePathCharacters = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u;
