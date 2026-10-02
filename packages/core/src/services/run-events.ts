import { runs, type Db } from "@openorc/db";
import { harnessName, type AgentEvent, type Project } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import { occupied, working, type CompletedTurn, type LiveRun, type RunHooks, type RunScope } from "./run-types.js";

/** Tools that only read. Any other tool, including one this list does not know, may have changed files. */
const READ_ONLY_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebFetch",
  "WebSearch",
  "ToolSearch",
  "TodoWrite",
  "AskUserQuestion",
  "ExitPlanMode",
  "read",
  "search",
  "grep",
  "glob",
  "list",
  "webfetch",
  "todowrite",
  "todoread",
]);
/** Provider events publish synchronously; state transitions and capture follow the ordered barrier. */
interface RunEventsDependencies {
  db: Db;
  log: Logger;
  hooks: Pick<RunHooks, "onProviderEvent" | "onSteerable" | "onThreadIdle">;
  emit: (event: AgentEvent) => void;
  invalidate: (keys: string[]) => void;
  keysFor: (scope: RunScope) => string[];
  denyApprovals: (runId: string) => void;
  canSteer: (runId: string) => boolean;
  disarmIdle: (runId: string) => void;
  armIdle: (entry: LiveRun) => void;
  refreshDiffs: (entry: LiveRun, project: Project) => void;
  completeTurn: (entry: LiveRun, project: Project, turn: CompletedTurn) => Promise<void>;
}

export class RunEvents {
  constructor(private readonly deps: RunEventsDependencies) {}

  publishProviderEvent(entry: LiveRun, ev: AgentEvent): AgentEvent {
    if (ev.type === "turn.completed" || ev.type === "session.completed") {
      entry.questionsInterrupted = true;
      this.deps.denyApprovals(entry.run.id);
    }
    // Every provider event funnels through here, so this is the one place that
    // knows the agent is still producing output mid-turn.
    entry.lastAgentEventAt = Date.now();
    this.deps.hooks.onProviderEvent?.(ev);
    const steerable = this.deps.canSteer(entry.run.id);
    if (steerable !== entry.steerable) {
      entry.steerable = steerable;
      if (steerable) this.deps.hooks.onSteerable?.(entry.run.id);
      this.deps.invalidate(this.deps.keysFor(entry.scope));
    }
    if (ev.type === "tool.started" || ev.type === "tool.completed") {
      // Keep the per-process connection identity out of user-facing tool labels.
      // Approval classification always uses the original provider identity instead.
      const rawName = ev.name;
      const tool = entry.internalMcp.toolNames.find((name) => rawName === `${entry.internalMcp.serverName}.${name}` || rawName === `mcp__${entry.internalMcp.serverName}__${name}`);
      if (tool) ev = { ...ev, name: `openorc.${tool}` };
    }
    this.deps.emit(ev);
    return ev;
  }

  async onEvent(entry: LiveRun, project: Project, ev: AgentEvent): Promise<void> {
    switch (ev.type) {
      case "session.started":
        this.onSessionStarted(entry, ev);
        return;
      case "usage.updated":
        entry.usage = { ...entry.usage, ...ev.usage };
        return;
      case "message.completed":
        if (ev.role === "assistant") entry.reply = ev.text;
        return;
      case "error":
        this.onError(entry, ev);
        return;
      case "turn.started":
        this.onTurnStarted(entry);
        return;
      case "background.updated":
        this.onBackgroundUpdated(entry, project, ev);
        return;
      case "activity.updated":
        // Codex reports its turn's changes as they grow; a Claude background task that ends may have written files.
        this.onActivityUpdated(entry, project, ev);
        return;
      case "tool.completed":
        this.onToolCompleted(entry, project, ev.name);
        return;
      case "turn.completed":
        await this.deps.completeTurn(entry, project, ev);
        return;
      default:
        return;
    }
  }

  private onSessionStarted(entry: LiveRun, ev: Extract<AgentEvent, { type: "session.started" }>): void {
    entry.started = true;
    this.deps.log.info(`run ${entry.run.id} session started ${Date.now() - entry.run.startedAt} ms after the run was created`);
    this.deps.emit({
      type: "activity.updated",
      runId: entry.run.id,
      ts: Date.now(),
      activityId: "startup",
      label: `Starting ${harnessName(entry.run.agent)}`,
      status: "success",
    });
    // The requested model wins; the adapter's report is a fallback for runs that did not name one.
    runs.update(this.deps.db, entry.run.id, { state: "running", externalSessionId: ev.externalSessionId, model: entry.run.model ?? ev.model });
    this.deps.invalidate(this.deps.keysFor(entry.scope));
  }

  private onError(entry: LiveRun, ev: Extract<AgentEvent, { type: "error" }>): void {
    if (ev.fatal) {
      entry.failed = ev.message;
      runs.update(this.deps.db, entry.run.id, { error: ev.message });
      return;
    }
    entry.stderr.push(ev.message);
    if (entry.stderr.length > 20) entry.stderr.shift();
  }

  private onTurnStarted(entry: LiveRun): void {
    // Input queued during a turn, or background work that finished, starts the next one without a send() from the app.
    this.deps.disarmIdle(entry.run.id);
    if (entry.busy) return;
    entry.busy = true;
    entry.questionsInterrupted = false;
    this.deps.invalidate(this.deps.keysFor(entry.scope));
  }

  private onBackgroundUpdated(entry: LiveRun, project: Project, ev: Extract<AgentEvent, { type: "background.updated" }>): void {
    const was = { working: working(entry), occupied: occupied(entry) };
    entry.background = ev.running;
    entry.commands = ev.commands ?? [];
    // The thread shows whether its agent is at work and which commands still run.
    this.deps.invalidate(this.deps.keysFor(entry.scope));
    if (was.working && !working(entry)) this.deps.refreshDiffs(entry, project);
    if (!was.occupied && occupied(entry)) this.deps.disarmIdle(entry.run.id);
    if (entry.exiting || entry.closingRequested) return;
    // What ran ended with no turn to report on it, as when the user stops it.
    if (was.occupied && !occupied(entry)) this.deps.armIdle(entry);
    if (was.working && !working(entry) && entry.scope.thread) this.deps.hooks.onThreadIdle?.(entry.scope.thread);
  }

  private onActivityUpdated(entry: LiveRun, project: Project, ev: Extract<AgentEvent, { type: "activity.updated" }>): void {
    if (ev.activityId.startsWith("diff-") || (ev.activityId.startsWith("task-") && ev.status !== "running")) this.deps.refreshDiffs(entry, project);
  }

  private onToolCompleted(entry: LiveRun, project: Project, name: string): void {
    if (!READ_ONLY_TOOLS.has(name) && !name.startsWith("openorc.")) this.deps.refreshDiffs(entry, project);
  }
}
