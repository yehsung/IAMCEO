// 배포판: 맥 두 종류(Apple Silicon·Intel)용 단일 실행 파일과 SHA256SUMS 를 dist/release/ 에 만든다.
// CLI 호환 자산이다. Mac 앱 설치 DMG는 release-mac.ts가 만들고 SHA256SUMS에 이 항목들을 합친다.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const out = join(root, "dist", "release");
// 한 릴리스의 실행 파일은 모두 같은 Bun 으로 만든다: CI 의 CLI 자산(여기)과 감독자 Mac 의 DMG 안 데몬(release-mac.ts) 모두 .bun-version.
const pinned = readFileSync(join(root, ".bun-version"), "utf8").trim();
const bun = Bun.spawnSync(["bun", "--version"], { cwd: root, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
if (Bun.version !== pinned || bun !== pinned) throw new Error(`Bun ${pinned}(.bun-version)으로 만들어야 합니다: 이 Bun ${Bun.version}, PATH 의 bun ${bun || "없음"}`);
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
