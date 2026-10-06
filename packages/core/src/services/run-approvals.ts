import { randomUUID } from "node:crypto";
import type { AcpApprovalRequest, CodexApprovalRequest } from "@openorc/agents";
import { audit, orchestration, runs, tasks, threads, type Db } from "@openorc/db";
import { UserInput, validateUserAnswers, type UserInputResult } from "@openorc/mcp";
import { executionMode, harnessCatalog, isHarnessId, stricterPermission, type AgentEvent, type ApprovalDecision, type ApprovalResolution } from "@openorc/protocol";
import { appActionPolicy, blockedInPlan, type AppAction } from "./app-actions.js";
import type { Logger } from "../transport.js";
import type { LiveRun, PendingApproval, RunScope, ThreadPermissionState } from "./run-types.js";
import type { ExecutionMode, Thread } from "@openorc/protocol";

/** Words and answer requirements for one Codex transport request. */
function codexApprovalPresentation(
  kind: CodexApprovalRequest["kind"],
  params: unknown,
): {
  detail: string;
  reason: string | undefined;
  toolName: string | undefined;
  needsAnswer: boolean;
  serverName: unknown;
} {
  const input = (params ?? {}) as Record<string, unknown>;
  const command = typeof input["command"] === "string" ? input["command"] : undefined;
  const message = typeof input["message"] === "string" ? input["message"] : undefined;
  const reason = typeof input["reason"] === "string" ? input["reason"] : message;
  const toolName = codexToolName(kind, input, command, message);
  const detail = codexApprovalDetail(kind, input, command, message, toolName);
  const needsAnswer = codexNeedsAnswer(kind, input);
  return { detail, reason, toolName, needsAnswer, serverName: input["serverName"] };
}

function codexToolName(kind: CodexApprovalRequest["kind"], input: Record<string, unknown>, command: string | undefined, message: string | undefined): string | undefined {
  if (command !== undefined) return "shell";
  if (kind === "tool") return `${String(input["serverName"] ?? "mcp")}.${/tool "([^"]+)"/.exec(message ?? "")?.[1] ?? "tool"}`;
  if (kind === "user_input") return "question";
  return undefined;
}

function codexApprovalDetail(kind: CodexApprovalRequest["kind"], input: Record<string, unknown>, command: string | undefined, message: string | undefined, toolName: string | undefined): string {
  if (command !== undefined) return command;
  if (kind !== "user_input") return toolName ?? message ?? kind;
  const questions = Array.isArray(input["questions"]) ? (input["questions"] as Record<string, unknown>[]) : [];
  return questions.map((question) => String(question["question"] ?? "")).join(" / ") || "The agent has a question";
}

/**
 * What "Allow for this run" covers for one of Claude's own tool calls, the way Claude's own "don't ask again" reads:
 * the same command, the same file, the same site, or the same MCP tool. Anything else only as exactly the same call.
 */
function runAllowance(toolName: string, input: unknown): string {
  const value = (input ?? {}) as Record<string, unknown>;
  const file = value["file_path"] ?? value["notebook_path"];
  const url = value["url"];
  if (toolName === "Bash" && typeof value["command"] === "string") return `${toolName} ${value["command"]}`;
  if (typeof file === "string") return `${toolName} ${file}`;
  if (toolName === "WebFetch" && typeof url === "string" && URL.canParse(url)) return `${toolName} ${new URL(url).host}`;
  if (toolName.startsWith("mcp__")) return toolName;
  return `${toolName} ${JSON.stringify(input)}`;
}

function codexNeedsAnswer(kind: CodexApprovalRequest["kind"], input: Record<string, unknown>): boolean {
  if (kind === "user_input") return true;
  if (kind !== "tool") return false;
  const schema = input["requestedSchema"] as { properties?: Record<string, unknown> } | undefined;
  return input["mode"] !== "form" || Object.keys(schema?.properties ?? {}).length > 0;
}

/** Pending decisions, plan writes, and thread permission gates share one approval owner. */
interface RunApprovalsDependencies {
  db: Db;
  live: ReadonlyMap<string, LiveRun>;
  isClosing: () => boolean;
  emit: (event: AgentEvent) => void;
  invalidate: (keys: string[]) => void;
  keysFor: (scope: RunScope) => string[];
  log: Logger;
}

