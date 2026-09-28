import { glob, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkpoints, orchestration, projects, teamRuntime, teamWorkspaces, threads, type Db } from "@openorc/db";
import { git, teamTransfer } from "@openorc/git";
import type { TeamTreeCapture } from "@openorc/protocol";
import { teamWorkspaceLocation } from "./team-workspace-location.js";
import { WorkspaceWriters, type WorkspaceLease } from "./workspace-writers.js";

/** Shared exact-file boundary for independent forks and retained workspace restores. */
export class TeamWorkspaceSnapshots {
  constructor(
    private readonly db: Db,
    private readonly writers: WorkspaceWriters,
  ) {}

  async capture(threadId: string, refPrefix: string, assertCurrent: () => void, lease?: WorkspaceLease): Promise<{ snapshot: TeamTreeCapture; setupInput: TeamTreeCapture | null }> {
    const location = teamWorkspaceLocation(this.db, threadId);
    const thread = threads.get(this.db, threadId)!;
    const project = projects.get(this.db, thread.projectId)!;
    return this.writers.withLease(
      location.path,
      "Capture retained team workspace",
      async () => {
        assertCurrent();
        const snapshot = await teamTransfer.capture(location.path, { refPrefix, trackedTree: location.trackedTree, additionalTrackedTrees: location.additionalTrackedTrees });
        if (snapshot.rootPath !== (await realpath(location.path))) throw new Error("The capture no longer belongs to the current team workspace.");
        const paths = await this.setupPaths(location.path, project.settings.worktreeInclude);
        const setupInput = paths.length ? await teamTransfer.capture(location.path, { refPrefix: `${refPrefix}/setup`, paths }) : null;
        if (JSON.stringify(paths) !== JSON.stringify(await this.setupPaths(location.path, project.settings.worktreeInclude)))
          throw new Error("The declared setup inputs changed while capturing the workspace. Retry with the current files.");
        if (setupInput && (await teamTransfer.listTree(project.rootPath, setupInput.treeSha)).some((entry) => entry.mode === "120000")) throw new Error("Declared setup inputs must be regular files.");
        assertCurrent();
        return { snapshot, setupInput };
      },
      lease,
    );
  }

  /** Older lossy checkpoints cannot prove the full input, including inherited ignored files. */
  async verifiedCheckpoint(
    threadId: string,
    checkpointId: string,
    runId?: string,
  ): Promise<{
    treeSha: string;
    treeRef: string;
    headSha: string;
    headRef: string;
    sourceRunId: string;
  }> {
    const thread = threads.get(this.db, threadId);
    const instance = orchestration.getInstance(this.db, threadId);
    const checkpoint = checkpoints.get(this.db, checkpointId);
    const project = thread && projects.get(this.db, thread.projectId);
    if (!thread || !instance || !project || checkpoint?.threadId !== threadId) throw new Error("The selected checkpoint does not belong to this team.");
    const rows = this.db.stmt("SELECT id FROM team_executions WHERE instance_id=? AND thread_id=? ORDER BY created_at,rowid").all(instance.id, threadId) as { id: string }[];
    const attempts = rows.flatMap((row) => {
      const execution = teamRuntime.get(this.db, row.id)!;
      return execution.attempts
        .filter((attempt) => attempt.actorId === "lead" && attempt.snapshotId === checkpointId && attempt.runId && (!runId || attempt.runId === runId))
        .map((attempt) => ({ execution, attempt }));
    });
    // Unchanged turns share checkpoint IDs; prefer the original turn when present.
    attempts.sort((a, b) => Number(b.attempt.runId === checkpoint.runId) - Number(a.attempt.runId === checkpoint.runId));
    for (const { execution, attempt } of attempts) {
      const binding = teamRuntime.binding(this.db, attempt.runId!);
      const workspace = teamWorkspaces.get(this.db, execution.id, "lead");
      if (!workspace || binding?.executionId !== execution.id || binding.attemptId !== attempt.id || binding.actorId !== "lead") continue;
      const prefix = `refs/openorc/teams/${workspace.id}/checkpoints/`;
      const references = (await git(project.rootPath, ["for-each-ref", "--format=%(refname) %(objectname)", prefix])).stdout
        .trim()
        .split("\n")
        .map((line) => line.split(" "));
      const candidates = references
        .filter(([ref, sha]) => ref?.startsWith(`${prefix}${attempt.runId}-`) && ref.endsWith("/tree") && sha === checkpoint.treeSha)
        .flatMap(([treeRef]) => {
          const head = references.find(([name]) => name === `${treeRef!.slice(0, -4)}head`);
          return head ? [{ treeRef: treeRef!, headRef: head[0]!, headSha: head[1]! }] : [];
        });
      if (!candidates.length) continue;
      if (new Set(candidates.map((item) => item.headSha)).size !== 1) throw new Error("The selected lead turn has an ambiguous exact file checkpoint. Its files were preserved.");
      return { ...candidates[0]!, treeSha: checkpoint.treeSha, sourceRunId: attempt.runId! };
    }
    throw new Error("The selected lead turn has no verified exact file checkpoint. Choose a checkpoint from a newly completed turn.");
  }

