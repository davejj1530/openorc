import type { Readable, Writable } from "node:stream";

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
  /** Runs a command to completion. A non-zero exit is a result, not an error. */
  exec(cmd: string, args: string[], options?: SandboxCommandOptions): Promise<SandboxExecResult>;
  /** Starts a command that outlives this call and runs until it exits or the VM stops. */
  launch(cmd: string, args: string[], options?: SandboxCommandOptions): Promise<void>;
  stream(cmd: string, args: string[], options?: SandboxCommandOptions): Promise<SandboxStream>;
  /** Creates parent folders as needed. */
  writeFile(file: string, content: Buffer): Promise<void>;
  /** Null when the file does not exist. */
  readFile(file: string): Promise<Buffer | null>;
  /** Ends every process. The files stay for the next `open`. */
  stop(): Promise<void>;
}

export interface SandboxProvider {
  readonly id: "local" | "vercel";
  /** Creates the named sandbox, or wakes it when it exists. */
  open(name: string): Promise<Sandbox>;
}