export class RunApprovals {
  private readonly pendingApprovals = new Map<
    string,
    { resolve: (r: ApprovalResolution) => void; info: PendingApproval; needsAnswer: boolean; own?: boolean; always?: boolean; userInput?: UserInput }
  >();

  constructor(private readonly deps: RunApprovalsDependencies) {}

  get pendingCount(): number {
    return this.pendingApprovals.size;
  }

  get pendingEntries(): IterableIterator<{ info: PendingApproval; needsAnswer: boolean; always?: boolean }> {
    return this.pendingApprovals.values();
  }

  hasPending(runId: string, approvalId: string): boolean {
    return this.pendingApprovals.has(this.approvalKey(runId, approvalId));
  }

  handleCodexApproval({ runId, approvalId, kind, params, onceOnly }: CodexApprovalRequest): Promise<ApprovalResolution> {
    const { detail, reason, toolName, needsAnswer, serverName } = codexApprovalPresentation(kind, params);
    // serverName is supplied by the provider transport, not the MCP tool or its input.
    const integration = this.deps.live.get(runId)?.internalMcp;
    const category = kind === "tool" && integration && serverName === integration.serverName ? "internal_app" : "external";
    return this.awaitApproval(
      runId,
      approvalId,
      detail,
      () =>
        this.deps.emit({
          type: "approval.requested",
          runId,
          ts: Date.now(),
          approvalId,
          kind,
          input: params,
          ...(toolName ? { toolName } : {}),
          ...(reason ? { reason } : {}),
          ...(onceOnly ? { onceOnly } : {}),
        }),
      needsAnswer,
      category,
    );
  }

  handleOpenCodeApproval({ runId, approvalId, kind, toolName, detail, input, onceOnly }: AcpApprovalRequest): Promise<ApprovalResolution> {
    // OpenCode names its MCP tools `<server>_<tool>`.
    const integration = this.deps.live.get(runId)?.internalMcp;
    const category = integration && toolName.startsWith(`${integration.serverName}_`) ? "internal_app" : "external";
    return this.awaitApproval(
      runId,
      approvalId,
      detail,
      () => this.deps.emit({ type: "approval.requested", runId, ts: Date.now(), approvalId, kind, toolName, input, ...(onceOnly ? { onceOnly } : {}) }),
      false,
      category,
    );
  }

  async requestApproval(runId: string, approvalId: string, toolName: string, input: unknown): Promise<ApprovalResolution> {
    if (toolName === "ExitPlanMode") return this.presentPlan(runId, input);
    if (toolName === "AskUserQuestion") {
      const questions = Array.isArray((input as Record<string, unknown>)?.["questions"]) ? ((input as Record<string, unknown>)["questions"] as Record<string, unknown>[]) : [];
      const detail = questions.map((q) => String(q["question"] ?? "")).join(" / ") || "Claude has a question";
      return this.awaitApproval(
        runId,
        approvalId,
        detail,
        () => this.deps.emit({ type: "approval.requested", runId, ts: Date.now(), approvalId, kind: "user_input", toolName: "question", input }),
        true,
      );
    }
    const entry = this.deps.live.get(runId);
    const integration = entry?.internalMcp;
    const category = integration?.toolNames.some((name) => toolName === `mcp__${integration.serverName}__${name}`) ? "internal_app" : "external";
    // Claude and MCP Apps ask for every call, so OpenOrc remembers what the user allowed for the rest of the run. Plan mode still refuses it.
    const allowance = runAllowance(toolName, input);
    if (entry?.toolsAllowed?.has(allowance) && entry.run.mode !== "plan") {
      audit.record(this.deps.db, { actor: "openorc", action: "approval.auto_allow", resourceType: "run", resourceId: runId, metadata: { approvalId, policy: "allowed_for_run" } });
      return { decision: "allow" };
    }
    const result = await this.awaitApproval(
      runId,
      approvalId,
      toolName,
      () => this.deps.emit({ type: "approval.requested", runId, ts: Date.now(), approvalId, kind: "tool", toolName, input }),
      false,
      category,
    );
    if (result.decision === "allow_for_run" && entry) (entry.toolsAllowed ??= new Set()).add(allowance);
    return result;
  }

