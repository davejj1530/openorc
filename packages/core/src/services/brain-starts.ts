import { randomUUID } from "node:crypto";
import { THREAD_EXISTS, type CloudThreadState, type OwnerReach, type QueuedMessage, type RpcMethod, type RpcParams, type RpcRequest, type ThreadSummary } from "@openorc/protocol";
import type { RpcReply } from "../transport.js";
import { titleFromPrompt } from "./thread-inputs.js";

type StartParams = RpcParams<"threads.start">;
export type NamedStart = StartParams & { id: string };
type Queued = RpcParams<"threads.queue"> & { requestKey: string };
type Waiting = { send: Queued; shown: QueuedMessage };

/** Where a start stands: the brain waking for it, the brain making the thread, refused, or the brain has it. */
type Stage = { at: "waking" } | { at: "starting" } | { at: "failed"; error: string } | { at: "started" };

interface Starting {
  params: NamedStart;
  /** What the row shows that never changes while it starts. */
  row: ThreadSummary;
  provider: CloudThreadState["provider"];
  setup: boolean;
  first: QueuedMessage;
  stage: Stage;
  /** Messages sent before the brain had the thread, in order: each goes to the brain's queue once it has it. */
  waiting: Waiting[];
  /** Each message on its way to the brain's queue, one after another in the order sent. */
  sending: Promise<void>;
}

export interface BrainStartsDeps {
  /** Wakes the brain as Wake does: on this build's brain, holding where its threads run now. */
  wake(): Promise<void>;
  /** The brain makes the thread under the id given. */
  start(params: NamedStart): Promise<void>;
  /** A message into the brain's queue for the thread, once it has it. */
  queue(params: Queued): Promise<void>;
  /** The windows' lists, refreshed with the brain's rows. */
  listed(): Promise<void>;
  /** Windows read the thread and the lists again. */
  changed(id: string): void;
  /** CloudBrain installs a newer brain before it starts it. */
  updating(): boolean;
  reach(): OwnerReach;
  warn(text: string): void;
}

/** What a thread that only starts answers before the brain has it: nothing yet. */
const NOTHING_YET: Partial<Record<RpcMethod, unknown>> = {
  "runs.listForThread": [],
  "threads.messages": [],
  "threads.lastMessage": null,
  "threads.plans": [],
  // The composer's changes strip asks as soon as the thread opens; until the brain has a worktree there are none.
  "review.threadDiff": { baseSha: null, patch: "", files: [], since: null },
};
const STILL_STARTING = "This conversation is still starting in the cloud.";

const words = (error: unknown) => (error instanceof Error ? error.message : String(error));
const result = (request: RpcRequest, value: unknown): RpcReply => ({ type: "rpc.result", id: request.id, result: value });
const refusal = (request: RpcRequest, message: string): RpcReply => ({ type: "rpc.error", id: request.id, message });

/** The row a window shows for a thread asked of the brain, under its final id, before the brain has it. */
function startingRow(id: string, params: StartParams, now: number): ThreadSummary {
  const chosen = params.executionTarget?.kind === "model" ? params.executionTarget.settings : undefined;
  return {
    id,
    projectId: params.projectId,
    title: params.title?.trim() || titleFromPrompt(params.prompt),
    agent: chosen?.agent ?? params.agent ?? "claude",
    model: (chosen ? chosen.model : params.model) ?? null,
    effort: (chosen ? chosen.effort : params.effort) ?? null,
    fastMode: (chosen ? chosen.fastMode : params.fastMode) ?? false,
    claudeAccountId: params.claudeAccountId ?? null,
    mode: params.mode,
    permissionMode: params.permissionMode,
    workspaceMode: "worktree",
    branch: null,
    worktreePath: null,
    baseSha: null,
    baseBranch: params.baseRef ?? null,
    pinnedAt: null,
    seenAt: now,
    doneAt: null,
    snoozedUntil: null,
    prUrl: null,
    prState: null,
    forkedFromId: null,
    forkedAtRunId: null,
    draft: null,
    importedFrom: null,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    archivedAt: null,
    hasStarted: false,
    activity: "idle",
    unread: false,
    session: { status: "idle", message: null },
    context: null,
    queued: [],
    lastAgentEventAt: null,
    liveRunId: null,
    taskCount: 0,
    openTaskCount: 0,
  };
}

/**
 * New cloud threads a window asked of the brain. Each opens at once under the id this Mac chose: its row shows the brain
 * waking and the brain's own setup after, as one on this Mac would. It reads as working while it starts, so a window
 * queues what it sends meanwhile, and that follows the start into the brain's queue, in order. A failure shows on the
 * thread, and Try again starts it anew. Gone once the brain's lists carry the thread.
 */
export class BrainStarts {
  private readonly starting = new Map<string, Starting>();

  constructor(private readonly deps: BrainStartsDeps) {}

  /** Answers the window at once; the brain is woken and asked behind it. */
  begin(params: StartParams, place: { provider: CloudThreadState["provider"]; setup: boolean }): ThreadSummary {
    const id = randomUUID();
    const now = Date.now();
    const first: QueuedMessage = { id: randomUUID(), text: params.prompt, attachments: params.attachments ?? [], queuedAt: now };
    const entry: Starting = { params: { ...params, id }, row: startingRow(id, params, now), ...place, first, stage: { at: "waking" }, waiting: [], sending: Promise.resolve() };
    this.starting.set(id, entry);
    void this.run(entry);
    return this.shown(entry);
  }

