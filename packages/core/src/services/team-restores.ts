import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { audit, orchestration, projects, teamContexts, teamRestores, threads, type Db, type TeamRestoreRecord } from "@openorc/db";
import { teamTransfer } from "@openorc/git";
import { TeamContextSeed, type TeamActionAvailability } from "@openorc/protocol";
import { buildTeamContextSeed, restoredWorkspaceContext } from "./team-context.js";
import { TeamOperationGuard } from "./team-operations.js";
import { teamWorkspaceLocation } from "./team-workspace-location.js";
import { TeamWorkspaceSnapshots } from "./team-workspace-snapshots.js";
import { WorkspaceWriters } from "./workspace-writers.js";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
interface RestoreInput {
  threadId: string;
  checkpointId: string;
  requestKey: string;
}
type RestoreResult = null | { rejected: string };
export interface TeamRestoreHooks {
  fault?(point: "retained" | "materialized" | "applied", record: TeamRestoreRecord): Promise<void> | void;
}

/** Restore through a new verified workspace; previous files and Git history stay intact. */
export class TeamRestoreService {
  private readonly operations = new Map<string, { hash: string; promise: Promise<RestoreResult> }>();
  private readonly snapshots: TeamWorkspaceSnapshots;
  private closing = false;

  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    private readonly guard: TeamOperationGuard,
    private readonly writers: WorkspaceWriters,
    private readonly changed: (threadId: string) => void,
    private readonly hooks: TeamRestoreHooks = {},
  ) {
    this.snapshots = new TeamWorkspaceSnapshots(db, writers);
  }

  availability(threadId: string): TeamActionAvailability {
    try {
      const pending = teamRestores.pendingForThread(this.db, threadId);
      const reason = this.guard.reason(threadId, pending[0]?.id);
      if (reason) throw new Error(reason);
      teamWorkspaceLocation(this.db, threadId);
      return { allowed: true, reason: null };
    } catch (error) {
      return { allowed: false, reason: errorText(error) };
    }
  }

  restore(input: RestoreInput): Promise<RestoreResult> {
    if (this.closing) return Promise.reject(new Error("Team restores are shutting down."));
    if (!input.requestKey.trim() || input.requestKey.length > 200) return Promise.reject(new Error("A team restore requires a bounded request key."));
    if (!input.checkpointId.trim()) return Promise.reject(new Error("Choose a file checkpoint to restore."));
    const key = JSON.stringify([input.threadId, input.requestKey]);
    const hash = createHash("sha256")
      .update(JSON.stringify([input.threadId, input.checkpointId]))
      .digest("hex");
    const previous = this.operations.get(key);
    if (previous) return previous.hash === hash ? previous.promise : Promise.reject(new Error("This restore key already identifies different work."));
    const promise = this.perform(input, hash)
      .catch((error) => {
        // Absence alone is not a client-visible rejection. Retain an immutable
        // negative receipt so a delayed duplicate can never later apply this key.
        if (teamRestores.find(this.db, input.threadId, input.requestKey)) throw error;
        const rejection = teamRestores.reject(this.db, { threadId: input.threadId, requestKey: input.requestKey, requestHash: hash, error: errorText(error) });
        return { rejected: rejection.error };
      })
      .finally(() => this.operations.delete(key));
    this.operations.set(key, { hash, promise });
    return promise;
  }

  cancel(threadId: string, requestKey: string): { state: "cancelled" | "applied" } {
    if (this.closing || this.operations.has(JSON.stringify([threadId, requestKey]))) throw new Error("Wait for the current restore request to finish.");
    const receipt = teamRestores.find(this.db, threadId, requestKey);
    if (!receipt) throw new Error("The restore request was not found. Refresh team status.");
    if (receipt.state === "applied" || receipt.state === "cancelled") return { state: receipt.state };
    const reservation = this.guard.reserve(threadId, receipt.id);
    try {
      teamRestores.cancel(this.db, receipt.id);
      audit.record(this.db, { actor: "user", action: "team.restore.cancel", resourceType: "thread", resourceId: threadId, metadata: { receiptId: receipt.id, retainedPaths: receipt.paths } });
      return { state: "cancelled" };
    } finally {
      reservation.release();
      this.changed(threadId);
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    // Negative receipts are written after failed admission as well as inside
    // admitted operations; drain both before closing the database.
    await Promise.allSettled([...this.operations.values()].map((operation) => operation.promise));
  }

  private resolveRequest(input: RestoreInput, hash: string): { receipt: TeamRestoreRecord | null } | { result: RestoreResult } {
    const rejected = teamRestores.rejection(this.db, input.threadId, input.requestKey);
    if (rejected) {
      if (rejected.requestHash !== hash) throw new Error("This restore key already identifies different work.");
      return { result: { rejected: rejected.error } };
    }
    const receipt = teamRestores.find(this.db, input.threadId, input.requestKey);
    if (receipt && receipt.requestHash !== hash) throw new Error("This restore key already identifies different work.");
    // A response replay must never restore again after later work or add an epoch.
    if (receipt?.state === "cancelled") return { result: { rejected: "This restore was cancelled. Its saved files were kept. Start a new request to try again." } };
    if (receipt?.state === "applied") return { result: null };
    return { receipt };
  }

  private async perform(input: RestoreInput, hash: string): Promise<RestoreResult> {
    const resolved = this.resolveRequest(input, hash);
    if ("result" in resolved) return resolved.result;
    let { receipt } = resolved;
    const operationId = receipt?.id ?? randomUUID();
    const reservation = this.guard.reserve(input.threadId, operationId);
    try {
      const thread = threads.get(this.db, input.threadId)!;
      const instance = orchestration.getInstance(this.db, input.threadId)!;
      const project = projects.get(this.db, thread.projectId)!;
      const location = teamWorkspaceLocation(this.db, thread.id);
      if (!receipt) {
        const target = await this.snapshots.verifiedCheckpoint(thread.id, input.checkpointId);
        reservation.assertCurrent();
        const before = await this.snapshots.capture(thread.id, `refs/openorc/restores/${operationId}/before`, () => reservation.assertCurrent());
        reservation.assertCurrent();
        await teamTransfer.retainTree(project.rootPath, target.treeSha, `refs/openorc/restores/${operationId}/target/tree`);
        reservation.assertCurrent();
        const context = JSON.parse(buildTeamContextSeed(this.db, { instanceId: instance.id, executionId: null, actorId: "lead" })) as Record<string, unknown>;
        const seed = TeamContextSeed.parse(
          JSON.stringify({
            ...context,
            restoredWorkspace: restoredWorkspaceContext({
              checkpointId: input.checkpointId,
              sourceRunId: target.sourceRunId,
              targetTree: target.treeSha,
              before: before.snapshot,
            }),
          }),
        );
        receipt = teamRestores.create(this.db, {
          id: operationId,
          threadId: thread.id,
          instanceId: instance.id,
          projectId: project.id,
          projectRoot: project.rootPath,
          requestKey: input.requestKey,
          requestHash: hash,
          checkpointId: input.checkpointId,
          sourceRunId: target.sourceRunId,
          sourcePath: location.path,
          before: before.snapshot,
          targetTree: target.treeSha,
          setupInput: before.setupInput,
          seed,
        });
        this.changed(thread.id);
      }
      if (receipt.instanceId !== instance.id || receipt.projectId !== project.id || receipt.projectRoot !== project.rootPath || receipt.sourcePath !== location.path)
        throw new Error("The restore's original project, team or workspace changed. Its captured files were preserved for recovery.");
      await this.hooks.fault?.("retained", receipt);
      reservation.assertCurrent();
      // A failed candidate may contain user recovery edits; never write to it again.
      const destination = path.join(this.dataDir, "team-restores", receipt.id, randomUUID());
      receipt = teamRestores.appendPath(this.db, receipt.id, destination);
      const accepted = receipt;
      await this.writers.withLease(destination, `Materialize team restore ${accepted.id}`, async () => {
        reservation.assertCurrent();
        await this.snapshots.materialize(
          project.rootPath,
          {
            snapshot: { ...accepted.before, treeSha: accepted.targetTree, treeRef: `refs/openorc/restores/${accepted.id}/target/tree`, branch: null },
            setupInput: accepted.setupInput,
            path: destination,
            refPrefix: `refs/openorc/restores/${accepted.id}/verified-${path.basename(destination)}`,
          },
          () => reservation.assertCurrent(),
        );
        await this.hooks.fault?.("materialized", accepted);
        reservation.assertCurrent();
        this.db.transaction(() => {
          threads.update(this.db, accepted.threadId, {
            workspaceMode: "worktree",
            worktreePath: destination,
            baseSha: accepted.before.headSha,
            ...(accepted.sourcePath === accepted.projectRoot ? { branch: `openorc/team-${accepted.threadId}-restore-${accepted.id}` } : {}),
          });
          const context = teamContexts.create(this.db, {
            instanceId: accepted.instanceId,
            executionId: null,
            actorId: "lead",
            originExecutionId: null,
            reason: "compact",
            requestKey: `restore:${accepted.id}`,
            seed: accepted.seed,
          });
          teamRestores.apply(this.db, accepted.id, { path: destination, contextCheckpointId: context.id });
          audit.record(this.db, {
            actor: "user",
            action: "team.restore",
            resourceType: "thread",
            resourceId: accepted.threadId,
            metadata: { receiptId: accepted.id, checkpointId: accepted.checkpointId, treeSha: accepted.targetTree, contextCheckpointId: context.id },
          });
        });
        this.changed(accepted.threadId);
        await this.hooks.fault?.("applied", teamRestores.get(this.db, accepted.id)!);
      });
      return null;
    } catch (error) {
      if (receipt && teamRestores.get(this.db, receipt.id)?.state !== "applied") teamRestores.attention(this.db, receipt.id, errorText(error));
      throw error;
    } finally {
      reservation.release();
      this.changed(input.threadId);
    }
  }
}
