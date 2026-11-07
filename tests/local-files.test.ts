import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { folderFixture } from "./folder-fixture.ts";
import { renderRole } from "../server/roles.ts";
import { FilePublication } from "../server/files.ts";
import { LOCAL_IMAGE_MAX, LOCAL_TEXT_MAX } from "../server/local-files.ts";
import { additionalSecretFiles, allowedProjectFiles, fixturePNG, headSecretFiles, homeSecretPaths, nestedSecretFiles, projectArtifactFiles, relocatedSecretPaths } from "./fixtures/secret-path-cases.ts";

let f: Awaited<ReturnType<typeof folderFixture>>;
let id: string;
let cwd: string;
let worker: string;
const endpoint = () => `/api/projects/${id}`;
const get = (path: string) => f.request(endpoint() + "/local-file?path=" + encodeURIComponent(path));
const post = (path: string, title?: string) => f.request(endpoint() + "/files/from-path", { path, title });
beforeAll(async () => {
  f = await folderFixture();
  cwd = join(f.home, "project"); worker = join(f.home, "worker");
  mkdirSync(cwd); mkdirSync(worker);
  id = f.store.createProject({ name: "파일 보기 시험", cwd }).id;
  f.store.createMember({ projectId: id, handle: "worker", name: "직원", kind: "worker", cwd: worker });
  writeFileSync(join(cwd, "대본.md"), "# 대본\n복사할 내용");
  writeFileSync(join(worker, "worker.txt"), "직원 작업 폴더");
  writeFileSync(join(f.home, "home.json"), '{"ok":true}');
});
afterAll(async () => { await f?.close(); });

test("absolute, tilde, project-relative and member-relative paths; project takes precedence", async () => {
  for (const path of [join(cwd, "대본.md"), "~/project/대본.md", "대본.md"]) {
    const response = await get(path); expect(response.status).toBe(200);
    const body = await response.json(); expect(body.kind).toBe("text"); expect(body.content).toContain("복사할 내용"); expect(body.mime).toContain("text/");
    expect(body.path).toBe(join(cwd, "대본.md")); expect(body.size).toBeGreaterThan(0); expect(body.modifiedAt).toBeString();
  }
  expect((await (await get("worker.txt")).json()).content).toBe("직원 작업 폴더");
  writeFileSync(join(cwd, "worker.txt"), "프로젝트 우선");
  expect((await (await get("worker.txt")).json()).content).toBe("프로젝트 우선");
  expect((await get("~/home.json")).status).toBe(200);
});

test("missing, directories, outside-home, symlink escapes and sensitive aliases fail with Korean reasons", async () => {
  writeFileSync(join(f.root, "outside.txt"), "outside");
  symlinkSync(join(f.root, "outside.txt"), join(cwd, "escape.txt"));
  symlinkSync(join(cwd, "대본.md"), join(cwd, "safe.md"));
  expect((await get("safe.md")).status).toBe(200);
  for (const path of [f.root, join(f.root, "outside.txt"), "escape.txt", cwd, "../../outside.txt"]) {
    const response = await get(path); expect(response.status).toBe(403); expect((await response.json()).error).toMatch(/[가-힣]/);
    expect((await post(path)).status).toBe(403);
  }
  const missing = await get("missing.md"); expect(missing.status).toBe(404); expect((await missing.json()).code).toBe("LOCAL_FILE_NOT_FOUND");
  expect((await get("")).status).toBe(400);
});

test("sensitive locations and filenames rejected directly and through innocent symlink names", async () => {
  const blocked = [".netrc", ".npmrc", ".kube/config", ".docker/config.json", ".zsh_history", ".bash_history", ".python_history", ".history", ".local/share/fish/fish_history", "project/id_ed25519", "project/id_ed25519_sk", "project/id_dsa", "project/id_ecdsa", "project/deploy.p12", "project/deploy.pfx", ".SSH/config", ".CoDeX/Auth.json", "project/.ENV.local", ".ssh/id", ".gnupg/data", ".aws/config", ".iamceo/state", ".config/iamceo/config", ".appstoreconnect/token", ".codex/auth.json", ".codex/auth-backup/token", ".claude.json", "Library/Keychains/login", "project/.env", "project/.env.local", "project/a.pem", "project/a.p8", "project/a.key", "project/id_rsa.pub", "project/credentials.json", "project/login.keychain-db"];
  for (const [index, path] of blocked.entries()) {
    const full = join(f.home, path); mkdirSync(join(full, ".."), { recursive: true }); writeFileSync(full, "secret");
    const alias = join(cwd, `alias-${index}.txt`); symlinkSync(full, alias);
    for (const input of [full, alias]) {
      expect((await get(input)).status).toBe(403);
      expect((await post(input)).status).toBe(403);
    }
  }
  // A sensitive-looking input remains forbidden even if its target is harmless.
  symlinkSync(join(cwd, "대본.md"), join(cwd, ".env.safe"));
  expect((await get(".env.safe")).status).toBe(403);
});

