import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, glob, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { stopProcess, waitForProcessGroup } from "@openorc/agents";
import { projects, tasks, teamMoves, teamRuntime, teamWorkspaces, threads, type Db } from "@openorc/db";
import { teamTransfer } from "@openorc/git";
import type {
  Project,
  Task,
  TeamActionAvailability,
  TeamIntegrationRecovery,
  TeamPublicationRecord,
  TeamSetupRecovery,
  TeamTreeEntry,
  TeamWorkspaceRecord,
  TeamWorkspaceRecovery,
} from "@openorc/protocol";
import { WorkspaceWriters, type WorkspaceLease } from "./workspace-writers.js";
import { portBlockFor } from "./workspace.js";
import { teamPublicationBranch, teamWorkspaceLocation } from "./team-workspace-location.js";
import { publishTeamFiles } from "./team-file-publication.js";
import { assertSafeParentPath } from "./safe-parent-path.js";
import { captureWithRetry } from "./team-capture-retry.js";
import { checkoutBranch } from "./checkout-branch.js";

type FaultPoint = "after-plan" | "before-write" | "after-write" | "before-receipt" | "after-receipt";
export interface TeamWorkspaceHooks {
  fault?(point: FaultPoint, receiptId: string, file?: string): Promise<void> | void;
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const same = (left: TeamTreeEntry | null, right: TeamTreeEntry | null) => left?.mode === right?.mode && left?.oid === right?.oid;
const allowed = { allowed: true, reason: null } as const;
const denied = (reason: string): TeamActionAvailability => ({ allowed: false, reason });
const CONFLICT_MARKER = /^(<{7}|={7}|>{7}|\|{7})( |$)/m;
export interface TeamRecoveryContext {
  /** Throws once the owning execution was stopped, replaced or shut down. */
  assertActive(): void;
  /** Throws while the actor still has a starting, running or launching attempt. */
  assertActorIdle(actorId: string): void;
}

/** Exact input, immutable output and recoverable publication. Never resets a user's index or creates commits. */
export class TeamWorkspaceService {
  private readonly operations = new Map<string, Promise<unknown>>();
  /** Request key of each running explicit recovery; a different key must not coalesce with it. */
  private readonly recovering = new Map<string, string>();
  private readonly fences = new Map<string, WorkspaceLease>();
  private closing = false;

  constructor(
    private readonly db: Db,
    private readonly options: { dataDir: string },
    private readonly writers: WorkspaceWriters,
    private readonly hooks: TeamWorkspaceHooks = {},
  ) {}

  private context(executionId: string, actorId: string) {
    if (this.closing) throw new Error("Team workspaces are shutting down.");
    const execution = teamRuntime.get(this.db, executionId);
    const actor = execution?.actors.find((candidate) => candidate.id === actorId);
    if (!execution || !actor) throw new Error("Team workspace actor not found.");
    const project = projects.get(this.db, execution.projectId)!;
    const thread = threads.get(this.db, execution.threadId)!;
    return { execution, actor, project, thread };
  }

  private once<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(key);
    if (previous) return previous as Promise<T>;
    const pending = operation().finally(() => this.operations.delete(key));
    this.operations.set(key, pending);
    return pending;
  }

