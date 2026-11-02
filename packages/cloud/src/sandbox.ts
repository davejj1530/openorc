import type { Readable, Writable } from "node:stream";

/**
 * How long a VM keeps going on its own once nothing keeps it awake: while the Mac sleeps, is offline or OpenOrc has
 * quit, an agent's turn carries on this long. Then the VM stops, and its files stay for the next session.
 */
export const SANDBOX_AWAY_MS = 30 * 60_000;

export interface SandboxCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export interface SandboxExecResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/** Standard input and output of one command that keeps running, such as the runner's bridge. */
export interface SandboxStream {
  readonly input: Writable;
  readonly output: Readable;
  /** Settles when the command ends, for whatever reason. */
  readonly ended: Promise<void>;
  close(): void;
}

/**
 * One Linux VM that holds a cloud workspace, whichever service runs it. Every path is the VM's own; nothing here
 * assumes the VM shares a disk with the Mac. Files persist while it sleeps and processes do not.
 */
export interface Sandbox {
  readonly name: string;
  /** Where the workspace's files live in the VM, such as /vercel/sandbox. */
  readonly root: string;
  /** How long the VM runs on its own once nothing keeps it awake. The next command starts a new session. */
  readonly awayMs: number;
  /** Runs a command to completion. A non-zero exit is a result, not an error. */
  exec(cmd: string, args: string[], options?: SandboxCommandOptions): Promise<SandboxExecResult>;
  /** Starts a command that outlives this call and runs until it exits or the VM stops. */
  launch(cmd: string, args: string[], options?: SandboxCommandOptions): Promise<void>;
  stream(cmd: string, args: string[], options?: SandboxCommandOptions): Promise<SandboxStream>;
  /** Creates parent folders as needed. */
  writeFile(file: string, content: Buffer): Promise<void>;
  /** Null when the file does not exist. */
  readFile(file: string): Promise<Buffer | null>;
  /** Moves the VM's own stop to `awayMs` from now, unless it is later already. */
  keepAwake(): Promise<void>;
  /** Ends every process. The files stay for the next `open`. */
  stop(): Promise<void>;
}

/** Every sandbox OpenOrc makes is named with this, so a list leaves out a team's other sandboxes. */
export const SANDBOX_PREFIX = "openorc-";

/** What a sandbox service reports about one of OpenOrc's sandboxes. */
export interface SandboxInfo {
  name: string;
  state: "starting" | "running" | "stopping" | "stopped" | "failed";
  createdAt: number;
  /** When its running session began; null while it does not run. */
  awakeSince: number | null;
  /** How long it has run, all sessions together, as the service last counted. */
  awakeMs: number;
  vcpus: number | null;
  memoryMb: number | null;
  /** Estimated at the service's list prices; null where nothing is billed. */
  costUsd: number | null;
}

export interface SandboxProvider {
  readonly id: "local" | "vercel";
  /** Creates the named sandbox, or wakes it when it exists. */
  open(name: string): Promise<Sandbox>;
  /** Deletes the named sandbox and its files for good. */
  remove(name: string): Promise<void>;
  /** Every sandbox OpenOrc made on this service: its conversations' own, and any no conversation has anymore. */
  list(): Promise<SandboxInfo[]>;
  /** Called as OpenOrc closes. A cloud VM keeps running and sleeps on its own; a sandbox on this Mac stops here. */
  close?(): Promise<void>;
}
