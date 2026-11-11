// Claude Code 화면(입력칸·상태줄) 해석. 실행기 종류와 무관하게 화면 글자만 본다.

const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
const stripAnsi = (s: string) => s.replace(OSC_RE, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const isRule = (l: string) => /^\s*[╭╰]?─{5,}/.test(l);

/**
 * 화면을 줄로 나누고 글자마다 흐린 글씨(SGR 2)인지 함께 돌려준다. 글자 모양 상태는 줄을 넘어 이어진다.
 * 확장 색(38;5;n, 38;2;r;g;b)의 숫자 2 는 흐림이 아니다.
 */
function scanDim(screen: string): { text: string; dim: boolean[] }[] {
  const lines: { text: string; dim: boolean[] }[] = [];
  let text = "";
  let dim: boolean[] = [];
  let faint = false;
  const token = /\x1b\[([0-?]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[^[\]]?|\n|[^\x1b\n]+/gy;
  for (let m = token.exec(screen); m; m = token.exec(screen)) {
    const t = m[0];
    if (t === "\n") {
      lines.push({ text, dim });
      text = "";
      dim = [];
    } else if (t[0] !== "\x1b") {
      text += t;
      for (let i = 0; i < t.length; i++) dim.push(faint);
    } else if (m[2] === "m" && !/[<=>?]/.test(m[1]!)) {
      const params = m[1] === "" ? ["0"] : m[1]!.split(";");
      for (let i = 0; i < params.length; i++) {
        const p = params[i]!;
        if (p.includes(":")) continue;
        const n = Number(p || "0");
        if (n === 38 || n === 48 || n === 58) {
          i += params[i + 1] === "5" ? 2 : params[i + 1] === "2" ? 4 : 0;
          continue;
        }
        if (n === 0) faint = false;
        else if (n === 2) faint = true;
        else if (n === 22) faint = false;
      }
    }
  }
  lines.push({ text, dim });
  return lines;
}

/** 빈 입력칸의 안내 문구(Claude Code 2.1.322 기준). 고르는 중("Press Enter to edit the selected message…")은 넣지 않는다. */
const INPUT_HINTS = [
  /^Try "[^"]*"$/,
  /^Press up to edit queued( messages?)?(, Enter to send them immediately)?$/,
  /^Press up to select a queued message(?: to edit, or Enter to send them now|, then Enter to edit it)$/,
];

/**
 * Claude 입력칸에 친 글. 두 가로줄 사이의 `❯`(또는 `>`) 줄부터 읽는다. 빈 문자열이면 비었다.
 * null 은 입력칸을 못 찾음(승인 창·선택 창·다른 프로그램).
 * 흐린 글씨(빈 입력칸의 안내 글, 다음에 칠 말 추천)는 친 글이 아니다. 색을 지운 화면에서는 구분되지 않아
 * 화면을 ansi 로 읽어 글자마다 흐림을 본다. 글자만 있는 화면이면 알려진 안내 문구로 거른다.
 */
export function inputText(screen: string): string | null {
  const scanned = scanDim(screen);
  const box = inputBox(scanned.map((l) => l.text));
  if (!box) return null;
  const typed = (i: number, from = 0): string => {
    const l = scanned[i]!;
    let s = "";
    for (let k = from; k < l.text.length; k++) if (!l.dim[k]) s += l.text[k];
    return s;
  };
  const first = typed(box.top + 1, box.prefix).replace(/\s*[│┃]?\s*$/, "").trim();
  const rest: string[] = [];
  for (let i = box.top + 2; i < box.bottom; i++) rest.push(typed(i).replace(/[│┃]/g, "").trim());
  // 좁은 칸에서는 안내 문구가 여러 줄로 접힌다. 이어 붙인 글 전체가 안내 문구일 때만 빈 칸이다.
  const whole = [first, ...rest].filter(Boolean).join(" ");
  if (INPUT_HINTS.some((hint) => hint.test(whole))) return "";
  return [INPUT_HINTS.some((hint) => hint.test(first)) ? "" : first, ...rest].join("\n").trim();
}

/** 화면 아래에서부터 찾은 입력칸: 위·아래 가로줄 줄 번호와 첫 줄 `❯ ` 머리의 길이. */
function inputBox(lines: string[]): { top: number; bottom: number; prefix: number } | null {
  for (let bottom = lines.length - 1; bottom > 0; bottom--) {
    if (!isRule(lines[bottom]!)) continue;
    let top = bottom - 1;
    while (top >= 0 && !isRule(lines[top]!)) top--;
    if (top < 0) return null;
    const m = top + 1 < bottom ? /^(\s*[│┃]?\s*[❯>›]\s?)(.*?)\s*[│┃]?\s*$/.exec(lines[top + 1]!) : null;
    if (!m) { bottom = top + 1; continue; }
    return { top, bottom, prefix: m[1]!.length };
  }
  return null;
}

/** Claude 입력칸이 비었는가. null 은 입력칸을 못 찾음(승인 창·선택 창·다른 프로그램). */
export function inputLooksEmpty(screen: string): boolean | null {
  const text = inputText(screen);
  return text === null ? null : text === "";
}

/**
 * 상태줄의 문맥 %(`│ ███░░░░░░░ │ 27% │`). 실제 창 크기를 반영하므로 토큰 계산보다 먼저 쓴다.
 * 상태줄은 입력칸 바로 아래에 있다. 입력칸 아래에서 막대(█░)가 있는 첫 줄이 상태줄이고, 그 줄의 막대 바로 다음 칸 % 만 읽는다.
 * 좁은 칸에서는 상태줄이 잘린다(`│ ██░░░░░░…`, `│ ███░░░░░░░ │ 2…`). 그때는 null 이고, 다른 줄로 넘어가지 않는다:
 * 더 올라가면 대화에 그린 표·막대를, 더 내려가면 다른 % 칸(사용량 한도 등)을 문맥 %로 잘못 읽는다. 입력칸을 못 찾아도 null.
 */
export function screenContextPct(screen: string): number | null {
  const lines = stripAnsi(screen).split("\n");
  const box = inputBox(lines);
  if (!box) return null;
  const status = lines.slice(box.bottom + 1).find((l) => /[█░]/.test(l));
  if (!status) return null;
  const m = /[█░]+\s*│\s*(\d{1,3})%/.exec(status);
  return m ? Math.min(100, Number(m[1])) : null;
}