  /** Called only after the requesting manager has yielded and released its writer. */
  prepare(executionId: string, actorId: string, assertActive: () => void): Promise<Task | null> {
    return this.once(`prepare:${executionId}:${actorId}`, async () => {
      assertActive();
      const { execution, actor, project, thread } = this.context(executionId, actorId);
      const existing = teamWorkspaces.get(this.db, executionId, actorId);
      if (existing) {
        if (existing.state !== "ready" || existing.setupState !== "completed") throw new Error(existing.error ?? "Workspace preparation requires recovery. Its existing files were preserved.");
        await realpath(existing.path);
        assertActive();
        return this.projectWorkspace(existing, execution.threadId, assertActive);
      }
      const parent = actor.parentId ? teamWorkspaces.get(this.db, executionId, actor.parentId) : null;
      if (actor.parentId && parent?.state !== "ready") throw new Error("The requesting manager's workspace is not ready.");
      const sourcePath = parent?.path ?? thread.worktreePath ?? project.rootPath;
      const prior =
        parent ??
        teamWorkspaces.list(this.db).findLast((item) => item.actorId === "lead" && item.path === sourcePath && teamRuntime.get(this.db, item.executionId)?.instanceId === execution.instanceId);
      const local = !parent && thread.workspaceMode === "current" && !thread.worktreePath;
      // A first local start establishes ownership by capturing the existing checkout.
      // Once prepared, require the retained proof just as for a moved workspace.
      const retainedLocal = local && (prior || thread.baseSha || teamMoves.latestForThread(this.db, thread.id));
      const inherited = !parent && (thread.worktreePath || retainedLocal) ? teamWorkspaceLocation(this.db, thread.id) : null;
      const sourceRoot = await realpath(sourcePath);
      const id = randomUUID();
      // The conversation keeps one lead workspace: a later execution continues in
      // the same directory instead of materializing a copy of it. Members may be
      // talking there right now, so nothing is captured or copied here.
      if (!parent && !local && prior && thread.worktreePath && sourcePath === thread.worktreePath) {
        assertActive();
        const now = Date.now();
        const continued = teamWorkspaces.save(this.db, {
          id,
          executionId,
          actorId,
          taskId: null,
          parentActorId: null,
          path: prior.path,
          source: prior.source,
          state: "preparing",
          setupState: "pending",
          preparedTree: null,
          outputTree: null,
          error: null,
          createdAt: now,
          updatedAt: now,
        });
        const ready = this.save(continued, { state: "ready", setupState: "completed", preparedTree: prior.outputTree ?? inherited?.trackedTree ?? prior.preparedTree });
        return this.projectWorkspace(ready, execution.threadId, assertActive);
      }
      const destination = local ? project.rootPath : path.join(this.options.dataDir, "team-workspaces", executionId, actorId);
      // Reading the source must not stop other conversations using it. Only a
      // newly materialized destination needs exclusive setup ownership.
      const lease = await this.writers.acquire(destination, `Prepare team workspace ${actorId}`, undefined, local ? { shared: true } : { waitForShared: assertActive });
      let sourceLease: WorkspaceLease | undefined;
      let record: TeamWorkspaceRecord | null = null;
      try {
        if (!local) sourceLease = await this.writers.acquire(sourceRoot, `Read team workspace ${actorId}`, undefined, { shared: true });
        assertActive();
        // A team launched from a chosen base starts its lead from that exact commit, never from the checkout's uncommitted files.
        // Only a first lead workspace carries a base without a projected workspace; later records inherit from it.
        const fromBase = !parent && !prior && !inherited && !local && thread.baseSha && sourceRoot === (await realpath(project.rootPath));
        const source = fromBase
          ? await teamTransfer.captureCommit(sourceRoot, thread.baseSha!, { refPrefix: `refs/openorc/teams/${id}/input` })
          : await teamTransfer.capture(sourceRoot, {
              refPrefix: `refs/openorc/teams/${id}/input`,
              ...this.captureTracking(inherited, prior),
            });
        assertActive();
        const now = Date.now();
        record = teamWorkspaces.save(this.db, {
          id,
          executionId,
          actorId,
          taskId: actor.taskId,
          parentActorId: actor.parentId,
          path: destination,
          source,
          state: "preparing",
          setupState: "pending",
          preparedTree: null,
          outputTree: null,
          error: null,
          createdAt: now,
          updatedAt: now,
        });
        if (local) {
          // The checkout already exists. Retain its input without setup,
          // materialization or copying configuration over the user's files.
          record = this.save(record, { state: "ready", setupState: "completed", preparedTree: source.treeSha });
          assertActive();
          return await this.projectWorkspace(record, execution.threadId, assertActive);
        }
        record = await this.build(record, project, sourceRoot, actor.taskId ?? thread.id, assertActive);
        return await this.projectWorkspace(record, execution.threadId, assertActive);
      } catch (error) {
        // The build journals progress (prepared tree) before it can fail; block the current record, not a stale copy.
        const latest = record && (teamWorkspaces.get(this.db, executionId, actorId) ?? record);
        if (latest) this.save(latest, { state: "attention", setupState: "blocked", error: message(error) });
        throw error;
      } finally {
        sourceLease?.release();
        lease.release();
      }
    });
  }

  /** Materialize the captured input, copy declared includes, run setup and verify the prepared tree. */
  private async build(saved: TeamWorkspaceRecord, project: Project, includeSource: string | null, setupId: string, assertActive: () => void): Promise<TeamWorkspaceRecord> {
    let record = saved;
    await mkdir(path.dirname(record.path), { recursive: true });
    await teamTransfer.materialize(project.rootPath, { snapshot: record.source, path: record.path });
    assertActive();
    if (includeSource) await this.copyIncludes(project, includeSource, record.path);
    record = this.save(record, { setupState: "running" });
    await this.setup(project, record.path, setupId, assertActive);
    assertActive();
    const prepared = await teamTransfer.capture(record.path, { refPrefix: `refs/openorc/teams/${record.id}/prepared-${randomUUID()}`, trackedTree: record.source.treeSha });
    record = this.save(record, { preparedTree: prepared.treeSha, setupChangedSource: prepared.treeSha !== record.source.treeSha });
    if (prepared.treeSha !== record.source.treeSha)
      throw new Error("Workspace setup changed source files. Inspect the retained source and prepared trees before accepting those changes; this worker has not started.");
    assertActive();
    return this.save(record, { state: "ready", setupState: "completed", error: null });
  }

