import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, glob, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { audit, taskForwardings, tasks, threads, type Db } from "@openorc/db";
import { stopProcess, waitForProcessGroup } from "@openorc/agents";
import { diskUsage, emptyTree, fetch, git, repoInfo, revParse, worktree } from "@openorc/git";
import { WORKSPACE_ID, type BranchLoss, type Project, type RemovalImpact, type Task, type Thread } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import { assertCanBranch, projectGit } from "./project-git.js";
import { inUnvettedCopy } from "./review-copies.js";
import { assertSafeParentPath } from "./safe-parent-path.js";
import { workspaceWriters, type WorkspaceLease, type WorkspaceWriters } from "./workspace-writers.js";

export interface WorkspaceOptions {
  /** Where worktrees live: `<dataDir>/worktrees/<project>/<task>`. Outside the repo on purpose. */
  dataDir: string;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Refuses to delete a branch whose only-copy work exceeds what the user confirmed losing, and says what that work is. */
export function assertLossAccepted(loss: RemovalImpact, accepted: BranchLoss | undefined): void {
  if (loss.uncommitted <= (accepted?.uncommitted ?? 0) && loss.commits <= (accepted?.commits ?? 0)) return;
  const parts = [
    loss.uncommitted ? `${plural(loss.uncommitted, "uncommitted file")} in its worktree` : null,
    loss.commits ? `${plural(loss.commits, "commit")} that no other branch, remote or tag has` : null,
  ].filter(Boolean);
  throw new Error(`Deleting branch ${loss.branch} would delete ${parts.join(" and ")}. Confirm to delete them, or keep the branch.`);
}

/**
 * Where work in the project folder starts: HEAD and its branch. `start` is HEAD, or the empty tree while nothing is
 * committed, a folder without git included, so a thread's first turn keeps a comparison that a later `git init` or
 * commit never replaces. Tasks keep HEAD alone: their commit list and base need a commit.
 */
async function checkoutStart(project: Project): Promise<{ headSha: string | null; start: string; branch: string | null }> {
  if ((await projectGit(project)) === "none") return { headSha: null, start: await emptyTree(project.rootPath), branch: null };
  const info = await repoInfo(project.rootPath);
  return { headSha: info.headSha, start: info.headSha ?? (await emptyTree(project.rootPath)), branch: info.branch };
}

/**
 * Whether the project folder is a repository of its own, so git housekeeping may run there. Workspace and a folder
 * without git are not, and a plain folder can sit inside another repository that must stay untouched.
 */
async function ownsRepository(project: Project): Promise<boolean> {
  return (await projectGit(project).catch(() => "none" as const)) !== "none";
}

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task"
  );
}

