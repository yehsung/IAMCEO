// 터미널 직접 조작(J): 앱의 터미널 화면(스트림·조작권·입력·키), 터미널 조작과 새 세션의 v2 작업 영수증,
// 실행 엔진(herdr-core)의 응답·버전 상태와 런타임 정보. orchestrator.ts 에서 옮겨 왔다(동작은 그대로다).
// 세션 수명과 전달 펌프는 Orchestrator 가 맡는다. 여기서는 TerminalControlPort 로만 묻고 부른다.
import { statSync } from "node:fs";
import type { ErrorCode } from "../shared/error-codes.ts";
import type { FreshSessionRequest, OperationReceipt, TerminalControlRequestV2 } from "../shared/operations.ts";
import type { EngineStatus, Member, Project, RuntimeInfo } from "../shared/types.ts";
import { CORE_VERSION, type Config } from "./config.ts";
import { briefly } from "./orchestrator-api.ts";
import type { OrchestratorDeps, OrchestratorTimings } from "./orchestrator.ts";
import { CoreError, type CoreHello } from "./runner/core-client.ts";
import type { Runner, RunnerMember, TerminalControlAction, TerminalControlResult } from "./runner/types.ts";
import type { LifecycleJournal } from "./service-contracts.ts";
import { ApiError, type Store } from "./store.ts";

/** 직원의 세션을 다루는 중인지(Orchestrator 가 직원별로 들고 있는 실행 상태). 읽기만 한다. */
export interface SessionActivity {
  readonly closing: boolean;
  readonly starting: Promise<void> | null;
  readonly reopening: Promise<Member | null> | null;
  readonly pumping: Promise<void> | null;
}

/** 터미널 조작이 Orchestrator 에서 받는 것. */
export interface TerminalControlPort {
  readonly store: Store;
  /** 실행 파일 경로(coreBin·claudeBin·codexBin). */
  readonly config: OrchestratorDeps["config"];
  readonly timings: Pick<OrchestratorTimings, "screenWaitMs" | "engineUnresponsiveMs">;
  /** 서버를 닫는 중이다. */
  closed(): boolean;
  /** core 실행기. 없으면 undefined. */
  coreRunner(): Runner | undefined;
  /** 세션을 띄우기·다시 열기·닫기·전달하는 중인지. */
  session(memberId: string): SessionActivity;
  /** 결과를 아직 모르는 지금 세대의 세션 작업(띄우기·끝내기) 기록. */
  pendingLifecycle(memberId: string): LifecycleJournal | undefined;
  /** 이 직원의 세션을 다루는 실행기. 없으면 ApiError(503). */
  runnerOf(member: Member): Runner;
  runnerMember(member: Member, project: Project): RunnerMember;
  /** 대표가 터미널에 직접 입력했다: 화면으로 잰 문맥 사용량을 버린다. */
  invalidateCoreMeasurement(member: Member): void;
  /** 보관했거나 보관 중인 프로젝트면 ApiError(409). */
  requireActive(project: Project): void;
  /** 이전 세션을 이어 열지 않은 새 세션으로 바꾼다. */
  freshMemberSession(memberId: string): Promise<Member>;
  pump(memberId: string): Promise<void>;
}

export class TerminalControl {
  private readonly store: Store;

  constructor(private readonly port: TerminalControlPort) {
    this.store = port.store;
  }

  /** core 소켓이 연결을 거절하기 시작한 때. 실행 엔진이 hello 에 답하면 Orchestrator 가 비운다. */
  coreRefusedSince: number | null = null;
  private coreRefusedLogged = false;
  /**
   * 소켓 파일은 있는데 아무도 받지 않는 상태가 이어지면 죽은 core 가 남긴 소켓일 수 있다. 살아 있는 core 를 둘로 만들 위험이 있어
   * 자동으로 지우거나 새로 띄우지는 않는다. 왜 실행기가 안 닿는지는 로그에 한 번 남긴다.
   */
  noteCoreRefused(refused: boolean): void {
    if (!refused) { this.coreRefusedSince = null; this.coreRefusedLogged = false; return; }
    this.coreRefusedSince ??= Date.now();
    if (this.coreRefusedLogged || Date.now() - this.coreRefusedSince < 60_000) return;
    this.coreRefusedLogged = true;
    console.error("[core] herdr-core 소켓 파일은 있지만 1분 넘게 아무도 받지 않습니다. 죽은 core 가 남긴 소켓일 수 있습니다. 자동으로 지우거나 새로 띄우지 않습니다: core 가 정말 내려갔는지 확인한 뒤 소켓 파일을 지우면 다시 띄웁니다");
  }

