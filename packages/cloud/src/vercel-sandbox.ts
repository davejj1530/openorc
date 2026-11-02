import { PassThrough, Writable } from "node:stream";
import { Sandbox as SdkSandbox } from "@vercel/sandbox";
import type { Sandbox, SandboxCommandOptions, SandboxExecResult, SandboxProvider, SandboxStream } from "./sandbox.js";

const ROOT = "/vercel/sandbox";
/** The longest session the Hobby plan allows. A persistent sandbox resumes into a new session after it. */
const SESSION_MS = 45 * 60_000;
/** After the command exits, how long its remaining output gets to arrive before the stream ends anyway. */
const LOG_DRAIN_MS = 2000;

export interface VercelCredentials {
  token: string;
  teamId: string;
  projectId: string;
}

/** The parts of a Vercel command this provider uses. */
export interface VercelCommand {
  wait(): Promise<{ exitCode: number; stdout(): Promise<string>; stderr(): Promise<string> }>;
  logs(): AsyncIterable<{ stream: "stdout" | "stderr"; data: string }>;
  writeStdin(data: string | Uint8Array): Promise<void>;
  closeStdin(): Promise<void>;
  kill(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
}

/** The parts of a Vercel sandbox this provider uses. Every command starts detached; `exec` waits for it. */
export interface VercelVm {
  runCommand(params: { cmd: string; args: string[]; cwd: string; env?: Record<string, string>; sudo?: boolean; detached: true; stdin?: boolean }): Promise<VercelCommand>;
  writeFiles(files: { path: string; content: Uint8Array }[]): Promise<void>;
  readFileToBuffer(file: { path: string }): Promise<Buffer | null>;
  stop(): Promise<unknown>;
}

export interface VercelOpenParams extends VercelCredentials {
  name: string;
  persistent: true;
  timeout: number;
  env?: Record<string, string>;
  onCreate: (vm: VercelVm) => Promise<void>;
}

/** How the provider reaches Vercel. Tests pass a stand-in; the app passes the SDK. */
export interface VercelApi {
  getOrCreate(params: VercelOpenParams): Promise<VercelVm>;
  /** Deletes the sandbox, its files and the snapshots only it used. */
  remove(params: VercelCredentials & { name: string }): Promise<void>;
}

const sdk: VercelApi = {
  getOrCreate: async ({ onCreate, ...params }) => {
    const vm: VercelVm = await SdkSandbox.getOrCreate({ ...params, onCreate: (sandbox) => onCreate(sandbox) });
    return vm;
  },
  remove: async ({ name, token, teamId, projectId }) => {
    const sandbox = await SdkSandbox.get({ name, token, teamId, projectId });
    await sandbox.delete({ deleteOrphanSnapshots: true });
  },
};

export interface VercelProviderOptions {
  /** Null until Vercel is connected. Read on every open, so a change in Settings applies to the next sandbox. */
  credentials: () => Promise<VercelCredentials | null>;
  api?: VercelApi;
}

async function run(vm: VercelVm, cmd: string, args: string[], options: SandboxCommandOptions & { sudo?: boolean } = {}): Promise<SandboxExecResult> {
  const command = await vm.runCommand({ cmd, args, cwd: options.cwd ?? ROOT, ...(options.env ? { env: options.env } : {}), ...(options.sudo ? { sudo: true } : {}), detached: true });
  const done = await command.wait();
  return { code: done.exitCode, stdout: Buffer.from(await done.stdout(), "utf8"), stderr: await done.stderr() };
}

/** Puts Claude Code on the VM's PATH unless it is there already. */
export async function ensureClaude(vm: VercelVm): Promise<void> {
  // Plain sh, not a login shell: the runner starts the CLI with the VM's default environment.
  const found = await run(vm, "sh", ["-c", "command -v claude"]);
  if (found.code === 0) return;
  const install = await run(vm, "npm", ["install", "-g", "@anthropic-ai/claude-code"], { sudo: true });
  if (install.code !== 0) throw new Error(`Claude Code could not be installed in the cloud workspace: ${install.stderr.trim().slice(-500)}`);
}

/** A VM on Vercel. Its files persist between sessions; its processes do not. */
export class VercelSandbox implements Sandbox {
  readonly root = ROOT;

