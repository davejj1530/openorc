import { spawn } from "node:child_process";
import { GitError, WITHOUT_HOOKS } from "./exec.js";

export interface GrepQuery {
  pattern: string;
  /** Literal text (`-F`); otherwise an extended regular expression (`-E`). */
  fixed: boolean;
  ignoreCase: boolean;
}

/** One matching line. `path` is relative to the folder searched, as git wrote it. */
export interface GrepLine {
  path: string;
  line: number;
  text: string;
}

export interface GrepLimits {
  /** Lines in all. One more stops git. */
  total: number;
  /** Lines from any one file. Later ones are dropped. */
  perFile: number;
  /** Stops git. The search answers what had arrived. */
  signal: AbortSignal;
}

/** `truncated`: more lines matched than the limits let through, or the search was stopped. `invalid`: git could not read the pattern. */
export type GrepResult = { kind: "lines"; lines: GrepLine[]; truncated: boolean } | { kind: "invalid"; message: string };

/** Bytes kept of one line. A minified file's line can run to megabytes; the rest is skipped as it streams. */
const LINE_BYTES = 8 * 1024;

/** Reads `git grep -z -n` output, a `path\0line\0text\n` record per match, as chunks arrive. */
function records(onRecord: (path: string, line: number, text: string) => void): (chunk: Buffer) => void {
  let field = 0;
  let parts: Buffer[] = [];
  let size = 0;
  let path = "";
  let line = 0;
  return (chunk) => {
    let at = 0;
    while (at < chunk.length) {
      const end = chunk.indexOf(field === 2 ? 0x0a : 0x00, at);
      const stop = end === -1 ? chunk.length : end;
      const keep = field === 2 ? Math.min(stop, at + Math.max(0, LINE_BYTES - size)) : stop;
      parts.push(chunk.subarray(at, keep));
      size += keep - at;
      if (end === -1) return;
      const value = Buffer.concat(parts).toString("utf8");
      parts = [];
      size = 0;
      if (field === 0) path = value;
      else if (field === 1) line = Number(value);
      else onRecord(path, line, value);
      field = (field + 1) % 3;
      at = end + 1;
    }
  };
}

/** Git's reason for refusing the pattern, as in `fatal: -e option, '(': parentheses not balanced`. */
function patternError(stderr: string, pattern: string): string | null {
  const marker = `-e option, '${pattern}': `;
  const at = stderr.indexOf(marker);
  return at === -1 ? null : (stderr.slice(at + marker.length).split("\n")[0] ?? "").trim();
}

/**
 * Lines matching `query` in the working tree at `cwd`: tracked and untracked files, .gitignore respected, binary files
 * skipped. Output streams, so git stops as soon as the limits are met or `signal` aborts. Hooks are off, and the
 * pattern follows `-e`, so one starting with `-` is never read as an option.
 */
export function grepWorkingTree(cwd: string, query: GrepQuery, limits: GrepLimits): Promise<GrepResult> {
  // The --no-* flags hold the record shape against a user's color.ui, grep.column and grep.fullName.
  const args = ["grep", "-I", "-n", "-z", "--untracked", "--no-color", "--no-column", "--no-full-name", ...(query.ignoreCase ? ["-i"] : []), query.fixed ? "-F" : "-E", "-e", query.pattern, "--"];
  return new Promise((resolve, reject) => {
    const lines: GrepLine[] = [];
    const counts = new Map<string, number>();
    const stderr: Buffer[] = [];
    let truncated = false;
    let stopped = false;
    const child = spawn("git", [...WITHOUT_HOOKS, ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] });
    const stop = () => {
      truncated = true;
      if (stopped) return;
      stopped = true;
      child.kill();
    };
    child.stdout.on(
      "data",
      records((path, line, text) => {
        if (stopped) return;
        const count = (counts.get(path) ?? 0) + 1;
        counts.set(path, count);
        if (count > limits.perFile) truncated = true;
        else if (lines.length === limits.total) stop();
        else lines.push({ path, line, text });
      }),
    );
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    limits.signal.addEventListener("abort", stop, { once: true });
    if (limits.signal.aborted) stop();
    child.on("error", (error) => {
      limits.signal.removeEventListener("abort", stop);
      reject(error);
    });
    child.on("close", (code) => {
      limits.signal.removeEventListener("abort", stop);
      if (stopped || code === 0 || code === 1) {
        resolve({ kind: "lines", lines, truncated });
        return;
      }
      const message = Buffer.concat(stderr).toString();
      const invalid = query.fixed ? null : patternError(message, query.pattern);
      if (invalid) resolve({ kind: "invalid", message: invalid });
      else reject(new GitError(args, cwd, code, message));
    });
  });
}
