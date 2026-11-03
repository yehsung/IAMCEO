// csv·tsv 해석과 정렬. 화면과 떨어진 순수 함수라 시험에서 바로 부른다.

export interface ParsedTable {
  /** 표의 열 수(최대 TABLE_COLUMN_LIMIT)만큼 채워져 있다. */
  header: string[];
  /** 열이 모자란 행은 채우지 않는다. 행 × 열 만큼 메모리가 늘어 1MB 파일로도 탭이 죽는다. 없는 칸은 빈 칸으로 읽는다. */
  rows: string[][];
  /** 상한에 걸려 버린 열 수. 없으면 전부 들어온 것이다. */
  hiddenColumns?: number;
}

/** 읽어 들일 열 수. 넘는 칸은 버리고 '앞 N열만 표시'로 알린다. */
export const TABLE_COLUMN_LIMIT = 200;

/** 따옴표 밖 첫 줄에서 가장 많이 나온 구분자. 엑셀의 세미콜론 csv 도 받는다. */
export function sniffDelimiter(text: string): string {
  const counts: Record<string, number> = { ",": 0, "\t": 0, ";": 0 };
  let quoted = false;
  for (const c of text.slice(0, 8192)) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "\n" || c === "\r")) break;
    else if (!quoted && c in counts) counts[c]!++;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]!;
  return n > 0 ? best : ",";
}

/** RFC 4180: 따옴표 안의 구분자·줄바꿈, "" 는 따옴표 하나. 잘린 파일이면 마지막 온전하지 않은 줄을 버린다. */
export function parseDelimited(input: string, delimiter = sniffDelimiter(input), truncated = false): ParsedTable {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  let cells = 0;
  let maxCells = 0;
  const endCell = () => {
    if (cells++ < TABLE_COLUMN_LIMIT) row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    maxCells = Math.max(maxCells, cells);
    cells = 0;
    // 빈 줄은 행이 아니다
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      if (c === '"') quoted = false;
      else cell += c;
      i++;
      continue;
    }
    if (c === '"' && cell === "") quoted = true;
    else if (c === delimiter) endCell();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else cell += c;
    i++;
  }
  // 잘린 파일의 끝 줄은 어디서 끊겼는지 모른다
  if (!truncated && (cell !== "" || row.length > 0)) endRow();
  const header = rows.shift() ?? [];
  const width = Math.min(maxCells, TABLE_COLUMN_LIMIT);
  while (header.length < width) header.push("");
  return maxCells > width ? { header, rows, hiddenColumns: maxCells - width } : { header, rows };
}

/** 1,234 · -3.5 · 12% 는 수로 친다. 전화번호처럼 0 으로 시작하는 긴 숫자는 글이다. */
export function cellNumber(cell: string): number | null {
  const s = cell.trim();
  if (!/^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?%?$/.test(s) || !/\d/.test(s)) return null;
  if (/^[-+]?0\d/.test(s)) return null;
  const n = Number(s.replace(/[,%]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** 빈 칸을 뺀 값이 전부 수면 수 열이다. */
export function isNumericColumn(rows: string[][], col: number): boolean {
  let seen = false;
  for (const r of rows) {
    const v = r[col] ?? "";
    if (v.trim() === "") continue;
    if (cellNumber(v) === null) return false;
    seen = true;
  }
  return seen;
}

export type SortDir = "asc" | "desc";

/** 안정 정렬. 빈 칸은 방향과 상관없이 맨 아래다. */
export function sortRows(rows: string[][], col: number, dir: SortDir): string[][] {
  const numeric = isNumericColumn(rows, col);
  const sign = dir === "asc" ? 1 : -1;
  const collator = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const x = a.r[col] ?? "";
      const y = b.r[col] ?? "";
      if (!x.trim() || !y.trim()) return (x.trim() ? 0 : 1) - (y.trim() ? 0 : 1) || a.i - b.i;
      const d = numeric ? cellNumber(x)! - cellNumber(y)! : collator.compare(x, y);
      return d * sign || a.i - b.i;
    })
    .map((e) => e.r);
}
