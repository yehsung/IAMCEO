// 거절·성공을 보통의 await 로 받아 단정하는 도우미. 불러오기만으로는 아무것도 하지 않는다.
//
// bun:test 의 `await expect(p).rejects`·`.resolves` 는 약속이 풀릴 때까지 그 자리에서 이벤트 루프를 한 겹 더 돌리고 돌아온다
// (Bun 1.3.14, 돌려주는 값이 Promise 가 아니다). 그 안쪽 루프 동안 같은 프로세스의 가짜 core 소켓이 요청을 하나도 받지 못하는 때가 있다:
// 2초 동안 타이머·HTTP 왕복·다른 node:net 서버 왕복은 38번씩 돌았는데 가짜 core 가 받은 요청은 0건이었고, CoreRunner 의 RPC 가
// "terminal.get: no reply within 2000ms" 로 끝났다. 바로 앞의 await 가 어디서 풀렸는지에 따라 갈려(앞에 await 하나를 더 두면 지나간다)
// 느린 CI 에서는 거의 늘, 이 Mac 에서도 자주 났다(0.2.4 CI, usage-limit-model 에서 A/B 로 확정). 보통의 await 는 바깥 루프에서 기다려 이 일이 없다.
//
// 그래서 같은 프로세스에 core 소켓을 띄우는 시험 파일(가짜 core 틀·브라우저 core 틀·node:net 서버)은 .rejects·.resolves 를 쓰지 않는다.
// tests/settle-guard.test.ts 가 지킨다. 옮기는 법(단정은 그대로):
//   await expect(p).rejects.toMatchObject(x)  →  expect(await rejection(p)).toMatchObject(x)
//   await expect(p).rejects.toThrow(x)        →  expect(await thrower(p)).toThrow(x)
//   await expect(p).resolves.toBe(x)          →  expect(await p).toBe(x)

/** 약속이 거절한 값. 성공하면 던진다. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  throw new Error("거절되어야 할 동작이 성공했습니다");
}

/** 거절한 값을 다시 던지는 함수. `.rejects.toThrow(x)` 와 같은 판정을 `expect(await thrower(p)).toThrow(x)` 로 한다. 성공하면 던진다. */
export async function thrower(promise: Promise<unknown>): Promise<() => never> {
  const error = await rejection(promise);
  return () => { throw error; };
}
