import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeviceRelayEvent } from "@openorc/protocol";
import { startFakeHub, type FakeHub } from "./fixtures/fake-hub.js";
import { FakePort } from "./fixtures/fake-port.js";
import { until } from "./fixtures/wait.js";
import { attachRelay, DeviceTargetError, type RelaySource } from "./relay.js";

let hub: FakeHub;
let port: FakePort;
let targets: string[];

function source(overrides: Partial<RelaySource> = {}): RelaySource {
  const headers = { Authorization: `Bearer ${hub.token}` };
  return {
    target: async (platform, deviceId) => {
      targets.push(`${platform}:${deviceId}`);
      return platform === "android" ? "emulator-5554" : deviceId;
    },
    request: (route, init) => fetch(`http://127.0.0.1:${hub.port}${route}`, { ...init, headers }),
    socket: async (route) => {
      const socket = new WebSocket(`ws://127.0.0.1:${hub.port}${route}`, { headers });
      socket.binaryType = "arraybuffer";
      return socket;
    },
    ...overrides,
  };
}

const bytes = (event: DeviceRelayEvent | undefined) => (event?.type === "data" && event.data instanceof ArrayBuffer ? [...new Uint8Array(event.data)] : null);

beforeEach(async () => {
  hub = await startFakeHub("relay-token");
  port = new FakePort();
  targets = [];
});

afterEach(async () => {
  port.close();
  await hub.close();
});