test("HEAD secret basenames remain forbidden while ordinary parent and project names are allowed by both APIs", async () => {
  for (const name of [...headSecretFiles, ...additionalSecretFiles, ...allowedProjectFiles]) {
    const path = join(cwd, "names-policy", name);
    mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "safe fixture");
    const denied = !allowedProjectFiles.includes(name);
    const response = await get(path); expect(response.status, path).toBe(denied ? 403 : 200);
    if (!denied) expect((await response.json()).content).toBe("safe fixture");
    const published = await post(path); expect(published.status, path).toBe(denied ? 403 : 200);
    if (!denied) expect((await published.json()).body).toBe("safe fixture");
  }
  const history = join(f.home, "history"); mkdirSync(history);
  writeFileSync(join(history, "report.md"), "safe fixture");
  const project = f.store.createProject({ name: "history", cwd: history });
  expect((await f.request(`/api/projects/${project.id}/local-file?path=report.md`)).status).toBe(200);
  expect((await f.request(`/api/projects/${project.id}/files/from-path`, { path: "report.md" })).status).toBe(200);
});

test("project secret-directory names allow artifacts and worktrees while secret basenames stay forbidden on both APIs", async () => {
  for (const name of [...projectArtifactFiles, ...nestedSecretFiles]) {
    const path = join(cwd, name); mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, name.endsWith(".png") ? fixturePNG : "safe fixture");
    const denied = nestedSecretFiles.includes(name);
    const response = await get(name); expect(response.status, name).toBe(denied ? 403 : 200);
    if (!denied) {
      if (name.endsWith(".png")) expect(Buffer.from(await response.arrayBuffer())).toEqual(fixturePNG);
      else expect((await response.json()).content).toBe("safe fixture");
    }
    const published = await post(name); expect(published.status, name).toBe(denied ? 403 : 200);
    if (!denied) {
      const doc = await published.json();
      if (name.endsWith(".png")) {
        expect(doc.kind).toBe("image"); expect(doc.attachments).toHaveLength(1);
        expect(readFileSync(doc.attachments[0].path)).toEqual(fixturePNG);
      } else expect(doc.body).toBe("safe fixture");
    }
  }
});

test("a home workspace allows another project's .claude artifacts and still rejects home secret roots on both APIs", async () => {
  const project = f.store.createProject({ name: "home workspace", cwd: f.home });
  const name = "check/.claude/mocks/a.png", path = join(f.home, name);
  mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, fixturePNG);
  const response = await f.request(`/api/projects/${project.id}/local-file?path=${encodeURIComponent(name)}`);
  expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(fixturePNG);
  const published = await f.request(`/api/projects/${project.id}/files/from-path`, { path: name });
  expect(published.status).toBe(200); expect((await published.json()).kind).toBe("image");
  for (const secret of homeSecretPaths) {
    const full = join(f.home, secret); mkdirSync(join(full, ".."), { recursive: true }); writeFileSync(full, "fixture-only secret");
    expect((await f.request(`/api/projects/${project.id}/local-file?path=${encodeURIComponent(secret)}`)).status, secret).toBe(403);
    expect((await f.request(`/api/projects/${project.id}/files/from-path`, { path: secret })).status, secret).toBe(403);
  }
});

test("default secret directories and home files relocated by symlinks reject real, lexical and innocent alias paths on both APIs", async () => {
  const custom = await folderFixture();
  try {
    const work = join(custom.home, "project"); mkdirSync(work);
    const project = custom.store.createProject({ name: "relocated defaults", cwd: work });
    for (const path of relocatedSecretPaths(custom.home, work)) {
      expect((await custom.request(`/api/projects/${project.id}/local-file?path=${encodeURIComponent(path)}`)).status, path).toBe(403);
      expect((await custom.request(`/api/projects/${project.id}/files/from-path`, { path })).status, path).toBe(403);
    }
  } finally { await custom.close(); }
});

