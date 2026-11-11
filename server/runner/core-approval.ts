import { createHash } from "node:crypto";
import type { ApprovalPrompt } from "../../shared/types.ts";

/**
 * Claude Code's observed plain-text setup menu only (2.1.319, 2.1.322). No inferred Codex menus.
 * 2.1.322 puts an explanation row and a "Security guide" row between the question and the options; rows there
 * that are not one of the two options are not read as options. An empty folder shows no dialog at all (2.1.322).
 */
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

/** Only a complete, unpadded single row can establish the workspace path. */
function matchesWorkspacePath(lines: string[], heading: number, question: number, cwd: string, indent: number): boolean {
  if (!cwd.startsWith("/") || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(cwd) || /\s$/u.test(cwd)) return false;
  const rows = lines.slice(heading + 1, question);
  while (rows.length && /^ *$/.test(rows[0]!)) rows.shift();
  while (rows.length && /^ *$/.test(rows.at(-1)!)) rows.pop();
  if (rows.length !== 1) return false;
  const path = rows[0]!;
  // terminal.read does not distinguish padding from a real filename space, or
  // soft wraps from separate rows. Trimming/joining could approve another cwd.
  // Even an exact row at the 160-cell edge could have a clipped continuation.
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(path) || /\s$/u.test(path) || Bun.stringWidth(path) >= 160) return false;
  return path === cwd || path === " ".repeat(indent) + cwd;
}

const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]|\x1b./g;
const TRUST_WORDING = /\btrust(?:ed|ing)?\b[^\n]{0,80}\b(?:folder|directory|workspace|files|project)\b|\b(?:folder|directory|workspace|project)\b[^\n]{0,80}\btrust(?:ed)?\b|^\s*Accessing workspace:\s*$|^\s*Folder access\s*$/im;
/** An option row carrying the selection mark of a CLI menu (Claude `❯`, Codex `›`), optionally inside a drawn box. */
const SELECTED_OPTION = /^\s*[│┃]?\s*[❯›]\s*\S/;
/**
 * Guidance only. Says that the bottom of the screen reads like a folder-trust dialog of some CLI version, so the
 * owner can be told to open the terminal and answer it. It never yields options or keys: only the exact parsers
 * above may answer a dialog.
 *
 * Trust wording alone is not a dialog: a start banner's path (`directory: ~/workspace/trust-api`) or a sentence in
 * the conversation reads the same. A dialog is a menu, so a selected option row must sit among the last rows, below
 * the wording. A composer also starts with that mark, so the caller must first rule out a visible input box
 * (`trustDialogLike` in core.ts): a real folder-trust dialog has none.
 */
export function looksLikeFolderTrust(screen: string): boolean {
  const lines = screen.replace(ANSI, "").split(/\r?\n/).filter(line => line.trim()).slice(-40);
  const selected = lines.findLastIndex(line => SELECTED_OPTION.test(line));
  if (selected < 1 || lines.length - 1 - selected > 8) return false;
  return TRUST_WORDING.test(lines.slice(0, selected).join("\n"));
}

/** 알림·기록에 쓸 한 줄 요약. 예: "폴더 신뢰 확인: /work/app · 이 폴더에서 AI가 파일을 읽고 고치고 실행할 수 있게 됩니다" */
export function approvalSummary(a: ApprovalPrompt, max = 160): string {
  const lines = a.body.split("\n").map((l) => l.trim()).filter((l) => l && !/^Tip:/.test(l));
  // 명령·파일 이름처럼 가장 구체적인 줄은 보통 마지막 쪽이다. 짧은 창이면 다 붙인다.
  const detail = lines.length <= 2 ? lines.join(" · ") : lines[lines.length - 1]!;
  const s = [a.title, detail].filter(Boolean).join(": ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
