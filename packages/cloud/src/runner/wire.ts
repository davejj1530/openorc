/**
 * Frames between OpenOrc on the Mac and the runner inside a cloud workspace, one JSON object per line. Bytes travel as
 * base64. Offsets count bytes from the start of a process's stream, so either side can reconnect and resume exactly.
 */

export const RUNNER_VERSION = 1;

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

export type ClientFrame =
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
  | { op: "welcome"; version: number; home: string; processes: ProcessState[] }
  | { op: "spawned"; id: string }
  | { op: "out"; id: string; stream: OutputStream; at: number; data: string }
  | { op: "exit"; id: string; exit: ProcessExit }
  | { op: "stdin-ack"; id: string; at: number }
  | { op: "relay-ready"; name: string; port: number }
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
