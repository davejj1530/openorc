import type { DeviceRelayEvent } from "@openorc/protocol";
import type { MediaPort } from "../relay.js";

/** The core's end of a window's media port, as the relay sees it. */
export class FakePort implements MediaPort {
  readonly events: DeviceRelayEvent[] = [];
  private readonly listeners: { message: ((event: { data: unknown }) => void)[]; close: (() => void)[] } = { message: [], close: [] };
  started = false;

  on(event: "message", listener: (event: { data: unknown }) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "message" | "close", listener: ((event: { data: unknown }) => void) | (() => void)): this {
    (this.listeners[event] as unknown[]).push(listener);
    return this;
  }

  postMessage(message: DeviceRelayEvent): void {
    this.events.push(message);
  }

  start(): void {
    this.started = true;
  }

  send(data: unknown): void {
    for (const listener of this.listeners.message) listener({ data });
  }

  close(): void {
    for (const listener of this.listeners.close) listener();
  }

  of(channel: number): DeviceRelayEvent[] {
    return this.events.filter((event) => event.channel === channel);
  }
}
