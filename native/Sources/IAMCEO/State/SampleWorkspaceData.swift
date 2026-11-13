// 이 파일은 tests/sample-workspace.test.ts 가 실제 서버 응답으로 만든다. 손으로 고치지 않는다.
// 다시 만들기: IAMCEO_UPDATE_SAMPLE=1 bun test tests/sample-workspace.test.ts
// 샘플 모드의 가짜 서버(SampleServer.swift)가 이 자료로 답한다. 앱 화면 언어가 영어면 `english`, 아니면 `json`(한국어).

enum SampleWorkspaceData {
    static let json = ##"""
{
 "format": 1,
 "baseTime": "2026-01-05T09:00:00.000Z",
 "capabilities": {
  "contractVersion": 2,
  "capabilities": {
   "paging": true,
   "archive": true,
   "realtime": true,
   "delivery": true,
   "push": true,
   "operations": true
  }
 },
 "models": {
  "claude": {
   "source": "default",
   "models": [
    {
     "value": "opus",
     "label": "Opus",
     "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
     ]
    },
    {
     "value": "sonnet",
     "label": "Sonnet",
     "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
     ]
    },
    {
     "value": "haiku",
     "label": "Haiku",
     "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
     ]
    }
   ]
  },
  "codex": {
   "source": "default",
   "models": [
    {
     "value": "gpt-6.1-sol",
     "label": "gpt-6.1-sol",
     "efforts": [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh"
     ]
    },
    {
     "value": "gpt-6-luna",
     "label": "gpt-6-luna",
     "efforts": [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh"
     ]
    },
    {
     "value": "gpt-6.1-terra",
     "label": "gpt-6.1-terra",
     "efforts": [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh"
     ]
    },
    {
     "value": "gpt-6-astra",
     "label": "gpt-6-astra",
     "efforts": [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh"
     ]
    }
   ]
  }
 },
 "runtime": {
  "backend": "core",
  "core": {
   "installed": true,
   "available": true,
   "version": null,
   "detail": null
  },
  "providers": {
   "claude": {
    "installed": true
   },
   "codex": {
    "installed": true
   }
  }
 },
 "bootstrap": {
  "apiOutage": null,
  "version": "sample",
  "runtime": {
   "backend": "core",
   "core": {
    "installed": true,
    "available": true,
    "version": null,
    "detail": null
   },
   "providers": {
    "claude": {
     "installed": true
    },
    "codex": {
     "installed": true
    }
   }
  },
  "settings": {
   "backend": "core",
   "permissionMode": "bypassPermissions",
   "ranks": {
    "manager": {
     "model": null,
     "effort": null
    },
    "lead": {
     "model": null,
     "effort": null
    },
    "staff": {
     "model": null,
     "effort": null
    }
   },
   "codexRanks": {
    "manager": {
     "model": null,
     "effort": null
    },
    "lead": {
     "model": null,
     "effort": null
    },
    "staff": {
     "model": null,
     "effort": null
    }
   },
   "maxConcurrentTurns": 4,
   "compactAtPct": 70,
   "contextWindowDefault": 1000000,
   "contextWindows": {
    "gpt-6-astra": 475000
   },
   "maxAwakeWorkers": 8,
   "notifyMac": false,
   "macScriptNotifications": true,
   "boardTidyHours": 0,
   "permissionAcknowledged": true,
   "reportLanguage": "ko"
  },
  "projects": [
   {
    "id": "hq",
    "name": "본사",
    "isHq": true,
    "cwd": "/Users/sample",
    "now": "새 프로젝트 요청을 기다립니다.",
    "runnerEnabled": true,
    "connection": {
     "ok": true,
     "reason": null,
     "detail": null
    },
    "decisionCount": 0,
    "todoCount": 0,
    "needsCount": 0,
    "needsDanger": false,
    "inboxCount": 0,
    "workingCount": 0,
    "blockedCount": 0,
    "errorCount": 0,
    "memberCount": 1
   },
   {
    "id": "sample-pay",
    "name": "결제 페이지 개편",
    "isHq": false,
    "cwd": "/Users/sample/Projects/shop-web",
    "now": "**자료 조사**가 결제 방식 비교표를 올렸고, **카드 결제 구현**은 결제 화면을 만들고 있습니다. PG사와 완료 문구 결정 2건이 대표의 답을 기다립니다.",
    "runnerEnabled": true,
    "connection": {
     "ok": true,
     "reason": null,
     "detail": null
    },
    "decisionCount": 2,
    "todoCount": 3,
    "needsCount": 5,
    "needsDanger": false,
    "inboxCount": 5,
    "workingCount": 3,
    "blockedCount": 0,
    "errorCount": 0,
    "memberCount": 9
   },
   {
    "id": "sample-ir",
    "name": "투자 IR 자료",
    "isHq": false,
    "cwd": "/Users/sample/Projects/ir",
    "now": "재무 요약 슬라이드 작성 중",
    "runnerEnabled": true,
    "connection": {
     "ok": true,
     "reason": null,
     "detail": null
    },
    "decisionCount": 1,
    "todoCount": 0,
    "needsCount": 1,
    "needsDanger": false,
    "inboxCount": 1,
    "workingCount": 1,
    "blockedCount": 0,
    "errorCount": 0,
    "memberCount": 3
   }
  ],
  "herdr": {
   "installed": false,
   "running": false,
   "version": null,
   "protocol": null,
   "compatible": false,
   "warning": null
  },
  "rankOverrides": {
   "manager": 0,
   "lead": 0
  }
 },
 "settingsRevision": 1,
 "projects": {
  "hq": {
   "state": {
    "project": {
     "id": "hq",
     "name": "본사",
     "isHq": true,
     "cwd": "/Users/sample",
     "runnerEnabled": true,
     "now": "새 프로젝트 요청을 기다립니다.",
     "creationGoal": null,
     "nowAt": "2026-01-04T09:00:00.000Z",
     "herdrTabId": null,
     "archived": false,
     "createdAt": "2026-01-04T03:00:00.000Z",
     "updatedAt": "2026-01-04T09:00:00.000Z",
     "connection": {
      "ok": true,
      "reason": null,
      "detail": null
     },
     "tidiedAt": null
    },
    "members": [
     {
      "id": "m-hq",
      "projectId": "hq",
      "handle": "chief",
      "name": "본사 총괄",
      "role": "새 프로젝트 준비",
      "kind": "conductor",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "claude",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": null,
      "appliedEffort": null,
      "status": "idle",
      "now": "새 프로젝트 요청을 기다립니다.",
      "next": "",
      "cwd": "/Users/sample",
      "sessionId": "00000000-0000-4000-8000-000000000013",
      "paneId": "sample:hq",
      "contextPct": null,
      "contextWindow": null,
      "contextWindowSource": null,
      "subagents": 0,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": null,
      "updatedAt": "2026-01-05T06:00:00.000Z",
      "createdAt": "2026-01-04T04:00:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": null,
      "nowAt": "2026-01-05T06:00:00.000Z",
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null
     }
    ],
    "decisions": [],
    "doneDecisionCount": 0,
    "todos": [],
    "work": [],
    "messages": [],
    "files": [],
    "deliveryNotices": {
     "version": 2,
     "unassignedItems": [],
     "reportNotices": [],
     "members": [
      {
       "memberId": "m-hq",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      }
     ],
     "unassigned": {
      "undeliveredCount": 0,
      "unknownCount": 0,
      "needsOwnerCount": 0
     }
    }
   },
   "revisions": {
    "settings": 1,
    "members": {
     "m-hq": {
      "configRevision": 0,
      "sessionGeneration": 0
     }
    },
    "todos": {}
   },
   "messages": [],
   "decisionsDone": [],
   "deliveryNotices": {
    "version": 2,
    "unassignedItems": [],
    "reportNotices": [],
    "members": [
     {
      "memberId": "m-hq",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     }
    ],
    "unassigned": {
     "undeliveredCount": 0,
     "unknownCount": 0,
     "needsOwnerCount": 0
    }
   },
   "activity": {
    "m-hq": []
   },
   "memberNotices": {
    "m-hq": {
     "memberId": "m-hq",
     "summary": {
      "memberId": "m-hq",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    }
   }
  },
  "sample-pay": {
   "state": {
    "project": {
     "id": "sample-pay",
     "name": "결제 페이지 개편",
     "isHq": false,
     "cwd": "/Users/sample/Projects/shop-web",
     "runnerEnabled": true,
     "now": "**자료 조사**가 결제 방식 비교표를 올렸고, **카드 결제 구현**은 결제 화면을 만들고 있습니다. PG사와 완료 문구 결정 2건이 대표의 답을 기다립니다.",
     "creationGoal": null,
     "nowAt": "2026-01-05T08:54:00.000Z",
     "herdrTabId": null,
     "archived": false,
     "createdAt": "2026-01-04T07:00:00.000Z",
     "updatedAt": "2026-01-05T08:54:00.000Z",
     "connection": {
      "ok": true,
      "reason": null,
      "detail": null
     },
     "tidiedAt": null
    },
    "members": [
     {
      "id": "m-chief",
      "projectId": "sample-pay",
      "handle": "chief",
      "name": "결제 총괄",
      "role": "프로젝트 총괄",
      "kind": "conductor",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "claude",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": "opus",
      "appliedEffort": null,
      "status": "working",
      "now": "PG 연동 결과와 문구 결정을 묶어 다음 지시를 정리하는 중",
      "next": "결재 답이 오면 구현 팀장에게 전달",
      "cwd": "/Users/sample/Projects/shop-web",
      "sessionId": "00000000-0000-4000-8000-000000000001",
      "paneId": "sample:chief",
      "contextPct": 38,
      "contextWindow": 200000,
      "contextWindowSource": "statusline",
      "subagents": 0,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": null,
      "updatedAt": "2026-01-05T08:59:00.000Z",
      "createdAt": "2026-01-04T08:00:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": {
       "quality": "exact",
       "count": 0,
       "observedAt": "2026-01-05T09:00:00.000Z",
       "sessionGeneration": 0
      },
      "nowAt": "2026-01-05T08:59:00.000Z",
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null,
      "contextState": {
       "measurement": {
        "sessionId": "00000000-0000-4000-8000-000000000001",
        "sessionGeneration": 0,
        "turn": 4,
        "model": "opus",
        "tokens": 76000,
        "window": 200000,
        "source": "statusline",
        "quality": "exact",
        "measuredAt": "2026-01-05T08:59:00.000Z",
        "fresh": true
       },
       "compaction": null
      }
     },
     {
      "id": "m-pg",
      "projectId": "sample-pay",
      "handle": "pg",
      "name": "결제 연동",
      "role": "PG 시험 연동 · 실패 코드",
      "kind": "worker",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "codex",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": "gpt-6-astra",
      "appliedEffort": null,
      "status": "waiting",
      "now": "PG 시험 연동 — 실패 응답 코드 정리",
      "next": "완료 문구가 정해지면 화면에 반영",
      "cwd": "/Users/sample/Projects/shop-web",
      "sessionId": "00000000-0000-4000-8000-000000000002",
      "paneId": "sample:pg",
      "contextPct": 22,
      "contextWindow": 400000,
      "contextWindowSource": "codex",
      "subagents": 0,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": "2026-01-05T08:51:00.000Z",
      "updatedAt": "2026-01-05T08:51:00.000Z",
      "createdAt": "2026-01-04T08:01:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": {
       "quality": "exact",
       "count": 0,
       "observedAt": "2026-01-05T09:00:00.000Z",
       "sessionGeneration": 0
      },
      "nowAt": "2026-01-05T08:51:00.000Z",
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null,
      "contextState": {
       "measurement": {
        "sessionId": "00000000-0000-4000-8000-000000000002",
        "sessionGeneration": 0,
        "turn": 4,
        "model": "gpt-6-astra",
        "tokens": 88000,
        "window": 400000,
        "source": "codex",
        "quality": "exact",
        "measuredAt": "2026-01-05T08:51:00.000Z",
        "fresh": true
       },
       "compaction": null
      }
     },
     {
      "id": "m-copy",
      "projectId": "sample-pay",
      "handle": "copy",
      "name": "화면 문구",
      "role": "완료·실패 화면 문구",
      "kind": "worker",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "claude",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": "sonnet",
      "appliedEffort": null,
      "status": "working",
      "now": "완료 화면 문구를 다듬는 중",
      "next": "실패 화면 문구",
      "cwd": "/Users/sample/Projects/shop-web",
      "sessionId": "00000000-0000-4000-8000-000000000003",
      "paneId": "sample:copy",
      "contextPct": 51,
      "contextWindow": 200000,
      "contextWindowSource": "statusline",
      "subagents": 2,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": "2026-01-05T08:59:00.000Z",
      "updatedAt": "2026-01-05T08:59:30.000Z",
      "createdAt": "2026-01-04T08:02:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": {
       "quality": "exact",
       "count": 2,
       "observedAt": "2026-01-05T09:00:00.000Z",
       "sessionGeneration": 0
      },
      "nowAt": "2026-01-05T08:59:30.000Z",
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null,
      "contextState": {
       "measurement": {
        "sessionId": "00000000-0000-4000-8000-000000000003",
        "sessionGeneration": 0,
        "turn": 4,
        "model": "sonnet",
        "tokens": 102000,
        "window": 200000,
        "source": "statusline",
        "quality": "exact",
        "measuredAt": "2026-01-05T08:59:30.000Z",
        "fresh": true
       },
       "compaction": null
      }
     },
     {
      "id": "m-card",
      "projectId": "sample-pay",
      "handle": "card",
      "name": "카드 결제 구현",
      "role": "카드 결제 화면",
      "kind": "worker",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "codex",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": "gpt-6-astra",
      "appliedEffort": null,
      "status": "working",
      "now": "카드 결제 화면 구현 — 결제 버튼과 입력 검증을 잇는 중",
      "next": "시험 통과 후 결과 보고",
      "cwd": "/Users/sample/Projects/shop-web",
      "sessionId": "00000000-0000-4000-8000-000000000004",
      "paneId": "sample:card",
      "contextPct": 44,
      "contextWindow": 400000,
      "contextWindowSource": "codex",
      "subagents": 1,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": "2026-01-05T08:58:00.000Z",
      "updatedAt": "2026-01-05T08:58:00.000Z",
      "createdAt": "2026-01-04T08:03:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": {
       "quality": "exact",
       "count": 1,
       "observedAt": "2026-01-05T09:00:00.000Z",
       "sessionGeneration": 0
      },
      "nowAt": "2026-01-05T08:58:00.000Z",
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null,
      "contextState": {
       "measurement": {
        "sessionId": "00000000-0000-4000-8000-000000000004",
        "sessionGeneration": 0,
        "turn": 4,
        "model": "gpt-6-astra",
        "tokens": 176000,
        "window": 400000,
        "source": "codex",
        "quality": "exact",
        "measuredAt": "2026-01-05T08:58:00.000Z",
        "fresh": true
       },
       "compaction": null
      }
     },
     {
      "id": "m-research",
      "projectId": "sample-pay",
      "handle": "research",
      "name": "자료 조사",
      "role": "PG 비교 · 계약 조건",
      "kind": "worker",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "claude",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": "sonnet",
      "appliedEffort": null,
      "status": "idle",
      "now": "결제 방식 비교표를 정리했다고 보고",
      "next": "PG 결정 뒤 계약 조건 요약",
      "cwd": "/Users/sample/Projects/shop-web",
      "sessionId": "00000000-0000-4000-8000-000000000005",
      "paneId": "sample:research",
      "contextPct": 17,
      "contextWindow": 200000,
      "contextWindowSource": "statusline",
      "subagents": 0,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": null,
      "updatedAt": "2026-01-05T08:40:00.000Z",
      "createdAt": "2026-01-04T08:04:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": {
       "quality": "exact",
       "count": 0,
       "observedAt": "2026-01-05T09:00:00.000Z",
       "sessionGeneration": 0
      },
      "nowAt": "2026-01-05T08:40:00.000Z",
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null,
      "contextState": {
       "measurement": {
        "sessionId": "00000000-0000-4000-8000-000000000005",
        "sessionGeneration": 0,
        "turn": 4,
        "model": "sonnet",
        "tokens": 34000,
        "window": 200000,
        "source": "statusline",
        "quality": "exact",
        "measuredAt": "2026-01-05T08:40:00.000Z",
        "fresh": true
       },
       "compaction": null
      }
     },
     {
      "id": "m-funnel",
      "projectId": "sample-pay",
      "handle": "funnel",
      "name": "이탈률 측정",
      "role": "결제 단계별 이벤트",
      "kind": "worker",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "codex",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": "gpt-6-astra",
      "appliedEffort": null,
      "status": "idle",
      "now": "결제 단계별 이탈 이벤트 이름을 정리했다고 보고",
      "next": "구현이 끝나면 이벤트 심기",
      "cwd": "/Users/sample/Projects/shop-web",
      "sessionId": "00000000-0000-4000-8000-000000000006",
      "paneId": "sample:funnel",
      "contextPct": 28,
      "contextWindow": 400000,
      "contextWindowSource": "codex",
      "subagents": 0,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": null,
      "updatedAt": "2026-01-05T08:55:00.000Z",
      "createdAt": "2026-01-04T08:05:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": {
       "quality": "exact",
       "count": 0,
       "observedAt": "2026-01-05T09:00:00.000Z",
       "sessionGeneration": 0
      },
      "nowAt": "2026-01-05T08:55:00.000Z",
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null,
      "contextState": {
       "measurement": {
        "sessionId": "00000000-0000-4000-8000-000000000006",
        "sessionGeneration": 0,
        "turn": 4,
        "model": "gpt-6-astra",
        "tokens": 112000,
        "window": 400000,
        "source": "codex",
        "quality": "exact",
        "measuredAt": "2026-01-05T08:55:00.000Z",
        "fresh": true
       },
       "compaction": null
      }
     },
     {
      "id": "m-qa",
      "projectId": "sample-pay",
      "handle": "qa",
      "name": "결제 QA",
      "role": "회귀 시험",
      "kind": "worker",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "claude",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": null,
      "appliedEffort": null,
      "status": "asleep",
      "now": "",
      "next": "구현이 끝나면 결제 회귀 시험",
      "cwd": "/Users/sample/Projects/shop-web",
      "sessionId": "00000000-0000-4000-8000-000000000007",
      "paneId": "sample:qa",
      "contextPct": null,
      "contextWindow": null,
      "contextWindowSource": null,
      "subagents": 0,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": null,
      "updatedAt": "2026-01-05T07:30:00.000Z",
      "createdAt": "2026-01-04T08:06:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": {
       "quality": "exact",
       "count": 0,
       "observedAt": "2026-01-05T09:00:00.000Z",
       "sessionGeneration": 0
      },
      "nowAt": null,
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null
     },
     {
      "id": "m-mail",
      "projectId": "sample-pay",
      "handle": "mail",
      "name": "영수증 메일",
      "role": "결제 완료 메일",
      "kind": "worker",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "claude",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": "sonnet",
      "appliedEffort": null,
      "status": "idle",
      "now": "영수증 메일 템플릿 초안을 올렸다고 보고",
      "next": "",
      "cwd": "/Users/sample/Projects/shop-web",
      "sessionId": "00000000-0000-4000-8000-000000000008",
      "paneId": "sample:mail",
      "contextPct": 12,
      "contextWindow": 200000,
      "contextWindowSource": "statusline",
      "subagents": 0,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": null,
      "updatedAt": "2026-01-05T08:30:00.000Z",
      "createdAt": "2026-01-04T08:07:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": {
       "quality": "exact",
       "count": 0,
       "observedAt": "2026-01-05T09:00:00.000Z",
       "sessionGeneration": 0
      },
      "nowAt": "2026-01-05T08:30:00.000Z",
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null,
      "contextState": {
       "measurement": {
        "sessionId": "00000000-0000-4000-8000-000000000008",
        "sessionGeneration": 0,
        "turn": 4,
        "model": "sonnet",
        "tokens": 24000,
        "window": 200000,
        "source": "statusline",
        "quality": "exact",
        "measuredAt": "2026-01-05T08:30:00.000Z",
        "fresh": true
       },
       "compaction": null
      }
     },
     {
      "id": "m-settle",
      "projectId": "sample-pay",
      "handle": "settle",
      "name": "정산 리포트",
      "role": "일별 정산 요약",
      "kind": "worker",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "codex",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": null,
      "appliedEffort": null,
      "status": "asleep",
      "now": "지난주 정산 요약을 보고",
      "next": "",
      "cwd": "/Users/sample/Projects/shop-web",
      "sessionId": "00000000-0000-4000-8000-000000000009",
      "paneId": "sample:settle",
      "contextPct": null,
      "contextWindow": null,
      "contextWindowSource": null,
      "subagents": 0,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": null,
      "updatedAt": "2026-01-04T13:00:00.000Z",
      "createdAt": "2026-01-04T08:08:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": {
       "quality": "exact",
       "count": 0,
       "observedAt": "2026-01-05T09:00:00.000Z",
       "sessionGeneration": 0
      },
      "nowAt": "2026-01-04T13:00:00.000Z",
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null
     }
    ],
    "decisions": [
     {
      "id": "d-pg",
      "projectId": "sample-pay",
      "memberId": "m-research",
      "who": "자료 조사",
      "title": "PG사를 어디로 할지 정해 주세요",
      "detail": "결제 연동을 시작하려면 PG사를 하나 정해야 합니다. 비교표를 자료에 올렸습니다.\n\n- 고객 문의 1위가 '결제됐나요?'라서 정산·알림이 빠른 쪽이 유리합니다\n- 기존 KG이니시스 계약은 내년 3월에 끝납니다",
      "options": [
       {
        "k": "a",
        "label": "토스페이먼츠",
        "desc": "수수료 2.9%, 정산 D+2. 연동 문서가 가장 좋아 구현이 이틀 빠릅니다."
       },
       {
        "k": "b",
        "label": "KG이니시스",
        "desc": "수수료 2.7%, 정산 D+3. 기존 계약을 그대로 씁니다."
       },
       {
        "k": "c",
        "label": "둘 다 붙이고 비교",
        "desc": "구현이 3일 늘고, 2주 뒤 전환율로 고릅니다."
       }
      ],
      "rec": "a",
      "group": null,
      "fileId": "f-fee",
      "images": [],
      "status": "open",
      "choice": null,
      "note": null,
      "batch": false,
      "createdAt": "2026-01-05T08:35:00.000Z",
      "answeredAt": null,
      "deliveredAt": null,
      "updatedAt": "2026-01-05T08:35:00.000Z",
      "lastChoice": null,
      "lastNote": null,
      "reopenNote": null,
      "closeKind": null,
      "closeReason": null,
      "closeQuote": null,
      "closedBy": null,
      "closedAt": null
     },
     {
      "id": "d-done-copy",
      "projectId": "sample-pay",
      "memberId": "m-pg",
      "who": "결제 연동",
      "title": "결제 완료 문구를 골라 주세요",
      "detail": "완료 화면 첫 줄입니다. 사용자가 결제 성공을 바로 알아야 합니다.",
      "options": [
       {
        "k": "a",
        "label": "결제가 끝났습니다",
        "desc": "결과를 바로 말합니다. 영수증 링크를 아래에 둡니다."
       },
       {
        "k": "b",
        "label": "감사합니다",
        "desc": "친근하지만 성공 여부가 덜 분명합니다."
       }
      ],
      "rec": "a",
      "group": null,
      "fileId": "f-copy",
      "images": [],
      "status": "open",
      "choice": null,
      "note": null,
      "batch": false,
      "createdAt": "2026-01-05T08:48:00.000Z",
      "answeredAt": null,
      "deliveredAt": null,
      "updatedAt": "2026-01-05T08:48:00.000Z",
      "lastChoice": null,
      "lastNote": null,
      "reopenNote": null,
      "closeKind": null,
      "closeReason": null,
      "closeQuote": null,
      "closedBy": null,
      "closedAt": null
     },
     {
      "id": "d-fail-copy",
      "projectId": "sample-pay",
      "memberId": "m-copy",
      "who": "화면 문구",
      "title": "실패 문구를 골라 주세요",
      "detail": "실패 화면 첫 줄입니다. 가장 흔한 실패 원인은 카드 한도와 인증 취소입니다.",
      "options": [
       {
        "k": "a",
        "label": "다시 시도해 주세요",
        "desc": "원인을 말하지 않아 같은 실패가 반복될 수 있습니다."
       },
       {
        "k": "b",
        "label": "카드를 확인해 주세요",
        "desc": "가장 흔한 원인을 바로 안내합니다."
       }
      ],
      "rec": "b",
      "group": null,
      "fileId": null,
      "images": [],
      "status": "delivered",
      "choice": "b",
      "note": "고객센터 번호도 함께 보여 주세요.",
      "batch": false,
      "createdAt": "2026-01-05T08:05:00.000Z",
      "answeredAt": "2026-01-05T08:51:00.000Z",
      "deliveredAt": "2026-01-05T08:52:00.000Z",
      "updatedAt": "2026-01-05T08:52:00.000Z",
      "lastChoice": null,
      "lastNote": null,
      "reopenNote": null,
      "closeKind": null,
      "closeReason": null,
      "closeQuote": null,
      "closedBy": null,
      "closedAt": null
     },
     {
      "id": "d-receipt",
      "projectId": "sample-pay",
      "memberId": "m-pg",
      "who": "결제 연동",
      "title": "영수증 메일을 보낼까요?",
      "detail": "결제 완료 직후 영수증 메일을 자동 발송할지 정해 주세요.",
      "options": [
       {
        "k": "a",
        "label": "보낸다"
       },
       {
        "k": "b",
        "label": "보내지 않는다"
       }
      ],
      "rec": null,
      "group": null,
      "fileId": null,
      "images": [],
      "status": "delivered",
      "choice": "a",
      "note": null,
      "batch": false,
      "createdAt": "2026-01-05T08:10:00.000Z",
      "answeredAt": "2026-01-05T08:28:00.000Z",
      "deliveredAt": "2026-01-05T08:29:00.000Z",
      "updatedAt": "2026-01-05T08:29:00.000Z",
      "lastChoice": null,
      "lastNote": null,
      "reopenNote": null,
      "closeKind": null,
      "closeReason": null,
      "closeQuote": null,
      "closedBy": null,
      "closedAt": null
     },
     {
      "id": "d-button",
      "projectId": "sample-pay",
      "memberId": "m-card",
      "who": "카드 결제 구현",
      "title": "결제 버튼 색을 정해 주세요",
      "detail": "브랜드 보라와 기본 파랑 중 하나입니다.",
      "options": [
       {
        "k": "a",
        "label": "기본 파랑"
       },
       {
        "k": "b",
        "label": "브랜드 보라"
       }
      ],
      "rec": "a",
      "group": null,
      "fileId": null,
      "images": [],
      "status": "delivered",
      "choice": "a",
      "note": "접근성 대비 기준을 지켜 주세요.",
      "batch": false,
      "createdAt": "2026-01-05T06:00:00.000Z",
      "answeredAt": "2026-01-05T07:00:00.000Z",
      "deliveredAt": "2026-01-05T07:01:00.000Z",
      "updatedAt": "2026-01-05T07:01:00.000Z",
      "lastChoice": null,
      "lastNote": null,
      "reopenNote": null,
      "closeKind": null,
      "closeReason": null,
      "closeQuote": null,
      "closedBy": null,
      "closedAt": null
     },
     {
      "id": "d-old",
      "projectId": "sample-pay",
      "memberId": "m-research",
      "who": "자료 조사",
      "title": "비교 대상에 페이팔을 넣을까요?",
      "detail": "해외 결제가 필요하면 넣습니다.",
      "options": [],
      "rec": null,
      "group": null,
      "fileId": null,
      "images": [],
      "status": "closed",
      "choice": null,
      "note": null,
      "batch": false,
      "createdAt": "2026-01-05T04:00:00.000Z",
      "answeredAt": null,
      "deliveredAt": null,
      "updatedAt": "2026-01-05T05:00:00.000Z",
      "lastChoice": null,
      "lastNote": null,
      "reopenNote": null,
      "closeKind": "decided",
      "closeReason": "대화에서 국내 결제만 한다고 정했습니다.",
      "closeQuote": "해외 결제는 이번엔 빼죠",
      "closedBy": "자료 조사",
      "closedAt": "2026-01-05T05:00:00.000Z"
     }
    ],
    "doneDecisionCount": 4,
    "todos": [
     {
      "id": "t-done",
      "projectId": "sample-pay",
      "memberId": null,
      "who": "결제 총괄",
      "title": "PG 담당자 연락처 전달",
      "detail": "",
      "done": true,
      "doneAt": "2026-01-05T06:00:00.000Z",
      "createdAt": "2026-01-05T04:00:00.000Z",
      "completionNote": null,
      "completionFileIds": [],
      "outcome": "done",
      "closeReason": null,
      "closedBy": null
     },
     {
      "id": "t-policy",
      "projectId": "sample-pay",
      "memberId": "m-research",
      "who": "자료 조사",
      "title": "개인정보 처리방침 확인",
      "detail": "결제 정보 보관 기간 문구를 법무 기준으로 확인해 주세요.",
      "done": false,
      "doneAt": null,
      "createdAt": "2026-01-05T07:00:00.000Z",
      "completionNote": null,
      "completionFileIds": [],
      "outcome": null,
      "closeReason": null,
      "closedBy": null
     },
     {
      "id": "t-key",
      "projectId": "sample-pay",
      "memberId": "m-card",
      "who": "카드 결제 구현",
      "title": "PG 시험 계정 만들어 주기",
      "detail": "토스페이먼츠 개발자센터에서 시험 키 발급이 필요합니다. 발급 뒤 키를 대화로 보내 주세요.",
      "done": false,
      "doneAt": null,
      "createdAt": "2026-01-05T08:30:00.000Z",
      "completionNote": null,
      "completionFileIds": [],
      "outcome": null,
      "closeReason": null,
      "closedBy": null
     },
     {
      "id": "t-logo",
      "projectId": "sample-pay",
      "memberId": "m-pg",
      "who": "결제 연동",
      "title": "로고 원본 파일 보내기",
      "detail": "완료 화면에 넣을 로고가 필요합니다.\n- SVG면 좋습니다\n- 없으면 PNG",
      "done": false,
      "doneAt": null,
      "createdAt": "2026-01-05T08:42:00.000Z",
      "completionNote": null,
      "completionFileIds": [],
      "outcome": null,
      "closeReason": null,
      "closedBy": null
     }
    ],
    "work": [
     {
      "id": "w9",
      "projectId": "sample-pay",
      "sec": "done",
      "title": "결제 수단 목록 정리",
      "detail": "",
      "who": "결제 총괄",
      "order": 1,
      "doneAt": "2026-01-04T07:00:00.000Z",
      "createdAt": "2026-01-04T07:00:00.000Z",
      "updatedAt": "2026-01-04T07:00:00.000Z"
     },
     {
      "id": "w8",
      "projectId": "sample-pay",
      "sec": "done",
      "title": "영수증 메일 템플릿",
      "detail": "",
      "who": "영수증 메일",
      "order": 2,
      "doneAt": "2026-01-05T08:30:00.000Z",
      "createdAt": "2026-01-05T08:30:00.000Z",
      "updatedAt": "2026-01-05T08:30:00.000Z"
     },
     {
      "id": "w7",
      "projectId": "sample-pay",
      "sec": "done",
      "title": "결제 방식 비교표",
      "detail": "",
      "who": "자료 조사",
      "order": 3,
      "doneAt": "2026-01-05T08:40:00.000Z",
      "createdAt": "2026-01-05T08:40:00.000Z",
      "updatedAt": "2026-01-05T08:40:00.000Z"
     },
     {
      "id": "w1",
      "projectId": "sample-pay",
      "sec": "doing",
      "title": "PG 시험 연동",
      "detail": "실패 응답 코드 표 정리",
      "who": "결제 연동",
      "order": 4,
      "doneAt": null,
      "createdAt": "2026-01-05T08:20:00.000Z",
      "updatedAt": "2026-01-05T08:20:00.000Z"
     },
     {
      "id": "w2",
      "projectId": "sample-pay",
      "sec": "doing",
      "title": "완료·실패 화면 문구",
      "detail": "",
      "who": "화면 문구",
      "order": 5,
      "doneAt": null,
      "createdAt": "2026-01-05T08:21:00.000Z",
      "updatedAt": "2026-01-05T08:21:00.000Z"
     },
     {
      "id": "w3",
      "projectId": "sample-pay",
      "sec": "doing",
      "title": "카드 결제 화면 구현",
      "detail": "결제 버튼·입력 검증 연결",
      "who": "카드 결제 구현",
      "order": 6,
      "doneAt": null,
      "createdAt": "2026-01-05T08:22:00.000Z",
      "updatedAt": "2026-01-05T08:22:00.000Z"
     },
     {
      "id": "w4",
      "projectId": "sample-pay",
      "sec": "next",
      "title": "이탈률 측정 넣기",
      "detail": "",
      "who": "이탈률 측정",
      "order": 7,
      "doneAt": null,
      "createdAt": "2026-01-05T08:23:00.000Z",
      "updatedAt": "2026-01-05T08:23:00.000Z"
     },
     {
      "id": "w5",
      "projectId": "sample-pay",
      "sec": "next",
      "title": "결제 회귀 시험",
      "detail": "",
      "who": "결제 QA",
      "order": 8,
      "doneAt": null,
      "createdAt": "2026-01-05T08:24:00.000Z",
      "updatedAt": "2026-01-05T08:24:00.000Z"
     },
     {
      "id": "w6",
      "projectId": "sample-pay",
      "sec": "hold",
      "title": "간편결제 추가",
      "detail": "PG 결정 뒤 재개",
      "who": "결제 총괄",
      "order": 9,
      "doneAt": null,
      "createdAt": "2026-01-05T08:25:00.000Z",
      "updatedAt": "2026-01-05T08:25:00.000Z"
     }
    ],
    "messages": [
     {
      "id": "x1",
      "projectId": "sample-pay",
      "at": "2026-01-05T08:20:00.000Z",
      "mine": false,
      "memberId": "m-chief",
      "who": "결제 총괄",
      "kind": "진행",
      "title": "오늘 계획",
      "body": "1. PG사 결정 받기\n2. 완료·실패 문구 확정\n3. 카드 결제 화면 시험 통과",
      "targetMemberId": null,
      "targetName": null,
      "decisionId": null,
      "fileId": null,
      "attachments": [],
      "delivery": null,
      "deliveryNote": null,
      "deliveryRevision": 0,
      "contextFileId": null,
      "fileIds": [],
      "supersedes": null,
      "supersededBy": null
     },
     {
      "id": "x2",
      "projectId": "sample-pay",
      "at": "2026-01-05T08:22:00.000Z",
      "mine": true,
      "memberId": null,
      "who": "나",
      "kind": "나",
      "title": "",
      "body": "PG 연동은 이번 주 안에 끝내 주세요.",
      "targetMemberId": null,
      "targetName": null,
      "decisionId": null,
      "fileId": null,
      "attachments": [],
      "delivery": "delivered",
      "deliveryNote": null,
      "deliveryRevision": 0,
      "contextFileId": null,
      "fileIds": [],
      "supersedes": null,
      "supersededBy": null
     },
     {
      "id": "x3",
      "projectId": "sample-pay",
      "at": "2026-01-05T08:40:00.000Z",
      "mine": false,
      "memberId": "m-research",
      "who": "자료 조사",
      "kind": "완료",
      "title": "결제 방식 비교표를 올렸습니다",
      "body": "수수료·정산 주기·연동 난이도를 비교했습니다. PG사 결정은 결재함에 올렸습니다.",
      "targetMemberId": null,
      "targetName": null,
      "decisionId": null,
      "fileId": "f-fee",
      "attachments": [],
      "delivery": null,
      "deliveryNote": null,
      "deliveryRevision": 0,
      "contextFileId": null,
      "fileIds": [
       "f-fee"
      ],
      "supersedes": null,
      "supersededBy": null
     },
     {
      "id": "x4",
      "projectId": "sample-pay",
      "at": "2026-01-05T08:46:00.000Z",
      "mine": false,
      "memberId": "m-card",
      "who": "카드 결제 구현",
      "kind": "진행",
      "title": "카드 결제 화면 1차 구현",
      "body": "- 카드 번호·유효기간 입력 검증\n- 결제 버튼 상태(대기·진행·완료)\n- 다음: 결제 버튼과 PG 시험 연동 잇기",
      "targetMemberId": null,
      "targetName": null,
      "decisionId": null,
      "fileId": null,
      "attachments": [],
      "delivery": null,
      "deliveryNote": null,
      "deliveryRevision": 0,
      "contextFileId": null,
      "fileIds": [],
      "supersedes": null,
      "supersededBy": null
     },
     {
      "id": "x5",
      "projectId": "sample-pay",
      "at": "2026-01-05T08:48:00.000Z",
      "mine": false,
      "memberId": "m-pg",
      "who": "결제 연동",
      "kind": "질문",
      "title": "결제 완료 문구 결정 요청",
      "body": "두 안 중 하나를 골라 주세요.",
      "targetMemberId": null,
      "targetName": null,
      "decisionId": "d-done-copy",
      "fileId": null,
      "attachments": [],
      "delivery": null,
      "deliveryNote": null,
      "deliveryRevision": 0,
      "contextFileId": null,
      "fileIds": [],
      "supersedes": null,
      "supersededBy": null
     },
     {
      "id": "x6",
      "projectId": "sample-pay",
      "at": "2026-01-05T08:52:00.000Z",
      "mine": true,
      "memberId": null,
      "who": "나",
      "kind": "나",
      "title": "",
      "body": "실패 화면에는 고객센터 번호도 넣어 주세요.",
      "targetMemberId": "m-copy",
      "targetName": "화면 문구",
      "decisionId": null,
      "fileId": null,
      "attachments": [],
      "delivery": "delivered",
      "deliveryNote": null,
      "deliveryRevision": 0,
      "contextFileId": null,
      "fileIds": [],
      "supersedes": null,
      "supersededBy": null
     },
     {
      "id": "x7",
      "projectId": "sample-pay",
      "at": "2026-01-05T08:53:00.000Z",
      "mine": true,
      "memberId": null,
      "who": "나",
      "kind": "나",
      "title": "",
      "body": "이탈 이벤트 이름부터 정리해 주세요.",
      "targetMemberId": "m-funnel",
      "targetName": "이탈률 측정",
      "decisionId": null,
      "fileId": null,
      "attachments": [],
      "delivery": "delivered",
      "deliveryNote": null,
      "deliveryRevision": 0,
      "contextFileId": null,
      "fileIds": [],
      "supersedes": null,
      "supersededBy": null
     },
     {
      "id": "x11",
      "projectId": "sample-pay",
      "at": "2026-01-05T08:55:00.000Z",
      "mine": false,
      "memberId": "m-funnel",
      "who": "이탈률 측정",
      "kind": "완료",
      "title": "이탈 이벤트 이름을 정리했습니다",
      "body": "장바구니 → 주문서 → 결제 수단 선택 → 결제 완료, 네 단계의 이벤트 이름과 속성을 정했습니다. 지난 4주 이탈률 표는 자료에 있습니다.",
      "targetMemberId": null,
      "targetName": null,
      "decisionId": null,
      "fileId": "f-funnel",
      "attachments": [],
      "delivery": null,
      "deliveryNote": null,
      "deliveryRevision": 0,
      "contextFileId": null,
      "fileIds": [
       "f-funnel"
      ],
      "supersedes": null,
      "supersededBy": null
     },
     {
      "id": "x8",
      "projectId": "sample-pay",
      "at": "2026-01-05T08:56:00.000Z",
      "mine": false,
      "memberId": "m-copy",
      "who": "화면 문구",
      "kind": "진행",
      "title": "완료 화면 문구 초안",
      "body": "- 짧게 한 줄\n- 다음 행동 안내 한 줄\n- 영수증 링크는 버튼으로",
      "targetMemberId": null,
      "targetName": null,
      "decisionId": null,
      "fileId": null,
      "attachments": [],
      "delivery": null,
      "deliveryNote": null,
      "deliveryRevision": 0,
      "contextFileId": null,
      "fileIds": [],
      "supersedes": null,
      "supersededBy": null
     },
     {
      "id": "x9",
      "projectId": "sample-pay",
      "at": "2026-01-05T08:58:00.000Z",
      "mine": true,
      "memberId": null,
      "who": "나",
      "kind": "나",
      "title": "",
      "body": "결제 버튼은 화면 아래에 고정해 주세요.",
      "targetMemberId": "m-card",
      "targetName": "카드 결제 구현",
      "decisionId": null,
      "fileId": null,
      "attachments": [],
      "delivery": "delivered",
      "deliveryNote": null,
      "deliveryRevision": 0,
      "contextFileId": null,
      "fileIds": [],
      "supersedes": null,
      "supersededBy": null
     },
     {
      "id": "x10",
      "projectId": "sample-pay",
      "at": "2026-01-05T08:59:00.000Z",
      "mine": true,
      "memberId": null,
      "who": "나",
      "kind": "나",
      "title": "",
      "body": "문구 결정은 오늘 오후에 할게요.",
      "targetMemberId": null,
      "targetName": null,
      "decisionId": null,
      "fileId": null,
      "attachments": [],
      "delivery": "delivered",
      "deliveryNote": null,
      "deliveryRevision": 0,
      "contextFileId": null,
      "fileIds": [],
      "supersedes": null,
      "supersededBy": null
     }
    ],
    "files": [
     {
      "id": "f-copy",
      "kind": "artifact",
      "projectId": "sample-pay",
      "title": "완료·실패 화면 시안",
      "who": "화면 문구",
      "memberId": "m-copy",
      "summary": "완료 화면 2안, 실패 화면 2안을 나란히 비교하는 HTML 시안",
      "body": "",
      "path": null,
      "attachments": [],
      "createdAt": "2026-01-05T08:56:00.000Z",
      "order": 5
     },
     {
      "id": "f-fee",
      "kind": "document",
      "projectId": "sample-pay",
      "title": "결제 수단별 수수료 비교",
      "who": "자료 조사",
      "memberId": "m-research",
      "summary": "토스페이먼츠·KG이니시스의 수수료, 정산 주기, 연동 난이도를 비교했습니다.",
      "body": "# 결제 수단별 수수료 비교\n\n## 요약\n토스페이먼츠가 연동 문서와 정산 주기에서 앞서고, KG이니시스는 수수료가 0.2%p 낮습니다.\n\n## 비교\n| PG사 | 수수료 | 정산 | 연동 |\n|---|---:|:-:|---|\n| 토스페이먼츠 | 2.9% | D+2 | 시험 키 즉시 발급, `sandbox` 제공 |\n| KG이니시스 | 2.7% | D+3 | 기존 계약 있음, 시험 키는 2~3일 |\n\n> 결제 금액 1만~5만 원 구간이 전체 결제의 70%입니다.\n\n## 남은 확인\n- [x] 정산 주기 확인\n- [ ] 간편결제 수수료 별도 여부\n- [ ] 해지 위약금\n",
      "path": null,
      "attachments": [],
      "createdAt": "2026-01-05T08:40:00.000Z",
      "order": 4
     },
     {
      "id": "f-config",
      "kind": "code",
      "projectId": "sample-pay",
      "title": "payment-config.ts",
      "who": "카드 결제 구현",
      "memberId": "m-card",
      "summary": "PG 키와 결제 수단 설정",
      "body": "export const payment = {\n  provider: process.env.PG_PROVIDER ?? \"toss\",\n  methods: [\"card\", \"transfer\", \"easy-pay\"],\n  retry: { max: 2, backoffMs: 800 },\n}\n",
      "path": "src/payment/payment-config.ts",
      "attachments": [],
      "createdAt": "2026-01-05T08:25:00.000Z",
      "order": 3
     },
     {
      "id": "f-funnel",
      "kind": "table",
      "projectId": "sample-pay",
      "title": "결제 단계별 이탈률",
      "who": "이탈률 측정",
      "memberId": "m-funnel",
      "summary": "지난 4주 결제 단계별 이탈률",
      "body": "단계,방문,이탈률\n장바구니,12840,18%\n주문서,10529,24%\n결제 수단 선택,8002,31%\n결제 완료,5521,-",
      "path": null,
      "attachments": [],
      "createdAt": "2026-01-04T11:00:00.000Z",
      "order": 2
     },
     {
      "id": "f-shot",
      "kind": "image",
      "projectId": "sample-pay",
      "title": "현재 결제 버튼 캡처",
      "who": "카드 결제 구현",
      "memberId": "m-card",
      "summary": "모바일 결제 버튼 현재 상태",
      "body": "",
      "path": null,
      "attachments": [
       {
        "id": "a-shot",
        "name": "payment-button.png",
        "mime": "image/png",
        "size": 2357,
        "url": "/files/a-shot/payment-button.png",
        "path": "/Users/sample/iamceo/uploads/a-shot/payment-button.png",
        "isImage": true
       }
      ],
      "createdAt": "2026-01-04T08:00:00.000Z",
      "order": 1
     }
    ],
    "deliveryNotices": {
     "version": 2,
     "unassignedItems": [],
     "reportNotices": [],
     "members": [
      {
       "memberId": "m-chief",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      },
      {
       "memberId": "m-pg",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      },
      {
       "memberId": "m-copy",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      },
      {
       "memberId": "m-card",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      },
      {
       "memberId": "m-research",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      },
      {
       "memberId": "m-funnel",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      },
      {
       "memberId": "m-qa",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      },
      {
       "memberId": "m-mail",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      },
      {
       "memberId": "m-settle",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      }
     ],
     "unassigned": {
      "undeliveredCount": 0,
      "unknownCount": 0,
      "needsOwnerCount": 0
     }
    }
   },
   "revisions": {
    "settings": 1,
    "members": {
     "m-card": {
      "configRevision": 0,
      "sessionGeneration": 0
     },
     "m-chief": {
      "configRevision": 0,
      "sessionGeneration": 0
     },
     "m-copy": {
      "configRevision": 0,
      "sessionGeneration": 0
     },
     "m-funnel": {
      "configRevision": 0,
      "sessionGeneration": 0
     },
     "m-mail": {
      "configRevision": 0,
      "sessionGeneration": 0
     },
     "m-pg": {
      "configRevision": 0,
      "sessionGeneration": 0
     },
     "m-qa": {
      "configRevision": 0,
      "sessionGeneration": 0
     },
     "m-research": {
      "configRevision": 0,
      "sessionGeneration": 0
     },
     "m-settle": {
      "configRevision": 0,
      "sessionGeneration": 0
     }
    },
    "todos": {
     "t-policy": 0,
     "t-key": 0,
     "t-logo": 0,
     "t-done": 1
    }
   },
   "messages": [
    {
     "id": "x1",
     "projectId": "sample-pay",
     "at": "2026-01-05T08:20:00.000Z",
     "mine": false,
     "memberId": "m-chief",
     "who": "결제 총괄",
     "kind": "진행",
     "title": "오늘 계획",
     "body": "1. PG사 결정 받기\n2. 완료·실패 문구 확정\n3. 카드 결제 화면 시험 통과",
     "targetMemberId": null,
     "targetName": null,
     "decisionId": null,
     "fileId": null,
     "attachments": [],
     "delivery": null,
     "deliveryNote": null,
     "deliveryRevision": 0,
     "contextFileId": null,
     "fileIds": [],
     "supersedes": null,
     "supersededBy": null
    },
    {
     "id": "x2",
     "projectId": "sample-pay",
     "at": "2026-01-05T08:22:00.000Z",
     "mine": true,
     "memberId": null,
     "who": "나",
     "kind": "나",
     "title": "",
     "body": "PG 연동은 이번 주 안에 끝내 주세요.",
     "targetMemberId": null,
     "targetName": null,
     "decisionId": null,
     "fileId": null,
     "attachments": [],
     "delivery": "delivered",
     "deliveryNote": null,
     "deliveryRevision": 0,
     "contextFileId": null,
     "fileIds": [],
     "supersedes": null,
     "supersededBy": null
    },
    {
     "id": "x3",
     "projectId": "sample-pay",
     "at": "2026-01-05T08:40:00.000Z",
     "mine": false,
     "memberId": "m-research",
     "who": "자료 조사",
     "kind": "완료",
     "title": "결제 방식 비교표를 올렸습니다",
     "body": "수수료·정산 주기·연동 난이도를 비교했습니다. PG사 결정은 결재함에 올렸습니다.",
     "targetMemberId": null,
     "targetName": null,
     "decisionId": null,
     "fileId": "f-fee",
     "attachments": [],
     "delivery": null,
     "deliveryNote": null,
     "deliveryRevision": 0,
     "contextFileId": null,
     "fileIds": [
      "f-fee"
     ],
     "supersedes": null,
     "supersededBy": null
    },
    {
     "id": "x4",
     "projectId": "sample-pay",
     "at": "2026-01-05T08:46:00.000Z",
     "mine": false,
     "memberId": "m-card",
     "who": "카드 결제 구현",
     "kind": "진행",
     "title": "카드 결제 화면 1차 구현",
     "body": "- 카드 번호·유효기간 입력 검증\n- 결제 버튼 상태(대기·진행·완료)\n- 다음: 결제 버튼과 PG 시험 연동 잇기",
     "targetMemberId": null,
     "targetName": null,
     "decisionId": null,
     "fileId": null,
     "attachments": [],
     "delivery": null,
     "deliveryNote": null,
     "deliveryRevision": 0,
     "contextFileId": null,
     "fileIds": [],
     "supersedes": null,
     "supersededBy": null
    },
    {
     "id": "x5",
     "projectId": "sample-pay",
     "at": "2026-01-05T08:48:00.000Z",
     "mine": false,
     "memberId": "m-pg",
     "who": "결제 연동",
     "kind": "질문",
     "title": "결제 완료 문구 결정 요청",
     "body": "두 안 중 하나를 골라 주세요.",
     "targetMemberId": null,
     "targetName": null,
     "decisionId": "d-done-copy",
     "fileId": null,
     "attachments": [],
     "delivery": null,
     "deliveryNote": null,
     "deliveryRevision": 0,
     "contextFileId": null,
     "fileIds": [],
     "supersedes": null,
     "supersededBy": null
    },
    {
     "id": "x6",
     "projectId": "sample-pay",
     "at": "2026-01-05T08:52:00.000Z",
     "mine": true,
     "memberId": null,
     "who": "나",
     "kind": "나",
     "title": "",
     "body": "실패 화면에는 고객센터 번호도 넣어 주세요.",
     "targetMemberId": "m-copy",
     "targetName": "화면 문구",
     "decisionId": null,
     "fileId": null,
     "attachments": [],
     "delivery": "delivered",
     "deliveryNote": null,
     "deliveryRevision": 0,
     "contextFileId": null,
     "fileIds": [],
     "supersedes": null,
     "supersededBy": null
    },
    {
     "id": "x7",
     "projectId": "sample-pay",
     "at": "2026-01-05T08:53:00.000Z",
     "mine": true,
     "memberId": null,
     "who": "나",
     "kind": "나",
     "title": "",
     "body": "이탈 이벤트 이름부터 정리해 주세요.",
     "targetMemberId": "m-funnel",
     "targetName": "이탈률 측정",
     "decisionId": null,
     "fileId": null,
     "attachments": [],
     "delivery": "delivered",
     "deliveryNote": null,
     "deliveryRevision": 0,
     "contextFileId": null,
     "fileIds": [],
     "supersedes": null,
     "supersededBy": null
    },
    {
     "id": "x11",
     "projectId": "sample-pay",
     "at": "2026-01-05T08:55:00.000Z",
     "mine": false,
     "memberId": "m-funnel",
     "who": "이탈률 측정",
     "kind": "완료",
     "title": "이탈 이벤트 이름을 정리했습니다",
     "body": "장바구니 → 주문서 → 결제 수단 선택 → 결제 완료, 네 단계의 이벤트 이름과 속성을 정했습니다. 지난 4주 이탈률 표는 자료에 있습니다.",
     "targetMemberId": null,
     "targetName": null,
     "decisionId": null,
     "fileId": "f-funnel",
     "attachments": [],
     "delivery": null,
     "deliveryNote": null,
     "deliveryRevision": 0,
     "contextFileId": null,
     "fileIds": [
      "f-funnel"
     ],
     "supersedes": null,
     "supersededBy": null
    },
    {
     "id": "x8",
     "projectId": "sample-pay",
     "at": "2026-01-05T08:56:00.000Z",
     "mine": false,
     "memberId": "m-copy",
     "who": "화면 문구",
     "kind": "진행",
     "title": "완료 화면 문구 초안",
     "body": "- 짧게 한 줄\n- 다음 행동 안내 한 줄\n- 영수증 링크는 버튼으로",
     "targetMemberId": null,
     "targetName": null,
     "decisionId": null,
     "fileId": null,
     "attachments": [],
     "delivery": null,
     "deliveryNote": null,
     "deliveryRevision": 0,
     "contextFileId": null,
     "fileIds": [],
     "supersedes": null,
     "supersededBy": null
    },
    {
     "id": "x9",
     "projectId": "sample-pay",
     "at": "2026-01-05T08:58:00.000Z",
     "mine": true,
     "memberId": null,
     "who": "나",
     "kind": "나",
     "title": "",
     "body": "결제 버튼은 화면 아래에 고정해 주세요.",
     "targetMemberId": "m-card",
     "targetName": "카드 결제 구현",
     "decisionId": null,
     "fileId": null,
     "attachments": [],
     "delivery": "delivered",
     "deliveryNote": null,
     "deliveryRevision": 0,
     "contextFileId": null,
     "fileIds": [],
     "supersedes": null,
     "supersededBy": null
    },
    {
     "id": "x10",
     "projectId": "sample-pay",
     "at": "2026-01-05T08:59:00.000Z",
     "mine": true,
     "memberId": null,
     "who": "나",
     "kind": "나",
     "title": "",
     "body": "문구 결정은 오늘 오후에 할게요.",
     "targetMemberId": null,
     "targetName": null,
     "decisionId": null,
     "fileId": null,
     "attachments": [],
     "delivery": "delivered",
     "deliveryNote": null,
     "deliveryRevision": 0,
     "contextFileId": null,
     "fileIds": [],
     "supersedes": null,
     "supersededBy": null
    }
   ],
   "decisionsDone": [
    {
     "id": "d-fail-copy",
     "projectId": "sample-pay",
     "memberId": "m-copy",
     "who": "화면 문구",
     "title": "실패 문구를 골라 주세요",
     "detail": "실패 화면 첫 줄입니다. 가장 흔한 실패 원인은 카드 한도와 인증 취소입니다.",
     "options": [
      {
       "k": "a",
       "label": "다시 시도해 주세요",
       "desc": "원인을 말하지 않아 같은 실패가 반복될 수 있습니다."
      },
      {
       "k": "b",
       "label": "카드를 확인해 주세요",
       "desc": "가장 흔한 원인을 바로 안내합니다."
      }
     ],
     "rec": "b",
     "group": null,
     "fileId": null,
     "images": [],
     "status": "delivered",
     "choice": "b",
     "note": "고객센터 번호도 함께 보여 주세요.",
     "batch": false,
     "createdAt": "2026-01-05T08:05:00.000Z",
     "answeredAt": "2026-01-05T08:51:00.000Z",
     "deliveredAt": "2026-01-05T08:52:00.000Z",
     "updatedAt": "2026-01-05T08:52:00.000Z",
     "lastChoice": null,
     "lastNote": null,
     "reopenNote": null,
     "closeKind": null,
     "closeReason": null,
     "closeQuote": null,
     "closedBy": null,
     "closedAt": null
    },
    {
     "id": "d-receipt",
     "projectId": "sample-pay",
     "memberId": "m-pg",
     "who": "결제 연동",
     "title": "영수증 메일을 보낼까요?",
     "detail": "결제 완료 직후 영수증 메일을 자동 발송할지 정해 주세요.",
     "options": [
      {
       "k": "a",
       "label": "보낸다"
      },
      {
       "k": "b",
       "label": "보내지 않는다"
      }
     ],
     "rec": null,
     "group": null,
     "fileId": null,
     "images": [],
     "status": "delivered",
     "choice": "a",
     "note": null,
     "batch": false,
     "createdAt": "2026-01-05T08:10:00.000Z",
     "answeredAt": "2026-01-05T08:28:00.000Z",
     "deliveredAt": "2026-01-05T08:29:00.000Z",
     "updatedAt": "2026-01-05T08:29:00.000Z",
     "lastChoice": null,
     "lastNote": null,
     "reopenNote": null,
     "closeKind": null,
     "closeReason": null,
     "closeQuote": null,
     "closedBy": null,
     "closedAt": null
    },
    {
     "id": "d-button",
     "projectId": "sample-pay",
     "memberId": "m-card",
     "who": "카드 결제 구현",
     "title": "결제 버튼 색을 정해 주세요",
     "detail": "브랜드 보라와 기본 파랑 중 하나입니다.",
     "options": [
      {
       "k": "a",
       "label": "기본 파랑"
      },
      {
       "k": "b",
       "label": "브랜드 보라"
      }
     ],
     "rec": "a",
     "group": null,
     "fileId": null,
     "images": [],
     "status": "delivered",
     "choice": "a",
     "note": "접근성 대비 기준을 지켜 주세요.",
     "batch": false,
     "createdAt": "2026-01-05T06:00:00.000Z",
     "answeredAt": "2026-01-05T07:00:00.000Z",
     "deliveredAt": "2026-01-05T07:01:00.000Z",
     "updatedAt": "2026-01-05T07:01:00.000Z",
     "lastChoice": null,
     "lastNote": null,
     "reopenNote": null,
     "closeKind": null,
     "closeReason": null,
     "closeQuote": null,
     "closedBy": null,
     "closedAt": null
    },
    {
     "id": "d-old",
     "projectId": "sample-pay",
     "memberId": "m-research",
     "who": "자료 조사",
     "title": "비교 대상에 페이팔을 넣을까요?",
     "detail": "해외 결제가 필요하면 넣습니다.",
     "options": [],
     "rec": null,
     "group": null,
     "fileId": null,
     "images": [],
     "status": "closed",
     "choice": null,
     "note": null,
     "batch": false,
     "createdAt": "2026-01-05T04:00:00.000Z",
     "answeredAt": null,
     "deliveredAt": null,
     "updatedAt": "2026-01-05T05:00:00.000Z",
     "lastChoice": null,
     "lastNote": null,
     "reopenNote": null,
     "closeKind": "decided",
     "closeReason": "대화에서 국내 결제만 한다고 정했습니다.",
     "closeQuote": "해외 결제는 이번엔 빼죠",
     "closedBy": "자료 조사",
     "closedAt": "2026-01-05T05:00:00.000Z"
    }
   ],
   "deliveryNotices": {
    "version": 2,
    "unassignedItems": [],
    "reportNotices": [],
    "members": [
     {
      "memberId": "m-chief",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     {
      "memberId": "m-pg",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     {
      "memberId": "m-copy",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     {
      "memberId": "m-card",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     {
      "memberId": "m-research",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     {
      "memberId": "m-funnel",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     {
      "memberId": "m-qa",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     {
      "memberId": "m-mail",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     {
      "memberId": "m-settle",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     }
    ],
    "unassigned": {
     "undeliveredCount": 0,
     "unknownCount": 0,
     "needsOwnerCount": 0
    }
   },
   "activity": {
    "m-chief": [
     {
      "id": 8,
      "memberId": "m-chief",
      "at": "2026-01-05T08:59:00.000Z",
      "kind": "text",
      "text": "결재 두 건(PG사, 완료 문구)의 답을 기다리는 동안 구현 순서를 정리합니다."
     }
    ],
    "m-pg": [
     {
      "id": 9,
      "memberId": "m-pg",
      "at": "2026-01-05T08:51:00.000Z",
      "kind": "turn_end",
      "text": "실패 응답 코드 표를 정리했습니다. 완료 문구 결정을 기다립니다."
     }
    ],
    "m-copy": [
     {
      "id": 1,
      "memberId": "m-copy",
      "at": "2026-01-05T08:52:00.000Z",
      "kind": "turn_start",
      "text": "지시를 받았습니다: 실패 화면에 고객센터 번호 넣기"
     },
     {
      "id": 2,
      "memberId": "m-copy",
      "at": "2026-01-05T08:54:00.000Z",
      "kind": "tool",
      "text": "읽기 src/pages/checkout/complete.tsx"
     },
     {
      "id": 3,
      "memberId": "m-copy",
      "at": "2026-01-05T08:56:00.000Z",
      "kind": "text",
      "text": "완료 화면 첫 줄을 '결제가 끝났습니다'로 두고 다음 행동 안내를 아래에 붙입니다."
     },
     {
      "id": 4,
      "memberId": "m-copy",
      "at": "2026-01-05T08:59:00.000Z",
      "kind": "tool",
      "text": "고치기 src/pages/checkout/complete.tsx"
     }
    ],
    "m-card": [
     {
      "id": 5,
      "memberId": "m-card",
      "at": "2026-01-05T08:58:00.000Z",
      "kind": "turn_start",
      "text": "지시를 받았습니다: 결제 버튼을 화면 아래에 고정"
     },
     {
      "id": 6,
      "memberId": "m-card",
      "at": "2026-01-05T08:58:00.000Z",
      "kind": "tool",
      "text": "읽기 src/payment/PayButton.tsx"
     },
     {
      "id": 7,
      "memberId": "m-card",
      "at": "2026-01-05T08:59:00.000Z",
      "kind": "text",
      "text": "버튼을 안전 영역 위에 고정하고 키보드가 올라오면 함께 올라가게 합니다."
     }
    ],
    "m-research": [],
    "m-funnel": [],
    "m-qa": [],
    "m-mail": [],
    "m-settle": []
   },
   "memberNotices": {
    "m-chief": {
     "memberId": "m-chief",
     "summary": {
      "memberId": "m-chief",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    },
    "m-pg": {
     "memberId": "m-pg",
     "summary": {
      "memberId": "m-pg",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    },
    "m-copy": {
     "memberId": "m-copy",
     "summary": {
      "memberId": "m-copy",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    },
    "m-card": {
     "memberId": "m-card",
     "summary": {
      "memberId": "m-card",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    },
    "m-research": {
     "memberId": "m-research",
     "summary": {
      "memberId": "m-research",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    },
    "m-funnel": {
     "memberId": "m-funnel",
     "summary": {
      "memberId": "m-funnel",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    },
    "m-qa": {
     "memberId": "m-qa",
     "summary": {
      "memberId": "m-qa",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    },
    "m-mail": {
     "memberId": "m-mail",
     "summary": {
      "memberId": "m-mail",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    },
    "m-settle": {
     "memberId": "m-settle",
     "summary": {
      "memberId": "m-settle",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    }
   }
  },
  "sample-ir": {
   "state": {
    "project": {
     "id": "sample-ir",
     "name": "투자 IR 자료",
     "isHq": false,
     "cwd": "/Users/sample/Projects/ir",
     "runnerEnabled": true,
     "now": "재무 요약 슬라이드 작성 중",
     "creationGoal": null,
     "nowAt": "2026-01-05T07:00:00.000Z",
     "herdrTabId": null,
     "archived": false,
     "createdAt": "2026-01-04T09:00:00.000Z",
     "updatedAt": "2026-01-05T07:00:00.000Z",
     "connection": {
      "ok": true,
      "reason": null,
      "detail": null
     },
     "tidiedAt": null
    },
    "members": [
     {
      "id": "m-ir-chief",
      "projectId": "sample-ir",
      "handle": "chief",
      "name": "IR 총괄",
      "role": "프로젝트 총괄",
      "kind": "conductor",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "claude",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": null,
      "appliedEffort": null,
      "status": "working",
      "now": "재무 요약 슬라이드 순서를 정하는 중",
      "next": "",
      "cwd": "/Users/sample/Projects/ir",
      "sessionId": "00000000-0000-4000-8000-000000000010",
      "paneId": "sample:ir-chief",
      "contextPct": null,
      "contextWindow": null,
      "contextWindowSource": null,
      "subagents": 0,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": null,
      "updatedAt": "2026-01-05T07:00:00.000Z",
      "createdAt": "2026-01-04T10:00:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": null,
      "nowAt": "2026-01-05T07:00:00.000Z",
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null
     },
     {
      "id": "m-ir-deck",
      "projectId": "sample-ir",
      "handle": "deck",
      "name": "슬라이드 작성",
      "role": "재무 요약 · 시장 규모",
      "kind": "worker",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "claude",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": null,
      "appliedEffort": null,
      "status": "idle",
      "now": "시장 규모 슬라이드를 올렸다고 보고",
      "next": "",
      "cwd": "/Users/sample/Projects/ir",
      "sessionId": "00000000-0000-4000-8000-000000000011",
      "paneId": "sample:ir-deck",
      "contextPct": null,
      "contextWindow": null,
      "contextWindowSource": null,
      "subagents": 0,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": null,
      "updatedAt": "2026-01-05T07:00:00.000Z",
      "createdAt": "2026-01-04T10:01:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": null,
      "nowAt": "2026-01-05T07:00:00.000Z",
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null
     },
     {
      "id": "m-ir-num",
      "projectId": "sample-ir",
      "handle": "numbers",
      "name": "숫자 검토",
      "role": "재무 표 검산",
      "kind": "worker",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "codex",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": null,
      "appliedEffort": null,
      "status": "asleep",
      "now": "",
      "next": "",
      "cwd": "/Users/sample/Projects/ir",
      "sessionId": "00000000-0000-4000-8000-000000000012",
      "paneId": "sample:ir-numbers",
      "contextPct": null,
      "contextWindow": null,
      "contextWindowSource": null,
      "subagents": 0,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": null,
      "updatedAt": "2026-01-05T07:00:00.000Z",
      "createdAt": "2026-01-04T10:02:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": null,
      "nowAt": null,
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null
     }
    ],
    "decisions": [
     {
      "id": "d-ir-number",
      "projectId": "sample-ir",
      "memberId": "m-ir-deck",
      "who": "슬라이드 작성",
      "title": "첫 장에 넣을 숫자를 골라 주세요",
      "detail": "투자자가 첫 장에서 기억할 숫자 하나를 정합니다.",
      "options": [
       {
        "k": "a",
        "label": "월 거래액 12억 원"
       },
       {
        "k": "b",
        "label": "재구매율 64%"
       }
      ],
      "rec": "b",
      "group": null,
      "fileId": null,
      "images": [],
      "status": "open",
      "choice": null,
      "note": null,
      "batch": false,
      "createdAt": "2026-01-05T07:00:00.000Z",
      "answeredAt": null,
      "deliveredAt": null,
      "updatedAt": "2026-01-05T07:00:00.000Z",
      "lastChoice": null,
      "lastNote": null,
      "reopenNote": null,
      "closeKind": null,
      "closeReason": null,
      "closeQuote": null,
      "closedBy": null,
      "closedAt": null
     }
    ],
    "doneDecisionCount": 0,
    "todos": [],
    "work": [
     {
      "id": "w-ir-1",
      "projectId": "sample-ir",
      "sec": "doing",
      "title": "재무 요약 슬라이드",
      "detail": "",
      "who": "IR 총괄",
      "order": 1,
      "doneAt": null,
      "createdAt": "2026-01-05T06:00:00.000Z",
      "updatedAt": "2026-01-05T06:00:00.000Z"
     }
    ],
    "messages": [
     {
      "id": "x-ir-1",
      "projectId": "sample-ir",
      "at": "2026-01-05T06:00:00.000Z",
      "mine": false,
      "memberId": "m-ir-chief",
      "who": "IR 총괄",
      "kind": "진행",
      "title": "재무 요약 슬라이드 작성 중",
      "body": "매출·거래액·재구매율 세 장으로 나눴습니다.",
      "targetMemberId": null,
      "targetName": null,
      "decisionId": null,
      "fileId": null,
      "attachments": [],
      "delivery": null,
      "deliveryNote": null,
      "deliveryRevision": 0,
      "contextFileId": null,
      "fileIds": [],
      "supersedes": null,
      "supersededBy": null
     }
    ],
    "files": [
     {
      "id": "f-ir-market",
      "kind": "document",
      "projectId": "sample-ir",
      "title": "시장 규모 요약",
      "who": "슬라이드 작성",
      "memberId": "m-ir-deck",
      "summary": "국내 간편결제 시장 규모와 성장률을 한 장으로 정리했습니다.",
      "body": "# 시장 규모 요약\n\n- 국내 간편결제 거래액: 연 280조 원\n- 최근 3년 연평균 성장률: 18%\n- 우리 고객층(20~30대) 비중: 46%\n",
      "path": null,
      "attachments": [],
      "createdAt": "2026-01-05T06:00:00.000Z",
      "order": 1
     }
    ],
    "deliveryNotices": {
     "version": 2,
     "unassignedItems": [],
     "reportNotices": [],
     "members": [
      {
       "memberId": "m-ir-chief",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      },
      {
       "memberId": "m-ir-deck",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      },
      {
       "memberId": "m-ir-num",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      }
     ],
     "unassigned": {
      "undeliveredCount": 0,
      "unknownCount": 0,
      "needsOwnerCount": 0
     }
    }
   },
   "revisions": {
    "settings": 1,
    "members": {
     "m-ir-chief": {
      "configRevision": 0,
      "sessionGeneration": 0
     },
     "m-ir-deck": {
      "configRevision": 0,
      "sessionGeneration": 0
     },
     "m-ir-num": {
      "configRevision": 0,
      "sessionGeneration": 0
     }
    },
    "todos": {}
   },
   "messages": [
    {
     "id": "x-ir-1",
     "projectId": "sample-ir",
     "at": "2026-01-05T06:00:00.000Z",
     "mine": false,
     "memberId": "m-ir-chief",
     "who": "IR 총괄",
     "kind": "진행",
     "title": "재무 요약 슬라이드 작성 중",
     "body": "매출·거래액·재구매율 세 장으로 나눴습니다.",
     "targetMemberId": null,
     "targetName": null,
     "decisionId": null,
     "fileId": null,
     "attachments": [],
     "delivery": null,
     "deliveryNote": null,
     "deliveryRevision": 0,
     "contextFileId": null,
     "fileIds": [],
     "supersedes": null,
     "supersededBy": null
    }
   ],
   "decisionsDone": [],
   "deliveryNotices": {
    "version": 2,
    "unassignedItems": [],
    "reportNotices": [],
    "members": [
     {
      "memberId": "m-ir-chief",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     {
      "memberId": "m-ir-deck",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     {
      "memberId": "m-ir-num",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     }
    ],
    "unassigned": {
     "undeliveredCount": 0,
     "unknownCount": 0,
     "needsOwnerCount": 0
    }
   },
   "activity": {
    "m-ir-chief": [],
    "m-ir-deck": [],
    "m-ir-num": []
   },
   "memberNotices": {
    "m-ir-chief": {
     "memberId": "m-ir-chief",
     "summary": {
      "memberId": "m-ir-chief",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    },
    "m-ir-deck": {
     "memberId": "m-ir-deck",
     "summary": {
      "memberId": "m-ir-deck",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    },
    "m-ir-num": {
     "memberId": "m-ir-num",
     "summary": {
      "memberId": "m-ir-num",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    }
   }
  }
 },
 "files": {
  "f-copy": {
   "id": "f-copy",
   "kind": "artifact",
   "projectId": "sample-pay",
   "title": "완료·실패 화면 시안",
   "who": "화면 문구",
   "memberId": "m-copy",
   "summary": "완료 화면 2안, 실패 화면 2안을 나란히 비교하는 HTML 시안",
   "body": "",
   "path": null,
   "attachments": [],
   "createdAt": "2026-01-05T08:56:00.000Z",
   "order": 5
  },
  "f-fee": {
   "id": "f-fee",
   "kind": "document",
   "projectId": "sample-pay",
   "title": "결제 수단별 수수료 비교",
   "who": "자료 조사",
   "memberId": "m-research",
   "summary": "토스페이먼츠·KG이니시스의 수수료, 정산 주기, 연동 난이도를 비교했습니다.",
   "body": "# 결제 수단별 수수료 비교\n\n## 요약\n토스페이먼츠가 연동 문서와 정산 주기에서 앞서고, KG이니시스는 수수료가 0.2%p 낮습니다.\n\n## 비교\n| PG사 | 수수료 | 정산 | 연동 |\n|---|---:|:-:|---|\n| 토스페이먼츠 | 2.9% | D+2 | 시험 키 즉시 발급, `sandbox` 제공 |\n| KG이니시스 | 2.7% | D+3 | 기존 계약 있음, 시험 키는 2~3일 |\n\n> 결제 금액 1만~5만 원 구간이 전체 결제의 70%입니다.\n\n## 남은 확인\n- [x] 정산 주기 확인\n- [ ] 간편결제 수수료 별도 여부\n- [ ] 해지 위약금\n",
   "path": null,
   "attachments": [],
   "createdAt": "2026-01-05T08:40:00.000Z",
   "order": 4
  },
  "f-config": {
   "id": "f-config",
   "kind": "code",
   "projectId": "sample-pay",
   "title": "payment-config.ts",
   "who": "카드 결제 구현",
   "memberId": "m-card",
   "summary": "PG 키와 결제 수단 설정",
   "body": "export const payment = {\n  provider: process.env.PG_PROVIDER ?? \"toss\",\n  methods: [\"card\", \"transfer\", \"easy-pay\"],\n  retry: { max: 2, backoffMs: 800 },\n}\n",
   "path": "src/payment/payment-config.ts",
   "attachments": [],
   "createdAt": "2026-01-05T08:25:00.000Z",
   "order": 3
  },
  "f-funnel": {
   "id": "f-funnel",
   "kind": "table",
   "projectId": "sample-pay",
   "title": "결제 단계별 이탈률",
   "who": "이탈률 측정",
   "memberId": "m-funnel",
   "summary": "지난 4주 결제 단계별 이탈률",
   "body": "단계,방문,이탈률\n장바구니,12840,18%\n주문서,10529,24%\n결제 수단 선택,8002,31%\n결제 완료,5521,-",
   "path": null,
   "attachments": [],
   "createdAt": "2026-01-04T11:00:00.000Z",
   "order": 2
  },
  "f-shot": {
   "id": "f-shot",
   "kind": "image",
   "projectId": "sample-pay",
   "title": "현재 결제 버튼 캡처",
   "who": "카드 결제 구현",
   "memberId": "m-card",
   "summary": "모바일 결제 버튼 현재 상태",
   "body": "",
   "path": null,
   "attachments": [
    {
     "id": "a-shot",
     "name": "payment-button.png",
     "mime": "image/png",
     "size": 2357,
     "url": "/files/a-shot/payment-button.png",
     "path": "/Users/sample/iamceo/uploads/a-shot/payment-button.png",
     "isImage": true
    }
   ],
   "createdAt": "2026-01-04T08:00:00.000Z",
   "order": 1
  },
  "f-ir-market": {
   "id": "f-ir-market",
   "kind": "document",
   "projectId": "sample-ir",
   "title": "시장 규모 요약",
   "who": "슬라이드 작성",
   "memberId": "m-ir-deck",
   "summary": "국내 간편결제 시장 규모와 성장률을 한 장으로 정리했습니다.",
   "body": "# 시장 규모 요약\n\n- 국내 간편결제 거래액: 연 280조 원\n- 최근 3년 연평균 성장률: 18%\n- 우리 고객층(20~30대) 비중: 46%\n",
   "path": null,
   "attachments": [],
   "createdAt": "2026-01-05T06:00:00.000Z",
   "order": 1
  }
 },
 "artifacts": {
  "f-copy": "<!doctype html>\n<html lang=\"ko\">\n<head><title>완료·실패 화면 시안</title></head>\n<body>\n<h1>완료·실패 화면 시안</h1>\n<p>결제 직후 보이는 첫 화면을 두 안씩 나란히 놓았습니다. <span class=\"tag good\">추천: 완료 A · 실패 B</span></p>\n\n<div class=\"grid\">\n  <div class=\"card\"><h3>완료 A</h3><p><strong>결제가 끝났습니다</strong></p><p>영수증은 메일로 보냈습니다. 주문 내역에서도 볼 수 있습니다.</p></div>\n  <div class=\"card\"><h3>완료 B</h3><p><strong>감사합니다</strong></p><p>주문이 접수되었습니다.</p></div>\n  <div class=\"card\"><h3>실패 A</h3><p><strong>다시 시도해 주세요</strong></p><p>결제가 완료되지 않았습니다.</p></div>\n  <div class=\"card\"><h3>실패 B</h3><p><strong>카드를 확인해 주세요</strong></p><p>한도나 인증을 확인한 뒤 다시 결제해 주세요. 고객센터 1588-0000</p></div>\n</div>\n\n<div class=\"callout\"><strong>고른 이유:</strong> 고객 문의 1위가 '결제됐나요?'입니다. 첫 줄에서 결과를 바로 말하는 안이 문의를 줄입니다.</div>\n\n<table>\n  <thead><tr><th>안</th><th>첫 줄 길이</th><th>결과가 분명한가</th></tr></thead>\n  <tbody>\n    <tr><td>완료 A</td><td>9자</td><td>예</td></tr>\n    <tr><td>완료 B</td><td>5자</td><td>덜 분명함</td></tr>\n    <tr><td>실패 B</td><td>10자</td><td>원인까지 안내</td></tr>\n  </tbody>\n</table>\n</body>\n</html>"
 },
 "artifactDocuments": {
  "f-copy": "<!doctype html><html lang=\"ko\"><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'\"><meta http-equiv=\"x-dns-prefetch-control\" content=\"off\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>완료·실패 화면 시안</title><style>:where(*,*::before,*::after){box-sizing:border-box}\n:where(html){color-scheme:dark;-webkit-text-size-adjust:100%}\n:where(body){margin:0;padding:24px;background:#090713;color:#F5F2FF;font:15px/1.65 -apple-system,BlinkMacSystemFont,\"Apple SD Gothic Neo\",\"Noto Sans KR\",\"Segoe UI\",sans-serif;word-break:keep-all;overflow-wrap:anywhere}\n:where(h1,h2,h3,h4){margin:1.6em 0 .6em;line-height:1.3;font-weight:650;color:#F5F2FF}\n:where(h1){font-size:1.6rem;margin-top:0}\n:where(h2){font-size:1.25rem}\n:where(h3){font-size:1.05rem}\n:where(h4){font-size:.95rem;color:#C2BBDF}\n:where(p,ul,ol,dl,blockquote,pre,table,figure){margin:0 0 1em}\n:where(ul,ol){padding-left:1.4em}\n:where(li+li){margin-top:.25em}\n:where(a){color:#B9A8FF}\n:where(strong){color:#F5F2FF}\n:where(hr){border:0;border-top:1px solid rgba(255,255,255,.12);margin:1.5em 0}\n:where(blockquote){padding:.2em 0 .2em 1em;border-left:3px solid rgba(185,168,255,.5);color:#C2BBDF}\n:where(img,svg,video,canvas){max-width:100%;height:auto}\n:where(code,kbd,samp){font:.9em/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:rgba(255,255,255,.08);padding:.1em .35em;border-radius:5px}\n:where(pre){padding:14px 16px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:12px;overflow:auto}\n:where(pre code){background:none;padding:0}\n:where(table){width:100%;border-collapse:collapse;font-size:.93em;display:block;overflow-x:auto}\n:where(.kit-table){margin:0 0 1em;overflow-x:auto}\n:where(.kit-table>table){display:table;margin:0}\n:where(th,td){padding:9px 12px;border-bottom:1px solid rgba(255,255,255,.1);text-align:left;vertical-align:top;overflow-wrap:break-word}\n:where(th){color:#C2BBDF;font-weight:600;background:rgba(255,255,255,.04);white-space:nowrap}\n:where(.card){padding:18px 20px;margin:0 0 14px;background:linear-gradient(160deg,rgba(255,255,255,.08),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.12);border-radius:16px;box-shadow:0 8px 24px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.1)}\n:where(.card>:last-child,.callout>:last-child){margin-bottom:0}\n:where(.card>:first-child,.callout>:first-child){margin-top:0}\n:where(.grid){display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 14px}\n:where(.grid>.card){margin:0}\n:where(.callout){padding:14px 16px;margin:0 0 14px;background:rgba(185,168,255,.1);border:1px solid rgba(185,168,255,.28);border-left-width:4px;border-radius:12px}\n:where(.callout.warn){background:rgba(255,183,77,.1);border-color:rgba(255,183,77,.35)}\n:where(.callout.bad){background:rgba(255,107,107,.1);border-color:rgba(255,107,107,.35)}\n:where(.callout.good){background:rgba(92,214,160,.1);border-color:rgba(92,214,160,.35)}\n:where(.kpi){display:flex;flex-direction:column;gap:4px;padding:16px 18px;background:linear-gradient(160deg,rgba(255,255,255,.08),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.12);border-radius:16px}\n:where(.kpi b,.kpi strong){font-size:1.7rem;line-height:1.2;font-weight:680;color:#F5F2FF;font-variant-numeric:tabular-nums}\n:where(.kpi small,.kpi span){color:#A9A2C9;font-size:.85em}\n:where(.steps){list-style:none;counter-reset:step;padding:0;margin:0 0 14px}\n:where(.steps>li){counter-increment:step;position:relative;padding:0 0 14px 40px;margin:0}\n:where(.steps>li)::before{content:counter(step);position:absolute;left:0;top:0;width:26px;height:26px;display:grid;place-items:center;border-radius:50%;background:rgba(185,168,255,.18);color:#D5CBFF;font-size:.82em;font-weight:650}\n:where(.steps>li:not(:last-child))::after{content:\"\";position:absolute;left:12.5px;top:30px;bottom:4px;width:1px;background:rgba(255,255,255,.14)}\n:where(.tag){display:inline-block;padding:.1em .6em;border-radius:999px;font-size:.8em;line-height:1.6;background:rgba(255,255,255,.1);color:#C2BBDF;border:1px solid rgba(255,255,255,.12)}\n:where(.tag.good){background:rgba(92,214,160,.16);color:#9ee8c6}\n:where(.tag.warn){background:rgba(255,183,77,.16);color:#ffd08a}\n:where(.tag.bad){background:rgba(255,107,107,.16);color:#ffb0b0}\n:where(.compare){display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin:0 0 14px}\n:where(.compare>*){padding:16px 18px;margin:0;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:14px}\n:where(.compare>.pick){border-color:rgba(185,168,255,.55);background:rgba(185,168,255,.1)}\n:where(.compare>*>:last-child){margin-bottom:0}\n:where(.compare>*>:first-child){margin-top:0}\n:where(.flow){display:flex;flex-wrap:wrap;gap:10px 26px;list-style:none;padding:0;margin:0 0 14px}\n:where(.flow>*){position:relative;flex:1 1 130px;margin:0;padding:12px 14px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:12px}\n:where(.flow>*:not(:last-child))::after{content:\"→\";position:absolute;right:-20px;top:50%;transform:translateY(-50%);color:#A9A2C9}\n:where(.flow>*>:last-child){margin-bottom:0}\n:where(.flow>*>:first-child){margin-top:0}\n:where(button){font:inherit;color:inherit}\n:where(.tabs){display:flex;flex-wrap:wrap;gap:4px;padding:4px;margin:0 0 14px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:14px}\n:where(.tabs>button){flex:1 1 auto;min-height:44px;padding:0 14px;background:none;border:0;border-radius:10px;color:#C2BBDF;font-weight:600;cursor:pointer}\n:where(.tabs>button:hover){background:rgba(255,255,255,.06)}\n:where(.tabs>button[aria-selected=\"true\"]){background:rgba(122,91,255,.42);color:#fff}\n@media (max-width:520px){:where(body){padding:16px;font-size:14.5px}:where(h1){font-size:1.35rem}:where(.grid,.compare){grid-template-columns:1fr}:where(.flow){flex-direction:column;gap:22px}:where(.flow>*){flex:none}:where(.flow>*:not(:last-child))::after{content:\"↓\";right:auto;left:50%;top:auto;bottom:-22px;transform:translateX(-50%)}}</style><script>(function(){[\"RTCPeerConnection\",\"webkitRTCPeerConnection\"].forEach(function(k){try{delete window[k];window[k]=undefined}catch(e){}});var Q=\"iframe,frame,link\",E=Element.prototype,Rm=E.remove,Mt=E.matches,Qa=E.querySelectorAll;function strip(n){if(n.nodeType!==1)return;if(Mt.call(n,Q))Rm.call(n);else Qa.call(n,Q).forEach(function(x){Rm.call(x)})}new MutationObserver(function(l){l.forEach(function(r){r.addedNodes.forEach(strip)})}).observe(document,{childList:true,subtree:true});[[E,\"attachShadow\"],[E,\"setHTMLUnsafe\"],[Document,\"parseHTMLUnsafe\"],[Document.prototype,\"write\"],[Document.prototype,\"writeln\"]].forEach(function(x){try{delete x[0][x[1]]}catch(e){}});var P=parent,O=ResizeObserver,last=-1,S=getComputedStyle;function send(){var b=document.body,d=document.documentElement,n=0;if(b){var c=S(b);n=b.scrollHeight+(parseFloat(c.marginTop)||0)+(parseFloat(c.marginBottom)||0)}else if(d){n=d.scrollHeight}n=Math.ceil(n);if(n!==last){last=n;P.postMessage({iamceoHeight:n},\"*\")}}var r=new O(send);if(document.documentElement)r.observe(document.documentElement);send();addEventListener(\"DOMContentLoaded\",function(){if(document.body)r.observe(document.body);document.querySelectorAll(\"table\").forEach(function(t){if(t.parentElement&&t.parentElement.classList.contains(\"kit-table\"))return;var w=document.createElement(\"div\");w.className=\"kit-table\";t.parentNode.insertBefore(w,t);w.appendChild(t)});send()});addEventListener(\"load\",send);addEventListener(\"click\",function(e){var a=e.target&&e.target.closest?e.target.closest(\"a[href]\"):null;if(!a)return;var h=a.getAttribute(\"href\")||\"\";if(h.charAt(0)===\"#\")return;e.preventDefault();P.postMessage({iamceoLink:a.href},\"*\")},true);addEventListener(\"keydown\",function(e){if(e.key===\"Escape\")P.postMessage({iamceoEscape:true},\"*\")},true)})()</script></head><body><!doctype html>\n<html lang=\"ko\">\n<head><title>완료·실패 화면 시안</title></head>\n<body>\n<h1>완료·실패 화면 시안</h1>\n<p>결제 직후 보이는 첫 화면을 두 안씩 나란히 놓았습니다. <span class=\"tag good\">추천: 완료 A · 실패 B</span></p>\n\n<div class=\"grid\">\n  <div class=\"card\"><h3>완료 A</h3><p><strong>결제가 끝났습니다</strong></p><p>영수증은 메일로 보냈습니다. 주문 내역에서도 볼 수 있습니다.</p></div>\n  <div class=\"card\"><h3>완료 B</h3><p><strong>감사합니다</strong></p><p>주문이 접수되었습니다.</p></div>\n  <div class=\"card\"><h3>실패 A</h3><p><strong>다시 시도해 주세요</strong></p><p>결제가 완료되지 않았습니다.</p></div>\n  <div class=\"card\"><h3>실패 B</h3><p><strong>카드를 확인해 주세요</strong></p><p>한도나 인증을 확인한 뒤 다시 결제해 주세요. 고객센터 1588-0000</p></div>\n</div>\n\n<div class=\"callout\"><strong>고른 이유:</strong> 고객 문의 1위가 '결제됐나요?'입니다. 첫 줄에서 결과를 바로 말하는 안이 문의를 줄입니다.</div>\n\n<table>\n  <thead><tr><th>안</th><th>첫 줄 길이</th><th>결과가 분명한가</th></tr></thead>\n  <tbody>\n    <tr><td>완료 A</td><td>9자</td><td>예</td></tr>\n    <tr><td>완료 B</td><td>5자</td><td>덜 분명함</td></tr>\n    <tr><td>실패 B</td><td>10자</td><td>원인까지 안내</td></tr>\n  </tbody>\n</table>\n</body>\n</html></body></html>"
 },
 "artifactPolicy": "sandbox allow-scripts; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'",
 "blobs": {
  "/files/a-shot/payment-button.png": {
   "mime": "image/png",
   "base64": "iVBORw0KGgoAAAANSUhEUgAAAYYAAAIICAIAAADlsN6HAAAI/ElEQVR42u3dsU1DQRBFUdeACC2RI0QLOHIFhBZ1EFArEX1AQAFIaNeeeXOkU8Hu+1cE+P/D/d0RoIiDIwAkCUCSAEkCkCRAkgAkCZAkAEkCJAlAkgBJApAkAEkCJAlAkgBJApAkQJIAJAmQJABJAiQJYECSHo5PQCmDkuSyQaRunyQ3CtpUIkmuEISpSpLcHKhSlSS5M1ClEklyVSBMVZLkhkCVJAmQJD0CVlfpoEdAnSod9AioUyVJArKS5CaAVVWSJECSAEnakSR3ACyskiQBkgRIkiQBkgRIkiQB05Lk9IG1VZIkQJIASZIkQJIASZIkQJIAJAmQJEkCJAmQpOsl6fL6znAeaUmqkiRPI6okSVWS5DlElSSpSpI8gaiSJEkSkoQkSRKSJEmVk+TZQ5UkyV9J6BGSJElIkiRJEpKEJKkSeiRJ/nsbPUKSVAk9IvlNAJ5MJUKSvJwEkCRAkiQJkCRAkiQJkCRAkiQJkCQASQIkSZIASQIkSZIASQIkSZIASfp1Pr2xiYcESdIjVUKSJAlJQpIkSZIgJ0l6oUpIkr+S9AgkSZIkCUmSJDwnSJIq6RGS1P+/txVEiZAkPygBJAmQJEkCJAmQJEkCJAmQJEkCJAlAkgBJkiRAkgBJkiRAkgBJkiRAkgBJkiRAkgBJkiRAkgBJkiRAkgAkCZAkSQIkCZAkSQIkCZAkSQIkCZAkSQIkCZAkSQIkCZAkSQIkCWBekp4fX4B/kyQZgqF5CkyS0UDfMKUlyVagdZWikmQl0L1KOUmyDwioUkiSLAMyqiRJgCQtTZJNQEyVJAmQJEkCSZIkQJL2JskaIKlKkgRIkiSBJEkSIEmSBJIkSYAkSRJIkiQBkiRJgCRJEkiSJAGSJEkgSZIESJIkgSRJEiBJkgSSJEmAJEkSSJIkAZIkSSBJkgRIkiQBkiRJIEmSBEiSJIEkSRIgSZIEkiRJgCStTJIqQUyPJAmQJEkCSZIkQJKukSRVgoweSRIgSRuSpEoQ0KOoJKkSdO9RWpJUCVr3KDBJqgR9e5SZJGGCjjEKT5I8QZcMjUsS0IUkAZIkSYAkAZIkSYAkAZIkSYAkAZIkSYAkAZIkSYAkAZIkSYAkAUgSIEmSBHiFG1Hv+nLaXuHmRbfceMdO1YtufQ6AEgt2kj4H4KNJVJmvM/TRJJ+WpMp8nZ5PS/oAN1Xm69x8gLtlkiwjcr5ObGCVJAlJQpKWJskmIufrrGZWSZKQJCRJkmzXtUqSJCFJSNLeJFlD5Hyd0tgqSRKShCRJku26VkmSJCQJSZIkJMm1ShKShCRJEpLkWiUJSUKSJAlJQpJsV5KQJElCkpAk25UkJEmSkCQkSZJs17VKkiQhSUiSJNmua5UkSUKSkCRJQpJcqyQhSUiSJCFJrlWSkCQkSZKQJCTJdiUJSZIkJAlJsl1JQpIkCUlCkiTJdl2rJEkSkoQkrUyS+aYO11kN7JEkIUlIkiTZrmuVJElCkpCkayTJfFOH68Sm9UiSkCQkaUOSzDd1uM5tVI+ikmS+qcN1enN6lJYk800drjMc0qPAJJlv6nCd5IQeZSbJgoNX61SDYxSeJDuO3Ktrjb/WEUkCupAkQJIkCZAkQJIkCZAkQJIkCZAkQJIkCZAkQJIkCZAkQJIkCZAkAEkCJEmSAK9wA7zCzYtuQZ58DgDwOQAfTQJVkiQ9Ap+W9AFuQJL0CJKrJEmAJC1Nkk1ATJUkCZAkSQJJkiRAkvYmyRogqUqSBEiSJIEkSRIgSZIEkiRJgCRJEkiSJAGSJEmAJEkSSJIkAZIkSSBJkgRIkiSBJEkSIEmSBJIkSYAkSRJIkiQBkiRJIEmSBEiSJAGSJEkgSZIESJIkgSRJEiBJkgSSJEmAJK1MkipBTI8kCZAkSQJJkiRAkq6RJFWCjB5JEiBJG5KkShDQo6gkqRJ071FaklQJWvcoMEmqBH17lJkkYYKOMQpPkjxBlwyNSxLQhSQBkiRJgCQBkiRJgCQBkiRJgCQBkiRJgCQBkiRJgCQBkiRJgCQBSBIgSZIESBIgSZIESBIgSZIESBIgSZIESBIgSZIESBIgSZIESBKAJAGStD5J59Mb3JygSJIeoUqSJEkgSZIkSUiSJFVPkmcAVZIkfyWBHkmSJCFJkiRJIEmSpErokST1/+9tTwVKJEl+UAJIEiBJkgRIEiBJkgRIEiBJkgRIEoAkAZIkSYDfuOFXGkiSNwGgSkgSkoQkSRKShCTpkSohSf5KQo+QJEmSJCRJkpAkJEmV0CNJ8u5tlAhJApAkQJIkCZAkQJIkCZAkQJIkCZAkQJIkCZAkQJIkCZAkQJIkCZAkAEkCJEmSAEkCJEmSAEkCJEmSAEkCJEmSAEkCJEmSAEkCJEmSAEkCkCRAkiQJkCRAkiQJkCRAkiQJkCRAkiQJkCRAklKT9HH5Bv4kSRoEChWdJDOCdmHKTJLpQNMwBSbJYqBvldKSZCvQukpRSbIS6F6lnCTZBwRUSZIASVqdJMuAjCpJEiBJS5NkExBTJUkCJEmSQJIkCZAkSQJJGpMka4CkKkkSIEmSBJIkSYAkSRJIkiQBkiRJTX19zuX2JUmS9EiVJEmS0CNVkiRJkiRJkiRJQpIkSZIkSY9USZIkCVXSI0mSJEmSJCRJkiRJkiRJklRJj5AkSVIlPZIkSdImJUKSJAkkSZIASZIkkCRJAiRJkkCSJAmQJJ+WBD2SJEkCSZIkQJIkCSRJkgBJUiUY1iNJAiRpQ5JUCQJ6JEmAJO1JkipB9x6lJUmVoHWPApOkStC3R5lJUiVo2qPYJAkTtItRfpKECRrFaEqSFAoqN2h6koDKJAmQJEkCJAmQJEkCJAmQJFUCbtIjSQIkCZAkSQIkCZAkSQJmJkmVgFU9kiRAkgBJ2pckVQKW9EiSgMQkqRLoUa0kqRLoUa0kqRLokSQBkqRKwOoebUmSMIEYlUuSKoEe1UqSKoEe1UqSMIEYlUuSNoESVUySSIEAlU4SgCQBkgQgSYAkAUgSIEkAkgRIEoAkAZIEIEmAJAFIEoAkAZIEIEmAJAFIEiBJAJIESBKAJAGSBCBJgCQBlPAD+qEPpeCfETEAAAAASUVORK5CYII="
  }
 },
 "usage": {
  "1": {
   "generatedAt": "2026-01-05T09:00:00.000Z",
   "timeZone": "UTC",
   "days": 1,
   "from": "2026-01-05",
   "to": "2026-01-05",
   "projectId": null,
   "retentionDays": 90,
   "totals": {
    "costUsd": 15.72,
    "inputTokens": 4358300,
    "outputTokens": 552760
   },
   "members": [
    {
     "memberId": "m-chief",
     "projectId": "sample-pay",
     "name": "결제 총괄",
     "kind": "conductor",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 5.47,
     "inputTokens": 934800,
     "outputTokens": 118560
    },
    {
     "memberId": "m-copy",
     "projectId": "sample-pay",
     "name": "화면 문구",
     "kind": "worker",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 3.43,
     "inputTokens": 586300,
     "outputTokens": 74360
    },
    {
     "memberId": "m-research",
     "projectId": "sample-pay",
     "name": "자료 조사",
     "kind": "worker",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 2.16,
     "inputTokens": 369000,
     "outputTokens": 46800
    },
    {
     "memberId": "m-ir-chief",
     "projectId": "sample-ir",
     "name": "IR 총괄",
     "kind": "conductor",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 1.92,
     "inputTokens": 328000,
     "outputTokens": 41600
    },
    {
     "memberId": "m-ir-deck",
     "projectId": "sample-ir",
     "name": "슬라이드 작성",
     "kind": "worker",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 1.68,
     "inputTokens": 287000,
     "outputTokens": 36400
    },
    {
     "memberId": "m-mail",
     "projectId": "sample-pay",
     "name": "영수증 메일",
     "kind": "worker",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 1.06,
     "inputTokens": 180400,
     "outputTokens": 22880
    },
    {
     "memberId": "m-card",
     "projectId": "sample-pay",
     "name": "카드 결제 구현",
     "kind": "worker",
     "providers": [
      "codex"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": null,
     "inputTokens": 721600,
     "outputTokens": 91520
    },
    {
     "memberId": "m-pg",
     "projectId": "sample-pay",
     "name": "결제 연동",
     "kind": "worker",
     "providers": [
      "codex"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": null,
     "inputTokens": 631400,
     "outputTokens": 80080
    },
    {
     "memberId": "m-funnel",
     "projectId": "sample-pay",
     "name": "이탈률 측정",
     "kind": "worker",
     "providers": [
      "codex"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": null,
     "inputTokens": 319800,
     "outputTokens": 40560
    }
   ],
   "projects": [
    {
     "projectId": "sample-pay",
     "name": "결제 페이지 개편",
     "archived": false,
     "members": 7,
     "costUsd": 12.12,
     "inputTokens": 3743300,
     "outputTokens": 474760
    },
    {
     "projectId": "sample-ir",
     "name": "투자 IR 자료",
     "archived": false,
     "members": 2,
     "costUsd": 3.6,
     "inputTokens": 615000,
     "outputTokens": 78000
    }
   ],
   "daily": [
    {
     "day": "2026-01-05",
     "costUsd": 15.72,
     "inputTokens": 4358300,
     "outputTokens": 552760
    }
   ],
   "limits": [
    {
     "provider": "claude",
     "window": "five_hour",
     "windowMinutes": 300,
     "usedPct": 34,
     "resetsAt": "2026-01-05T11:00:00.000Z",
     "observedAt": "2026-01-05T08:30:00.000Z"
    },
    {
     "provider": "claude",
     "window": "seven_day",
     "windowMinutes": 10080,
     "usedPct": 18,
     "resetsAt": "2026-01-08T09:00:00.000Z",
     "observedAt": "2026-01-05T08:30:00.000Z"
    },
    {
     "provider": "codex",
     "window": "primary",
     "windowMinutes": 300,
     "usedPct": 22,
     "resetsAt": "2026-01-05T12:00:00.000Z",
     "observedAt": "2026-01-05T08:30:00.000Z"
    },
    {
     "provider": "codex",
     "window": "secondary",
     "windowMinutes": 10080,
     "usedPct": 9,
     "resetsAt": "2026-01-09T09:00:00.000Z",
     "observedAt": "2026-01-05T08:30:00.000Z"
    }
   ]
  },
  "7": {
   "generatedAt": "2026-01-05T09:00:00.000Z",
   "timeZone": "UTC",
   "days": 7,
   "from": "2025-12-30",
   "to": "2026-01-05",
   "projectId": null,
   "retentionDays": 90,
   "totals": {
    "costUsd": 93.62,
    "inputTokens": 25089540,
    "outputTokens": 3182088
   },
   "members": [
    {
     "memberId": "m-chief",
     "projectId": "sample-pay",
     "name": "결제 총괄",
     "kind": "conductor",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 30.92,
     "inputTokens": 5281620,
     "outputTokens": 669864
    },
    {
     "memberId": "m-copy",
     "projectId": "sample-pay",
     "name": "화면 문구",
     "kind": "worker",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 20.97,
     "inputTokens": 3581760,
     "outputTokens": 454272
    },
    {
     "memberId": "m-research",
     "projectId": "sample-pay",
     "name": "자료 조사",
     "kind": "worker",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 14.39,
     "inputTokens": 2457540,
     "outputTokens": 311688
    },
    {
     "memberId": "m-ir-chief",
     "projectId": "sample-ir",
     "name": "IR 총괄",
     "kind": "conductor",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 12.79,
     "inputTokens": 2184480,
     "outputTokens": 277056
    },
    {
     "memberId": "m-ir-deck",
     "projectId": "sample-ir",
     "name": "슬라이드 작성",
     "kind": "worker",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 8.1,
     "inputTokens": 1383750,
     "outputTokens": 175500
    },
    {
     "memberId": "m-mail",
     "projectId": "sample-pay",
     "name": "영수증 메일",
     "kind": "worker",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 6.45,
     "inputTokens": 1102080,
     "outputTokens": 139776
    },
    {
     "memberId": "m-card",
     "projectId": "sample-pay",
     "name": "카드 결제 구현",
     "kind": "worker",
     "providers": [
      "codex"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": null,
     "inputTokens": 4408320,
     "outputTokens": 559104
    },
    {
     "memberId": "m-pg",
     "projectId": "sample-pay",
     "name": "결제 연동",
     "kind": "worker",
     "providers": [
      "codex"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": null,
     "inputTokens": 3044250,
     "outputTokens": 386100
    },
    {
     "memberId": "m-funnel",
     "projectId": "sample-pay",
     "name": "이탈률 측정",
     "kind": "worker",
     "providers": [
      "codex"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": null,
     "inputTokens": 1645740,
     "outputTokens": 208728
    }
   ],
   "projects": [
    {
     "projectId": "sample-pay",
     "name": "결제 페이지 개편",
     "archived": false,
     "members": 7,
     "costUsd": 72.73,
     "inputTokens": 21521310,
     "outputTokens": 2729532
    },
    {
     "projectId": "sample-ir",
     "name": "투자 IR 자료",
     "archived": false,
     "members": 2,
     "costUsd": 20.89,
     "inputTokens": 3568230,
     "outputTokens": 452556
    }
   ],
   "daily": [
    {
     "day": "2025-12-30",
     "costUsd": 5.38,
     "inputTokens": 1396050,
     "outputTokens": 177060
    },
    {
     "day": "2025-12-31",
     "costUsd": 4.72,
     "inputTokens": 1307490,
     "outputTokens": 165828
    },
    {
     "day": "2026-01-01",
     "costUsd": 17.02,
     "inputTokens": 4637100,
     "outputTokens": 588120
    },
    {
     "day": "2026-01-02",
     "costUsd": 16.51,
     "inputTokens": 4403400,
     "outputTokens": 558480
    },
    {
     "day": "2026-01-03",
     "costUsd": 16.37,
     "inputTokens": 4333700,
     "outputTokens": 549640
    },
    {
     "day": "2026-01-04",
     "costUsd": 17.9,
     "inputTokens": 4653500,
     "outputTokens": 590200
    },
    {
     "day": "2026-01-05",
     "costUsd": 15.72,
     "inputTokens": 4358300,
     "outputTokens": 552760
    }
   ],
   "limits": [
    {
     "provider": "claude",
     "window": "five_hour",
     "windowMinutes": 300,
     "usedPct": 34,
     "resetsAt": "2026-01-05T11:00:00.000Z",
     "observedAt": "2026-01-05T08:30:00.000Z"
    },
    {
     "provider": "claude",
     "window": "seven_day",
     "windowMinutes": 10080,
     "usedPct": 18,
     "resetsAt": "2026-01-08T09:00:00.000Z",
     "observedAt": "2026-01-05T08:30:00.000Z"
    },
    {
     "provider": "codex",
     "window": "primary",
     "windowMinutes": 300,
     "usedPct": 22,
     "resetsAt": "2026-01-05T12:00:00.000Z",
     "observedAt": "2026-01-05T08:30:00.000Z"
    },
    {
     "provider": "codex",
     "window": "secondary",
     "windowMinutes": 10080,
     "usedPct": 9,
     "resetsAt": "2026-01-09T09:00:00.000Z",
     "observedAt": "2026-01-05T08:30:00.000Z"
    }
   ]
  },
  "30": {
   "generatedAt": "2026-01-05T09:00:00.000Z",
   "timeZone": "UTC",
   "days": 30,
   "from": "2025-12-07",
   "to": "2026-01-05",
   "projectId": null,
   "retentionDays": 90,
   "totals": {
    "costUsd": 187.01,
    "inputTokens": 50096670,
    "outputTokens": 6353724
   },
   "members": [
    {
     "memberId": "m-chief",
     "projectId": "sample-pay",
     "name": "결제 총괄",
     "kind": "conductor",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 61.56,
     "inputTokens": 10516500,
     "outputTokens": 1333800
    },
    {
     "memberId": "m-copy",
     "projectId": "sample-pay",
     "name": "화면 문구",
     "kind": "worker",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 41.75,
     "inputTokens": 7131540,
     "outputTokens": 904488
    },
    {
     "memberId": "m-research",
     "projectId": "sample-pay",
     "name": "자료 조사",
     "kind": "worker",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 28.97,
     "inputTokens": 4948290,
     "outputTokens": 627588
    },
    {
     "memberId": "m-ir-chief",
     "projectId": "sample-ir",
     "name": "IR 총괄",
     "kind": "conductor",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 25.75,
     "inputTokens": 4398480,
     "outputTokens": 557856
    },
    {
     "memberId": "m-ir-deck",
     "projectId": "sample-ir",
     "name": "슬라이드 작성",
     "kind": "worker",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 16.13,
     "inputTokens": 2755200,
     "outputTokens": 349440
    },
    {
     "memberId": "m-mail",
     "projectId": "sample-pay",
     "name": "영수증 메일",
     "kind": "worker",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 12.85,
     "inputTokens": 2194320,
     "outputTokens": 278304
    },
    {
     "memberId": "m-card",
     "projectId": "sample-pay",
     "name": "카드 결제 구현",
     "kind": "worker",
     "providers": [
      "codex"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": null,
     "inputTokens": 8777280,
     "outputTokens": 1113216
    },
    {
     "memberId": "m-pg",
     "projectId": "sample-pay",
     "name": "결제 연동",
     "kind": "worker",
     "providers": [
      "codex"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": null,
     "inputTokens": 6061440,
     "outputTokens": 768768
    },
    {
     "memberId": "m-funnel",
     "projectId": "sample-pay",
     "name": "이탈률 측정",
     "kind": "worker",
     "providers": [
      "codex"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": null,
     "inputTokens": 3313620,
     "outputTokens": 420264
    }
   ],
   "projects": [
    {
     "projectId": "sample-pay",
     "name": "결제 페이지 개편",
     "archived": false,
     "members": 7,
     "costUsd": 145.13,
     "inputTokens": 42942990,
     "outputTokens": 5446428
    },
    {
     "projectId": "sample-ir",
     "name": "투자 IR 자료",
     "archived": false,
     "members": 2,
     "costUsd": 41.88,
     "inputTokens": 7153680,
     "outputTokens": 907296
    }
   ],
   "daily": [
    {
     "day": "2025-12-23",
     "costUsd": 4.95,
     "inputTokens": 1321020,
     "outputTokens": 167544
    },
    {
     "day": "2025-12-24",
     "costUsd": 4.92,
     "inputTokens": 1300110,
     "outputTokens": 164892
    },
    {
     "day": "2025-12-25",
     "costUsd": 17.9,
     "inputTokens": 4653500,
     "outputTokens": 590200
    },
    {
     "day": "2025-12-26",
     "costUsd": 15.72,
     "inputTokens": 4358300,
     "outputTokens": 552760
    },
    {
     "day": "2025-12-27",
     "costUsd": 17.02,
     "inputTokens": 4637100,
     "outputTokens": 588120
    },
    {
     "day": "2025-12-28",
     "costUsd": 16.51,
     "inputTokens": 4403400,
     "outputTokens": 558480
    },
    {
     "day": "2025-12-29",
     "costUsd": 16.37,
     "inputTokens": 4333700,
     "outputTokens": 549640
    },
    {
     "day": "2025-12-30",
     "costUsd": 5.38,
     "inputTokens": 1396050,
     "outputTokens": 177060
    },
    {
     "day": "2025-12-31",
     "costUsd": 4.72,
     "inputTokens": 1307490,
     "outputTokens": 165828
    },
    {
     "day": "2026-01-01",
     "costUsd": 17.02,
     "inputTokens": 4637100,
     "outputTokens": 588120
    },
    {
     "day": "2026-01-02",
     "costUsd": 16.51,
     "inputTokens": 4403400,
     "outputTokens": 558480
    },
    {
     "day": "2026-01-03",
     "costUsd": 16.37,
     "inputTokens": 4333700,
     "outputTokens": 549640
    },
    {
     "day": "2026-01-04",
     "costUsd": 17.9,
     "inputTokens": 4653500,
     "outputTokens": 590200
    },
    {
     "day": "2026-01-05",
     "costUsd": 15.72,
     "inputTokens": 4358300,
     "outputTokens": 552760
    }
   ],
   "limits": [
    {
     "provider": "claude",
     "window": "five_hour",
     "windowMinutes": 300,
     "usedPct": 34,
     "resetsAt": "2026-01-05T11:00:00.000Z",
     "observedAt": "2026-01-05T08:30:00.000Z"
    },
    {
     "provider": "claude",
     "window": "seven_day",
     "windowMinutes": 10080,
     "usedPct": 18,
     "resetsAt": "2026-01-08T09:00:00.000Z",
     "observedAt": "2026-01-05T08:30:00.000Z"
    },
    {
     "provider": "codex",
     "window": "primary",
     "windowMinutes": 300,
     "usedPct": 22,
     "resetsAt": "2026-01-05T12:00:00.000Z",
     "observedAt": "2026-01-05T08:30:00.000Z"
    },
    {
     "provider": "codex",
     "window": "secondary",
     "windowMinutes": 10080,
     "usedPct": 9,
     "resetsAt": "2026-01-09T09:00:00.000Z",
     "observedAt": "2026-01-05T08:30:00.000Z"
    }
   ]
  }
 }
}
"""##

    static let english = ##"""
{
 "format": 1,
 "baseTime": "2026-01-05T09:00:00.000Z",
 "capabilities": {
  "contractVersion": 2,
  "capabilities": {
   "paging": true,
   "archive": true,
   "realtime": true,
   "delivery": true,
   "push": true,
   "operations": true
  }
 },
 "models": {
  "claude": {
   "source": "default",
   "models": [
    {
     "value": "opus",
     "label": "Opus",
     "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
     ]
    },
    {
     "value": "sonnet",
     "label": "Sonnet",
     "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
     ]
    },
    {
     "value": "haiku",
     "label": "Haiku",
     "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
     ]
    }
   ]
  },
  "codex": {
   "source": "default",
   "models": [
    {
     "value": "gpt-6.1-sol",
     "label": "gpt-6.1-sol",
     "efforts": [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh"
     ]
    },
    {
     "value": "gpt-6-luna",
     "label": "gpt-6-luna",
     "efforts": [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh"
     ]
    },
    {
     "value": "gpt-6.1-terra",
     "label": "gpt-6.1-terra",
     "efforts": [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh"
     ]
    },
    {
     "value": "gpt-6-astra",
     "label": "gpt-6-astra",
     "efforts": [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh"
     ]
    }
   ]
  }
 },
 "runtime": {
  "backend": "core",
  "core": {
   "installed": true,
   "available": true,
   "version": null,
   "detail": null
  },
  "providers": {
   "claude": {
    "installed": true
   },
   "codex": {
    "installed": true
   }
  }
 },
 "bootstrap": {
  "apiOutage": null,
  "version": "sample",
  "runtime": {
   "backend": "core",
   "core": {
    "installed": true,
    "available": true,
    "version": null,
    "detail": null
   },
   "providers": {
    "claude": {
     "installed": true
    },
    "codex": {
     "installed": true
    }
   }
  },
  "settings": {
   "backend": "core",
   "permissionMode": "bypassPermissions",
   "ranks": {
    "manager": {
     "model": null,
     "effort": null
    },
    "lead": {
     "model": null,
     "effort": null
    },
    "staff": {
     "model": null,
     "effort": null
    }
   },
   "codexRanks": {
    "manager": {
     "model": null,
     "effort": null
    },
    "lead": {
     "model": null,
     "effort": null
    },
    "staff": {
     "model": null,
     "effort": null
    }
   },
   "maxConcurrentTurns": 4,
   "compactAtPct": 70,
   "contextWindowDefault": 1000000,
   "contextWindows": {
    "gpt-6-astra": 475000
   },
   "maxAwakeWorkers": 8,
   "notifyMac": false,
   "macScriptNotifications": true,
   "boardTidyHours": 0,
   "permissionAcknowledged": true,
   "reportLanguage": "en"
  },
  "projects": [
   {
    "id": "hq",
    "name": "HQ",
    "isHq": true,
    "cwd": "/Users/sample",
    "now": "Waiting for a new project request.",
    "runnerEnabled": true,
    "connection": {
     "ok": true,
     "reason": null,
     "detail": null
    },
    "decisionCount": 0,
    "todoCount": 0,
    "needsCount": 0,
    "needsDanger": false,
    "inboxCount": 0,
    "workingCount": 0,
    "blockedCount": 0,
    "errorCount": 0,
    "memberCount": 1
   },
   {
    "id": "sample-pay",
    "name": "Checkout Revamp",
    "isHq": false,
    "cwd": "/Users/sample/Projects/shop-web",
    "now": "**Research** posted the payment provider comparison, and **Card Checkout** is building the payment screen. Two decisions — the provider and the confirmation message — are waiting for you.",
    "runnerEnabled": true,
    "connection": {
     "ok": true,
     "reason": null,
     "detail": null
    },
    "decisionCount": 2,
    "todoCount": 3,
    "needsCount": 5,
    "needsDanger": false,
    "inboxCount": 5,
    "workingCount": 3,
    "blockedCount": 0,
    "errorCount": 0,
    "memberCount": 9
   },
   {
    "id": "sample-ir",
    "name": "Investor Deck",
    "isHq": false,
    "cwd": "/Users/sample/Projects/ir",
    "now": "Writing the financial summary slides",
    "runnerEnabled": true,
    "connection": {
     "ok": true,
     "reason": null,
     "detail": null
    },
    "decisionCount": 1,
    "todoCount": 0,
    "needsCount": 1,
    "needsDanger": false,
    "inboxCount": 1,
    "workingCount": 1,
    "blockedCount": 0,
    "errorCount": 0,
    "memberCount": 3
   }
  ],
  "herdr": {
   "installed": false,
   "running": false,
   "version": null,
   "protocol": null,
   "compatible": false,
   "warning": null
  },
  "rankOverrides": {
   "manager": 0,
   "lead": 0
  }
 },
 "settingsRevision": 1,
 "projects": {
  "hq": {
   "state": {
    "project": {
     "id": "hq",
     "name": "HQ",
     "isHq": true,
     "cwd": "/Users/sample",
     "runnerEnabled": true,
     "now": "Waiting for a new project request.",
     "creationGoal": null,
     "nowAt": "2026-01-04T09:00:00.000Z",
     "herdrTabId": null,
     "archived": false,
     "createdAt": "2026-01-04T03:00:00.000Z",
     "updatedAt": "2026-01-04T09:00:00.000Z",
     "connection": {
      "ok": true,
      "reason": null,
      "detail": null
     },
     "tidiedAt": null
    },
    "members": [
     {
      "id": "m-hq",
      "projectId": "hq",
      "handle": "chief",
      "name": "HQ Lead",
      "role": "Getting new projects ready",
      "kind": "conductor",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "claude",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": null,
      "appliedEffort": null,
      "status": "idle",
      "now": "Waiting for a new project request.",
      "next": "",
      "cwd": "/Users/sample",
      "sessionId": "00000000-0000-4000-8000-000000000013",
      "paneId": "sample:hq",
      "contextPct": null,
      "contextWindow": null,
      "contextWindowSource": null,
      "subagents": 0,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": null,
      "updatedAt": "2026-01-05T06:00:00.000Z",
      "createdAt": "2026-01-04T04:00:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": null,
      "nowAt": "2026-01-05T06:00:00.000Z",
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null
     }
    ],
    "decisions": [],
    "doneDecisionCount": 0,
    "todos": [],
    "work": [],
    "messages": [],
    "files": [],
    "deliveryNotices": {
     "version": 2,
     "unassignedItems": [],
     "reportNotices": [],
     "members": [
      {
       "memberId": "m-hq",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      }
     ],
     "unassigned": {
      "undeliveredCount": 0,
      "unknownCount": 0,
      "needsOwnerCount": 0
     }
    }
   },
   "revisions": {
    "settings": 1,
    "members": {
     "m-hq": {
      "configRevision": 0,
      "sessionGeneration": 0
     }
    },
    "todos": {}
   },
   "messages": [],
   "decisionsDone": [],
   "deliveryNotices": {
    "version": 2,
    "unassignedItems": [],
    "reportNotices": [],
    "members": [
     {
      "memberId": "m-hq",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     }
    ],
    "unassigned": {
     "undeliveredCount": 0,
     "unknownCount": 0,
     "needsOwnerCount": 0
    }
   },
   "activity": {
    "m-hq": []
   },
   "memberNotices": {
    "m-hq": {
     "memberId": "m-hq",
     "summary": {
      "memberId": "m-hq",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    }
   }
  },
  "sample-pay": {
   "state": {
    "project": {
     "id": "sample-pay",
     "name": "Checkout Revamp",
     "isHq": false,
     "cwd": "/Users/sample/Projects/shop-web",
     "runnerEnabled": true,
     "now": "**Research** posted the payment provider comparison, and **Card Checkout** is building the payment screen. Two decisions — the provider and the confirmation message — are waiting for you.",
     "creationGoal": null,
     "nowAt": "2026-01-05T08:54:00.000Z",
     "herdrTabId": null,
     "archived": false,
     "createdAt": "2026-01-04T07:00:00.000Z",
     "updatedAt": "2026-01-05T08:54:00.000Z",
     "connection": {
      "ok": true,
      "reason": null,
      "detail": null
     },
     "tidiedAt": null
    },
    "members": [
     {
      "id": "m-chief",
      "projectId": "sample-pay",
      "handle": "chief",
      "name": "Checkout Lead",
      "role": "Project lead",
      "kind": "conductor",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "claude",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": "opus",
      "appliedEffort": null,
      "status": "working",
      "now": "Turning the payment provider results and copy decisions into next steps",
      "next": "Pass your decisions on to the build staff",
      "cwd": "/Users/sample/Projects/shop-web",
      "sessionId": "00000000-0000-4000-8000-000000000001",
      "paneId": "sample:chief",
      "contextPct": 38,
      "contextWindow": 200000,
      "contextWindowSource": "statusline",
      "subagents": 0,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": null,
      "updatedAt": "2026-01-05T08:59:00.000Z",
      "createdAt": "2026-01-04T08:00:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": {
       "quality": "exact",
       "count": 0,
       "observedAt": "2026-01-05T09:00:00.000Z",
       "sessionGeneration": 0
      },
      "nowAt": "2026-01-05T08:59:00.000Z",
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null,
      "contextState": {
       "measurement": {
        "sessionId": "00000000-0000-4000-8000-000000000001",
        "sessionGeneration": 0,
        "turn": 4,
        "model": "opus",
        "tokens": 76000,
        "window": 200000,
        "source": "statusline",
        "quality": "exact",
        "measuredAt": "2026-01-05T08:59:00.000Z",
        "fresh": true
       },
       "compaction": null
      }
     },
     {
      "id": "m-pg",
      "projectId": "sample-pay",
      "handle": "pg",
      "name": "Payments Integration",
      "role": "Provider sandbox · error codes",
      "kind": "worker",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "codex",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": "gpt-6-astra",
      "appliedEffort": null,
      "status": "waiting",
      "now": "Provider sandbox — sorting out failure codes",
      "next": "Add the confirmation message once it's chosen",
      "cwd": "/Users/sample/Projects/shop-web",
      "sessionId": "00000000-0000-4000-8000-000000000002",
      "paneId": "sample:pg",
      "contextPct": 22,
      "contextWindow": 400000,
      "contextWindowSource": "codex",
      "subagents": 0,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": "2026-01-05T08:51:00.000Z",
      "updatedAt": "2026-01-05T08:51:00.000Z",
      "createdAt": "2026-01-04T08:01:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": {
       "quality": "exact",
       "count": 0,
       "observedAt": "2026-01-05T09:00:00.000Z",
       "sessionGeneration": 0
      },
      "nowAt": "2026-01-05T08:51:00.000Z",
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null,
      "contextState": {
       "measurement": {
        "sessionId": "00000000-0000-4000-8000-000000000002",
        "sessionGeneration": 0,
        "turn": 4,
        "model": "gpt-6-astra",
        "tokens": 88000,
        "window": 400000,
        "source": "codex",
        "quality": "exact",
        "measuredAt": "2026-01-05T08:51:00.000Z",
        "fresh": true
       },
       "compaction": null
      }
     },
     {
      "id": "m-copy",
      "projectId": "sample-pay",
      "handle": "copy",
      "name": "UX Copy",
      "role": "Success and failure screen copy",
      "kind": "worker",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "claude",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": "sonnet",
      "appliedEffort": null,
      "status": "working",
      "now": "Polishing the confirmation screen copy",
      "next": "Failure screen copy",
      "cwd": "/Users/sample/Projects/shop-web",
      "sessionId": "00000000-0000-4000-8000-000000000003",
      "paneId": "sample:copy",
      "contextPct": 51,
      "contextWindow": 200000,
      "contextWindowSource": "statusline",
      "subagents": 2,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": "2026-01-05T08:59:00.000Z",
      "updatedAt": "2026-01-05T08:59:30.000Z",
      "createdAt": "2026-01-04T08:02:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": {
       "quality": "exact",
       "count": 2,
       "observedAt": "2026-01-05T09:00:00.000Z",
       "sessionGeneration": 0
      },
      "nowAt": "2026-01-05T08:59:30.000Z",
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null,
      "contextState": {
       "measurement": {
        "sessionId": "00000000-0000-4000-8000-000000000003",
        "sessionGeneration": 0,
        "turn": 4,
        "model": "sonnet",
        "tokens": 102000,
        "window": 200000,
        "source": "statusline",
        "quality": "exact",
        "measuredAt": "2026-01-05T08:59:30.000Z",
        "fresh": true
       },
       "compaction": null
      }
     },
     {
      "id": "m-card",
      "projectId": "sample-pay",
      "handle": "card",
      "name": "Card Checkout",
      "role": "Card payment screen",
      "kind": "worker",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "codex",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": "gpt-6-astra",
      "appliedEffort": null,
      "status": "working",
      "now": "Building the card payment screen — wiring the pay button to input validation",
      "next": "Report back once the tests pass",
      "cwd": "/Users/sample/Projects/shop-web",
      "sessionId": "00000000-0000-4000-8000-000000000004",
      "paneId": "sample:card",
      "contextPct": 44,
      "contextWindow": 400000,
      "contextWindowSource": "codex",
      "subagents": 1,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": "2026-01-05T08:58:00.000Z",
      "updatedAt": "2026-01-05T08:58:00.000Z",
      "createdAt": "2026-01-04T08:03:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": {
       "quality": "exact",
       "count": 1,
       "observedAt": "2026-01-05T09:00:00.000Z",
       "sessionGeneration": 0
      },
      "nowAt": "2026-01-05T08:58:00.000Z",
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null,
      "contextState": {
       "measurement": {
        "sessionId": "00000000-0000-4000-8000-000000000004",
        "sessionGeneration": 0,
        "turn": 4,
        "model": "gpt-6-astra",
        "tokens": 176000,
        "window": 400000,
        "source": "codex",
        "quality": "exact",
        "measuredAt": "2026-01-05T08:58:00.000Z",
        "fresh": true
       },
       "compaction": null
      }
     },
     {
      "id": "m-research",
      "projectId": "sample-pay",
      "handle": "research",
      "name": "Research",
      "role": "Provider comparison · contract terms",
      "kind": "worker",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "claude",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": "sonnet",
      "appliedEffort": null,
      "status": "idle",
      "now": "Reported the payment provider comparison",
      "next": "Summarize contract terms once a provider is chosen",
      "cwd": "/Users/sample/Projects/shop-web",
      "sessionId": "00000000-0000-4000-8000-000000000005",
      "paneId": "sample:research",
      "contextPct": 17,
      "contextWindow": 200000,
      "contextWindowSource": "statusline",
      "subagents": 0,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": null,
      "updatedAt": "2026-01-05T08:40:00.000Z",
      "createdAt": "2026-01-04T08:04:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": {
       "quality": "exact",
       "count": 0,
       "observedAt": "2026-01-05T09:00:00.000Z",
       "sessionGeneration": 0
      },
      "nowAt": "2026-01-05T08:40:00.000Z",
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null,
      "contextState": {
       "measurement": {
        "sessionId": "00000000-0000-4000-8000-000000000005",
        "sessionGeneration": 0,
        "turn": 4,
        "model": "sonnet",
        "tokens": 34000,
        "window": 200000,
        "source": "statusline",
        "quality": "exact",
        "measuredAt": "2026-01-05T08:40:00.000Z",
        "fresh": true
       },
       "compaction": null
      }
     },
     {
      "id": "m-funnel",
      "projectId": "sample-pay",
      "handle": "funnel",
      "name": "Funnel Analytics",
      "role": "Checkout step events",
      "kind": "worker",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "codex",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": "gpt-6-astra",
      "appliedEffort": null,
      "status": "idle",
      "now": "Reported the drop-off event names for each checkout step",
      "next": "Add the events once the build is done",
      "cwd": "/Users/sample/Projects/shop-web",
      "sessionId": "00000000-0000-4000-8000-000000000006",
      "paneId": "sample:funnel",
      "contextPct": 28,
      "contextWindow": 400000,
      "contextWindowSource": "codex",
      "subagents": 0,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": null,
      "updatedAt": "2026-01-05T08:55:00.000Z",
      "createdAt": "2026-01-04T08:05:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": {
       "quality": "exact",
       "count": 0,
       "observedAt": "2026-01-05T09:00:00.000Z",
       "sessionGeneration": 0
      },
      "nowAt": "2026-01-05T08:55:00.000Z",
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null,
      "contextState": {
       "measurement": {
        "sessionId": "00000000-0000-4000-8000-000000000006",
        "sessionGeneration": 0,
        "turn": 4,
        "model": "gpt-6-astra",
        "tokens": 112000,
        "window": 400000,
        "source": "codex",
        "quality": "exact",
        "measuredAt": "2026-01-05T08:55:00.000Z",
        "fresh": true
       },
       "compaction": null
      }
     },
     {
      "id": "m-qa",
      "projectId": "sample-pay",
      "handle": "qa",
      "name": "Checkout QA",
      "role": "Regression tests",
      "kind": "worker",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "claude",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": null,
      "appliedEffort": null,
      "status": "asleep",
      "now": "",
      "next": "Run the checkout regression tests once the build is done",
      "cwd": "/Users/sample/Projects/shop-web",
      "sessionId": "00000000-0000-4000-8000-000000000007",
      "paneId": "sample:qa",
      "contextPct": null,
      "contextWindow": null,
      "contextWindowSource": null,
      "subagents": 0,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": null,
      "updatedAt": "2026-01-05T07:30:00.000Z",
      "createdAt": "2026-01-04T08:06:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": {
       "quality": "exact",
       "count": 0,
       "observedAt": "2026-01-05T09:00:00.000Z",
       "sessionGeneration": 0
      },
      "nowAt": null,
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null
     },
     {
      "id": "m-mail",
      "projectId": "sample-pay",
      "handle": "mail",
      "name": "Receipt Email",
      "role": "Order confirmation email",
      "kind": "worker",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "claude",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": "sonnet",
      "appliedEffort": null,
      "status": "idle",
      "now": "Reported the first draft of the receipt email template",
      "next": "",
      "cwd": "/Users/sample/Projects/shop-web",
      "sessionId": "00000000-0000-4000-8000-000000000008",
      "paneId": "sample:mail",
      "contextPct": 12,
      "contextWindow": 200000,
      "contextWindowSource": "statusline",
      "subagents": 0,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": null,
      "updatedAt": "2026-01-05T08:30:00.000Z",
      "createdAt": "2026-01-04T08:07:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": {
       "quality": "exact",
       "count": 0,
       "observedAt": "2026-01-05T09:00:00.000Z",
       "sessionGeneration": 0
      },
      "nowAt": "2026-01-05T08:30:00.000Z",
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null,
      "contextState": {
       "measurement": {
        "sessionId": "00000000-0000-4000-8000-000000000008",
        "sessionGeneration": 0,
        "turn": 4,
        "model": "sonnet",
        "tokens": 24000,
        "window": 200000,
        "source": "statusline",
        "quality": "exact",
        "measuredAt": "2026-01-05T08:30:00.000Z",
        "fresh": true
       },
       "compaction": null
      }
     },
     {
      "id": "m-settle",
      "projectId": "sample-pay",
      "handle": "settle",
      "name": "Settlement Reports",
      "role": "Daily settlement summary",
      "kind": "worker",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "codex",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": null,
      "appliedEffort": null,
      "status": "asleep",
      "now": "Reported last week's settlement summary",
      "next": "",
      "cwd": "/Users/sample/Projects/shop-web",
      "sessionId": "00000000-0000-4000-8000-000000000009",
      "paneId": "sample:settle",
      "contextPct": null,
      "contextWindow": null,
      "contextWindowSource": null,
      "subagents": 0,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": null,
      "updatedAt": "2026-01-04T13:00:00.000Z",
      "createdAt": "2026-01-04T08:08:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": {
       "quality": "exact",
       "count": 0,
       "observedAt": "2026-01-05T09:00:00.000Z",
       "sessionGeneration": 0
      },
      "nowAt": "2026-01-04T13:00:00.000Z",
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null
     }
    ],
    "decisions": [
     {
      "id": "d-pg",
      "projectId": "sample-pay",
      "memberId": "m-research",
      "who": "Research",
      "title": "Which payment provider should we use?",
      "detail": "We need to pick one provider before the integration can start. The comparison is in Files.\n\n- \"Did my payment go through?\" is our most common support question, so faster payouts and notifications help\n- Our current Adyen contract ends next March",
      "options": [
       {
        "k": "a",
        "label": "Stripe",
        "desc": "2.9% fee, payout in 2 days. The best documentation, so the build is two days faster."
       },
       {
        "k": "b",
        "label": "Adyen",
        "desc": "2.7% fee, payout in 3 days. Keeps our existing contract."
       },
       {
        "k": "c",
        "label": "Integrate both and compare",
        "desc": "Adds 3 days to the build. We pick by conversion rate after 2 weeks."
       }
      ],
      "rec": "a",
      "group": null,
      "fileId": "f-fee",
      "images": [],
      "status": "open",
      "choice": null,
      "note": null,
      "batch": false,
      "createdAt": "2026-01-05T08:35:00.000Z",
      "answeredAt": null,
      "deliveredAt": null,
      "updatedAt": "2026-01-05T08:35:00.000Z",
      "lastChoice": null,
      "lastNote": null,
      "reopenNote": null,
      "closeKind": null,
      "closeReason": null,
      "closeQuote": null,
      "closedBy": null,
      "closedAt": null
     },
     {
      "id": "d-done-copy",
      "projectId": "sample-pay",
      "memberId": "m-pg",
      "who": "Payments Integration",
      "title": "Pick the payment confirmation message",
      "detail": "This is the first line on the confirmation screen. People need to see right away that the payment worked.",
      "options": [
       {
        "k": "a",
        "label": "Payment complete",
        "desc": "States the result right away. The receipt link goes below it."
       },
       {
        "k": "b",
        "label": "Thank you",
        "desc": "Friendly, but less clear about whether the payment worked."
       }
      ],
      "rec": "a",
      "group": null,
      "fileId": "f-copy",
      "images": [],
      "status": "open",
      "choice": null,
      "note": null,
      "batch": false,
      "createdAt": "2026-01-05T08:48:00.000Z",
      "answeredAt": null,
      "deliveredAt": null,
      "updatedAt": "2026-01-05T08:48:00.000Z",
      "lastChoice": null,
      "lastNote": null,
      "reopenNote": null,
      "closeKind": null,
      "closeReason": null,
      "closeQuote": null,
      "closedBy": null,
      "closedAt": null
     },
     {
      "id": "d-fail-copy",
      "projectId": "sample-pay",
      "memberId": "m-copy",
      "who": "UX Copy",
      "title": "Pick the failure message",
      "detail": "This is the first line on the failure screen. The most common causes are a maxed-out card and a canceled verification step.",
      "options": [
       {
        "k": "a",
        "label": "Please try again",
        "desc": "Doesn't say why, so people may hit the same failure again."
       },
       {
        "k": "b",
        "label": "Please check your card",
        "desc": "Points straight to the most common cause."
       }
      ],
      "rec": "b",
      "group": null,
      "fileId": null,
      "images": [],
      "status": "delivered",
      "choice": "b",
      "note": "Show the support number as well.",
      "batch": false,
      "createdAt": "2026-01-05T08:05:00.000Z",
      "answeredAt": "2026-01-05T08:51:00.000Z",
      "deliveredAt": "2026-01-05T08:52:00.000Z",
      "updatedAt": "2026-01-05T08:52:00.000Z",
      "lastChoice": null,
      "lastNote": null,
      "reopenNote": null,
      "closeKind": null,
      "closeReason": null,
      "closeQuote": null,
      "closedBy": null,
      "closedAt": null
     },
     {
      "id": "d-receipt",
      "projectId": "sample-pay",
      "memberId": "m-pg",
      "who": "Payments Integration",
      "title": "Should we send a receipt email?",
      "detail": "Decide whether a receipt email goes out automatically right after payment.",
      "options": [
       {
        "k": "a",
        "label": "Send it"
       },
       {
        "k": "b",
        "label": "Don't send it"
       }
      ],
      "rec": null,
      "group": null,
      "fileId": null,
      "images": [],
      "status": "delivered",
      "choice": "a",
      "note": null,
      "batch": false,
      "createdAt": "2026-01-05T08:10:00.000Z",
      "answeredAt": "2026-01-05T08:28:00.000Z",
      "deliveredAt": "2026-01-05T08:29:00.000Z",
      "updatedAt": "2026-01-05T08:29:00.000Z",
      "lastChoice": null,
      "lastNote": null,
      "reopenNote": null,
      "closeKind": null,
      "closeReason": null,
      "closeQuote": null,
      "closedBy": null,
      "closedAt": null
     },
     {
      "id": "d-button",
      "projectId": "sample-pay",
      "memberId": "m-card",
      "who": "Card Checkout",
      "title": "Pick a color for the pay button",
      "detail": "It's either our brand purple or the default blue.",
      "options": [
       {
        "k": "a",
        "label": "Default blue"
       },
       {
        "k": "b",
        "label": "Brand purple"
       }
      ],
      "rec": "a",
      "group": null,
      "fileId": null,
      "images": [],
      "status": "delivered",
      "choice": "a",
      "note": "Make sure it meets the accessibility contrast guidelines.",
      "batch": false,
      "createdAt": "2026-01-05T06:00:00.000Z",
      "answeredAt": "2026-01-05T07:00:00.000Z",
      "deliveredAt": "2026-01-05T07:01:00.000Z",
      "updatedAt": "2026-01-05T07:01:00.000Z",
      "lastChoice": null,
      "lastNote": null,
      "reopenNote": null,
      "closeKind": null,
      "closeReason": null,
      "closeQuote": null,
      "closedBy": null,
      "closedAt": null
     },
     {
      "id": "d-old",
      "projectId": "sample-pay",
      "memberId": "m-research",
      "who": "Research",
      "title": "Should we add PayPal to the comparison?",
      "detail": "Only if we need international payments.",
      "options": [],
      "rec": null,
      "group": null,
      "fileId": null,
      "images": [],
      "status": "closed",
      "choice": null,
      "note": null,
      "batch": false,
      "createdAt": "2026-01-05T04:00:00.000Z",
      "answeredAt": null,
      "deliveredAt": null,
      "updatedAt": "2026-01-05T05:00:00.000Z",
      "lastChoice": null,
      "lastNote": null,
      "reopenNote": null,
      "closeKind": "decided",
      "closeReason": "We agreed in chat to handle domestic payments only.",
      "closeQuote": "Let's leave international payments out this time",
      "closedBy": "Research",
      "closedAt": "2026-01-05T05:00:00.000Z"
     }
    ],
    "doneDecisionCount": 4,
    "todos": [
     {
      "id": "t-done",
      "projectId": "sample-pay",
      "memberId": null,
      "who": "Checkout Lead",
      "title": "Share the payment provider's contact",
      "detail": "",
      "done": true,
      "doneAt": "2026-01-05T06:00:00.000Z",
      "createdAt": "2026-01-05T04:00:00.000Z",
      "completionNote": null,
      "completionFileIds": [],
      "outcome": "done",
      "closeReason": null,
      "closedBy": null
     },
     {
      "id": "t-policy",
      "projectId": "sample-pay",
      "memberId": "m-research",
      "who": "Research",
      "title": "Review the privacy policy",
      "detail": "Please check the wording on how long we keep payment data against our legal guidelines.",
      "done": false,
      "doneAt": null,
      "createdAt": "2026-01-05T07:00:00.000Z",
      "completionNote": null,
      "completionFileIds": [],
      "outcome": null,
      "closeReason": null,
      "closedBy": null
     },
     {
      "id": "t-key",
      "projectId": "sample-pay",
      "memberId": "m-card",
      "who": "Card Checkout",
      "title": "Set up a payment sandbox account",
      "detail": "We need test keys from the Stripe dashboard. Once you have them, send them to me in Chat.",
      "done": false,
      "doneAt": null,
      "createdAt": "2026-01-05T08:30:00.000Z",
      "completionNote": null,
      "completionFileIds": [],
      "outcome": null,
      "closeReason": null,
      "closedBy": null
     },
     {
      "id": "t-logo",
      "projectId": "sample-pay",
      "memberId": "m-pg",
      "who": "Payments Integration",
      "title": "Send the original logo file",
      "detail": "We need the logo for the confirmation screen.\n- SVG if you have it\n- Otherwise PNG",
      "done": false,
      "doneAt": null,
      "createdAt": "2026-01-05T08:42:00.000Z",
      "completionNote": null,
      "completionFileIds": [],
      "outcome": null,
      "closeReason": null,
      "closedBy": null
     }
    ],
    "work": [
     {
      "id": "w9",
      "projectId": "sample-pay",
      "sec": "done",
      "title": "List the payment methods",
      "detail": "",
      "who": "Checkout Lead",
      "order": 1,
      "doneAt": "2026-01-04T07:00:00.000Z",
      "createdAt": "2026-01-04T07:00:00.000Z",
      "updatedAt": "2026-01-04T07:00:00.000Z"
     },
     {
      "id": "w8",
      "projectId": "sample-pay",
      "sec": "done",
      "title": "Receipt email template",
      "detail": "",
      "who": "Receipt Email",
      "order": 2,
      "doneAt": "2026-01-05T08:30:00.000Z",
      "createdAt": "2026-01-05T08:30:00.000Z",
      "updatedAt": "2026-01-05T08:30:00.000Z"
     },
     {
      "id": "w7",
      "projectId": "sample-pay",
      "sec": "done",
      "title": "Payment provider comparison",
      "detail": "",
      "who": "Research",
      "order": 3,
      "doneAt": "2026-01-05T08:40:00.000Z",
      "createdAt": "2026-01-05T08:40:00.000Z",
      "updatedAt": "2026-01-05T08:40:00.000Z"
     },
     {
      "id": "w1",
      "projectId": "sample-pay",
      "sec": "doing",
      "title": "Provider sandbox integration",
      "detail": "Sorting out the failure response codes",
      "who": "Payments Integration",
      "order": 4,
      "doneAt": null,
      "createdAt": "2026-01-05T08:20:00.000Z",
      "updatedAt": "2026-01-05T08:20:00.000Z"
     },
     {
      "id": "w2",
      "projectId": "sample-pay",
      "sec": "doing",
      "title": "Success and failure screen copy",
      "detail": "",
      "who": "UX Copy",
      "order": 5,
      "doneAt": null,
      "createdAt": "2026-01-05T08:21:00.000Z",
      "updatedAt": "2026-01-05T08:21:00.000Z"
     },
     {
      "id": "w3",
      "projectId": "sample-pay",
      "sec": "doing",
      "title": "Build the card payment screen",
      "detail": "Connect the pay button and input validation",
      "who": "Card Checkout",
      "order": 6,
      "doneAt": null,
      "createdAt": "2026-01-05T08:22:00.000Z",
      "updatedAt": "2026-01-05T08:22:00.000Z"
     },
     {
      "id": "w4",
      "projectId": "sample-pay",
      "sec": "next",
      "title": "Add drop-off tracking",
      "detail": "",
      "who": "Funnel Analytics",
      "order": 7,
      "doneAt": null,
      "createdAt": "2026-01-05T08:23:00.000Z",
      "updatedAt": "2026-01-05T08:23:00.000Z"
     },
     {
      "id": "w5",
      "projectId": "sample-pay",
      "sec": "next",
      "title": "Checkout regression tests",
      "detail": "",
      "who": "Checkout QA",
      "order": 8,
      "doneAt": null,
      "createdAt": "2026-01-05T08:24:00.000Z",
      "updatedAt": "2026-01-05T08:24:00.000Z"
     },
     {
      "id": "w6",
      "projectId": "sample-pay",
      "sec": "hold",
      "title": "Add Apple Pay and Google Pay",
      "detail": "Resumes after the provider decision",
      "who": "Checkout Lead",
      "order": 9,
      "doneAt": null,
      "createdAt": "2026-01-05T08:25:00.000Z",
      "updatedAt": "2026-01-05T08:25:00.000Z"
     }
    ],
    "messages": [
     {
      "id": "x1",
      "projectId": "sample-pay",
      "at": "2026-01-05T08:20:00.000Z",
      "mine": false,
      "memberId": "m-chief",
      "who": "Checkout Lead",
      "kind": "진행",
      "title": "Today's plan",
      "body": "1. Get a decision on the payment provider\n2. Lock in the success and failure copy\n3. Get the card payment screen through its tests",
      "targetMemberId": null,
      "targetName": null,
      "decisionId": null,
      "fileId": null,
      "attachments": [],
      "delivery": null,
      "deliveryNote": null,
      "deliveryRevision": 0,
      "contextFileId": null,
      "fileIds": [],
      "supersedes": null,
      "supersededBy": null
     },
     {
      "id": "x2",
      "projectId": "sample-pay",
      "at": "2026-01-05T08:22:00.000Z",
      "mine": true,
      "memberId": null,
      "who": "나",
      "kind": "나",
      "title": "",
      "body": "Please finish the payment provider integration this week.",
      "targetMemberId": null,
      "targetName": null,
      "decisionId": null,
      "fileId": null,
      "attachments": [],
      "delivery": "delivered",
      "deliveryNote": null,
      "deliveryRevision": 0,
      "contextFileId": null,
      "fileIds": [],
      "supersedes": null,
      "supersededBy": null
     },
     {
      "id": "x3",
      "projectId": "sample-pay",
      "at": "2026-01-05T08:40:00.000Z",
      "mine": false,
      "memberId": "m-research",
      "who": "Research",
      "kind": "완료",
      "title": "The payment provider comparison is up",
      "body": "I compared fees, payout timing and integration effort. The provider decision is waiting in your Inbox.",
      "targetMemberId": null,
      "targetName": null,
      "decisionId": null,
      "fileId": "f-fee",
      "attachments": [],
      "delivery": null,
      "deliveryNote": null,
      "deliveryRevision": 0,
      "contextFileId": null,
      "fileIds": [
       "f-fee"
      ],
      "supersedes": null,
      "supersededBy": null
     },
     {
      "id": "x4",
      "projectId": "sample-pay",
      "at": "2026-01-05T08:46:00.000Z",
      "mine": false,
      "memberId": "m-card",
      "who": "Card Checkout",
      "kind": "진행",
      "title": "Card payment screen, first pass",
      "body": "- Card number and expiry validation\n- Pay button states (ready, processing, done)\n- Next: connect the pay button to the provider sandbox",
      "targetMemberId": null,
      "targetName": null,
      "decisionId": null,
      "fileId": null,
      "attachments": [],
      "delivery": null,
      "deliveryNote": null,
      "deliveryRevision": 0,
      "contextFileId": null,
      "fileIds": [],
      "supersedes": null,
      "supersededBy": null
     },
     {
      "id": "x5",
      "projectId": "sample-pay",
      "at": "2026-01-05T08:48:00.000Z",
      "mine": false,
      "memberId": "m-pg",
      "who": "Payments Integration",
      "kind": "질문",
      "title": "Need your call on the confirmation message",
      "body": "Please pick one of the two options.",
      "targetMemberId": null,
      "targetName": null,
      "decisionId": "d-done-copy",
      "fileId": null,
      "attachments": [],
      "delivery": null,
      "deliveryNote": null,
      "deliveryRevision": 0,
      "contextFileId": null,
      "fileIds": [],
      "supersedes": null,
      "supersededBy": null
     },
     {
      "id": "x6",
      "projectId": "sample-pay",
      "at": "2026-01-05T08:52:00.000Z",
      "mine": true,
      "memberId": null,
      "who": "나",
      "kind": "나",
      "title": "",
      "body": "Add the support number to the failure screen too.",
      "targetMemberId": "m-copy",
      "targetName": "UX Copy",
      "decisionId": null,
      "fileId": null,
      "attachments": [],
      "delivery": "delivered",
      "deliveryNote": null,
      "deliveryRevision": 0,
      "contextFileId": null,
      "fileIds": [],
      "supersedes": null,
      "supersededBy": null
     },
     {
      "id": "x7",
      "projectId": "sample-pay",
      "at": "2026-01-05T08:53:00.000Z",
      "mine": true,
      "memberId": null,
      "who": "나",
      "kind": "나",
      "title": "",
      "body": "Start by settling the drop-off event names.",
      "targetMemberId": "m-funnel",
      "targetName": "Funnel Analytics",
      "decisionId": null,
      "fileId": null,
      "attachments": [],
      "delivery": "delivered",
      "deliveryNote": null,
      "deliveryRevision": 0,
      "contextFileId": null,
      "fileIds": [],
      "supersedes": null,
      "supersededBy": null
     },
     {
      "id": "x11",
      "projectId": "sample-pay",
      "at": "2026-01-05T08:55:00.000Z",
      "mine": false,
      "memberId": "m-funnel",
      "who": "Funnel Analytics",
      "kind": "완료",
      "title": "The drop-off event names are settled",
      "body": "I named the events and their properties for all four steps: cart → order details → payment method → payment complete. The drop-off table for the last 4 weeks is in Files.",
      "targetMemberId": null,
      "targetName": null,
      "decisionId": null,
      "fileId": "f-funnel",
      "attachments": [],
      "delivery": null,
      "deliveryNote": null,
      "deliveryRevision": 0,
      "contextFileId": null,
      "fileIds": [
       "f-funnel"
      ],
      "supersedes": null,
      "supersededBy": null
     },
     {
      "id": "x8",
      "projectId": "sample-pay",
      "at": "2026-01-05T08:56:00.000Z",
      "mine": false,
      "memberId": "m-copy",
      "who": "UX Copy",
      "kind": "진행",
      "title": "Draft confirmation screen copy",
      "body": "- One short line\n- One line on what to do next\n- The receipt link as a button",
      "targetMemberId": null,
      "targetName": null,
      "decisionId": null,
      "fileId": null,
      "attachments": [],
      "delivery": null,
      "deliveryNote": null,
      "deliveryRevision": 0,
      "contextFileId": null,
      "fileIds": [],
      "supersedes": null,
      "supersededBy": null
     },
     {
      "id": "x9",
      "projectId": "sample-pay",
      "at": "2026-01-05T08:58:00.000Z",
      "mine": true,
      "memberId": null,
      "who": "나",
      "kind": "나",
      "title": "",
      "body": "Pin the pay button to the bottom of the screen.",
      "targetMemberId": "m-card",
      "targetName": "Card Checkout",
      "decisionId": null,
      "fileId": null,
      "attachments": [],
      "delivery": "delivered",
      "deliveryNote": null,
      "deliveryRevision": 0,
      "contextFileId": null,
      "fileIds": [],
      "supersedes": null,
      "supersededBy": null
     },
     {
      "id": "x10",
      "projectId": "sample-pay",
      "at": "2026-01-05T08:59:00.000Z",
      "mine": true,
      "memberId": null,
      "who": "나",
      "kind": "나",
      "title": "",
      "body": "I'll decide on the copy this afternoon.",
      "targetMemberId": null,
      "targetName": null,
      "decisionId": null,
      "fileId": null,
      "attachments": [],
      "delivery": "delivered",
      "deliveryNote": null,
      "deliveryRevision": 0,
      "contextFileId": null,
      "fileIds": [],
      "supersedes": null,
      "supersededBy": null
     }
    ],
    "files": [
     {
      "id": "f-copy",
      "kind": "artifact",
      "projectId": "sample-pay",
      "title": "Success and failure screen mockups",
      "who": "UX Copy",
      "memberId": "m-copy",
      "summary": "An HTML mockup comparing two success screens and two failure screens side by side",
      "body": "",
      "path": null,
      "attachments": [],
      "createdAt": "2026-01-05T08:56:00.000Z",
      "order": 5
     },
     {
      "id": "f-fee",
      "kind": "document",
      "projectId": "sample-pay",
      "title": "Payment provider fee comparison",
      "who": "Research",
      "memberId": "m-research",
      "summary": "Compares Stripe and Adyen on fees, payout timing and integration effort.",
      "body": "# Payment provider fee comparison\n\n## Summary\nStripe is ahead on documentation and payout speed. Adyen's quoted rate is 0.2 points lower.\n\n## Comparison\n| Provider | Fee | Payout | Integration |\n|---|---:|:-:|---|\n| Stripe | 2.9% | 2 days | Test keys right away, full `sandbox` |\n| Adyen | 2.7% | 3 days | Existing contract, test keys in 2–3 days |\n\n> Orders between $10 and $50 make up 70% of all payments.\n\n## Still to check\n- [x] Payout timing\n- [ ] Whether wallet payments carry a separate fee\n- [ ] Early termination fee\n",
      "path": null,
      "attachments": [],
      "createdAt": "2026-01-05T08:40:00.000Z",
      "order": 4
     },
     {
      "id": "f-config",
      "kind": "code",
      "projectId": "sample-pay",
      "title": "payment-config.ts",
      "who": "Card Checkout",
      "memberId": "m-card",
      "summary": "Payment provider key and payment methods",
      "body": "export const payment = {\n  provider: process.env.PAYMENT_PROVIDER ?? \"stripe\",\n  methods: [\"card\", \"apple-pay\", \"google-pay\"],\n  retry: { max: 2, backoffMs: 800 },\n}\n",
      "path": "src/payment/payment-config.ts",
      "attachments": [],
      "createdAt": "2026-01-05T08:25:00.000Z",
      "order": 3
     },
     {
      "id": "f-funnel",
      "kind": "table",
      "projectId": "sample-pay",
      "title": "Checkout drop-off by step",
      "who": "Funnel Analytics",
      "memberId": "m-funnel",
      "summary": "Drop-off at each checkout step over the last 4 weeks",
      "body": "Step,Visits,Drop-off\nCart,12840,18%\nOrder details,10529,24%\nPayment method,8002,31%\nPayment complete,5521,-",
      "path": null,
      "attachments": [],
      "createdAt": "2026-01-04T11:00:00.000Z",
      "order": 2
     },
     {
      "id": "f-shot",
      "kind": "image",
      "projectId": "sample-pay",
      "title": "Current pay button screenshot",
      "who": "Card Checkout",
      "memberId": "m-card",
      "summary": "How the mobile pay button looks today",
      "body": "",
      "path": null,
      "attachments": [
       {
        "id": "a-shot",
        "name": "payment-button.png",
        "mime": "image/png",
        "size": 2357,
        "url": "/files/a-shot/payment-button.png",
        "path": "/Users/sample/iamceo/uploads/a-shot/payment-button.png",
        "isImage": true
       }
      ],
      "createdAt": "2026-01-04T08:00:00.000Z",
      "order": 1
     }
    ],
    "deliveryNotices": {
     "version": 2,
     "unassignedItems": [],
     "reportNotices": [],
     "members": [
      {
       "memberId": "m-chief",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      },
      {
       "memberId": "m-pg",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      },
      {
       "memberId": "m-copy",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      },
      {
       "memberId": "m-card",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      },
      {
       "memberId": "m-research",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      },
      {
       "memberId": "m-funnel",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      },
      {
       "memberId": "m-qa",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      },
      {
       "memberId": "m-mail",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      },
      {
       "memberId": "m-settle",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      }
     ],
     "unassigned": {
      "undeliveredCount": 0,
      "unknownCount": 0,
      "needsOwnerCount": 0
     }
    }
   },
   "revisions": {
    "settings": 1,
    "members": {
     "m-card": {
      "configRevision": 0,
      "sessionGeneration": 0
     },
     "m-chief": {
      "configRevision": 0,
      "sessionGeneration": 0
     },
     "m-copy": {
      "configRevision": 0,
      "sessionGeneration": 0
     },
     "m-funnel": {
      "configRevision": 0,
      "sessionGeneration": 0
     },
     "m-mail": {
      "configRevision": 0,
      "sessionGeneration": 0
     },
     "m-pg": {
      "configRevision": 0,
      "sessionGeneration": 0
     },
     "m-qa": {
      "configRevision": 0,
      "sessionGeneration": 0
     },
     "m-research": {
      "configRevision": 0,
      "sessionGeneration": 0
     },
     "m-settle": {
      "configRevision": 0,
      "sessionGeneration": 0
     }
    },
    "todos": {
     "t-policy": 0,
     "t-key": 0,
     "t-logo": 0,
     "t-done": 1
    }
   },
   "messages": [
    {
     "id": "x1",
     "projectId": "sample-pay",
     "at": "2026-01-05T08:20:00.000Z",
     "mine": false,
     "memberId": "m-chief",
     "who": "Checkout Lead",
     "kind": "진행",
     "title": "Today's plan",
     "body": "1. Get a decision on the payment provider\n2. Lock in the success and failure copy\n3. Get the card payment screen through its tests",
     "targetMemberId": null,
     "targetName": null,
     "decisionId": null,
     "fileId": null,
     "attachments": [],
     "delivery": null,
     "deliveryNote": null,
     "deliveryRevision": 0,
     "contextFileId": null,
     "fileIds": [],
     "supersedes": null,
     "supersededBy": null
    },
    {
     "id": "x2",
     "projectId": "sample-pay",
     "at": "2026-01-05T08:22:00.000Z",
     "mine": true,
     "memberId": null,
     "who": "나",
     "kind": "나",
     "title": "",
     "body": "Please finish the payment provider integration this week.",
     "targetMemberId": null,
     "targetName": null,
     "decisionId": null,
     "fileId": null,
     "attachments": [],
     "delivery": "delivered",
     "deliveryNote": null,
     "deliveryRevision": 0,
     "contextFileId": null,
     "fileIds": [],
     "supersedes": null,
     "supersededBy": null
    },
    {
     "id": "x3",
     "projectId": "sample-pay",
     "at": "2026-01-05T08:40:00.000Z",
     "mine": false,
     "memberId": "m-research",
     "who": "Research",
     "kind": "완료",
     "title": "The payment provider comparison is up",
     "body": "I compared fees, payout timing and integration effort. The provider decision is waiting in your Inbox.",
     "targetMemberId": null,
     "targetName": null,
     "decisionId": null,
     "fileId": "f-fee",
     "attachments": [],
     "delivery": null,
     "deliveryNote": null,
     "deliveryRevision": 0,
     "contextFileId": null,
     "fileIds": [
      "f-fee"
     ],
     "supersedes": null,
     "supersededBy": null
    },
    {
     "id": "x4",
     "projectId": "sample-pay",
     "at": "2026-01-05T08:46:00.000Z",
     "mine": false,
     "memberId": "m-card",
     "who": "Card Checkout",
     "kind": "진행",
     "title": "Card payment screen, first pass",
     "body": "- Card number and expiry validation\n- Pay button states (ready, processing, done)\n- Next: connect the pay button to the provider sandbox",
     "targetMemberId": null,
     "targetName": null,
     "decisionId": null,
     "fileId": null,
     "attachments": [],
     "delivery": null,
     "deliveryNote": null,
     "deliveryRevision": 0,
     "contextFileId": null,
     "fileIds": [],
     "supersedes": null,
     "supersededBy": null
    },
    {
     "id": "x5",
     "projectId": "sample-pay",
     "at": "2026-01-05T08:48:00.000Z",
     "mine": false,
     "memberId": "m-pg",
     "who": "Payments Integration",
     "kind": "질문",
     "title": "Need your call on the confirmation message",
     "body": "Please pick one of the two options.",
     "targetMemberId": null,
     "targetName": null,
     "decisionId": "d-done-copy",
     "fileId": null,
     "attachments": [],
     "delivery": null,
     "deliveryNote": null,
     "deliveryRevision": 0,
     "contextFileId": null,
     "fileIds": [],
     "supersedes": null,
     "supersededBy": null
    },
    {
     "id": "x6",
     "projectId": "sample-pay",
     "at": "2026-01-05T08:52:00.000Z",
     "mine": true,
     "memberId": null,
     "who": "나",
     "kind": "나",
     "title": "",
     "body": "Add the support number to the failure screen too.",
     "targetMemberId": "m-copy",
     "targetName": "UX Copy",
     "decisionId": null,
     "fileId": null,
     "attachments": [],
     "delivery": "delivered",
     "deliveryNote": null,
     "deliveryRevision": 0,
     "contextFileId": null,
     "fileIds": [],
     "supersedes": null,
     "supersededBy": null
    },
    {
     "id": "x7",
     "projectId": "sample-pay",
     "at": "2026-01-05T08:53:00.000Z",
     "mine": true,
     "memberId": null,
     "who": "나",
     "kind": "나",
     "title": "",
     "body": "Start by settling the drop-off event names.",
     "targetMemberId": "m-funnel",
     "targetName": "Funnel Analytics",
     "decisionId": null,
     "fileId": null,
     "attachments": [],
     "delivery": "delivered",
     "deliveryNote": null,
     "deliveryRevision": 0,
     "contextFileId": null,
     "fileIds": [],
     "supersedes": null,
     "supersededBy": null
    },
    {
     "id": "x11",
     "projectId": "sample-pay",
     "at": "2026-01-05T08:55:00.000Z",
     "mine": false,
     "memberId": "m-funnel",
     "who": "Funnel Analytics",
     "kind": "완료",
     "title": "The drop-off event names are settled",
     "body": "I named the events and their properties for all four steps: cart → order details → payment method → payment complete. The drop-off table for the last 4 weeks is in Files.",
     "targetMemberId": null,
     "targetName": null,
     "decisionId": null,
     "fileId": "f-funnel",
     "attachments": [],
     "delivery": null,
     "deliveryNote": null,
     "deliveryRevision": 0,
     "contextFileId": null,
     "fileIds": [
      "f-funnel"
     ],
     "supersedes": null,
     "supersededBy": null
    },
    {
     "id": "x8",
     "projectId": "sample-pay",
     "at": "2026-01-05T08:56:00.000Z",
     "mine": false,
     "memberId": "m-copy",
     "who": "UX Copy",
     "kind": "진행",
     "title": "Draft confirmation screen copy",
     "body": "- One short line\n- One line on what to do next\n- The receipt link as a button",
     "targetMemberId": null,
     "targetName": null,
     "decisionId": null,
     "fileId": null,
     "attachments": [],
     "delivery": null,
     "deliveryNote": null,
     "deliveryRevision": 0,
     "contextFileId": null,
     "fileIds": [],
     "supersedes": null,
     "supersededBy": null
    },
    {
     "id": "x9",
     "projectId": "sample-pay",
     "at": "2026-01-05T08:58:00.000Z",
     "mine": true,
     "memberId": null,
     "who": "나",
     "kind": "나",
     "title": "",
     "body": "Pin the pay button to the bottom of the screen.",
     "targetMemberId": "m-card",
     "targetName": "Card Checkout",
     "decisionId": null,
     "fileId": null,
     "attachments": [],
     "delivery": "delivered",
     "deliveryNote": null,
     "deliveryRevision": 0,
     "contextFileId": null,
     "fileIds": [],
     "supersedes": null,
     "supersededBy": null
    },
    {
     "id": "x10",
     "projectId": "sample-pay",
     "at": "2026-01-05T08:59:00.000Z",
     "mine": true,
     "memberId": null,
     "who": "나",
     "kind": "나",
     "title": "",
     "body": "I'll decide on the copy this afternoon.",
     "targetMemberId": null,
     "targetName": null,
     "decisionId": null,
     "fileId": null,
     "attachments": [],
     "delivery": "delivered",
     "deliveryNote": null,
     "deliveryRevision": 0,
     "contextFileId": null,
     "fileIds": [],
     "supersedes": null,
     "supersededBy": null
    }
   ],
   "decisionsDone": [
    {
     "id": "d-fail-copy",
     "projectId": "sample-pay",
     "memberId": "m-copy",
     "who": "UX Copy",
     "title": "Pick the failure message",
     "detail": "This is the first line on the failure screen. The most common causes are a maxed-out card and a canceled verification step.",
     "options": [
      {
       "k": "a",
       "label": "Please try again",
       "desc": "Doesn't say why, so people may hit the same failure again."
      },
      {
       "k": "b",
       "label": "Please check your card",
       "desc": "Points straight to the most common cause."
      }
     ],
     "rec": "b",
     "group": null,
     "fileId": null,
     "images": [],
     "status": "delivered",
     "choice": "b",
     "note": "Show the support number as well.",
     "batch": false,
     "createdAt": "2026-01-05T08:05:00.000Z",
     "answeredAt": "2026-01-05T08:51:00.000Z",
     "deliveredAt": "2026-01-05T08:52:00.000Z",
     "updatedAt": "2026-01-05T08:52:00.000Z",
     "lastChoice": null,
     "lastNote": null,
     "reopenNote": null,
     "closeKind": null,
     "closeReason": null,
     "closeQuote": null,
     "closedBy": null,
     "closedAt": null
    },
    {
     "id": "d-receipt",
     "projectId": "sample-pay",
     "memberId": "m-pg",
     "who": "Payments Integration",
     "title": "Should we send a receipt email?",
     "detail": "Decide whether a receipt email goes out automatically right after payment.",
     "options": [
      {
       "k": "a",
       "label": "Send it"
      },
      {
       "k": "b",
       "label": "Don't send it"
      }
     ],
     "rec": null,
     "group": null,
     "fileId": null,
     "images": [],
     "status": "delivered",
     "choice": "a",
     "note": null,
     "batch": false,
     "createdAt": "2026-01-05T08:10:00.000Z",
     "answeredAt": "2026-01-05T08:28:00.000Z",
     "deliveredAt": "2026-01-05T08:29:00.000Z",
     "updatedAt": "2026-01-05T08:29:00.000Z",
     "lastChoice": null,
     "lastNote": null,
     "reopenNote": null,
     "closeKind": null,
     "closeReason": null,
     "closeQuote": null,
     "closedBy": null,
     "closedAt": null
    },
    {
     "id": "d-button",
     "projectId": "sample-pay",
     "memberId": "m-card",
     "who": "Card Checkout",
     "title": "Pick a color for the pay button",
     "detail": "It's either our brand purple or the default blue.",
     "options": [
      {
       "k": "a",
       "label": "Default blue"
      },
      {
       "k": "b",
       "label": "Brand purple"
      }
     ],
     "rec": "a",
     "group": null,
     "fileId": null,
     "images": [],
     "status": "delivered",
     "choice": "a",
     "note": "Make sure it meets the accessibility contrast guidelines.",
     "batch": false,
     "createdAt": "2026-01-05T06:00:00.000Z",
     "answeredAt": "2026-01-05T07:00:00.000Z",
     "deliveredAt": "2026-01-05T07:01:00.000Z",
     "updatedAt": "2026-01-05T07:01:00.000Z",
     "lastChoice": null,
     "lastNote": null,
     "reopenNote": null,
     "closeKind": null,
     "closeReason": null,
     "closeQuote": null,
     "closedBy": null,
     "closedAt": null
    },
    {
     "id": "d-old",
     "projectId": "sample-pay",
     "memberId": "m-research",
     "who": "Research",
     "title": "Should we add PayPal to the comparison?",
     "detail": "Only if we need international payments.",
     "options": [],
     "rec": null,
     "group": null,
     "fileId": null,
     "images": [],
     "status": "closed",
     "choice": null,
     "note": null,
     "batch": false,
     "createdAt": "2026-01-05T04:00:00.000Z",
     "answeredAt": null,
     "deliveredAt": null,
     "updatedAt": "2026-01-05T05:00:00.000Z",
     "lastChoice": null,
     "lastNote": null,
     "reopenNote": null,
     "closeKind": "decided",
     "closeReason": "We agreed in chat to handle domestic payments only.",
     "closeQuote": "Let's leave international payments out this time",
     "closedBy": "Research",
     "closedAt": "2026-01-05T05:00:00.000Z"
    }
   ],
   "deliveryNotices": {
    "version": 2,
    "unassignedItems": [],
    "reportNotices": [],
    "members": [
     {
      "memberId": "m-chief",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     {
      "memberId": "m-pg",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     {
      "memberId": "m-copy",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     {
      "memberId": "m-card",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     {
      "memberId": "m-research",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     {
      "memberId": "m-funnel",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     {
      "memberId": "m-qa",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     {
      "memberId": "m-mail",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     {
      "memberId": "m-settle",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     }
    ],
    "unassigned": {
     "undeliveredCount": 0,
     "unknownCount": 0,
     "needsOwnerCount": 0
    }
   },
   "activity": {
    "m-chief": [
     {
      "id": 8,
      "memberId": "m-chief",
      "at": "2026-01-05T08:59:00.000Z",
      "kind": "text",
      "text": "Planning the build order while two decisions (provider and confirmation message) wait for an answer."
     }
    ],
    "m-pg": [
     {
      "id": 9,
      "memberId": "m-pg",
      "at": "2026-01-05T08:51:00.000Z",
      "kind": "turn_end",
      "text": "Finished the failure response code table. Waiting on the confirmation message decision."
     }
    ],
    "m-copy": [
     {
      "id": 1,
      "memberId": "m-copy",
      "at": "2026-01-05T08:52:00.000Z",
      "kind": "turn_start",
      "text": "Got the instruction: add the support number to the failure screen"
     },
     {
      "id": 2,
      "memberId": "m-copy",
      "at": "2026-01-05T08:54:00.000Z",
      "kind": "tool",
      "text": "Read src/pages/checkout/complete.tsx"
     },
     {
      "id": 3,
      "memberId": "m-copy",
      "at": "2026-01-05T08:56:00.000Z",
      "kind": "text",
      "text": "Keeping 'Payment complete' as the first line of the confirmation screen and adding next steps below it."
     },
     {
      "id": 4,
      "memberId": "m-copy",
      "at": "2026-01-05T08:59:00.000Z",
      "kind": "tool",
      "text": "Edit src/pages/checkout/complete.tsx"
     }
    ],
    "m-card": [
     {
      "id": 5,
      "memberId": "m-card",
      "at": "2026-01-05T08:58:00.000Z",
      "kind": "turn_start",
      "text": "Got the instruction: pin the pay button to the bottom of the screen"
     },
     {
      "id": 6,
      "memberId": "m-card",
      "at": "2026-01-05T08:58:00.000Z",
      "kind": "tool",
      "text": "Read src/payment/PayButton.tsx"
     },
     {
      "id": 7,
      "memberId": "m-card",
      "at": "2026-01-05T08:59:00.000Z",
      "kind": "text",
      "text": "Pinning the button above the safe area so it moves up with the keyboard."
     }
    ],
    "m-research": [],
    "m-funnel": [],
    "m-qa": [],
    "m-mail": [],
    "m-settle": []
   },
   "memberNotices": {
    "m-chief": {
     "memberId": "m-chief",
     "summary": {
      "memberId": "m-chief",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    },
    "m-pg": {
     "memberId": "m-pg",
     "summary": {
      "memberId": "m-pg",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    },
    "m-copy": {
     "memberId": "m-copy",
     "summary": {
      "memberId": "m-copy",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    },
    "m-card": {
     "memberId": "m-card",
     "summary": {
      "memberId": "m-card",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    },
    "m-research": {
     "memberId": "m-research",
     "summary": {
      "memberId": "m-research",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    },
    "m-funnel": {
     "memberId": "m-funnel",
     "summary": {
      "memberId": "m-funnel",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    },
    "m-qa": {
     "memberId": "m-qa",
     "summary": {
      "memberId": "m-qa",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    },
    "m-mail": {
     "memberId": "m-mail",
     "summary": {
      "memberId": "m-mail",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    },
    "m-settle": {
     "memberId": "m-settle",
     "summary": {
      "memberId": "m-settle",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    }
   }
  },
  "sample-ir": {
   "state": {
    "project": {
     "id": "sample-ir",
     "name": "Investor Deck",
     "isHq": false,
     "cwd": "/Users/sample/Projects/ir",
     "runnerEnabled": true,
     "now": "Writing the financial summary slides",
     "creationGoal": null,
     "nowAt": "2026-01-05T07:00:00.000Z",
     "herdrTabId": null,
     "archived": false,
     "createdAt": "2026-01-04T09:00:00.000Z",
     "updatedAt": "2026-01-05T07:00:00.000Z",
     "connection": {
      "ok": true,
      "reason": null,
      "detail": null
     },
     "tidiedAt": null
    },
    "members": [
     {
      "id": "m-ir-chief",
      "projectId": "sample-ir",
      "handle": "chief",
      "name": "Deck Lead",
      "role": "Project lead",
      "kind": "conductor",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "claude",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": null,
      "appliedEffort": null,
      "status": "working",
      "now": "Deciding the order of the financial summary slides",
      "next": "",
      "cwd": "/Users/sample/Projects/ir",
      "sessionId": "00000000-0000-4000-8000-000000000010",
      "paneId": "sample:ir-chief",
      "contextPct": null,
      "contextWindow": null,
      "contextWindowSource": null,
      "subagents": 0,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": null,
      "updatedAt": "2026-01-05T07:00:00.000Z",
      "createdAt": "2026-01-04T10:00:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": null,
      "nowAt": "2026-01-05T07:00:00.000Z",
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null
     },
     {
      "id": "m-ir-deck",
      "projectId": "sample-ir",
      "handle": "deck",
      "name": "Slide Writer",
      "role": "Financial summary · market size",
      "kind": "worker",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "claude",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": null,
      "appliedEffort": null,
      "status": "idle",
      "now": "Reported the market size slide",
      "next": "",
      "cwd": "/Users/sample/Projects/ir",
      "sessionId": "00000000-0000-4000-8000-000000000011",
      "paneId": "sample:ir-deck",
      "contextPct": null,
      "contextWindow": null,
      "contextWindowSource": null,
      "subagents": 0,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": null,
      "updatedAt": "2026-01-05T07:00:00.000Z",
      "createdAt": "2026-01-04T10:01:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": null,
      "nowAt": "2026-01-05T07:00:00.000Z",
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null
     },
     {
      "id": "m-ir-num",
      "projectId": "sample-ir",
      "handle": "numbers",
      "name": "Numbers Check",
      "role": "Checking the financial tables",
      "kind": "worker",
      "origin": "runner",
      "wasAdopted": false,
      "cli": "codex",
      "backend": "core",
      "modelOverride": null,
      "effortOverride": null,
      "appliedModel": null,
      "appliedEffort": null,
      "status": "asleep",
      "now": "",
      "next": "",
      "cwd": "/Users/sample/Projects/ir",
      "sessionId": "00000000-0000-4000-8000-000000000012",
      "paneId": "sample:ir-numbers",
      "contextPct": null,
      "contextWindow": null,
      "contextWindowSource": null,
      "subagents": 0,
      "parallel": false,
      "queuedCount": 0,
      "lastError": null,
      "lastActiveAt": null,
      "updatedAt": "2026-01-05T07:00:00.000Z",
      "createdAt": "2026-01-04T10:02:00.000Z",
      "statusObservation": {
       "source": "core",
       "observedAt": "2026-01-05T09:00:00.000Z",
       "freshness": "fresh",
       "ownership": "verified",
       "consecutiveFailures": 0,
       "error": null
      },
      "blockedReason": null,
      "subagentState": null,
      "nowAt": null,
      "manualActivityAt": null,
      "lifecycleState": null,
      "executionState": null
     }
    ],
    "decisions": [
     {
      "id": "d-ir-number",
      "projectId": "sample-ir",
      "memberId": "m-ir-deck",
      "who": "Slide Writer",
      "title": "Pick the number for the first slide",
      "detail": "Choose the one number investors should remember from the first slide.",
      "options": [
       {
        "k": "a",
        "label": "$1.2M in monthly sales"
       },
       {
        "k": "b",
        "label": "64% repeat purchase rate"
       }
      ],
      "rec": "b",
      "group": null,
      "fileId": null,
      "images": [],
      "status": "open",
      "choice": null,
      "note": null,
      "batch": false,
      "createdAt": "2026-01-05T07:00:00.000Z",
      "answeredAt": null,
      "deliveredAt": null,
      "updatedAt": "2026-01-05T07:00:00.000Z",
      "lastChoice": null,
      "lastNote": null,
      "reopenNote": null,
      "closeKind": null,
      "closeReason": null,
      "closeQuote": null,
      "closedBy": null,
      "closedAt": null
     }
    ],
    "doneDecisionCount": 0,
    "todos": [],
    "work": [
     {
      "id": "w-ir-1",
      "projectId": "sample-ir",
      "sec": "doing",
      "title": "Financial summary slides",
      "detail": "",
      "who": "Deck Lead",
      "order": 1,
      "doneAt": null,
      "createdAt": "2026-01-05T06:00:00.000Z",
      "updatedAt": "2026-01-05T06:00:00.000Z"
     }
    ],
    "messages": [
     {
      "id": "x-ir-1",
      "projectId": "sample-ir",
      "at": "2026-01-05T06:00:00.000Z",
      "mine": false,
      "memberId": "m-ir-chief",
      "who": "Deck Lead",
      "kind": "진행",
      "title": "Writing the financial summary slides",
      "body": "I split it into three slides: revenue, sales volume and repeat purchase rate.",
      "targetMemberId": null,
      "targetName": null,
      "decisionId": null,
      "fileId": null,
      "attachments": [],
      "delivery": null,
      "deliveryNote": null,
      "deliveryRevision": 0,
      "contextFileId": null,
      "fileIds": [],
      "supersedes": null,
      "supersededBy": null
     }
    ],
    "files": [
     {
      "id": "f-ir-market",
      "kind": "document",
      "projectId": "sample-ir",
      "title": "Market size summary",
      "who": "Slide Writer",
      "memberId": "m-ir-deck",
      "summary": "The US digital wallet market and its growth, on one page.",
      "body": "# Market size summary\n\n- US digital wallet payments: about $1.7 trillion a year\n- Average annual growth over the last 3 years: 18%\n- Share of our customers aged 20–39: 46%\n",
      "path": null,
      "attachments": [],
      "createdAt": "2026-01-05T06:00:00.000Z",
      "order": 1
     }
    ],
    "deliveryNotices": {
     "version": 2,
     "unassignedItems": [],
     "reportNotices": [],
     "members": [
      {
       "memberId": "m-ir-chief",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      },
      {
       "memberId": "m-ir-deck",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      },
      {
       "memberId": "m-ir-num",
       "undeliveredCount": 0,
       "unknownCount": 0,
       "deliveringCount": 0,
       "checkingCount": 0,
       "needsOwnerCount": 0,
       "waitingBehindCount": 0,
       "oldestAt": null,
       "reasons": [],
       "waitReason": null,
       "waitingSince": null,
       "waitReasons": []
      }
     ],
     "unassigned": {
      "undeliveredCount": 0,
      "unknownCount": 0,
      "needsOwnerCount": 0
     }
    }
   },
   "revisions": {
    "settings": 1,
    "members": {
     "m-ir-chief": {
      "configRevision": 0,
      "sessionGeneration": 0
     },
     "m-ir-deck": {
      "configRevision": 0,
      "sessionGeneration": 0
     },
     "m-ir-num": {
      "configRevision": 0,
      "sessionGeneration": 0
     }
    },
    "todos": {}
   },
   "messages": [
    {
     "id": "x-ir-1",
     "projectId": "sample-ir",
     "at": "2026-01-05T06:00:00.000Z",
     "mine": false,
     "memberId": "m-ir-chief",
     "who": "Deck Lead",
     "kind": "진행",
     "title": "Writing the financial summary slides",
     "body": "I split it into three slides: revenue, sales volume and repeat purchase rate.",
     "targetMemberId": null,
     "targetName": null,
     "decisionId": null,
     "fileId": null,
     "attachments": [],
     "delivery": null,
     "deliveryNote": null,
     "deliveryRevision": 0,
     "contextFileId": null,
     "fileIds": [],
     "supersedes": null,
     "supersededBy": null
    }
   ],
   "decisionsDone": [],
   "deliveryNotices": {
    "version": 2,
    "unassignedItems": [],
    "reportNotices": [],
    "members": [
     {
      "memberId": "m-ir-chief",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     {
      "memberId": "m-ir-deck",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     {
      "memberId": "m-ir-num",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     }
    ],
    "unassigned": {
     "undeliveredCount": 0,
     "unknownCount": 0,
     "needsOwnerCount": 0
    }
   },
   "activity": {
    "m-ir-chief": [],
    "m-ir-deck": [],
    "m-ir-num": []
   },
   "memberNotices": {
    "m-ir-chief": {
     "memberId": "m-ir-chief",
     "summary": {
      "memberId": "m-ir-chief",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    },
    "m-ir-deck": {
     "memberId": "m-ir-deck",
     "summary": {
      "memberId": "m-ir-deck",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    },
    "m-ir-num": {
     "memberId": "m-ir-num",
     "summary": {
      "memberId": "m-ir-num",
      "undeliveredCount": 0,
      "unknownCount": 0,
      "deliveringCount": 0,
      "checkingCount": 0,
      "needsOwnerCount": 0,
      "waitingBehindCount": 0,
      "oldestAt": null,
      "reasons": [],
      "waitReason": null,
      "waitingSince": null,
      "waitReasons": []
     },
     "items": [],
     "nextBefore": null
    }
   }
  }
 },
 "files": {
  "f-copy": {
   "id": "f-copy",
   "kind": "artifact",
   "projectId": "sample-pay",
   "title": "Success and failure screen mockups",
   "who": "UX Copy",
   "memberId": "m-copy",
   "summary": "An HTML mockup comparing two success screens and two failure screens side by side",
   "body": "",
   "path": null,
   "attachments": [],
   "createdAt": "2026-01-05T08:56:00.000Z",
   "order": 5
  },
  "f-fee": {
   "id": "f-fee",
   "kind": "document",
   "projectId": "sample-pay",
   "title": "Payment provider fee comparison",
   "who": "Research",
   "memberId": "m-research",
   "summary": "Compares Stripe and Adyen on fees, payout timing and integration effort.",
   "body": "# Payment provider fee comparison\n\n## Summary\nStripe is ahead on documentation and payout speed. Adyen's quoted rate is 0.2 points lower.\n\n## Comparison\n| Provider | Fee | Payout | Integration |\n|---|---:|:-:|---|\n| Stripe | 2.9% | 2 days | Test keys right away, full `sandbox` |\n| Adyen | 2.7% | 3 days | Existing contract, test keys in 2–3 days |\n\n> Orders between $10 and $50 make up 70% of all payments.\n\n## Still to check\n- [x] Payout timing\n- [ ] Whether wallet payments carry a separate fee\n- [ ] Early termination fee\n",
   "path": null,
   "attachments": [],
   "createdAt": "2026-01-05T08:40:00.000Z",
   "order": 4
  },
  "f-config": {
   "id": "f-config",
   "kind": "code",
   "projectId": "sample-pay",
   "title": "payment-config.ts",
   "who": "Card Checkout",
   "memberId": "m-card",
   "summary": "Payment provider key and payment methods",
   "body": "export const payment = {\n  provider: process.env.PAYMENT_PROVIDER ?? \"stripe\",\n  methods: [\"card\", \"apple-pay\", \"google-pay\"],\n  retry: { max: 2, backoffMs: 800 },\n}\n",
   "path": "src/payment/payment-config.ts",
   "attachments": [],
   "createdAt": "2026-01-05T08:25:00.000Z",
   "order": 3
  },
  "f-funnel": {
   "id": "f-funnel",
   "kind": "table",
   "projectId": "sample-pay",
   "title": "Checkout drop-off by step",
   "who": "Funnel Analytics",
   "memberId": "m-funnel",
   "summary": "Drop-off at each checkout step over the last 4 weeks",
   "body": "Step,Visits,Drop-off\nCart,12840,18%\nOrder details,10529,24%\nPayment method,8002,31%\nPayment complete,5521,-",
   "path": null,
   "attachments": [],
   "createdAt": "2026-01-04T11:00:00.000Z",
   "order": 2
  },
  "f-shot": {
   "id": "f-shot",
   "kind": "image",
   "projectId": "sample-pay",
   "title": "Current pay button screenshot",
   "who": "Card Checkout",
   "memberId": "m-card",
   "summary": "How the mobile pay button looks today",
   "body": "",
   "path": null,
   "attachments": [
    {
     "id": "a-shot",
     "name": "payment-button.png",
     "mime": "image/png",
     "size": 2357,
     "url": "/files/a-shot/payment-button.png",
     "path": "/Users/sample/iamceo/uploads/a-shot/payment-button.png",
     "isImage": true
    }
   ],
   "createdAt": "2026-01-04T08:00:00.000Z",
   "order": 1
  },
  "f-ir-market": {
   "id": "f-ir-market",
   "kind": "document",
   "projectId": "sample-ir",
   "title": "Market size summary",
   "who": "Slide Writer",
   "memberId": "m-ir-deck",
   "summary": "The US digital wallet market and its growth, on one page.",
   "body": "# Market size summary\n\n- US digital wallet payments: about $1.7 trillion a year\n- Average annual growth over the last 3 years: 18%\n- Share of our customers aged 20–39: 46%\n",
   "path": null,
   "attachments": [],
   "createdAt": "2026-01-05T06:00:00.000Z",
   "order": 1
  }
 },
 "artifacts": {
  "f-copy": "<!doctype html>\n<html lang=\"en\">\n<head><title>Success and failure screen mockups</title></head>\n<body>\n<h1>Success and failure screen mockups</h1>\n<p>Two options each for the first screen people see after they pay, side by side. <span class=\"tag good\">Recommended: Success A · Failure B</span></p>\n\n<div class=\"grid\">\n  <div class=\"card\"><h3>Success A</h3><p><strong>Payment complete</strong></p><p>We've emailed your receipt. You can also find it in your order history.</p></div>\n  <div class=\"card\"><h3>Success B</h3><p><strong>Thank you</strong></p><p>We've received your order.</p></div>\n  <div class=\"card\"><h3>Failure A</h3><p><strong>Please try again</strong></p><p>Your payment didn't go through.</p></div>\n  <div class=\"card\"><h3>Failure B</h3><p><strong>Please check your card</strong></p><p>Check your card limit or verification, then try again. Need help? Call 1-800-555-0100.</p></div>\n</div>\n\n<div class=\"callout\"><strong>Why these:</strong> \"Did my payment go through?\" is our most common support question. Stating the result in the first line cuts those questions down.</div>\n\n<table>\n  <thead><tr><th>Option</th><th>First line</th><th>Is the result clear?</th></tr></thead>\n  <tbody>\n    <tr><td>Success A</td><td>16 characters</td><td>Yes</td></tr>\n    <tr><td>Success B</td><td>9 characters</td><td>Less clear</td></tr>\n    <tr><td>Failure B</td><td>22 characters</td><td>Also says why</td></tr>\n  </tbody>\n</table>\n</body>\n</html>"
 },
 "artifactDocuments": {
  "f-copy": "<!doctype html><html lang=\"en\"><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'\"><meta http-equiv=\"x-dns-prefetch-control\" content=\"off\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Success and failure screen mockups</title><style>:where(*,*::before,*::after){box-sizing:border-box}\n:where(html){color-scheme:dark;-webkit-text-size-adjust:100%}\n:where(body){margin:0;padding:24px;background:#090713;color:#F5F2FF;font:15px/1.65 -apple-system,BlinkMacSystemFont,\"Apple SD Gothic Neo\",\"Noto Sans KR\",\"Segoe UI\",sans-serif;word-break:keep-all;overflow-wrap:anywhere}\n:where(h1,h2,h3,h4){margin:1.6em 0 .6em;line-height:1.3;font-weight:650;color:#F5F2FF}\n:where(h1){font-size:1.6rem;margin-top:0}\n:where(h2){font-size:1.25rem}\n:where(h3){font-size:1.05rem}\n:where(h4){font-size:.95rem;color:#C2BBDF}\n:where(p,ul,ol,dl,blockquote,pre,table,figure){margin:0 0 1em}\n:where(ul,ol){padding-left:1.4em}\n:where(li+li){margin-top:.25em}\n:where(a){color:#B9A8FF}\n:where(strong){color:#F5F2FF}\n:where(hr){border:0;border-top:1px solid rgba(255,255,255,.12);margin:1.5em 0}\n:where(blockquote){padding:.2em 0 .2em 1em;border-left:3px solid rgba(185,168,255,.5);color:#C2BBDF}\n:where(img,svg,video,canvas){max-width:100%;height:auto}\n:where(code,kbd,samp){font:.9em/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:rgba(255,255,255,.08);padding:.1em .35em;border-radius:5px}\n:where(pre){padding:14px 16px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:12px;overflow:auto}\n:where(pre code){background:none;padding:0}\n:where(table){width:100%;border-collapse:collapse;font-size:.93em;display:block;overflow-x:auto}\n:where(.kit-table){margin:0 0 1em;overflow-x:auto}\n:where(.kit-table>table){display:table;margin:0}\n:where(th,td){padding:9px 12px;border-bottom:1px solid rgba(255,255,255,.1);text-align:left;vertical-align:top;overflow-wrap:break-word}\n:where(th){color:#C2BBDF;font-weight:600;background:rgba(255,255,255,.04);white-space:nowrap}\n:where(.card){padding:18px 20px;margin:0 0 14px;background:linear-gradient(160deg,rgba(255,255,255,.08),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.12);border-radius:16px;box-shadow:0 8px 24px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.1)}\n:where(.card>:last-child,.callout>:last-child){margin-bottom:0}\n:where(.card>:first-child,.callout>:first-child){margin-top:0}\n:where(.grid){display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 14px}\n:where(.grid>.card){margin:0}\n:where(.callout){padding:14px 16px;margin:0 0 14px;background:rgba(185,168,255,.1);border:1px solid rgba(185,168,255,.28);border-left-width:4px;border-radius:12px}\n:where(.callout.warn){background:rgba(255,183,77,.1);border-color:rgba(255,183,77,.35)}\n:where(.callout.bad){background:rgba(255,107,107,.1);border-color:rgba(255,107,107,.35)}\n:where(.callout.good){background:rgba(92,214,160,.1);border-color:rgba(92,214,160,.35)}\n:where(.kpi){display:flex;flex-direction:column;gap:4px;padding:16px 18px;background:linear-gradient(160deg,rgba(255,255,255,.08),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.12);border-radius:16px}\n:where(.kpi b,.kpi strong){font-size:1.7rem;line-height:1.2;font-weight:680;color:#F5F2FF;font-variant-numeric:tabular-nums}\n:where(.kpi small,.kpi span){color:#A9A2C9;font-size:.85em}\n:where(.steps){list-style:none;counter-reset:step;padding:0;margin:0 0 14px}\n:where(.steps>li){counter-increment:step;position:relative;padding:0 0 14px 40px;margin:0}\n:where(.steps>li)::before{content:counter(step);position:absolute;left:0;top:0;width:26px;height:26px;display:grid;place-items:center;border-radius:50%;background:rgba(185,168,255,.18);color:#D5CBFF;font-size:.82em;font-weight:650}\n:where(.steps>li:not(:last-child))::after{content:\"\";position:absolute;left:12.5px;top:30px;bottom:4px;width:1px;background:rgba(255,255,255,.14)}\n:where(.tag){display:inline-block;padding:.1em .6em;border-radius:999px;font-size:.8em;line-height:1.6;background:rgba(255,255,255,.1);color:#C2BBDF;border:1px solid rgba(255,255,255,.12)}\n:where(.tag.good){background:rgba(92,214,160,.16);color:#9ee8c6}\n:where(.tag.warn){background:rgba(255,183,77,.16);color:#ffd08a}\n:where(.tag.bad){background:rgba(255,107,107,.16);color:#ffb0b0}\n:where(.compare){display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin:0 0 14px}\n:where(.compare>*){padding:16px 18px;margin:0;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:14px}\n:where(.compare>.pick){border-color:rgba(185,168,255,.55);background:rgba(185,168,255,.1)}\n:where(.compare>*>:last-child){margin-bottom:0}\n:where(.compare>*>:first-child){margin-top:0}\n:where(.flow){display:flex;flex-wrap:wrap;gap:10px 26px;list-style:none;padding:0;margin:0 0 14px}\n:where(.flow>*){position:relative;flex:1 1 130px;margin:0;padding:12px 14px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:12px}\n:where(.flow>*:not(:last-child))::after{content:\"→\";position:absolute;right:-20px;top:50%;transform:translateY(-50%);color:#A9A2C9}\n:where(.flow>*>:last-child){margin-bottom:0}\n:where(.flow>*>:first-child){margin-top:0}\n:where(button){font:inherit;color:inherit}\n:where(.tabs){display:flex;flex-wrap:wrap;gap:4px;padding:4px;margin:0 0 14px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:14px}\n:where(.tabs>button){flex:1 1 auto;min-height:44px;padding:0 14px;background:none;border:0;border-radius:10px;color:#C2BBDF;font-weight:600;cursor:pointer}\n:where(.tabs>button:hover){background:rgba(255,255,255,.06)}\n:where(.tabs>button[aria-selected=\"true\"]){background:rgba(122,91,255,.42);color:#fff}\n@media (max-width:520px){:where(body){padding:16px;font-size:14.5px}:where(h1){font-size:1.35rem}:where(.grid,.compare){grid-template-columns:1fr}:where(.flow){flex-direction:column;gap:22px}:where(.flow>*){flex:none}:where(.flow>*:not(:last-child))::after{content:\"↓\";right:auto;left:50%;top:auto;bottom:-22px;transform:translateX(-50%)}}</style><script>(function(){[\"RTCPeerConnection\",\"webkitRTCPeerConnection\"].forEach(function(k){try{delete window[k];window[k]=undefined}catch(e){}});var Q=\"iframe,frame,link\",E=Element.prototype,Rm=E.remove,Mt=E.matches,Qa=E.querySelectorAll;function strip(n){if(n.nodeType!==1)return;if(Mt.call(n,Q))Rm.call(n);else Qa.call(n,Q).forEach(function(x){Rm.call(x)})}new MutationObserver(function(l){l.forEach(function(r){r.addedNodes.forEach(strip)})}).observe(document,{childList:true,subtree:true});[[E,\"attachShadow\"],[E,\"setHTMLUnsafe\"],[Document,\"parseHTMLUnsafe\"],[Document.prototype,\"write\"],[Document.prototype,\"writeln\"]].forEach(function(x){try{delete x[0][x[1]]}catch(e){}});var P=parent,O=ResizeObserver,last=-1,S=getComputedStyle;function send(){var b=document.body,d=document.documentElement,n=0;if(b){var c=S(b);n=b.scrollHeight+(parseFloat(c.marginTop)||0)+(parseFloat(c.marginBottom)||0)}else if(d){n=d.scrollHeight}n=Math.ceil(n);if(n!==last){last=n;P.postMessage({iamceoHeight:n},\"*\")}}var r=new O(send);if(document.documentElement)r.observe(document.documentElement);send();addEventListener(\"DOMContentLoaded\",function(){if(document.body)r.observe(document.body);document.querySelectorAll(\"table\").forEach(function(t){if(t.parentElement&&t.parentElement.classList.contains(\"kit-table\"))return;var w=document.createElement(\"div\");w.className=\"kit-table\";t.parentNode.insertBefore(w,t);w.appendChild(t)});send()});addEventListener(\"load\",send);addEventListener(\"click\",function(e){var a=e.target&&e.target.closest?e.target.closest(\"a[href]\"):null;if(!a)return;var h=a.getAttribute(\"href\")||\"\";if(h.charAt(0)===\"#\")return;e.preventDefault();P.postMessage({iamceoLink:a.href},\"*\")},true);addEventListener(\"keydown\",function(e){if(e.key===\"Escape\")P.postMessage({iamceoEscape:true},\"*\")},true)})()</script></head><body><!doctype html>\n<html lang=\"en\">\n<head><title>Success and failure screen mockups</title></head>\n<body>\n<h1>Success and failure screen mockups</h1>\n<p>Two options each for the first screen people see after they pay, side by side. <span class=\"tag good\">Recommended: Success A · Failure B</span></p>\n\n<div class=\"grid\">\n  <div class=\"card\"><h3>Success A</h3><p><strong>Payment complete</strong></p><p>We've emailed your receipt. You can also find it in your order history.</p></div>\n  <div class=\"card\"><h3>Success B</h3><p><strong>Thank you</strong></p><p>We've received your order.</p></div>\n  <div class=\"card\"><h3>Failure A</h3><p><strong>Please try again</strong></p><p>Your payment didn't go through.</p></div>\n  <div class=\"card\"><h3>Failure B</h3><p><strong>Please check your card</strong></p><p>Check your card limit or verification, then try again. Need help? Call 1-800-555-0100.</p></div>\n</div>\n\n<div class=\"callout\"><strong>Why these:</strong> \"Did my payment go through?\" is our most common support question. Stating the result in the first line cuts those questions down.</div>\n\n<table>\n  <thead><tr><th>Option</th><th>First line</th><th>Is the result clear?</th></tr></thead>\n  <tbody>\n    <tr><td>Success A</td><td>16 characters</td><td>Yes</td></tr>\n    <tr><td>Success B</td><td>9 characters</td><td>Less clear</td></tr>\n    <tr><td>Failure B</td><td>22 characters</td><td>Also says why</td></tr>\n  </tbody>\n</table>\n</body>\n</html></body></html>"
 },
 "artifactPolicy": "sandbox allow-scripts; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'",
 "blobs": {
  "/files/a-shot/payment-button.png": {
   "mime": "image/png",
   "base64": "iVBORw0KGgoAAAANSUhEUgAAAYYAAAIICAIAAADlsN6HAAAI/ElEQVR42u3dsU1DQRBFUdeACC2RI0QLOHIFhBZ1EFArEX1AQAFIaNeeeXOkU8Hu+1cE+P/D/d0RoIiDIwAkCUCSAEkCkCRAkgAkCZAkAEkCJAlAkgBJApAkAEkCJAlAkgBJApAkQJIAJAmQJABJAiQJYECSHo5PQCmDkuSyQaRunyQ3CtpUIkmuEISpSpLcHKhSlSS5M1ClEklyVSBMVZLkhkCVJAmQJD0CVlfpoEdAnSod9AioUyVJArKS5CaAVVWSJECSAEnakSR3ACyskiQBkgRIkiQBkgRIkiQB05Lk9IG1VZIkQJIASZIkQJIASZIkQJIAJAmQJEkCJAmQpOsl6fL6znAeaUmqkiRPI6okSVWS5DlElSSpSpI8gaiSJEkSkoQkSRKSJEmVk+TZQ5UkyV9J6BGSJElIkiRJEpKEJKkSeiRJ/nsbPUKSVAk9IvlNAJ5MJUKSvJwEkCRAkiQJkCRAkiQJkCRAkiQJkCQASQIkSZIASQIkSZIASQIkSZIASfp1Pr2xiYcESdIjVUKSJAlJQpIkSZIgJ0l6oUpIkr+S9AgkSZIkCUmSJDwnSJIq6RGS1P+/txVEiZAkPygBJAmQJEkCJAmQJEkCJAmQJEkCJAlAkgBJkiRAkgBJkiRAkgBJkiRAkgBJkiRAkgBJkiRAkgBJkiRAkgAkCZAkSQIkCZAkSQIkCZAkSQIkCZAkSQIkCZAkSQIkCZAkSQIkCWBekp4fX4B/kyQZgqF5CkyS0UDfMKUlyVagdZWikmQl0L1KOUmyDwioUkiSLAMyqiRJgCQtTZJNQEyVJAmQJEkCSZIkQJL2JskaIKlKkgRIkiSBJEkSIEmSBJIkSYAkSRJIkiQBkiRJgCRJEkiSJAGSJEkgSZIESJIkgSRJEiBJkgSSJEmAJEkSSJIkAZIkSSBJkgRIkiQBkiRJIEmSBEiSJIEkSRIgSZIEkiRJgCStTJIqQUyPJAmQJEkCSZIkQJKukSRVgoweSRIgSRuSpEoQ0KOoJKkSdO9RWpJUCVr3KDBJqgR9e5SZJGGCjjEKT5I8QZcMjUsS0IUkAZIkSYAkAZIkSYAkAZIkSYAkAZIkSYAkAZIkSYAkAZIkSYAkAUgSIEmSBHiFG1Hv+nLaXuHmRbfceMdO1YtufQ6AEgt2kj4H4KNJVJmvM/TRJJ+WpMp8nZ5PS/oAN1Xm69x8gLtlkiwjcr5ObGCVJAlJQpKWJskmIufrrGZWSZKQJCRJkmzXtUqSJCFJSNLeJFlD5Hyd0tgqSRKShCRJku26VkmSJCQJSZIkJMm1ShKShCRJEpLkWiUJSUKSJAlJQpJsV5KQJElCkpAk25UkJEmSkCQkSZJs17VKkiQhSUiSJNmua5UkSUKSkCRJQpJcqyQhSUiSJCFJrlWSkCQkSZKQJCTJdiUJSZIkJAlJsl1JQpIkCUlCkiTJdl2rJEkSkoQkrUyS+aYO11kN7JEkIUlIkiTZrmuVJElCkpCkayTJfFOH68Sm9UiSkCQkaUOSzDd1uM5tVI+ikmS+qcN1enN6lJYk800drjMc0qPAJJlv6nCd5IQeZSbJgoNX61SDYxSeJDuO3Ktrjb/WEUkCupAkQJIkCZAkQJIkCZAkQJIkCZAkQJIkCZAkQJIkCZAkQJIkCZAkAEkCJEmSAK9wA7zCzYtuQZ58DgDwOQAfTQJVkiQ9Ap+W9AFuQJL0CJKrJEmAJC1Nkk1ATJUkCZAkSQJJkiRAkvYmyRogqUqSBEiSJIEkSRIgSZIEkiRJgCRJEkiSJAGSJEmAJEkSSJIkAZIkSSBJkgRIkiSBJEkSIEmSBJIkSYAkSRJIkiQBkiRJIEmSBEiSJAGSJEkgSZIESJIkgSRJEiBJkgSSJEmAJK1MkipBTI8kCZAkSQJJkiRAkq6RJFWCjB5JEiBJG5KkShDQo6gkqRJ071FaklQJWvcoMEmqBH17lJkkYYKOMQpPkjxBlwyNSxLQhSQBkiRJgCQBkiRJgCQBkiRJgCQBkiRJgCQBkiRJgCQBkiRJgCQBSBIgSZIESBIgSZIESBIgSZIESBIgSZIESBIgSZIESBIgSZIESBKAJAGStD5J59Mb3JygSJIeoUqSJEkgSZIkSUiSJFVPkmcAVZIkfyWBHkmSJCFJkiRJIEmSpErokST1/+9tTwVKJEl+UAJIEiBJkgRIEiBJkgRIEiBJkgRIEoAkAZIkSYDfuOFXGkiSNwGgSkgSkoQkSRKShCTpkSohSf5KQo+QJEmSJCRJkpAkJEmV0CNJ8u5tlAhJApAkQJIkCZAkQJIkCZAkQJIkCZAkQJIkCZAkQJIkCZAkQJIkCZAkAEkCJEmSAEkCJEmSAEkCJEmSAEkCJEmSAEkCJEmSAEkCJEmSAEkCkCRAkiQJkCRAkiQJkCRAkiQJkCRAkiQJkCRAklKT9HH5Bv4kSRoEChWdJDOCdmHKTJLpQNMwBSbJYqBvldKSZCvQukpRSbIS6F6lnCTZBwRUSZIASVqdJMuAjCpJEiBJS5NkExBTJUkCJEmSQJIkCZAkSQJJGpMka4CkKkkSIEmSBJIkSYAkSRJIkiQBkiRJTX19zuX2JUmS9EiVJEmS0CNVkiRJkiRJkiRJQpIkSZIkSY9USZIkCVXSI0mSJEmSJCRJkiRJkiRJklRJj5AkSVIlPZIkSdImJUKSJAkkSZIASZIkkCRJAiRJkkCSJAmQJJ+WBD2SJEkCSZIkQJIkCSRJkgBJUiUY1iNJAiRpQ5JUCQJ6JEmAJO1JkipB9x6lJUmVoHWPApOkStC3R5lJUiVo2qPYJAkTtItRfpKECRrFaEqSFAoqN2h6koDKJAmQJEkCJAmQJEkCJAmQJFUCbtIjSQIkCZAkSQIkCZAkSQJmJkmVgFU9kiRAkgBJ2pckVQKW9EiSgMQkqRLoUa0kqRLoUa0kqRLokSQBkqRKwOoebUmSMIEYlUuSKoEe1UqSKoEe1UqSMIEYlUuSNoESVUySSIEAlU4SgCQBkgQgSYAkAUgSIEkAkgRIEoAkAZIEIEmAJAFIEoAkAZIEIEmAJAFIEiBJAJIESBKAJAGSBCBJgCQBlPAD+qEPpeCfETEAAAAASUVORK5CYII="
  }
 },
 "usage": {
  "1": {
   "generatedAt": "2026-01-05T09:00:00.000Z",
   "timeZone": "UTC",
   "days": 1,
   "from": "2026-01-05",
   "to": "2026-01-05",
   "projectId": null,
   "retentionDays": 90,
   "totals": {
    "costUsd": 15.72,
    "inputTokens": 4358300,
    "outputTokens": 552760
   },
   "members": [
    {
     "memberId": "m-chief",
     "projectId": "sample-pay",
     "name": "Checkout Lead",
     "kind": "conductor",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 5.47,
     "inputTokens": 934800,
     "outputTokens": 118560
    },
    {
     "memberId": "m-copy",
     "projectId": "sample-pay",
     "name": "UX Copy",
     "kind": "worker",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 3.43,
     "inputTokens": 586300,
     "outputTokens": 74360
    },
    {
     "memberId": "m-research",
     "projectId": "sample-pay",
     "name": "Research",
     "kind": "worker",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 2.16,
     "inputTokens": 369000,
     "outputTokens": 46800
    },
    {
     "memberId": "m-ir-chief",
     "projectId": "sample-ir",
     "name": "Deck Lead",
     "kind": "conductor",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 1.92,
     "inputTokens": 328000,
     "outputTokens": 41600
    },
    {
     "memberId": "m-ir-deck",
     "projectId": "sample-ir",
     "name": "Slide Writer",
     "kind": "worker",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 1.68,
     "inputTokens": 287000,
     "outputTokens": 36400
    },
    {
     "memberId": "m-mail",
     "projectId": "sample-pay",
     "name": "Receipt Email",
     "kind": "worker",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 1.06,
     "inputTokens": 180400,
     "outputTokens": 22880
    },
    {
     "memberId": "m-card",
     "projectId": "sample-pay",
     "name": "Card Checkout",
     "kind": "worker",
     "providers": [
      "codex"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": null,
     "inputTokens": 721600,
     "outputTokens": 91520
    },
    {
     "memberId": "m-pg",
     "projectId": "sample-pay",
     "name": "Payments Integration",
     "kind": "worker",
     "providers": [
      "codex"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": null,
     "inputTokens": 631400,
     "outputTokens": 80080
    },
    {
     "memberId": "m-funnel",
     "projectId": "sample-pay",
     "name": "Funnel Analytics",
     "kind": "worker",
     "providers": [
      "codex"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": null,
     "inputTokens": 319800,
     "outputTokens": 40560
    }
   ],
   "projects": [
    {
     "projectId": "sample-pay",
     "name": "Checkout Revamp",
     "archived": false,
     "members": 7,
     "costUsd": 12.12,
     "inputTokens": 3743300,
     "outputTokens": 474760
    },
    {
     "projectId": "sample-ir",
     "name": "Investor Deck",
     "archived": false,
     "members": 2,
     "costUsd": 3.6,
     "inputTokens": 615000,
     "outputTokens": 78000
    }
   ],
   "daily": [
    {
     "day": "2026-01-05",
     "costUsd": 15.72,
     "inputTokens": 4358300,
     "outputTokens": 552760
    }
   ],
   "limits": [
    {
     "provider": "claude",
     "window": "five_hour",
     "windowMinutes": 300,
     "usedPct": 34,
     "resetsAt": "2026-01-05T11:00:00.000Z",
     "observedAt": "2026-01-05T08:30:00.000Z"
    },
    {
     "provider": "claude",
     "window": "seven_day",
     "windowMinutes": 10080,
     "usedPct": 18,
     "resetsAt": "2026-01-08T09:00:00.000Z",
     "observedAt": "2026-01-05T08:30:00.000Z"
    },
    {
     "provider": "codex",
     "window": "primary",
     "windowMinutes": 300,
     "usedPct": 22,
     "resetsAt": "2026-01-05T12:00:00.000Z",
     "observedAt": "2026-01-05T08:30:00.000Z"
    },
    {
     "provider": "codex",
     "window": "secondary",
     "windowMinutes": 10080,
     "usedPct": 9,
     "resetsAt": "2026-01-09T09:00:00.000Z",
     "observedAt": "2026-01-05T08:30:00.000Z"
    }
   ]
  },
  "7": {
   "generatedAt": "2026-01-05T09:00:00.000Z",
   "timeZone": "UTC",
   "days": 7,
   "from": "2025-12-30",
   "to": "2026-01-05",
   "projectId": null,
   "retentionDays": 90,
   "totals": {
    "costUsd": 93.62,
    "inputTokens": 25089540,
    "outputTokens": 3182088
   },
   "members": [
    {
     "memberId": "m-chief",
     "projectId": "sample-pay",
     "name": "Checkout Lead",
     "kind": "conductor",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 30.92,
     "inputTokens": 5281620,
     "outputTokens": 669864
    },
    {
     "memberId": "m-copy",
     "projectId": "sample-pay",
     "name": "UX Copy",
     "kind": "worker",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 20.97,
     "inputTokens": 3581760,
     "outputTokens": 454272
    },
    {
     "memberId": "m-research",
     "projectId": "sample-pay",
     "name": "Research",
     "kind": "worker",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 14.39,
     "inputTokens": 2457540,
     "outputTokens": 311688
    },
    {
     "memberId": "m-ir-chief",
     "projectId": "sample-ir",
     "name": "Deck Lead",
     "kind": "conductor",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 12.79,
     "inputTokens": 2184480,
     "outputTokens": 277056
    },
    {
     "memberId": "m-ir-deck",
     "projectId": "sample-ir",
     "name": "Slide Writer",
     "kind": "worker",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 8.1,
     "inputTokens": 1383750,
     "outputTokens": 175500
    },
    {
     "memberId": "m-mail",
     "projectId": "sample-pay",
     "name": "Receipt Email",
     "kind": "worker",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 6.45,
     "inputTokens": 1102080,
     "outputTokens": 139776
    },
    {
     "memberId": "m-card",
     "projectId": "sample-pay",
     "name": "Card Checkout",
     "kind": "worker",
     "providers": [
      "codex"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": null,
     "inputTokens": 4408320,
     "outputTokens": 559104
    },
    {
     "memberId": "m-pg",
     "projectId": "sample-pay",
     "name": "Payments Integration",
     "kind": "worker",
     "providers": [
      "codex"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": null,
     "inputTokens": 3044250,
     "outputTokens": 386100
    },
    {
     "memberId": "m-funnel",
     "projectId": "sample-pay",
     "name": "Funnel Analytics",
     "kind": "worker",
     "providers": [
      "codex"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": null,
     "inputTokens": 1645740,
     "outputTokens": 208728
    }
   ],
   "projects": [
    {
     "projectId": "sample-pay",
     "name": "Checkout Revamp",
     "archived": false,
     "members": 7,
     "costUsd": 72.73,
     "inputTokens": 21521310,
     "outputTokens": 2729532
    },
    {
     "projectId": "sample-ir",
     "name": "Investor Deck",
     "archived": false,
     "members": 2,
     "costUsd": 20.89,
     "inputTokens": 3568230,
     "outputTokens": 452556
    }
   ],
   "daily": [
    {
     "day": "2025-12-30",
     "costUsd": 5.38,
     "inputTokens": 1396050,
     "outputTokens": 177060
    },
    {
     "day": "2025-12-31",
     "costUsd": 4.72,
     "inputTokens": 1307490,
     "outputTokens": 165828
    },
    {
     "day": "2026-01-01",
     "costUsd": 17.02,
     "inputTokens": 4637100,
     "outputTokens": 588120
    },
    {
     "day": "2026-01-02",
     "costUsd": 16.51,
     "inputTokens": 4403400,
     "outputTokens": 558480
    },
    {
     "day": "2026-01-03",
     "costUsd": 16.37,
     "inputTokens": 4333700,
     "outputTokens": 549640
    },
    {
     "day": "2026-01-04",
     "costUsd": 17.9,
     "inputTokens": 4653500,
     "outputTokens": 590200
    },
    {
     "day": "2026-01-05",
     "costUsd": 15.72,
     "inputTokens": 4358300,
     "outputTokens": 552760
    }
   ],
   "limits": [
    {
     "provider": "claude",
     "window": "five_hour",
     "windowMinutes": 300,
     "usedPct": 34,
     "resetsAt": "2026-01-05T11:00:00.000Z",
     "observedAt": "2026-01-05T08:30:00.000Z"
    },
    {
     "provider": "claude",
     "window": "seven_day",
     "windowMinutes": 10080,
     "usedPct": 18,
     "resetsAt": "2026-01-08T09:00:00.000Z",
     "observedAt": "2026-01-05T08:30:00.000Z"
    },
    {
     "provider": "codex",
     "window": "primary",
     "windowMinutes": 300,
     "usedPct": 22,
     "resetsAt": "2026-01-05T12:00:00.000Z",
     "observedAt": "2026-01-05T08:30:00.000Z"
    },
    {
     "provider": "codex",
     "window": "secondary",
     "windowMinutes": 10080,
     "usedPct": 9,
     "resetsAt": "2026-01-09T09:00:00.000Z",
     "observedAt": "2026-01-05T08:30:00.000Z"
    }
   ]
  },
  "30": {
   "generatedAt": "2026-01-05T09:00:00.000Z",
   "timeZone": "UTC",
   "days": 30,
   "from": "2025-12-07",
   "to": "2026-01-05",
   "projectId": null,
   "retentionDays": 90,
   "totals": {
    "costUsd": 187.01,
    "inputTokens": 50096670,
    "outputTokens": 6353724
   },
   "members": [
    {
     "memberId": "m-chief",
     "projectId": "sample-pay",
     "name": "Checkout Lead",
     "kind": "conductor",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 61.56,
     "inputTokens": 10516500,
     "outputTokens": 1333800
    },
    {
     "memberId": "m-copy",
     "projectId": "sample-pay",
     "name": "UX Copy",
     "kind": "worker",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 41.75,
     "inputTokens": 7131540,
     "outputTokens": 904488
    },
    {
     "memberId": "m-research",
     "projectId": "sample-pay",
     "name": "Research",
     "kind": "worker",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 28.97,
     "inputTokens": 4948290,
     "outputTokens": 627588
    },
    {
     "memberId": "m-ir-chief",
     "projectId": "sample-ir",
     "name": "Deck Lead",
     "kind": "conductor",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 25.75,
     "inputTokens": 4398480,
     "outputTokens": 557856
    },
    {
     "memberId": "m-ir-deck",
     "projectId": "sample-ir",
     "name": "Slide Writer",
     "kind": "worker",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 16.13,
     "inputTokens": 2755200,
     "outputTokens": 349440
    },
    {
     "memberId": "m-mail",
     "projectId": "sample-pay",
     "name": "Receipt Email",
     "kind": "worker",
     "providers": [
      "claude"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": 12.85,
     "inputTokens": 2194320,
     "outputTokens": 278304
    },
    {
     "memberId": "m-card",
     "projectId": "sample-pay",
     "name": "Card Checkout",
     "kind": "worker",
     "providers": [
      "codex"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": null,
     "inputTokens": 8777280,
     "outputTokens": 1113216
    },
    {
     "memberId": "m-pg",
     "projectId": "sample-pay",
     "name": "Payments Integration",
     "kind": "worker",
     "providers": [
      "codex"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": null,
     "inputTokens": 6061440,
     "outputTokens": 768768
    },
    {
     "memberId": "m-funnel",
     "projectId": "sample-pay",
     "name": "Funnel Analytics",
     "kind": "worker",
     "providers": [
      "codex"
     ],
     "removed": false,
     "lastAt": "2026-01-05T08:30:00.000Z",
     "costUsd": null,
     "inputTokens": 3313620,
     "outputTokens": 420264
    }
   ],
   "projects": [
    {
     "projectId": "sample-pay",
     "name": "Checkout Revamp",
     "archived": false,
     "members": 7,
     "costUsd": 145.13,
     "inputTokens": 42942990,
     "outputTokens": 5446428
    },
    {
     "projectId": "sample-ir",
     "name": "Investor Deck",
     "archived": false,
     "members": 2,
     "costUsd": 41.88,
     "inputTokens": 7153680,
     "outputTokens": 907296
    }
   ],
   "daily": [
    {
     "day": "2025-12-23",
     "costUsd": 4.95,
     "inputTokens": 1321020,
     "outputTokens": 167544
    },
    {
     "day": "2025-12-24",
     "costUsd": 4.92,
     "inputTokens": 1300110,
     "outputTokens": 164892
    },
    {
     "day": "2025-12-25",
     "costUsd": 17.9,
     "inputTokens": 4653500,
     "outputTokens": 590200
    },
    {
     "day": "2025-12-26",
     "costUsd": 15.72,
     "inputTokens": 4358300,
     "outputTokens": 552760
    },
    {
     "day": "2025-12-27",
     "costUsd": 17.02,
     "inputTokens": 4637100,
     "outputTokens": 588120
    },
    {
     "day": "2025-12-28",
     "costUsd": 16.51,
     "inputTokens": 4403400,
     "outputTokens": 558480
    },
    {
     "day": "2025-12-29",
     "costUsd": 16.37,
     "inputTokens": 4333700,
     "outputTokens": 549640
    },
    {
     "day": "2025-12-30",
     "costUsd": 5.38,
     "inputTokens": 1396050,
     "outputTokens": 177060
    },
    {
     "day": "2025-12-31",
     "costUsd": 4.72,
     "inputTokens": 1307490,
     "outputTokens": 165828
    },
    {
     "day": "2026-01-01",
     "costUsd": 17.02,
     "inputTokens": 4637100,
     "outputTokens": 588120
    },
    {
     "day": "2026-01-02",
     "costUsd": 16.51,
     "inputTokens": 4403400,
     "outputTokens": 558480
    },
    {
     "day": "2026-01-03",
     "costUsd": 16.37,
     "inputTokens": 4333700,
     "outputTokens": 549640
    },
    {
     "day": "2026-01-04",
     "costUsd": 17.9,
     "inputTokens": 4653500,
     "outputTokens": 590200
    },
    {
     "day": "2026-01-05",
     "costUsd": 15.72,
     "inputTokens": 4358300,
     "outputTokens": 552760
    }
   ],
   "limits": [
    {
     "provider": "claude",
     "window": "five_hour",
     "windowMinutes": 300,
     "usedPct": 34,
     "resetsAt": "2026-01-05T11:00:00.000Z",
     "observedAt": "2026-01-05T08:30:00.000Z"
    },
    {
     "provider": "claude",
     "window": "seven_day",
     "windowMinutes": 10080,
     "usedPct": 18,
     "resetsAt": "2026-01-08T09:00:00.000Z",
     "observedAt": "2026-01-05T08:30:00.000Z"
    },
    {
     "provider": "codex",
     "window": "primary",
     "windowMinutes": 300,
     "usedPct": 22,
     "resetsAt": "2026-01-05T12:00:00.000Z",
     "observedAt": "2026-01-05T08:30:00.000Z"
    },
    {
     "provider": "codex",
     "window": "secondary",
     "windowMinutes": 10080,
     "usedPct": 9,
     "resetsAt": "2026-01-09T09:00:00.000Z",
     "observedAt": "2026-01-05T08:30:00.000Z"
    }
   ]
  }
 }
}
"""##
}
