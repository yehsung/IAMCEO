import { readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { ApiError } from "./store.ts";

// The employee tools and local-file API share this policy. Roots come from actual
// configuration as well as defaults; aliases must not hide relocated credentials.
export const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".claude", ".config", ".kube", ".docker", ".codex", ".gemini", ".iamceo", ".appstoreconnect", "Library"];
// File rules apply only to the basename. Keep HEAD's credential names narrow:
// ordinary history/, id_generator/ and credentials-ui/ projects are valid.
const SECRET_FILE = /^(\.env(\..*)?|\.netrc|\.npmrc|\.pgpass|\.git-credentials|\.claude\.json|\.[a-z]*_history|\.history|\.node_repl_history|fish_history|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|id_(ecdsa|ed25519)_sk(\.pub)?|iamceo\.db.*|\.?credentials(\.json)?|.*\.(pem|p8|key|p12|pfx|keychain|keychain-db))$/i;
const SHELL_HISTORY = /^(\.[a-z]*_history|\.history|\.node_repl_history|fish_history)$/i;
const HOME_SECRET_FILES = [".netrc", ".npmrc", ".pgpass", ".git-credentials", ".claude.json"];
export function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}
export function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch {
    const full = resolve(path), parent = dirname(full);
    return parent === full ? full : join(canonicalPath(parent), full.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
  }
}
export interface SecretPathConfig { home?: string; claudeHome?: string; codexHome?: string }
export function configuredSecretRoots(config: SecretPathConfig, env: NodeJS.ProcessEnv = process.env, userHome = homedir()): string[] {
  const roots = new Set<string>();
  for (const path of [config.home, config.claudeHome, config.codexHome, env.IAMCEO_HOME, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME]) {
    if (path) { roots.add(resolve(path)); roots.add(canonicalPath(path)); }
  }
  // A default secret directory/file can itself be a symlink to a neutral name.
  // Protect its lexical spelling and existing real target on every check.
  let histories: string[] = [];
  try { histories = readdirSync(userHome).filter(name => SHELL_HISTORY.test(name)); } catch { /* home may not exist yet */ }
  for (const name of [...SECRET_DIRS, ...HOME_SECRET_FILES, ...histories]) {
    const path = resolve(userHome, name);
    roots.add(path);
    try { roots.add(realpathSync(path)); } catch { /* absent defaults have no target */ }
  }
  return [...roots];
}
export function isSecretPath(path: string, home: string, protectedRoots: readonly string[] = [], homeDot = false): boolean {
  // Case folding matches credential names on case-insensitive macOS volumes too.
  const folded = path.toLowerCase(), foldedHome = home.toLowerCase();
  if (protectedRoots.some(root => isInside(folded, root.toLowerCase()))) return true;
  if (SECRET_DIRS.some(dir => isInside(folded, join(foldedHome, dir.toLowerCase())))) return true;
  if (homeDot && isInside(folded, foldedHome) && folded.slice(foldedHome.length + 1).startsWith(".")) return true;
  // SECRET_DIRS are protected home locations, not names forbidden throughout
  // projects: project/.claude worktrees and artifacts must remain readable.
  return SECRET_FILE.test(basename(path));
}

export function rejectHardLink(stat: { isFile(): boolean; nlink: number }): void {
  if (stat.isFile() && stat.nlink > 1) throw new ApiError(403, "다른 이름으로 연결된 파일(하드 링크)은 열지 않습니다", "local_file_hard_link");
}
