// csv·tsv 를 표로. 머리글을 누르면 정렬한다. 줄이 많으면 앞부분만 그리고 전체는 내려받는다.
import { useMemo, useState } from "react";
import type { Attachment, FileDoc } from "@shared/types";
import { formatBytes } from "../Attachments";
import { isNumericColumn, parseDelimited, sortRows, type SortDir } from "./delimited";
import { DownloadLink, ViewerNote } from "./parts";
import { useTextSource } from "./source";

/** 한 번에 그릴 줄 수. 정렬은 받은 줄 전부에 하고 그 앞부분을 그린다. */
export const TABLE_ROW_LIMIT = 500;

export function TableViewer({ file, att }: { file: FileDoc; att: Attachment | null }) {
  const source = useTextSource(file, att);
  const [sort, setSort] = useState<{ col: number; dir: SortDir } | null>(null);
  const ready = source.status === "ready" ? source : null;
  const delimiter = att && /\.tsv$/i.test(att.name) ? "\t" : undefined;
  const table = useMemo(() => (ready ? parseDelimited(ready.text, delimiter, ready.truncated) : null), [ready?.text, ready?.truncated, delimiter]);
  const numeric = useMemo(() => table?.header.map((_, i) => isNumericColumn(table.rows, i)) ?? [], [table]);
  const rows = useMemo(() => (table && sort ? sortRows(table.rows, sort.col, sort.dir) : (table?.rows ?? [])), [table, sort]);

  if (source.status === "loading") return <ViewerNote>표를 불러오는 중입니다</ViewerNote>;
  if (source.status === "error" || !table) return <ViewerNote tone="bad">{source.status === "error" ? source.text : "표를 읽지 못했습니다"}</ViewerNote>;

  const toggle = (col: number) =>
    setSort((cur) => (cur?.col !== col ? { col, dir: "asc" } : cur.dir === "asc" ? { col, dir: "desc" } : null));
  const shown = rows.slice(0, TABLE_ROW_LIMIT);

  return (
    <section className="vw-table" aria-label="표">
      <div className="vw-bar">
        <p className="vw-bar__text t-tabular">
          {ready?.truncated ? `앞부분 ${table.rows.length.toLocaleString()}행` : `${table.rows.length.toLocaleString()}행`} · {table.header.length}열
          {rows.length > shown.length ? ` · 앞 ${shown.length.toLocaleString()}행만 표시` : ""}
          {table.hiddenColumns ? ` · 전체 ${(table.header.length + table.hiddenColumns).toLocaleString()}열 중 앞 ${table.header.length}열만 표시` : ""}
        </p>
        {att ? <DownloadLink att={att} label={ready?.truncated || rows.length > shown.length || table.hiddenColumns ? `전체 받기 (${formatBytes(att.size)})` : "받기"} /> : null}
      </div>
      {table.header.length === 0 ? (
        <ViewerNote>비어 있는 표입니다</ViewerNote>
      ) : (
        <div className="vw-table__scroll" tabIndex={0} role="region" aria-label={`${file.title} 표, 가로로 밀어 볼 수 있습니다`}>
          <table>
            <thead>
              <tr>
                {table.header.map((h, i) => (
                  <th key={i} scope="col" data-num={numeric[i] ? "" : undefined} aria-sort={sort?.col === i ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                    <button type="button" onClick={() => toggle(i)}>
                      <span>{h || `열 ${i + 1}`}</span>
                      <i aria-hidden="true">{sort?.col === i ? (sort.dir === "asc" ? "↑" : "↓") : ""}</i>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r, y) => (
                <tr key={y}>
                  {table.header.map((_, x) => (
                    <td key={x} data-num={numeric[x] ? "" : undefined}>
                      {r[x] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