  /** Blocked setup is recoverable only explicitly: a fresh directory or an accepted source-changing setup. */
  setupRecovery(executionId: string, actorId: string, context?: Pick<TeamRecoveryContext, "assertActorIdle">, inside = false): TeamSetupRecovery | undefined {
    const record = teamWorkspaces.get(this.db, executionId, actorId);
    if (!record || record.state !== "attention" || record.setupState !== "blocked") return undefined;
    const sourceChanged = Boolean(record.setupChangedSource ?? (record.preparedTree && record.preparedTree !== record.source.treeSha));
    let blocked: string | null = null;
    if (this.closing) blocked = "Team workspaces are shutting down.";
    else if (!inside && this.recovering.has(`recover:setup:${executionId}:${actorId}`)) blocked = "Setup recovery is already in progress.";
    else if (record.outputTree) blocked = "This assignment already captured output; its setup cannot be recovered.";
    else if (record.path === projects.get(this.db, teamRuntime.get(this.db, executionId)!.projectId)!.rootPath) blocked = "The local checkout is never rebuilt by setup recovery.";
    else {
      try {
        context?.assertActorIdle(actorId);
      } catch (error) {
        blocked = message(error);
      }
    }
    return {
      retrySetup: blocked ? denied(blocked) : allowed,
      acceptSetup: setupAcceptance(blocked, sourceChanged),
      sourceChanged,
      retiredPaths: (record.retired ?? []).map((item) => item.path),
    };
  }

  /** One explicit recovery per target at a time; replaying its key joins it, any other key is refused. */
  private recoveryOnce(key: string, requestKey: string, operation: () => Promise<void>): Promise<void> {
    const running = this.recovering.get(key);
    if (running !== undefined && running !== requestKey) return Promise.reject(new Error("Recovery is already in progress for this target."));
    if (running === requestKey) return this.operations.get(key) as Promise<void>;
    this.recovering.set(key, requestKey);
    return this.once(key, operation).finally(() => this.recovering.delete(key));
  }

  private recovered(record: { recovery?: TeamWorkspaceRecovery[] }, requestKey: string, kind: TeamWorkspaceRecovery["kind"]): TeamWorkspaceRecovery | null {
    const previous = record.recovery?.find((item) => item.requestKey === requestKey);
    if (previous && previous.kind !== kind) throw new Error("This recovery request key already identifies a different operation.");
    return previous ?? null;
  }

  /** Same captured input, new directory; the failed directory stays exactly as it is for inspection. */
  retrySetup(executionId: string, actorId: string, requestKey: string, context: TeamRecoveryContext): Promise<void> {
    return this.recoveryOnce(`recover:setup:${executionId}:${actorId}`, requestKey, async () => {
      const { execution, actor, project, thread } = this.context(executionId, actorId);
      const existing = teamWorkspaces.get(this.db, executionId, actorId);
      if (!existing) throw new Error("This assignment has no workspace to recover.");
      if (this.recovered(existing, requestKey, "retry-setup")) return;
      const availability = this.setupRecovery(executionId, actorId, context, true)?.retrySetup ?? denied("Setup is not blocked for this assignment.");
      if (!availability.allowed) throw new Error(availability.reason!);
      context.assertActive();
      const retiredAt = Date.now();
      const base = path.join(this.options.dataDir, "team-workspaces", executionId, actorId);
      const destination = `${base}-retry-${(existing.retired?.length ?? 0) + 1}`;
      // Declared includes come from the original source when it still exists, otherwise from the retired directory that already received them.
      const includeSource = (await realpath(existing.source.rootPath).catch(() => null)) ?? (await realpath(existing.path).catch(() => null));
      const lease = await this.writers.acquire([destination, ...(includeSource ? [includeSource] : [])], `Retry team workspace setup ${actorId}`, undefined, { waitForShared: () => {} });
      let record: TeamWorkspaceRecord | null = null;
      try {
        context.assertActive();
        record = this.save(existing, {
          path: destination,
          state: "preparing",
          setupState: "pending",
          preparedTree: null,
          error: null,
          setupChangedSource: false,
          retired: [...(existing.retired ?? []), { path: existing.path, preparedTree: existing.preparedTree, error: existing.error, retiredAt }],
        });
        record = await this.build(record, project, includeSource, actor.taskId ?? thread.id, context.assertActive);
        // A key is consumed only by a successful outcome; replaying a failed attempt's key retries again.
        record = this.save(record, { recovery: [...(record.recovery ?? []), { requestKey, kind: "retry-setup", createdAt: Date.now() }] });
        await this.projectWorkspace(record, execution.threadId, context.assertActive);
      } catch (error) {
        const latest = record && (teamWorkspaces.get(this.db, executionId, actorId) ?? record);
        if (latest) this.save(latest, { state: "attention", setupState: "blocked", error: message(error) });
        throw error;
      } finally {
        lease.release();
      }
    });
  }

