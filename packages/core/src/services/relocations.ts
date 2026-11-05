import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrainControlResults } from "@openorc/cloud";
import {
  claudeAccounts,
  deleteThreadRows,
  frozenMoving,
  projects,
  readThreadRows,
  relocations,
  runs as runRows,
  threadTaskIds,
  threads,
  writeThreadRows,
  type CloudProviderId,
  type Db,
  type LedgerWriter,
} from "@openorc/db";
import { git } from "@openorc/git";
import { type Brain, type Project, type Thread, type ThreadMoving } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import type { CloudSessions } from "./cloud-sessions.js";
import type { CloudWorkspaceService } from "./cloud-workspaces.js";
import { decodePackage, encodePackage, LacksBase, packThread, RelocationRefused, retireCode, takeCode, takeFiles, type RelocationPackage } from "./relocation-package.js";
import { AT_WORK, relocationRefusal } from "./relocation-rules.js";
import { executionProject } from "./workspace-home.js";

const CALLED_OFF = "This move was called off.";
const words = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** The outbox file of a relocation's package. */
export const packageFile = (relocation: string) => `${relocation}.thread`;

export interface RelocationDeps {
  db: Db;
  dataDir: string;
  ledger: Pick<LedgerWriter, "flush" | "forget">;
  sessions: Pick<CloudSessions, "export" | "import">;
  /** Where a worktree of the thread's own lives in the project, as WorkspaceService names it. */
  threadPath(thread: Pick<Thread, "id" | "title" | "workspaceMode" | "worktreePath">, project: Project): string;
  cloud: Pick<CloudWorkspaceService, "place" | "admit" | "prepare" | "get" | "sync" | "removeSandbox">;
  runs: { threadActivity(threadId: string): "idle" | "running" | "waiting"; liveRunForThread(threadId: string): { id: string } | null; closeAndWait(runId: string): Promise<void> };
  changed(threadId: string): void;
  /** Delivers queued messages, a taken thread's among them. */
  drain(): void;
  log: Logger;
}

/** What a source still has to clean once it let its copy go. */
interface Cleanup {
  threadId: string;
  root: string;
  worktree: string | null;
  sandbox: { provider: CloudProviderId; name: string } | null;
}

/** Where a taken thread lands, and what this host's journal records in the transaction that takes it. */
export interface TakeTarget {
  /** This host's project for the package's Mac project; null refuses the package. */
  projectId: (macProject: string) => string | null;
  /** "cloud": the thread runs in a sandbox of its own from now on, as every thread on the brain does. */
  place: "cloud" | "here";
  commit: () => void;
}

/**
 * Moves threads between the Mac and the cloud brain: the same class on both, since both run the same core. The source
 * freezes the thread and packs it; the target's one transaction (rows plus its journal row) is the commit point.
 */
export class ThreadRelocations {
  constructor(private readonly deps: RelocationDeps) {}

  /** The thread's frozen state on this host, or null. */
  frozen(threadId: string): ThreadMoving | null {
    return frozenMoving(this.deps.db, threadId);
  }

  /** The thread as one package's bytes, read after the ledger's last events are written. */
  async pack(relocation: string, threadId: string, options: { from: Brain; macProject: string; since: readonly string[] }): Promise<Buffer> {
    return encodePackage(await this.packed(relocation, threadId, options));
  }

  private async packed(relocation: string, threadId: string, options: { from: Brain; macProject: string; since: readonly string[] }): Promise<RelocationPackage> {
    const { db, dataDir } = this.deps;
    const thread = threads.get(db, threadId);
    if (!thread) throw new RelocationRefused("That conversation is gone.");
    this.deps.ledger.flush();
    return packThread({
      relocation,
      from: options.from,
      macProject: options.macProject,
      dataDir,
      root: executionProject(db, thread).rootPath,
      rows: () => readThreadRows(db, threadId),
      thread,
      tasks: threadTaskIds(db, threadId),
      session: await this.deps.sessions.export(thread),
      since: options.since,
    });
  }

