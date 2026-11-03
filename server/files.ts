import { copyFileSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, extname, join, sep } from "node:path";
import { newId } from "./db.ts";
import { cleanText } from "./text.ts";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** 아티팩트(자체 완결 HTML) 한 장의 상한. 화면이 통째로 받아 격리 칸에 넣는다. */
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

export interface SavedFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  path: string;
}

const MAX_NAME_BYTES = 180;
const encoder = new TextEncoder();

function truncateToBytes(s: string, max: number): string {
  let out = "";
  let used = 0;
  for (const ch of s) {
    used += encoder.encode(ch).length;
    if (used > max) break;
    out += ch;
  }
  return out;
}

/**
 * 사용자·에이전트가 준 이름에서 경로와 위험한 글자를 없앤다. 맥의 NFD 한글도 NFC 로 맞춘다.
 * 이름은 전달 글의 `첨부:` 줄에 그대로 들어간다. 메일로 받은 파일의 이름을 정한 외부인이 줄을 끊거나 `[대표 직접]` 을 지어내지 못하게 한다.
 */
export function sanitizeName(raw: string): string {
  const base = cleanText(raw).normalize("NFC").split(/[/\\]/).pop() ?? "";
  const clean = base
    .replace(/[\u0000-\u001f\u007f<>:"|?*\[\]'`]/g, "")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  if (!clean) return "file";
  const ext = extname(clean);
  if (encoder.encode(clean).length <= MAX_NAME_BYTES) return clean;
  const stem = clean.slice(0, clean.length - ext.length);
  const keptExt = encoder.encode(ext).length <= 20 ? ext : "";
  return truncateToBytes(stem, MAX_NAME_BYTES - encoder.encode(keptExt).length) + keptExt;
}

/** target 이 base 안에 실제로 있을 때만(심볼릭 링크를 따라간 뒤) 진짜 경로를 돌려준다. */
export function resolveInside(base: string, target: string): string | null {
  try {
    const realBase = realpathSync(base);
    const real = realpathSync(target);
    return real.startsWith(realBase + sep) ? real : null;
  } catch {
    return null;
  }
}

function guessMime(name: string, given?: string): string {
  const type = given?.split(";")[0]?.trim();
  if (type && type !== "application/octet-stream") return type;
  return Bun.file(name).type.split(";")[0] || "application/octet-stream";
}

function isHeic(name: string, mime: string): boolean {
  return /^image\/hei[cf]/.test(mime) || /\.hei[cf]$/i.test(name);
}

/** 맥에서만 된다. 실패하면 null(원본을 그대로 쓴다). */
async function heicToJpeg(src: string, dest: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    const proc = Bun.spawn(["sips", "-s", "format", "jpeg", src, "--out", dest], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0 && statSync(dest).size > 0;
  } catch {
    return false;
  }
}

async function finish(id: string, dir: string, name: string, mime: string): Promise<SavedFile> {
  const path = join(dir, name);
  if (isHeic(name, mime)) {
    const jpegName = `${basename(name, extname(name)) || "image"}.jpg`;
    const jpegPath = join(dir, jpegName);
    if (await heicToJpeg(path, jpegPath)) {
      rmSync(path, { force: true });
      return { id, name: jpegName, mime: "image/jpeg", size: statSync(jpegPath).size, path: jpegPath };
    }
  }
  return { id, name, mime, size: statSync(path).size, path };
}

function makeSlot(uploadsDir: string): { id: string; dir: string } {
  const id = newId("a_");
  const dir = join(uploadsDir, id);
  mkdirSync(dir, { recursive: true });
  return { id, dir };
}

/** 받은 파일을 uploads/<id>/<이름> 에 저장한다. 결과를 store.createAttachment 에 넘긴다. */
export async function saveUpload(uploadsDir: string, file: File): Promise<SavedFile> {
  const { id, dir } = makeSlot(uploadsDir);
  const name = sanitizeName(file.name);
  await Bun.write(join(dir, name), file);
  return finish(id, dir, name, guessMime(name, file.type));
}

/** 디스크의 파일(에이전트의 file 도구 등)을 uploads 로 복사한다. 원본이 없으면 예외. */
export async function importPath(uploadsDir: string, srcPath: string, name?: string): Promise<SavedFile> {
  if (!statSync(srcPath).isFile()) throw new Error(`파일이 아닙니다: ${srcPath}`);
  const { id, dir } = makeSlot(uploadsDir);
  const safe = sanitizeName(name ?? basename(srcPath));
  copyFileSync(srcPath, join(dir, safe));
  return finish(id, dir, safe, guessMime(safe));
}