  /** The prepared tree becomes the assignment's input; its later result delta is measured from that tree, not from the captured source. */
  acceptSetup(executionId: string, actorId: string, requestKey: string, context: TeamRecoveryContext): Promise<void> {
    return this.recoveryOnce(`recover:setup:${executionId}:${actorId}`, requestKey, async () => {
      const { execution } = this.context(executionId, actorId);
      const existing = teamWorkspaces.get(this.db, executionId, actorId);
      if (!existing) throw new Error("This assignment has no workspace to recover.");
      if (this.recovered(existing, requestKey, "accept-setup")) return;
      const availability = this.setupRecovery(executionId, actorId, context, true)?.acceptSetup ?? denied("Setup is not blocked for this assignment.");
      if (!availability.allowed) throw new Error(availability.reason!);
      if (!existing.preparedTree) throw new Error("Setup never produced a prepared tree; retry setup instead.");
      const lease = await this.writers.acquire(existing.path, `Accept team workspace setup ${actorId}`, undefined, { waitForShared: () => {} });
      try {
        context.assertActive();
        const current = await teamTransfer.capture(existing.path, { refPrefix: `refs/openorc/teams/${existing.id}/accepted-${randomUUID()}`, trackedTree: existing.source.treeSha });
        if (current.treeSha !== existing.preparedTree) throw new Error("The workspace changed after setup finished. Inspect it, then retry setup to rebuild from the captured input.");
        context.assertActive();
        const record = this.save(existing, {
          state: "ready",
          setupState: "completed",
          error: null,
          setupAccepted: { sourceTree: existing.source.treeSha, preparedTree: existing.preparedTree, acceptedAt: Date.now() },
          recovery: [...(existing.recovery ?? []), { requestKey, kind: "accept-setup", createdAt: Date.now() }],
        });
        await this.projectWorkspace(record, execution.threadId, context.assertActive);
      } finally {
        lease.release();
      }
    });
  }

  /** Conflicting and interrupted integrations are recoverable only explicitly. */
  integrationRecovery(receipt: TeamPublicationRecord, context?: Pick<TeamRecoveryContext, "assertActorIdle">, inside = false): TeamIntegrationRecovery | undefined {
    if (receipt.state === "applied") return undefined;
    let blocked: string | null = null;
    if (this.closing) blocked = "Team workspaces are shutting down.";
    else if (this.operations.has(`integrate:${receipt.executionId}:${receipt.targetActorId}`) || (!inside && this.recovering.has(`recover:integration:${receipt.id}`)))
      blocked = "Integration is already in progress.";
    else {
      try {
        context?.assertActorIdle(receipt.targetActorId);
      } catch (error) {
        blocked = message(error);
      }
    }
    const conflicts = receipt.conflicts ?? [];
    return {
      retry: blocked ? denied(blocked) : allowed,
      accept: integrationAcceptance(blocked, receipt.state),
      conflicts,
      retiredScratchPaths: receipt.retiredScratchPaths ?? [],
    };
  }

  private async ownedReceipt(executionId: string, publicationId: string) {
    const receipt = teamWorkspaces.publication(this.db, publicationId);
    if (!receipt || receipt.executionId !== executionId) throw new Error("This integration does not belong to the execution.");
    const { execution } = this.context(executionId, receipt.targetActorId);
    const source = teamWorkspaces.get(this.db, executionId, receipt.sourceActorId);
    const destination = teamWorkspaces.get(this.db, executionId, receipt.targetActorId);
    if (!source?.preparedTree || !destination) throw new Error("The integration's workspaces are missing. Preserve them for recovery.");
    return { receipt, execution, source, destination };
  }

  /** Merge the current workspaces again into a new scratch worktree; earlier scratch evidence stays untouched. */
  retryIntegration(executionId: string, publicationId: string, requestKey: string, context: TeamRecoveryContext): Promise<void> {
    return this.recoveryOnce(`recover:integration:${publicationId}`, requestKey, async () => {
      const { receipt: existing, source, destination } = await this.ownedReceipt(executionId, publicationId);
      if (this.recovered(existing, requestKey, "retry-integration")) return;
      const availability = this.integrationRecovery(existing, context, true)?.retry ?? denied("This integration is already applied.");
      if (!availability.allowed) throw new Error(availability.reason!);
      context.assertActive();
      const lease = this.fences.get(existing.id) ?? (await this.writers.acquire(destination.path, `Retry team integration ${existing.id}`, undefined, { waitForShared: () => {} }));
      let receipt = existing;
      let retain = false;
      try {
        context.assertActive();
        if (!existing.afterTree) {
          const scratch = `${path.join(this.options.dataDir, "team-integrations", existing.id)}-retry-${(existing.retiredScratchPaths?.length ?? 0) + 1}`;
          const before = await teamTransfer.capture(destination.path, { refPrefix: `refs/openorc/teams/${existing.id}/before-${randomUUID()}`, ...this.tracking(destination) });
          context.assertActive();
          receipt = this.saveReceipt(existing, {
            before,
            scratchPath: scratch,
            state: "planned",
            error: null,
            conflicts: [],
            retiredScratchPaths: [...(existing.retiredScratchPaths ?? []), existing.scratchPath],
          });
        }
        await this.processReceipt(receipt, source, context.assertActive);
        const applied = teamWorkspaces.publication(this.db, receipt.id)!;
        this.saveReceipt(applied, { recovery: [...(applied.recovery ?? []), { requestKey, kind: "retry-integration", createdAt: Date.now() }] });
      } catch (error) {
        const latest = teamWorkspaces.publication(this.db, receipt.id);
        if (latest && latest.state !== "applied" && latest.state !== "conflict") {
          this.saveReceipt(latest, { state: "attention", error: message(error) });
          this.fences.set(latest.id, lease);
          retain = true;
        }
        throw error;
      } finally {
        if (!retain) {
          this.fences.delete(receipt.id);
          lease.release();
        }
      }
    });
  }

