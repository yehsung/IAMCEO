import { DEFAULT_PUSH_PREFERENCES, type PushPreferences } from "../../shared/push.ts";

// Compatibility exports; shared/push.ts owns the wire contract for every client.
export { DEFAULT_PUSH_PREFERENCES, PUSH_KINDS } from "../../shared/push.ts";
export type { PatchPushDeviceRequest, PushDevice, PushEventTarget, PushEventTargetResult, PushKind, PushPayload, PushPreferences } from "../../shared/push.ts";

/**
 * A kind missing from a device's stored preferences follows that kind's default, the same default the app shows for a new
 * device (shared/push.ts DEFAULT_PUSH_PREFERENCES; native PushPreferences: every kind true). 0.2.7 묶음 1(점검 D4-4): before, a
 * device registered before `todo_created`·`report_blocked` existed read the missing keys as OFF, so those two kinds never
 * reached the owner's iPhone (80 events) although the app's default is ON and the owner never turned them off. The overall
 * opt-in (`enabled`) is unchanged and a kind the owner switched off stays off (it is stored as false).
 */
export function storedPushPreferences(json: string): PushPreferences {
  return { ...DEFAULT_PUSH_PREFERENCES, ...JSON.parse(json) };
}
