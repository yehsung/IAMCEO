import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { FilePublication, importPath, MAX_UPLOAD_BYTES, prepareImport, saveUpload, writePublicationManifest, type PublicationManifest } from "../server/files.ts";
import { createStorageReferences, measureStorage, QUARANTINE_GRACE_MS, STAGING_GRACE_MS, StorageMaintenance } from "../server/storage-maintenance.ts";
import { Store } from "../server/store.ts";
import { createIsolatedRuntime, type IsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const fixtures: { runtime: IsolatedRuntime; store: Store }[] = [];
afterEach(async () => {
  for (const { runtime, store } of fixtures.splice(0)) { store.db.close(); await runtime.stop(); }
});

function setup() {
  const runtime = createIsolatedRuntime();
  const home = runtime.paths.iamceoHome;
  const store = new Store(openDb(join(home, "iamceo.db")), new Bus());
  fixtures.push({ runtime, store });
  const uploadsDir = join(home, "uploads");
  const inboxDir = join(home, "inbox");
  const backupDir = join(home, "backups");
  for (const path of [uploadsDir, inboxDir, backupDir]) mkdirSync(path);
  const references = createStorageReferences(store, inboxDir);
  const maintenance = new StorageMaintenance({ uploadsDir, inboxDir, backupDir, references });
  const source = join(runtime.paths.work, "source.png");
  writeFileSync(source, "fixture bytes");
  const manifest = (publication: FilePublication) => JSON.parse(readFileSync(join(publication.directory, "manifest.json"), "utf8")) as PublicationManifest;
  const failed = async () => {
    const publication = new FilePublication(uploadsDir);
    const saved = await publication.stagePath(prepareImport(source));
    publication.fail(references);
    const record = manifest(publication);
    return { publication, saved, record, due: record.failedAt! + STAGING_GRACE_MS };
  };
  return { runtime, home, store, uploadsDir, inboxDir, backupDir, references, maintenance, source, manifest, failed };
}

describe("staging publication", () => {
  test("파일은 staging에만 쓰고 publish 뒤 원래 uploads 형식을 유지한다", async () => {
    const { uploadsDir, source, manifest, references } = setup();
    const publication = new FilePublication(uploadsDir);
    const saved = await publication.stagePath(prepareImport(source));
    expect(existsSync(saved.path)).toBe(false);
    expect(readFileSync(join(publication.directory, saved.id, saved.name), "utf8")).toBe("fixture bytes");
    publication.publish();
    expect(readFileSync(saved.path, "utf8")).toBe("fixture bytes");
    expect(statSync(saved.path).mode & 0o777).toBe(0o600);
    publication.fail(references);
    expect(existsSync(saved.path)).toBe(false);
    expect(manifest(publication).state).toBe("failed");
  });

  test("게시된 attachment는 fail 보상에서도 건드리지 않는다", async () => {
    const { uploadsDir, source, store, references } = setup();
    const publication = new FilePublication(uploadsDir);
    const saved = await publication.stagePath(prepareImport(source));
    publication.publish();
    store.createAttachment(saved);
    publication.fail(references);
    expect(readFileSync(saved.path, "utf8")).toBe("fixture bytes");
  });

  test("검증 뒤 원본 변경은 실패하며 다른 파일을 복사하지 않는다", async () => {
    const { uploadsDir, source, references, manifest } = setup();
    const input = prepareImport(source);
    writeFileSync(source, "changed after validation");
    const publication = new FilePublication(uploadsDir);
    await expect(publication.stagePath(input)).rejects.toThrow("변경");
    expect(() => publication.publish()).toThrow("unfinished");
    expect(() => publication.complete()).toThrow("awaiting commit");
    publication.fail(references);
    expect(manifest(publication).state).toBe("failed");
    expect(existsSync(join(uploadsDir, input.id))).toBe(false);
  });

  test("업로드·importPath 호환, 크기 초과는 staging도 만들지 않는다", async () => {
    const { uploadsDir, source, home } = setup();
    const upload = await saveUpload(uploadsDir, new File(["hello"], "../hello.txt", { type: "text/plain" }));
    expect(upload.name).toBe("hello.txt");
    expect(readFileSync(upload.path, "utf8")).toBe("hello");
    expect(readFileSync((await importPath(uploadsDir, source)).path, "utf8")).toBe("fixture bytes");
    const empty = join(home, "oversized");
    const tooLarge = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "large.bin");
    await expect(saveUpload(empty, tooLarge)).rejects.toThrow("50MB");
    expect(existsSync(empty)).toBe(false);
  });

  test("staging symlink를 따라 쓰지 않는다", () => {
    const { uploadsDir, backupDir } = setup();
    symlinkSync(backupDir, join(uploadsDir, ".staging"));
    expect(() => new FilePublication(uploadsDir)).toThrow("Staging");
    expect(readdirSync(backupDir)).toEqual([]);
  });
});

