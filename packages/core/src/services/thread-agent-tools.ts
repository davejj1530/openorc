import { audit, listEvents, projects, retiredTeams, runs as runRepo, tasks, threads, type Db } from "@openorc/db";
import type { TaskCard, ThreadCard } from "@openorc/mcp";
import {
  DEFAULT_CLAUDE_ACCOUNT,
  WORKSPACE_ID,
  executionMode,
  executionModeLabel,
  type AgentKind,
  type ModelOption,
  type Run,
  type Task,
  type TaskStatus,
  type Thread,
  type ThreadMessage,
  type WorkspaceMode,
} from "@openorc/protocol";
import { createHash } from "node:crypto";
import { checkoutBranch } from "./checkout-branch.js";
import { projectGit } from "./project-git.js";
import { assertTaskNotMoving } from "./relocation-fence.js";
import type { RunService } from "./runs.js";
import { titleFromPrompt, type StartThreadInput } from "./thread-inputs.js";
import type { SpawnTaskInput, ThreadService } from "./threads.js";

/**
 * How many agent messages in a row may pass between conversations before a person has to write. Agents end an
 * exchange by not replying; this only stops two of them that never do.
 */
export const MAX_AGENT_HOPS = 50;

export interface ThreadStartInput {
  prompt: string;
  title?: string;
  agent?: AgentKind;
  model?: string;
  effort?: string;
  fast?: boolean;
}

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9.]/g, "");

/**
 * The model a name stands for: the one whose id or label it is, else the only one whose id or label contains it, so
 * "6.1 sol" finds "GPT-6.1 Sol". A name that fits none or several is answered with the choices rather than a guess.
 */
export function pickModel(options: ModelOption[], agent: AgentKind, name: string): ModelOption {
  const wanted = squash(name).replace(new RegExp(`^${agent}`), "");
  const exact = options.find((option) => squash(option.id) === wanted || squash(option.label) === wanted);
  const near = exact ? [exact] : options.filter((option) => wanted && (squash(option.id).includes(wanted) || squash(option.label).includes(wanted)));
  const model = near.length === 1 ? near[0]! : null;
  if (!model) {
    const choices = options.map((option) => `${option.label} (${option.id})`).join(", ") || "none available";
    throw new Error(`${near.length ? `"${name}" fits several ${agent} models` : `No ${agent} model is called "${name}"`}. Choose one of: ${choices}.`);
  }
  if (model.unavailable) throw new Error(`${model.label} can't run right now: ${model.unavailable}`);
  return model;
}

/** Where a started thread works: in its parent's worktree, checkout, or Workspace folder. */
/** Where a thread started under `parent` works: in the parent's folder, joining its worktree when it has one. */
function childFolder(parent: Thread): Pick<StartThreadInput, "workingDirectory" | "workspaceMode" | "checkout"> {
  if (parent.projectId === WORKSPACE_ID) return parent.workingDirectory ? { workingDirectory: parent.workingDirectory } : {};
  if (!parent.worktreePath) return { workspaceMode: "current" };
  if (!parent.baseSha) throw new Error("This thread's worktree has no recorded starting commit, so a thread can't join it. Start one from OpenOrc instead.");
  // On the parent's branch, it is the parent's work; only a pull request's detached copy stays one for its children.
  return { checkout: { path: parent.worktreePath, baseSha: parent.baseSha, ...(parent.branch ? { branch: parent.branch } : {}) } };
}

