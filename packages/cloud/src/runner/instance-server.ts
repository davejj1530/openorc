/**
 * OpenOrc's server in a cloud instance whose service runs a command only to completion, with no input and no way to
 * move files (Agent37's base template). The instance's own Node runs it:
 *
 *   node instance-server.ts --port 47821
 *
 *   GET  /health            "ok"
 *   PUT  /file?path=/abs    writes the body, whole or not at all
 *   GET  /file?path=/abs    the file, or 404
 *   WebSocket /process      one command: its input in, its output out by channel, its exit code last
 *
 * Node builtins only, since it runs from its own folder before anything else is there.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const;
/** Agent37 closes a connection that carries no bytes for 15 minutes, so a quiet process still pings well inside that. */
const PING_MS = 60_000;
/** A message larger than this closes the connection rather than filling memory. */
const MAX_MESSAGE = 64 * 1024 * 1024;
/** After the closing frame, how long the other side gets to close its end. */
const CLOSE_GRACE_MS = 5000;
/** The first byte of each output frame says which stream it carries. */
const CHANNEL = { stdout: 1, stderr: 2 } as const;

interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

class ProtocolError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function frameHead(opcode: number, length: number): Buffer {
  if (length < 126) return Buffer.from([0x80 | opcode, length]);
  if (length < 0x10000) {
    const head = Buffer.from([0x80 | opcode, 126, 0, 0]);
    head.writeUInt16BE(length, 2);
    return head;
  }
  const head = Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  head[1] = 127;
  head.writeBigUInt64BE(BigInt(length), 2);
  return head;
}

/** The frame at the front of `buffer` and its size, or null until all of it has arrived. Client frames are masked. */
function readFrame(buffer: Buffer): { frame: Frame; size: number } | null {
  if (buffer.length < 2) return null;
  const first = buffer[0]!;
  const second = buffer[1]!;
  if (first & 0x70) throw new ProtocolError(1002, "No extension was agreed.");
  if (!(second & 0x80)) throw new ProtocolError(1002, "A client's frames must be masked.");
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (length > MAX_MESSAGE) throw new ProtocolError(1009, "The message is too large.");
  const size = offset + 4 + length;
  if (buffer.length < size) return null;
  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.from(buffer.subarray(offset + 4, size));
  for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i & 3]!;
  return { frame: { fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload }, size };
}

/** One WebSocket connection, server side: whole messages in, frames out. */
class Connection {
  onMessage: (opcode: number, data: Buffer) => void = () => undefined;
  onClose: () => void = () => undefined;
  open = true;
  readonly socket: Duplex;
  private buffer: Buffer = Buffer.alloc(0);
  private message: { opcode: number; parts: Buffer[]; size: number } | null = null;
  private readonly pinger: ReturnType<typeof setInterval>;

  constructor(socket: Duplex) {
    this.socket = socket;
    this.pinger = setInterval(() => this.send(OP.ping, Buffer.alloc(0)), PING_MS);
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", () => socket.destroy());
    socket.on("close", () => this.closed());
  }

  /** False once the socket's buffer is full: wait for its "drain". */
  send(opcode: number, payload: Buffer): boolean {
    if (!this.open) return true;
    this.socket.write(frameHead(opcode, payload.length));
    return this.socket.write(payload);
  }

  sendText(value: unknown): void {
    this.send(OP.text, Buffer.from(JSON.stringify(value)));
  }

  close(code?: number): void {
    if (!this.open) return;
    const payload = Buffer.alloc(code === undefined ? 0 : 2);
    if (code !== undefined) payload.writeUInt16BE(code);
    this.send(OP.close, payload);
    this.open = false;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), CLOSE_GRACE_MS).unref();
  }

  private closed(): void {
    clearInterval(this.pinger);
    this.open = false;
    this.onClose();
  }

  private receive(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    try {
      for (let read = readFrame(this.buffer); read && this.open; read = readFrame(this.buffer)) {
        this.buffer = this.buffer.subarray(read.size);
        this.frame(read.frame);
      }
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      this.close(error.code);
    }
  }

  private frame({ fin, opcode, payload }: Frame): void {
    if (opcode === OP.ping) return void this.send(OP.pong, payload);
    if (opcode === OP.pong) return;
    if (opcode === OP.close) return this.close(payload.length >= 2 ? payload.readUInt16BE(0) : undefined);
    if (opcode === OP.continuation) {
      if (!this.message) throw new ProtocolError(1002, "A continuation began no message.");
      this.message.parts.push(payload);
      this.message.size += payload.length;
    } else if (opcode === OP.text || opcode === OP.binary) {
      if (this.message) throw new ProtocolError(1002, "A message began inside another.");
      this.message = { opcode, parts: [payload], size: payload.length };
    } else throw new ProtocolError(1002, `Unknown opcode ${opcode}.`);
    if (this.message.size > MAX_MESSAGE) throw new ProtocolError(1009, "The message is too large.");
    if (!fin) return;
    const { opcode: kind, parts } = this.message;
    this.message = null;
    this.onMessage(kind, Buffer.concat(parts));
  }
}

