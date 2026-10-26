import { describe, expect, it, vi } from "vitest";
import type { DeviceRelayEvent } from "@openorc/protocol";
import { DeviceChannels, type ChannelHandlers, type MediaPort } from "./channels";

function fakePort() {
  const port = { onmessage: null as ((event: MessageEvent) => void) | null, start: vi.fn(), postMessage: vi.fn() };
  return {
    port: port as MediaPort,
    posted: () => port.postMessage.mock.calls,
    emit: (event: DeviceRelayEvent | Record<string, unknown>) => port.onmessage?.({ data: event } as MessageEvent),
  };
}

const handlers = () => ({ opened: vi.fn(), data: vi.fn(), closed: vi.fn() }) satisfies ChannelHandlers;

describe("DeviceChannels", () => {
  it("opens a channel by kind and device and routes the core's events to it alone", () => {
    const { port, posted, emit } = fakePort();
    const channels = new DeviceChannels();
    channels.attach(port);
    const video = handlers();
    const control = handlers();
    channels.open("ios-video", "UDID-1", video);
    channels.open("ios-control", "UDID-1", control);
    expect(posted()).toEqual([[{ type: "open", channel: 1, kind: "ios-video", deviceId: "UDID-1" }], [{ type: "open", channel: 2, kind: "ios-control", deviceId: "UDID-1" }]]);
    emit({ type: "opened", channel: 1, contentType: "application/octet-stream" });
    emit({ type: "data", channel: 1, data: Uint8Array.of(1, 2).buffer, at: 0 });
    emit({ type: "data", channel: 2, data: Uint8Array.of(0, 9, 8).subarray(1), at: 0 });
    emit({ type: "data", channel: 2, data: "text", at: 0 });
    expect(video.opened).toHaveBeenCalledWith("application/octet-stream");
    expect(video.data.mock.calls).toEqual([[Uint8Array.of(1, 2)]]);
    expect(control.data.mock.calls).toEqual([[Uint8Array.of(9, 8)], ["text"]]);
  });

  it("posts binary without a transfer list, as a buffer holding exactly the bytes sent", () => {
    const { port, posted } = fakePort();
    const channels = new DeviceChannels();
    channels.attach(port);
    const channel = channels.open("android", "Pixel_9", handlers());
    channel.send(Uint8Array.of(7, 8, 9).subarray(1));
    channel.send('{"type":"home"}');
    const [, binary, text] = posted();
    expect(binary).toHaveLength(1);
    expect(binary![0]).toMatchObject({ type: "send", channel: 1 });
    expect(new Uint8Array((binary![0] as { data: ArrayBuffer }).data)).toEqual(Uint8Array.of(8, 9));
    expect(text).toEqual([{ type: "send", channel: 1, data: '{"type":"home"}' }]);
  });

  it("closes once, then delivers nothing more and sends nothing more", () => {
    const { port, posted, emit } = fakePort();
    const channels = new DeviceChannels();
    channels.attach(port);
    const video = handlers();
    const channel = channels.open("ios-mjpeg", "UDID-1", video);
    channel.close();
    channel.close();
    channel.send("late");
    emit({ type: "data", channel: 1, data: "late", at: 0 });
    emit({ type: "closed", channel: 1 });
    expect(posted().map(([message]) => (message as { type: string }).type)).toEqual(["open", "close"]);
    expect(video.data).not.toHaveBeenCalled();
    expect(video.closed).not.toHaveBeenCalled();
  });

  it("tells a channel the core ended it, with the status, and forgets it", () => {
    const { port, emit } = fakePort();
    const channels = new DeviceChannels();
    channels.attach(port);
    const video = handlers();
    channels.open("ios-video", "UDID-1", video);
    emit({ type: "closed", channel: 1, status: 503 });
    emit({ type: "data", channel: 1, data: "late", at: 0 });
    expect(video.closed).toHaveBeenCalledExactlyOnceWith({ status: 503, reason: undefined });
    expect(video.data).not.toHaveBeenCalled();
  });

  it("holds opens until the port arrives, and drops a channel closed before then", () => {
    const channels = new DeviceChannels();
    channels.open("ios-video", "UDID-1", handlers()).close();
    channels.open("ios-control", "UDID-1", handlers());
    const { port, posted } = fakePort();
    channels.attach(port);
    expect(posted()).toEqual([[{ type: "open", channel: 2, kind: "ios-control", deviceId: "UDID-1" }]]);
  });

  it("ends every channel when a new port replaces the old one", () => {
    const first = fakePort();
    const channels = new DeviceChannels();
    channels.attach(first.port);
    const video = handlers();
    channels.open("android", "Pixel_9", video);
    const second = fakePort();
    channels.attach(second.port);
    expect(video.closed).toHaveBeenCalledOnce();
    first.emit({ type: "data", channel: 1, data: "stale", at: 0 });
    second.emit({ type: "data", channel: 1, data: "stale", at: 0 });
    expect(video.data).not.toHaveBeenCalled();
  });

  it("ignores messages that are not relay events", () => {
    const { port, emit } = fakePort();
    const channels = new DeviceChannels();
    channels.attach(port);
    const video = handlers();
    channels.open("ios-video", "UDID-1", video);
    emit({ type: "data", channel: "1", data: "x" });
    emit({ type: "data", channel: 1, data: 42 });
    emit({ type: "unknown", channel: 1 });
    expect(video.data).not.toHaveBeenCalled();
    expect(video.closed).not.toHaveBeenCalled();
  });
});
