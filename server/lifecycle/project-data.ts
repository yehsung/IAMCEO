// 프로젝트 단위 내보내기(zip 한 개)와 지운 프로젝트의 디스크 정리.
// 내보내기에는 대화·결재·할 일·업무·자료와 첨부 원본이 들어간다. 접속 코드·팀장 열쇠·전달 내부 기록은 넣지 않는다.
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import type { Config } from "../config.ts";
import { VERSION } from "../config.ts";
import { resolveInside } from "../files.ts";
import { ApiError, type Store } from "../store.ts";

const MAX_ZIP_BYTES = 0xffff_fff0;
const MAX_ENTRIES = 0xfff0;
const CHUNK = 1024 * 1024;

function dosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * 저장(무압축) 방식의 zip 을 파일에 바로 쓴다. 항목 하나를 조각조각 흘려 쓰고, 다 쓴 뒤 머리의 CRC·크기를 제자리에 고쳐 쓴다.
 * 큰 첨부도 메모리에 통째로 올리지 않는다. 4GB·65,000 항목을 넘으면 거절한다(ZIP64 를 쓰지 않는다).
 */
export class ZipWriter {
  private offset = 0;
  private readonly entries: { name: Buffer; crc: number; size: number; offset: number; time: number; date: number }[] = [];
  private closed = false;
  constructor(private readonly fd: number, private readonly yieldEvery: () => Promise<void> = () => new Promise(resolve => setImmediate(resolve))) {}

  private write(bytes: Uint8Array, position?: number): void {
    let done = 0;
    while (done < bytes.length) {
      const written = writeSync(this.fd, bytes, done, bytes.length - done, position === undefined ? null : position + done);
      if (!written) throw new Error("zip short write");
      done += written;
    }
    if (position === undefined) this.offset += bytes.length;
  }

  private ensureRoom(extra: number): void {
    if (this.offset + extra > MAX_ZIP_BYTES || this.entries.length >= MAX_ENTRIES) throw new ApiError(413, "내보낼 자료가 너무 큽니다(4GB 또는 65,000개 초과)", "export_too_large");
  }

  async add(name: string, chunks: Iterable<Uint8Array | string> | AsyncIterable<Uint8Array | string>, modified: Date = new Date()): Promise<void> {
    if (this.closed) throw new Error("zip already finished");
    const encoded = Buffer.from(name, "utf8");
    if (!name || name.startsWith("/") || name.split("/").some(part => part === ".." || part === "") || encoded.length > 0xffff) throw new Error("invalid zip entry name");
    this.ensureRoom(30 + encoded.length);
    const stamp = dosTime(modified), start = this.offset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // 이름이 UTF-8
    header.writeUInt16LE(0, 8); // 저장(무압축)
    header.writeUInt16LE(stamp.time, 10);
    header.writeUInt16LE(stamp.date, 12);
    header.writeUInt16LE(encoded.length, 26);
    this.write(header);
    this.write(encoded);
    let crc = 0, size = 0, sinceYield = 0;
    for await (const chunk of chunks as AsyncIterable<Uint8Array | string>) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      if (!bytes.length) continue;
      this.ensureRoom(bytes.length);
      crc = crc32(bytes, crc);
      size += bytes.length;
      this.write(bytes);
      sinceYield += bytes.length;
      // 서버 한가운데서 돈다. 몇 MB 마다 이벤트 루프를 놓아 다른 요청을 막지 않는다.
      if (sinceYield >= 4 * CHUNK) { sinceYield = 0; await this.yieldEvery(); }
    }
    const patch = Buffer.alloc(12);
    patch.writeUInt32LE(crc >>> 0, 0);
    patch.writeUInt32LE(size, 4);
    patch.writeUInt32LE(size, 8);
    this.write(patch, start + 14);
    this.entries.push({ name: encoded, crc: crc >>> 0, size, offset: start, ...stamp });
  }

  finish(): void {
    if (this.closed) return;
    const directory = this.offset;
    for (const entry of this.entries) {
      this.ensureRoom(46 + entry.name.length);
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(0x031e, 4); // 만든 쪽: Unix, 3.0
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x0800, 8);
      record.writeUInt16LE(0, 10);
      record.writeUInt16LE(entry.time, 12);
      record.writeUInt16LE(entry.date, 14);
      record.writeUInt32LE(entry.crc, 16);
      record.writeUInt32LE(entry.size, 20);
      record.writeUInt32LE(entry.size, 24);
      record.writeUInt16LE(entry.name.length, 28);
      record.writeUInt32LE((0o100600 << 16) >>> 0, 38); // 일반 파일 0600
      record.writeUInt32LE(entry.offset, 42);
      this.write(record);
      this.write(entry.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - directory, 12);
    end.writeUInt32LE(directory, 16);
    this.write(end);
    this.closed = true;
  }

  get size(): number { return this.offset; }
}

