import { audit, redact, threads, threadQueue, type Db } from "@openorc/db";
import type { QueuedMessage, Run, Thread, ThreadMessage } from "@openorc/protocol";
import { randomUUID } from "node:crypto";
import type { Logger } from "../transport.js";
import type { RunService } from "./runs.js";
import type { ThreadService } from "./threads.js";

type ContinueThreadInput = Parameters<ThreadService["continueThread"]>[1];

/** Owns durable messages, one drain per thread, and the task-start reservation that pauses draining. */
export class ThreadMessageQueue {
  private readonly draining = new Map<string, Promise<void>>();
  private readonly reservedTaskThreads = new Set<string>();
  private closing = false;

  constructor(
    private readonly db: Db,
    private readonly runs: RunService,
    private readonly invalidate: (keys: string[]) => void,
    private readonly log: Logger,
    private readonly rejectPinnedTeam: (id: string | null) => void,
    private readonly continueThread: (id: string, input: ContinueThreadInput) => Promise<Run>,
    private readonly publicQueueFollowUp: ThreadService["queueFollowUp"],
    private readonly publicStopAccepting: ThreadService["stopAccepting"],
  ) {}

  private thread(id: string): Thread {
    const thread = threads.get(this.db, id);
    if (!thread) throw new Error(`thread ${id} not found`);
    return thread;
  }

  hasTaskThreadReservation(id: string): boolean {
    return this.reservedTaskThreads.has(id);
  }

  reserveTaskThread(id: string): void {
    if (this.reservedTaskThreads.has(id)) throw new Error("This conversation is already starting work.");
    this.reservedTaskThreads.add(id);
  }

  releaseTaskThread(id: string): void {
    this.reservedTaskThreads.delete(id);
    void this.drainQueue(id);
  }

  recordMessage(threadId: string, message: ThreadMessage): void {
    this.thread(threadId);
    this.db
      .stmt(
        `INSERT INTO thread_messages (id, thread_id, role, text, created_at, attachments) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id, id) DO UPDATE SET attachments = COALESCE(excluded.attachments, thread_messages.attachments)`,
      )
      .run(message.id, threadId, message.role, redact(message.text).text, message.createdAt, message.attachments?.length ? JSON.stringify(message.attachments) : null);
    threads.touch(this.db, threadId);
    this.invalidate(["threads", `thread:${threadId}`]);
  }

  /* Queue */

  /** Accept once, durably. Provider delivery is a separate, recoverable step. */
  queueFollowUp(input: { threadId: string; text: string; attachments?: string[]; requestKey: string }): { messageId: string } {
    if (this.closing) throw new Error("OpenOrc is closing.");
    this.rejectPinnedTeam(input.threadId);
    const thread = this.thread(input.threadId);
    if (thread.archivedAt !== null) throw new Error("Unarchive this conversation before sending a message.");
    if ((!input.text.trim() && !input.attachments?.length) || !input.requestKey.trim()) throw new Error("A message and request key are required.");
    const message = threadQueue.enqueue(this.db, { ...input, attachments: input.attachments ?? [] });
    this.invalidate(["threads", `thread:${thread.id}`]);
    // Let the caller finish linking its durable receipt before attempting delivery.
    if (message.state === "pending") void Promise.resolve().then(() => this.drainQueue(thread.id));
    return { messageId: message.id };
  }

  queue(id: string, text: string, attachments: string[] = [], requestKey: string = randomUUID()): QueuedMessage[] {
    this.publicQueueFollowUp({ threadId: id, text, attachments, requestKey });
    return threadQueue.list(this.db, id);
  }

  recoverQueue(): void {
    threadQueue.recover(this.db);
    for (const id of threadQueue.pendingThreads(this.db)) void this.drainQueue(id);
  }

  stopAccepting(): void {
    this.closing = true;
  }

  async shutdown(): Promise<void> {
    this.publicStopAccepting();
    await Promise.allSettled(this.draining.values());
  }

  unqueue(id: string, messageId: string): QueuedMessage[] {
    this.thread(id);
    const message = threadQueue.list(this.db, id).find((message) => message.id === messageId);
    if (message?.state === "delivering") throw new Error("This message is being delivered. Wait for delivery to finish.");
    if (message) threadQueue.update(this.db, message.id, "cancelled");
    this.invalidate(["threads", `thread:${id}`]);
    void this.drainQueue(id);
    return threadQueue.list(this.db, id);
  }

