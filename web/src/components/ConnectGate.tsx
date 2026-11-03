// 연결 게이트: 연결되지 않은 동안 대표의 말·결정을 막고 왜 막혔는지와 할 일을 보여 준다.
//   useGate()      지금 쓸 수 있는가(서버 소켓 + 이 프로젝트의 연결). 입력을 가진 화면이 읽는다.
//   <ConnectGate/> 막혔을 때의 안내 판. 열려 있으면 아무것도 안 그린다. 입력칸·홈·팀이 함께 쓴다.
import { useEffect, useState } from "react";
import type { ConnectionReason } from "@shared/types";
import { Glass, GlassButton } from "../glass";
import { cx } from "../glass/Glass";
import { ApiError } from "../lib/api";
import { HQ_ID, routeHash, useProject, useRoute, useStore, useSummary } from "../lib/store";
import "../styles/connect-gate.css";

export const SERVER_DOWN = "서버 연결이 끊겼습니다";

/** 화면 복귀·서버 재시작 같은 잠깐의 끊김에 입력칸이 닫히면 쓰던 글의 초점을 잃는다. 이만큼은 기다린다. */
const SERVER_GRACE_MS = 1500;

export type GateKind = ConnectionReason | "server";
export type Gate = { ok: true; kind: null; detail: null } | { ok: false; kind: GateKind; detail: string };
const OPEN: Gate = { ok: true, kind: null, detail: null };

// 화면을 옮겨 새로 그려도 유예를 다시 세지 않는다.
let offlineSince = 0;

function useServerDown(): boolean {
  const offline = useStore((s) => s.connection === "offline");
  const [, redraw] = useState(0);
  if (!offline) offlineSince = 0;
  else if (!offlineSince) offlineSince = Date.now();
  const left = offline ? SERVER_GRACE_MS - (Date.now() - offlineSince) : 0;
  useEffect(() => {
    if (!offline || left <= 0) return;
    const t = setTimeout(() => redraw((n) => n + 1), left + 10);
    return () => clearTimeout(t);
  }, [offline, left]);
  return offline && left <= 0;
}

export function useGate(): Gate {
  const serverDown = useServerDown();
  const route = useRoute();
  const summary = useSummary();
  const project = useProject();
  if (serverDown) return { ok: false, kind: "server", detail: SERVER_DOWN };
  // 요약은 연결이 바뀔 때마다 온다. 보관된 프로젝트는 요약에 없어 프로젝트 값을 본다.
  const connection = summary?.connection ?? (project?.project.id === route.projectId ? project.project.connection : null);
  if (!connection || connection.ok) return OPEN;
  return { ok: false, kind: connection.reason ?? "backend_down", detail: connection.detail ?? "연결을 확인해 주세요" };
}

/** 연결 때문에 서버가 거부한 요청인가. 이미 답한 결재 같은 다른 409 와 가른다. */
export function isGateRejection(e: unknown): e is ApiError {
  return e instanceof ApiError && e.status === 409 && /연결|실행기/.test(e.message);
}

export default function ConnectGate({ className }: { className?: string }) {
  const gate = useGate();
  const route = useRoute();
  if (gate.ok) return null;
  const server = gate.kind === "server";
  const toTeam = gate.kind === "runner_off" && route.projectId !== HQ_ID && route.tab !== "team";
  return (
    <Glass level="regular" tint radius={20} className={cx("gate", className)} role="status" data-gate={gate.kind}>
      <p className="gate__text"><strong>{server ? SERVER_DOWN : gate.detail}</strong></p>
      {toTeam ? (
        <GlassButton variant="primary" size="m" className="gate__action" href={routeHash({ projectId: route.projectId, tab: "team" })}>
          팀 화면으로
        </GlassButton>
      ) : null}
    </Glass>
  );
}
