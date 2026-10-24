import type { LinkSocket } from "../session.js";

/** Rewrites what one end sends before the other receives it: none, one or several messages. */
export type Tap = (data: Uint8Array) => Uint8Array[];

/** One end of an in-memory WebSocket. Delivery is asynchronous and ordered, like a socket over TCP. */
export class TestSocket implements LinkSocket {
  peer!: TestSocket;
  tap: Tap | null = null;
  /** What `bufferedAmount` reports, as if the peer had stopped reading. */
  buffered = 0;
  readonly sent: Uint8Array[] = [];
  closedWith: { code: number; reason: string } | null = null;
  private messageListener: (data: Uint8Array) => void = () => {};
  private closeListener: (code: number, reason: string) => void = () => {};

  send(data: Uint8Array): void {
    if (this.closedWith) return;
    this.sent.push(data);
    for (const delivery of this.tap ? this.tap(data) : [Uint8Array.from(data)]) queueMicrotask(() => this.peer.deliver(delivery));
  }

  bufferedAmount(): number {
    return this.buffered;
  }

  close(code: number, reason: string): void {
    if (this.closedWith) return;
    this.closedWith = { code, reason };
    queueMicrotask(() => {
      this.closeListener(code, reason);
      this.peer.closedByPeer(code, reason);
    });
  }

  onMessage(listener: (data: Uint8Array) => void): void {
    this.messageListener = listener;
  }

  onClose(listener: (code: number, reason: string) => void): void {
    this.closeListener = listener;
  }

  private deliver(data: Uint8Array): void {
    if (!this.closedWith) this.messageListener(data);
  }

  private closedByPeer(code: number, reason: string): void {
    if (this.closedWith) return;
    this.closedWith = { code, reason };
    this.closeListener(code, reason);
  }
}

export function socketPair(): { phone: TestSocket; mac: TestSocket } {
  const phone = new TestSocket();
  const mac = new TestSocket();
  phone.peer = mac;
  mac.peer = phone;
  return { phone, mac };
}