function* fileChunks(path: string): Generator<Uint8Array> {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) return;
    const buffer = Buffer.alloc(CHUNK);
    for (let count; (count = readSync(fd, buffer, 0, buffer.length, null)) > 0;) yield Buffer.from(buffer.subarray(0, count));
  } finally { closeSync(fd); }
}

/** JSON 배열을 원소 단위로 흘려 쓴다. */
function* jsonArray<T>(batches: Iterable<T[]>): Generator<string> {
  yield "[";
  let first = true;
  for (const batch of batches) for (const item of batch) {
    yield `${first ? "\n" : ",\n"}${JSON.stringify(item)}`;
    first = false;
  }
  yield first ? "]\n" : "\n]\n";
}

/** zip 안에서 안전한 파일 이름: 경로 구분자·제어 문자·앞의 점을 바꾸고 길이를 줄인다. */
export function safeEntryName(name: string): string {
  const cleaned = name.normalize("NFC").replace(/[\u0000-\u001f\u007f/\\:]/g, "_").replace(/^\.+/, "_").trim();
  return (cleaned || "file").slice(0, 120);
}

const README = `IAMCEO 프로젝트 내보내기 / IAMCEO project export

project.json    프로젝트 정보 / project
members.json    총괄·팀장 명부(접속 열쇠는 없음) / sessions (no credentials)
messages.json   대화 전체, 오래된 것부터 / every message, oldest first
decisions.json  결재 / decisions
todos.json      대표 할 일 / owner to-dos
work.json       진행판 / work board
files.json      자료(본문·아티팩트 HTML 포함) / files with their text and artifact HTML
attachments/    첨부 원본 / original attachments
manifest.json   개수와 첨부 목록 / counts and the attachment list
`;

export interface ProjectExport { stream: ReadableStream<Uint8Array>; size: number; filename: string }

/**
 * 프로젝트를 zip 하나로 만든다. 데이터 폴더의 exports/ 에 0600 임시 파일로 쓴 뒤 열어 두고 바로 지운다:
 * 응답이 끝나거나 끊기면 파일이 저절로 사라지고, 서버가 도중에 꺼져도 다음 내보내기가 남은 것을 치운다.
 */
