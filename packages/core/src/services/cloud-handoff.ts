import { cloudWorkspaces, retiredTeams, threads, type Db } from "@openorc/db";
import { WORKSPACE_ID, type Thread } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import type { CloudSandboxRuns } from "./cloud-sandboxes.js";
import type { CloudWorkspaceService } from "./cloud-workspaces.js";
import { executionProject } from "./workspace-home.js";
import { assertMutableThread } from "./thread-mutations.js";

export interface CloudHandoffDeps {
  db: Db;
  cloud: CloudWorkspaceService;
  runs: CloudSandboxRuns;
  /** Moves a conversation from the checkout to a worktree of its own, with the checkout's uncommitted changes. */
  toWorktree(threadId: string): Promise<Thread>;
  changed(threadId: string): void;
  log: Logger;
}

/**
 * Moves a conversation from this Mac to a sandbox of its own. Its worktree, uncommitted changes and Claude session go
 * there, and its next message runs there; the worktree stays on this Mac and follows the sandbox.
 */
export class CloudHandoff {
  constructor(private readonly deps: CloudHandoffDeps) {}

  /** Refuses, changing nothing, when the conversation cannot move now. */
  private assertMovable(thread: Thread): void {
    assertMutableThread(thread);
    if (cloudWorkspaces.get(this.deps.db, thread.id)) throw new Error("This conversation already runs in the cloud.");
    if (thread.projectId === WORKSPACE_ID) throw new Error("Only a project's conversations can move to the cloud.");
    if (retiredTeams.isHidden(this.deps.db, thread.id)) throw new Error("This conversation is no longer available.");
    if (this.deps.runs.threadActivity(thread.id) !== "idle") throw new Error("Its agent is at work. Stop the turn, then move it.");
  }

  /**
   * A conversation in the checkout first takes the checkout's uncommitted changes to a worktree of its own, as moving it
   * to a worktree does. The sandbox is set up in the background, its steps showing on the conversation; a failure there
   * shows too, and its next message tries again.
   */
  async move(threadId: string): Promise<Thread> {
    let thread = threads.get(this.deps.db, threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found`);
    this.assertMovable(thread);
    const project = executionProject(this.deps.db, thread);
    // Before anything changes: an account that cannot sign in to the sandbox's service is refused here.
    const provider = await this.deps.cloud.place({ agent: thread.agent, claudeAccountId: thread.claudeAccountId ?? undefined, model: thread.model }, project);
    const live = this.deps.runs.liveRunForThread(threadId);
    if (live) await this.deps.runs.closeAndWait(live.id);
    if (thread.workspaceMode === "current") thread = await this.deps.toWorktree(threadId);
    this.deps.cloud.admit(threadId, provider);
    this.deps.changed(threadId);
    const moved = thread;
    void this.deps.cloud.prepare(moved, project).catch((error: unknown) => {
      this.deps.log.warn(`thread ${threadId} did not finish moving to the cloud: ${error instanceof Error ? error.message : String(error)}`);
    });
    return moved;
  }
}
