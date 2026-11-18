import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, FrameReader, type WslFrame } from "./wsl-frames";

function read(chunks: (Buffer | string)[]): { frames: WslFrame[]; noise: string[] } {
  const frames: WslFrame[] = [];
  const noise: string[] = [];
  const reader = new FrameReader(
    (frame) => frames.push(frame),
    (line) => noise.push(line),
  );
  for (const chunk of chunks) reader.push(chunk);
  reader.end();
  return { frames, noise };
}

describe("WSL frames", () => {
  it("carries every kind of frame across a line and back", () => {
    const sent: WslFrame[] = [
      { t: "start", dataDir: "/home/me/.openorc-wsl/data", fileKey: "abc" },
      { t: "host", data: { type: "presence", id: 1 } },
      { t: "open", window: 0 },
      { t: "rpc", window: 0, data: { type: "rpc", id: 7, method: "projects.list", params: {} } },
      { t: "close", window: 0 },
    ];
    expect(read(sent.map(encodeFrame)).frames).toEqual(sent);
  });

  it("keeps a message with line breaks and non-ASCII text on one line", () => {
    const frame: WslFrame = { t: "rpc", window: 2, data: { text: "first\nsecond\r\n“quoted” ✓" } };
    const line = encodeFrame(frame);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(read([line]).frames).toEqual([frame]);
  });

  it("carries bytes on the private channel, whether a typed array or a Buffer", () => {
    const jpeg = new Uint8Array([255, 216, 255, 0, 1, 2]);
    const { frames } = read([encodeFrame({ t: "host", data: { type: "preview.result", id: 1, result: { kind: "frame", jpeg, also: Buffer.from(jpeg) } } })]);
    const result = (frames[0] as { data: { result: { jpeg: Uint8Array; also: Uint8Array } } }).data.result;
    expect(result.jpeg).toBeInstanceOf(Uint8Array);
    expect([...result.jpeg]).toEqual([...jpeg]);
    expect([...result.also]).toEqual([...jpeg]);
  });

  it("joins a frame that arrives in pieces, even when a piece ends inside a character", () => {
    const line = Buffer.from(encodeFrame({ t: "rpc", window: 1, data: "héllo ✓" }));
    const cut = line.indexOf(0xc3) + 1;
    expect(read([line.subarray(0, cut), line.subarray(cut, cut + 3), line.subarray(cut + 3)]).frames).toEqual([{ t: "rpc", window: 1, data: "héllo ✓" }]);
  });

  it("reads two frames that arrive together, and a line that came back with a carriage return", () => {
    const first = encodeFrame({ t: "open", window: 1 });
    const second = encodeFrame({ t: "close", window: 1 }).replace("\n", "\r\n");
    expect(read([first + second]).frames).toEqual([
      { t: "open", window: 1 },
      { t: "close", window: 1 },
    ]);
  });

  it("reports what is no frame as noise, and goes on reading", () => {
    const { frames, noise } = read(["The distribution is not running.\n", encodeFrame({ t: "open", window: 3 }), '{"t":"rpc","window":-1,"data":1}\n', '{"t":"open"', "\n", "cut short"]);
    expect(frames).toEqual([{ t: "open", window: 3 }]);
    expect(noise).toEqual(["The distribution is not running.", '{"t":"rpc","window":-1,"data":1}', '{"t":"open"', "cut short"]);
  });

  it("refuses frames that lack what their kind needs", () => {
    expect(decodeFrame('{"t":"start","dataDir":"/x"}')).toBeNull();
    expect(decodeFrame('{"t":"open","window":"1"}')).toBeNull();
    expect(decodeFrame('{"t":"rpc","window":1}')).toBeNull();
    expect(decodeFrame('{"t":"unknown"}')).toBeNull();
    expect(decodeFrame('{"t":"host","data":null}')).toEqual({ t: "host", data: null });
  });
});