  /** The user resolved the scratch worktree by hand; publish exactly those files through the journaled path. */
  acceptIntegration(executionId: string, publicationId: string, requestKey: string, context: TeamRecoveryContext): Promise<void> {
    return this.recoveryOnce(`recover:integration:${publicationId}`, requestKey, async () => {
      const { receipt: existing, destination } = await this.ownedReceipt(executionId, publicationId);
      if (this.recovered(existing, requestKey, "accept-integration")) return;
      const availability = this.integrationRecovery(existing, context, true)?.accept ?? denied("This integration is already applied.");
      if (!availability.allowed) throw new Error(availability.reason!);
      context.assertActive();
      const lease =
        this.fences.get(existing.id) ?? (await this.writers.acquire([destination.path, existing.scratchPath], `Accept team integration ${existing.id}`, undefined, { waitForShared: () => {} }));
      let receipt = existing;
      let retain = false;
      try {
        if (!(await lstat(existing.scratchPath).catch(() => null))?.isDirectory()) throw new Error("The retained integration scratch workspace is missing. Retry the integration instead.");
        const unresolved: string[] = [];
        for (const file of existing.conflicts ?? []) {
          const bytes = await readFile(path.join(existing.scratchPath, file)).catch(() => null);
          if (bytes && CONFLICT_MARKER.test(bytes.toString("utf8"))) unresolved.push(file);
        }
        if (unresolved.length) throw new Error(`Resolve the conflict markers in ${unresolved.join(", ")} before accepting.`);
        context.assertActive();
        const resolved = await teamTransfer.capture(existing.scratchPath, {
          refPrefix: `refs/openorc/teams/${existing.id}/resolved-${randomUUID()}`,
          trackedTree: existing.before.treeSha,
          additionalTrackedTrees: [existing.outputTree],
        });
        context.assertActive();
        const [beforeEntries, afterEntries] = await Promise.all([teamTransfer.listTree(destination.path, existing.before.treeSha), teamTransfer.listTree(destination.path, resolved.treeSha)]);
        const before = new Map(beforeEntries.map((entry) => [entry.path, entry])),
          after = new Map(afterEntries.map((entry) => [entry.path, entry]));
        const entries = [...new Set([...before.keys(), ...after.keys()])]
          .sort()
          .flatMap((file) => (same(before.get(file) ?? null, after.get(file) ?? null) ? [] : [{ path: file, before: before.get(file) ?? null, after: after.get(file) ?? null }]));
        receipt = this.saveReceipt(existing, { afterTree: resolved.treeSha, entries, state: "publishing", error: null });
        await this.publish(receipt, context.assertActive);
        const applied = teamWorkspaces.publication(this.db, receipt.id)!;
        this.saveReceipt(applied, { recovery: [...(applied.recovery ?? []), { requestKey, kind: "accept-integration", createdAt: Date.now() }] });
      } catch (error) {
        const latest = teamWorkspaces.publication(this.db, receipt.id);
        if (latest && latest.state !== "applied" && latest.state !== "conflict") {
          this.saveReceipt(latest, { state: "attention", error: message(error) });
          this.fences.set(latest.id, lease);
          retain = true;
        }
        throw error;
      } finally {
        if (!retain) {
          this.fences.delete(receipt.id);
          lease.release();
        }
      }
    });
  }

  /** In-flight explicit recoveries for an execution; Stop and quiescence wait for them. */
  pendingRecoveries(executionId: string): Promise<void>[] {
    return [...this.operations.entries()]
      .filter(
        ([key]) =>
          key.startsWith(`recover:setup:${executionId}:`) ||
          (key.startsWith("recover:integration:") && teamWorkspaces.publication(this.db, key.slice("recover:integration:".length))?.executionId === executionId),
      )
      .map(([, promise]) =>
        promise.then(
          () => undefined,
          () => undefined,
        ),
      );
  }

  /** Turn checkpoints inherit the writer lease and the assignment's exact tracked input. */
  async captureRunCheckpoint(runId: string, cwd: string, lease: WorkspaceLease): Promise<string | null> {
    const binding = teamRuntime.binding(this.db, runId);
    if (!binding) return null;
    const execution = teamRuntime.get(this.db, binding.executionId)!;
    const participant = execution.actors.find((actor) => actor.id === binding.actorId)?.participant;
    // A chat participant shares the lead's workspace: the newest ready lead record of this team at that path owns its tracked input.
    const physical = await realpath(cwd);
    const sharedLead = async () => {
      const candidates = teamWorkspaces
        .list(this.db)
        .filter((item) => item.actorId === "lead" && item.state === "ready" && item.setupState === "completed" && teamRuntime.get(this.db, item.executionId)?.instanceId === execution.instanceId);
      for (const candidate of candidates.reverse()) if ((await realpath(candidate.path).catch(() => null)) === physical) return candidate;
      return null;
    };
    const record = participant ? await sharedLead() : teamWorkspaces.get(this.db, binding.executionId, binding.actorId);
    if (!record?.preparedTree || record.state !== "ready" || record.setupState !== "completed" || (await realpath(record.path)) !== physical)
      throw new Error("This team turn has no ready retained workspace to checkpoint.");
    return this.writers.withLease(
      cwd,
      `Checkpoint team run ${runId}`,
      async () => {
        const snapshot = await captureWithRetry(() => teamTransfer.capture(cwd, { refPrefix: `refs/openorc/teams/${record.id}/checkpoints/${runId}-${randomUUID()}`, ...this.tracking(record) }));
        return snapshot.treeSha;
      },
      lease,
    );
  }