  /** Explicit send-now or recovery; a receipt stays queued until the provider accepts it. */
  async sendQueued(id: string, messageId: string): Promise<QueuedMessage[]> {
    this.rejectPinnedTeam(id);
    const thread = this.thread(id);
    if (thread.archivedAt !== null) throw new Error("Unarchive this conversation before sending a message.");
    const item = threadQueue.list(this.db, id).find((message) => message.id === messageId);
    if (!item) throw new Error("That queued message is gone.");
    if (item.state === "delivering" || this.draining.has(id)) throw new Error("A queued message is being delivered.");
    if (item.state === "interrupted") {
      threadQueue.update(this.db, item.id, "pending");
      await this.drainQueue(id);
      this.invalidate(["threads", `thread:${id}`]);
      return threadQueue.list(this.db, id);
    }
    const live = this.runs.liveRunForThread(id);
    if (!live) throw new Error("The agent is between turns. The message stays queued.");
    if (live.agent !== thread.agent || !this.runs.canSteer(live.id)) {
      throw new Error(this.runs.steerUnavailableReason(live.id) ?? "The agent cannot take a message right now. It stays queued.");
    }
    const operation = (async () => {
      threadQueue.update(this.db, item.id, "delivering");
      try {
        await this.runs.send(live.id, item.text, { attachments: item.attachments });
        threadQueue.update(this.db, item.id, "delivered");
      } catch (error) {
        threadQueue.update(this.db, item.id, "interrupted", error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        this.draining.delete(id);
        this.invalidate(["threads", `thread:${id}`]);
        void Promise.resolve().then(() => this.drainQueue(id));
      }
    })();
    this.draining.set(
      id,
      operation.catch(() => {}),
    );
    await operation;
    return threadQueue.list(this.db, id);
  }

  drainQueue(id: string): Promise<void> {
    const existing = this.draining.get(id);
    if (existing) return existing;
    if (this.closing) return Promise.resolve();
    const next = threadQueue.list(this.db, id)[0];
    const thread = threads.get(this.db, id);
    if (!next || next.state !== "pending" || !thread || thread.archivedAt !== null || this.reservedTaskThreads.has(id) || this.runs.threadActivity(id) !== "idle") return Promise.resolve();
    const operation = (async () => {
      threadQueue.update(this.db, next.id, "delivering");
      try {
        await this.deliver(thread, next.text, "user", next.attachments);
        threadQueue.update(this.db, next.id, "delivered");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        threadQueue.update(this.db, next.id, "interrupted", message);
        this.log.warn(`queued message on thread ${id} failed: ${message}`);
      } finally {
        this.draining.delete(id);
        this.invalidate(["threads", `thread:${id}`]);
        void Promise.resolve().then(() => this.drainQueue(id));
      }
    })();
    this.draining.set(id, operation);
    return operation;
  }

  /** Puts a message into the thread: on the live session when there is one, else on a run that resumes it. */
  async deliver(thread: Thread, text: string, role: "user" | "system", attachments: string[] = [], recordPrompt = true): Promise<void> {
    this.rejectPinnedTeam(thread.id);
    const live = this.runs.liveRunForThread(thread.id);
    if (live && live.agent === thread.agent) {
      await this.runs.send(live.id, text, { role, attachments, recordPrompt });
      return;
    }
    await this.continueThread(thread.id, {
      agent: thread.agent,
      model: thread.model ?? undefined,
      effort: thread.effort ?? undefined,
      fastMode: thread.fastMode,
      mode: thread.mode,
      permissionMode: thread.permissionMode,
      prompt: text,
      attachments,
      promptRole: role,
      recordPrompt,
    });
  }

  /** A message into a thread from the outside: another thread, or the user relaying between them. */
  async send(id: string, text: string, from: Thread | null, attribution?: { member: string; team: string }, options: { liveOnly?: boolean } = {}): Promise<void> {
    const thread = this.thread(id);
    if (thread.archivedAt) throw new Error("the thread is archived");
    const sender = attribution ? ` sent by ${attribution.member} of team ${attribution.team}` : "";
    const body = from ? `Message from the thread "${from.title}" (id ${from.id})${sender}:\n\n${text}` : text;
    // A team agent may inform running work but never start a provider process outside its roster.
    if (options.liveOnly) {
      this.rejectPinnedTeam(thread.id);
      const live = this.runs.liveRunForThread(thread.id);
      if (!live || live.agent !== thread.agent) throw new Error(`"${thread.title}" is idle. A team agent cannot start work outside its roster; ask the user to continue that thread.`);
      await this.runs.send(live.id, body, { role: "system" });
    } else await this.deliver(thread, body, "system");
    audit.record(this.db, { actor: from ? "agent" : "user", action: "thread.message", resourceType: "thread", resourceId: id, metadata: { from: from?.id ?? null } });
  }
}
