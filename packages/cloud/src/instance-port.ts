import { PassThrough, Writable, type Readable } from "node:stream";
import type { PortAddress } from "./agent37.js";

/** The port OpenOrc's server listens on in each instance. */
export const INSTANCE_SERVER_PORT = 47_821;

const HEALTH_TIMEOUT_MS = 5000;

/** Node's WebSocket takes headers beside the protocols that the DOM's typing alone allows. */
type HeaderedWebSocket = new (url: string, init: { headers: Record<string, string> }) => WebSocket;
const STDERR_CHANNEL = 2;

export interface ProcessSpec {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/** One command running in the instance, joined to this Mac by a WebSocket. */
export interface InstanceProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Settles once the connection closes: the exit code, or null when a signal ended it or the connection dropped first. */
  readonly exited: Promise<number | null>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  /** Drops the connection. The command keeps running with its input ended. */
  close(): void;
}

/** What OpenOrc's server of `build` answers at /openorc/health. */
export const instanceServerAnswer = (build: string) => `openorc-instance-server ${build}`;

/** The code in a service's error body, `{"error": "<code>"}` or `{"error": {"code"}}`, else its first words. */
function answerCode(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
    if (typeof body.error === "object" && body.error !== null && "code" in body.error) return String(body.error.code);
  } catch {
    // Not JSON: its words, briefly.
  }
  return text.trim().slice(0, 80);
}

/** The Mac's client for OpenOrc's server in an instance (runner/instance-server.ts), through the service's port address. */
export class InstancePort {
  /** `build` names the server this client speaks to; another answering at the address reads as not there. */
  constructor(
    private readonly address: PortAddress,
    private readonly build = "dev",
  ) {}

  private url(pathname: string, file?: string): string {
    const url = new URL(this.address.url);
    url.pathname = `${url.pathname.replace(/\/$/, "")}${pathname}`;
    if (file !== undefined) url.searchParams.set("path", file);
    return url.toString();
  }

  /** True when the server answers. */
  async health(): Promise<boolean> {
    return (await this.probe()) === null;
  }

  /** Null when the server answers; otherwise what its address answered instead, as "502 container_unreachable". */
  async probe(): Promise<string | null> {
    try {
      const response = await fetch(this.url("/openorc/health"), { headers: this.address.headers, signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      const text = await response.text();
      if (response.ok && text === instanceServerAnswer(this.build)) return null;
      return `${response.status} ${answerCode(text)}`.trim();
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") return `no answer in ${HEALTH_TIMEOUT_MS / 1000} s`;
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null;
      return (cause && "code" in cause ? String(cause.code) : null) ?? (error instanceof Error ? error.message : String(error));
    }
  }

  async putFile(file: string, content: Buffer): Promise<void> {
    const response = await fetch(this.url("/openorc/file", file), { method: "PUT", headers: this.address.headers, body: new Uint8Array(content) });
    if (!response.ok) throw new Error(`Could not write ${file} in the cloud instance (${response.status}). ${await response.text()}`.trim());
  }

  /** Null when the file does not exist. */
  async getFile(file: string): Promise<Buffer | null> {
    const response = await fetch(this.url("/openorc/file", file), { headers: this.address.headers });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Could not read ${file} in the cloud instance (${response.status}). ${await response.text()}`.trim());
    return Buffer.from(await response.arrayBuffer());
  }

  /** Starts `spec` and answers once the server has it. */
  process(spec: ProcessSpec): Promise<InstanceProcess> {
    const socket = new (WebSocket as unknown as HeaderedWebSocket)(this.url("/openorc/process").replace(/^http/, "ws"), { headers: this.address.headers });
    socket.binaryType = "arraybuffer";
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let code: number | null = null;
    const exited = new Promise<number | null>((resolve) =>
      socket.addEventListener("close", () => {
        stdout.end();
        stderr.end();
        resolve(code);
      }),
    );
    socket.addEventListener("message", (event) => {
      const data = event.data as string | ArrayBuffer;
      if (typeof data === "string") {
        try {
          const message = JSON.parse(data) as { exit?: number | null };
          if ("exit" in message) code = message.exit ?? null;
        } catch {
          // A message this client does not know is no reason to drop the command's output.
        }
        return;
      }
      const bytes = Buffer.from(data);
      (bytes[0] === STDERR_CHANNEL ? stderr : stdout).write(bytes.subarray(1));
    });
    // Input for a command whose connection is gone has nowhere to go, as with a process that has exited.
    const send = (data: string | Buffer) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    };
    const stdin = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        send(chunk);
        done();
      },
      final: (done) => {
        send(JSON.stringify({ stdin: "end" }));
        done();
      },
    });
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify(spec));
        resolve({ stdin, stdout, stderr, exited, kill: (signal) => send(JSON.stringify({ kill: signal })), close: () => socket.close() });
      });
      socket.addEventListener("error", () => reject(new Error("Could not reach OpenOrc's server in the cloud instance.")));
    });
  }
}
