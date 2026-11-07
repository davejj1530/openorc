import { harnessShortName, type AgentEvent } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import type { LiveRun, Notification, RunHooks, RunScope } from "./run-types.js";

export function runScopeKeys(scope: RunScope): string[] {
  if (scope.comment) return [`task-comments:${scope.comment.task.id}`];
  if (scope.task) return ["tasks", "inbox", `task:${scope.task.id}`, `runs:${scope.task.id}`, ...(scope.task.threadId ? ["threads", `thread:${scope.task.threadId}`] : [])];
  return ["threads", `thread:${scope.thread.id}`, `runs:thread:${scope.thread.id}`, "inbox"];
}

export function runScopeTitle(scope: RunScope): string {
  if (scope.comment) return scope.comment.task.title;
  if (scope.task) return scope.task.title;
  return scope.thread.title;
}

interface Dependencies {
  hooks: RunHooks;
  log: Logger;
  entry(runId: string): LiveRun | undefined;
  pending(runId: string, approvalId: string): boolean;
}

export class RunNotifications {
  constructor(private readonly deps: Dependencies) {}

  forScope(scope: RunScope, kind: Notification["kind"], title: string, body: string, approval?: { runId: string; approvalId: string }): void {
    let threadId: string | null;
    if (scope.comment) threadId = null;
    else if (scope.thread) threadId = scope.thread.id;
    else threadId = scope.task.threadId;
    this.deps.hooks.notify({ kind, threadId, taskId: scope.comment?.task.id ?? scope.task?.id ?? null, title, body, ...approval });
  }

  /** Host permission requests enter here outside the provider event queue. */
  approval(ev: Extract<AgentEvent, { type: "approval.requested" }>): void {
    try {
      this.deps.hooks.onApprovalRequested?.(ev);
      const entry = this.deps.entry(ev.runId);
      if (!entry || !this.deps.pending(ev.runId, ev.approvalId)) return;
      const question = ev.kind === "user_input";
      const input = (ev.input ?? {}) as Record<string, unknown>;
      let what: string;
      if (question) what = "has a question";
      else if (typeof input["command"] === "string") what = `wants to run ${input["command"]}`;
      else what = `wants to use ${ev.toolName ?? ev.kind}`;
      this.forScope(entry.scope, question ? "question" : "approval", runScopeTitle(entry.scope), `${harnessShortName(entry.run.agent)} ${what}`, { runId: ev.runId, approvalId: ev.approvalId });
    } catch (error) {
      this.deps.log.warn(`approval notification failed: ${String(error)}`);
    }
  }
}
