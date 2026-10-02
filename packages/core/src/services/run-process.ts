import { runs, type Db } from "@openorc/db";
import type { AgentEvent, Project } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import type { LiveProcessBinding, LiveRun } from "./run-types.js";

/** Binds one process, serializes its events, and retains the physical lease through finalization. */
interface RunProcessDependencies {
  db: Db;
  log: Logger;
  attach: (entry: LiveRun) => void;
  finalizations: Set<Promise<void>>;
  denyApprovals: (runId: string) => void;
  watchDiffs: (entry: LiveRun, project: Project) => void;
  publishProviderEvent: (entry: LiveRun, event: AgentEvent) => AgentEvent;
  onEvent: (entry: LiveRun, project: Project, event: AgentEvent) => Promise<void>;
  onExit: (entry: LiveRun, project: Project) => Promise<void>;
}

export class RunProcess {
  constructor(private readonly deps: RunProcessDependencies) {}

  bindLiveProcess({ run, input, handle, workspaceLease, internalMcp, providerPermissionMode, permissionGate }: LiveProcessBinding): void {
    const runId = run.id;
    const { scope, project } = input;
    let finishFinalization!: () => void;
    let failFinalization!: (error: unknown) => void;
    const finalized = new Promise<void>((resolve, reject) => {
      finishFinalization = resolve;
      failFinalization = reject;
    });
    // The explicit barrier reports failures to waiters; the logger also handles fire-and-forget closes.
    void finalized.catch(() => {});
    const entry: LiveRun = {
      run,
      internalMcp,
      providerPermissionMode,
      ...(permissionGate ? { permissionGate } : {}),
      scope,
      handle,
      workspaceLease,
      usage: null,
      turns: 0,
      busy: true,
      background: 0,
      commands: [],
      steerable: false,
      lastAgentEventAt: null,
      prompt: input.promptRole === "system" ? null : input.prompt,
      reply: null,
      started: false,
      team: Boolean(input.teamAttemptId),
      stderr: [],
      failed: null,
      events: Promise.resolve(),
      finalized,
      finishFinalization,
      failFinalization,
      exiting: false,
      closingRequested: false,
    };
    this.deps.attach(entry);
    this.deps.watchDiffs(entry, project);
    handle.on("event", (ev: AgentEvent) => {
      if (entry.exiting) return;
      // Progress reads and renderer frames observe provider events immediately.
      // Only state transitions and asynchronous capture belong behind the barrier.
      let published: AgentEvent;
      try {
        published = this.deps.publishProviderEvent(entry, ev);
      } catch (error) {
        entry.failed = error instanceof Error ? error.message : String(error);
        runs.update(this.deps.db, runId, { error: entry.failed });
        this.deps.log.error(`run ${runId} event publication failed: ${entry.failed}`);
        return;
      }
      entry.events = entry.events
        .then(() => this.deps.onEvent(entry, project, published))
        .catch((error) => {
          entry.failed = error instanceof Error ? error.message : String(error);
          runs.update(this.deps.db, runId, { error: entry.failed });
          this.deps.log.error(`run ${runId} event finalization failed: ${entry.failed}`);
        });
    });
    const finalize = () => {
      if (entry.exiting) return;
      entry.exiting = true;
      this.deps.denyApprovals(runId);
      // An exit notification can precede closed stdio/process completion.
      // Keep the physical writer until both the process and capture barrier settle.
      const finished = Promise.all([entry.events, handle.wait()]).then(() => this.deps.onExit(entry, project));
      this.deps.finalizations.add(finished);
      void finished
        .then(
          () => entry.finishFinalization(),
          (error) => {
            this.deps.log.error(String(error));
            entry.failFinalization(error);
          },
        )
        .finally(() => this.deps.finalizations.delete(finished));
    };
    handle.once("exit", finalize);
    // RunHandle's process barrier also covers a transport that only resolves done.
    void handle.wait().then(finalize, (error) => {
      entry.failed = String(error);
      finalize();
    });
  }
}