/** What a started thread reads first, ahead of its work: who started it and how to reach them. */
function opener(parent: Thread): string {
  return `The thread "${parent.title}" (id ${parent.id}) started this thread and works in the same folder. Message it with thread_send when you have results or need something from it; don't reply just to acknowledge.`;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

/** Agents reach the threads of their own project; an Orcling works across all of the person's projects. */
export function reachesThread(db: Db, runId: string, source: Thread, target: Thread): boolean {
  return target.projectId === source.projectId || Boolean(runRepo.get(db, runId)?.orclingId);
}

type MessageResult = { delivered: boolean; message: string };
type MessageScope = { thread: Thread; target: Thread };

interface AgentToolContext {
  spawnTask(thread: Thread, input: SpawnTaskInput, origin: "user" | "agent"): Promise<{ task: Task; duplicate: boolean; started: boolean }>;
  rejectRetiredThread(id: string | null): void;
  send: ThreadService["send"];
  messages: ThreadService["messages"];
  withCheckoutBranches: ThreadService["withCheckoutBranches"];
  start: ThreadService["start"];
}

/** Resolves run-scoped task and thread access, including message retry identity. */
export class ThreadAgentTools {
  private readonly sentMessages = new Map<string, { fingerprint: string; result: MessageResult }>();

  constructor(
    private readonly db: Db,
    private readonly runs: RunService,
    private readonly invalidate: (keys: string[]) => void,
    private readonly context: AgentToolContext,
  ) {}

  /** Local conversations can have missing or stale metadata. Read their checkout's HEAD for display. */
  async withCheckoutBranches<T extends Thread>(rows: T[]): Promise<T[]> {
    const branches = new Map<string, Promise<string | null>>();
    return Promise.all(
      rows.map(async (thread) => {
        if (thread.projectId === WORKSPACE_ID || thread.workspaceMode !== "current" || thread.worktreePath) return thread;
        const project = projects.get(this.db, thread.projectId);
        if (!project) return { ...thread, branch: null };
        const pending =
          branches.get(project.rootPath) ??
          projectGit(project).then(
            (git) => (git === "none" ? null : checkoutBranch(project.rootPath)),
            () => null,
          );
        branches.set(project.rootPath, pending);
        return { ...thread, branch: await pending };
      }),
    );
  }

  messages(id: string): ThreadMessage[] {
    if (!threads.get(this.db, id)) throw new Error(`thread ${id} not found`);
    const rows = this.db.stmt("SELECT id, role, text, created_at AS createdAt, attachments FROM thread_messages WHERE thread_id = ? ORDER BY created_at, rowid").all(id);
    return rows.map((row) => ({ ...row, ...(row.attachments ? { attachments: JSON.parse(String(row.attachments)) as string[] } : { attachments: undefined }) })) as ThreadMessage[];
  }

  /** A fresh start, or a provider or Claude account that cannot read any earlier session here, gets a brief instead of the session. */
  handoffFor(thread: Thread, own: Run[], agent: AgentKind, fresh: boolean | undefined): string | undefined {
    if (own.length === 0) return undefined;
    const account = thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT;
    const resumable = own.some((run) => run.agent === agent && (agent !== "claude" || (run.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT) === account));
    return fresh || !resumable ? this.handoffBrief(thread, own) : undefined;
  }

  /** What the previous agent and the user said, clipped, for an agent that joins the thread cold. */
  handoffBrief(thread: Thread, own: Run[]): string {
    const conversation = this.context.messages(thread.id);
    for (const run of own.slice(-6)) {
      for (const ev of listEvents(this.db, run.id, { kinds: ["message.completed"], newest: true, limit: 2000 })) {
        if (ev.type !== "message.completed") continue;
        conversation.push({ id: ev.messageId, role: ev.role, text: ev.text, createdAt: ev.ts });
      }
    }
    conversation.sort((a, b) => a.createdAt - b.createdAt);
    const prompts = conversation.filter((m) => m.role === "user").map((m) => m.text.trim());
    const replies = conversation.filter((m) => m.role === "assistant" && m.text.trim()).map((m) => m.text.trim());
    const lines = [`Handoff: this thread ("${thread.title}") was worked on by another agent before you. You cannot see its session, so here is the gist.`];
    if (prompts.length > 0) lines.push("", "What the user asked, most recent last:", ...prompts.slice(-4).map((p) => `- ${clip(p.replace(/\s+/g, " "), 400)}`));
    if (replies.length > 0) lines.push("", "The previous agent's last reply:", clip(replies[replies.length - 1] ?? "", 1500));
    lines.push("", "Continue from here. Check the working tree before assuming what was done.");
    return lines.join("\n");
  }

  /* Agent-facing tools, scoped to the calling run */

  private scopeOf(runId: string): { thread: Thread | null; task: Task | null } {
    const run = runRepo.get(this.db, runId);
    if (!run) return { thread: null, task: null };
    const task = run.taskId ? tasks.get(this.db, run.taskId) : null;
    let thread: Thread | null = null;
    if (run.threadId) thread = threads.get(this.db, run.threadId);
    else if (task?.threadId) thread = threads.get(this.db, task.threadId);
    return { thread, task };
  }

  private card(t: Task, currentTaskId: string | null): TaskCard {
    const activity = this.runs.taskProgress(t.id);
    const last = activity ? runRepo.get(this.db, activity.runId) : null;
    const execution = t.executionThreadId ? threads.get(this.db, t.executionThreadId) : null;
    return {
      id: t.id,
      title: t.title,
      spec: t.spec,
      status: t.status,
      branch: execution?.branch ?? t.branch,
      current: t.id === currentTaskId,
      resultSummary: last?.endedAt ? ((last.resultText ?? last.error)?.slice(0, 2400) ?? null) : null,
      activity,
    };
  }

  /** Task board access follows the project, not the thread that created it. */
  private taskScope(runId: string): { projectId: string; currentTaskId: string | null } | null {
    const { thread, task } = this.scopeOf(runId);
    if (task && thread && task.projectId !== thread.projectId) return null;
    const projectId = task?.projectId ?? thread?.projectId;
    return projectId ? { projectId, currentTaskId: task?.id ?? null } : null;
  }

  private taskInScope(runId: string, id: string): { task: Task; currentTaskId: string | null } | null {
    const scope = this.taskScope(runId);
    const task = tasks.get(this.db, id);
    if (!scope || !task || task.retiredTeam || task.projectId !== scope.projectId) return null;
    return { task, currentTaskId: scope.currentTaskId };
  }

  async toolCreate(runId: string, input: SpawnTaskInput): Promise<{ task: TaskCard; duplicate: boolean; started: boolean; message: string }> {
    const { thread, task: current } = this.scopeOf(runId);
    if (!thread || current) throw new Error("Only a thread can create tasks. Finish this task and report back; the thread decides what comes next.");
    const run = runRepo.get(this.db, runId)!;
    const { task, duplicate, started } = await this.context.spawnTask(
      { ...thread, mode: run.mode, permissionMode: run.permissionMode },
      { ...input, execution: input.execution ?? "backlog" },
      "agent",
    );
    const message = duplicate
      ? `A task like this already exists (${task.status}): "${task.title}". Use task_update to refine it instead of creating another.`
      : "Saved to backlog. When the user asks to work on it, use task_start and implement it in this conversation. No separate agent is started.";
    return { task: this.card(task, null), duplicate, started, message };
  }

  async toolStart(runId: string, id: string, workspaceMode?: WorkspaceMode): Promise<TaskCard> {
    const scoped = this.taskInScope(runId, id);
    const run = runRepo.get(this.db, runId);
    if (!scoped) throw new Error("Task not found in this agent's project.");
    const { task, currentTaskId } = scoped;
    assertTaskNotMoving(this.db, task);
    this.assertTaskStartAllowed(task, run?.mode);
    const caller = this.scopeOf(runId).thread;
    this.assertTaskStartLocation(task, caller, workspaceMode);
    const updated = tasks.update(this.db, id, { status: "in_progress", completedAt: null, ...(caller ? { executionThreadId: caller.id } : {}) }, { explicitStatus: true });
    audit.record(this.db, { actor: "agent", action: "task.start", resourceType: "task", resourceId: id, metadata: { runId, threadId: caller?.id } });
    this.invalidate(["tasks", "inbox", `task:${id}`]);
    return {
      ...this.card(updated, currentTaskId),
      spec: updated.spec,
      message: "Task marked in progress. Implement it now in this conversation and workspace. No separate agent was started. Use task_update to record progress and completion.",
    };
  }

  private assertTaskStartAllowed(task: Task, mode: Run["mode"] | undefined): void {
    if (mode !== "act") throw new Error("Plan mode cannot start tasks. Switch to Act or approve the task in OpenOrc.");
    if (task.status === "done" || task.status === "archived") throw new Error("This task is finished. Reopen it in OpenOrc before starting it.");
    this.context.rejectRetiredThread(task.threadId);
    if (retiredTeams.hasTask(this.db, task.id)) throw new Error("This item is no longer available.");
    if (this.runs.liveRunForTask(task.id)) throw new Error("This task still has a running legacy agent. Stop or finish it before continuing here.");
  }

  private assertTaskStartLocation(task: Task, caller: Thread | null, workspaceMode?: WorkspaceMode): void {
    if (workspaceMode && caller && workspaceMode !== caller.workspaceMode) throw new Error("Tasks use the current thread's workspace. Move the thread before changing execution location.");
    if (task.executionThreadId && caller && task.executionThreadId !== caller.id) throw new Error("This task already runs in another conversation. Continue in its execution thread.");
    if (caller && !task.executionThreadId && task.workspaceMode !== caller.workspaceMode) throw new Error("Start this task from its task screen to use the selected execution location.");
  }

  async toolList(runId: string): Promise<TaskCard[]> {
    const scope = this.taskScope(runId);
    if (!scope) return [];
    return tasks
      .list(this.db, { projectId: scope.projectId })
      .filter((t) => t.status !== "archived")
      .map((t) => this.card(t, scope.currentTaskId));
  }

  async toolGet(runId: string, id: string): Promise<TaskCard | null> {
    const scoped = this.taskInScope(runId, id);
    return scoped ? this.card(scoped.task, scoped.currentTaskId) : null;
  }

  async toolUpdate(runId: string, id: string, patch: { status?: TaskStatus; spec?: string }): Promise<TaskCard | null> {
    const scoped = this.taskInScope(runId, id);
    if (!scoped) return null;
    const { task: t, currentTaskId } = scoped;
    if (t.retiredTeam) throw new Error("This item is no longer available.");
    assertTaskNotMoving(this.db, t);
    const changes: { spec?: string; status?: TaskStatus; completedAt?: number | null } = {};
    if (patch.spec) changes.spec = patch.spec;
    if (patch.status) {
      changes.status = patch.status;
      if (patch.status === "done") changes.completedAt = Date.now();
      else if (patch.status !== "archived") changes.completedAt = null;
    }
    const updated = tasks.update(this.db, id, changes, { explicitStatus: true });
    audit.record(this.db, { actor: "agent", action: "task.update", resourceType: "task", resourceId: id, metadata: { runId, patch } });
    this.invalidate(["tasks", "inbox", `task:${id}`, ...(t.threadId ? ["threads", `thread:${t.threadId}`] : [])]);
    return this.card(updated, currentTaskId);
  }

  /* Cross-thread tools: what the other threads of the project are up to, and a way to tell them something. */

  private threadCard(t: Thread, currentId: string | null): ThreadCard {
    const last = runRepo.listForThread(this.db, t.id).at(-1);
    return {
      id: t.id,
      title: t.title,
      activity: this.runs.threadActivity(t.id),
      branch: t.branch,
      current: t.id === currentId,
      lastReply: last?.resultText ? clip(last.resultText.replace(/\s+/g, " "), 300) : null,
      lastActivityAt: t.lastActivityAt,
    };
  }

  async toolThreadList(runId: string): Promise<ThreadCard[]> {
    const { thread } = this.scopeOf(runId);
    if (!thread) return [];
    const rows = await this.context.withCheckoutBranches(threads.list(this.db, { projectId: thread.projectId, filter: "active", excludeSubagents: true, limit: 30 }));
    return rows.map((t) => this.threadCard(t, thread.id));
  }

  async toolThreadRead(runId: string, id: string, limit = 10): Promise<{ thread: ThreadCard; messages: { role: "user" | "assistant" | "system"; text: string }[] } | null> {
    const { thread } = this.scopeOf(runId);
    const target = threads.get(this.db, id);
    if (!thread || !target || !reachesThread(this.db, runId, thread, target) || retiredTeams.isHidden(this.db, id)) return null;
    const out = this.context.messages(id);
    for (const run of runRepo.listForThread(this.db, id).slice(-4)) {
      for (const ev of listEvents(this.db, run.id, { kinds: ["message.completed"], newest: true, limit: 2000 })) {
        if (ev.type === "message.completed" && ev.text.trim()) out.push({ id: ev.messageId, role: ev.role, text: ev.text, createdAt: ev.ts });
      }
    }
    return {
      thread: this.threadCard((await this.context.withCheckoutBranches([target]))[0]!, thread.id),
      messages: out
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-limit)
        .map((m) => ({ role: m.role, text: clip(m.text.trim(), 1200) })),
    };
  }

  /**
   * Starts a thread that works beside the caller: in its folder, in its mode and with its permissions, with the caller
   * as its parent. The two talk through thread_send. A started thread can't start its own; a parent may start as many as
   * it needs.
   */
  async toolThreadStart(runId: string, input: ThreadStartInput): Promise<{ thread: { id: string; title: string }; agent: AgentKind; model: string | null; message: string }> {
    const { parent, run } = this.startingParent(runId);
    const settings = await this.childModel(parent, input);
    const { thread } = await this.context.start(
      {
        projectId: parent.projectId,
        ...childFolder(parent),
        ...settings,
        claudeAccountId: parent.claudeAccountId ?? undefined,
        claudeAccountFrom: "inherited",
        mode: run.mode,
        permissionMode: run.permissionMode,
        prompt: `${opener(parent)}\n\n${input.prompt.trim()}`,
        promptRole: "system",
        attachments: undefined,
        // Named for its work, not for the note about who started it.
        title: input.title ?? titleFromPrompt(input.prompt),
      },
      {
        assertCanAdmit: () => undefined,
        onAdmitted: (child) => threads.update(this.db, child.id, { parentThreadId: parent.id, startedByAgent: true }),
      },
    );
    audit.record(this.db, { actor: "agent", action: "thread.start", resourceType: "thread", resourceId: thread.id, metadata: { runId, parentThreadId: parent.id, agent: settings.agent } });
    this.invalidate(["threads", `thread:${parent.id}`]);
    return {
      thread: { id: thread.id, title: thread.title },
      agent: settings.agent,
      model: thread.model,
      message: `Started "${thread.title}" in this thread's folder. It knows you started it and can reach you with thread_send; reach it the same way.`,
    };
  }

  /**
   * A thread a person starts under another, working in its folder. Nothing limits how many or how deep; a thread an
   * agent starts with thread_start starts none of its own.
   */
  startUnder(parentId: string, input: Omit<StartThreadInput, "id" | "projectId" | "workingDirectory" | "workspaceMode" | "baseRef" | "checkout" | "cloud">) {
    const parent = threads.get(this.db, parentId);
    if (!parent || retiredTeams.isHidden(this.db, parent.id)) throw new Error("Thread not found.");
    this.runs.subagents.assertExecutable({ threadId: parent.id });
    // It goes on with its parent's account, which gives way to the project's default when the project does not use it.
    return this.context.start(
      { ...input, claudeAccountFrom: "inherited", projectId: parent.projectId, ...childFolder(parent) },
      { assertCanAdmit: () => undefined, onAdmitted: (child) => threads.update(this.db, child.id, { parentThreadId: parent.id }) },
    );
  }

  /** The thread a run starts a thread from, when it may. */
  private startingParent(runId: string): { parent: Thread; run: Run } {
    const { thread, task } = this.scopeOf(runId);
    const run = runRepo.get(this.db, runId);
    if (!thread || task || !run) throw new Error("Only a thread can start threads.");
    if (run.mode !== "act") throw new Error("Plan mode can't start threads. Switch this thread to Act first.");
    if (thread.startedByAgent && thread.parentThreadId) {
      const title = threads.get(this.db, thread.parentThreadId)?.title ?? "the thread that started this one";
      throw new Error(`A thread started by another thread can't start its own. Ask "${title}" with thread_send.`);
    }
    if (retiredTeams.isHidden(this.db, thread.id)) throw new Error("This item is no longer available.");
    return { parent: thread, run };
  }

  /**
   * The started thread's agent, model and Fast mode: the parent's, unless the call names others. On another agent with
   * no model named, the model last used with that agent that can still run; the agent's own default only when there is
   * none, since an agent's default can be a free trial model that stops mid-task.
   */
  private async childModel(parent: Thread, input: ThreadStartInput): Promise<Pick<StartThreadInput, "agent" | "model" | "effort" | "fastMode">> {
    const agent = input.agent ?? parent.agent;
    if (input.model) {
      const model = pickModel(await this.runs.models(agent), agent, input.model);
      return { agent, model: model.id, effort: input.effort ?? model.defaultEffort ?? undefined, fastMode: input.fast ?? false };
    }
    if (agent !== parent.agent) {
      const options = await this.runs.models(agent);
      const usable = (id: string) => options.find((option) => option.id === id && !option.unavailable && !option.legacy);
      const last = runRepo.recentModels(this.db, agent).map(usable).find(Boolean);
      return { agent, model: last?.id, effort: input.effort ?? last?.defaultEffort ?? undefined, fastMode: input.fast ?? false };
    }
    return { agent, model: parent.model ?? undefined, effort: input.effort ?? parent.effort ?? undefined, fastMode: input.fast ?? parent.fastMode };
  }

  /** The thread a run speaks for: its own thread, or the thread that owns its task. */
  sourceThreadFor(runId: string): Thread | null {
    return this.scopeOf(runId).thread;
  }

  /**
   * An agent's message to another conversation. The receiver works in its own mode, so a message to a more permissive
   * conversation asks the user first, or is refused from Plan (see app-actions.ts). A chain of agent messages stops at
   * MAX_AGENT_HOPS until a person writes, and a retried call with the same request key is delivered once.
   */
  async toolThreadSend(runId: string, id: string, text: string, requestKey?: string): Promise<MessageResult> {
    const scope = this.messageScope(runId, id);
    if ("message" in scope) return { delivered: false, message: scope.message };
    // Include the target: a request key cannot accidentally replay another recipient's result.
    const fingerprint = createHash("sha256").update(text).digest("hex");
    const key = `${runId}\0${id}\0${requestKey ?? fingerprint}`;
    const previous = this.sentMessages.get(key);
    if (previous) return previous.fingerprint === fingerprint ? previous.result : { delivered: false, message: "This request key already identifies a different message." };
    let latest: MessageScope;
    try {
      latest = await this.authorizeMessage(runId, scope, text);
    } catch (error) {
      return { delivered: false, message: error instanceof Error ? error.message : String(error) };
    }
    const result = await this.deliverMessage(latest, text);
    if (result.delivered) this.sentMessages.set(key, { fingerprint, result });
    if (this.sentMessages.size > 500) this.sentMessages.delete(this.sentMessages.keys().next().value!);
    return result;
  }

  private assertMessageChain(threadId: string): number {
    const hops = this.runs.agentChain(threadId) + 1;
    if (hops > MAX_AGENT_HOPS) throw new Error(`This would be agent message ${hops} in a row with no one writing in between, and the limit is ${MAX_AGENT_HOPS}. Ask the user to continue.`);
    return hops;
  }

  private async authorizeMessage(runId: string, scope: MessageScope, text: string): Promise<MessageScope> {
    const { thread, target } = scope;
    this.assertMessageChain(thread.id);
    const receiver = executionMode(target.mode, target.permissionMode);
    await this.runs.authorizeAppAction(
      runId,
      "thread_message",
      {
        toolName: "thread_send",
        reason: `Message "${target.title}", which works in ${executionModeLabel[receiver]} mode and acts on it with that mode's permissions.`,
        input: { to: target.title, text },
      },
      receiver,
    );
    const latest = this.messageScope(runId, target.id);
    if ("message" in latest) throw new Error(latest.message);
    if (executionMode(latest.target.mode, latest.target.permissionMode) !== receiver) throw new Error("The receiving conversation's permissions changed. Retry the message.");
    this.assertMessageChain(latest.thread.id);
    return latest;
  }

  private async deliverMessage({ thread, target }: MessageScope, text: string): Promise<MessageResult> {
    const hops = this.assertMessageChain(thread.id);
    const live = this.runs.liveRunForThread(target.id);
    const midTurn = Boolean(live && live.agent === target.agent && this.runs.isBusy(live.id));
    await this.context.send(target.id, text, thread);
    this.runs.noteAgentMessage(target.id, hops);
    return {
      delivered: true,
      message: midTurn ? `Delivered to the running turn of "${target.title}". Its agent reads it while it works.` : `Delivered to "${target.title}". Its agent starts a new turn to read it.`,
    };
  }

  private messageScope(runId: string, id: string): { thread: Thread; target: Thread } | { message: string } {
    const { thread } = this.scopeOf(runId);
    const target = threads.get(this.db, id);
    if (!thread) return { message: "Only a thread can message other threads." };
    if (!target || !reachesThread(this.db, runId, thread, target) || retiredTeams.isHidden(this.db, id)) return { message: "No such thread in this project." };
    if (target.id === thread.id) return { message: "That is this thread." };
    return { thread, target };
  }
}
