// Synthetic terminal.read path rows, based on the existing observed menu
// structures. These are regression fixtures, not captures from a live CLI.
const edge = "/tmp/" + "a".repeat(155);
const koreanEdge = "/tmp/" + "한".repeat(77) + "a";

export const folderTrustPathCases = [
  { name: "exact short path", cwd: "/tmp/project", rows: [" /tmp/project"], accepted: true },
  { name: "exact Korean path", cwd: "/tmp/한글 프로젝트/직원", rows: [" /tmp/한글 프로젝트/직원"], accepted: true },
  { name: "exact special characters", cwd: "/tmp/a $'`[]#;&()/child", rows: [" /tmp/a $'`[]#;&()/child"], accepted: true },
  { name: "exact internal Unicode spaces", cwd: "/tmp/공백\u00a0중간\u3000폴더/직원", rows: ["/tmp/공백\u00a0중간\u3000폴더/직원"], accepted: true },
  { name: "short single final space is ambiguous", cwd: "/tmp/project", rows: [" /tmp/project "], accepted: false },
  { name: "short padded path is ambiguous", cwd: "/tmp/project", rows: [" /tmp/project     "], accepted: false },
  { name: "160-cell padded path is ambiguous", cwd: "/tmp/project", rows: [(" /tmp/project").padEnd(160)], accepted: false },
  { name: "full-width ending may be clipped", cwd: edge, rows: [edge], accepted: false },
  { name: "two full-width path rows are ambiguous", cwd: edge + "/member-work", rows: [edge, "/member-work".padEnd(160)], accepted: false },
  { name: "Korean padded path is ambiguous", cwd: "/tmp/한글 프로젝트/직원", rows: [" /tmp/한글 프로젝트/직원     "], accepted: false },
  { name: "Korean full-width wrap is ambiguous", cwd: koreanEdge + "/직원", rows: [koreanEdge, "/직원     "], accepted: false },
  { name: "wide character wraps at 159 cells", cwd: edge.slice(0, -1) + "한글/직원", rows: [edge.slice(0, -1), "한글/직원"], accepted: false },
  { name: "padded internal Unicode spaces are ambiguous", cwd: "/tmp/공백\u00a0중간\u3000폴더/직원", rows: ["/tmp/공백\u00a0중간\u3000폴더/직원   "], accepted: false },
  { name: "different folder", cwd: "/tmp/project", rows: [" /tmp/project-other     "], accepted: false },
  { name: "different wrapped folder", cwd: edge + "/member-work", rows: [edge, "/other-work"], accepted: false },
  { name: "truncated path", cwd: edge + "/member-work", rows: [edge], accepted: false },
  { name: "full-width last wrap may be clipped", cwd: edge + edge, rows: [edge, edge], accepted: false },
  { name: "padded wide-character boundary is ambiguous", cwd: edge.slice(0, -1) + "한글/직원", rows: [edge.slice(0, -1) + " ", "한글/직원"], accepted: false },
  { name: "ellipsis truncation", cwd: edge + "/member-work", rows: [edge.slice(0, -3) + "..."], accepted: false },
  { name: "Unicode ellipsis truncation", cwd: edge + "/member-work", rows: [edge.slice(0, -1) + "…"], accepted: false },
  { name: "short lines are not wraps", cwd: "/tmp/project/child", rows: [" /tmp/project", "/child"], accepted: false },
  { name: "missing wrapped separator", cwd: edge + "/member-work", rows: [edge, "member-work"], accepted: false },
  { name: "blank continuation", cwd: edge + "/member-work", rows: [edge, " ".repeat(160), "/member-work"], accepted: false },
  { name: "space at wrap is ambiguous", cwd: edge + "/member-work", rows: [edge.slice(0, -1) + " ", "/member-work"], accepted: false },
  { name: "leading continuation space is significant", cwd: edge + "/member-work", rows: [edge, " /member-work"], accepted: false },
  { name: "trailing folder space is ambiguous", cwd: "/tmp/project ", rows: [" /tmp/project     "], accepted: false },
  { name: "unsafe path control", cwd: "/tmp/project\tchild", rows: [" /tmp/project\tchild"], accepted: false },
] as const;
