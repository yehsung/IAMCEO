import { createHash } from "node:crypto";
import type { ApprovalPrompt } from "../../shared/types.ts";

/** Claude Code 2.1.319's observed plain-text setup menu only. No inferred Codex menus. */
export function claudeFolderTrust(screen: string, cwd: string): { prompt: ApprovalPrompt; selected: number } | null {
  if (screen.includes("\x1b")) return null;
  const lines = screen.split(/\r?\n/).map((line) => line.trim());
  const heading = lines.indexOf("Accessing workspace:");
  if (heading < 0 || lines[heading + 1] !== cwd) return null;
  const question = lines.findIndex((line, i) => i > heading + 1 && line.startsWith("Quick safety check: Is this a project you created or one you trust?"));
  if (question < 0) return null;
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
