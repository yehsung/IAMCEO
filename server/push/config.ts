import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { DEFAULT_PUSH_BUNDLE_ID } from "../../shared/push.ts";
import type { PushEnvironment, PushProviderStatus } from "../../shared/push.ts";

/** Internal credentials only. Never include this object in API/status responses. */
export interface APNsCredential {
  readonly environment: PushEnvironment;
  readonly keyId: string;
  readonly teamId: string;
  readonly bundleId: string;
  readonly key: KeyObject;
  readonly cacheKey: string;
}
export interface APNsConfig {
  credentials: Partial<Record<PushEnvironment, APNsCredential>>;
  providers: PushProviderStatus[];
}

function readSecret(path: string, maxBytes: number): string {
  // Check the opened inode, not just a path that could be replaced before read.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid()) || stat.size > maxBytes) throw new Error("key_unreadable");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function credential(environment: PushEnvironment, value: unknown): APNsCredential {
  if (!object(value) || Object.keys(value).some((key) => !["keyId", "teamId", "bundleId", "privateKeyPath"].includes(key)) ||
      typeof value.keyId !== "string" || !/^[A-Z0-9]{10}$/.test(value.keyId) ||
      typeof value.teamId !== "string" || !/^[A-Z0-9]{10}$/.test(value.teamId) ||
      typeof value.bundleId !== "string" || value.bundleId.length > 255 ||
      !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value.bundleId) ||
      typeof value.privateKeyPath !== "string" || !isAbsolute(value.privateKeyPath)) throw new Error("invalid_key");
  let pem: string;
  try {
    const directory = lstatSync(dirname(value.privateKeyPath));
    if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 ||
        (process.getuid && directory.uid !== process.getuid())) throw new Error("key_unreadable");
    pem = readSecret(value.privateKeyPath, 16_384);
  } catch { throw new Error("key_unreadable"); }
  try {
    if (!/^\s*-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PRIVATE KEY-----\s*$/.test(pem)) throw new Error();
    const key = createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error();
    const fingerprint = createHash("sha256").update(createPublicKey(key).export({ type: "spki", format: "der" })).digest("hex");
    return Object.freeze({ environment, keyId: value.keyId, teamId: value.teamId, bundleId: value.bundleId, key,
      cacheKey: [environment, value.teamId, value.keyId, value.bundleId, fingerprint].join(":") });
  } catch { throw new Error("invalid_key"); }
}

/** Explicit home required; no import-time reads or fallback to the user's home. */
export function loadAPNsConfig(home: string): APNsConfig {
  const credentials: APNsConfig["credentials"] = {};
  const providers: PushProviderStatus[] = ["sandbox", "production"].map((environment) => ({
    environment: environment as PushEnvironment, bundleId: DEFAULT_PUSH_BUNDLE_ID, state: "unconfigured", lastError: null,
  }));
  let parsed: unknown;
  try {
    if (!isAbsolute(home)) throw new Error("invalid_key");
    parsed = JSON.parse(readSecret(join(home, "apns.json"), 16_384));
    if (!object(parsed) || Object.keys(parsed).some((key) => key !== "sandbox" && key !== "production")) throw new Error("invalid_key");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { credentials, providers };
    for (const provider of providers) {
      provider.state = "configuration_error";
      provider.lastError = error instanceof SyntaxError || (error as Error).message === "invalid_key" ? "invalid_key" : "key_unreadable";
    }
    return { credentials, providers };
  }
  for (const provider of providers) {
    if (!Object.hasOwn(parsed as object, provider.environment)) continue;
    try {
      const entry = credential(provider.environment, (parsed as Record<string, unknown>)[provider.environment]);
      credentials[provider.environment] = entry;
      provider.bundleId = entry.bundleId;
      provider.state = "ready";
    } catch (error) {
      provider.state = "configuration_error";
      provider.lastError = (error as Error).message === "key_unreadable" ? "key_unreadable" : "invalid_key";
    }
  }
  return { credentials, providers };
}
