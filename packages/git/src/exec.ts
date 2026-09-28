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
  /**
   * Lets the repository's hooks run, for the user's own commits, pushes and new worktrees. Every other command skips
   * them: it may run in a checkout of someone else's pull request, where a relative core.hooksPath, as husky sets,
   * finds hooks in that pull request's files.
   */
  hooks?: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Keeps Git from running any hook. */
export const WITHOUT_HOOKS = ["-c", "core.hooksPath=/dev/null"];

/** Runs the user's own git. Nothing here reads credentials, and no hook runs unless `hooks` asks for them. */
export function git(cwd: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return execute("git", cwd, args, options, options.hooks ? [] : WITHOUT_HOOKS);
}

export function run(bin: string, cwd: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return execute(bin, cwd, args, options, []);
}

/** Runs `bin` with `settings` ahead of `args`. A failure names the command by `args`, as its caller wrote it. */
function execute(bin: string, cwd: string, args: string[], options: ExecOptions, settings: string[]): Promise<ExecResult> {
  const okCodes = options.okCodes ?? [0];
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      [...settings, ...args],
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