describe("device media relay", () => {
  it("relays a simulator's video body in order, then closes the channel", async () => {
    attachRelay(port, source());
    expect(port.started).toBe(true);
    port.send({ type: "open", channel: 7, kind: "ios-video", deviceId: "UDID-1" });
    await until(() => port.of(7).some((event) => event.type === "closed"));

    const events = port.of(7);
    expect(events[0]).toEqual({ type: "opened", channel: 7, contentType: "video/avcc" });
    expect(events.slice(1, -1).map(bytes).flat()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events.at(-1)).toEqual({ type: "closed", channel: 7 });
    expect(hub.calls).toEqual([{ method: "GET", path: "/vendor/serve-sim/helper/UDID-1/stream.avcc", body: null, authorized: true }]);
  });

  it("maps each kind to its one hub route and nothing else", async () => {
    attachRelay(port, source());
    port.send({ type: "open", channel: 1, kind: "ios-mjpeg", deviceId: "UDID-1" });
    port.send({ type: "open", channel: 2, kind: "ios-control", deviceId: "UDID-1" });
    port.send({ type: "open", channel: 3, kind: "android", deviceId: "Pixel_9" });
    port.send({ type: "open", channel: 4, kind: "ios-video", deviceId: "../../api/exec" });
    await until(() => hub.calls.length === 4);
    expect(hub.calls.map((call) => `${call.method} ${call.path}`).sort()).toEqual([
      "GET /vendor/serve-sim/helper/..%2F..%2Fapi%2Fexec/stream.avcc",
      "GET /vendor/serve-sim/helper/UDID-1/stream.mjpeg",
      "WS /vendor/serve-emu/ws?device=emulator-5554&frame-meta=1",
      "WS /vendor/serve-sim/helper/ws?device=UDID-1",
    ]);
    expect(targets).toContain("android:Pixel_9");
    await until(() => port.of(1).some((event) => event.type === "opened"));
    expect(port.of(1)[0]).toEqual({ type: "opened", channel: 1, contentType: "multipart/x-mixed-replace; boundary=frame" });
  });

  it("refuses an unknown kind or a malformed open without touching the hub", async () => {
    attachRelay(port, source());
    port.send({ type: "open", channel: 1, kind: "shell", deviceId: "UDID-1" });
    port.send({ type: "open", channel: 2, kind: "ios-video", deviceId: "" });
    port.send({ type: "open", channel: -1, kind: "ios-video", deviceId: "UDID-1" });
    port.send("open ios-video");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(port.events).toEqual([
      { type: "closed", channel: 1, reason: "Unknown device stream." },
      { type: "closed", channel: 2, reason: "Unknown device stream." },
    ]);
    expect(hub.calls).toEqual([]);
    expect(targets).toEqual([]);
  });

  it("never hands a window the hub's address or token, even in failures", async () => {
    attachRelay(
      port,
      source({
        target: async (_platform, deviceId) => {
          if (deviceId === "gone") throw new DeviceTargetError("This emulator is not running.");
          if (deviceId === "leaky") throw new Error(`fetch failed: http://127.0.0.1:${hub.port}/?token=${hub.token}`);
          return deviceId;
        },
      }),
    );
    hub.replies.set("GET /vendor/serve-sim/helper/missing/stream.avcc", { status: 404, body: `no stream on 127.0.0.1:${hub.port}` });
    port.send({ type: "open", channel: 1, kind: "ios-video", deviceId: "UDID-1" });
    port.send({ type: "open", channel: 2, kind: "android", deviceId: "gone" });
    port.send({ type: "open", channel: 3, kind: "ios-control", deviceId: "leaky" });
    port.send({ type: "open", channel: 4, kind: "ios-video", deviceId: "missing" });
    await until(() => [1, 2, 3, 4].every((channel) => port.of(channel).some((event) => event.type === "closed")));

    expect(port.of(2)).toEqual([{ type: "closed", channel: 2, reason: "This emulator is not running." }]);
    expect(port.of(3)).toEqual([{ type: "closed", channel: 3, reason: "The device stream stopped." }]);
    expect(port.of(4)).toEqual([{ type: "closed", channel: 4, status: 404 }]);
    const seen = JSON.stringify(port.events.map((event) => (event.type === "data" && typeof event.data !== "string" ? { ...event, data: [...new Uint8Array(event.data)] } : event)));
    expect(seen).not.toContain(hub.token);
    expect(seen).not.toContain(String(hub.port));
  });

  it("carries WebSocket messages both ways", async () => {
    attachRelay(port, source());
    port.send({ type: "open", channel: 5, kind: "ios-control", deviceId: "UDID-1" });
    port.send({ type: "send", channel: 5, data: "sent before open" });
    await until(() => port.of(5).some((event) => event.type === "opened"));
    port.send({ type: "send", channel: 5, data: new Uint8Array([9, 8, 7]).buffer });
    const socket = hub.sockets[0]!;
    await until(() => socket.received.length === 2);
    expect(socket.received).toEqual(["sent before open", Buffer.from([9, 8, 7])]);

    socket.send(Buffer.from([1, 2]));
    socket.send('{"type":"config"}');
    await until(() => port.of(5).filter((event) => event.type === "data").length === 2);
    const data = port.of(5).filter((event) => event.type === "data");
    expect(bytes(data[0])).toEqual([1, 2]);
    expect(data[1]).toMatchObject({ type: "data", channel: 5, data: '{"type":"config"}', at: expect.any(Number) });
  });

  it("ends every channel of a window when its port closes", async () => {
    attachRelay(port, source());
    port.send({ type: "open", channel: 1, kind: "android", deviceId: "Pixel_9" });
    port.send({ type: "open", channel: 2, kind: "ios-control", deviceId: "UDID-1" });
    await until(() => hub.sockets.length === 2 && port.events.filter((event) => event.type === "opened").length === 2);
    port.close();
    await until(() => hub.sockets.every((socket) => socket.closed));
  });

  it("caps the channels one window can hold open", async () => {
    attachRelay(port, source({ target: () => new Promise(() => undefined) }));
    for (let channel = 0; channel < 17; channel++) port.send({ type: "open", channel, kind: "ios-control", deviceId: "UDID-1" });
    expect(port.events).toEqual([{ type: "closed", channel: 16, reason: "Too many device streams in this window." }]);
    port.send({ type: "close", channel: 0 });
    port.send({ type: "open", channel: 16, kind: "ios-control", deviceId: "UDID-1" });
    expect(port.events).toHaveLength(1);
  });
});