interface ProcessSpec {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

type Control = { stdin: "end" } | { kill: NodeJS.Signals };

function signal(child: ChildProcess, name: NodeJS.Signals): void {
  try {
    // Its own process group, so the signal reaches whatever the command started too.
    process.kill(-child.pid!, name);
  } catch {
    child.kill(name);
  }
}

/** Runs the command the connection's first message names, until it exits. A dropped connection only ends its input. */
function serveProcess(connection: Connection): void {
  let child: ChildProcess | null = null;
  connection.onMessage = (opcode, data) => {
    try {
      if (!child) child = start(connection, JSON.parse(data.toString("utf8")) as ProcessSpec);
      else if (opcode === OP.binary) child.stdin?.write(data);
      else control(child, JSON.parse(data.toString("utf8")) as Control);
    } catch {
      connection.close(1008);
    }
  };
  connection.onClose = () => {
    child?.stdin?.end();
    // Nobody reads its output anymore; reading on keeps it from blocking on a full pipe.
    child?.stdout?.resume();
    child?.stderr?.resume();
  };
}

function control(child: ChildProcess, message: Control): void {
  if ("stdin" in message) child.stdin?.end();
  else if ("kill" in message && /^SIG[A-Z0-9]+$/.test(message.kill)) signal(child, message.kill);
}

function start(connection: Connection, spec: ProcessSpec): ChildProcess {
  const cwd = spec.cwd ?? process.cwd();
  // PWD follows cwd: some CLIs (OpenCode) read their folder from it.
  const child = spawn(spec.cmd, spec.args, { cwd, env: { ...process.env, ...spec.env, PWD: cwd }, stdio: "pipe", detached: true });
  let done = false;
  const finish = (code: number | null) => {
    if (done) return;
    done = true;
    connection.sendText({ exit: code });
    connection.close(1000);
  };
  child.stdin.on("error", () => undefined);
  for (const [name, channel] of [
    ["stdout", CHANNEL.stdout],
    ["stderr", CHANNEL.stderr],
  ] as const) {
    child[name].on("data", (chunk: Buffer) => {
      if (connection.open && !connection.send(OP.binary, Buffer.concat([Buffer.from([channel]), chunk]))) {
        child.stdout.pause();
        child.stderr.pause();
        connection.socket.once("drain", () => {
          child.stdout.resume();
          child.stderr.resume();
        });
      }
    });
  }
  child.on("error", (error) => {
    if (child.pid) return;
    // A shell reports 127 for a command it cannot find.
    connection.send(OP.binary, Buffer.concat([Buffer.from([CHANNEL.stderr]), Buffer.from(`${error.message}\n`)]));
    finish(127);
  });
  child.on("close", (code) => finish(code));
  return child;
}

/** Written beside the file and moved over it, so a reader never sees half of it. */
async function putFile(file: string, request: http.IncomingMessage): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString("hex")}.part`);
  try {
    await pipeline(request, createWriteStream(temp));
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function getFile(file: string, response: http.ServerResponse): Promise<void> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return void response.writeHead(404).end();
  response.writeHead(200, { "content-type": "application/octet-stream", "content-length": info.size });
  await pipeline(createReadStream(file), response);
}

async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://instance");
  if (url.pathname === "/health" && request.method === "GET") return void response.end("ok");
  if (url.pathname !== "/file") return void response.writeHead(404).end();
  const file = url.searchParams.get("path");
  if (!file || !path.isAbsolute(file)) return void response.writeHead(400).end("The path must be absolute.");
  if (request.method === "PUT") {
    await putFile(file, request);
    return void response.writeHead(204).end();
  }
  if (request.method === "GET") return getFile(file, response);
  response.writeHead(405).end();
}

function upgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
  const key = request.headers["sec-websocket-key"];
  if (new URL(request.url ?? "/", "http://instance").pathname !== "/process" || typeof key !== "string" || request.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  const accept = createHash("sha1")
    .update(key + WEBSOCKET_GUID)
    .digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  (socket as Duplex & { setNoDelay?: (on: boolean) => void }).setNoDelay?.(true);
  // Frames that came with the upgrade request go back on the socket, to arrive once the process handlers are set.
  if (head.length) socket.unshift(head);
  serveProcess(new Connection(socket));
}

const portAt = process.argv.indexOf("--port");
const port = Number(process.argv[portAt + 1]);
if (portAt < 0 || !Number.isInteger(port)) {
  process.stderr.write("Usage: node instance-server.ts --port <port>\n");
  process.exit(2);
}
const server = http.createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    if (response.headersSent) response.destroy();
    else response.writeHead(500).end(error instanceof Error ? error.message : String(error));
  });
});
server.on("upgrade", upgrade);
server.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
server.listen(port, "0.0.0.0", () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ port: typeof address === "object" && address ? address.port : port })}\n`);
});
