import type { PushPreferences } from "../../shared/push.ts";

// Compatibility exports; shared/push.ts owns the wire contract for every client.
export { DEFAULT_PUSH_PREFERENCES, PUSH_KINDS } from "../../shared/push.ts";
export type { PatchPushDeviceRequest, PushDevice, PushEventTarget, PushEventTargetResult, PushKind, PushPayload, PushPreferences } from "../../shared/push.ts";

/** Missing new preferences on existing devices are OFF; never infer renewed consent. */
export function storedPushPreferences(json: string): PushPreferences {
  return { todo_created: false, report_blocked: false, ...JSON.parse(json) };
}
