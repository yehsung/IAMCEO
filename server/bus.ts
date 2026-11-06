import { randomUUID } from "node:crypto";
import type { SyncCursor, WsEvent } from "../shared/types.ts";

export type BusListener = (event: WsEvent, cursor: Readonly<SyncCursor>) => void;

export class Bus {
  private listeners = new Set<BusListener>();
  /** 지금까지 낸 이벤트 수. hello 로 알려 준다. */
  seq = 0;
  private currentEpoch = randomUUID();

  get epoch(): string { return this.currentEpoch; }
  get cursor(): Readonly<SyncCursor> { return Object.freeze({ epoch: this.epoch, seq: this.seq }); }

  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: WsEvent): void {
    if (this.seq >= Number.MAX_SAFE_INTEGER - 1) {
      this.currentEpoch = randomUUID();
      this.seq = 0;
    }
    this.seq++;
    const cursor = this.cursor;
    for (const listener of this.listeners) {
      try {
        listener(event, cursor);
      } catch (e) {
        // 쓰기는 이미 끝났다. 받는 쪽 하나의 오류로 호출자를 실패시키지 않는다.
        console.error("bus listener 오류:", e);
      }
    }
  }
}
