import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { audit, checkpoints, orchestration, projects, teamContexts, teamMoves, teamWorkspaces, threads, type Db, type TeamMoveRecord } from "@openorc/db";
import { git, teamTransfer } from "@openorc/git";
import { TeamContextSeed, type TeamActionAvailability, type TeamTreeEntry, type Thread, type WorkspaceMode } from "@openorc/protocol";
import { buildTeamContextSeed, teamContextExecutions } from "./team-context.js";
import { teamCheckoutBase } from "./team-checkout-base.js";
import { publishTeamFiles } from "./team-file-publication.js";
import { TeamOperationGuard } from "./team-operations.js";
import { teamWorkspaceLocation } from "./team-workspace-location.js";
import { TeamWorkspaceSnapshots } from "./team-workspace-snapshots.js";
import { WorkspaceWriters, type WorkspaceLease } from "./workspace-writers.js";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sameTreeEntry = (left: TeamTreeEntry | undefined, right: TeamTreeEntry | undefined) => left?.mode === right?.mode && left?.oid === right?.oid;
interface MoveInput {
  threadId: string;
  to: WorkspaceMode;
  requestKey: string;
}
type MoveResult = Thread | { rejected: string };
type CancelResult = { state: "cancelled" | "applied" };
export interface TeamMoveHooks {
  fault?(point: "retained" | "materialized" | "planned" | "after-write" | "applied" | "cancelled", record: TeamMoveRecord, file?: string): Promise<void> | void;
}