  /** Caller holds the destination writer lease until its pointer/receipt transaction completes. */
  async materialize(repository: string, input: { snapshot: TeamTreeCapture; setupInput: TeamTreeCapture | null; path: string; refPrefix: string }, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    await mkdir(path.dirname(input.path), { recursive: true });
    await teamTransfer.materialize(repository, { snapshot: input.snapshot, path: input.path });
    await this.copySetupInput(repository, input.path, input.setupInput);
    const actual = await teamTransfer.capture(input.path, { refPrefix: input.refPrefix, trackedTree: input.snapshot.treeSha });
    if (actual.treeSha !== input.snapshot.treeSha || actual.headSha !== input.snapshot.headSha || actual.branch !== null || (await realpath(input.path)) === (await realpath(repository)))
      throw new Error("The new workspace did not match its retained input. Its files were preserved.");
    assertCurrent();
  }

  private async setupPaths(root: string, patterns: readonly string[]): Promise<string[]> {
    const result = new Set<string>();
    for (const pattern of patterns) {
      for await (const file of glob(pattern, { cwd: root, exclude: (candidate) => candidate.includes("node_modules") || candidate === ".git" || candidate.startsWith(".git/") })) {
        await this.safeSetupPath(root, file);
        if (!(await lstat(path.join(root, file))).isFile()) throw new Error(`Included setup input ${file} must be a regular file.`);
        result.add(file);
      }
    }
    return [...result].sort();
  }

  private async safeSetupPath(root: string, file: string): Promise<void> {
    const parts = file.split("/");
    if (!file || path.isAbsolute(file) || parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git"))
      throw new Error("Declared setup inputs must stay inside their workspace.");
    for (let index = 1; index < parts.length; index++) {
      const ancestor = await lstat(path.join(root, ...parts.slice(0, index))).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (ancestor && !ancestor.isDirectory()) throw new Error(`Setup input ${file} has an unsafe ancestor. Its files were preserved.`);
    }
  }

  private async copySetupInput(repository: string, destination: string, setupInput: TeamTreeCapture | null): Promise<void> {
    if (!setupInput) return;
    for (const entry of await teamTransfer.listTree(repository, setupInput.treeSha)) {
      if (entry.mode === "120000") throw new Error("Declared setup inputs must be regular files.");
      await this.safeSetupPath(destination, entry.path);
      const target = path.join(destination, entry.path);
      const existing = await lstat(target).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      // Captured code wins over setup inputs, just like normal workspace setup.
      if (existing) continue;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await teamTransfer.readBlob(repository, entry.oid), { flag: "wx", mode: entry.mode === "100755" ? 0o755 : 0o644 });
    }
  }
}