  constructor(
    readonly name: string,
    private readonly vm: VercelVm,
  ) {}

  exec(cmd: string, args: string[], options: SandboxCommandOptions = {}): Promise<SandboxExecResult> {
    return run(this.vm, cmd, args, options);
  }

  async launch(cmd: string, args: string[], options: SandboxCommandOptions = {}): Promise<void> {
    await this.vm.runCommand({ cmd, args, cwd: options.cwd ?? ROOT, ...(options.env ? { env: options.env } : {}), detached: true });
  }

  async stream(cmd: string, args: string[], options: SandboxCommandOptions = {}): Promise<SandboxStream> {
    const command = await this.vm.runCommand({ cmd, args, cwd: options.cwd ?? ROOT, ...(options.env ? { env: options.env } : {}), detached: true, stdin: true });
    const output = new PassThrough();
    const pump = (async () => {
      for await (const line of command.logs()) if (line.stream === "stdout") output.write(Buffer.from(line.data, "utf8"));
    })();
    const exited = command.wait().then(() => Promise.race([pump, new Promise((resolve) => setTimeout(resolve, LOG_DRAIN_MS))]));
    const ended = Promise.race([pump, exited])
      .catch(() => undefined)
      .then(() => {
        output.end();
      });
    // Writable calls write once at a time, so input reaches the command in order.
    const input = new Writable({
      write: (chunk: Buffer, _encoding, done) => void command.writeStdin(chunk).then(() => done(), done),
      final: (done) => void command.closeStdin().then(() => done(), done),
    });
    return { input, output, ended, close: () => void command.kill("SIGKILL").catch(() => undefined) };
  }

  async writeFile(file: string, content: Buffer): Promise<void> {
    await this.vm.writeFiles([{ path: file, content }]);
  }

  readFile(file: string): Promise<Buffer | null> {
    return this.vm.readFileToBuffer({ path: file });
  }

  async stop(): Promise<void> {
    await this.vm.stop();
  }
}

export class VercelSandboxProvider implements SandboxProvider {
  readonly id = "vercel";
  private readonly api: VercelApi;
  /** Sandboxes whose Claude Code was checked since the app started. */
  private readonly checked = new Set<string>();

  constructor(private readonly options: VercelProviderOptions) {
    this.api = options.api ?? sdk;
  }

  private async access(): Promise<VercelCredentials> {
    const access = await this.options.credentials();
    if (!access?.token || !access.teamId || !access.projectId) throw new Error("Connect Vercel in Settings to run in the cloud.");
    return access;
  }

  /** Deletes a sandbox for good, with its files. */
  async remove(name: string): Promise<void> {
    const { token, teamId, projectId } = await this.access();
    await this.api.remove({ name, token, teamId, projectId });
    this.checked.delete(name);
  }

  async open(name: string): Promise<VercelSandbox> {
    const access = await this.access();
    let created = false;
    const vm = await this.api.getOrCreate({
      name,
      persistent: true,
      timeout: SESSION_MS,
      token: access.token,
      teamId: access.teamId,
      projectId: access.projectId,
      onCreate: async (fresh) => {
        created = true;
        await ensureClaude(fresh);
      },
    });
    // A sandbox made before this check existed, or whose install failed, gets it on first use.
    if (!created && !this.checked.has(name)) await ensureClaude(vm);
    this.checked.add(name);
    return new VercelSandbox(name, vm);
  }

  /** VMs keep running when OpenOrc closes and sleep on their own. */
  async close(): Promise<void> {}
}
