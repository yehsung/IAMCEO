import * as fs from "node:fs";
import { readLocalFile } from "../../server/local-files.ts";
import type { Store } from "../../server/store.ts";
const home = process.argv[2]!;
let opens = 0;
const io = { ...fs, openSync: ((...args: Parameters<typeof fs.openSync>) => { opens++; return fs.openSync(...args); }) as typeof fs.openSync };
try {
  readLocalFile({ requireProject: () => ({ cwd: home }), listMembers: () => [] } as unknown as Store, "fixture", "pipe", home, [], io);
  process.exit(1);
} catch (error) {
  if ((error as { status: number }).status !== 403 || opens !== 0) process.exit(2);
  console.log("403 no opens");
}
