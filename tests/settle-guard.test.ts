// 같은 프로세스에 core 소켓을 띄우는 시험 파일은 bun:test 의 .rejects·.resolves 를 쓰지 않는다.
// 그 단정은 그 자리에서 이벤트 루프를 한 겹 더 돌리는데, 그동안 가짜 core 가 요청을 못 받아 느린 CI 에서 흔들렸다(까닭은 fixtures/settle.ts).
// 대신 fixtures/settle.ts 의 rejection·thrower 나 보통의 await 로 받는다.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const dir = import.meta.dir;
const self = basename(import.meta.path);
/** 가짜 core 틀, 브라우저 core 틀, 직접 띄우는 node:net 서버. */
const CORE_SOCKET = [
  /from "\.\/fixtures\/core-harness(\.ts)?"/,
  /from "\.\/fixtures\/core-browser-harness(\.ts)?"/,
  /import \{[^}]*\bcreateServer\b[^}]*\} from "node:net"/,
];
const NESTED_LOOP = /\)\s*\.\s*(rejects|resolves)\b/g;

test("core 소켓을 띄우는 시험 파일에는 expect(…).rejects·resolves 가 없다", () => {
  const found: string[] = [];
  for (const name of readdirSync(dir).filter(n => n.endsWith(".test.ts") && n !== self).sort()) {
    const text = readFileSync(join(dir, name), "utf8");
    if (!CORE_SOCKET.some(pattern => pattern.test(text))) continue;
    for (const match of text.matchAll(NESTED_LOOP)) found.push(`${name}:${text.slice(0, match.index).split("\n").length} .${match[1]}`);
  }
  expect(found).toEqual([]);
});

test("검사가 실제로 잡는다", () => {
  const sample = 'import { coreSetup } from "./fixtures/core-harness.ts";\nawait expect(t.orch.sleepMember(id)).rejects.toThrow();\nawait expect(p)\n  .resolves.toBe(1);';
  expect(CORE_SOCKET.some(pattern => pattern.test(sample))).toBe(true);
  expect([...sample.matchAll(NESTED_LOOP)].map(m => m[1])).toEqual(["rejects", "resolves"]);
  expect(CORE_SOCKET.some(pattern => pattern.test('import { Socket } from "node:net";'))).toBe(false);
});
