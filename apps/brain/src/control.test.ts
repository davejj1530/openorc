import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BRAIN_EXIT, parseControlReply, type BrainControlOp, type BrainControlRequest } from "@openorc/cloud";
import { askControl, serveControl, type ControlServer } from "./control.js";

let dir: string;
let socket: string;
let server: ControlServer | null = null;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "brain-ctl-"));
  socket = path.join(dir, "brain.sock");
});

afterEach(async () => {
  await server?.close();
  server = null;
  await rm(dir, { recursive: true, force: true });
});

/** One `ctl` run: the line on its stdin, its exit code and the last line it printed. */
async function ctl(line: string): Promise<{ code: number; reply: string }> {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk: Buffer) => (printed += chunk.toString()));
  input.end(`${line}\n`);
  const code = await askControl(socket, input, output);
  return { code, reply: printed.trim().split("\n").pop() ?? "" };
}

const gate = () => {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};

describe("the control socket", () => {
  it("answers the status reads while another request runs, and runs the others one at a time", async () => {
    const first = gate();
    const order: string[] = [];
    server = await serveControl(
      socket,
      async (request: BrainControlRequest) => {
        if (request.op === "status" || request.op === "wake") return { state: "ready", version: "v1", pid: 1, since: 0, busy: server?.busy ?? null };
        order.push(`start ${request.op}`);
        if (request.op === "pair") await first.opened;
        order.push(`end ${request.op}`);
        return request.op === "pair" ? { url: "openorc://pair", expiresAt: 1 } : { stopping: true };
      },
      () => undefined,
    );
    expect((await stat(socket)).mode & 0o777).toBe(0o600);
    const pair = ctl(JSON.stringify({ op: "pair" }));
    const stop = ctl(JSON.stringify({ op: "stop" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await ctl(JSON.stringify({ op: "stop-for-update" }))).code).toBe(0);
    const status = await ctl(JSON.stringify({ op: "status" }));
    expect(parseControlReply("status", status.reply)).toMatchObject({ ok: true, result: { busy: "control" } });
    expect(parseControlReply("wake", (await ctl(JSON.stringify({ op: "wake" }))).reply)).toMatchObject({ ok: true, result: { busy: "control" } });
    expect(order).toEqual(["start pair", "start stop-for-update", "end stop-for-update"]);
    first.open();
    expect(parseControlReply("pair", (await pair).reply)).toEqual({ ok: true, result: { url: "openorc://pair", expiresAt: 1 } });
    expect((await stop).code).toBe(0);
    expect(order).toEqual(["start pair", "start stop-for-update", "end stop-for-update", "end pair", "start stop", "end stop"]);
    expect(server.busy).toBeNull();
  });

  it("answers a failure in the handler's words", async () => {
    server = await serveControl(
      socket,
      async () => {
        throw new Error("Turn on phone access first.");
      },
      () => undefined,
    );
    expect(parseControlReply("pair", (await ctl(JSON.stringify({ op: "pair" }))).reply)).toEqual({ ok: false, error: "Turn on phone access first." });
  });

  it("starts the idle clock again for use and a waker's status, never for a status poll or a stop", async () => {
    const requests = {
      status: { op: "status" },
      wake: { op: "wake" },
      pair: { op: "pair" },
      handover: { op: "handover", sealed: {} },
      "import-project": { op: "import-project", source: "p1", name: "demo", branch: "main", bundle: "demo.bundle" },
      "remove-project": { op: "remove-project", source: "p1" },
      projects: { op: "projects" },
      stop: { op: "stop" },
      "stop-for-update": { op: "stop-for-update" },
    } satisfies { [K in BrainControlOp]: Extract<BrainControlRequest, { op: K }> };
    let uses = 0;
    server = await serveControl(
      socket,
      async () => ({}),
      () => uses++,
    );
    const used: string[] = [];
    for (const [op, request] of Object.entries(requests)) {
      const before = uses;
      expect((await ctl(JSON.stringify(request))).code).toBe(0);
      if (uses > before) used.push(op);
    }
    expect(used).toEqual(["wake", "pair", "handover", "import-project", "remove-project", "projects"]);
  });

  it("names a bad field without repeating what was sent", async () => {
    server = await serveControl(
      socket,
      async () => ({}),
      () => undefined,
    );
    const { code, reply } = await ctl(JSON.stringify({ op: "import-project", source: "p1", name: "demo", branch: "main", bundle: "../secret-token-value" }));
    expect(code).toBe(BRAIN_EXIT.badStart);
    expect(reply).toContain("bundle");
    expect(reply).not.toContain("secret-token-value");
  });

  it("exits unavailable when no brain answers its socket", async () => {
    expect(await ctl(JSON.stringify({ op: "status" }))).toEqual({ code: BRAIN_EXIT.unavailable, reply: "" });
  });

  it("gives up on a brain that does not answer in time", async () => {
    const silent = createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(socket, resolve));
    try {
      const { code, reply } = await ctl(JSON.stringify({ op: "status" }));
      expect(code).toBe(1);
      expect(parseControlReply("status", reply)).toEqual({ ok: false, error: "The brain did not answer status." });
    } finally {
      silent.close();
    }
  });
});