test("text/image limits, binary fallback and metadata-only video", async () => {
  writeFileSync(join(cwd, "limit.txt"), Buffer.alloc(LOCAL_TEXT_MAX, 97));
  expect((await get("limit.txt")).status).toBe(200);
  writeFileSync(join(cwd, "limit.txt"), Buffer.alloc(LOCAL_TEXT_MAX + 1, 97));
  expect((await get("limit.txt")).status).toBe(413); expect((await post("limit.txt")).status).toBe(413);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
  writeFileSync(join(cwd, "image.png"), png);
  const image = await get("image.png"); expect(image.headers.get("content-type")).toBe("image/png"); expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
  writeFileSync(join(cwd, "large.heic"), Buffer.alloc(LOCAL_IMAGE_MAX + 1));
  expect((await get("large.heic")).status).toBe(413);
  writeFileSync(join(cwd, "video.mp4"), Buffer.alloc(LOCAL_IMAGE_MAX + 1));
  const video = await (await get("video.mp4")).json(); expect(video.kind).toBe("other"); expect(video.content).toBeUndefined(); expect(video.size).toBe(LOCAL_IMAGE_MAX + 1);
  writeFileSync(join(cwd, "binary.txt"), Buffer.from([255, 0, 254]));
  for (const bytes of [Buffer.from([255, 0, 254]), Buffer.from([97, 0, 98])]) {
    writeFileSync(join(cwd, "binary.txt"), bytes);
    const binary = await (await get("binary.txt")).json(); expect(binary.kind).toBe("other"); expect(binary.content).toBeUndefined();
  }
  writeFileSync(join(cwd, "unknown.extension"), "UTF-8 자료");
  expect((await (await get("unknown.extension")).json()).content).toBe("UTF-8 자료");
});

test("from-path uses FileDoc body/attachments, canonical deduplication and concurrent deduplication", async () => {
  const responses = await Promise.all([post("대본.md", "검토할 대본"), post("~/project/대본.md"), post("safe.md")]);
  const docs = await Promise.all(responses.map(r => r.json()));
  expect(new Set(docs.map(d => d.id)).size).toBe(1); expect(docs[0].title).toBe("검토할 대본"); expect(docs[0].body).toContain("복사할 내용"); expect(docs[0].attachments).toEqual([]);
  const image = await (await post("image.png")).json(); expect(image.kind).toBe("image"); expect(image.attachments.length).toBe(1);
  expect(f.store.getAttachment(image.attachments[0].id)).not.toBeNull();
  const attachment = image.attachments[0]; expect(await Bun.file(attachment.path).exists()).toBe(true);
  writeFileSync(join(cwd, "page.html"), "<h1>검토 자료</h1>");
  const html = await (await post("page.html")).json(); expect(html.kind).toBe("artifact");
  expect(f.store.getFileHtml(html.id)).toBe("<h1>검토 자료</h1>");
  writeFileSync(join(cwd, "table.csv"), "name,value\n자료,1");
  const table = await (await post("table.csv")).json(); expect(table.kind).toBe("table"); expect(table.body).toContain("자료,1");
  const video = await (await post("video.mp4")).json(); expect(video.kind).toBe("video"); expect(video.attachments.length).toBe(1);
  writeFileSync(join(cwd, "large.mp4"), Buffer.alloc(50 * 1024 * 1024 + 1));
  expect((await post("large.mp4")).status).toBe(413);
});

test("hard links to sensitive and outside-home files are rejected by GET and from-path for text and attachments", async () => {
  for (const [index, source] of [join(f.home, ".aws/config"), join(f.root, "outside.txt")].entries()) {
    for (const extension of ["txt", "mp4"]) {
      const alias = join(cwd, `hard-${index}.${extension}`); linkSync(source, alias);
      for (const response of [await get(alias), await post(alias)]) {
        expect(response.status).toBe(403);
        expect((await response.json()).error).toBe("다른 이름으로 연결된 파일(하드 링크)은 열지 않습니다");
      }
    }
  }
});

test("SVG publication preserves the original image attachment instead of a text body", async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>';
  writeFileSync(join(cwd, "diagram.svg"), svg);
  const response = await post("diagram.svg"); expect(response.status).toBe(200);
  const doc = await response.json(); expect(doc.kind).toBe("image"); expect(doc.body).toBe("");
  expect(doc.attachments).toHaveLength(1); expect(doc.attachments[0].mime).toBe("image/svg+xml");
  expect(await Bun.file(doc.attachments[0].path).text()).toBe(svg);
});