  /** A completed process can leave changes after its last token. Capture only after confirmed closure. */
  captureOutput(executionId: string, actorId: string, assertActive: () => void): Promise<void> {
    return this.once(`capture:${executionId}:${actorId}`, async () => {
      const { actor, thread } = this.context(executionId, actorId);
      const record = teamWorkspaces.get(this.db, executionId, actorId);
      if (!record?.preparedTree || record.state !== "ready") throw new Error("The assignment has no verified input workspace.");
      if (record.outputTree && actor.state === "completed") return;
      // A local conversation shares the checkout with other threads. Its own
      // processes have closed, but this read-only snapshot must not wait for
      // unrelated conversations (as with local preparation and turn checkpoints).
      // Isolated assignment output still requires exclusive ownership.
      const local = actor.id === "lead" && thread.workspaceMode === "current" && !thread.worktreePath;
      const lease = await this.writers.acquire(record.path, `Capture team output ${actorId}`, undefined, local ? { shared: true } : { waitForShared: assertActive });
      try {
        assertActive();
        const output = await captureWithRetry(() => teamTransfer.capture(record.path, { refPrefix: `refs/openorc/teams/${record.id}/output-${randomUUID()}`, ...this.tracking(record) }), {
          assertActive,
        });
        assertActive();
        this.save(record, { outputTree: output.treeSha });
      } finally {
        lease.release();
      }
    });
  }

  /** Integrate only direct-child deltas. A manager's own later output includes its accepted descendants once. */
  integrate(executionId: string, targetActorId: string, assertActive: () => void): Promise<void> {
    return this.once(`integrate:${executionId}:${targetActorId}`, async () => {
      const { execution } = this.context(executionId, targetActorId);
      const destination = teamWorkspaces.get(this.db, executionId, targetActorId);
      if (!destination?.preparedTree || destination.state !== "ready") throw new Error("The receiving workspace is not ready.");
      for (const actor of execution.actors.filter((item) => item.parentId === targetActorId && item.state === "completed")) {
        assertActive();
        const output = teamWorkspaces.get(this.db, executionId, actor.id);
        if (!output?.preparedTree || !output.outputTree) throw new Error("The completed assignment has no retained output. Inspect it before integration.");
        let receipt = teamWorkspaces
          .publications(this.db, executionId)
          .find((item) => item.sourceActorId === actor.id && item.targetActorId === targetActorId && item.outputTree === output.outputTree);
        if (receipt?.state === "applied") continue;
        if (receipt?.state === "conflict") throw new Error(receipt.error ?? "This integration has conflicts. Resolve them in its retained scratch workspace and accept, or retry the integration.");
        const fenceKey = receipt?.id;
        const lease = (fenceKey && this.fences.get(fenceKey)) || (await this.writers.acquire(destination.path, `Integrate team result ${actor.id}`, undefined, { waitForShared: assertActive }));
        let retain = false;
        try {
          assertActive();
          if (!receipt) {
            const id = randomUUID();
            const before = await teamTransfer.capture(destination.path, { refPrefix: `refs/openorc/teams/${id}/before`, ...this.tracking(destination) });
            const now = Date.now();
            receipt = teamWorkspaces.savePublication(this.db, {
              id,
              executionId,
              sourceActorId: actor.id,
              targetActorId,
              outputTree: output.outputTree,
              destinationPath: destination.path,
              before,
              afterTree: null,
              scratchPath: path.join(this.options.dataDir, "team-integrations", id),
              state: "planned",
              entries: [],
              includedActorIds: [
                actor.id,
                ...teamWorkspaces
                  .publications(this.db, executionId)
                  .filter((item) => item.targetActorId === actor.id && item.state === "applied")
                  .flatMap((item) => item.includedActorIds),
              ],
              error: null,
              createdAt: now,
              updatedAt: now,
            });
            await this.hooks.fault?.("after-plan", receipt.id);
          }
          await this.processReceipt(receipt, output, assertActive);
          receipt = teamWorkspaces.publication(this.db, receipt.id)!;
        } catch (error) {
          const latest = receipt ? teamWorkspaces.publication(this.db, receipt.id) : null;
          if (latest && latest.state !== "applied" && latest.state !== "conflict") {
            receipt = this.saveReceipt(latest, { state: "attention", error: message(error) });
            this.fences.set(receipt.id, lease);
            retain = true;
          }
          throw error;
        } finally {
          if (!retain) {
            if (fenceKey) this.fences.delete(fenceKey);
            lease.release();
          }
        }
      }
    });
  }

