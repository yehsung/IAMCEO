import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { folderFixture } from "./folder-fixture.ts";
let f: Awaited<ReturnType<typeof folderFixture>>;
beforeAll(async () => {
  f = await folderFixture();
  for (const name of ["zeta", "Alpha", "가나다", ".hidden", "locked"]) mkdirSync(join(f.home, name));
  chmodSync(join(f.home, "locked"), 0);
  writeFileSync(join(f.home, "file"), "file");
  symlinkSync(f.root, join(f.home, "escape"));
});
afterAll(async () => { chmodSync(join(f.home, "locked"), 0o700); await f.close(); });
test("lists only accessible nonhidden folders, locale sorted; default/tilde home and parent", async () => {
  const response = await f.request("/api/folders"); expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.path).toBe(f.home); expect(body.home).toBe(f.home); expect(body.parent).toBeNull();
  expect(body.entries.map((e: { name: string }) => e.name)).toEqual(["zeta", "Alpha", "가나다"].sort((a, b) => a.localeCompare(b)));
  const nested = await (await f.request("/api/folders?path=" + encodeURIComponent("~/Alpha"))).json();
  expect(nested.parent).toBe(f.home);
});
test("outside home, traversal, and external symlink return 403", async () => {
  for (const path of [f.root, join(f.home, ".."), join(f.home, "escape"), "~/../", ".."]) {
    expect((await f.request("/api/folders?path=" + encodeURIComponent(path))).status).toBe(403);
  }
});
test("create trims Korean/spaces, duplicate returns Korean 409", async () => {
  const response = await f.request("/api/folders", { parent: f.home, name: "  새 프로젝트  " });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ name: "새 프로젝트", path: join(f.home, "새 프로젝트") });
  const duplicate = await f.request("/api/folders", { parent: f.home, name: "새 프로젝트" });
  expect(duplicate.status).toBe(409); expect((await duplicate.json()).error).toBe("같은 이름의 폴더가 있습니다");
});
test("invalid names are 400, outside parent is 403", async () => {
  for (const name of ["", " ", ".", "..", ".hidden", "a/b", "a\0b", "a\nb", "x".repeat(101)]) {
    expect((await f.request("/api/folders", { parent: f.home, name })).status).toBe(400);
  }
  expect((await f.request("/api/folders", { parent: f.root, name: "x" })).status).toBe(403);
  expect((await f.request("/api/folders", { parent: join(f.home, "escape"), name: "x" })).status).toBe(403);
});
test("GET and POST require representative Bearer authentication", async () => {
  expect((await f.request("/api/folders", undefined, false)).status).toBe(401);
  expect((await f.request("/api/folders", { parent: f.home, name: "x" }, false)).status).toBe(401);
});
test("returns at most the first 500 directories with truncation", async () => {
  const parent = join(f.home, "large"); mkdirSync(parent);
  for (let n = 0; n < 501; n++) mkdirSync(join(parent, String(n).padStart(3, "0")));
  const body = await (await f.request("/api/folders?path=" + encodeURIComponent(parent))).json();
  expect(body.entries.length).toBe(500); expect(body.truncated).toBe(true); expect(body.entries[0].name).toBe("000");
});
