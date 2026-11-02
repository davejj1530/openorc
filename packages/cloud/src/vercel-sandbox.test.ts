import { describe, expect, it } from "vitest";
import { VercelSandbox, VercelSandboxProvider, type VercelApi, type VercelCommand, type VercelVm } from "./vercel-sandbox.js";

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
function fakeVm(answer: (run: Run) => FakeCommand, files: Record<string, Buffer> = {}): VercelVm & { runs: Run[] } {
  const runs: Run[] = [];
  return {
    runs,
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

  /** An API whose sandboxes exist after their first open, with `claude` on PATH when `hasClaude` says so. */
  function api(hasClaude: () => boolean) {
    const created = new Set<string>();
    const vm = fakeVm((run) => finished(run.cmd === "sh" && !hasClaude() ? 1 : 0));
    const calls: Parameters<VercelApi["getOrCreate"]>[0][] = [];
    const removed: string[] = [];
    const fake: VercelApi = {
      remove: async ({ name }) => void removed.push(name),
      getOrCreate: async (params) => {
        calls.push(params);
        if (!created.has(params.name)) {
          created.add(params.name);
          await params.onCreate(vm);
        }
        return vm;
      },
    };
    return { fake, vm, calls, removed };
  }

  const installs = (vm: { runs: Run[] }) => vm.runs.filter((run) => run.cmd === "npm");
  const checks = (vm: { runs: Run[] }) => vm.runs.filter((run) => run.cmd === "sh");

  it("passes the credentials, keeps every account's Claude token out of the sandbox, and installs Claude Code only when it is missing", async () => {
    const present = api(() => true);
    await new VercelSandboxProvider({ ...settings, api: present.fake }).open("openorc-a");
    expect(present.calls[0]).toMatchObject({
      name: "openorc-a",
      persistent: true,
      timeout: 45 * 60_000,
      token: "tok",
      teamId: "team",
      projectId: "proj",
    });
    expect(present.calls[0]).not.toHaveProperty("env");
    expect(checks(present.vm)).toHaveLength(1);
    expect(installs(present.vm)).toHaveLength(0);

    const missing = api(() => false);
    await new VercelSandboxProvider({ ...settings, api: missing.fake }).open("openorc-b");
    expect(installs(missing.vm)).toEqual([expect.objectContaining({ args: ["install", "-g", "@anthropic-ai/claude-code"], sudo: true })]);
  });

  it("checks a sandbox it did not create once, the first time this app opens it", async () => {
    const existing = api(() => true);
    await existing.fake.getOrCreate({ name: "openorc-c", persistent: true, timeout: 1, token: "", teamId: "", projectId: "", onCreate: async () => undefined });
    const provider = new VercelSandboxProvider({ ...settings, api: existing.fake });
    await provider.open("openorc-c");
    await provider.open("openorc-c");
    expect(checks(existing.vm)).toHaveLength(1);
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