  private engine: EngineStatus | null = null;
  private engineSilentSince: number | null = null;
  /**
   * 실행 엔진이 답했는지(hello)와 그 버전을 적는다. 잠깐의 끊김(다시 띄우는 몇 초)에는 상태를 바꾸지 않고,
   * engineUnresponsiveMs 넘게 이어서 답이 없을 때만 '응답 없음'으로 바꾼다. 달라지면 화면이 다시 읽게 알린다.
   */
  noteEngine(hello: CoreHello | null): void {
    let next = this.engine;
    if (hello) {
      this.engineSilentSince = null;
      const version = typeof hello.version === "string" && hello.version.trim() ? versionIn(hello.version) : undefined;
      next = { state: hello.generation === 1 && version === CORE_VERSION ? "ok" : "version_mismatch", ...(version ? { version } : {}), expectedVersion: CORE_VERSION };
    } else {
      this.engineSilentSince ??= Date.now();
      if (Date.now() - this.engineSilentSince >= this.port.timings.engineUnresponsiveMs) next = { state: "unresponsive", expectedVersion: CORE_VERSION };
    }
    if (JSON.stringify(next) === JSON.stringify(this.engine)) return;
    const before = this.engine;
    this.engine = next;
    if (next && next.state !== "ok") console.warn(next.state === "unresponsive"
      ? `[core] 실행 엔진(herdr-core)이 ${Math.round(this.port.timings.engineUnresponsiveMs / 1000)}초 넘게 답하지 않습니다`
      : `[core] 떠 있는 실행 엔진의 버전(${next.version ?? "알 수 없음"})이 고정 버전(${CORE_VERSION})과 다릅니다`);
    else if (before && before.state !== "ok") console.warn("[core] 실행 엔진 상태가 정상으로 돌아왔습니다");
    // 따로 이벤트가 없는 변화다. 화면이 스냅샷을 다시 읽게 기존 신호를 보낸다.
    if (!this.port.closed()) this.store.touchSnapshot();
  }

  /** 실행 엔진 상태. 아직 한 번도 확인하지 못했거나 엔진이 없는 실행 방식이면 null. */
  engineStatus(): EngineStatus | null {
    return this.engine ? { ...this.engine } : null;
  }

