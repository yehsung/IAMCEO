// Firebase 함수 하나(relay). 배포: README.md. 값(지역·인스턴스·한도)은 settings.ts 한 곳에 있다.
//
// 비밀(Secret Manager, 대표가 `firebase functions:secrets:set` 으로 직접 넣는다. 코드·저장소·로그에 나오지 않는다):
//   RELAY_MASTER  설치 자격을 서명하는 무작위 값(32자 이상)
//   APNS_KEY_P8   IAMCEO 전용 APNs 키(.p8, Topic Specific·Production·com.yehsung.iamceo)
// 설정(functions/.env, 저장소에 올리지 않는다. 예시는 .env.example):
//   APNS_KEY_ID, APNS_TEAM_ID, RELAY_MODE(open|allowlist|off), RELAY_ALLOWED_INSTALLATIONS, RELAY_BLOCKED_INSTALLATIONS
//
// 비밀 값은 함수가 실행될 때만 읽는다(배포할 때 코드를 불러 살펴보므로 바깥 범위에서 읽으면 배포가 실패한다).
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret, defineString } from "firebase-functions/params";
import { RelayAPNs, apnsCredential } from "./apns-sender.ts";
import { nodeHandler } from "./http-adapter.ts";
import { createRelay } from "./relay.ts";
import type { LogEntry } from "./relay.ts";
import { RELAY_REGION, RELAY_RUNTIME } from "./settings.ts";

const RELAY_MASTER = defineSecret("RELAY_MASTER");
const APNS_KEY_P8 = defineSecret("APNS_KEY_P8");
const APNS_KEY_ID = defineString("APNS_KEY_ID", { description: "IAMCEO 전용 APNs 키의 Key ID(10자). IAMCEO APNs key ID (10 characters)." });
const APNS_TEAM_ID = defineString("APNS_TEAM_ID", { description: "Apple 개발자 Team ID(10자). Apple developer Team ID (10 characters)." });
const RELAY_MODE = defineString("RELAY_MODE", { default: "allowlist",
  description: "open(누구나) | allowlist(허용 설치만) | off(전체 정지). open | allowlist | off." });
const RELAY_ALLOWED_INSTALLATIONS = defineString("RELAY_ALLOWED_INSTALLATIONS", { default: "",
  description: "allowlist 일 때 받는 설치 ID(쉼표). Installation IDs accepted in allowlist mode (comma-separated)." });
const RELAY_BLOCKED_INSTALLATIONS = defineString("RELAY_BLOCKED_INSTALLATIONS", { default: "",
  description: "막을 설치 ID(쉼표). Installation IDs to block (comma-separated)." });

/** Cloud Logging 이 읽는 구조화 한 줄(severity·message). 토큰·IP·본문은 이 함수에 오지 않는다. */
function writeLog(entry: LogEntry): void {
  try { process.stdout.write(`${JSON.stringify(entry)}\n`); } catch { /* 로그를 못 써도 요청은 계속 */ }
}

let handler: ReturnType<typeof nodeHandler> | undefined;
function instance(): ReturnType<typeof nodeHandler> {
  if (handler) return handler;
  const apns = new RelayAPNs({
    credential: () => apnsCredential({ keyId: APNS_KEY_ID.value(), teamId: APNS_TEAM_ID.value(), privateKey: APNS_KEY_P8.value() }),
    onSuspend: (reason, until) => writeLog({ severity: "ERROR", message: "apns_suspended", reason, until: new Date(until).toISOString() }),
  });
  const relay = createRelay({
    apns, log: writeLog,
    settings: () => ({ master: RELAY_MASTER.value(), mode: RELAY_MODE.value(),
      allowed: RELAY_ALLOWED_INSTALLATIONS.value(), blocked: RELAY_BLOCKED_INSTALLATIONS.value() }),
  });
  handler = nodeHandler(relay);
  return handler;
}

/** 이름 relay = Cloud Run 서비스 이름(settings.ts 의 RELAY_FUNCTION_NAME). */
export const relay = onRequest({
  region: RELAY_REGION,
  ...RELAY_RUNTIME,
  secrets: [RELAY_MASTER, APNS_KEY_P8],
  invoker: "public",
}, (request, response) => instance()(request, response));
