// APNs 전용 계약. Settings/Bootstrap/WsEvent 및 v1 응답을 확장하지 않는다.
import type { CliProvider } from "./types.ts";
export const PUSH_KINDS = ["decision", "approval_wait", "error", "report_complete", "todo_created", "report_blocked"] as const;
/** 자유 답변 ask도 decision 사건 하나이며 질문 메시지는 별도 사건을 만들지 않는다. */
export type PushKind = (typeof PUSH_KINDS)[number];
/**
 * 알림 사건의 종류. 기기 설정 칸(PushKind)에 더해, 설정 칸이 없는 것: test(연결 확인)와
 * tailnet_off(0.2.7 D4-3: 서버 Mac 의 Tailscale 이 꺼져 iPhone 에서 연결할 수 없다. '실행 문제(error)' 설정을 따른다).
 * cli_update(0.2.11: 서버 Mac 의 AI 도구에 새 판이 나왔다. 판마다 한 번. 종류별 설정 칸 없이 기기의 알림 켜기만 따른다).
 * 출시 앱은 모르는 종류의 알림을 눌러도 화면을 옮기지 않을 뿐 배너는 그대로 보인다(문구는 서버·중계가 만든다).
 */
export type PushEventKind = PushKind | "test" | "tailnet_off" | "cli_update";
/** 이 종류의 알림을 보낼지 정하는 기기 설정 칸. test·cli_update 는 늘 보낸다(null). */
export function pushPreferenceOf(kind: PushEventKind): PushKind | null {
  return kind === "test" || kind === "cli_update" ? null : kind === "tailnet_off" ? "error" : kind;
}
export type PushPreferences = Record<PushKind, boolean>;
/** 종류 기본값과 전체 opt-in은 별개다. 새 기기의 enabled는 false다. */
export const DEFAULT_PUSH_PREFERENCES: Readonly<PushPreferences> = Object.freeze({
  decision: true,
  approval_wait: true,
  error: true,
  report_complete: true,
  todo_created: true,
  report_blocked: true,
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
  /** 선택(옛 서버엔 없음): 이 Mac 의 키로 직접 보내는지(key), 개발자의 알림 중계로 보내는지(relay). 설정이 없으면 싣지 않는다. */
  via?: "key" | "relay";
}
export interface PushStatus { serverId: string; supported: boolean; providers: PushProviderStatus[] }
export type PushTarget =
  | { screen: "home"; projectId: string }
  | { screen: "inbox"; projectId: string; decisionId: string }
  | { screen: "team"; projectId: string; memberId: string }
  | { screen: "chat"; projectId: string; memberId: string | null; messageId: string; groupId?: string };
/** cli_update(0.2.11)의 target 은 첫 화면에 CLI 와 판을 더한 세 열쇠다(알림 글을 그 값으로 만든다). 출시 앱은 이 종류를 모른다. */
export type PushEventTarget = PushTarget | { screen: "home" } | { screen: "home"; cli: CliProvider; version: string };
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
  iamceo: { v: 1; serverId: string; eventId: string; kind: PushEventKind; target: PushEventTarget };
}
export type PushDeliveryState = "queued" | "sending" | "retry" | "accepted" | "cancelled" | "invalid" | "expired" | "failed" | "unknown";
