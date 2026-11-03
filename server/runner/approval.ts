// Claude Code 권한 승인 창을 화면에서 읽는다. 실측(Claude Code 2.1.316) 모양:
//
//   ──────────────────────────────     ← 창 위 실선
//    Bash command                      ← 제목
//    Tip: …                            ← 본문(설명·명령·미리보기, 점선 ╌ 으로 나뉨)
//    ╌╌╌╌╌╌╌╌
//    mkdir -p out && touch out/a.txt
//    ╌╌╌╌╌╌╌╌
//    Do you want to proceed?           ← 질문(파일이면 "Do you want to create c.txt?")
//    ❯ 1. Yes                          ← 선택지. 길면 다음 줄로 들여 이어진다
//      2. Yes, and don't ask again for … commands in
//         /tmp/proj
//      3. No
//
//    Esc to cancel · Tab to amend
//
// 숫자 키 하나가 그 선택지를 고르고 바로 확정한다(실측: '1' 은 실행, 'No' 번호는 "Interrupted · What should Claude do instead?").
// 폴더 신뢰 창·바이패스 경고 창·그 밖의 선택 창은 다루지 않는다(null).
import { createHash } from "node:crypto";
import type { ApprovalOption, ApprovalPrompt } from "../../shared/types.ts";

const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
const strip = (s: string) => s.replace(OSC_RE, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b./g, "");
const SOLID_RULE = /^\s*[╭╰]?─{8,}/;
const DASHED_RULE = /^\s*╌{8,}\s*$/;
const QUESTION = /^\s*Do you want\b/;
const ESC_LINE = /^\s*Esc to cancel\b/;
const OPTION = /^\s*(?:❯\s*)?(\d{1,2})\.\s+(.*)$/;

/** 질문 줄과 'Esc to cancel' 줄 사이가 이보다 길면 승인 창으로 보지 않는다(대화 글을 잘못 읽지 않게). */
const MAX_OPTION_LINES = 24;

export function parseApproval(screen: string): ApprovalPrompt | null {
  const lines = strip(screen).split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  if (lines.some((l) => /Yes, I trust this folder|Bypass Permissions mode/.test(l))) return null;

  let esc = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (ESC_LINE.test(lines[i]!)) { esc = i; break; }
  if (esc < 0) return null;
  let q = -1;
  for (let i = esc - 1; i >= 0 && esc - i <= MAX_OPTION_LINES; i--) if (QUESTION.test(lines[i]!)) { q = i; break; }
  if (q < 0) return null;

  // 질문이 길면 다음 줄로 이어진다. 첫 선택지까지가 질문이다.
  const question: string[] = [lines[q]!.trim()];
  const options: ApprovalOption[] = [];
  for (let i = q + 1; i < esc; i++) {
    const line = lines[i]!;
    const m = OPTION.exec(line);
    if (m) {
      const n = Number(m[1]);
      if (n !== options.length + 1) return null; // 1, 2, 3 … 차례가 아니면 선택지 목록이 아니다
      options.push({ n, label: m[2]!.trim(), reject: false });
    } else if (!line.trim()) {
      continue;
    } else if (options.length === 0) {
      question.push(line.trim());
    } else {
      options[options.length - 1]!.label += ` ${line.trim()}`;
    }
  }
  if (options.length < 2) return null;
  for (const o of options) o.reject = /^No\b/i.test(o.label);
  if (!options.some((o) => o.reject)) return null; // 승인 창에는 늘 거절이 있다. 없으면 다른 선택 창이다

  let top = -1;
  for (let i = q - 1; i >= 0; i--) if (SOLID_RULE.test(lines[i]!)) { top = i; break; }
  const inner = lines.slice(top + 1, q);
  let title = "";
  let bodyLines = inner;
  if (top >= 0) {
    const t = inner.findIndex((l) => l.trim());
    if (t >= 0) { title = inner[t]!.trim(); bodyLines = inner.slice(t + 1); }
  }
  // 창 안의 글은 한 칸 들여 그려진다. 명령·미리보기의 들여쓰기는 남기고 그 한 칸만 뺀다.
  const body = bodyLines
    .filter((l) => !DASHED_RULE.test(l))
    .map((l) => l.replace(/^ /, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");

  const q2 = question.join(" ");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([title, body, q2, options.map((o) => [o.n, o.label])]))
    .digest("hex")
    .slice(0, 24);
  return { title, body, question: q2, options, fingerprint };
}

/** 알림·기록에 쓸 한 줄 요약. 예: "Bash command: mkdir -p out && touch out/a.txt" */
export function approvalSummary(a: ApprovalPrompt, max = 160): string {
  const lines = a.body.split("\n").map((l) => l.trim()).filter((l) => l && !/^Tip:/.test(l));
  // 명령·파일 이름처럼 가장 구체적인 줄은 보통 마지막 쪽이다. 짧은 창이면 다 붙인다.
  const detail = lines.length <= 2 ? lines.join(" · ") : lines[lines.length - 1]!;
  const s = [a.title, detail].filter(Boolean).join(": ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
