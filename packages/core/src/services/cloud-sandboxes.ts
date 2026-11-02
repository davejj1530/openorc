import { threads, type Db } from "@openorc/db";
import type { CloudSandbox } from "@openorc/protocol";
import type { CloudWorkspaceService } from "./cloud-workspaces.js";

/** What the sandbox list needs from runs: whether a conversation's agent is at work, and closing one that is not. */
export interface CloudSandboxRuns {
  threadActivity(threadId: string): "idle" | "running" | "waiting";
  liveRunForThread(threadId: string): { id: string } | null;
  closeAndWait(runId: string): Promise<void>;
}

/** Settings' list of OpenOrc's sandboxes: running ones first, then the newest. */
export class CloudSandboxes {
  constructor(
    private readonly db: Db,
    private readonly cloud: CloudWorkspaceService,
    private readonly runs: CloudSandboxRuns,
  ) {}

  async list(): Promise<CloudSandbox[]> {
    const listed = (await this.cloud.sandboxes()).map(({ threadId, ...sandbox }): CloudSandbox => {
      const thread = threadId ? threads.get(this.db, threadId) : null;
      return { ...sandbox, thread: thread ? { id: thread.id, title: thread.title } : null, working: thread ? this.runs.threadActivity(thread.id) !== "idle" : false };
    });
    return listed.sort((a, b) => Number(b.awakeSince !== null) - Number(a.awakeSince !== null) || b.createdAt - a.createdAt);
  }

  /** Deletes a sandbox. Its conversation's idle agent closes first; one at work keeps it. */
  async remove(name: string): Promise<void> {
    const sandbox = (await this.cloud.sandboxes()).find((candidate) => candidate.name === name);
    if (!sandbox) return;
    const { threadId } = sandbox;
    if (threadId) {
      if (this.runs.threadActivity(threadId) !== "idle") throw new Error("Its conversation's agent is at work there. Stop the turn, then remove the sandbox.");
      const live = this.runs.liveRunForThread(threadId);
      if (live) await this.runs.closeAndWait(live.id);
    }
    await this.cloud.removeSandbox(sandbox.provider, name);
  }
}
