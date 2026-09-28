import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { audit, orchestration, projects, teamContextParts, teamContexts, teamForks, teamOrigins, teamRoom, teamRuntime, teamWorkspaces, threads, type Db, type TeamForkRecord } from "@openorc/db";
import { TeamRoomService } from "./team-room.js";
import { teamTransfer } from "@openorc/git";
import type { TeamActionAvailability, Thread } from "@openorc/protocol";
import { buildTeamForkSeed } from "./team-context.js";
import { teamCheckoutBase } from "./team-checkout-base.js";
import { TeamOperationGuard } from "./team-operations.js";
import { teamWorkspaceLocation } from "./team-workspace-location.js";
import { TeamWorkspaceSnapshots } from "./team-workspace-snapshots.js";
import { WorkspaceWriters } from "./workspace-writers.js";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
interface ForkInput {
  threadId: string;
  upToRunId?: string;
  requestKey: string;
}
type ForkResult = Thread | { rejected: string };
export interface TeamForkHooks {
  fault?(point: "retained" | "materialized" | "applied", record: TeamForkRecord): Promise<void> | void;
}

/** A fork starts with independent files and public context, never a copied provider session. */
export class TeamForkService {
  private readonly operations = new Map<string, { hash: string; promise: Promise<ForkResult> }>();
  private readonly snapshots: TeamWorkspaceSnapshots;
  private closing = false;
  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    private readonly guard: TeamOperationGuard,
    private readonly writers: WorkspaceWriters,
    private readonly changed: (threadId: string) => void,
    private readonly hooks: TeamForkHooks = {},
  ) {
    this.snapshots = new TeamWorkspaceSnapshots(db, writers);
  }

  availability(threadId: string): TeamActionAvailability {
    try {
      const pending = teamForks.pendingForThread(this.db, threadId);
      const reason = this.guard.reason(threadId, pending[0]?.id);
      if (reason) throw new Error(reason);
      teamWorkspaceLocation(this.db, threadId);
      return { allowed: true, reason: null };
    } catch (error) {
      return { allowed: false, reason: errorText(error) };
    }
  }

  fork(input: ForkInput): Promise<ForkResult> {
    if (this.closing) return Promise.reject(new Error("Team forks are shutting down."));
    if (!input.requestKey.trim() || input.requestKey.length > 200) return Promise.reject(new Error("A team fork requires a bounded request key."));
    const key = JSON.stringify([input.threadId, input.requestKey]);
    const hash = createHash("sha256")
      .update(JSON.stringify([input.threadId, input.upToRunId ?? null]))
      .digest("hex");
    const previous = this.operations.get(key);
    if (previous) return previous.hash === hash ? previous.promise : Promise.reject(new Error("This fork key already identifies different work."));
    const promise = this.perform(input, hash)
      .catch((error) => {
        // A retained admission may have written files or created its child. Only
        // a durable negative receipt proves that a request cannot later apply.
        if (teamForks.find(this.db, input.threadId, input.requestKey)) throw error;
        const previous = teamForks.rejection(this.db, input.threadId, input.requestKey);
        if (previous) {
          if (previous.requestHash !== hash) throw error;
          return { rejected: previous.error };
        }
        const rejection = teamForks.reject(this.db, { sourceThreadId: input.threadId, requestKey: input.requestKey, requestHash: hash, error: errorText(error) });
        return { rejected: rejection.error };
      })
      .finally(() => this.operations.delete(key));
    this.operations.set(key, { hash, promise });
    return promise;
  }

  cancel(threadId: string, requestKey: string): { state: "cancelled" | "applied" } {
    if (this.closing || this.operations.has(JSON.stringify([threadId, requestKey]))) throw new Error("Wait for the current fork request to finish.");
    const receipt = teamForks.find(this.db, threadId, requestKey);
    if (!receipt) throw new Error("The fork request was not found. Refresh team status.");
    if (receipt.state === "applied" || receipt.state === "cancelled") return { state: receipt.state };
    const reservation = this.guard.reserve(threadId, receipt.id);
    try {
      teamForks.cancel(this.db, receipt.id);
      audit.record(this.db, { actor: "user", action: "team.fork.cancel", resourceType: "thread", resourceId: threadId, metadata: { receiptId: receipt.id, retainedPaths: receipt.paths } });
      return { state: "cancelled" };
    } finally {
      reservation.release();
      this.changed(threadId);
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    // Include negative receipt writes after the workspace reservation releases.
    await Promise.allSettled([...this.operations.values()].map((operation) => operation.promise));
  }

  private resolveRequest(input: ForkInput, hash: string): { receipt: TeamForkRecord | null } | { result: ForkResult } {
    const rejected = teamForks.rejection(this.db, input.threadId, input.requestKey);
    if (rejected) {
      if (rejected.requestHash !== hash) throw new Error("This fork key already identifies different work.");
      return { result: { rejected: rejected.error } };
    }
    const receipt = teamForks.find(this.db, input.threadId, input.requestKey);
    if (receipt && receipt.requestHash !== hash) throw new Error("This fork key already identifies different work.");
    if (receipt?.state === "cancelled") return { result: { rejected: "This fork was cancelled. Its saved files were kept. Start a new request to try again." } };
    if (receipt?.state === "applied") return { result: this.result(receipt) };
    return { receipt };
  }

  private async perform(input: ForkInput, hash: string): Promise<ForkResult> {
    const resolved = this.resolveRequest(input, hash);
    if ("result" in resolved) return resolved.result;
    let { receipt } = resolved;
    const operationId = receipt?.id ?? randomUUID();
    const reservation = this.guard.reserve(input.threadId, operationId);
    try {
      const source = threads.get(this.db, input.threadId)!;
      const instance = orchestration.getInstance(this.db, input.threadId)!;
      const project = projects.get(this.db, source.projectId)!;
      if (!receipt) {
        const context = buildTeamForkSeed(this.db, source.id, input.upToRunId);
        const captured = await this.snapshots.capture(source.id, `refs/openorc/forks/${operationId}/input`, () => reservation.assertCurrent());
        let snapshot = captured.snapshot;
        let baselinePath = snapshot.rootPath;
        let baselineEpoch = Infinity;
        if (input.upToRunId) {
          const binding = teamRuntime.binding(this.db, input.upToRunId);
          const execution = binding && teamRuntime.get(this.db, binding.executionId);
          const attempt = execution?.attempts.find((item) => item.id === binding?.attemptId);
          if (!attempt?.snapshotId) throw new Error("The selected lead turn has no retained file checkpoint. Choose another turn or fork the current workspace.");
          const checkpoint = await this.snapshots.verifiedCheckpoint(source.id, attempt.snapshotId, input.upToRunId);
          baselinePath = teamWorkspaces.get(this.db, execution!.id, "lead")!.path;
          baselineEpoch = attempt.contextCheckpointId ? (teamContexts.get(this.db, attempt.contextCheckpointId)?.epoch ?? 0) : 0;
          const treeRef = `refs/openorc/forks/${operationId}/cutoff/tree`;
          await teamTransfer.retainTree(project.rootPath, checkpoint.treeSha, treeRef);
          reservation.assertCurrent();
          snapshot = { ...snapshot, headSha: checkpoint.headSha, headRef: checkpoint.headRef, treeSha: checkpoint.treeSha, treeRef, branch: null };
        }
        const checkoutBaseTree = await teamCheckoutBase(this.db, source.id, baselinePath, snapshot.treeSha, baselineEpoch);
        if (checkoutBaseTree) await teamTransfer.retainTree(project.rootPath, checkoutBaseTree, `refs/openorc/forks/${operationId}/checkout-base`);
        reservation.assertCurrent();
        receipt = teamForks.create(this.db, {
          id: operationId,
          sourceThreadId: source.id,
          sourceInstanceId: instance.id,
          projectId: project.id,
          projectRoot: project.rootPath,
          requestKey: input.requestKey,
          requestHash: hash,
          upToRunId: input.upToRunId ?? null,
          destinationThreadId: randomUUID(),
          snapshot,
          setupInput: captured.setupInput,
          checkoutBaseTree,
          seed: context.seed,
          sourceRunId: context.sourceRunId,
          teamRevisionId: instance.teamRevisionId,
          leadOverrides: instance.leadOverrides,
          thread: { title: source.title, agent: source.agent, model: source.model, effort: source.effort, fastMode: source.fastMode, mode: source.mode, permissionMode: source.permissionMode },
        });
        this.changed(source.id);
      }
      if (receipt.sourceInstanceId !== instance.id || receipt.projectId !== project.id || receipt.projectRoot !== project.rootPath)
        throw new Error("The fork's original project or team changed. Its captured files are retained for recovery.");
      await this.hooks.fault?.("retained", receipt);
      reservation.assertCurrent();
      // Every uncertain attempt keeps its directory. Recovery always uses a new
      // candidate rather than overwriting files a user may already have edited.
      const destination = path.join(this.dataDir, "team-forks", receipt.id, randomUUID());
      receipt = teamForks.appendPath(this.db, receipt.id, destination);
      const accepted = receipt;
      return await this.writers.withLease(destination, `Materialize team fork ${receipt.id}`, async () => {
        reservation.assertCurrent();
        await this.snapshots.materialize(
          project.rootPath,
          { snapshot: accepted.snapshot, setupInput: accepted.setupInput, path: destination, refPrefix: `refs/openorc/forks/${accepted.id}/verified-${path.basename(destination)}` },
          () => reservation.assertCurrent(),
        );
        await this.hooks.fault?.("materialized", accepted);
        reservation.assertCurrent();
        const child = this.db.transaction(() => {
          const thread = threads.insert(this.db, {
            id: accepted.destinationThreadId,
            projectId: accepted.projectId,
            ...accepted.thread,
            title: `${accepted.thread.title} (fork)`,
            workspaceMode: "worktree",
          });
          const pinned = orchestration.createInstance(this.db, { threadId: thread.id, teamRevisionId: accepted.teamRevisionId, initialLeadOverrides: accepted.leadOverrides }, { allowArchived: true });
          teamOrigins.create(this.db, {
            instanceId: pinned.id,
            sourceThreadId: accepted.sourceThreadId,
            sourceInstanceId: accepted.sourceInstanceId,
            sourceRunId: accepted.sourceRunId,
            seed: accepted.seed,
          });
          teamContextParts.adopt(this.db, { from: accepted.sourceInstanceId, to: pinned.id, seed: accepted.seed });
          // The fork's room is the source room up to the reply it was taken from; later messages belong to the source alone.
          new TeamRoomService(this.db).ensureMigrated(accepted.sourceInstanceId);
          const sourceAttempt = accepted.sourceRunId ? teamRuntime.binding(this.db, accepted.sourceRunId)?.attemptId : undefined;
          const throughSeq = (sourceAttempt ? teamRoom.seqOf(this.db, accepted.sourceInstanceId, `reply:${sourceAttempt}`) : null) ?? teamRoom.latestSeq(this.db, accepted.sourceInstanceId);
          teamRoom.adopt(this.db, { from: accepted.sourceInstanceId, to: pinned.id, throughSeq, requestKeyPrefix: `fork:${accepted.id}` });
          teamContexts.create(this.db, {
            instanceId: pinned.id,
            executionId: null,
            actorId: "lead",
            originExecutionId: null,
            reason: "compact",
            requestKey: `fork:${accepted.id}`,
            seed: accepted.seed,
          });
          const ready = threads.update(this.db, thread.id, { worktreePath: destination, baseSha: accepted.snapshot.headSha, branch: null })!;
          teamForks.apply(this.db, accepted.id, destination);
          audit.record(this.db, {
            actor: "user",
            action: "team.fork",
            resourceType: "thread",
            resourceId: thread.id,
            metadata: { sourceThreadId: accepted.sourceThreadId, sourceRunId: accepted.sourceRunId, receiptId: accepted.id },
          });
          return ready;
        });
        this.changed(child.id);
        await this.hooks.fault?.("applied", teamForks.get(this.db, accepted.id)!);
        return child;
      });
    } catch (error) {
      if (receipt && teamForks.get(this.db, receipt.id)?.state !== "applied") teamForks.attention(this.db, receipt.id, errorText(error));
      throw error;
    } finally {
      reservation.release();
      this.changed(input.threadId);
    }
  }

  private result(receipt: TeamForkRecord): ForkResult {
    const thread = threads.get(this.db, receipt.destinationThreadId);
    if (!thread) return { rejected: "This fork was already created and later deleted. Start a new fork request to create another." };
    return thread;
  }
}
