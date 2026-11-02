import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentHost } from "@openorc/agents";
import type { RunnerClient, WorkspaceLocation } from "@openorc/cloud";

/**
 * A cloud workspace as the place a provider's CLI runs. Processes start through the runner, files the CLI reads go to
 * the runner's own folder in the VM, and addresses on the Mac are reached through the runner's relay on the VM's loopback.
 */
export function cloudAgentHost(client: RunnerClient, location: WorkspaceLocation, relayPort: number): AgentHost {
  const { install } = location;
  return {
    home: client.home,
    privateDir: (runId) => path.posix.join(install.state, "runs", runId),
    localUrl: (url) => {
      const target = new URL(url);
      return `http://127.0.0.1:${relayPort}${target.pathname}${target.search}`;
    },
    // The runner's process is shaped like a child process; the adapters use only that shape.
    spawn: (binary, args, { runId, cwd, env, files, dirs }) => client.spawn(runId, { cmd: binary, args, cwd, env, files, dirs }) as unknown as ChildProcessWithoutNullStreams,
    upload: (paths) =>
      Promise.all(
        paths.map(async (file) => {
          const target = path.posix.join(install.state, "attachments", `${createHash("sha256").update(file).digest("hex").slice(0, 12)}-${path.basename(file)}`);
          await install.sandbox.writeFile(target, await readFile(file));
          return target;
        }),
      ),
  };
}