  /** Trial-merge in scratch storage, journal the exact delta, then publish it to the destination. */
  private async processReceipt(planned: TeamPublicationRecord, output: TeamWorkspaceRecord, assertActive: () => void): Promise<void> {
    let receipt = planned;
    if (!receipt.afterTree) {
      await mkdir(path.dirname(receipt.scratchPath), { recursive: true });
      // A crash while constructing scratch storage is ambiguous; never overwrite its evidence.
      if (await lstat(receipt.scratchPath).catch(() => null))
        throw new Error("Interrupted scratch integration exists. Retry the integration explicitly to merge again in a new scratch directory; its retained files are kept.");
      const merge = await teamTransfer.stageMerge(receipt.destinationPath, {
        baseTree: output.preparedTree!,
        outputTree: output.outputTree!,
        destinationTree: receipt.before.treeSha,
        headSha: receipt.before.headSha,
        path: receipt.scratchPath,
        refPrefix: `refs/openorc/teams/${receipt.id}/merged-${path.basename(receipt.scratchPath)}`,
      });
      if (merge.status === "conflict") {
        receipt = this.saveReceipt(receipt, {
          state: "conflict",
          conflicts: merge.conflicts,
          error: `Conflicting result retained at ${receipt.scratchPath}: ${merge.conflicts.join(", ")}. Resolve the files there and accept, or retry the integration.`,
        });
        throw new Error(receipt.error!);
      }
      const [beforeEntries, afterEntries] = await Promise.all([teamTransfer.listTree(receipt.destinationPath, receipt.before.treeSha), teamTransfer.listTree(receipt.destinationPath, merge.treeSha)]);
      const before = new Map(beforeEntries.map((entry) => [entry.path, entry]));
      const after = new Map(afterEntries.map((entry) => [entry.path, entry]));
      const entries = [...new Set([...before.keys(), ...after.keys()])]
        .sort()
        .flatMap((file) => (same(before.get(file) ?? null, after.get(file) ?? null) ? [] : [{ path: file, before: before.get(file) ?? null, after: after.get(file) ?? null }]));
      receipt = this.saveReceipt(receipt, { afterTree: merge.treeSha, entries, state: "publishing", error: null, conflicts: [] });
    }
    await this.publish(receipt, assertActive);
  }

  private async publish(receipt: TeamPublicationRecord, assertActive: () => void): Promise<void> {
    this.saveReceipt(receipt, { state: "publishing", error: null });
    await publishTeamFiles(receipt, assertActive, this.hooks.fault);
    this.saveReceipt(receipt, { state: "applied", error: null });
    await this.hooks.fault?.("after-receipt", receipt.id);
  }

  private save(record: TeamWorkspaceRecord, patch: Partial<TeamWorkspaceRecord>): TeamWorkspaceRecord {
    return teamWorkspaces.save(this.db, { ...record, ...patch, updatedAt: Date.now() });
  }
  private tracking(record: TeamWorkspaceRecord): { trackedTree: string; additionalTrackedTrees: string[] } {
    const retained = teamWorkspaces
      .publications(this.db, record.executionId)
      .filter((item) => item.targetActorId === record.actorId && item.state === "applied")
      .flatMap((item) => (item.afterTree ? [item.afterTree] : []));
    return { trackedTree: record.preparedTree ?? record.source.treeSha, additionalTrackedTrees: [...new Set([...(record.outputTree ? [record.outputTree] : []), ...retained])] };
  }
  private captureTracking(inherited: { trackedTree: string; additionalTrackedTrees?: string[] } | null, prior: TeamWorkspaceRecord | null | undefined) {
    if (inherited) return { trackedTree: inherited.trackedTree, additionalTrackedTrees: inherited.additionalTrackedTrees };
    if (prior?.preparedTree) return this.tracking(prior);
    return {};
  }
  private async projectWorkspace(record: TeamWorkspaceRecord, threadId: string, assertActive: () => void): Promise<Task | null> {
    if (record.taskId)
      return tasks.update(this.db, record.taskId, { workspaceMode: "worktree", worktreePath: record.path, branch: null, baseSha: record.source.headSha, baseRef: record.source.headSha });
    // A local lead uses the checkout's actual branch, preserving the separate
    // publication metadata for a later move back to an isolated worktree.
    const branch = threads.get(this.db, threadId)?.branch;
    const execution = teamRuntime.get(this.db, record.executionId)!;
    const project = projects.get(this.db, execution.projectId)!;
    const local = record.path === project.rootPath;
    const publicationBranch = !local && branch?.startsWith("openorc/team-") ? teamPublicationBranch(this.db, threadId) : null;
    let projectedBranch: string | null = null;
    if (local) projectedBranch = await checkoutBranch(record.path);
    else if (branch && branch === publicationBranch) projectedBranch = branch;
    assertActive();
    threads.update(this.db, threadId, {
      workspaceMode: local ? "current" : "worktree",
      worktreePath: local ? null : record.path,
      branch: projectedBranch,
      baseSha: record.source.headSha,
    });
    return null;
  }
  private saveReceipt(record: TeamPublicationRecord, patch: Partial<TeamPublicationRecord>): TeamPublicationRecord {
    return teamWorkspaces.savePublication(this.db, { ...record, ...patch, updatedAt: Date.now() });
  }

