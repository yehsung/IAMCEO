// 배포용 묶음: src/index.ts 와 그것이 쓰는 Mac 서버 코드(server/push/apns.ts·shared/push.ts)를 lib/index.js 하나로 묶는다.
// Firebase 는 functions 폴더만 올리므로 저장소의 다른 폴더 코드는 이렇게 묶어서 올린다.
// firebase-functions·firebase-admin 은 묶지 않는다(배포 때 Cloud Build 가 package-lock.json 대로 설치한다).
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = process.argv[2] ?? join(root, "src/index.ts");
const outfile = process.argv[3] ?? join(root, "lib/index.js");

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
  external: ["firebase-functions", "firebase-functions/*", "firebase-admin", "firebase-admin/*"],
});
