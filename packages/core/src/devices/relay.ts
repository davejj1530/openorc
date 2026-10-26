import { DeviceChannelKind, type DevicePlatform, type DeviceRelayEvent, type DeviceRelayRequest } from "@openorc/protocol";

/** The core's end of a window's media port: MessagePortMain in the app. */
export interface MediaPort {
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  postMessage(message: DeviceRelayEvent): void;
  start(): void;
}

/** What the relay needs from the core: device targets and the hub, whose address and token never reach a window. */
export interface RelaySource {
  /** The UDID of an attached simulator or the serial of a running emulator. Throws a short reason otherwise. */
  target(platform: DevicePlatform, deviceId: string): Promise<string>;
  request(route: string, init: RequestInit): Promise<Response>;
  socket(route: string): Promise<WebSocket>;
}

/** Each kind a window may ask for maps to exactly one hub route. Nothing else on the hub is reachable from a window. */
const routes: Record<DeviceChannelKind, { platform: DevicePlatform; transport: "http" | "ws"; route(target: string): string }> = {
  "ios-video": { platform: "ios", transport: "http", route: (udid) => `/vendor/serve-sim/helper/${encodeURIComponent(udid)}/stream.avcc` },
  "ios-mjpeg": { platform: "ios", transport: "http", route: (udid) => `/vendor/serve-sim/helper/${encodeURIComponent(udid)}/stream.mjpeg` },
  "ios-control": { platform: "ios", transport: "ws", route: (udid) => `/vendor/serve-sim/helper/ws?device=${encodeURIComponent(udid)}` },
  android: { platform: "android", transport: "ws", route: (serial) => `/vendor/serve-emu/ws?device=${encodeURIComponent(serial)}&frame-meta=1` },
};

const MAX_CHANNELS = 16;
const STREAM_ENDED = "The device stream stopped.";

type Payload = ArrayBuffer | string;

interface Channel {
  send(data: Payload): void;
  close(): void;
}

const now = () => performance.timeOrigin + performance.now();

/** Relays one window's channels. Every message is checked by hand: this is the media path, and it is hot. */
export function attachRelay(port: MediaPort, source: RelaySource): void {
  const channels = new Map<number, Channel>();
  const post = (event: DeviceRelayEvent) => port.postMessage(event);
  /** Ends a channel the hub side closed. A channel the window already closed hears nothing more. */
  const end = (channel: number, owner: Channel, event: Omit<Extract<DeviceRelayEvent, { type: "closed" }>, "type" | "channel">) => {
    if (channels.get(channel) !== owner) return;
    channels.delete(channel);
    post({ type: "closed", channel, ...event });
  };
  const open = (channel: number, kind: DeviceChannelKind, deviceId: string) => {
    if (channels.has(channel) || channels.size >= MAX_CHANNELS) {
      post({ type: "closed", channel, reason: channels.has(channel) ? "That channel is already open." : "Too many device streams in this window." });
      return;
    }
    const spec = routes[kind];
    const relay = spec.transport === "http" ? httpChannel : socketChannel;
    channels.set(channel, relay({ channel, post, end, source, platform: spec.platform, route: spec.route, deviceId }));
  };
  port.on("message", (event) => {
    const request = parseRequest(event.data);
    if (!request) {
      const channel = refusedOpen(event.data);
      if (channel !== null) post({ type: "closed", channel, reason: "Unknown device stream." });
      return;
    }
    if (request.type === "open") open(request.channel, request.kind, request.deviceId);
    else if (request.type === "send") channels.get(request.channel)?.send(request.data);
    else {
      channels.get(request.channel)?.close();
      channels.delete(request.channel);
    }
  });
  port.on("close", () => {
    for (const channel of channels.values()) channel.close();
    channels.clear();
  });
  port.start();
}