/** Move files through retained scratch merges; never resets a checkout or its index. */
export class TeamMoveService {
  private readonly operations = new Map<string, { hash: string; promise: Promise<MoveResult | CancelResult> }>();
  private readonly fences = new Map<string, WorkspaceLease>();
  private readonly snapshots: TeamWorkspaceSnapshots;
  private closing = false;
  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    private readonly guard: TeamOperationGuard,
    private readonly writers: WorkspaceWriters,
    private readonly changed: (threadId: string) => void,
    private readonly hooks: TeamMoveHooks = {},
  ) {
    this.snapshots = new TeamWorkspaceSnapshots(db, writers);
  }

  availability(threadId: string): TeamActionAvailability {
    try {
      const pending = teamMoves.pendingForThread(this.db, threadId)[0];
      const reason = this.guard.reason(threadId, pending?.id);
      if (reason) throw new Error(reason);
      teamWorkspaceLocation(this.db, threadId);
      return { allowed: true, reason: null };
    } catch (error) {
      return { allowed: false, reason: message(error) };
    }
  }

  move(input: MoveInput): Promise<MoveResult> {
    if (this.closing) return Promise.reject(new Error("Team moves are shutting down."));
    if (!input.requestKey.trim() || input.requestKey.length > 200) return Promise.reject(new Error("Moving a team requires a bounded request key."));
    const key = JSON.stringify([input.threadId, input.requestKey]);
    const hash = createHash("sha256")
      .update(JSON.stringify([input.threadId, input.to]))
      .digest("hex");
    const existing = this.operations.get(key);
    if (existing) return existing.hash === hash ? (existing.promise as Promise<MoveResult>) : Promise.reject(new Error("This move key already identifies different work."));
    const promise = this.perform(input, hash)
      .catch((error) => {
        if (teamMoves.find(this.db, input.threadId, input.requestKey)) throw error;
        const rejection = teamMoves.reject(this.db, { threadId: input.threadId, requestKey: input.requestKey, requestHash: hash, error: message(error) });
        return { rejected: rejection.error };
      })
      .finally(() => this.operations.delete(key));
    this.operations.set(key, { hash, promise });
    return promise;
  }

  private async perform(input: MoveInput, hash: string): Promise<MoveResult> {
    const rejected = teamMoves.rejection(this.db, input.threadId, input.requestKey);
    if (rejected) {
      if (rejected.requestHash !== hash) throw new Error("This move key already identifies different work.");
      return { rejected: rejected.error };
    }
    let receipt = teamMoves.find(this.db, input.threadId, input.requestKey);
    if (receipt && receipt.requestHash !== hash) throw new Error("This move key already identifies different work.");
    if (receipt?.state === "applied") return threads.get(this.db, input.threadId) ?? { rejected: "This move completed before its task was deleted." };
    if (receipt?.state === "cancelled") return { rejected: "This move was cancelled. Start a new move request to move the task." };
    if (receipt?.cancelRequested) throw new Error("Finish cancelling the retained move before starting another action.");
    const id = receipt?.id ?? randomUUID();
    const reservation = this.guard.reserve(input.threadId, id);
    let lease: WorkspaceLease | undefined;
    let keepFence = false;
    try {
      const thread = threads.get(this.db, input.threadId)!;
      const instance = orchestration.getInstance(this.db, input.threadId)!;
      const project = projects.get(this.db, thread.projectId)!;
      const location = teamWorkspaceLocation(this.db, thread.id);
      if (!receipt && thread.workspaceMode === input.to) throw new Error("The task is already using that workspace. Refresh its current location.");
      lease = this.fences.get(id) ?? (await this.writers.acquire([location.path, project.rootPath], `Move team ${thread.id}`));
      reservation.assertCurrent();
      if (!receipt) {
        receipt = await this.retainReceipt({
          input,
          hash,
          id,
          workspace: { thread, instanceId: instance.id, projectId: project.id, projectRoot: project.rootPath, sourcePath: location.path },
          lease,
          assertCurrent: () => reservation.assertCurrent(),
        });
        this.changed(thread.id);
      }
      if (receipt.instanceId !== instance.id || receipt.projectId !== project.id || receipt.projectRoot !== project.rootPath || receipt.sourcePath !== location.path)
        throw new Error("The move's original team or workspace changed. Its files remain retained for recovery.");
      await this.hooks.fault?.("retained", receipt);
      reservation.assertCurrent();
      let candidate: string | null = null;
      let candidateLease: WorkspaceLease | undefined;
      try {
        if (receipt.to === "worktree") {
          candidate = path.join(this.dataDir, "team-moves", receipt.id, "workspace", randomUUID());
          receipt = teamMoves.appendPath(this.db, receipt.id, { path: candidate, kind: "workspace" });
          candidateLease = await this.writers.acquire(candidate, `Materialize team move ${receipt.id}`);
          await this.snapshots.materialize(
            project.rootPath,
            { snapshot: receipt.source, setupInput: receipt.setupInput, path: candidate, refPrefix: `refs/openorc/moves/${receipt.id}/verified-${path.basename(candidate)}` },
            () => reservation.assertCurrent(),
          );
          await this.hooks.fault?.("materialized", receipt);
        }
        if (!receipt.publication) {
          receipt = await this.planPublication(receipt, () => reservation.assertCurrent());
        }
        await this.hooks.fault?.("planned", receipt);
        const accepted = receipt;
        await publishTeamFiles(
          { id: receipt.id, destinationPath: project.rootPath, before: receipt.destinationBefore ?? receipt.source, entries: receipt.publication!.entries },
          () => reservation.assertCurrent(),
          async (point, _id, file) => {
            if (point === "after-write") await this.hooks.fault?.("after-write", accepted, file);
          },
        );
        reservation.assertCurrent();
        const target = receipt.to === "current" ? project.rootPath : candidate!;
        const result = this.finalizeMove(accepted, target);
        await this.hooks.fault?.("applied", teamMoves.get(this.db, receipt.id)!);
        return result;
      } finally {
        candidateLease?.release();
      }
    } catch (error) {
      const latest = receipt && teamMoves.get(this.db, receipt.id);
      if (latest && latest.state !== "applied") {
        teamMoves.attention(this.db, latest.id, message(error));
        if (latest.publication && lease) {
          this.fences.set(latest.id, lease);
          keepFence = true;
        }
      }
      throw error;
    } finally {
      if (!keepFence) {
        this.fences.delete(id);
        lease?.release();
      }
      reservation.release();
      this.changed(input.threadId);
    }
  }

  private async retainReceipt({
    input,
    hash,
    id,
    workspace,
    lease,
    assertCurrent,
  }: {
    input: MoveInput;
    hash: string;
    id: string;
    workspace: { thread: Thread; instanceId: string; projectId: string; projectRoot: string; sourcePath: string };
    lease: WorkspaceLease;
    assertCurrent: () => void;
  }): Promise<TeamMoveRecord> {
    const { thread } = workspace;
    const source = await this.snapshots.capture(thread.id, `refs/openorc/moves/${id}/source`, assertCurrent, lease);
    const destinationBefore = input.to === "current" ? await teamTransfer.capture(workspace.projectRoot, { refPrefix: `refs/openorc/moves/${id}/destination` }) : null;
    const origin = input.to === "worktree" ? teamMoves.latestForThread(this.db, thread.id) : null;
    let deltas: { baseTree: string; outputTree: string }[];
    if (destinationBefore) {
      let baseTree = await teamCheckoutBase(this.db, thread.id, workspace.sourcePath);
      if (!baseTree) {
        const common = (await git(workspace.projectRoot, ["merge-base", source.snapshot.headSha, destinationBefore.headSha])).stdout.trim();
        baseTree = (await git(workspace.projectRoot, ["rev-parse", `${common}^{tree}`])).stdout.trim();
      }
      deltas = [{ baseTree, outputTree: source.snapshot.treeSha }];
    } else {
      if (origin && (origin.to !== "current" || !origin.destinationBefore || !origin.afterTree || origin.instanceId !== workspace.instanceId))
        throw new Error("The local team workspace has no retained move baseline. Its files were preserved.");
      const initial = !origin
        ? teamContextExecutions(this.db, workspace.instanceId)
            .map((execution) => teamWorkspaces.get(this.db, execution.id, "lead"))
            .find((record) => record?.path === workspace.projectRoot && record.state === "ready" && record.preparedTree)
        : null;
      const baseline = origin?.destinationBefore ?? initial?.source;
      if (!baseline) throw new Error("The local team workspace has no retained starting baseline. Its files were preserved.");
      deltas = this.localInverseDeltas(workspace.instanceId, workspace.projectRoot, origin);
      // Moving uncommitted work must never undo changes the user has already
      // committed in this checkout. Reapply that retained committed delta
      // to the restored local baseline before publishing source cleanup.
      if (source.snapshot.headSha !== baseline.headSha) {
        const beforeHead = (await git(workspace.projectRoot, ["rev-parse", `${baseline.headSha}^{tree}`])).stdout.trim();
        const currentHead = (await git(workspace.projectRoot, ["rev-parse", `${source.snapshot.headSha}^{tree}`])).stdout.trim();
        deltas.push({ baseTree: beforeHead, outputTree: currentHead });
      }
    }
    for (const [index, delta] of deltas.entries()) {
      await teamTransfer.retainTree(workspace.projectRoot, delta.baseTree, `refs/openorc/moves/${id}/deltas/${index}/base`);
      await teamTransfer.retainTree(workspace.projectRoot, delta.outputTree, `refs/openorc/moves/${id}/deltas/${index}/output`);
    }
    assertCurrent();
    const context = JSON.parse(buildTeamContextSeed(this.db, { instanceId: workspace.instanceId, executionId: null, actorId: "lead" })) as Record<string, unknown>;
    const seed = TeamContextSeed.parse(
      JSON.stringify({
        ...context,
        movedWorkspace: {
          to: input.to,
          note: "The user explicitly moved this task. Use the current workspace path; historical workspace paths are retained history. Do not replay prior assignments.",
        },
      }),
    );
    const receipt = teamMoves.create(this.db, {
      id,
      threadId: thread.id,
      instanceId: workspace.instanceId,
      projectId: workspace.projectId,
      projectRoot: workspace.projectRoot,
      requestKey: input.requestKey,
      requestHash: hash,
      from: thread.workspaceMode,
      to: input.to,
      sourcePath: workspace.sourcePath,
      source: source.snapshot,
      setupInput: source.setupInput,
      destinationBefore,
      deltas,
      originMoveId: origin?.id ?? null,
      publicationBranch: input.to === "worktree" ? `openorc/team-${thread.id}-${id}` : thread.branch,
      seed,
    });
    return receipt;
  }

  private async planPublication(receipt: TeamMoveRecord, assertCurrent: () => void): Promise<TeamMoveRecord> {
    const before = receipt.destinationBefore ?? receipt.source;
    let tree = before.treeSha;
    for (const delta of receipt.deltas) {
      const scratch = path.join(this.dataDir, "team-moves", receipt.id, "scratch", randomUUID());
      receipt = teamMoves.appendPath(this.db, receipt.id, { path: scratch, kind: "scratch" });
      await mkdir(path.dirname(scratch), { recursive: true });
      const merge = await teamTransfer.stageMerge(receipt.projectRoot, {
        ...delta,
        destinationTree: tree,
        headSha: before.headSha,
        path: scratch,
        refPrefix: `refs/openorc/moves/${receipt.id}/merged-${path.basename(scratch)}`,
      });
      assertCurrent();
      if (merge.status === "conflict")
        throw new Error(`The move has conflicts at ${scratch}: ${merge.conflicts.join(", ")}. Cancel this move to keep the original workspace, then resolve the source changes before trying again.`);
      tree = merge.treeSha;
    }
    const [beforeEntries, afterEntries] = await Promise.all([teamTransfer.listTree(receipt.projectRoot, before.treeSha), teamTransfer.listTree(receipt.projectRoot, tree)]);
    const previous = new Map(beforeEntries.map((item) => [item.path, item]));
    const next = new Map(afterEntries.map((item) => [item.path, item]));
    const entries = [...new Set([...previous.keys(), ...next.keys()])]
      .sort()
      .flatMap((file) => (sameTreeEntry(previous.get(file), next.get(file)) ? [] : [{ path: file, before: previous.get(file) ?? null, after: next.get(file) ?? null }]));
    receipt = teamMoves.plan(this.db, receipt.id, { afterTree: tree, entries });
    return receipt;
  }

  private finalizeMove(receipt: TeamMoveRecord, target: string): Thread {
    const result = this.db.transaction(() => {
      const moved = threads.update(this.db, receipt.threadId, {
        workspaceMode: receipt.to,
        worktreePath: receipt.to === "current" ? null : target,
        baseSha: (receipt.destinationBefore ?? receipt.source).headSha,
        branch: receipt.publicationBranch,
      })!;
      const context = teamContexts.create(this.db, {
        instanceId: receipt.instanceId,
        executionId: null,
        actorId: "lead",
        originExecutionId: null,
        reason: "compact",
        requestKey: `move:${receipt.id}`,
        seed: receipt.seed,
      });
      teamMoves.apply(this.db, receipt.id, { path: target, contextCheckpointId: context.id });
      audit.record(this.db, { actor: "user", action: "team.move", resourceType: "thread", resourceId: receipt.threadId, metadata: { receiptId: receipt.id, to: receipt.to } });
      return moved;
    });
    this.changed(receipt.threadId);
    return result;
  }

  private localInverseDeltas(instanceId: string, projectRoot: string, origin: TeamMoveRecord | null): { baseTree: string; outputTree: string }[] {
    const epoch = origin ? teamContexts.get(this.db, origin.appliedContextId!)!.epoch : null;
    const deltas: { baseTree: string; outputTree: string }[] = [];
    for (const execution of teamContextExecutions(this.db, instanceId).reverse()) {
      const local = teamWorkspaces.get(this.db, execution.id, "lead");
      if (!local || local.path !== projectRoot || !local.preparedTree) continue;
      const attempts = execution.attempts.filter(
        (item) =>
          (item.actorId === "lead" || (!origin && execution.actors.find((actor) => actor.id === item.actorId)?.participant)) &&
          (epoch === null || (item.contextCheckpointId && (teamContexts.get(this.db, item.contextCheckpointId)?.epoch ?? 0) >= epoch)),
      );
      if (!attempts.length) continue;
      const checkpoint = attempts.at(-1)?.snapshotId;
      const output = local.outputTree ?? (checkpoint ? checkpoints.get(this.db, checkpoint)?.treeSha : null);
      if (!output) throw new Error("A local lead turn has no verified final files. Preserve its changes and finish its recovery before moving.");
      deltas.push({ baseTree: output, outputTree: local.preparedTree });
    }
    if (origin) deltas.push({ baseTree: origin.afterTree!, outputTree: origin.destinationBefore!.treeSha });
    return deltas;
  }

  cancel(threadId: string, requestKey: string): Promise<CancelResult> {
    if (this.closing) return Promise.reject(new Error("Team moves are shutting down."));
    const key = JSON.stringify([threadId, requestKey]);
    if (this.operations.has(key)) return Promise.reject(new Error("Wait for the current move operation to finish before cancelling it."));
    const promise = this.performCancel(threadId, requestKey).finally(() => this.operations.delete(key));
    this.operations.set(key, { hash: "cancel", promise });
    return promise;
  }

  private async performCancel(threadId: string, requestKey: string): Promise<CancelResult> {
    let receipt = teamMoves.find(this.db, threadId, requestKey);
    if (!receipt) throw new Error("The retained move was not found. Retry its original request to confirm its outcome.");
    if (receipt.state === "cancelled") return { state: "cancelled" };
    if (receipt.state === "applied") return { state: "applied" };
    const reservation = this.guard.reserve(threadId, receipt.id);
    let lease: WorkspaceLease | undefined,
      keepFence = false;
    try {
      lease = this.fences.get(receipt.id) ?? (await this.writers.acquire([receipt.sourcePath, receipt.projectRoot], `Cancel team move ${receipt.id}`));
      reservation.assertCurrent();
      receipt = teamMoves.requestCancel(this.db, receipt.id);
      if (receipt.publication)
        await publishTeamFiles(
          {
            id: receipt.id,
            destinationPath: receipt.projectRoot,
            before: receipt.destinationBefore ?? receipt.source,
            entries: receipt.publication.entries.map((entry) => ({ path: entry.path, before: entry.after, after: entry.before })),
          },
          () => reservation.assertCurrent(),
        );
      reservation.assertCurrent();
      this.db.transaction(() => {
        teamMoves.cancel(this.db, receipt!.id);
        audit.record(this.db, { actor: "user", action: "team.move.cancel", resourceType: "thread", resourceId: threadId, metadata: { receiptId: receipt!.id } });
      });
      await this.hooks.fault?.("cancelled", teamMoves.get(this.db, receipt.id)!);
      return { state: "cancelled" };
    } catch (error) {
      if (teamMoves.get(this.db, receipt.id)?.state !== "cancelled") {
        teamMoves.attention(this.db, receipt.id, message(error));
        if (receipt.publication && lease) {
          this.fences.set(receipt.id, lease);
          keepFence = true;
        }
      }
      throw error;
    } finally {
      if (!keepFence) {
        this.fences.delete(receipt.id);
        lease?.release();
      }
      reservation.release();
      this.changed(threadId);
    }
  }

  async recover(): Promise<void> {
    for (const receipt of teamMoves.list(this.db))
      if (!["applied", "cancelled"].includes(receipt.state) && receipt.publication && !this.fences.has(receipt.id)) {
        this.fences.set(receipt.id, await this.writers.acquire([receipt.sourcePath, receipt.projectRoot], `Recover team move ${receipt.id}`));
        teamMoves.attention(this.db, receipt.id, "The move was interrupted. Retry its recorded transfer or cancel it to restore only its recorded changes.");
      }
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.operations.values()].map((item) => item.promise));
    for (const lease of this.fences.values()) lease.release();
    this.fences.clear();
  }
}
