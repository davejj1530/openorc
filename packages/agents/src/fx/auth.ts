import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { z } from "zod";
import type { AgentLaunchEnvironment } from "../launch-environment.js";

const status = z.object({ kind: z.literal("status"), auth: z.string() });
const sources = new Set(["VERCEL_OIDC_TOKEN", "AI_GATEWAY_API_KEY", "fx login", "Codex subscription", "Grok subscription", "configured provider"]);

/** Status inspects the selected connection without opening login or sending a model request. */
export function fxAuthenticated(output: string): boolean | null {
  try {
    const read = status.safeParse(JSON.parse(output));
    if (!read.success) return null;
    if (read.data.auth === "missing") return false;
    return sources.has(read.data.auth) || /^stored API key \([^)]+\)$/.test(read.data.auth) ? true : null;
  } catch {
    return null;
  }
}

export async function assertFxReady(launch: AgentLaunchEnvironment, cwd = launch.env["HOME"] || os.homedir()): Promise<void> {
  const result = await promisify(execFile)(launch.binary, ["status", "--json"], { cwd, env: { ...launch.env, FX_AUTO_UPGRADE: "0" }, timeout: 8000, maxBuffer: 1024 * 1024 });
  if (fxAuthenticated(result.stdout) !== true) throw new Error("Connect a provider with fx login or fx setup, then rescan in Settings → Connections.");
}
