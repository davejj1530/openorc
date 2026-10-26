import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { DeviceChannelKind } from "@openorc/protocol";
import { AndroidTransport } from "./android-transport";
import type { ChannelHandlers, ChannelOpener } from "./channels";
import { IosTransport } from "./ios-transport";
import type { FrameSink, StreamEvents } from "./stream";

type Opened = { kind: DeviceChannelKind; handlers: ChannelHandlers; sent: Array<ArrayBuffer | Uint8Array | string>; closed: boolean };

function fakeChannels() {
  const opened: Opened[] = [];
  const channels: ChannelOpener & { opened: Opened[]; all: (kind: DeviceChannelKind) => Opened[] } = {
    opened,
    all: (kind) => opened.filter((channel) => channel.kind === kind),
    open: (kind, _deviceId, handlers) => {
      const channel: Opened = { kind, handlers, sent: [], closed: false };
      opened.push(channel);
      return { send: (data) => void channel.sent.push(data), close: () => void (channel.closed = true) };
    },
  };
  return channels;
}

class FakeDecoder {
  static isConfigSupported = vi.fn(async (_config: VideoDecoderConfig) => ({ supported: true }));
  static instances: FakeDecoder[] = [];
  state: CodecState = "unconfigured";
  decodeQueueSize = 0;
  readonly chunks: Array<{ type: string }> = [];
  constructor(readonly init: VideoDecoderInit) {
    FakeDecoder.instances.push(this);
  }
  configure() {
    this.state = "configured";
  }
  decode(chunk: { init: { type: string } }) {
    this.chunks.push(chunk.init);
  }
  close() {
    this.state = "closed";
  }
  emit(width: number, height: number) {
    const frame = { displayWidth: width, displayHeight: height, close: vi.fn() };
    this.init.output(frame as unknown as VideoFrame);
    return frame;
  }
}

