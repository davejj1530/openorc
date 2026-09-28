import { execFile } from "node:child_process";

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly cwd: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed (${code ?? "signal"}) in ${cwd}: ${stderr.trim() || "no stderr"}`);
    this.name = "GitError";
  }
}

export interface ExecOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Exit codes to treat as success (git diff uses 1 for "differences found"). */
  okCodes?: number[];
  maxBuffer?: number;
  /** Written to the command's stdin, for lists too long for arguments. */
  input?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs the user's own git. Nothing here reads credentials. */
export function git(cwd: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return run("git", cwd, args, options);
}

export function run(bin: string, cwd: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  const okCodes = options.okCodes ?? [0];
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      {
        cwd,
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...options.env },
      },
      (error, stdout, stderr) => {
        const code = commandExitCode(error);
        if (error && !(code !== null && okCodes.includes(code))) {
          reject(new GitError([bin === "git" ? "" : bin, ...args].filter(Boolean), cwd, code, String(stderr)));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr), code: code ?? 0 });
      },
    );
    if (options.input !== undefined) {
      child.stdin?.on("error", () => {}); // The command callback reports early exits.
      child.stdin?.end(options.input);
    }
  });
}

/** A signal or launch error has no numeric exit code; a successful callback means zero. */
export function commandExitCode(error: { code?: string | number | null } | null): number | null {
  if (!error) return 0;
  return typeof error.code === "number" ? error.code : null;
}
