import { existsSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SECRET_DIRS } from "../../server/secret-paths.ts";

// Enumerate every alternative of HEAD 296570c's SECRET_FILE, including all SSH
// key types and public-key forms. These expectations do not reuse its regex.
export const headSecretFiles = [
  ".env", ".env.", ".env.local", ".env.production.local", ".ENV.LOCAL",
  ".netrc", ".npmrc", ".pgpass", ".git-credentials", ".claude.json",
  "._history", ".bash_history", ".zsh_history", ".python_history", ".MYSQL_HISTORY",
  "id_rsa", "id_rsa.pub", "id_dsa", "id_dsa.pub", "id_ecdsa", "id_ecdsa.pub", "id_ed25519", "id_ed25519.pub",
  "deploy.pem", "deploy.key", "deploy.p12", "deploy.pfx", "DEPLOY.PEM",
];
export const additionalSecretFiles = [
  ".history", ".node_repl_history", "fish_history", "deploy.p8",
  "id_ecdsa_sk", "id_ecdsa_sk.pub", "id_ed25519_sk", "id_ed25519_sk.pub",
  "iamceo.db", "iamceo.db-wal", "iamceo.db-shm",
  "credentials", ".credentials", "credentials.json", ".credentials.json",
  "login.keychain", "login.keychain-db",
];
export const allowedProjectFiles = [
  "history/report.md", "id_generator/report.md", "credentials-ui/report.md",
  "names/history", "names/id_generator", "names/credentials-ui", "myCredentials.json", "id_rsa_notes.md",
  ".envrc", ".environment", "login.keychain-backup",
  "basename-only/.env/report.md", "basename-only/id_rsa/report.md", "basename-only/credentials/report.md",
  "basename-only/credentials.json/report.md", "basename-only/deploy.pem/report.md", "basename-only/.bash_history/report.md",
  "folders/.aws-ui/report.md", "folders/LibraryNotes/report.md",
];
export const projectArtifactFiles = [
  ".claude/mj-mocks-20261103/screen.png", ".claude/worktrees/w1/docs/report.md", ".claude/acc-drafts-r1/draft.md",
  "Library/notes.md", ".config/app.json", ".docker/compose-notes.md", ".aws/readme.md",
];
export const nestedSecretFiles = [".claude/x/.env", ".claude/x/id_rsa", ".claude/x/credentials.json", ".claude/x/deploy.pem"];
export const homeSecretPaths = [".claude/mocks/a.png", ".config/app.json", "Library/notes.md"];
export const fixturePNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");

/** Each default location itself is a link, rather than just a link inside it. */
export function relocatedSecretPaths(home: string, work: string): string[] {
  const paths: string[] = [];
  for (const [index, name] of SECRET_DIRS.entries()) {
    const target = join(home, ({ ".docker": "docker-state", ".aws": "vault", ".kube": "cluster-state" } as Record<string, string>)[name] ?? `neutral-dir-${index}`);
    const lexical = join(home, name);
    // macOS/Bun may already have made Library in this temporary HOME.
    if (existsSync(lexical)) renameSync(lexical, target);
    mkdirSync(target, { recursive: true });
    const file = join(target, "config.txt"); writeFileSync(file, "fixture-only secret");
    symlinkSync(target, lexical);
    const alias = join(work, `alias-dir-${index}.txt`); symlinkSync(file, alias);
    paths.push(file, alias, join(lexical, "config.txt"));
  }
  for (const [index, name] of [".netrc", ".npmrc", ".pgpass", ".git-credentials", ".claude.json", ".bash_history", ".zsh_history", ".python_history", ".history", ".node_repl_history", "fish_history", ".custom_history"].entries()) {
    const file = join(home, "secrets", name === ".netrc" ? "netrc-real" : `neutral-file-${index}`);
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "fixture-only secret");
    const lexical = join(home, name); symlinkSync(file, lexical);
    const alias = join(work, `alias-file-${index}.txt`); symlinkSync(file, alias);
    paths.push(file, alias, lexical);
  }
  return paths;
}