interface ChannelContext {
  channel: number;
  post(event: DeviceRelayEvent): void;
  end(channel: number, owner: Channel, event: { status?: number; reason?: string }): void;
  source: RelaySource;
  platform: DevicePlatform;
  route(target: string): string;
  deviceId: string;
}

function httpChannel(context: ChannelContext): Channel {
  const abort = new AbortController();
  const self: Channel = { send: () => undefined, close: () => abort.abort() };
  const { channel, post, end, source } = context;
  void (async () => {
    try {
      const target = await source.target(context.platform, context.deviceId);
      if (abort.signal.aborted) return;
      const response = await source.request(context.route(target), { signal: abort.signal });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        end(channel, self, { status: response.status });
        return;
      }
      const contentType = response.headers.get("content-type");
      post({ type: "opened", channel, ...(contentType ? { contentType } : {}) });
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        post({ type: "data", channel, data: ownBuffer(value), at: now() });
      }
      end(channel, self, {});
    } catch (error) {
      if (!abort.signal.aborted) end(channel, self, { reason: targetReason(error) ?? STREAM_ENDED });
    }
  })();
  return self;
}

function socketChannel(context: ChannelContext): Channel {
  const { channel, post, end, source } = context;
  let socket: WebSocket | null = null;
  let closed = false;
  const pending: Payload[] = [];
  const self: Channel = {
    send: (data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(data);
      else if (!closed && pending.length < 64) pending.push(data);
    },
    close: () => {
      closed = true;
      socket?.close();
    },
  };
  void (async () => {
    try {
      const target = await source.target(context.platform, context.deviceId);
      if (closed) return;
      socket = await source.socket(context.route(target));
      if (closed) return socket.close();
      socket.addEventListener("open", () => {
        post({ type: "opened", channel });
        for (const data of pending.splice(0)) socket?.send(data);
      });
      socket.addEventListener("message", (event) => post({ type: "data", channel, data: event.data as ArrayBuffer | string, at: now() }));
      socket.addEventListener("close", () => end(channel, self, {}));
      socket.addEventListener("error", () => end(channel, self, { reason: STREAM_ENDED }));
    } catch (error) {
      if (!closed) end(channel, self, { reason: targetReason(error) ?? STREAM_ENDED });
    }
  })();
  return self;
}

/** Reasons the core wrote itself may reach a window; anything from fetch or the hub might name its address, so it does not. */
export class DeviceTargetError extends Error {}

function targetReason(error: unknown): string | null {
  return error instanceof DeviceTargetError ? error.message : null;
}

function ownBuffer(chunk: Uint8Array): ArrayBuffer {
  if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength && chunk.buffer instanceof ArrayBuffer) return chunk.buffer;
  return chunk.slice().buffer;
}

function parseRequest(value: unknown): DeviceRelayRequest | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  const channel = message["channel"];
  if (typeof channel !== "number" || !Number.isSafeInteger(channel) || channel < 0) return null;
  if (message["type"] === "close") return { type: "close", channel };
  if (message["type"] === "send") {
    const data = payload(message["data"]);
    return data === null ? null : { type: "send", channel, data };
  }
  const { kind, deviceId } = message;
  if (message["type"] !== "open" || typeof deviceId !== "string" || !deviceId || deviceId.length > 200) return null;
  if (!DeviceChannelKind.options.includes(kind as DeviceChannelKind)) return null;
  return { type: "open", channel, kind: kind as DeviceChannelKind, deviceId };
}

/** Windows send ArrayBuffers; a typed array is copied out of its buffer rather than refused. */
function payload(data: unknown): ArrayBuffer | string | null {
  if (typeof data === "string" || data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
  return null;
}

/** The channel of an open request that failed the checks, so the window hears why instead of waiting. */
function refusedOpen(value: unknown): number | null {
  const message = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const channel = message?.["channel"];
  return message?.["type"] === "open" && typeof channel === "number" && Number.isSafeInteger(channel) && channel >= 0 ? channel : null;
}
