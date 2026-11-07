import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly cwd: string,
    readonly code: number | null,
    readonly stderr: string,
    readonly stdout = "",
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

let signIn: () => Record<string, string> = () => ({});

/**
 * What every git and gh this process runs gets beside its own environment, asked at each run: the cloud brain's GitHub
 * sign-in. It stays out of process.env, so no other program the process starts inherits it, and it goes the moment
 * `environment` stops naming it.
 */
export function useGitHubSignIn(environment: () => Record<string, string>): void {
  signIn = environment;
}

/** What every git and gh this process runs is given beside the process's own environment. */
const environment = (bin: string, extra: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
  ...(bin === "git" || bin === "gh" ? signIn() : {}),
  ...extra,
});

/**
 * Runs git with its output written to `file` as it comes, for output too large to hold, such as a pack. A pack asked
 * for this way never moves: one git writes itself is made beside the repository's objects and renamed to its name,
 * which fails when that name is on another disk, as /tmp is on a Linux host.
 */
export async function gitToFile(cwd: string, args: string[], file: string, options: Pick<ExecOptions, "input" | "timeoutMs" | "env"> = {}): Promise<void> {
  const child = spawn("git", [...WITHOUT_HOOKS, ...args], { cwd, env: environment("git", options.env), timeout: options.timeoutMs ?? 60_000 });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.on("error", () => undefined);
  child.stdin.end(options.input);
  const [[code]] = (await Promise.all([once(child, "close"), pipeline(child.stdout, createWriteStream(file))])) as [[number | null], void];
  if (code !== 0) throw new GitError(args, cwd, code, Buffer.concat(stderr).toString("utf8"));
}

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
        env: environment(bin, options.env),
      },
      (error, stdout, stderr) => {
        const code = commandExitCode(error);
        if (error && !(code !== null && okCodes.includes(code))) {
          reject(new GitError([bin === "git" ? "" : bin, ...args].filter(Boolean), cwd, code, String(stderr), String(stdout)));
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
