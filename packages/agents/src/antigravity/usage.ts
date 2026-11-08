import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { launchCommand } from "../command-launch.js";
import { inFolder, type AgentLaunchEnvironment } from "../launch-environment.js";
import { stopProcess, waitForProcessGroup } from "../process-lifetime.js";

const name = z.string().trim().min(1).max(160);
const bucket = z.object({
  id: name,
  name,
  remaining_fraction: z.number().min(0).max(1).nullish().catch(null),
  reset_time: z.iso.datetime({ offset: true }).nullish().catch(null),
});
const report = z.object({
  status: z.literal("SUCCESS"),
  num_turns: z.literal(0),
  command: z.object({ name: z.literal("usage"), data: z.object({ groups: z.array(z.object({ name, buckets: z.array(bucket) })) }) }),
});
const failure = z.object({ status: z.literal("ERROR"), error: z.string() });

export type AntigravityQuotaGroup = z.infer<typeof report>["command"]["data"]["groups"][number];
export type AntigravityUsageResult = { status: "ok"; groups: AntigravityQuotaGroup[] } | { status: "unsupported" | "disconnected" | "unavailable" };
export interface AntigravityUsageOptions extends Partial<Pick<AgentLaunchEnvironment, "binary" | "env">> {
  timeoutMs?: number;
}

/** The native /usage command returns structured quotas without creating a conversation or running a model turn. */
export async function readAntigravityUsage(options: AntigravityUsageOptions = {}): Promise<AntigravityUsageResult> {
  const env = options.env ?? process.env;
  // ACP chooses this key over the cached Google login. Its API quotas belong to a different account.
  if (env["GEMINI_API_KEY"]?.trim()) return { status: "unsupported" };
  let cwd: string | undefined;
  try {
    cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-antigravity-usage-")));
    const answer = await quotaCommand({ ...options, env }, cwd);
    const payload: unknown = JSON.parse(answer.stdout);
    const parsed = report.safeParse(payload);
    if (answer.ok && parsed.success) return { status: "ok", groups: parsed.data.command.data.groups };
    const failed = failure.safeParse(payload);
    if (failed.success && /authentication (?:required|failed)|not signed in/i.test(failed.data.error)) return { status: "disconnected" };
    return { status: "unavailable" };
  } catch {
    // Neither process output nor provider errors may expose credentials or local paths to the UI.
    return { status: "unavailable" };
  } finally {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  }
}

/** Bounded output and lifetime, with no terminal or stdin for an interactive login. */
function quotaCommand(options: AntigravityUsageOptions, cwd: string): Promise<{ ok: boolean; stdout: string }> {
  const command = launchCommand(options.binary ?? "agy", ["--print", "/usage", "--output-format", "json", "--print-timeout", "20s", "--settings", JSON.stringify({ useG1Credits: false })]);
  const proc = spawn(command.file, command.args, {
    ...command.options,
    cwd,
    env: inFolder({ ...(options.env ?? process.env) }, cwd),
    stdio: ["pipe", "pipe", "ignore"],
    detached: process.platform !== "win32",
  });
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const stop = () => {
      failed = true;
      stopProcess(proc);
    };
    const timer = setTimeout(stop, options.timeoutMs ?? 25_000);
    proc.stdin.on("error", () => {
      failed = true;
    });
    proc.stdin.end();
    proc.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) stop();
      else chunks.push(chunk);
    });
    proc.once("error", () => {
      failed = true;
    });
    proc.once("close", (code) => {
      clearTimeout(timer);
      stopProcess(proc);
      void waitForProcessGroup(proc).then(() => resolve({ ok: !failed && code === 0, stdout: Buffer.concat(chunks).toString("utf8") }), reject);
    });
  });
}
