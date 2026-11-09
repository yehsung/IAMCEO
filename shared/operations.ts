// v2 전용 쓰기 계약. v1 body/응답에 새 필드를 필수화하지 않는다.
import type { AnswerReq, Member, PatchMemberReq, Settings, SettingsPatch, Todo } from "./types.ts";

export const CONTRACT_HEADER = "X-IAMCEO-Contract";
export const CONTRACT_VERSION = 2;

/** HTTP 경계에서 안전 정수 범위를 검증한다. If-Match는 따옴표를 포함한 정수 revision이다. */
export type Revision = number;
export type SessionGeneration = number;
export interface MemberRevisions { configRevision: Revision; sessionGeneration: SessionGeneration }
export interface SyncRevisions {
  settings: Revision;
  members: Record<string, MemberRevisions>;
  todos: Record<string, Revision>;
}
/** 아직 연결되지 않은 기능은 false. 조회 실패는 연결 전체 실패/쓰기 재생의 근거가 아니다. */
export interface ServerCapabilities {
  contractVersion: 2;
  capabilities: {
    paging: boolean;
    archive: boolean;
    delivery: boolean;
    realtime: boolean;
    push: boolean;
    operations: boolean;
  };
}

/** expectedRevision은 서비스 인자이며 JSON body가 아닌 If-Match에서 읽는다. */
export interface RevisionPrecondition { expectedRevision: Revision }
export type SettingsWriteRequest = SettingsPatch;
export type MemberConfigWriteRequest = PatchMemberReq;
export interface TodoDoneRequest { done: boolean; note?: string; fileIds?: string[] }
/** Decision.updatedAt 문자열이다. delivery recovery의 숫자 version과 혼용하지 않는다. */
export type AnswerRequestV2 = Omit<AnswerReq, "expectedVersion"> & { expectedVersion: string };
export interface SettingsWriteResult { settings: Settings; revision: Revision }
export interface MemberConfigWriteResult { member: Member; configRevision: Revision; sessionGeneration: SessionGeneration }
export interface TodoWriteResult { todo: Todo; revision: Revision }

export interface FreshSessionRequest {
  operationId: string;
  expectedSessionGeneration: SessionGeneration;
}
export interface FreshSessionResult { member: Member; sessionGeneration: SessionGeneration }

export type TerminalKey = "enter" | "up" | "down" | "esc" | "tab" | "ctrl+c" | "backspace";
/** claimId는 클라이언트가 생성해 응답 유실에도 재사용한다. lease는 terminal/세대에 결합한다. */
export type TerminalControlRequestV2 = {
  operationId: string;
  expectedSessionGeneration: SessionGeneration;
  claimId: string;
} & (
  | { action: "claim" | "release"; inputSequence?: never; text?: never; key?: never }
  | { action: "input"; inputSequence: number; text: string; key?: never }
  | { action: "key"; inputSequence: number; key: TerminalKey; text?: never }
);
export interface TerminalControlResultV2 {
  memberId: string;
  action: TerminalControlRequestV2["action"];
  claimId: string;
  sessionGeneration: SessionGeneration;
  inputSequence?: number;
  leaseId?: string;
  /** 기존 terminal 응답과 같은 Unix epoch milliseconds. */
  expiresAt?: number;
}

export type OperationStatus = "pending" | "applied" | "refused" | "unknown";
/** 허용된 결과만 열거한다. 요청 body/인증 토큰/임의 JSON을 receipt로 돌려주지 않는다. */
export interface OperationResults {
  fresh_session: FreshSessionResult;
  terminal_control: TerminalControlResultV2;
  settings: SettingsWriteResult;
  member_config: MemberConfigWriteResult;
  todo_done: TodoWriteResult;
}
export type OperationKind = keyof OperationResults;
export type OperationReceipt<K extends OperationKind = OperationKind> = {
  [P in K]: {
    operationId: string;
    kind: P;
    projectId: string | null;
    memberId: string | null;
    createdAt: string;
    updatedAt: string;
  } & (
    | { status: "pending"; result?: never; code?: never; error?: never }
    | { status: "applied"; result: OperationResults[P]; code?: never; error?: never }
    | { status: "refused" | "unknown"; result?: never; code: string; error: string }
  )
}[K];

/** 새 호출은 같은 본문이어도 다른 operationId다. stable ID의 재요청만 합친다. */
export interface AgentOperationContext { operationId: string }
export interface ManualInboxItem {
  deliveryId: string;
  text: string;
  ref: { type: "message" | "decision" | "todo"; id: string } | null;
}
/** ACK 전 같은 batch를 다시 조회한다. 반환만으로 delivered/소비 완료가 되지 않는다. */
export interface ManualInboxBatch {
  id: string;
  memberId: string;
  items: ManualInboxItem[];
  createdAt: string;
}
export interface ManualInboxAckRequest { batchId: string }
export interface ManualInboxAckResult { batchId: string; acknowledged: true }
