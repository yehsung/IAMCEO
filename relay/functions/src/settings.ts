// 중계의 고정 값을 한 곳에 둔다. 바꿀 때는 이 파일만 고치고 다시 배포한다(README "값 바꾸기").
// 숫자 옆의 [제안값]은 근거 없이 정한 출발점이다. 실제 사용량을 보고 고친다.
import { DEFAULT_PUSH_BUNDLE_ID } from "../../../shared/push.ts";

/**
 * 함수가 도는 지역(한 곳). us-central1 = Tier 1 가격(무료 사용량이 Tier 1 단가로 깎인다), APNs(미국)와 가깝다.
 * Mac 이 부르는 주소는 함수 주소(Cloud Run 의 https://relay-….run.app)이고 그 주소에 지역이 들어간다.
 * 그래서 출시한 뒤에는 지역을 바꾸지 않는다(바꾸면 옛 주소를 쓰는 Mac 서버가 남는다. README '운영').
 * Firebase Hosting 은 앞에 두지 않는다: Hosting 은 요청한 Mac 의 IP 를 몇 달 보관한다(firebase.google.com/support/privacy).
 */
export const RELAY_REGION = "us-central1";

/** 배포 이름. Cloud Run 서비스 이름도 이것이다(로그 제외 필터가 이 이름을 쓴다). */
export const RELAY_FUNCTION_NAME = "relay";

/**
 * 인스턴스 설정.
 * - maxInstances 1: 한도·정지를 메모리에서 세므로 인스턴스가 하나여야 숫자가 대체로 맞고, 계산 비용도 대체로 한 대 값에 묶인다.
 *   보장은 아니다: Cloud Run 은 요청이 몰릴 때 이 상한을 잠깐 넘길 수 있다(docs.cloud.google.com/run/docs/configuring/max-instances).
 *   그때 새 인스턴스는 0 부터 센다. 한계를 넘는 요청은 Cloud Run 이 30초 줄 세운 뒤 429 로 돌려준다(Mac 은 다시 시도한다).
 * - minInstances 0: 쉬면 내려간다(대기 비용 없음). 처음 요청은 콜드 스타트로 1~3초 늦을 수 있다 [추정].
 * - concurrency 80(기본값): 한 인스턴스가 동시에 받는 요청 수. 1 이상의 CPU 가 있어야 쓸 수 있다.
 * - cpu 1, memory 256MiB: 2세대 기본 조합. 메모리는 한도 표(최대 수만 건)와 Node 를 넉넉히 담는다.
 * - timeoutSeconds 15: 중계는 안쪽 시간 한도(대기 0.75초 + APNs 4초)로 늘 그 전에 답한다. 멈춘 요청의 과금을 묶는다.
 */
export const RELAY_RUNTIME = Object.freeze({
  maxInstances: 1,
  minInstances: 0,
  concurrency: 80,
  cpu: 1,
  memory: "256MiB",
  timeoutSeconds: 15,
} as const);

/** APNs 로 보내는 값. topic(번들 ID)은 코드에 고정한다. 남이 다른 앱으로 보낼 수 없다. */
export const RELAY_APNS = Object.freeze({
  topic: DEFAULT_PUSH_BUNDLE_ID,
  /** 중계→APNs 한 건의 시간 한도. Mac→중계 한도(8초)보다 짧아야 Mac 이 확실한 결과를 먼저 받는다. */
  timeoutMs: 4_000,
  /** 한 연결에서 동시에 여는 스트림 수 [제안값]. 한 건이 멈춰도 다른 사용자가 줄 서지 않게. */
  maxInFlight: 16,
  /** 동시 스트림이 다 찼을 때 기다리는 최대 시간 [제안값]. 넘으면 보내지 않고 503(다시 시도)으로 답한다. */
  maxQueueWaitMs: 750,
  /** APNs 가 키를 거절(403)하거나 키를 읽지 못하면 이만큼 APNs 로 보내지 않고 503 으로 답한다 [제안값]. */
  authHoldMs: 10 * 60_000,
});

