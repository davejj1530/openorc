import { describe, expect, it } from "vitest";
import { SANDBOX_AWAY_MS } from "./sandbox.js";
import { VercelSandbox, VercelSandboxProvider, type VercelApi, type VercelCommand, type VercelListed, type VercelVm } from "./vercel-sandbox.js";

type Line = { stream: "stdout" | "stderr"; data: string };

/** A command that exits when told to, streams the lines it is given, and records its input. */
class FakeCommand implements VercelCommand {
  readonly stdin: string[] = [];
  stdinClosed = false;
  killedWith: string | undefined;
  private readonly lines: Line[] = [];
  private wake: (() => void) | null = null;
  private exitCode: number | null = null;
  private readonly exited: Promise<number>;
  private exit!: (code: number) => void;

  constructor(private readonly result: { stdout?: string; stderr?: string } = {}) {
    this.exited = new Promise((resolve) => (this.exit = resolve));
  }

  emit(stream: Line["stream"], data: string): void {
    this.lines.push({ stream, data });
    this.wake?.();
  }

  finish(code: number): void {
    this.exitCode = code;
    this.exit(code);
    this.wake?.();
  }

  async wait() {
    const exitCode = await this.exited;
    return { exitCode, stdout: async () => this.result.stdout ?? "", stderr: async () => this.result.stderr ?? "" };
  }

