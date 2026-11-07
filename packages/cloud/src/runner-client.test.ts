import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandboxProvider, type LocalSandbox } from "./local-sandbox.js";
import { RemoteProcess } from "./remote-process.js";
import { installRunner, RunnerClient, runnerFiles, type RunnerConnectionState } from "./runner-client.js";

let base: string;
let sandbox: LocalSandbox;
let client: RunnerClient | null;
const states: RunnerConnectionState[] = [];

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "openorc-cloud-"));
  sandbox = await new LocalSandboxProvider(base).open("workspace");
  states.length = 0;
  client = await RunnerClient.open(await installRunner(sandbox, runnerFiles()), (state) => states.push(state));
});

afterEach(async () => {
  client?.close();
  await sandbox.stop();
  await rm(base, { recursive: true, force: true });
});

function node(source: string): { cmd: string; args: string[]; cwd: string; env: Record<string, string> } {
  return { cmd: "node", args: ["-e", source], cwd: sandbox.root, env: {} };
}

function collect(proc: RemoteProcess): { text: () => string; closed: Promise<[number | null, string | null]> } {
  let text = "";
  proc.stdout.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
  const closed = new Promise<[number | null, string | null]>((resolve) => proc.once("close", (code, signal) => resolve([code, signal])));
  return { text: () => text, closed };
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function write(proc: RemoteProcess, text: string): Promise<void> {
  return new Promise((resolve, reject) => proc.stdin.write(text, (error) => (error ? reject(error) : resolve())));
}

describe("RunnerClient", () => {
  it("runs a process in the sandbox with its input, output and exit code", async () => {
    const proc = client!.spawn("echo", node(`process.stdin.on("data", (d) => process.stdout.write("echo:" + d)); process.stdin.on("end", () => process.exit(7));`));
    const out = collect(proc);
    await write(proc, "hello\n");
    proc.stdin.end();
    expect(await out.closed).toEqual([7, null]);
    expect(out.text()).toBe("echo:hello\n");
  });

  it("puts the runner's own commands first on a process's PATH, before the sandbox's and the caller's", async () => {
    const install = await installRunner(sandbox, runnerFiles());
    const proc = client!.spawn("path", { ...node(`process.stdout.write(process.env.PATH)`), cmd: process.execPath, env: { PATH: "/caller/bin" } });
    const out = collect(proc);
    expect(await out.closed).toEqual([0, null]);
    expect(out.text()).toBe(`${path.join(install.state, "bin")}:/caller/bin`);
  });

  it("starts a process in its folder with PWD naming that folder, whatever PWD the runner or the caller had", async () => {
    const folder = path.join(sandbox.root, "checkout");
    await mkdir(folder, { recursive: true });
    const proc = client!.spawn("pwd", { ...node(`process.stdout.write(process.env.PWD + "|" + process.cwd())`), cwd: folder, env: { PWD: "/elsewhere" } });
    const out = collect(proc);
    expect(await out.closed).toEqual([0, null]);
    expect(out.text()).toBe(`${folder}|${await realpath(folder)}`);
  });

  it("keeps a process running through a dropped connection and delivers every byte once", async () => {
    const proc = client!.spawn(
      "ticks",
      node(`let n = 0; const t = setInterval(() => { process.stdout.write("tick " + n++ + "\\n"); if (n === 40) { clearInterval(t); } }, 15);
        process.stdin.on("data", (d) => process.stdout.write("got " + d)); process.stdin.on("end", () => setTimeout(() => process.exit(0), 700));`),
    );
    const out = collect(proc);
    await until(() => out.text().includes("tick 5\n"));
    sandbox.dropConnections();
    await until(() => states.filter((state) => state === "connected").length >= 2);
    await write(proc, "after-reconnect\n");
    proc.stdin.end();
    expect(await out.closed).toEqual([0, null]);
    const lines = out.text().trim().split("\n");
    expect(lines.filter((line) => line.startsWith("tick"))).toEqual(Array.from({ length: 40 }, (_, n) => `tick ${n}`));
    expect(lines.filter((line) => line.startsWith("got"))).toEqual(["got after-reconnect"]);
  });

  it("writes input sent while disconnected exactly once after reconnecting", async () => {
    const proc = client!.spawn("cat", node(`process.stdin.pipe(process.stdout);`));
    const out = collect(proc);
    await write(proc, "one\n");
    sandbox.dropConnections();
    const pending = write(proc, "two\n");
    await until(() => states.includes("disconnected"));
    await pending;
    proc.stdin.end();
    await out.closed;
    expect(out.text()).toBe("one\ntwo\n");
  });

  it("starts the armed takeover when the Mac says it is going away, and the next connection reads it from the start", async () => {
    const install = client!.install;
    client!.standby({ id: "takeover", cmd: "node", args: ["-e", `console.log("carried on")`], cwd: sandbox.root, env: {}, afterMs: 60_000 });
    expect((await client!.away())?.id).toBe("takeover");
    expect((await client!.away())?.id).toBe("takeover");
    client!.close();
    client = await RunnerClient.open(install);
    expect(client!.takeover?.id).toBe("takeover");
    const out = collect(client!.adopt("takeover"));
    expect(await out.closed).toEqual([0, null]);
    expect(out.text()).toBe("carried on\n");
    client!.takeoverSeen();
    expect(await client!.away()).toBeNull();
    client!.close();
    client = await RunnerClient.open(install);
    expect(client!.takeover).toBeNull();
  });

  it("starts the takeover on its own once the Mac has been gone for its wait, and never while the Mac is connected", async () => {
    const install = client!.install;
    // Its wait is longer than reconnecting takes on a busy CI runner, so the reconnect below is never late enough to start it.
    const takeover = { id: "late", cmd: "node", args: ["-e", `console.log("on my own")`], cwd: sandbox.root, env: {}, afterMs: 1500 };
    client!.standby(takeover);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    client!.close();
    client = await RunnerClient.open(install);
    expect(client!.takeover).toBeNull();

    client!.standby(takeover);
    client!.close();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    client = await RunnerClient.open(install);
    expect(client!.takeover?.id).toBe("late");
    const out = collect(client!.adopt("late"));
    await out.closed;
    expect(out.text()).toBe("on my own\n");
  });

  it("reports a process the sandbox stopped as ended by the stop", async () => {
    const proc = client!.spawn("forever", node(`setInterval(() => {}, 1000); process.stdout.write("up\\n");`));
    const out = collect(proc);
    await until(() => out.text() === "up\n");
    await sandbox.stop();
    expect(await out.closed).toEqual([null, "SIGKILL"]);
  });

  it("reports a command the sandbox cannot start", async () => {
    const proc = client!.spawn("missing", { cmd: "openorc-no-such-binary", args: [], cwd: sandbox.root, env: {} });
    const errors: Error[] = [];
    proc.on("error", (error: Error) => errors.push(error));
    const out = collect(proc);
    expect((await out.closed)[0]).toBe(127);
    expect(errors[0]?.message).toMatch(/ENOENT/);
  });

  it("relays requests from the sandbox's loopback to the Mac, and refuses them while the Mac is away", async () => {
    const mac = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      request.on("end", () => {
        response.writeHead(201, { "content-type": "text/plain", "x-seen-host": request.headers.host ?? "" });
        response.end(`${request.method} ${request.url} ${body}`);
      });
    });
    await new Promise<void>((resolve) => mac.listen(0, "127.0.0.1", resolve));
    const target = `http://127.0.0.1:${(mac.address() as AddressInfo).port}`;
    try {
      const port = await client!.relay("mcp", target);
      expect(await client!.relay("mcp", target)).toBe(port);
      const fetchFromVm = `fetch("http://127.0.0.1:${port}/mcp/token?x=1", { method: "POST", body: "hi" }).then(async (r) => console.log(r.status, r.headers.get("x-seen-host"), await r.text()))`;
      const proc = client!.spawn("fetch", node(fetchFromVm));
      const out = collect(proc);
      await out.closed;
      expect(out.text().trim()).toBe(`201 ${target.replace("http://", "")} POST /mcp/token?x=1 hi`);

      client!.close();
      client = null;
      const offline = await sandbox.exec("node", ["-e", `fetch("http://127.0.0.1:${port}/mcp/token").then((r) => console.log(r.status))`]);
      expect(offline.stdout.toString().trim()).toBe("503");
    } finally {
      mac.close();
    }
  });
});

describe("installing the runner", () => {
  it("writes its files only when the sandbox does not hold this runner already, as one made from a base does", async () => {
    const writes: string[] = [];
    const counted = new Proxy(sandbox, {
      get: (target, key) => (key === "writeFile" ? (file: string, bytes: Buffer) => (writes.push(file), target.writeFile(file, bytes)) : Reflect.get(target, key, target)),
    });
    await installRunner(counted, runnerFiles());
    expect(writes).toEqual([]);
    const changed = runnerFiles().map((file, index) => (index === 0 ? { ...file, content: Buffer.concat([file.content, Buffer.from("\n")]) } : file));
    await installRunner(counted, changed);
    expect(writes).toHaveLength(changed.length + 2);
    expect(writes.at(-1)).toMatch(/\.installed$/);
  });
});