  /**
   * Takes a package into this host. Everything before the transaction is idempotent and keyed by the thread id: the code
   * in a worktree of its own, the files, the session where the agent looks for it. Then one transaction writes the
   * rows and this host's journal row, and on the brain admits it as a cloud thread. A thread this ledger holds already
   * was taken before: nothing is written again.
   */
  async take(bytes: Buffer, target: TakeTarget): Promise<"taken" | "already"> {
    const pkg = decodePackage(bytes);
    const { db, dataDir } = this.deps;
    const threadId = pkg.rows.threadId;
    if (threads.get(db, threadId)) return "already";
    const projectId = target.projectId(pkg.macProject);
    const project = projectId ? projects.get(db, projectId) : null;
    if (!project) throw new RelocationRefused("This conversation's project is not on this side. Switch it on for the cloud brain in Settings > Cloud.");
    const root = pkg.rows.tables.threads[0] as { title: string; agent: string; claude_account_id: string | null } | undefined;
    if (!root || root.agent !== "claude") throw new RelocationRefused("Only Claude conversations can move between brains so far.");
    const accountId = root.claude_account_id ?? claudeAccounts.defaultId(db);
    if (!claudeAccounts.list(db).some((account) => account.id === accountId)) throw new RelocationRefused("Its Claude account is not here.");
    const provider = target.place === "cloud" ? await this.deps.cloud.place({ agent: "claude", claudeAccountId: accountId }, project) : null;
    const folder = this.deps.threadPath({ id: threadId, title: root.title, workspaceMode: "worktree", worktreePath: null }, project);
    await takeCode(project.rootPath, threadId, pkg.code, folder);
    await takeFiles(dataDir, pkg.files);
    if (pkg.session) await this.deps.sessions.import({ id: threadId, worktreePath: folder } as Thread & { worktreePath: string }, pkg.session);
    this.deps.ledger.forget(pkg.rows.tables.runs.map((run) => String(run.id)));
    db.transaction(() => {
      writeThreadRows(db, pkg.rows, {
        projectId: project.id,
        paths: [
          { from: pkg.worktree, to: folder },
          { from: pkg.dataDir, to: dataDir },
        ],
      });
      target.commit();
      if (provider) this.deps.cloud.admit(threadId, provider);
    });
    this.deps.changed(threadId);
    const thread = threads.get(db, threadId)!;
    if (provider)
      void this.deps.cloud.prepare(thread, project).catch((error: unknown) => {
        this.deps.log.warn(`thread ${threadId} arrived, but its sandbox is not ready: ${error instanceof Error ? error.message : String(error)}`);
      });
    // Messages queued before it moved go on here; a cloud thread's wait for its sandbox.
    this.deps.drain();
    return "taken";
  }

  /**
   * The source lets its copy go once the target holds the thread: its rows deleted in one transaction with `settle` and
   * a note of what is left to clean, then its sandbox deleted and its worktree retired (its last state pinned). A crash
   * between the two is cleaned at the next `cleanUp`.
   */
  async letGo(relocation: string, threadId: string, settle: () => void, between?: () => void): Promise<void> {
    const { db } = this.deps;
    const thread = threads.get(db, threadId);
    const runIds = runRows.listForThread(db, threadId).map((run) => run.id);
    const sandbox = thread ? this.deps.cloud.get(threadId) : null;
    const cleanup: Cleanup | null = thread
      ? { threadId, root: executionProject(db, thread).rootPath, worktree: thread.worktreePath, sandbox: sandbox ? { provider: sandbox.provider, name: sandbox.sandbox } : null }
      : null;
    db.transaction(() => {
      if (thread) deleteThreadRows(db, threadId);
      settle();
      if (cleanup) relocations.setCleanup(db, relocation, JSON.stringify(cleanup));
    });
    this.deps.ledger.forget(runIds);
    this.deps.changed(threadId);
    between?.();
    await this.cleanUp(relocation);
  }

  /** The cleaning a relocation's source still owes, done and cleared. Safe to repeat. */
  async cleanUp(relocation: string): Promise<void> {
    const note = relocations.cleanup(this.deps.db, relocation);
    if (!note) return;
    const { threadId, root, worktree, sandbox } = JSON.parse(note) as Cleanup;
    if (sandbox) await this.deps.cloud.removeSandbox(sandbox.provider, sandbox.name).catch((error: unknown) => this.deps.log.warn(`thread ${threadId}'s sandbox stays: ${words(error)}`));
    await retireCode(root, threadId, worktree);
    relocations.setCleanup(this.deps.db, relocation, null);
  }

  // ── The brain's part, asked by its Mac through control ops ──

  /** receive-thread: takes a package from the inbox. One called off before it arrived is refused. */
  async receive(relocation: string, file: string, copyOf: (macProject: string) => string | null): Promise<BrainControlResults["receive-thread"]> {
    const { db } = this.deps;
    const row = relocations.get(db, relocation);
    if (row?.phase === "arrived") return { received: true };
    if (row) return { refused: CALLED_OFF };
    try {
      const bytes = await readFile(file);
      const pkg = decodePackage(bytes);
      if (pkg.relocation !== relocation) throw new RelocationRefused("The package is for another move.");
      const commit = () => void relocations.open(db, { id: relocation, threadId: pkg.rows.threadId, role: "brain", direction: "to-cloud", phase: "arrived", projectId: copyOf(pkg.macProject) });
      await this.take(bytes, { projectId: copyOf, place: "cloud", commit });
      return { received: true };
    } catch (error) {
      if (error instanceof LacksBase) return { lacksBase: true };
      if (error instanceof RelocationRefused) return { refused: error.message };
      throw error;
    }
  }

