import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { launchCommand } from "../command-launch.js";
import type { AgentLaunchEnvironment } from "../launch-environment.js";

const status = z.object({ isAuthenticated: z.boolean() });
export function cursorAuthenticated(output: string): boolean | null {
  try {
    const read = status.safeParse(JSON.parse(output));
    return read.success ? read.data.isAuthenticated : null;
  } catch {
    return null;
  }
}

/** Cursor's status command checks the existing login without opening a browser. */
export async function assertCursorSignedIn(launch: AgentLaunchEnvironment): Promise<void> {
  const command = launchCommand(launch.binary, ["status", "--format", "json"]);
  const output = await promisify(execFile)(command.file, command.args, { ...command.options, env: { ...launch.env }, timeout: 15_000, maxBuffer: 1024 * 1024 });
  if (cursorAuthenticated(output.stdout) !== true) {
    throw new Error("Sign in to Cursor with cursor-agent login, then rescan the connection in Settings.");
  }
}