  /** Startup classifies interrupted intent, preserves all files and reestablishes publication fences. */
  assertStopped(executionId: string): void {
    if (this.pendingRecoveries(executionId).length) throw new Error("Workspace recovery is still running for this team. Wait for it to finish before this action.");
    if (teamWorkspaces.publications(this.db, executionId).some((record) => !["applied", "conflict"].includes(record.state)))
      throw new Error("The team stopped while integrating files. Its partial publication is preserved and needs explicit recovery before another writer can start.");
  }

  async recover(): Promise<void> {
    for (const record of teamWorkspaces.list(this.db))
      if (record.state === "preparing")
        this.save(record, { state: "attention", setupState: "blocked", error: "Workspace setup was interrupted. Inspect its retained files before retrying; setup was not replayed." });
    for (const record of teamWorkspaces.publications(this.db)) {
      if (record.state === "applied" || record.state === "conflict" || this.fences.has(record.id)) continue;
      const lease = await this.writers.acquire(record.destinationPath, `Recover team integration ${record.id}`, undefined, { waitForShared: () => {} });
      this.fences.set(record.id, lease);
      this.saveReceipt(record, { state: "attention", error: "Integration was interrupted. Explicitly retry to reconcile its recorded before/after files; nothing was reset." });
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.operations.values()]);
    for (const lease of this.fences.values()) lease.release();
    this.fences.clear();
  }

  private async copyIncludes(project: Project, source: string, destination: string): Promise<void> {
    const sourceDirectories = new Map<string, string>();
    const destinationDirectories = new Map<string, string>();
    for (const pattern of project.settings.worktreeInclude) {
      for await (const file of glob(pattern, { cwd: source, exclude: (candidate) => candidate.includes("node_modules") || candidate === ".git" || candidate.startsWith(".git/") })) {
        await assertSafeParentPath(source, file, sourceDirectories);
        await assertSafeParentPath(destination, file, destinationDirectories);
        const from = path.join(source, file),
          to = path.join(destination, file);
        if (!(await lstat(from)).isFile()) throw new Error(`Included setup input ${file} must be a regular file.`);
        // Existing tree input always wins; include patterns are for ignored local configuration.
        if (await lstat(to).catch(() => null)) continue;
        await mkdir(path.dirname(to), { recursive: true });
        await assertSafeParentPath(source, file, sourceDirectories);
        await assertSafeParentPath(destination, file, destinationDirectories);
        try {
          await copyFile(from, to, constants.COPYFILE_EXCL);
        } catch (error) {
          // Another writer creating the target first has the same precedence as an existing tree input.
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
    }
  }

  private async setup(project: Project, cwd: string, id: string, assertActive: () => void): Promise<void> {
    if (!project.settings.setupScript) return;
    assertActive();
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/bin/bash", ["-lc", project.settings.setupScript!], {
        cwd,
        detached: true,
        env: { ...process.env, OPENORC_WORKSPACE_PATH: cwd, OPENORC_ROOT_PATH: project.rootPath, OPENORC_WORKSPACE_NAME: path.basename(cwd), OPENORC_PORT: String(portBlockFor(id)) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let tail = "",
        failure: Error | null = null;
      const terminate = () => {
        try {
          stopProcess(child);
        } catch (error) {
          failure ??= new Error(message(error));
        }
      };
      const timer = setInterval(() => {
        try {
          if (this.closing) throw new Error("Workspace setup interrupted by shutdown.");
          assertActive();
        } catch (error) {
          failure ??= new Error(message(error));
          terminate();
        }
      }, 50);
      const timeout = setTimeout(() => {
        failure = new Error("Workspace setup exceeded five minutes.");
        terminate();
      }, 300_000);
      const keep = (data: Buffer) => {
        tail = (tail + data.toString()).slice(-8000);
      };
      child.stdout?.on("data", keep);
      child.stderr?.on("data", keep);
      child.once("error", (error) => {
        failure = error;
      });
      child.once("exit", () => terminate()); // Prevent background descendants from retaining a writer after setup exits.
      child.once("close", async (code) => {
        await waitForProcessGroup(child);
        clearInterval(timer);
        clearTimeout(timeout);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`Workspace setup exited with ${code}: ${tail}`));
        else resolve();
      });
    });
  }
}

function setupAcceptance(blocked: string | null, sourceChanged: boolean) {
  if (blocked) return denied(blocked);
  if (sourceChanged) return allowed;
  return denied("Setup did not change source files; there is nothing to accept. Retry setup instead.");
}
function integrationAcceptance(blocked: string | null, state: string) {
  if (blocked) return denied(blocked);
  if (state !== "conflict") return denied("Only a conflicting integration has a scratch resolution to accept.");
  return allowed;
}