describe("보수적 저장소 정리", () => {
  test("실패 확정 후 7일과 격리 후 24시간 경계를 각각 지킨다", async () => {
    const { failed, maintenance, uploadsDir } = setup();
    const { publication, record, due } = await failed();
    expect(maintenance.sweep(due - 1).quarantined).toEqual([]);
    expect(maintenance.sweep(due).quarantined).toEqual([record.id]);
    expect(existsSync(publication.directory)).toBe(false);
    const quarantined = join(uploadsDir, ".quarantine", record.id);
    expect(existsSync(quarantined)).toBe(true);
    expect(maintenance.sweep(due + QUARANTINE_GRACE_MS - 1).removed).toEqual([]);
    expect(maintenance.sweep(due + QUARANTINE_GRACE_MS).removed).toEqual([record.id]);
    expect(existsSync(quarantined)).toBe(false);
  });

  test("격리 사이 새 완료 첨부 행이 생기면 미전송 초안으로 보호한다", async () => {
    const { failed, maintenance, store, uploadsDir } = setup();
    const { record, saved, due } = await failed();
    maintenance.sweep(due);
    store.createAttachment(saved);
    const result = maintenance.sweep(due + QUARANTINE_GRACE_MS);
    expect(result.removed).toEqual([]);
    expect(result.retained).toContain(record.id);
    expect(existsSync(join(uploadsDir, ".quarantine", record.id, saved.id, saved.name))).toBe(true);
  });

  test("보관 자료·살아 있는 inbox·미해결 전달은 각각 보호한다", async () => {
    const { failed, store, runtime, inboxDir, maintenance } = setup();
    const project = store.createProject({ name: "보관", cwd: runtime.paths.work });
    const member = store.createMember({ projectId: project.id, name: "직원", handle: "worker", kind: "worker", origin: "manual" });
    const archived = await failed();
    const attachment = { ...archived.saved, url: "/file", isImage: true };
    store.createFile({ projectId: project.id, title: "보관 자료", attachments: [attachment] });
    store.patchProject(project.id, { archived: true });
    const inbox = await failed();
    mkdirSync(join(inboxDir, member.id));
    writeFileSync(join(inboxDir, member.id, `${inbox.saved.id}-${inbox.saved.name}`), "live");
    const delivery = await failed();
    store.enqueue({ projectId: project.id, memberId: member.id, kind: "instruction", text: `첨부: ${delivery.saved.path}`, status: "held", holdReason: "delivery_unknown" });
    const result = maintenance.sweep(Math.max(archived.due, inbox.due, delivery.due));
    expect(result.errors).toEqual([]);
    expect(result.quarantined).toEqual([]);
    expect(result.retained.sort()).toEqual([archived.record.id, inbox.record.id, delivery.record.id].sort());
  });

  test("200개 밖의 오래된 대화 참조도 보관 상태에서 보호한다", async () => {
    const { failed, store, runtime, maintenance } = setup();
    const { saved, due, record } = await failed();
    const project = store.createProject({ name: "오래된 기록", cwd: runtime.paths.work });
    store.createMessage({ projectId: project.id, who: "대표", kind: "나", body: saved.path });
    for (let i = 0; i < 205; i++) store.createMessage({ projectId: project.id, who: "대표", kind: "나", body: `tail ${i}` });
    store.patchProject(project.id, { archived: true });
    expect(maintenance.sweep(due).retained).toContain(record.id);
  });

  test("완료·진행 중·실패 증거 없는 고아 uploads·inbox·백업은 오래되어도 삭제하지 않는다", async () => {
    const { uploadsDir, source, maintenance, inboxDir, backupDir, manifest } = setup();
    const active = new FilePublication(uploadsDir);
    await active.stagePath(prepareImport(source));
    const published = new FilePublication(uploadsDir);
    const saved = await published.stagePath(prepareImport(source));
    published.publish(); published.complete();
    writeFileSync(join(uploadsDir, "orphan.bin"), "orphan");
    writeFileSync(join(inboxDir, "closed-member"), "inbox");
    writeFileSync(join(backupDir, "old.db"), "backup");
    const result = maintenance.sweep(Date.now() + 100 * STAGING_GRACE_MS);
    expect(result.removed).toEqual([]);
    expect(result.retained.sort()).toEqual([manifest(active).id, manifest(published).id].sort());
    expect(existsSync(saved.path)).toBe(true);
    expect(readFileSync(join(uploadsDir, "orphan.bin"), "utf8")).toBe("orphan");
    expect(readFileSync(join(inboxDir, "closed-member"), "utf8")).toBe("inbox");
    expect(readFileSync(join(backupDir, "old.db"), "utf8")).toBe("backup");
  });

  test("사용량은 uploads·inbox·백업과 격리 보존량을 집계하고 symlink를 따르지 않는다", async () => {
    const { failed, maintenance, uploadsDir, inboxDir, backupDir } = setup();
    const { due } = await failed();
    writeFileSync(join(inboxDir, "copy"), "123");
    writeFileSync(join(backupDir, "backup.db"), "12345");
    symlinkSync(backupDir, join(uploadsDir, "link"));
    let usage = maintenance.usage();
    expect(usage.inbox).toEqual({ bytes: 3, files: 1, symlinks: 0 });
    expect(usage.backups).toEqual({ bytes: 5, files: 1, symlinks: 0 });
    expect(usage.uploads.symlinks).toBe(1);
    expect(usage.staging.bytes).toBeGreaterThan(13);
    maintenance.sweep(due);
    usage = maintenance.usage();
    expect(usage.staging.bytes).toBe(0);
    expect(usage.quarantine.bytes).toBeGreaterThan(13);
    expect(measureStorage(join(uploadsDir, "missing"))).toEqual({ bytes: 0, files: 0, symlinks: 0 });
  });

  test("참조 조회 실패·경로 변조·symlink·hardlink는 정리하지 않는다", async () => {
    const { failed, maintenance, references, backupDir } = setup();
    const a = await failed();
    const probe = spyOn(references, "isReferenced").mockImplementation(() => { throw new Error("DB read failed"); });
    try { expect(maintenance.sweep(a.due).errors).toContain(a.record.id); }
    finally { probe.mockRestore(); }
    const b = await failed();
    writePublicationManifest(b.publication.directory, { ...b.record, files: [{ ...b.saved, path: join(backupDir, "escape") }] });
    const c = await failed();
    symlinkSync(backupDir, join(c.publication.directory, c.saved.id, "escape"));
    const d = await failed();
    linkSync(join(d.publication.directory, d.saved.id, d.saved.name), join(backupDir, "hardlink"));
    const result = maintenance.sweep(Math.max(a.due, b.due, c.due, d.due));
    expect(result.quarantined).toEqual([a.record.id]);
    expect(result.errors.sort()).toEqual([b.record.id, c.record.id, d.record.id].sort());
    expect(readFileSync(join(backupDir, "hardlink"), "utf8")).toBe("fixture bytes");
  });
});
