import type { WsEvent } from "../shared/types.ts";

export type BusListener = (event: WsEvent) => void;

export class Bus {
  private listeners = new Set<BusListener>();
  /** 지금까지 낸 이벤트 수. hello 로 알려 준다. */
  seq = 0;

  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: WsEvent): void {
    this.seq++;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        // 쓰기는 이미 끝났다. 받는 쪽 하나의 오류로 호출자를 실패시키지 않는다.
        console.error("bus listener 오류:", e);
      }
    }
  }
}
