/**
 * Frames between OpenOrc on the Mac and the runner inside a cloud workspace, one JSON object per line. Bytes travel as
 * base64. Offsets count bytes from the start of a process's stream, so either side can reconnect and resume exactly.
 */

export const RUNNER_VERSION = 1;
/** The folder in the runner's state whose commands come first on its processes' PATH. */
export const RUNNER_BIN = "bin";

export type OutputStream = "stdout" | "stderr";

/** `lost` marks a process that was running when the workspace stopped. */
export interface ProcessExit {
  code: number | null;
  signal: string | null;
  lost?: true;
  error?: string;
}

export interface ProcessState {
  id: string;
  stdinAt: number;
  stdout: number;
  stderr: number;
  exit: ProcessExit | null;
}

/** Written before the process starts, readable only by the VM's user. */
export interface SpawnFile {
  path: string;
  content: string;
}

/**
 * What the sandbox starts on its own when the Mac goes away in the middle of a turn: the agent resuming its session.
 * It carries the account's token, so the daemon keeps it in memory only.
 */
export interface Takeover {
  id: string;
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** How long the Mac may be gone before it starts without being told to. */
  afterMs: number;
}

/** A takeover the sandbox started, until the Mac has seen it. */
export interface TakeoverStarted {
  id: string;
  at: number;
}

export type ClientFrame =
  | { op: "standby"; takeover: Takeover }
  | { op: "standby-off" }
  | { op: "away" }
  | { op: "takeover-seen" }
  | { op: "hello" }
  | { op: "spawn"; id: string; cmd: string; args: string[]; cwd: string; env: Record<string, string>; files?: SpawnFile[]; dirs?: string[] }
  | { op: "attach"; id: string; stdout: number; stderr: number }
  | { op: "stdin"; id: string; at: number; data: string }
  | { op: "stdin-end"; id: string; at: number }
  | { op: "signal"; id: string; signal: string }
  | { op: "forget"; id: string }
  | { op: "relay-open"; name: string }
  | { op: "http-head"; req: string; status: number; headers: Record<string, string> }
  | { op: "http-data"; req: string; data: string }
  | { op: "http-end"; req: string };

export type RunnerFrame =
  | { op: "welcome"; version: number; home: string; processes: ProcessState[]; takeover?: TakeoverStarted | null }
  | { op: "spawned"; id: string }
  | { op: "out"; id: string; stream: OutputStream; at: number; data: string }
  | { op: "exit"; id: string; exit: ProcessExit }
  | { op: "stdin-ack"; id: string; at: number }
  | { op: "relay-ready"; name: string; port: number }
  /** Answers `away`: the takeover that started, or null when none was armed. */
  | { op: "took-over"; takeover: TakeoverStarted | null }
  | { op: "http"; req: string; name: string; method: string; url: string; headers: Record<string, string>; body: string }
  | { op: "http-abort"; req: string };

export function encodeFrame(frame: ClientFrame | RunnerFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/** Feeds a byte stream in and hands each complete line out as a parsed frame. */
export function frameReader<T>(onFrame: (frame: T) => void): (chunk: Buffer) => void {
  let pending: Buffer = Buffer.alloc(0);
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    for (let end = pending.indexOf(10, start); end !== -1; end = pending.indexOf(10, start)) {
      const line = pending.subarray(start, end).toString("utf8");
      start = end + 1;
      if (line.trim()) onFrame(JSON.parse(line) as T);
    }
    pending = pending.subarray(start);
  };
}