const envelope = (tag: number, payload: number[]) => {
  const length = 1 + payload.length;
  return [(length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff, tag, ...payload];
};
const tagged = (tag: number, payload: unknown) => Uint8Array.from([tag, ...new TextEncoder().encode(JSON.stringify(payload))]);
const sentMessage = (data: ArrayBuffer | Uint8Array | string | undefined) => {
  const bytes = new Uint8Array(data as ArrayBuffer);
  return { tag: bytes[0], payload: JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as unknown };
};
// The fallback encoder's avcC record captured from the hub, and the record the viewer configures instead.
const fallback = [1, 100, 0, 51, 255, 225, 0, 12, 39, 100, 0, 51, 172, 86, 128, 76, 1, 73, 230, 164, 1, 0, 4, 40, 238, 60, 176];
const repaired = Uint8Array.from([1, 100, 0, 51, 255, 225, 0, 17, 39, 100, 0, 51, 172, 86, 128, 76, 1, 73, 230, 168, 6, 208, 68, 35, 80, 1, 0, 4, 40, 238, 60, 176]);

let sink: { present: Mock<FrameSink["present"]> };
let events: { [K in keyof StreamEvents]: Mock<StreamEvents[K]> };
const flush = () => vi.advanceTimersByTimeAsync(0);
const statuses = () => events.status.mock.calls.map(([status]) => (status as { kind: string }).kind);

beforeEach(() => {
  vi.useFakeTimers();
  FakeDecoder.instances = [];
  FakeDecoder.isConfigSupported.mockClear();
  FakeDecoder.isConfigSupported.mockImplementation(async () => ({ supported: true }));
  vi.stubGlobal("VideoDecoder", FakeDecoder);
  vi.stubGlobal(
    "EncodedVideoChunk",
    class {
      constructor(readonly init: { type: string }) {}
    },
  );
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 1206, height: 2622, close: vi.fn() })),
  );
  sink = { present: vi.fn<FrameSink["present"]>(() => true) };
  events = { status: vi.fn<StreamEvents["status"]>(), screen: vi.fn<StreamEvents["screen"]>(), input: vi.fn<StreamEvents["input"]>() };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("iOS", () => {
  const start = () => {
    const channels = fakeChannels();
    const transport = new IosTransport(channels, "UDID-1", sink, events);
    transport.start();
    return { channels, transport };
  };

  it("wakes the helper through MJPEG, then sends input only once the helper admits it, in the framebuffer's space", async () => {
    const { channels, transport } = start();
    expect(channels.opened.map((channel) => channel.kind)).toEqual(["ios-mjpeg", "ios-video"]);
    channels.opened[0]!.handlers.data(Uint8Array.of(1));
    await flush();
    expect(channels.opened[0]!.closed).toBe(true);
    const [control] = channels.all("ios-control");
    transport.touch("begin", { x: 0.5, y: 0.5 });
    expect(control!.sent).toEqual([]);
    control!.handlers.data(Uint8Array.of(0x83));
    control!.handlers.data(tagged(0x82, { width: 1206, height: 2622, orientation: "landscape_left" }));
    expect(events.input).toHaveBeenLastCalledWith(true);
    expect(events.screen).toHaveBeenCalledWith({ width: 1206, height: 2622, orientation: "landscape_left" });
    transport.touch("begin", { x: 0.25, y: 0.75 });
    transport.press("rotate");
    expect(control!.sent.map(sentMessage)).toEqual([
      { tag: 0x03, payload: { type: "begin", x: 0.75, y: 0.75 } },
      { tag: 0x07, payload: { orientation: "portrait_upside_down" } },
    ]);
    transport.stop();
    expect(channels.opened.every((channel) => channel.closed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("paints the seed, configures the decoder with the repaired SPS, and keeps a late seed off newer video", async () => {
    let resolveSeed!: (bitmap: { width: number; height: number; close: () => void }) => void;
    vi.stubGlobal("createImageBitmap", () => new Promise((resolve) => (resolveSeed = resolve)));
    const { channels, transport } = start();
    const [video] = channels.all("ios-video");
    video!.handlers.data(Uint8Array.from([...envelope(4, [0xff, 0xd8, 0xff, 0xd9]), ...envelope(1, fallback), ...envelope(2, [0, 0, 0, 1, 0x65])]));
    await flush();
    expect(FakeDecoder.isConfigSupported).toHaveBeenCalledExactlyOnceWith({ codec: "avc1.640033", description: repaired, optimizeForLatency: true });
    const decoder = FakeDecoder.instances[0]!;
    expect(decoder.chunks).toEqual([expect.objectContaining({ type: "key" })]);
    const frame = decoder.emit(1206, 2622);
    expect(sink.present).toHaveBeenCalledExactlyOnceWith(frame, 1206, 2622);
    expect(frame.close).toHaveBeenCalledOnce();
    const seed = { width: 1206, height: 2622, close: vi.fn() };
    resolveSeed(seed);
    await flush();
    expect(sink.present).toHaveBeenCalledOnce();
    expect(seed.close).toHaveBeenCalledOnce();
    expect(statuses()).toEqual(["connecting", "streaming"]);
    transport.stop();
  });

  it("falls back to MJPEG when this window cannot decode the simulator's H.264", async () => {
    FakeDecoder.isConfigSupported.mockImplementation(async () => ({ supported: false }));
    const { channels, transport } = start();
    channels.opened[0]!.handlers.data(Uint8Array.of(1));
    const [video] = channels.all("ios-video");
    video!.handlers.data(Uint8Array.from(envelope(1, fallback)));
    await flush();
    expect(video!.closed).toBe(true);
    const mjpeg = channels.all("ios-mjpeg").at(-1)!;
    expect(mjpeg).not.toBe(channels.opened[0]);
    mjpeg.handlers.opened?.("multipart/x-mixed-replace; boundary=frame");
    const jpeg = [0xff, 0xd8, 1, 2, 0xff, 0xd9];
    mjpeg.handlers.data(Uint8Array.from([...new TextEncoder().encode(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`), ...jpeg, 13, 10]));
    await flush();
    expect(sink.present).toHaveBeenCalledOnce();
    expect(statuses()).toEqual(["connecting", "streaming"]);
    transport.stop();
  });

  it("reopens a dropped feed, waits longer while tries fail, and says why there is no picture yet", async () => {
    const { channels, transport } = start();
    const feeds = () => channels.all("ios-video");
    feeds()[0]!.handlers.closed({ status: 503 });
    expect(events.status).toHaveBeenLastCalledWith({ kind: "connecting", detail: "The device stream answered 503." });
    await vi.advanceTimersByTimeAsync(1_000);
    feeds()[1]!.handlers.closed({ status: 503 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(feeds()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    feeds()[2]!.handlers.data(Uint8Array.from(envelope(4, [0xff, 0xd8, 0xff, 0xd9])));
    await flush();
    expect(events.status).toHaveBeenLastCalledWith({ kind: "streaming" });
    feeds()[2]!.handlers.closed({ reason: "hub restarted" });
    expect(events.status).toHaveBeenLastCalledWith({ kind: "reconnecting", detail: "hub restarted" });
    // A frame resets the wait, so a feed that worked a moment ago comes back quickly.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(feeds()).toHaveLength(4);
    transport.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Android", () => {
  const semu = (isKey: boolean, payload: number[]) => {
    const bytes = new Uint8Array(16 + payload.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x53454d55);
    view.setUint8(4, 1);
    view.setUint8(5, isKey ? 1 : 0);
    bytes.set(payload, 16);
    return bytes;
  };
  const keyframe = semu(true, [0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f, 0, 0, 1, 0x65, 0xaa]);
  const start = () => {
    const channels = fakeChannels();
    const transport = new AndroidTransport(channels, "Pixel_9", sink, events);
    transport.start();
    const socket = channels.all("android")[0]!;
    socket.handlers.opened?.(undefined);
    return { channels, transport, socket };
  };
  const keyframeRequests = (socket: Opened) => socket.sent.filter((message) => message === '{"type":"reset-video","ack":false}').length;

  it("configures from the first SPS, asks for a keyframe, then decodes and reports the screen size", async () => {
    const { transport, socket } = start();
    expect(events.input).toHaveBeenLastCalledWith(true);
    socket.handlers.data(keyframe);
    await flush();
    expect(FakeDecoder.isConfigSupported).toHaveBeenCalledWith({ codec: "avc1.64001f", optimizeForLatency: true });
    expect(keyframeRequests(socket)).toBe(1);
    socket.handlers.data(keyframe);
    const decoder = FakeDecoder.instances[0]!;
    expect(decoder.chunks).toEqual([expect.objectContaining({ type: "key" })]);
    decoder.emit(1080, 2400);
    expect(events.screen).toHaveBeenCalledWith({ width: 1080, height: 2400, orientation: "portrait" });
    expect(statuses()).toEqual(["connecting", "streaming"]);
    socket.handlers.data('{"type":"video-session"}');
    expect(decoder.state).toBe("closed");
    expect(keyframeRequests(socket)).toBe(2);
    transport.stop();
  });

  it("asks once for a keyframe when the decoder falls behind, however many deltas arrive before it", async () => {
    const { transport, socket } = start();
    socket.handlers.data(keyframe);
    await flush();
    socket.handlers.data(keyframe);
    const asked = keyframeRequests(socket);
    FakeDecoder.instances[0]!.decodeQueueSize = 9;
    for (let index = 0; index < 5; index++) socket.handlers.data(semu(false, [0, 0, 0, 1, 0x41, 0x9a]));
    expect(keyframeRequests(socket)).toBe(asked + 1);
    socket.handlers.data(keyframe);
    await flush();
    expect(keyframeRequests(socket)).toBe(asked + 2);
    transport.stop();
  });

  it("sends touches, keys, pasted text and buttons as the emulator's JSON", () => {
    const { transport, socket } = start();
    transport.touch("begin", { x: 0.5, y: 0.25 });
    transport.key({ code: "Escape", key: "Escape", metaKey: false, ctrlKey: false }, "down");
    transport.key({ code: "KeyA", key: "a", metaKey: false, ctrlKey: false }, "up");
    transport.paste("hi");
    transport.press("recents");
    expect(socket.sent.map((message) => JSON.parse(message as string) as unknown)).toEqual([
      { type: "touch", action: "down", x: 0.5, y: 0.25 },
      { type: "back" },
      { type: "text", text: "hi" },
      { type: "recents" },
    ]);
    transport.stop();
  });

  it("reconnects a dropped socket, and stops for good when told to", async () => {
    const { channels, transport, socket } = start();
    socket.handlers.data(keyframe);
    await flush();
    socket.handlers.data(keyframe);
    FakeDecoder.instances[0]!.emit(1080, 2400);
    socket.handlers.closed({ reason: "emulator restarted" });
    expect(events.input).toHaveBeenLastCalledWith(false);
    expect(statuses()).toEqual(["connecting", "streaming", "reconnecting"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channels.all("android")).toHaveLength(2);
    transport.stop();
    expect(channels.all("android").every((channel) => channel.closed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("says when this window cannot decode Android video at all", () => {
    vi.stubGlobal("VideoDecoder", undefined);
    Reflect.deleteProperty(globalThis, "VideoDecoder");
    const channels = fakeChannels();
    new AndroidTransport(channels, "Pixel_9", sink, events).start();
    expect(events.status).toHaveBeenLastCalledWith({ kind: "failed", reason: "This window cannot decode Android video." });
    expect(channels.opened).toEqual([]);
  });

  it("stops for good, without retrying, when the emulator's codec cannot be decoded", async () => {
    FakeDecoder.isConfigSupported.mockImplementation(async () => ({ supported: false }));
    const { channels, socket } = start();
    socket.handlers.data(keyframe);
    await flush();
    expect(events.status).toHaveBeenLastCalledWith({ kind: "failed", reason: "This window cannot decode the emulator's avc1.64001f video." });
    expect(socket.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(channels.all("android")).toHaveLength(1);
    expect(events.status).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "failed" }));
  });
});