  readonly terminalStreamClosers = new Set<() => Promise<void>>();
  readonly terminalLeaseListeners = new Set<(memberId: string, leaseId: string | null) => Promise<void>>();
  onTerminalLeaseEnded(ended: (memberId: string, leaseId: string | null) => Promise<void>): () => void {
    this.terminalLeaseListeners.add(ended);
    return () => { this.terminalLeaseListeners.delete(ended); };
  }
  onTerminalStreamShutdown(close: () => Promise<void>): () => void {
    this.terminalStreamClosers.add(close);
    return () => { this.terminalStreamClosers.delete(close); };
  }
  private requireTerminalStream(memberId: string): Member {
    const member = this.store.requireMember(memberId);
    const project = this.store.requireProject(member.projectId);
    const rt = this.port.session(memberId);
    if (this.port.closed() || member.backend !== "core" || !member.paneId || member.origin === "manual" || project.archived || !project.runnerEnabled ||
        this.port.pendingLifecycle(memberId) || rt.closing || rt.starting || rt.reopening) {
      throw new ApiError(409, "세션을 처리하는 중이거나 터미널을 열 수 없습니다", "TERMINAL_REFUSED");
    }
    return member;
  }
  async terminalStreamInfo(memberId: string): Promise<{ cols: number; rows: number }> {
    const member = this.requireTerminalStream(memberId);
    const generation = this.store.memberRevisions(memberId).sessionGeneration;
    const runner = this.port.runnerOf(member);
    if (!runner.terminalInfo) throw new ApiError(409, "core 터미널을 확인할 수 없습니다", "TERMINAL_REFUSED");
    try {
      const size = await runner.terminalInfo(this.port.runnerMember(member, this.store.requireProject(member.projectId)));
      const latest = this.requireTerminalStream(memberId);
      if (latest.paneId !== member.paneId || this.store.memberRevisions(memberId).sessionGeneration !== generation) {
        throw new ApiError(409, "세션이 바뀌었습니다", "TERMINAL_REFUSED");
      }
      return size;
    } catch (error) {
      if (error instanceof CoreError && !error.uncertain && ["finished", "not_found"].includes(error.kind)) {
        throw new ApiError(409, "터미널이 끝났거나 없습니다", "TERMINAL_GONE");
      }
      throw new ApiError(409, "터미널 소유와 크기를 확인할 수 없습니다", "TERMINAL_REFUSED");
    }
  }
  terminalStreamLease(memberId: string) {
    const member = this.requireTerminalStream(memberId);
    const lease = this.port.runnerOf(member).terminalLease?.(memberId) ?? null;
    return lease && lease.identity.terminalId === member.paneId && lease.identity.sessionGeneration === this.store.memberRevisions(memberId).sessionGeneration ? lease : null;
  }
  renewTerminalStreamLease(memberId: string, leaseId: string): number {
    const member = this.requireTerminalStream(memberId);
    if (this.terminalStreamLease(memberId)?.leaseId !== leaseId) throw new ApiError(409, "조작권이 없습니다", "TERMINAL_REFUSED");
    const expiresAt = this.port.runnerOf(member).renewLease?.(memberId, leaseId);
    if (!expiresAt) throw new ApiError(409, "조작권이 없습니다", "TERMINAL_REFUSED");
    return expiresAt;
  }
  async terminalStreamInput(memberId: string, write: () => void): Promise<void> {
    const member = this.requireTerminalStream(memberId);
    this.port.invalidateCoreMeasurement(member);
    const runner = this.port.runnerOf(member);
    if (runner.noteTerminalInput) await runner.noteTerminalInput(memberId, write);
    else write();
  }

  /** 터미널 조작(입력·키·조작권)을 처리하는 중인 직원. 그동안 전달·보관·설정 변경을 미룬다. */
  readonly terminalMutations = new Set<string>();
  async terminalControl(memberId: string, action: TerminalControlAction): Promise<TerminalControlResult> {
    const member = this.store.requireMember(memberId);
    if (member.backend !== "core") throw new ApiError(409, "core 터미널만 조작할 수 있습니다", "TERMINAL_REFUSED");
    if (action.action !== "release") {
      this.port.requireActive(this.store.requireProject(member.projectId));
      if (this.port.pendingLifecycle(memberId)) throw new ApiError(409, "미확정 세션 작업을 확인하는 중입니다", "TERMINAL_REFUSED");
    }
    const rt = this.port.session(memberId);
    if (rt.closing || rt.starting || rt.reopening || rt.pumping) throw new ApiError(409, "세션을 처리하는 중입니다. 잠시 뒤 다시 여세요", "TERMINAL_REFUSED");
    const runner = this.port.runnerOf(member);
    if (!runner.terminalControl) throw new ApiError(501, "터미널 조작을 지원하지 않습니다", "TERMINAL_REFUSED");
    if (this.terminalMutations.has(memberId)) throw new ApiError(409, "터미널 입력을 처리하는 중입니다", "terminal_busy");
    this.terminalMutations.add(memberId);
    try {
      if (action.action === "input" || action.action === "key") this.port.invalidateCoreMeasurement(member);
      const previousLease = runner.terminalLease?.(memberId);
      const result = await runner.terminalControl(this.port.runnerMember(member, this.store.requireProject(member.projectId)), action);
      if (previousLease && (action.action === "release" || (action.action === "claim" && result.leaseId !== previousLease.leaseId))) {
        await Promise.all([...this.terminalLeaseListeners].map(ended => ended(memberId, previousLease.leaseId)));
      }
      return result;
    } catch (e) {
      // 넓은 코드 TERMINAL_REFUSED 는 출시된 앱이 보므로 그대로 두고, 실행 엔진의 좁은 사유(core_terminal_missing 등)를 reason 으로 더한다.
      if (e instanceof CoreError && !e.uncertain) throw new ApiError(409, e.message, "TERMINAL_REFUSED", e.reason);
      throw e;
    } finally {
      this.terminalMutations.delete(memberId);
      if (action.action === "release" && this.store.listPending(memberId).length > 0) void this.port.pump(memberId);
    }
  }

