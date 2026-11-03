// 배포판: 맥 두 종류(Apple Silicon·Intel)용 단일 실행 파일과 SHA256SUMS 를 dist/release/ 에 만든다.
// install.sh 가 GitHub 릴리스에서 이 이름 그대로 받는다. 릴리스 워크플로(.github/workflows/release.yml)와 로컬이 같은 스크립트를 쓴다.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const out = join(root, "dist", "release");
const TARGETS = ["darwin-arm64", "darwin-x64"] as const;

function run(cmd: string[]): void {
  const p = Bun.spawnSync(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error(`실패(${p.exitCode}): ${cmd.join(" ")}`);
}

mkdirSync(out, { recursive: true });
const sums: string[] = [];
for (const t of TARGETS) {
  const file = join(out, `iamceo-${t}`);
  run(["bun", "build", "bin/iamceo.ts", "--compile", `--target=bun-${t}`, "--outfile", file]);
  // Apple Silicon 은 서명 없는 실행 파일을 죽인다. 맥에서 만들면 임시(ad-hoc) 서명을 다시 붙여 확실히 한다.
  if (process.platform === "darwin") run(["codesign", "--force", "--sign", "-", file]);
  sums.push(`${createHash("sha256").update(readFileSync(file)).digest("hex")}  iamceo-${t}`);
}
writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(`${out}\n${sums.join("\n")}`);
