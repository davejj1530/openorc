import { spawn } from "node:child_process";
import { agentBinary } from "../bin.js";
import { launchCommand } from "../command-launch.js";
import { StdioJsonRpc } from "../jsonrpc.js";
import { stopProcess, waitForProcessGroup } from "../process-lifetime.js";

/** A bounded, metadata-only connection; no thread or turn is created. */
export async function withCodexConnection<T>(options: { binary?: string; env?: Readonly<NodeJS.ProcessEnv>; cwd?: string; timeoutMs?: number }, work: (rpc: StdioJsonRpc) => Promise<T>): Promise<T> {
  const command = launchCommand(options.binary ?? agentBinary("codex"), ["app-server", "--listen", "stdio://"]);
  const proc = spawn(command.file, command.args, {
    ...command.options,
    env: options.env ? { ...options.env } : process.env,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()));
  const rpc = new StdioJsonRpc(proc);
  let timer: NodeJS.Timeout | undefined;
  const stopped = new Promise<never>((_, reject) => {
    proc.once("error", () => reject(new Error("Codex could not start")));
    proc.stdin.on("error", () => reject(new Error("Codex connection closed")));
    timer = setTimeout(() => reject(new Error("Codex account or model request timed out")), options.timeoutMs ?? 15_000);
  });
  try {
    return await Promise.race([
      stopped,
      (async () => {
        await rpc.request("initialize", { clientInfo: { name: "openorc", title: "OpenOrc", version: "0.0.0" }, capabilities: null }, 5000);
        rpc.notify("initialized", {});
        return work(rpc);
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    stopProcess(proc);
    await closed;
    await waitForProcessGroup(proc);
  }
}