  /** 실행 파일이 바뀌지 않는 한 버전은 한 번만 묻는다. 요청마다 프로세스를 띄우면 앱의 연결 확인이 그만큼 늦어진다. */
  private coreVersion: { key: string; value: Promise<string | null> } | null = null;
  private coreVersionOf(binary: string): Promise<string | null> {
    const path = Bun.which(binary);
    if (!path) return Promise.resolve(null);
    let key = path;
    try { const stat = statSync(path); key = `${path}:${stat.mtimeMs}:${stat.size}`; } catch {}
    if (this.coreVersion?.key === key) return this.coreVersion.value;
    const value = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = Bun.spawn([path, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
        timer = setTimeout(() => result.kill(), 2000);
        const output = await new Response(result.stdout).text();
        return await result.exited === 0 ? output.trim().slice(0, 200) || null : null;
      } catch { return null; }
      finally { if (timer) clearTimeout(timer); }
    })();
    this.coreVersion = { key, value };
    // 실패한 조회는 기억하지 않는다. 다음에 다시 묻는다.
    void value.then(found => { if (found === null && this.coreVersion?.value === value) this.coreVersion = null; });
    return value;
  }

  /** 겹친 요청은 한 번만 묻고, 답이 늦으면 마지막으로 아는 상태로 답한다(앱의 연결 확인은 3~4초 제한이다). */
  private coreAvailability: Promise<{ ok: boolean; detail?: string }> | null = null;
  lastCoreAvailability: { ok: boolean; detail?: string } | null = null;
  async runtimeInfo(): Promise<RuntimeInfo> {
    const runner = this.port.coreRunner();
    if (runner) this.coreAvailability ??= runner.available().catch((e: Error) => ({ ok: false, detail: e.message }))
      .then(state => { this.lastCoreAvailability = state; return state; }).finally(() => { this.coreAvailability = null; });
    const configured = this.port.config as OrchestratorDeps["config"] & Partial<Config>;
    const binary = configured.coreBin ?? "herdr-core";
    const installed = !!Bun.which(binary);
    const [available, version] = await Promise.all([
      runner ? briefly(this.coreAvailability!, this.port.timings.screenWaitMs, () => this.lastCoreAvailability ?? { ok: false, detail: "실행기 응답을 기다리는 중입니다" }) : { ok: false, detail: "core 실행기가 없습니다" },
      installed ? briefly(this.coreVersionOf(binary), this.port.timings.screenWaitMs, () => null) : null,
    ]);
    return { backend: "core", core: { installed, available: available.ok, version, detail: available.ok ? null : available.detail ?? null }, providers: {
      claude: { installed: !!Bun.which(configured.claudeBin ?? "claude") }, codex: { installed: !!Bun.which(configured.codexBin ?? "codex") },
    } };
  }

  async operation(operationId: string): Promise<OperationReceipt> {
    const receipt = this.store.getOperation(operationId);
    if (!receipt) throw new ApiError(404, "작업을 찾을 수 없습니다", "operation_not_found");
    if (receipt.projectId) this.store.requireProject(receipt.projectId);
    if (receipt.memberId && this.store.requireMember(receipt.memberId).projectId !== receipt.projectId) throw new ApiError(404, "작업을 찾을 수 없습니다", "operation_not_found");
    return receipt;
  }

  async freshMemberSessionV2(memberId: string, request: FreshSessionRequest): Promise<OperationReceipt<"fresh_session">> {
    const member = this.store.requireMember(memberId);
    const existing = this.store.getOperation(request.operationId);
    const receipt = this.store.beginOperation({ operationId: request.operationId, kind: "fresh_session", projectId: member.projectId, memberId, request }) as OperationReceipt<"fresh_session">;
    if (existing || receipt.status !== "pending") return receipt;
    try {
      if (this.store.memberRevisions(memberId).sessionGeneration !== request.expectedSessionGeneration) throw new ApiError(409, "세션 세대가 변경되었습니다", "SESSION_CONFLICT");
      const updated = await this.port.freshMemberSession(memberId);
      return this.store.finishOperation({ ...receipt, status: "applied", result: { member: updated, sessionGeneration: this.store.memberRevisions(memberId).sessionGeneration } }) as OperationReceipt<"fresh_session">;
    } catch (error) {
      const unknown = this.port.pendingLifecycle(memberId)?.phase === "unknown" || (error instanceof CoreError && error.uncertain);
      return this.store.finishOperation({ ...receipt, status: unknown ? "unknown" : "refused", code: unknown ? "SESSION_UNKNOWN" : "SESSION_REFUSED", error: (error as Error).message.slice(0, 500), ...receiptReason(error, "SESSION_REFUSED") }) as OperationReceipt<"fresh_session">;
    }
  }

  async terminalControlV2(memberId: string, request: TerminalControlRequestV2): Promise<OperationReceipt<"terminal_control">> {
    const member = this.store.requireMember(memberId);
    const existing = this.store.getOperation(request.operationId);
    const receipt = this.store.beginOperation({ operationId: request.operationId, kind: "terminal_control", projectId: member.projectId, memberId, request }) as OperationReceipt<"terminal_control">;
    if (existing || receipt.status !== "pending") return receipt;
    let attempted = false;
    try {
      if (request.action !== "release") this.port.requireActive(this.store.requireProject(member.projectId));
      const generation = this.store.memberRevisions(memberId).sessionGeneration;
      if (generation !== request.expectedSessionGeneration) throw new ApiError(409, "세션 세대가 변경되었습니다", "session_generation_changed");
      const lease = this.store.inputState(memberId).lease;
      if (request.action === "claim" && lease && lease.claimId !== request.claimId) throw new ApiError(409, "다른 조작권이 있습니다", "terminal_lease_other");
      if (request.action !== "claim" && (!lease || lease.claimId !== request.claimId || lease.identity.terminalId !== member.paneId)) throw new ApiError(409, "조작권이 만료되었거나 바뀌었습니다", "terminal_lease_expired");
      if ((request.action === "input" || request.action === "key") && request.inputSequence !== lease!.lastInputSequence + 1) throw new ApiError(409, "입력 순번이 변경되었습니다", "terminal_input_sequence_stale");
      attempted = true;
      const result = await this.terminalControl(memberId, { action: request.action, leaseId: lease?.leaseId ?? request.claimId, ...(request.action === "input" ? { text: request.text } : request.action === "key" ? { key: request.key } : {}) });
      return this.store.finishOperation({ ...receipt, status: "applied", result: { memberId, action: request.action, claimId: request.claimId, sessionGeneration: generation, ...result, ...((request.action === "input" || request.action === "key") ? { inputSequence: request.inputSequence } : {}) } }) as OperationReceipt<"terminal_control">;
    } catch (error) {
      const unknown = attempted && !(error instanceof ApiError && error.code === "TERMINAL_REFUSED");
      return this.store.finishOperation({ ...receipt, status: unknown ? "unknown" : "refused", code: unknown ? "TERMINAL_UNKNOWN" : "TERMINAL_REFUSED", error: (error as Error).message.slice(0, 500), ...receiptReason(error, "TERMINAL_REFUSED") }) as OperationReceipt<"terminal_control">;
    }
  }
}

/** "hc 1.2.3" 같은 글에서 버전만 고른다. 버전 꼴이 없으면 글자 그대로 비교한다. */
function versionIn(raw: string): string {
  return /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(raw)?.[0] ?? raw.trim();
}

/**
 * 작업 영수증의 좁은 사유(reason). 영수증의 code 는 넓은 옛 이름(TERMINAL_REFUSED 등)이라 앱이 사유를 가를 수 없다.
 * ApiError 면 그 reason 이나(넓은 이름과 다르면) 자기 코드, 실행 엔진 거절이면 그 reason. 모르면 싣지 않는다(앱은 그때 옛 방식대로 문장을 본다).
 */
function receiptReason(error: unknown, family: ErrorCode): { reason?: ErrorCode } {
  const reason = error instanceof ApiError ? error.reason ?? (error.code !== family ? error.code : undefined)
    : error instanceof CoreError ? error.reason : undefined;
  return reason ? { reason } : {};
}
