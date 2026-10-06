import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import readline from "node:readline";
import { launchCommand } from "../command-launch.js";
import { stopProcess, waitForProcessGroup } from "../process-lifetime.js";
import type { AgentLaunchEnvironment } from "../launch-environment.js";

/** Sends one control request and resolves with the CLI's answer, or rejects with its error text. */
export type ClaudeControlAsk = (request: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface ClaudeControlSessionOptions {
  /** What the session is for, as it reads in errors: "listing models". */
  task: string;
  /** Added to the CLI's `--settings`; hooks are always disabled. */
  settings?: Record<string, unknown>;
  timeoutMs?: number;
}

interface Waiting {
  resolve: (answer: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

/**
 * A stream-json session that runs no turn: only control requests, answered by the
 * unmodified CLI with the login it holds. OpenOrc never sees that credential.
 */
export async function withClaudeControlSession<T>(
  launch: Pick<AgentLaunchEnvironment, "binary" | "env">,
  options: ClaudeControlSessionOptions,
  body: (ask: ClaudeControlAsk) => Promise<T>,
): Promise<T> {
  const env = { ...launch.env };
  delete env["CLAUDECODE"];
  const command = launchCommand(launch.binary, [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--setting-sources",
    "user",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
    "--settings",
    JSON.stringify({ disableAllHooks: true, ...options.settings }),
  ]);
  const proc = spawn(command.file, command.args, { ...command.options, cwd: os.homedir(), env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()));
  const output = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  proc.stderr.resume();
  const pending = new Map<string, Waiting>();
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    for (const waiting of pending.values()) waiting.reject(error);
    pending.clear();
  };
  proc.once("error", () => fail(new Error("Claude could not start")));
  proc.once("close", () => fail(new Error(`Claude exited before ${options.task}`)));
  proc.stdin.on("error", () => fail(new Error(`Claude closed the connection while ${options.task}`)));
  output.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message?.type !== "control_response") return;
    const response = message.response ?? {};
    const waiting = pending.get(response.request_id);
    if (!waiting) return;
    pending.delete(response.request_id);
    if (response.subtype === "success") waiting.resolve(response.response !== null && typeof response.response === "object" ? response.response : {});
    else waiting.reject(new Error(typeof response.error === "string" && response.error ? response.error : `Claude refused the request while ${options.task}`));
  });
  const ask: ClaudeControlAsk = (request) =>
    new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      const id = randomUUID();
      pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ type: "control_request", request_id: id, request }) + "\n");
    });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Claude timed out while ${options.task}`)), options.timeoutMs ?? 15_000);
  });
  try {
    return await Promise.race([body(ask), timeout]);
  } finally {
    clearTimeout(timer);
    output.close();
    stopProcess(proc);
    await closed;
    await waitForProcessGroup(proc);
  }
}