  /** drop-arrival: a receive that may or may not have landed; a tombstone refuses one that comes later. */
  dropArrival(relocation: string, threadId: string): BrainControlResults["drop-arrival"] {
    const { db } = this.deps;
    const row = relocations.get(db, relocation);
    if (row?.phase === "arrived") return { received: true };
    if (!row) relocations.open(db, { id: relocation, threadId, role: "brain", direction: "to-cloud", phase: "dropped", projectId: null });
    return { dropped: true };
  }

  /**
   * hand-off-thread: the idle check and the freeze in one synchronous step, then the sandbox's last state and session
   * into the brain's worktree, and the package into the outbox. Asked again, the same package; one called off is refused.
   */
  async handOff(relocation: string, threadId: string, outbox: string, macProjectOf: (projectId: string) => string | null): Promise<BrainControlResults["hand-off-thread"]> {
    const { db } = this.deps;
    const row = relocations.get(db, relocation);
    if (row && row.phase !== "leaving") return { refused: CALLED_OFF };
    if (!row) {
      const refusal = await this.freezeToLeave(relocation, threadId);
      if (refusal) return { refused: refusal };
    }
    const file = path.join(outbox, packageFile(relocation));
    if (!(await stat(file).catch(() => null))) await this.writePackage(relocation, threadId, file, macProjectOf);
    const bytes = await readFile(file);
    return { file: packageFile(relocation), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  private async freezeToLeave(relocation: string, threadId: string): Promise<string | null> {
    const { db, runs } = this.deps;
    const thread = threads.get(db, threadId);
    if (!thread) return "That conversation is not on the cloud brain.";
    const refusal = relocationRefusal(db, thread);
    if (refusal) return refusal;
    const live = runs.liveRunForThread(threadId);
    if (live && runs.threadActivity(threadId) === "idle") await runs.closeAndWait(live.id);
    if (runs.threadActivity(threadId) !== "idle") return AT_WORK;
    relocations.open(db, { id: relocation, threadId, role: "brain", direction: "to-mac", phase: "leaving", projectId: thread.projectId });
    this.deps.changed(threadId);
    return null;
  }

  private async writePackage(relocation: string, threadId: string, file: string, macProjectOf: (projectId: string) => string | null): Promise<void> {
    const thread = threads.get(this.deps.db, threadId)!;
    const macProject = macProjectOf(thread.projectId);
    if (!macProject) throw new Error("This conversation's project has no copy on the Mac.");
    // The sandbox's last state and its session come to the brain's worktree first.
    await this.deps.cloud.sync(thread, { turnEnded: true }).catch((error: unknown) => this.deps.log.warn(`thread ${threadId} left without its sandbox's last changes: ${words(error)}`));
    const root = executionProject(this.deps.db, thread).rootPath;
    const since = (await git(root, ["for-each-ref", "--format=%(objectname)", "refs/openorc/mac/"])).stdout.split("\n").filter(Boolean);
    const bytes = await this.pack(relocation, threadId, { from: "cloud", macProject, since });
    await mkdir(path.dirname(file), { recursive: true });
    const partial = `${file}.${randomUUID()}.partial`;
    await writeFile(partial, bytes);
    await rename(partial, file);
  }

  /** cancel-hand-off: unfreezes a thread its Mac did not take; a tombstone refuses a hand-off asked later. */
  async cancelHandOff(relocation: string, threadId: string, outbox: string): Promise<BrainControlResults["cancel-hand-off"]> {
    const { db } = this.deps;
    const row = relocations.get(db, relocation);
    if (row?.phase === "left") return { left: true };
    if (row?.phase === "leaving") relocations.advance(db, relocation, "leaving", "stayed");
    if (!row) relocations.open(db, { id: relocation, threadId, role: "brain", direction: "to-mac", phase: "stayed", projectId: null });
    await rm(path.join(outbox, packageFile(relocation)), { force: true });
    this.deps.changed(threadId);
    return { stayed: true };
  }

  /** handed-off: its Mac holds the thread now, so the brain lets its copy go. Safe to repeat. */
  async handedOff(relocation: string, outbox: string): Promise<BrainControlResults["handed-off"]> {
    const row = relocations.get(this.deps.db, relocation);
    // A thread the Mac called back stays here; saying it left would let the Mac think it holds the only copy.
    if (row?.phase === "stayed") throw new Error("This move was called off, so the cloud brain kept the conversation.");
    if (row?.phase === "leaving") await this.letGo(relocation, row.threadId, () => relocations.advance(this.deps.db, relocation, "leaving", "left"));
    await this.cleanUp(relocation);
    await rm(path.join(outbox, packageFile(relocation)), { force: true });
    return { left: true };
  }
}
