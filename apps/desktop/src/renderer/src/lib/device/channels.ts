import type { DeviceChannelKind, DeviceRelayEvent, DeviceRelayRequest } from "@openorc/protocol";
import { core } from "../rpc";

/** A body chunk or one socket message. Binary always arrives as bytes, whatever view the core sent. */
export type ChannelData = Uint8Array<ArrayBuffer> | string;

export interface ChannelHandlers {
  opened?: (contentType: string | undefined) => void;
  data: (data: ChannelData) => void;
  /** The core ended the channel, or the port it lived on went away. Never called after `close()`. */
  closed: (end: { status?: number; reason?: string }) => void;
}

export interface DeviceChannel {
  send: (data: ArrayBuffer | Uint8Array | string) => void;
  close: () => void;
}

export type ChannelOpener = Pick<DeviceChannels, "open">;

/** The part of a MessagePort the client uses, so tests can hand it a fake. */
export type MediaPort = Pick<MessagePort, "postMessage" | "start"> & { onmessage: ((event: MessageEvent) => void) | null };

function wireData(data: ArrayBuffer | Uint8Array | string): ArrayBuffer | string {
  if (typeof data === "string" || data instanceof ArrayBuffer) return data;
  const { buffer } = data;
  if (buffer instanceof ArrayBuffer && data.byteOffset === 0 && data.byteLength === buffer.byteLength) return buffer;
  return data.slice().buffer;
}

function readData(data: unknown): ChannelData | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data) && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

type RelayEvent =
  { type: "opened"; channel: number; contentType?: string } | { type: "data"; channel: number; data: ChannelData } | { type: "closed"; channel: number; status?: number; reason?: string };

/** Parses a message from the core. Anything that is not a well-formed relay event is dropped. */
function readEvent(raw: unknown): RelayEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const event = raw as Partial<DeviceRelayEvent>;
  if (typeof event.channel !== "number") return null;
  const channel = event.channel;
  if (event.type === "opened") return { type: "opened", channel, ...(typeof event.contentType === "string" ? { contentType: event.contentType } : {}) };
  if (event.type === "closed")
    return { type: "closed", channel, ...(typeof event.status === "number" ? { status: event.status } : {}), ...(typeof event.reason === "string" ? { reason: event.reason } : {}) };
  if (event.type !== "data") return null;
  const data = readData(event.data);
  return data === null ? null : { type: "data", channel, data };
}

/**
 * Device streams over the window's media port. A channel names a kind and a device; the core maps that to one hub
 * route and relays it. Opens made before the port arrives wait for it.
 */
export class DeviceChannels {
  private port: MediaPort | null = null;
  private nextChannel = 1;
  private readonly channels = new Map<number, ChannelHandlers>();
  private queued: DeviceRelayRequest[] = [];

  attach(port: MediaPort): void {
    if (port === this.port) return;
    const replaced = this.port !== null;
    this.port = port;
    port.onmessage = (event) => this.receive(event.data);
    port.start();
    for (const message of this.queued.splice(0)) this.post(message);
    if (!replaced) return;
    // The core ended every channel of the old port with it.
    const orphans = [...this.channels.values()];
    this.channels.clear();
    for (const handlers of orphans) handlers.closed({ reason: "The connection to OpenOrc's core restarted." });
  }

  open(kind: DeviceChannelKind, deviceId: string, handlers: ChannelHandlers): DeviceChannel {
    const channel = this.nextChannel++;
    this.channels.set(channel, handlers);
    this.post({ type: "open", channel, kind, deviceId });
    return {
      send: (data) => {
        if (this.channels.has(channel)) this.post({ type: "send", channel, data: wireData(data) });
      },
      close: () => {
        if (!this.channels.delete(channel)) return;
        if (this.port) this.post({ type: "close", channel });
        else this.queued = this.queued.filter((message) => message.channel !== channel);
      },
    };
  }

  private post(message: DeviceRelayRequest): void {
    // Never a transfer list: Electron delivers a message that transfers an ArrayBuffer as null.
    if (this.port) this.port.postMessage(message);
    else this.queued.push(message);
  }

  private receive(raw: unknown): void {
    const event = readEvent(raw);
    const handlers = event ? this.channels.get(event.channel) : undefined;
    if (!event || !handlers) return;
    if (event.type === "opened") handlers.opened?.(event.contentType);
    else if (event.type === "data") handlers.data(event.data);
    else {
      this.channels.delete(event.channel);
      handlers.closed({ status: event.status, reason: event.reason });
    }
  }
}

export const deviceChannels = new DeviceChannels();
core.onMediaPort((port) => deviceChannels.attach(port));