/** Ten ports per task, deterministic, in a range unlikely to collide with dev servers. */
export function portBlockFor(taskId: string): number {
  const h = createHash("sha1").update(taskId).digest();
  const n = h.readUInt32BE(0) % 3000;
  return 20_000 + n * 10;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Makes a task's workspace real: a worktree on its own branch from a fresh
 * base, gitignored files copied in, the setup script run to completion
 * before any agent starts. Idempotent.
 */
export class WorkspaceService {
  private readonly preparingTasks = new Map<string, Promise<Task>>();
  private readonly preparingThreads = new Map<string, Promise<Thread>>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly setups = new Map<ChildProcess, Promise<void>>();
  private closing = false;

  constructor(
    private readonly db: Db,
    private readonly options: WorkspaceOptions,
    private readonly log: Logger,
    private readonly writers: WorkspaceWriters = workspaceWriters,
  ) {}

  private assertOpen(): void {
    if (this.closing) throw new Error("Workspace preparation is shutting down.");
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    );
    return operation;
  }

  private stopSetup(child: ChildProcess): void {
    try {
      stopProcess(child);
    } catch (error) {
      this.log.warn(`could not stop workspace setup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** A timeout preserves the active reservations; the host must keep its database open. */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    this.closing = true;
    for (const child of this.setups.keys()) this.stopSetup(child);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.operations, ...this.setups.values()]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Workspace preparation is still shutting down. Keep the database open and retry after its setup processes and pending operations finish.")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  taskPath(task: Task, project: Project): string {
    if (task.workspaceMode === "current") return project.rootPath;
    return task.worktreePath ?? path.join(this.options.dataDir, "worktrees", `${slugify(project.name)}-${project.id.slice(0, 6)}`, `${slugify(task.title)}-${task.id.slice(0, 6)}`);
  }

  threadPath(thread: Pick<Thread, "id" | "title" | "workspaceMode" | "worktreePath">, project: Project): string {
    if (thread.workspaceMode === "current") return project.rootPath;
    return thread.worktreePath ?? path.join(this.options.dataDir, "worktrees", `${slugify(project.name)}-${project.id.slice(0, 6)}`, `thread-${slugify(thread.title)}-${thread.id.slice(0, 6)}`);
  }

  /** OpenOrc's data folder, where worktrees and scratch copies live. */
  get dataDir(): string {
    return this.options.dataDir;
  }

  /** The branch a worktree for this conversation works on. */
  threadBranch(thread: Pick<Thread, "id" | "title" | "branch">, project: Project): string {
    return thread.branch ?? `${project.settings.branchPrefix}/${slugify(thread.title)}-${thread.id.slice(0, 6)}`;
  }

  async prepare(task: Task, project: Project, lease?: WorkspaceLease): Promise<Task> {
    this.assertOpen();
    // Review panels can request diffs and history together before either has
    // created the workspace. Share preparation through setup completion.
    const pending = this.preparingTasks.get(task.id);
    if (pending) return pending;
    const preparation = this.prepareTask(task, project, lease).finally(() => this.preparingTasks.delete(task.id));
    this.preparingTasks.set(task.id, preparation);
    return this.track(preparation);
  }

  private async prepareTask(task: Task, project: Project, inherited?: WorkspaceLease): Promise<Task> {
    this.assertOpen();
    if (taskForwardings.target(this.db, task.id)?.state === "preparing") throw new Error("Finish this task’s saved handoff before preparing its workspace.");
    // A caller can retain the old row after an earlier preparation finishes.
    task = tasks.get(this.db, task.id) ?? task;
    if (project.id === WORKSPACE_ID) {
      if (task.workspaceMode !== "current") throw new Error("Workspace tasks use their conversation folder.");
      return task;
    }
    if (task.workspaceMode === "current" && task.baseSha) return task;
    if (task.workspaceMode === "worktree" && task.worktreePath && (await exists(task.worktreePath))) {
      this.assertOpen();
      return task;
    }
    return this.writers.withLease(
      this.taskPath(task, project),
      `preparing task ${task.id}`,
      async () => {
        this.assertOpen();
        if (task.workspaceMode === "current") {
          const info = await checkoutStart(project);
          this.assertOpen();
          return tasks.update(this.db, task.id, { baseSha: info.headSha, baseRef: info.branch ?? task.baseRef, branch: info.branch });
        }

        const shortId = task.id.slice(0, 6);
        const slug = slugify(task.title);
        const branch = task.branch ?? `${project.settings.branchPrefix}/${slug}-${shortId}`;
        const worktreePath = this.taskPath(task, project);
        await mkdir(path.dirname(worktreePath), { recursive: true });
        this.assertOpen();

        const baseRef = task.baseRef ?? project.defaultBranch ?? "HEAD";
        const startPoint = await this.resolveStartPoint(project, baseRef);
        this.assertOpen();
        this.log.info(`worktree for "${task.title}" at ${worktreePath} on ${branch} from ${baseRef} (${startPoint.slice(0, 8)})`);
        await worktree.add(project.rootPath, { path: worktreePath, branch, startPoint });
        this.assertOpen();

        const copied = await this.copyIncludes(project, worktreePath);
        this.assertOpen();
        if (copied.length > 0) this.log.info(`copied ${copied.length} gitignored file(s): ${copied.join(", ")}`);
        await this.initSubmodules(worktreePath);
        this.assertOpen();
        await this.warnAboutHusky(worktreePath, project);
        this.assertOpen();

        const updated = tasks.update(this.db, task.id, { worktreePath, branch, baseRef, baseSha: startPoint, status: task.status === "backlog" ? "in_progress" : task.status });
        audit.record(this.db, { actor: "openorc", action: "workspace.create", resourceType: "task", resourceId: task.id, metadata: { worktreePath, branch, baseSha: startPoint } });

        if (project.settings.setupScript) {
          await this.runSetup(project, updated);
        }
        this.assertOpen();
        return updated;
      },
      inherited,
    );
  }

  /**
   * A worktree of a thread's own, so two threads on one project never step
   * on each other. Same recipe as a task's: fresh base, includes, setup.
   */
  async prepareThread(thread: Thread, project: Project, baseRef?: string, lease?: WorkspaceLease): Promise<Thread> {
    this.assertOpen();
    const pending = this.preparingThreads.get(thread.id);
    if (pending) return pending;
    const preparation = this.prepareThreadWorkspace(thread, project, baseRef, lease).finally(() => this.preparingThreads.delete(thread.id));
    this.preparingThreads.set(thread.id, preparation);
    return this.track(preparation);
  }

  private async prepareThreadWorkspace(thread: Thread, project: Project, baseRef?: string, inherited?: WorkspaceLease): Promise<Thread> {
    this.assertOpen();
    if (project.id === WORKSPACE_ID) {
      if (thread.workspaceMode !== "current") throw new Error("Workspace conversations use their selected folder.");
      return thread;
    }
    if (thread.workspaceMode === "current" && thread.baseSha) return thread;
    if (thread.workspaceMode === "worktree" && thread.worktreePath && (await exists(thread.worktreePath))) {
      this.assertOpen();
      return thread;
    }
    // Only reviewing again rebuilds a pull request's copy, on no branch. An ordinary worktree here would take a branch
    // that keeps the pull request's code out of isolation once the next round checks it out.
    if (inUnvettedCopy(this.db, thread)) throw new Error("This review's copy of the pull request is gone. Review it again from the Pull requests tab.");
    return this.writers.withLease(
      this.threadPath(thread, project),
      `preparing thread ${thread.id}`,
      async () => {
        this.assertOpen();
        if (thread.workspaceMode === "current") {
          const info = await checkoutStart(project);
          this.assertOpen();
          return threads.update(this.db, thread.id, { baseSha: info.start, branch: info.branch });
        }

        const branch = this.threadBranch(thread, project);
        const worktreePath = this.threadPath(thread, project);
        await mkdir(path.dirname(worktreePath), { recursive: true });
        this.assertOpen();
        const base = baseRef ?? project.defaultBranch ?? "HEAD";
        const startPoint = await this.resolveStartPoint(project, base);
        this.assertOpen();
        this.log.info(`worktree for thread "${thread.title}" at ${worktreePath} on ${branch} from ${base} (${startPoint.slice(0, 8)})`);
        await worktree.add(project.rootPath, { path: worktreePath, branch, startPoint });
        this.assertOpen();
        await this.copyIncludes(project, worktreePath);
        this.assertOpen();
        await this.initSubmodules(worktreePath);
        this.assertOpen();
        await this.warnAboutHusky(worktreePath, project);
        this.assertOpen();
        const baseBranch = thread.baseBranch ?? (await this.startBranch(project, base));
        this.assertOpen();
        const updated = threads.update(this.db, thread.id, { worktreePath, branch, baseSha: thread.baseSha ?? startPoint, baseBranch, workspaceMode: "worktree" });
        audit.record(this.db, { actor: "openorc", action: "workspace.create", resourceType: "thread", resourceId: thread.id, metadata: { worktreePath, branch, baseSha: startPoint } });
        if (project.settings.setupScript) await this.runSetup(project, { worktreePath, id: thread.id });
        this.assertOpen();
        return updated;
      },
      inherited,
    );
  }

  /**
   * Removes a thread's worktree; its branch always stays. Uncommitted work is committed to that branch first, unless
   * `save` is false because the caller already took the changes elsewhere.
   */
  async cleanupThread(thread: Thread, project: Project, options: { save?: boolean } = {}, inherited?: WorkspaceLease): Promise<Thread> {
    this.assertOpen();
    if (project.id === WORKSPACE_ID) return thread;
    // A legacy task promoted to a conversation retains this workspace for its saved review history.
    if (thread.worktreePath && tasks.list(this.db, { projectId: project.id }).some((task) => task.worktreePath === thread.worktreePath))
      return threads.update(this.db, thread.id, { worktreePath: null });
    return this.track(
      this.writers.withLease(
        this.threadPath(thread, project),
        `removing thread workspace ${thread.id}`,
        async () => {
          this.assertOpen();
          let saved: string | null = null;
          if (thread.worktreePath && (await exists(thread.worktreePath))) {
            this.assertOpen();
            if (options.save ?? true) saved = await this.saveChanges(thread.worktreePath);
            await worktree.remove(project.rootPath, thread.worktreePath, { force: true });
            this.assertOpen();
            this.log.info(`removed worktree ${thread.worktreePath}`);
          }
          this.assertOpen();
          await worktree.prune(project.rootPath).catch(() => undefined);
          this.assertOpen();
          audit.record(this.db, { actor: "user", action: "workspace.cleanup", resourceType: "thread", resourceId: thread.id, metadata: { deleteBranch: false, saved } });
          return threads.update(this.db, thread.id, { worktreePath: null });
        },
        inherited,
      ),
    );
  }

  /**
   * Removes the worktree (and optionally the branch). The ledger keeps the task's history, and uncommitted work is
   * committed to a branch that stays first, so removing a worktree to free disk loses nothing.
   */
  /**
   * What deleting a task's branch would lose: uncommitted files in its worktree, and commits no other branch, remote
   * branch or tag holds. Removing the worktree alone loses neither, because its changes are committed first.
   */
  async removalImpact(task: Task, project: Project): Promise<RemovalImpact> {
    const branch = task.workspaceMode === "worktree" && task.branch && project.id !== WORKSPACE_ID ? task.branch : null;
    if (!branch || !(await worktree.branchTip(project.rootPath, branch))) return { branch: null, uncommitted: 0, commits: 0 };
    const uncommitted = task.worktreePath && (await exists(task.worktreePath)) ? (await git(task.worktreePath, ["status", "--porcelain"])).stdout.split("\n").filter(Boolean).length : 0;
    return { branch, uncommitted, commits: await worktree.commitsOnlyOn(project.rootPath, branch) };
  }

  async cleanup(task: Task, project: Project, options: { deleteBranch?: boolean; force?: boolean; acceptLoss?: BranchLoss } = {}, inherited?: WorkspaceLease): Promise<Task> {
    this.assertOpen();
    if (!(await ownsRepository(project))) return task;
    // Deleting/archiving a task record must not remove a conversation's workspace.
    if (task.worktreePath && threads.list(this.db, { projectId: project.id, filter: "all" }).some((thread) => thread.worktreePath === task.worktreePath)) return task;
    if ((taskForwardings.target(this.db, task.id) ?? taskForwardings.source(this.db, task.id))?.state === "preparing")
      throw new Error("Finish this task’s saved handoff before removing its workspace.");
    return this.track(
      this.writers.withLease(
        this.taskPath(task, project),
        `removing task workspace ${task.id}`,
        async () => {
          this.assertOpen();
          // Checked under the lease, so nothing can land on the branch between the check and the delete.
          const loss = options.deleteBranch ? await this.removalImpact(task, project) : null;
          const tip = loss?.branch ? await worktree.branchTip(project.rootPath, loss.branch) : null;
          if (loss) assertLossAccepted(loss, options.acceptLoss);
          this.assertOpen();
          let saved: string | null = null;
          if (task.worktreePath && (await exists(task.worktreePath))) {
            this.assertOpen();
            if (!options.deleteBranch) saved = await this.saveChanges(task.worktreePath);
            await worktree.remove(project.rootPath, task.worktreePath, { force: options.force ?? true });
            this.assertOpen();
            this.log.info(`removed worktree ${task.worktreePath}`);
          }
          this.assertOpen();
          await worktree.prune(project.rootPath).catch(() => undefined);
          this.assertOpen();
          if (loss?.branch && tip) {
            await worktree.deleteBranchAt(project.rootPath, loss.branch, tip).catch((e: unknown) => this.log.warn(`branch ${loss.branch} not deleted: ${e instanceof Error ? e.message : String(e)}`));
            this.assertOpen();
          }
          audit.record(this.db, { actor: "user", action: "workspace.cleanup", resourceType: "task", resourceId: task.id, metadata: { deleteBranch: Boolean(options.deleteBranch), saved } });
          return tasks.update(this.db, task.id, { worktreePath: null, ...(options.deleteBranch ? { branch: null } : {}) });
        },
        inherited,
      ),
    );
  }

  /** Commits what a worktree has not, before it is removed. A failure keeps the worktree: nothing is removed unsaved. */
  private async saveChanges(worktreePath: string): Promise<string | null> {
    const saved = await worktree.saveChanges(worktreePath, "Save uncommitted work before removing the worktree");
    this.assertOpen();
    if (saved) this.log.info(`saved ${saved.paths} uncommitted path(s) as ${saved.sha.slice(0, 7)} before removing ${worktreePath}`);
    return saved?.sha ?? null;
  }

  async usage(task: Task): Promise<number> {
    if (!task.worktreePath || !(await exists(task.worktreePath))) return 0;
    return diskUsage(task.worktreePath);
  }

  /** `git worktree add` leaves submodules empty; init them so the agent sees a whole tree. */
  private async initSubmodules(worktreePath: string): Promise<void> {
    this.assertOpen();
    if (!(await exists(path.join(worktreePath, ".gitmodules")))) return;
    this.assertOpen();
    this.log.info("initialising submodules");
    try {
      await git(worktreePath, ["submodule", "update", "--init", "--recursive"], { timeoutMs: 300_000 });
    } catch (e) {
      this.log.warn(`submodule init failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.assertOpen();
  }

  /** Husky hooks run in every worktree and fail without node_modules; say so before a commit does. */
  private async warnAboutHusky(worktreePath: string, project: Project): Promise<void> {
    this.assertOpen();
    if (!(await exists(path.join(worktreePath, ".husky")))) return;
    this.assertOpen();
    if (project.settings.setupScript) return;
    this.log.warn("this repo uses husky; commits in the worktree will fail until dependencies are installed. Add an install step to the project's setup script.");
  }

  /** The branch a worktree starts from by name, `HEAD` being whatever the checkout is on. Null for a commit or a detached checkout. */
  private async startBranch(project: Project, baseRef: string): Promise<string | null> {
    if (baseRef !== "HEAD") return /^[0-9a-f]{40,64}$/.test(baseRef) ? null : baseRef;
    return (await git(project.rootPath, ["symbolic-ref", "--short", "-q", "HEAD"], { okCodes: [0, 1] })).stdout.trim() || null;
  }

  /** Fetches the base from origin when it is a branch there, so tasks start from what the team sees. */
  private async resolveStartPoint(project: Project, baseRef: string): Promise<string> {
    this.assertOpen();
    await assertCanBranch(project);
    this.assertOpen();
    const root = project.rootPath;
    if (baseRef === "HEAD") return revParse(root, "HEAD");
    const fetched = await fetch(root, "origin", baseRef);
    this.assertOpen();
    if (fetched) {
      try {
        return await revParse(root, `origin/${baseRef}`);
      } catch {
        this.assertOpen();
        // fall through to the local ref
      }
    }
    return revParse(root, baseRef);
  }

  private async copyIncludes(project: Project, worktreePath: string): Promise<string[]> {
    this.assertOpen();
    const copied: string[] = [];
    const sourceDirectories = new Map<string, string>();
    const destinationDirectories = new Map<string, string>();
    for (const pattern of project.settings.worktreeInclude) {
      for await (const rel of glob(pattern, { cwd: project.rootPath, exclude: (p) => p.includes("node_modules") || p.startsWith(".git/") })) {
        this.assertOpen();
        try {
          await copyIncludedFile(project.rootPath, worktreePath, rel, sourceDirectories, destinationDirectories);
          this.assertOpen();
          copied.push(rel);
        } catch (e) {
          this.assertOpen();
          this.log.warn(`could not copy ${rel}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    return copied;
  }

  /** Blocks until the setup script exits. A failing script fails the workspace, never a silent race. */
  private runSetup(project: Project, task: { worktreePath: string | null; id: string }): Promise<void> {
    this.assertOpen();
    const script = project.settings.setupScript;
    const cwd = task.worktreePath;
    if (!script || !cwd) return Promise.resolve();
    this.log.info(`running setup script in ${cwd}`);
    const child = spawn("/bin/bash", ["-lc", script], {
      cwd,
      env: {
        ...process.env,
        OPENORC_WORKSPACE_PATH: cwd,
        OPENORC_ROOT_PATH: project.rootPath,
        OPENORC_WORKSPACE_NAME: path.basename(cwd),
        OPENORC_PORT: String(portBlockFor(task.id)),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const completion = new Promise<void>((resolve, reject) => {
      const tail: string[] = [];
      const keep = (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (!line) continue;
          tail.push(line);
          if (tail.length > 40) tail.shift();
          this.log.info(`[setup] ${line}`);
        }
      };
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      let spawnError: Error | null = null;
      child.on("error", (error) => {
        spawnError = error;
      });
      child.once("exit", () => this.stopSetup(child));
      // close follows exit and stream drainage; descendants can still own the pipes after exit.
      child.once("close", (code) => {
        void waitForProcessGroup(child).then(() => {
          this.setups.delete(child);
          if (this.closing) reject(new Error("Workspace preparation is shutting down."));
          else if (spawnError) reject(spawnError);
          else if (code === 0) resolve();
          else reject(new Error(`setup script exited with ${code}:\n${tail.join("\n")}`));
        }, reject);
      });
    });
    this.setups.set(child, completion);
    return completion;
  }
}

/**
 * Copies one include match from the checkout into a new worktree. Both paths must stay inside
 * their roots with no symlinked parents, and the source must be a regular file, so a pattern
 * such as `../secret` or a link to another folder can neither read nor write outside the repo.
 */
async function copyIncludedFile(source: string, destination: string, file: string, sourceDirectories: Map<string, string>, destinationDirectories: Map<string, string>): Promise<void> {
  await assertSafeParentPath(source, file, sourceDirectories);
  await assertSafeParentPath(destination, file, destinationDirectories);
  const from = path.join(source, file);
  const to = path.join(destination, file);
  if (!(await lstat(from)).isFile()) throw new Error("not a regular file");
  if ((await lstat(to).catch(() => null))?.isSymbolicLink()) throw new Error("the worktree already has a link at that path");
  await mkdir(path.dirname(to), { recursive: true });
  await assertSafeParentPath(source, file, sourceDirectories);
  await assertSafeParentPath(destination, file, destinationDirectories);
  await copyFile(from, to);
}