  /** The rows of threads still starting that a list asked for. */
  rows(matches: (row: ThreadSummary) => boolean): ThreadSummary[] {
    return [...this.starting.values()].map((entry) => this.shown(entry)).filter(matches);
  }

  /** A window's call about a thread still starting; null for any other thread, or a call the router answers as usual. */
  answer(request: RpcRequest, method: RpcMethod, params: Record<string, unknown>, id: string): Promise<RpcReply> | null {
    const entry = this.starting.get(id);
    if (!entry) return null;
    if (method === "threads.get") return Promise.resolve(result(request, this.shown(entry)));
    if (Object.hasOwn(NOTHING_YET, method)) return Promise.resolve(result(request, NOTHING_YET[method]));
    if (method === "threads.queue" || method === "threads.send") return Promise.resolve(this.queue(entry, request, method, params));
    if (method === "runs.start") return Promise.resolve(refusal(request, entry.stage.at === "failed" ? entry.stage.error : STILL_STARTING));
    if (method === "threads.sendQueued") return Promise.resolve(this.again(entry, request));
    if (method === "threads.unqueue") return Promise.resolve(this.unqueue(entry, request, params["messageId"]));
    if (method === "threads.delete") return Promise.resolve(this.forget(entry, request));
    return null;
  }

  /** CloudBrain changed, as when it began installing an update: windows read each thread it is waking for again. */
  brainChanged(): void {
    for (const entry of this.starting.values()) if (entry.stage.at === "waking") this.deps.changed(entry.params.id);
  }

  /** The brain's own step, while it is the one under way. */
  private brainStep(stage: Stage): CloudThreadState["brain"] {
    if (stage.at !== "waking") return undefined;
    return this.deps.updating() ? "updating" : "waking";
  }

  private queued(entry: Starting): QueuedMessage[] {
    return [entry.first, ...entry.waiting.map((each) => each.shown)];
  }

  private shown(entry: Starting): ThreadSummary {
    const { stage } = entry;
    const error = stage.at === "failed" ? stage.error : null;
    const brain = this.brainStep(stage);
    const cloud: CloudThreadState = { provider: entry.provider, state: error ? "failed" : "preparing", step: null, setup: entry.setup, error, ...(brain ? { brain } : {}) };
    const owner = { brain: "cloud" as const, reach: brain ? ("waking" as const) : this.deps.reach(), heardAt: Date.now() };
    return { ...entry.row, activity: error ? "idle" : "running", queued: this.queued(entry), cloud, owner };
  }

  private async run(entry: Starting): Promise<void> {
    const { id } = entry.params;
    const step = (stage: Stage) => {
      entry.stage = stage;
      this.deps.changed(id);
    };
    try {
      step({ at: "waking" });
      await this.deps.wake();
      step({ at: "starting" });
      // A start whose answer was lost made the thread all the same.
      await this.deps.start(entry.params).catch((error: unknown) => {
        if (words(error) !== THREAD_EXISTS) throw error;
      });
      entry.stage = { at: "started" };
    } catch (error) {
      return step({ at: "failed", error: words(error) });
    }
    for (const waiting of entry.waiting) this.deliver(entry, waiting);
    await entry.sending;
    await this.deps.listed();
    this.starting.delete(id);
    this.deps.changed(id);
  }

  /** A waiting message into the brain's queue, after those before it, unless it was taken out meanwhile. */
  private deliver(entry: Starting, waiting: Waiting): void {
    entry.sending = entry.sending.then(async () => {
      if (!entry.waiting.includes(waiting)) return;
      await this.deps.queue(waiting.send).catch((error: unknown) => this.deps.warn(`a message to a conversation starting in the cloud did not reach it: ${words(error)}`));
      entry.waiting = entry.waiting.filter((each) => each !== waiting);
      this.deps.changed(entry.params.id);
    });
  }

  private queue(entry: Starting, request: RpcRequest, method: "threads.queue" | "threads.send", params: Record<string, unknown>): RpcReply {
    const attachments = Array.isArray(params["attachments"]) ? (params["attachments"] as string[]) : [];
    const requestKey = typeof params["requestKey"] === "string" ? params["requestKey"] : randomUUID();
    const text = String(params["text"]);
    const waiting: Waiting = { send: { id: entry.params.id, text, attachments, requestKey }, shown: { id: requestKey, text, attachments, queuedAt: Date.now() } };
    entry.waiting.push(waiting);
    this.deps.changed(entry.params.id);
    // Once the brain has the thread, it goes after those before it; before, with them once it has.
    if (entry.stage.at === "started") this.deliver(entry, waiting);
    return result(request, method === "threads.queue" ? this.queued(entry) : null);
  }

  /** Try again on a start that failed: from the wake on, as the first time, with what waits for it. */
  private again(entry: Starting, request: RpcRequest): RpcReply {
    if (entry.stage.at === "failed") void this.run(entry);
    return result(request, this.queued(entry));
  }

  /** A message that still waits here leaves the queue; the first goes with the start. */
  private unqueue(entry: Starting, request: RpcRequest, messageId: unknown): RpcReply {
    entry.waiting = entry.waiting.filter((each) => each.shown.id !== messageId);
    this.deps.changed(entry.params.id);
    return result(request, this.queued(entry));
  }

  /** A start that failed can be deleted; one under way is the brain's to finish first. */
  private forget(entry: Starting, request: RpcRequest): RpcReply {
    if (entry.stage.at !== "failed") return refusal(request, STILL_STARTING);
    this.starting.delete(entry.params.id);
    this.deps.changed(entry.params.id);
    return result(request, null);
  }
}
