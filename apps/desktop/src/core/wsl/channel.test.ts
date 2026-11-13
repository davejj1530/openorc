import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { encodeFrame, FrameReader, type WslFrame } from "../../shared/wsl-frames";
import type { WindowPort } from "../reply";
import { FrameChannel } from "./channel";

const settled = () => new Promise((resolve) => setImmediate(resolve));
const START: Extract<WslFrame, { t: "start" }> = { t: "start", dataDir: "/home/me/.openorc-wsl/data", fileKey: "key" };

/** The core's end of the pipes, with what main would write and read. */
function fixture() {
  const input = new PassThrough();
  const output = new PassThrough();
  const sent: WslFrame[] = [];
  const reader = new FrameReader((frame) => sent.push(frame));
  output.on("data", (chunk: Buffer) => reader.push(chunk));
  const heard = { started: [] as WslFrame[], host: [] as unknown[], windows: [] as WindowPort[], ended: 0, noise: [] as string[] };
  const channel = new FrameChannel(input, output, {
    start: (frame) => heard.started.push(frame),
    host: (message) => heard.host.push(message),
    window: (port) => heard.windows.push(port),
    ended: () => heard.ended++,
    noise: (line) => heard.noise.push(line),
  });
  const write = (...frames: WslFrame[]) => input.write(frames.map(encodeFrame).join(""));
  return { channel, input, output, sent, heard, write };
}

describe("the core's end of the pipes", () => {
  it("reads nothing as anything before the start line, and the start line once", async () => {
    const { heard, write } = fixture();
    write({ t: "host", data: { type: "shutdown" } }, { t: "open", window: 1 }, START, { ...START, dataDir: "/elsewhere" }, { t: "host", data: { type: "presence.result", id: 1 } });
    await settled();
    expect(heard.started).toEqual([START]);
    expect(heard.host).toEqual([{ type: "presence.result", id: 1 }]);
    expect(heard.windows).toHaveLength(0);
  });

  it("gives each window main opens the shape of a port, and its messages under its number", async () => {
    const { heard, sent, write } = fixture();
    write(START, { t: "open", window: 1 }, { t: "open", window: 2 }, { t: "open", window: 2 });
    await settled();
    expect(heard.windows).toHaveLength(2);
    const [first, second] = heard.windows as [WindowPort, WindowPort];
    const asked: unknown[] = [];
    first.on("message", (event) => asked.push(event.data));
    second.on("message", () => asked.push("the wrong window"));
    write({ t: "rpc", window: 1, data: { type: "rpc", id: 4, method: "projects.list" } }, { t: "rpc", window: 9, data: "nobody" });
    await settled();
    expect(asked).toEqual([{ type: "rpc", id: 4, method: "projects.list" }]);
    second.postMessage({ type: "rpc.result", id: 4, result: [] });
    await settled();
    expect(sent).toEqual([{ t: "rpc", window: 2, data: { type: "rpc.result", id: 4, result: [] } }]);
  });

  it("tells a window's port it closed, and stops delivering to it", async () => {
    const { heard, write } = fixture();
    write(START, { t: "open", window: 1 });
    await settled();
    let closed = 0;
    const asked: unknown[] = [];
    heard.windows[0]!.on("close", () => closed++);
    heard.windows[0]!.on("message", (event) => asked.push(event.data));
    write({ t: "close", window: 1 }, { t: "rpc", window: 1, data: "late" });
    await settled();
    expect(closed).toBe(1);
    expect(asked).toEqual([]);
  });

  it("posts to main on the private channel", async () => {
    const { channel, sent, write } = fixture();
    write(START);
    channel.post({ type: "shell-env", snapshot: { revision: 1 } });
    await settled();
    expect(sent).toEqual([{ t: "host", data: { type: "shell-env", snapshot: { revision: 1 } } }]);
  });

  it("says the app left when its input ends, once, and closes every window", async () => {
    const { heard, input, write } = fixture();
    write(START, { t: "open", window: 1 });
    await settled();
    let closed = 0;
    heard.windows[0]!.on("close", () => closed++);
    input.end();
    await settled();
    expect(heard.ended).toBe(1);
    expect(closed).toBe(1);
  });

  it("writes everything it owes main before it lets the process end", async () => {
    const { channel, sent, write, output } = fixture();
    write(START);
    await settled();
    channel.post({ type: "update:prepared", id: "a" });
    await new Promise<void>((resolve) => channel.close(resolve));
    await settled();
    expect(sent).toEqual([{ t: "host", data: { type: "update:prepared", id: "a" } }]);
    expect(output.writableEnded).toBe(true);
    // Nothing more is written, and closing again is harmless.
    channel.post({ type: "late" });
    await new Promise<void>((resolve) => channel.close(resolve));
  });

  it("reports a line that is no frame, and reads on", async () => {
    const { heard, input, write } = fixture();
    input.write("not a frame\n");
    write(START);
    await settled();
    expect(heard.noise).toEqual(["not a frame"]);
    expect(heard.started).toEqual([START]);
  });
});
