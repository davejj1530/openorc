import path from "node:path";
import { installRunner, runnerFiles, seedWorkspace, type RunnerFile, type SandboxProvider, type WorkspaceLocation } from "@openorc/cloud";
import { cloudWorkspaces, type CloudWorkspaceRecord, type Db } from "@openorc/db";
import { originUrl } from "@openorc/git";
import type { Project, Thread } from "@openorc/protocol";
import type { Logger } from "../transport.js";

export interface CloudWorkspaceOptions {
  provider: SandboxProvider;
  /** Node in the sandbox, which runs OpenOrc's runner. */
  node?: string;
  files?: RunnerFile[];
}

const SETUP_OUTPUT_TAIL = 2000;

/**
 * Sandboxes for cloud conversations. A cloud conversation keeps an ordinary worktree on the Mac, which mirrors the
 * sandbox's checkout; this service opens the sandbox, gives it the worktree's code and runs the project's setup there.
 */
export class CloudWorkspaceService {
  private files: RunnerFile[] | null;

  constructor(
    private readonly db: Db,
    private readonly options: CloudWorkspaceOptions,
    private readonly log: Logger,
  ) {
    this.files = options.files ?? null;
  }

  /** Recorded in the transaction that admits the conversation, before its worktree exists. */
  admit(threadId: string): CloudWorkspaceRecord {
    return cloudWorkspaces.insert(this.db, { threadId, provider: this.options.provider.id, sandbox: `openorc-${threadId}` });
  }

  get(threadId: string): CloudWorkspaceRecord | null {
    return cloudWorkspaces.get(this.db, threadId);
  }

  /** Where the conversation's code lives in its sandbox and on the Mac. */
  async location(record: CloudWorkspaceRecord, mirror: string): Promise<WorkspaceLocation> {
    const sandbox = await this.options.provider.open(record.sandbox);
    this.files ??= runnerFiles();
    const install = await installRunner(sandbox, this.files, this.options.node);
    return { install, repo: path.posix.join(sandbox.root, "repo"), mirror, refPrefix: `refs/openorc/cloud/${record.threadId}/` };
  }

  /**
   * Gives the sandbox the worktree's branch and uncommitted work, then runs the project's setup script there instead
   * of on the Mac. A workspace that is ready is left alone; one that failed is tried again.
   */
  async prepare(thread: Thread, project: Project): Promise<void> {
    const record = cloudWorkspaces.get(this.db, thread.id);
    if (!record || record.state === "ready") return;
    if (!thread.worktreePath || !thread.branch) throw new Error("A cloud conversation needs its worktree before its sandbox.");
    try {
      const location = await this.location(record, thread.worktreePath);
      const mirror = await seedWorkspace(location, thread.branch, (await originUrl(project.rootPath)) ?? undefined);
      if (project.settings.setupScript) await this.runSetup(location, project.settings.setupScript, path.basename(thread.worktreePath));
      cloudWorkspaces.ready(this.db, thread.id, mirror);
      this.log.info(`cloud workspace ${record.sandbox} ready for thread ${thread.id}`);
    } catch (error) {
      cloudWorkspaces.failed(this.db, thread.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async runSetup(location: WorkspaceLocation, script: string, name: string): Promise<void> {
    const { repo } = location;
    const env = { OPENORC_WORKSPACE_PATH: repo, OPENORC_ROOT_PATH: repo, OPENORC_WORKSPACE_NAME: name, OPENORC_CLOUD: "1" };
    const result = await location.install.sandbox.exec("bash", ["-lc", script], { cwd: repo, env });
    if (result.code === 0) return;
    const output = `${result.stdout.toString("utf8")}${result.stderr}`.trim().slice(-SETUP_OUTPUT_TAIL);
    throw new Error(`The setup script failed in the cloud workspace (exit ${result.code ?? "signal"}).${output ? `\n${output}` : ""}`);
  }
}
