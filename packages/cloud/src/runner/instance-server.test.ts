import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { InstancePort, type InstanceProcess } from "../instance-port.js";

let server: ChildProcess;
let port: number;
let instance: InstancePort;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "openorc-instance-server-"));
  server = spawn(process.execPath, [fileURLToPath(new URL("./instance-server.ts", import.meta.url)), "--port", "0"], { stdio: ["ignore", "pipe", "inherit"] });
  const line = await new Promise<string>((resolve) => server.stdout!.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8"))));
  port = (JSON.parse(line) as { port: number }).port;
  instance = new InstancePort({ url: `http://127.0.0.1:${port}`, headers: {} });
});

afterAll(async () => {
  server.kill();
  await rm(dir, { recursive: true, force: true });
});

async function finished(proc: InstanceProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const [stdout, stderr, code] = await Promise.all([proc.stdout.toArray(), proc.stderr.toArray(), proc.exited]);
  return { code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}

async function eventually(check: () => Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("It did not happen in time.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

it("answers its health check", async () => {
  expect(await instance.health()).toBe(true);
  expect(await new InstancePort({ url: "http://127.0.0.1:1", headers: {} }).health()).toBe(false);
});

it("writes a 3 MB binary file into folders it makes, reads it back byte for byte, and leaves nothing beside it", async () => {
  const content = randomBytes(3 * 1024 * 1024);
  const file = path.join(dir, "a", "b", "bundle.bin");
  await instance.putFile(file, content);
  expect((await readFile(file)).equals(content)).toBe(true);
  expect((await instance.getFile(file))?.equals(content)).toBe(true);
  await instance.putFile(file, Buffer.from("smaller"));
  expect((await instance.getFile(file))?.toString("utf8")).toBe("smaller");
  expect(await readdir(path.dirname(file))).toEqual(["bundle.bin"]);
});

it("answers null for a missing file or a folder, and refuses a relative path", async () => {
  expect(await instance.getFile(path.join(dir, "missing"))).toBeNull();
  expect(await instance.getFile(dir)).toBeNull();
  await expect(instance.putFile("relative.txt", Buffer.from("x"))).rejects.toThrow("(400)");
});

it("carries stdout and stderr apart, then the exit code", async () => {
  const proc = await instance.process({ cmd: process.execPath, args: ["-e", `process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3`] });
  expect(await finished(proc)).toEqual({ code: 3, stdout: "out", stderr: "err" });
});

it("feeds input in, ends it on request, and runs in the folder and environment asked for", async () => {
  const proc = await instance.process({
    cmd: process.execPath,
    args: ["-e", `let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => console.log(JSON.stringify([s, process.cwd(), process.env.PWD, process.env.WHO])))`],
    cwd: dir,
    env: { WHO: "agent" },
  });
  proc.stdin.write("one ");
  proc.stdin.end("two");
  const result = await finished(proc);
  const real = await import("node:fs/promises").then((fs) => fs.realpath(dir));
  expect(result.code).toBe(0);
  const [input, cwd, pwd, who] = JSON.parse(result.stdout) as string[];
  expect([input, cwd, pwd, who]).toEqual(["one two", real, dir, "agent"]);
});

it("moves large input and output whole, past the 16-bit frame length", async () => {
  const input = randomBytes(200_000).toString("hex");
  const proc = await instance.process({ cmd: "cat", args: [] });
  proc.stdin.end(input);
  const result = await finished(proc);
  expect(result.stdout.length).toBe(input.length);
  expect(result.stdout === input).toBe(true);
});

it("signals a command when asked: one killed by a signal has no exit code", async () => {
  const proc = await instance.process({ cmd: process.execPath, args: ["-e", `setInterval(() => {}, 1000); process.stdout.write("up")`] });
  proc.stdout.once("data", () => proc.kill("SIGTERM"));
  expect((await finished(proc)).code).toBeNull();
});

it("says a command that does not exist exited 127, with why on stderr", async () => {
  const result = await finished(await instance.process({ cmd: "openorc-no-such-command", args: [] }));
  expect(result.code).toBe(127);
  expect(result.stderr).toContain("ENOENT");
});

it("keeps a command running when its connection drops, and ends its input", async () => {
  const marker = path.join(dir, "survived.txt");
  const proc = await instance.process({
    cmd: process.execPath,
    args: ["-e", `process.stdin.resume(); process.stdin.on("end", () => setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "after the drop"), 300))`],
  });
  proc.close();
  expect(await proc.exited).toBeNull();
  await eventually(async () => (await readFile(marker, "utf8").catch(() => "")) === "after the drop");
});

/** A client frame, masked as the protocol requires of clients. */
function clientFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = randomBytes(4);
  const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i & 3]!));
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length]), mask, masked]);
}

/** Server frames from `buffer`, which are never masked and here always short. */
function serverFrames(buffer: Buffer): { opcode: number; payload: Buffer }[] {
  const frames: { opcode: number; payload: Buffer }[] = [];
  for (let at = 0; at + 2 <= buffer.length;) {
    const length = buffer[at + 1]! & 0x7f;
    frames.push({ opcode: buffer[at]! & 0x0f, payload: buffer.subarray(at + 2, at + 2 + length) });
    at += 2 + length;
  }
  return frames;
}

it("speaks WebSocket by hand: the accept key, a fragmented first message, and a pong for a ping between its fragments", async () => {
  const socket = net.connect(port, "127.0.0.1");
  const key = randomBytes(16).toString("base64");
  socket.write(`GET /process HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  const closed = new Promise((resolve) => socket.on("close", resolve));
  const spec = Buffer.from(JSON.stringify({ cmd: process.execPath, args: ["-e", `process.stdout.write("ok")`] }));
  socket.write(clientFrame(1, spec.subarray(0, 10), false));
  socket.write(clientFrame(9, Buffer.from("are you there")));
  socket.write(clientFrame(0, spec.subarray(10)));
  await closed;
  const all = Buffer.concat(chunks);
  const split = all.indexOf("\r\n\r\n") + 4;
  const head = all.subarray(0, split).toString("utf8");
  expect(head).toContain("HTTP/1.1 101");
  expect(head).toContain(`Sec-WebSocket-Accept: ${createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")}`);
  const frames = serverFrames(all.subarray(split));
  expect(frames.map((frame) => [frame.opcode, frame.payload.toString("latin1")])).toEqual([
    [10, "are you there"],
    [2, "\u0001ok"],
    [1, `{"exit":0}`],
    [8, "\u0003è"],
  ]);
});
