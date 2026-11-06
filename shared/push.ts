// APNs 전용 계약. Settings/Bootstrap/WsEvent 및 v1 응답을 확장하지 않는다.
export const PUSH_KINDS = ["decision", "approval_wait", "error", "report_complete"] as const;
/** 자유 답변 ask도 decision 사건 하나이며 질문 메시지는 별도 사건을 만들지 않는다. */
export type PushKind = (typeof PUSH_KINDS)[number];
export type PushPreferences = Record<PushKind, boolean>;
/** 종류 기본값과 전체 opt-in은 별개다. 새 기기의 enabled는 false다. */
export const DEFAULT_PUSH_PREFERENCES: Readonly<PushPreferences> = Object.freeze({
  decision: true,
  approval_wait: true,
  error: true,
  report_complete: true,
});
export const DEFAULT_PUSH_BUNDLE_ID = "com.yehsung.iamceo";
export const PUSH_REPORT_GROUP_WINDOW_MS = 120_000;

export type PushEnvironment = "sandbox" | "production";
export type PushAuthorization = "authorized" | "provisional" | "ephemeral" | "denied" | "notDetermined";
export type PushDeviceState = "active" | "revoked" | "invalid" | "expired";
/** 응답 DTO에는 deviceToken/registrationGeneration/키 설정을 노출하지 않는다. */
export interface PushDevice {
  id: string;
  label: string;
  platform: "ios";
  bundleId: string;
  environment: PushEnvironment;
  enabled: boolean;
  authorization: PushAuthorization;
  preferences: PushPreferences;
  state: PushDeviceState;
  revision: number;
  registeredAt: string;
  lastSeenAt: string;
  expiresAt: string;
  /** APNs 접수이며 기기 수신/읽음의 증거가 아니다. */
  lastAcceptedAt: string | null;
  lastFailure: "token_invalid" | "provider_error" | "temporary_error" | null;
}
export interface RegisterPushDeviceRequest {
  expectedRevision: number | null;
  platform: "ios";
  bundleId: string;
  environment: PushEnvironment;
  deviceToken: string;
  authorization: PushAuthorization;
  label?: string;
}
export interface PatchPushDeviceRequest {
  expectedRevision: number;
  enabled?: boolean;
  preferences?: Partial<PushPreferences>;
  label?: string;
  authorization?: PushAuthorization;
}
export interface PushDeviceList { devices: PushDevice[] }
export interface PushProviderStatus {
  environment: PushEnvironment;
  bundleId: string;
  state: "ready" | "unconfigured" | "configuration_error" | "temporarily_unavailable";
  lastError: "key_unreadable" | "invalid_key" | "auth_failed" | "network_error" | null;
}
export interface PushStatus { serverId: string; supported: boolean; providers: PushProviderStatus[] }
export type PushTarget =
  | { screen: "inbox"; projectId: string; decisionId: string }
  | { screen: "team"; projectId: string; memberId: string }
  | { screen: "chat"; projectId: string; memberId: string | null; messageId: string; groupId?: string };
export type PushEventTarget = PushTarget | { screen: "home" };
export interface PushReportGroupReference {
  id: string;
  projectId: string;
  memberId: string;
  openedAt: string;
  closesAt: string;
  lastMessageId: string;
  /** 완료 보고의 원본 message ID 목록, 작성 순서 유지. */
  reportIds: string[];
}
/** 서버 영속 DTO. 첫 보고의 수신 기기 집합을 고정하고 늦은 등록 기기에 소급하지 않는다. */
export interface PushReportGroup extends PushReportGroupReference {
  state: "open" | "closed" | "cancelled";
  recipients: { deviceId: string; registrationGeneration: number; cancelledAt: string | null }[];
  eventId: string | null;
  closedAt: string | null;
}
export interface PushEventTargetResult {
  serverId: string;
  eventId: string;
  target: PushEventTarget;
  reportGroup?: PushReportGroupReference;
}
export interface PushTestRequest { requestId: string }
export interface PushTestResult { notificationId: string; state: "queued" }
export interface PushPayload {
  aps: { alert: { title: "IAMCEO"; body: string }; sound: "default"; "thread-id": string };
  iamceo: { v: 1; serverId: string; eventId: string; kind: PushKind | "test"; target: PushEventTarget };
}
export type PushDeliveryState = "queued" | "sending" | "retry" | "accepted" | "cancelled" | "invalid" | "expired" | "failed" | "unknown";