export async function exportProjectZip(store: Store, config: Pick<Config, "home" | "uploadsDir">, projectId: string, now: Date = new Date()): Promise<ProjectExport> {
  const data = store.projectExport(projectId);
  const dir = join(config.home, "exports");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(dir)) {
    if (!/^\.export-[0-9a-f-]{36}\.zip$/.test(name)) continue;
    try { if (Date.now() - lstatSync(join(dir, name)).mtimeMs > 3_600_000) unlinkSync(join(dir, name)); } catch { /* 다음에 */ }
  }
  const path = join(dir, `.export-${randomUUID()}.zip`);
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let handedOff = false;
  try {
    const zip = new ZipWriter(fd);
    const attachments = new Map<string, { id: string; name: string; mime: string; size: number; path: string }>();
    const note = (list: unknown) => {
      if (!Array.isArray(list)) return;
      for (const item of list) {
        const id = typeof item === "string" ? item : item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id : null;
        if (!id || attachments.has(id)) continue;
        const row = store.getAttachment(id);
        if (row) attachments.set(id, { id, name: row.name, mime: row.mime, size: row.size, path: row.path });
      }
    };
    for (const file of data.files) note(file.attachments);
    for (const decision of data.decisions) note((decision as { images?: unknown }).images);
    for (const todo of data.todos) note((todo as { completionFileIds?: unknown }).completionFileIds);
    const project = { ...data.project, exportedAt: now.toISOString() };
    await zip.add("README.txt", [README], now);
    await zip.add("project.json", [JSON.stringify(project, null, 2) + "\n"], now);
    await zip.add("members.json", jsonArray([data.members]), now);
    // 대화는 흘려 쓰면서 첨부를 모은다.
    let messageCount = 0;
    const messages = function* () { for (const batch of data.messages()) { for (const message of batch) note(message.attachments); messageCount += batch.length; yield batch; } };
    await zip.add("messages.json", jsonArray(messages()), now);
    await zip.add("decisions.json", jsonArray([data.decisions]), now);
    await zip.add("todos.json", jsonArray([data.todos]), now);
    await zip.add("work.json", jsonArray([data.work]), now);
    await zip.add("files.json", jsonArray([data.files]), now);
    const included: { id: string; name: string; mime: string; size: number; path: string }[] = [];
    const missing: string[] = [];
    for (const attachment of attachments.values()) {
      const source = resolveInside(config.uploadsDir, attachment.path);
      if (!source || !existsSync(source) || !statSync(source).isFile()) { missing.push(attachment.id); continue; }
      const entry = `attachments/${safeEntryName(attachment.id)}-${safeEntryName(attachment.name)}`;
      await zip.add(entry, fileChunks(source), now);
      included.push({ ...attachment, path: entry });
    }
    const manifest = {
      format: 1, exportedAt: now.toISOString(), appVersion: VERSION, project: { id: data.project.id, name: data.project.name, archived: data.project.archived },
      counts: { messages: messageCount, decisions: data.decisions.length, todos: data.todos.length, work: data.work.length, files: data.files.length, attachments: included.length },
      attachments: included, missingAttachments: missing,
    };
    await zip.add("manifest.json", [JSON.stringify(manifest, null, 2) + "\n"], now);
    zip.finish();
    // 열어 둔 채 이름을 지운다. 이제 이 응답만 읽을 수 있다.
    unlinkSync(path);
    const size = zip.size;
    let position = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const buffer = Buffer.alloc(Math.min(CHUNK, size - position));
        const count = buffer.length ? readSync(fd, buffer, 0, buffer.length, position) : 0;
        if (count <= 0) { controller.close(); try { closeSync(fd); } catch { /* 이미 닫힘 */ } return; }
        position += count;
        controller.enqueue(buffer.subarray(0, count));
      },
      cancel() { try { closeSync(fd); } catch { /* 이미 닫힘 */ } },
    });
    handedOff = true;
    const day = now.toISOString().slice(0, 10);
    return { stream, size, filename: `IAMCEO-${safeEntryName(data.project.name).replace(/\s+/g, "-")}-${day}.zip` };
  } finally {
    if (!handedOff) {
      try { closeSync(fd); } catch { /* 이미 닫힘 */ }
      try { unlinkSync(path); } catch { /* 이미 지움 */ }
    }
  }
}

/** 지운 프로젝트의 디스크 자취: 다른 곳이 가리키지 않는 첨부 파일, 팀장에게 건넨 파일함, 세션 설정(토큰이 든 MCP 설정 포함). */
export function removeDeletedProjectFiles(config: Pick<Config, "home" | "uploadsDir" | "inboxDir">, deleted: { memberIds: string[]; attachments: { id: string; path: string }[] }): { attachments: number; failed: number } {
  let attachments = 0, failed = 0;
  for (const attachment of deleted.attachments) {
    const path = resolveInside(config.uploadsDir, attachment.path);
    if (!path) continue;
    try {
      if (existsSync(path) && lstatSync(path).isFile()) { unlinkSync(path); attachments++; }
    } catch { failed++; }
  }
  const run = join(config.home, "run");
  const runFiles = existsSync(run) ? readdirSync(run) : [];
  for (const memberId of deleted.memberIds) {
    if (!/^[A-Za-z0-9_-]+$/.test(memberId)) continue;
    const inbox = join(config.inboxDir, memberId);
    try {
      if (existsSync(inbox) && lstatSync(inbox).isDirectory() && !lstatSync(inbox).isSymbolicLink()) rmSync(inbox, { recursive: true });
    } catch { failed++; }
    for (const name of runFiles) {
      if (!name.startsWith(`${memberId}.`)) continue;
      try { if (lstatSync(join(run, name)).isFile()) unlinkSync(join(run, name)); } catch { failed++; }
    }
  }
  return { attachments, failed };
}