  private presentPlan(runId: string, input: unknown): ApprovalResolution {
    const run = this.deps.live.get(runId)?.run ?? runs.get(this.deps.db, runId);
    const plan = (input as Record<string, unknown> | null)?.["plan"];
    if (run?.mode !== "plan" || typeof plan !== "string" || !plan.trim()) return { decision: "deny", message: "There is no plan to present. Write it to your plan file first." };
    this.deps.emit({ type: "plan.updated", runId, ts: Date.now(), documentId: "plan", text: plan });
    return {
      decision: "deny",
      message: "OpenOrc saved your plan and shows it to the user, who implements it from OpenOrc or replies with changes. Stay in Plan mode and end your turn with a one-line summary.",
    };
  }

  acceptsPlanWrite(runId: string): boolean {
    const run = this.deps.live.get(runId)?.run ?? runs.get(this.deps.db, runId);
    return run?.mode === "plan" && isHarnessId(run.agent) && !harnessCatalog[run.agent].nativePlans;
  }

  writePlan(runId: string, text: string): void {
    if (!this.deps.live.has(runId) || !this.acceptsPlanWrite(runId)) throw new Error("Only a running Plan conversation can save a plan.");
    this.deps.emit({ type: "plan.updated", runId, ts: Date.now(), documentId: "plan", text });
  }