test("attachment staging wait coalesces concurrent imports and rejects an archive transition without publishing a file", async () => {
  for (const archive of [false, true]) {
    const project = f.store.createProject({ name: "staging", cwd });
    const path = join(cwd, `pending-${archive}.mp4`); writeFileSync(path, "small fixture video");
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const original = FilePublication.prototype.stagePath;
    let publication: FilePublication | undefined;
    const attachmentCount = () => (f.store.db.query("SELECT COUNT(*) AS n FROM attachments").get() as { n: number }).n;
    const beforeAttachments = attachmentCount();
    const stage = spyOn(FilePublication.prototype, "stagePath").mockImplementation(async function(this: FilePublication, input) {
      publication = this; entered(); await waiting; return original.call(this, input);
    });
    const send = () => f.request(`/api/projects/${project.id}/files/from-path`, { path });
    try {
      const first = send(); await started;
      const second = send();
      // Let the second request reach once() while staging is still waiting.
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(stage).toHaveBeenCalledTimes(1);
      if (archive) f.store.patchProject(project.id, { archived: true });
      release();
      const responses = await Promise.all([first, second]);
      expect(responses.map(r => r.status)).toEqual(archive ? [404, 404] : [200, 200]);
      expect(stage).toHaveBeenCalledTimes(1);
      const manifest = JSON.parse(readFileSync(join(publication!.directory, "manifest.json"), "utf8"));
      expect(manifest.state).toBe(archive ? "failed" : "published");
      expect(attachmentCount()).toBe(beforeAttachments + (archive ? 0 : 1));
      if (archive) {
        expect(f.store.listFiles(project.id)).toHaveLength(0);
        expect(manifest.files).toHaveLength(1);
        expect(existsSync(manifest.files[0].path)).toBe(false);
        expect(await Bun.file(join(publication!.directory, manifest.files[0].id, manifest.files[0].name)).text()).toBe("small fixture video");
      } else {
        const docs = await Promise.all(responses.map(r => r.json()));
        expect(docs[0].id).toBe(docs[1].id); expect(f.store.listFiles(project.id)).toHaveLength(1);
        expect(await Bun.file(docs[0].attachments[0].path).text()).toBe("small fixture video");
      }
    } finally { release(); stage.mockRestore(); }
  }
}, 5000);

test("custom canonical state and provider homes are forbidden including aliases on both APIs", async () => {
  const custom = await folderFixture(undefined, home => {
    const settings: Record<string, string> = {};
    for (const [key, name] of [["IAMCEO_HOME", "state"], ["CLAUDE_CONFIG_DIR", "claude"], ["CODEX_HOME", "codex"]]) {
      const target = join(home, `actual-${name}`); mkdirSync(target);
      const alias = join(home, `configured-${name}`); symlinkSync(target, alias);
      settings[key!] = key === "IAMCEO_HOME" ? target : alias;
    }
    return settings;
  });
  try {
    const project = custom.store.createProject({ name: "custom roots", cwd: custom.home });
    for (const name of ["state", "claude", "codex"]) {
      const target = join(custom.home, `actual-${name}`, "fixture.txt"); writeFileSync(target, "fixture-only token");
      const alias = join(custom.home, `alias-${name}.txt`); symlinkSync(target, alias);
      for (const path of [target, alias, join(custom.home, `configured-${name}`, "fixture.txt")]) {
        expect((await custom.request(`/api/projects/${project.id}/local-file?path=${encodeURIComponent(path)}`)).status).toBe(403);
        expect((await custom.request(`/api/projects/${project.id}/files/from-path`, { path })).status).toBe(403);
      }
    }
  } finally { await custom.close(); }
});

test("representative auth required; archived project refuses writes even duplicates", async () => {
  expect((await f.request(endpoint() + "/local-file?path=대본.md", undefined, false)).status).toBe(401);
  expect((await f.request(endpoint() + "/files/from-path", { path: "대본.md" }, false)).status).toBe(401);
  f.store.patchProject(id, { archived: true });
  expect((await post("대본.md")).status).toBe(404);
  expect((await get("대본.md")).status).toBe(200);
});

test("built-in conductor and worker system prompts require published deliverables and post links", () => {
  for (const kind of ["conductor", "worker"] as const) {
    const rules = renderRole(kind, { PROJECT: "시험", NAME: "직원", ROLE: "개발", CONDUCTOR: "총괄" });
    expect(rules).toContain("반드시 `file` 도구로 자료에 올리고");
    expect(rules).toContain("`post`의 `file_ids`");
    expect(rules).toContain("로컬 파일 경로만 말하고 끝내지 않는다");
    expect(rules).toContain("갱신하거나 새 판");
  }
});