/**
 * 남용 막기 [제안값]. 모두 이 인스턴스의 메모리에서 세는 최선 노력 한도다. 인스턴스가 쉬어 내려가거나(유휴),
 * 다시 배포하거나(설정·허용·차단 목록을 바꿀 때 포함), 상한을 잠깐 넘겨 새 인스턴스가 뜨면 처음부터 다시 센다.
 * 오류 예산 정지(하루)도 그때 풀린다. 오래 막아야 하는 설치는 RELAY_BLOCKED_INSTALLATIONS 로 옮긴다(README '운영').
 */
export const RELAY_LIMITS = Object.freeze({
  installationPerMinute: 30,
  installationPerDay: 300,
  /** 토큰(iPhone)별. 토큰은 날마다 새로 만드는 메모리 비밀로 HMAC 한 값으로만 센다. */
  tokenPerDay: 200,
  /**
   * 설치 만들기: IP(IPv4 는 주소, IPv6 는 /64)별 하루. IP 도 HMAC 한 값으로만 센다.
   * 전체 한도에 막힌 요청은 세지 않는다(다시 시도하는 정상 Mac 이 자기 몫을 태우지 않게). IP 표가 차면 이 한도는 건너뛴다.
   */
  createPerIpPerDay: 5,
  /**
   * 설치 만들기: 이 인스턴스 전체 한 시간. 넘으면 503 relay_busy(그 시간만). 등록은 저장 없이 HMAC 한 번이라 값싸고,
   * 보내기 쪽은 설치·토큰·전체 분 한도가 따로 막으므로 넉넉히 둔다. RELAY_MASTER 를 바꾸면 모든 Mac 이 다음 알림 때
   * 다시 등록하므로, 활성 Mac 이 이보다 많으면 그 배포에서 잠시 올린다(README '운영').
   */
  createPerHour: 1_000,
  /** 보내기: 이 인스턴스 전체 1분. APNs 연결은 모두가 같이 쓴다. */
  sendsPerMinute: 1_200,
  /** 오류 예산: 한 설치가 한 시간에 영구 토큰 오류(Unregistered·BadDeviceToken 등)를 이만큼 넘기면 하루 정지. */
  errorBudget: 20,
  errorWindowMs: 60 * 60_000,
  errorSuspendMs: 24 * 60 * 60_000,
  /** 메모리 표 한 개의 최대 항목 수. 차면 지난 항목을 지우고, 그래도 차 있으면 거절한다(IP 표만은 IP 한도를 건너뛴다). */
  maxEntries: 50_000,
});

/**
 * 손님(Mac) IP 를 읽는 자리. X-Forwarded-For 의 끝에서 몇 번째 값인가.
 * 함수 주소(run.app)로 바로 부르면 Google 앞단이 연결한 쪽의 IP 를 맨 끝에 하나 붙이고, 보낸 쪽이 넣은 값은 그 앞에 남는다
 * [공식 문서 없음. Google 개발자 포럼의 실측 보고]. 그래서 끝의 값만 믿고 첫 값·Fastly-Client-IP 같은 머리글은 쓰지 않는다.
 * 실제 배포에서 확인한다(README 배포 9단계): 머리글 없이 보낸 등록의 응답 머리글 X-Relay-Forwarded-Count 가 1 이면 맞고,
 * 2 면 앞단이 두 값을 붙이는 것이니 2 로 바꾼다. 그 뒤로는 relay_hourly 의 create_xff_1(Mac 은 이 머리글을 보내지 않는다)로 본다.
 */
export const RELAY_CLIENT_IP = Object.freeze({ forwardedForFromEnd: 1 });

/** 요청 본문의 최대 크기(바이트). 정상 본문은 600바이트 남짓이다. */
export const MAX_BODY_BYTES = 4_096;

/** 다시 시도 시각(초). */
export const RETRY_AFTER = Object.freeze({
  off: 3_600,
  notAllowed: 3_600,
  blocked: 24 * 3_600,
  busy: 5,
  configError: 600,
  apnsThrottle: 60,
});