  async *logs(): AsyncIterable<Line> {
    for (;;) {
      const line = this.lines.shift();
      if (line) yield line;
      else if (this.exitCode !== null) return;
      else await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  async writeStdin(data: string | Uint8Array): Promise<void> {
    // A slow write: input written after it must still arrive after it.
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.stdin.push(Buffer.from(data).toString("utf8"));
  }

  async closeStdin(): Promise<void> {
    this.stdinClosed = true;
  }

  async kill(signal?: "SIGTERM" | "SIGKILL"): Promise<void> {
    this.killedWith = signal;
    this.finish(137);
  }
}

type Run = Parameters<VercelVm["runCommand"]>[0];

/** A VM whose commands answer through `answer`, which records each one. */
type FakeVm = Omit<VercelVm, "expiresAt"> & { expiresAt: Date | undefined; runs: Run[]; extended: number[] };

function fakeVm(answer: (run: Run) => FakeCommand, files: Record<string, Buffer> = {}, cwd = "/vercel/sandbox"): FakeVm {
  const runs: Run[] = [];
  const extended: number[] = [];
  return {
    cwd,
    runs,
    extended,
    expiresAt: undefined,
    async extendTimeout(duration) {
      extended.push(duration);
      this.expiresAt = new Date((this.expiresAt?.getTime() ?? Date.now()) + duration);
    },
    runCommand: async (params) => {
      runs.push(params);
      return answer(params);
    },
    writeFiles: async (written) => {
      for (const file of written) files[file.path] = Buffer.from(file.content);
    },
    readFileToBuffer: async ({ path }) => files[path] ?? null,
    stop: async () => undefined,
  };
}

const finished = (code: number, output: { stdout?: string; stderr?: string } = {}) => {
  const command = new FakeCommand(output);
  command.finish(code);
  return command;
};

describe("a sandbox on Vercel", () => {
  it("streams a command's input in order and its stdout out, and ends when it exits", async () => {
    const command = new FakeCommand();
    const vm = fakeVm(() => command);
    const stream = await new VercelSandbox("s", vm).stream("node", ["runner.ts", "bridge"]);
    expect(vm.runs[0]).toMatchObject({ cmd: "node", args: ["runner.ts", "bridge"], cwd: "/vercel/sandbox", detached: true, stdin: true });

    let output = "";
    stream.output.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    stream.input.write("one\n");
    stream.input.write("two\n");
    await new Promise<void>((resolve) => stream.input.end(resolve));
    command.emit("stdout", "first ");
    command.emit("stderr", "not this");
    command.emit("stdout", "second");
    command.finish(0);
    await stream.ended;

    expect(command.stdin).toEqual(["one\n", "two\n"]);
    expect(command.stdinClosed).toBe(true);
    expect(output).toBe("first second");
    await new Promise((resolve) => (stream.output.readableEnded ? resolve(undefined) : stream.output.once("end", resolve)));
  });

  it("works in the folder its image starts sessions in", async () => {
    const vm = fakeVm(() => finished(0), {}, "/home/vercel-sandbox");
    const sandbox = new VercelSandbox("s", vm);
    expect(sandbox.root).toBe("/home/vercel-sandbox");
    await sandbox.exec("git", ["--version"]);
    await sandbox.launch("node", ["runner.ts", "daemon"]);
    expect(vm.runs.map((run) => run.cwd)).toEqual(["/home/vercel-sandbox", "/home/vercel-sandbox"]);
  });

  it("kills the command when the stream is closed", async () => {
    const command = new FakeCommand();
    const stream = await new VercelSandbox(
      "s",
      fakeVm(() => command),
    ).stream("node", []);
    stream.close();
    await stream.ended;
    expect(command.killedWith).toBe("SIGKILL");
  });

  it("returns a failing command's exit code and output instead of throwing", async () => {
    const sandbox = new VercelSandbox(
      "s",
      fakeVm(() => finished(3, { stdout: "partial", stderr: "it broke" })),
    );
    const result = await sandbox.exec("git", ["status"], { cwd: "/vercel/sandbox/repo", env: { A: "1" } });
    expect(result).toEqual({ code: 3, stdout: Buffer.from("partial"), stderr: "it broke" });
  });

  it("moves the session's timeout to its away window from now, only when it would end sooner", async () => {
    const vm = fakeVm(() => finished(0));
    const sandbox = new VercelSandbox("s", vm);
    vm.expiresAt = new Date(Date.now() + SANDBOX_AWAY_MS + 60_000);
    await sandbox.keepAwake();
    expect(vm.extended).toEqual([]);
    vm.expiresAt = new Date(Date.now() + 60_000);
    await sandbox.keepAwake();
    expect(vm.extended).toHaveLength(1);
    expect(vm.extended[0]).toBeGreaterThan(SANDBOX_AWAY_MS - 60_000 - 1000);
    expect(vm.extended[0]).toBeLessThanOrEqual(SANDBOX_AWAY_MS - 60_000);
    expect(vm.expiresAt!.getTime()).toBeGreaterThanOrEqual(Date.now() + SANDBOX_AWAY_MS - 1000);
  });

  it("reads a file it wrote, and null for one that is missing", async () => {
    const sandbox = new VercelSandbox(
      "s",
      fakeVm(() => finished(0)),
    );
    await sandbox.writeFile("/vercel/sandbox/.openorc/runner/runner.ts", Buffer.from("code"));
    expect((await sandbox.readFile("/vercel/sandbox/.openorc/runner/runner.ts"))?.toString()).toBe("code");
    expect(await sandbox.readFile("/vercel/sandbox/missing")).toBeNull();
  });
});

describe("the Vercel sandbox provider", () => {
  const settings = { credentials: async () => ({ token: "tok", teamId: "team", projectId: "proj" }) };

  /** An API whose sandboxes exist after their first open, in the region they were made in, with `claude` on PATH when `hasClaude` says so. */
  function api(hasClaude: () => boolean, listed: VercelListed[] = []) {
    const created = new Set<string>();
    const regions: Record<string, string | undefined> = {};
    const vm = fakeVm((run) => finished(run.cmd === "sh" && !hasClaude() ? 1 : 0));
    const calls: Parameters<VercelApi["getOrCreate"]>[0][] = [];
    const removed: string[] = [];
    const prefixes: string[] = [];
    const fake: VercelApi = {
      remove: async ({ name }) => void removed.push(name),
      list: async ({ prefix }) => {
        prefixes.push(prefix);
        return listed;
      },
      getOrCreate: async (params) => {
        calls.push(params);
        if (!created.has(params.name)) {
          created.add(params.name);
          regions[params.name] = params.region;
        }
        return vm;
      },
    };
    return { fake, vm, calls, removed, prefixes, regions };
  }

  const installs = (vm: { runs: Run[] }) => vm.runs.filter((run) => run.cmd === "npm");
  const checks = (vm: { runs: Run[] }) => vm.runs.filter((run) => run.cmd === "sh");

  it("passes the credentials, keeps every account's Claude token out of the sandbox, and opens it bare: each turn installs its own agent", async () => {
    const present = api(() => true);
    await new VercelSandboxProvider({ ...settings, api: present.fake }).open("openorc-a");
    expect(present.calls[0]).toMatchObject({
      name: "openorc-a",
      persistent: true,
      timeout: SANDBOX_AWAY_MS,
      token: "tok",
      teamId: "team",
      projectId: "proj",
    });
    expect(present.calls[0]).not.toHaveProperty("env");
    expect(checks(present.vm)).toHaveLength(0);
    expect(installs(present.vm)).toHaveLength(0);
  });

  it("makes new sandboxes the size Settings asks for, and leaves Vercel's default otherwise", async () => {
    const sized = api(() => true);
    await new VercelSandboxProvider({ credentials: async () => ({ token: "tok", teamId: "team", projectId: "proj", vcpus: 8 }), api: sized.fake }).open("openorc-e");
    expect(sized.calls[0]?.resources).toEqual({ vcpus: 8 });
    const plain = api(() => true);
    await new VercelSandboxProvider({ ...settings, api: plain.fake }).open("openorc-f");
    expect(plain.calls[0]).not.toHaveProperty("resources");
  });

  it("makes each new sandbox in the region asked for when it is made, and leaves Vercel's default otherwise", async () => {
    let region: string | undefined = "sin1";
    const placed = api(() => true);
    const provider = new VercelSandboxProvider({ credentials: async () => ({ token: "tok", teamId: "team", projectId: "proj", ...(region ? { region } : {}) }), api: placed.fake });
    await provider.open("openorc-g");
    region = "fra1";
    await provider.open("openorc-g");
    await provider.open("openorc-h");
    expect(placed.regions).toEqual({ "openorc-g": "sin1", "openorc-h": "fra1" });
    region = undefined;
    await provider.open("openorc-i");
    expect(placed.calls.at(-1)).not.toHaveProperty("region");
  });

  it("lists OpenOrc's sandboxes with their state, size, time awake and cost at list prices", async () => {
    const now = Date.now();
    const { fake, prefixes } = api(
      () => true,
      [
        { name: "openorc-a", status: "running", createdAt: now - 7_200_000, statusUpdatedAt: now - 600_000, vcpus: 8, memory: 16_384, totalActiveCpuDurationMs: 360_000, totalDurationMs: 3_600_000 },
        { name: "openorc-b", status: "snapshotting", createdAt: now - 60_000, vcpus: 2, memory: 4096 },
      ],
    );
    const sandboxes = await new VercelSandboxProvider({ ...settings, api: fake }).list();
    expect(prefixes).toEqual(["openorc-"]);
    expect(sandboxes[0]).toEqual({
      name: "openorc-a",
      state: "running",
      createdAt: now - 7_200_000,
      awakeSince: now - 600_000,
      awakeMs: 3_600_000,
      vcpus: 8,
      memoryMb: 16_384,
      costUsd: expect.closeTo(0.1 * 0.128 + 16 * 0.0212, 6),
    });
    expect(sandboxes[1]).toMatchObject({ state: "stopping", awakeSince: null, awakeMs: 0, costUsd: 0 });
  });

  it("deletes a sandbox with the account's credentials", async () => {
    const { fake, removed } = api(() => true);
    await new VercelSandboxProvider({ ...settings, api: fake }).remove("openorc-d");
    expect(removed).toEqual(["openorc-d"]);
  });

  it("asks to connect Vercel in Settings, without calling Vercel, until its credentials are complete", async () => {
    const { fake, calls } = api(() => true);
    for (const credentials of [async () => null, async () => ({ token: "tok", teamId: "", projectId: "proj" })])
      await expect(new VercelSandboxProvider({ credentials, api: fake }).open("x")).rejects.toThrow("Connect Vercel in Settings to run in the cloud.");
    expect(calls).toHaveLength(0);
  });
});
