import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StdioJsonRpc } from "./jsonrpc.js";

describe("JSON-RPC process lifetime", () => {
  it("reports malformed lines once and still delivers the next notification", async () => {
    const lines =
      ["null", "1", "[]", JSON.stringify({ id: null, error: { code: -32700, message: "invalid request" } }), JSON.stringify({ id: null, method: "ready", params: { ok: true } })].join("\n") + "\n";
    const proc = spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(lines)})`], { stdio: ["pipe", "pipe", "pipe"] });
    const rpc = new StdioJsonRpc(proc);
    const parseErrors: string[] = [];
    const notifications: string[] = [];
    rpc.on("parseError", (line) => parseErrors.push(line));
    rpc.on("notification", ({ method }) => notifications.push(method));

    await once(proc, "close");
    expect(parseErrors).toEqual(["null", "1", "[]"]);
    expect(notifications).toEqual(["ready"]);
  });

  it("rejects only the request with a malformed response and keeps the transport usable", async () => {
    const script = `
      let count = 0;
      require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
        const { id } = JSON.parse(line);
        count += 1;
        const response = count === 1 ? { id, error: null } : { id, result: { ok: true } };
        process.stdout.write(JSON.stringify(response) + '\\n');
      });
    `;
    const proc = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
    const rpc = new StdioJsonRpc(proc);
    try {
      await expect(rpc.request("first", {}, 3000)).rejects.toThrow("invalid rpc error response");
      await expect(rpc.request("second", {}, 3000)).resolves.toEqual({ ok: true });
    } finally {
      proc.kill();
      await once(proc, "close");
    }
  });

  it("rejects pending and subsequent requests with the provider startup error", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-rpc-missing-"));
    const proc = spawn(path.join(dir, "missing-provider"), [], { stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()));
    const failed = once(proc, "error");
    const rpc = new StdioJsonRpc(proc);
    try {
      const pending = Promise.allSettled([rpc.request("initialize", {}, 1000), rpc.request("model/list", {}, 1000)]);
      const [error] = await failed;
      expect(error).toMatchObject({ code: "ENOENT" });
      expect(await pending).toEqual([
        { status: "rejected", reason: error },
        { status: "rejected", reason: error },
      ]);
      await expect(rpc.request("account/read", {}, 1000)).rejects.toBe(error);
    } finally {
      await closed;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects requests after a normally exited process without waiting for a response", async () => {
    const proc = spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: ["pipe", "pipe", "pipe"] });
    const rpc = new StdioJsonRpc(proc);
    await once(proc, "close");
    await expect(rpc.request("initialize", {}, 1000)).rejects.toThrow("process exited with code 7 before responding");
  });
});
