/**
 * What the Windows app and its core inside a WSL distribution say to each other, over the pipes wsl.exe gives the
 * core: one JSON document per line, each way. The core has no MessagePort to a window there, so main relays every
 * window's port through these, and the private channel a utility process has with main rides beside them.
 */
export type WslFrame =
  /** The first line main writes: what a utility process is given in its environment. The key never reaches a command line. */
  | { t: "start"; dataDir: string; fileKey: string; qa?: boolean }
  /** The private channel between main and the core, either way: secrets, the browser, presence, updates and shutdown. */
  | { t: "host"; data: unknown }
  /** A window connected, under a number main chose; and went away. */
  | { t: "open"; window: number }
  | { t: "close"; window: number }
  /** One message on a window's channel, either way: a request from it, or a reply or broadcast to it. */
  | { t: "rpc"; window: number; data: unknown };

/** The descriptor the core writes its frames to. Its stdout is pointed at stderr, so nothing a program prints there lands between two frames. */
export const FRAMES_FD = 3;

const BYTES = "$openorc.bytes";

/** Bytes cross as base64 under a key no message uses. Only the private channel carries any: a capture of the Preview. */
function packBytes(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return { [BYTES]: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") };
  // JSON.stringify asks a Buffer for its own JSON first, which is this.
  if (isBufferJson(value)) return { [BYTES]: Buffer.from(value.data).toString("base64") };
  return value;
}

function isBufferJson(value: unknown): value is { type: "Buffer"; data: number[] } {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "Buffer" && Array.isArray((value as { data?: unknown }).data);
}

function unpackBytes(_key: string, value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const packed = (value as Record<string, unknown>)[BYTES];
  return typeof packed === "string" && Object.keys(value).length === 1 ? new Uint8Array(Buffer.from(packed, "base64")) : value;
}

/** One frame as its line, newline included. A window's messages are plain JSON already and cross untouched. */
export function encodeFrame(frame: WslFrame): string {
  return `${frame.t === "host" ? JSON.stringify(frame, packBytes) : JSON.stringify(frame)}\n`;
}

const isWindow = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** The frame a line holds, or null for anything else: a line a program printed, or one cut short. */
export function decodeFrame(line: string): WslFrame | null {
  if (!line.startsWith('{"t":"')) return null;
  let parsed: unknown;
  try {
    parsed = line.startsWith('{"t":"host"') ? JSON.parse(line, unpackBytes) : JSON.parse(line);
  } catch {
    return null;
  }
  const frame = parsed as { t?: unknown; window?: unknown; dataDir?: unknown; fileKey?: unknown };
  switch (frame.t) {
    case "start":
      return typeof frame.dataDir === "string" && typeof frame.fileKey === "string" ? (parsed as WslFrame) : null;
    case "host":
      return "data" in frame ? (parsed as WslFrame) : null;
    case "open":
    case "close":
      return isWindow(frame.window) ? (parsed as WslFrame) : null;
    case "rpc":
      return isWindow(frame.window) && "data" in frame ? (parsed as WslFrame) : null;
    default:
      return null;
  }
}

/**
 * Splits a byte stream into frames as it arrives. A line that is no frame goes to `noise` whole, so a banner or an
 * error wsl.exe printed is reported in its own words instead of being dropped.
 */
export class FrameReader {
  private readonly decoder = new TextDecoder("utf-8");
  /** The pieces of the line still arriving. Kept apart until its newline comes, so a long frame is joined once, not at every piece. */
  private pieces: string[] = [];

  constructor(
    private readonly frame: (frame: WslFrame) => void,
    private readonly noise: (line: string) => void = () => undefined,
  ) {}

  push(chunk: Uint8Array | string): void {
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    let from = 0;
    for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", from)) {
      this.pieces.push(text.slice(from, at));
      this.line(this.pieces.join(""));
      this.pieces = [];
      from = at + 1;
    }
    if (from < text.length) this.pieces.push(text.slice(from));
  }

  /** The stream ended: whatever stood after the last newline was never a whole frame. */
  end(): void {
    const rest = this.pieces.join("") + this.decoder.decode();
    this.pieces = [];
    if (rest.trim()) this.noise(rest);
  }

  private line(raw: string): void {
    // A pipe through Windows may hand a line its carriage return back.
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const frame = decodeFrame(line);
    if (frame) this.frame(frame);
    else if (line.trim()) this.noise(line);
  }
}
