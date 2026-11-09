import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchCommand } from "../command-launch.js";
import { inFolder, type AgentLaunchEnvironment } from "../launch-environment.js";
import { stopProcess, waitForProcessGroup } from "../process-lifetime.js";
import { fxCreditsReport, fxUsageReport, type FxCreditsReport, type FxUsageReport } from "./usage-schema.js";

export interface FxUsageOptions extends Partial<Pick<AgentLaunchEnvironment, "binary" | "env">> {
  model?: string;
  timeoutMs?: number;
}
export type FxUsageResult = { status: "ok"; report: FxUsageReport; credits: FxCreditsReport | null } | { status: "unavailable" };

/** Native metadata commands use the saved login, without starting a model or loading a project's configuration. */
export async function readFxUsage(options: FxUsageOptions = {}): Promise<FxUsageResult> {
  let cwd: string | undefined;
  try {
    cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-fx-usage-")));
    const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), FX_AUTO_UPGRADE: "0", FX_SOUND: "0" };
    if (options.model) {
      const separator = options.model.indexOf("/");
      if (separator <= 0 || separator === options.model.length - 1) return { status: "unavailable" };
      env["FX_PROVIDER"] = options.model.slice(0, separator);
      // Native usage startup also requires a model when this connection has none saved.
      env["FX_MODEL"] = options.model.slice(separator + 1);
    }
    const launch = { ...options, env };
    const answer = await usageCommand(launch, cwd, ["usage", "--period", "today", "--json"]);
    const parsed = fxUsageReport.safeParse(answer.payload);
    if (!parsed.success || (!answer.ok && parsed.data.status === "ready")) return { status: "unavailable" };
    let credits: FxCreditsReport | null = null;
    if (parsed.data.source === "ai_gateway" && !["unsupported_provider", "no_gateway_sign_in", "refresh_needed", "refused"].includes(parsed.data.reason ?? "")) {
      const answer = await usageCommand(launch, cwd, ["credits", "--json"]);
      const parsed = fxCreditsReport.safeParse(answer.payload);
      if (answer.ok && parsed.success) credits = parsed.data;
    }
    return { status: "ok", report: parsed.data, credits };
  } catch {
    return { status: "unavailable" };
  } finally {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  }
}

function usageCommand(options: FxUsageOptions, cwd: string, args: string[]): Promise<{ ok: boolean; payload: unknown }> {
  const command = launchCommand(options.binary ?? "fx", args);
  const proc = spawn(command.file, command.args, {
    ...command.options,
    cwd,
    env: inFolder({ ...options.env }, cwd),
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
    const timer = setTimeout(stop, options.timeoutMs ?? 20_000);
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
      void waitForProcessGroup(proc).then(() => {
        let payload: unknown;
        try {
          if (!failed) payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          /* Unstructured CLI output is not a usage report. */
        }
        resolve({ ok: !failed && code === 0, payload });
      }, reject);
    });
  });
}