  async requestUserInput(runId: string, requestId: string, rawInput: UserInput, signal?: AbortSignal): Promise<UserInputResult> {
    const input = UserInput.parse(rawInput);
    const entry = this.deps.live.get(runId);
    if (!entry || !entry.busy || entry.questionsInterrupted || entry.closingRequested || entry.exiting || this.deps.isClosing() || signal?.aborted) return { requestId, status: "cancelled" };
    const key = this.approvalKey(runId, requestId);
    if (this.pendingApprovals.has(key)) throw new Error("This question request is already pending.");
    const normalized = { questions: input.questions.map((q) => ({ ...q, isOther: q.allowOther !== false })) };
    const pending = this.awaitApproval(
      runId,
      requestId,
      input.questions.map((q) => q.question).join(" / "),
      () => {
        this.deps.emit({ type: "approval.requested", runId, ts: Date.now(), approvalId: requestId, kind: "user_input", toolName: "ask_user", input: normalized });
      },
      true,
      "internal_app",
      input,
    );
    const cancel = () => this.settleApproval(runId, requestId, { decision: "deny" }, "openorc");
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      const result = await pending;
      return result.decision === "deny" ? { requestId, status: "cancelled" } : { requestId, status: "answered", answers: result.answers! };
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  private approvalKey(runId: string, approvalId: string): string {
    return `${runId}:${approvalId}`;
  }

  async authorizeAppAction(runId: string, action: AppAction, request: { toolName: string; reason: string; input: unknown }, receiver?: ExecutionMode): Promise<void> {
    const entry = this.deps.live.get(runId);
    const run = entry?.run ?? runs.get(this.deps.db, runId);
    if (!run) throw new Error("This run is no longer active.");
    const decision = appActionPolicy(action, executionMode(run.mode, entry?.permissionGate ?? run.permissionMode), receiver);
    if (decision === "allow" || (decision === "ask" && action !== "secret_input" && entry?.appActionsAllowed?.has(action))) return;
    if (decision === "block") {
      audit.record(this.deps.db, { actor: "openorc", action: "approval.deny", resourceType: "run", resourceId: runId, metadata: { tool: request.toolName, policy: "plan" } });
      throw new Error(blockedInPlan[action]);
    }
    const approvalId = `app-${randomUUID()}`;
    // A password is never allowed for the rest of the run, so its request offers only Allow.
    const onceOnly = action === "secret_input";
    const announce = () =>
      this.deps.emit({
        type: "approval.requested",
        runId,
        ts: Date.now(),
        approvalId,
        kind: "tool",
        toolName: request.toolName,
        input: request.input,
        reason: request.reason,
        ...(onceOnly ? { onceOnly } : {}),
      });
    const result = await this.awaitApproval(runId, approvalId, request.reason, announce, false, action === "secret_input" ? "confirm_always" : "confirm");
    if (result.decision === "deny") throw new Error("The user declined this action.");
    if (result.decision === "allow_for_run" && entry) (entry.appActionsAllowed ??= new Set()).add(action);
  }

  awaitApproval(
    runId: string,
    approvalId: string,
    detail: string,
    announce: () => void,
    needsAnswer = false,
    /** App tools are allowed; external requests follow the mode; `confirm` asks the user, and `confirm_always` also survives a switch to Autonomous. */
    category: "internal_app" | "external" | "confirm" | "confirm_always" = "external",
    userInput?: UserInput,
  ): Promise<ApprovalResolution> {
    const entry = this.deps.live.get(runId);
    if (this.deps.isClosing() || entry?.closingRequested || entry?.exiting) return Promise.resolve({ decision: "deny" });
    const run = this.deps.live.get(runId)?.run ?? runs.get(this.deps.db, runId);
    if (!needsAnswer && category === "external" && run?.mode === "plan") {
      audit.record(this.deps.db, { actor: "openorc", action: "approval.deny", resourceType: "run", resourceId: runId, metadata: { approvalId, policy: "plan" } });
      return Promise.resolve({ decision: "deny" });
    }
    const autonomous = run?.mode === "act" && (entry?.permissionGate ?? run.permissionMode) === "autonomous";
    if (!needsAnswer && (category === "internal_app" || (category === "external" && autonomous))) {
      audit.record(this.deps.db, {
        actor: "openorc",
        action: "approval.auto_allow",
        resourceType: "run",
        resourceId: runId,
        metadata: { approvalId, policy: category === "internal_app" ? "internal_app" : "autonomous" },
      });
      return Promise.resolve({ decision: "allow" });
    }
    return new Promise((resolve) => {
      this.pendingApprovals.set(this.approvalKey(runId, approvalId), {
        resolve,
        needsAnswer,
        ...(category === "confirm" || category === "confirm_always" ? { own: true } : {}),
        ...(category === "confirm_always" ? { always: true } : {}),
        ...(userInput ? { userInput } : {}),
        info: { runId, taskId: run?.taskId ?? null, threadId: run?.threadId ?? null, approvalId, detail },
      });
      announce();
      this.deps.invalidate(["inbox", "threads"]);
    });
  }

  resolveApproval(runId: string, approvalId: string, decision: ApprovalDecision, answers?: Record<string, string[]>): void {
    this.settleApproval(runId, approvalId, { decision, ...(answers ? { answers } : {}) }, "user");
  }

  settleApproval(runId: string, approvalId: string, resolution: ApprovalResolution, actor: "user" | "openorc"): void {
    const { decision, answers } = resolution;
    const key = this.approvalKey(runId, approvalId);
    const pending = this.pendingApprovals.get(key);
    if (!pending) {
      this.deps.log.warn(`no pending approval ${approvalId} on run ${runId}`);
      return;
    }
    if (pending.userInput && decision !== "deny") validateUserAnswers(pending.userInput, answers);
    this.pendingApprovals.delete(key);
    pending.resolve({ decision, ...(answers ? { answers } : {}) });
    // The adapters emit approval.resolved themselves for their own requests; Claude's MCP path has no adapter hook.
    if (pending.own || pending.userInput || !this.deps.live.get(runId) || this.deps.live.get(runId)?.run.agent === "claude") {
      this.deps.emit({ type: "approval.resolved", runId, ts: Date.now(), approvalId, decision, ...(answers ? { answers } : {}) });
    }
    audit.record(this.deps.db, {
      actor,
      action: actor === "openorc" && decision === "allow" ? "approval.auto_allow" : `approval.${decision}`,
      resourceType: "run",
      resourceId: runId,
      metadata: { approvalId, ...(actor === "openorc" && decision === "allow" ? { policy: "autonomous" } : {}) },
    });
    this.deps.invalidate(["inbox", "threads"]);
  }

  private permissionEntries(thread: Thread): LiveRun[] {
    const team = Boolean(orchestration.getInstance(this.deps.db, thread.id));
    return [...this.deps.live.values()].filter((entry) => {
      if (entry.scope.thread?.id === thread.id) {
        if (entry.scope.thread.projectId !== thread.projectId) throw new Error("The live lead no longer belongs to this project.");
        return true;
      }
      if (!team || !entry.scope.task) return false;
      const task = tasks.get(this.deps.db, entry.scope.task.id);
      if (task?.threadId !== thread.id && entry.scope.task.threadId !== thread.id) return false;
      if (!task || task.threadId !== thread.id || entry.scope.task.threadId !== thread.id || task.projectId !== thread.projectId || entry.scope.task.projectId !== thread.projectId) {
        throw new Error("A live team assignment has inconsistent ownership. Close it before changing permissions.");
      }
      return true;
    });
  }

  assertThreadPermissions(threadId: string): void {
    const thread = threads.get(this.deps.db, threadId);
    if (!thread) throw new Error("Thread not found.");
    this.permissionEntries(thread);
  }

  threadPermissions(threadId: string): ThreadPermissionState {
    const thread = threads.get(this.deps.db, threadId);
    if (!thread) throw new Error("Thread not found.");
    const target = thread.mode === "plan" ? "review" : thread.permissionMode;
    const states = this.permissionEntries(thread).map((entry) => {
      const effective = entry.run.mode === "plan" ? ("review" as const) : entry.run.permissionMode;
      return {
        runId: entry.run.id,
        mode: entry.run.mode,
        requested: thread.permissionMode,
        effective,
        providerPermissionMode: entry.providerPermissionMode,
        pendingRestart: entry.run.mode === "act" && effective !== target,
      };
    });
    const policies = new Set(states.map((state) => state.effective));
    const modes = new Set(states.map((state) => state.mode));
    return {
      mode: { requested: thread.mode, effective: modes.size > 1 ? null : (states[0]?.mode ?? thread.mode), pending: states.some((state) => state.mode !== thread.mode) },
      requested: thread.permissionMode,
      effective: policies.size > 1 ? null : (states[0]?.effective ?? target),
      pendingRestart: states.some((state) => state.pendingRestart),
      runs: states,
    };
  }

  applyThreadPermissions(thread: Thread): ThreadPermissionState {
    const entries = this.permissionEntries(thread);
    const team = Boolean(orchestration.getInstance(this.deps.db, thread.id));
    const target = team && thread.mode === "plan" ? "review" : thread.permissionMode;
    for (const entry of entries) this.applyEntryPermission(entry, target, team);
    return this.threadPermissions(thread.id);
  }

  private applyEntryPermission(entry: LiveRun, requested: Thread["permissionMode"], team: boolean): void {
    const run = entry.run;
    const target = entry.orclingCeiling ? stricterPermission(requested, entry.orclingCeiling) : requested;
    if (entry.closingRequested || entry.exiting) return;
    if (team) entry.permissionGate = target;
    if (run.mode !== "act") return;
    // Native bypass cannot be tightened. A gated process can stop app-level
    // automatic grants immediately, restoring its original native ceiling.
    if (!team && target !== "autonomous" && target !== entry.providerPermissionMode) return;
    const effective = team && target !== "autonomous" ? entry.providerPermissionMode : target;
    this.updateStoredPermission(entry, effective);
    // Reopening the gate releases requests parked while a stricter policy awaited native restart.
    if (target === "autonomous") this.releaseAutomaticApprovals(run.id);
    this.deps.invalidate(this.deps.keysFor(entry.scope));
  }

  private updateStoredPermission(entry: LiveRun, effective: Thread["permissionMode"]): void {
    const run = entry.run;
    if (run.permissionMode === effective) return;
    const previous = run.permissionMode;
    run.permissionMode = effective;
    runs.update(this.deps.db, run.id, { permissionMode: effective });
    audit.record(this.deps.db, {
      actor: "user",
      action: "run.permissions_changed",
      resourceType: "run",
      resourceId: run.id,
      metadata: { previous, permissionMode: effective, providerPermissionMode: entry.providerPermissionMode },
    });
  }

  private releaseAutomaticApprovals(runId: string): void {
    for (const pending of this.pendingApprovals.values()) {
      if (pending.info.runId === runId && !pending.needsAnswer && !pending.always) this.settleApproval(runId, pending.info.approvalId, { decision: "allow" }, "openorc");
    }
  }

  pending(): PendingApproval[] {
    return [...this.pendingApprovals.values()].map((p) => p.info);
  }

  denyApprovals(runId: string): void {
    for (const pending of [...this.pendingApprovals.values()]) {
      if (pending.info.runId === runId) this.settleApproval(runId, pending.info.approvalId, { decision: "deny" }, "openorc");
    }
  }
}
