import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentEvent, RunStatus } from "@openorc/protocol";
import type { AgentCommand, JobReport, OwnTurns, SessionEntry } from "./profile.js";

/** How often the session is read while a background job runs, then while a turn of the agent's own runs. */
const WAITING_MS = 5_000;
const SLOW_WAITING_MS = 15_000;
const SLOW_AFTER_MS = 2 * 60_000;
const ANSWERING_MS = 2_000;

export interface OwnTurnHost {
  runId: string;
  run: AgentCommand;
  env: NodeJS.ProcessEnv;
  session(): string | null;
  emit(event: AgentEvent): void;
  now(): number;
  /** A prompt OpenOrc sent is in flight; its ACP server streams that turn. */
  prompting(): boolean;
  /** A turn of the agent's own is open. */
  answering(): boolean;
  open(): void;
  feed(update: SessionUpdate): void;
  close(status: RunStatus): void;
}

/** What the transcript says about a job's report, which reads as the reason the agent spoke. */
function reportText(job: JobReport, description: string | undefined): string {
  const named = description ? `: ${description}` : "";
  if (job.state === "cancelled") return `Background command stopped${named}`;
  if (job.state === "error" || (job.exit !== undefined && job.exit !== 0)) return `Background command failed${job.exit ? ` (exit ${job.exit})` : ""}${named}`;
  return `Background command finished${named}`;
}

/**
 * Follows the turns an agent starts by itself, which its ACP server never streams: the background jobs its tool calls
 * left running, each listed until it reports back, and the turn that report starts, read from the session and replayed
 * as the updates the ACP server would have sent. It reads only while a job runs or such a turn is open, and never while
 * a prompt of OpenOrc's is in flight.
 */
interface Job {
  description: string;
  /** The tool call still open for it, which its report finishes. */
  toolCallId?: string;
}

/** The text of an assistant message, as its chunks say it. */
function spoken(entry: SessionEntry | undefined): string {
  if (entry?.kind !== "assistant") return "";
  return entry.updates.flatMap((update) => (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? [update.content.text] : [])).join("");
}

export class OwnTurnWatcher {
  private readonly jobs = new Map<string, Job>();
  /** Tool calls the stream started and has not finished. */
  private readonly open = new Map<string, { name: string; input: unknown }>();
  /** What the prompt's turn last said, which names where it ends when the stream named no message of the session's. */
  private reply = "";
  /** The last message whose turn has been reported, by the prompt's stream or here. */
  private baseline: string | null = null;
  /** The last message the ACP stream named; the turn it ends after it is the prompt's. */
  private anchor: string | null = null;
  /** The baseline must be found again: a prompt's turn ended. */
  private stale = true;
  private readonly handled = new Set<string>();
  private readonly said = new Map<string, number>();
  private readonly announced = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private reading: Promise<void> | null = null;
  private waitingSince = 0;
  private closed = false;

  constructor(
    private readonly source: OwnTurns,
    private readonly host: OwnTurnHost,
  ) {}

  /** A job or a turn of the agent's own still needs following. */
  get active(): boolean {
    return !this.closed && (this.jobs.size > 0 || this.host.answering());
  }

  /** The ACP stream named a message; OpenCode names its own ids `msg_`. */
  saw(update: SessionUpdate): void {
    const id = "messageId" in update ? update.messageId : undefined;
    if (typeof id === "string" && id.startsWith("msg_")) this.anchor = id;
  }

  /** An event the stream mapped: a tool call that left a job running lists it until the job reports back. */
  observe(event: AgentEvent): void {
    if (this.closed) return;
    if (event.type === "tool.started") this.open.set(event.toolCallId, { name: event.name, input: event.input });
    if (event.type !== "tool.completed") return;
    this.open.delete(event.toolCallId);
    const job = this.source.startedJob?.({ name: event.name, input: event.input, output: event.output });
    if (job) this.addJob(job.id, { description: job.description });
  }

  /** A prompt's turn ended, having said `reply`: what follows it is the agent's own. */
  promptEnded(reply = ""): void {
    this.stale = true;
    this.reply = reply.trim();
    this.jobsLeftOpen();
    this.schedule();
  }

  /**
   * Reads the session now, unless a read is under way, which this waits for instead. A prompt waits for it while a job
   * runs: one sent into a turn the agent started itself would join it, so that turn is reported first.
   */
  sync(): Promise<void> {
    this.reading ??= this.readOnce()
      .catch(() => undefined)
      .finally(() => {
        this.reading = null;
      });
    return this.reading;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.jobs.size) {
      this.jobs.clear();
      this.listJobs();
    }
  }

  private addJob(id: string, job: Job): void {
    if (this.jobs.has(id)) return;
    this.jobs.set(id, job);
    this.waitingSince = this.host.now();
    this.listJobs();
    this.schedule();
  }

  /** The calls a turn ended with still open, which some agents leave so while the job they started runs. */
  private jobsLeftOpen(): void {
    for (const [id, tool] of this.open) {
      const job = this.source.leftRunning?.({ id, ...tool });
      if (job) this.addJob(job.id, { description: job.description, toolCallId: id });
    }
    this.open.clear();
  }

  /** The listed job a report is about: by its id, else by its command, else, for a report that starts a turn, the only one listed. */
  private jobOf(report: JobReport, loose = false): [string, Job] | undefined {
    const byId = this.jobs.get(report.id);
    if (byId) return [report.id, byId];
    const listed = [...this.jobs];
    return listed.find(([, job]) => report.command !== undefined && job.description === report.command) ?? (loose && listed.length === 1 ? listed[0] : undefined);
  }

  /** The job ended: it leaves the list, and the call that stood for it ends with its report. */
  private endJob(report: JobReport, loose = false): Job | undefined {
    const found = this.jobOf(report, loose);
    if (!found) return undefined;
    const [id, job] = found;
    this.jobs.delete(id);
    this.listJobs();
    if (job.toolCallId) {
      const failed = report.state !== "completed" || (report.exit !== undefined && report.exit !== 0);
      this.host.feed({
        sessionUpdate: "tool_call_update",
        toolCallId: job.toolCallId,
        status: failed ? "failed" : "completed",
        rawOutput: failed ? { error: report.output ?? "" } : { output: report.output ?? "" },
      });
    }
    return job;
  }

  private listJobs(): void {
    const commands = [...this.jobs].map(([id, { description }]) => ({ id, description }));
    this.host.emit({ type: "background.updated", runId: this.host.runId, ts: this.host.now(), running: 0, commands });
  }

  private schedule(): void {
    if (this.closed || this.timer || !this.active) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync().finally(() => this.schedule());
    }, this.delay());
    this.timer.unref?.();
  }

  private delay(): number {
    if (this.host.answering()) return ANSWERING_MS;
    return this.host.now() - this.waitingSince > SLOW_AFTER_MS ? SLOW_WAITING_MS : WAITING_MS;
  }

  private async readOnce(): Promise<void> {
    const sessionId = this.host.session();
    if (this.closed || !sessionId || this.host.prompting()) return;
    const entries = await this.source.read(this.host.run, sessionId, this.stale ? this.anchor : this.baseline, this.host.env);
    if (this.closed || this.host.prompting()) return;
    if (this.stale && !this.findBaseline(entries)) return;
    const start = this.baseline ? entries.findIndex((entry) => entry.id === this.baseline) : -1;
    if (this.baseline && start < 0) {
      // The page no longer reaches the baseline: start again from the newest finished turn, rather than replay old ones.
      this.baseline = entries.findLast((entry) => entry.kind === "idle")?.id ?? this.baseline;
      this.endJobs(entries);
      return;
    }
    for (const entry of entries.slice(start + 1)) this.replay(entry);
    this.endJobs(entries);
  }

  /**
   * Where the prompt's turn ends: the finished turn after the last message its stream named, else the newest finished
   * turn whose last words are the ones the stream said, else, when it said none, the newest finished turn.
   */
  private findBaseline(entries: SessionEntry[]): boolean {
    const anchored = this.anchor ? entries.findIndex((entry) => entry.id === this.anchor) : -1;
    let idle: SessionEntry | undefined;
    if (anchored >= 0) idle = entries.slice(anchored + 1).find((entry) => entry.kind === "idle");
    else if (this.reply) idle = entries.findLast((entry, index) => entry.kind === "idle" && this.endsReply(entries, index));
    else idle = entries.findLast((entry) => entry.kind === "idle");
    // The prompt's turn is not written to its end yet.
    if (!idle && (anchored >= 0 || this.reply)) return false;
    this.baseline = idle?.id ?? entries.at(-1)?.id ?? null;
    this.stale = false;
    return true;
  }

  /** The last words before this finished turn are the prompt's reply. */
  private endsReply(entries: SessionEntry[], index: number): boolean {
    const said = spoken(entries.slice(0, index).findLast((entry) => spoken(entry) !== "")).trim();
    return said !== "" && this.reply.endsWith(said);
  }

  private replay(entry: SessionEntry): void {
    const { host } = this;
    switch (entry.kind) {
      case "idle":
        if (host.answering()) {
          this.jobsLeftOpen();
          host.close(entry.outcome);
        }
        this.baseline = entry.id;
        return;
      case "user":
        if (this.handled.has(entry.id)) return;
        this.handled.add(entry.id);
        if (!host.answering()) host.open();
        host.emit({ type: "message.completed", runId: host.runId, ts: host.now(), messageId: entry.id, role: "user", text: entry.text });
        return;
      case "other":
        if (!entry.job || this.handled.has(entry.id)) return;
        this.handled.add(entry.id);
        if (!host.answering()) host.open();
        host.emit({
          type: "message.completed",
          runId: host.runId,
          ts: host.now(),
          messageId: entry.id,
          role: "system",
          text: reportText(entry.job, this.jobOf(entry.job, true)?.[1].description ?? entry.job.command),
        });
        this.endJob(entry.job, true);
        return;
      case "assistant":
        for (const update of entry.updates) this.replayUpdate(update);
        return;
    }
  }

  /** Each update once; a message's words as they grow, from where the last read left them. */
  private replayUpdate(update: SessionUpdate): void {
    const { host } = this;
    const fresh = this.freshPart(update);
    if (!fresh) return;
    if (!host.answering()) host.open();
    host.feed(fresh);
  }

  private freshPart(update: SessionUpdate): SessionUpdate | null {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        if (update.content.type !== "text" || !update.messageId) return null;
        const key = `${update.sessionUpdate}:${update.messageId}`;
        const said = this.said.get(key) ?? 0;
        const text = update.content.text;
        if (text.length <= said) return null;
        this.said.set(key, text.length);
        return { ...update, content: { type: "text", text: text.slice(said) } };
      }
      case "tool_call": {
        if (this.announced.has(update.toolCallId)) return null;
        this.announced.add(update.toolCallId);
        return update;
      }
      case "tool_call_update": {
        const key = `done:${update.toolCallId}`;
        if (this.announced.has(key)) return null;
        this.announced.add(key);
        return update;
      }
      default:
        return null;
    }
  }

  /** Jobs whose reports a prompt's turn already answered, or that the page no longer reaches back to. */
  private endJobs(entries: SessionEntry[]): void {
    for (const entry of entries) {
      if (entry.kind !== "other" || !entry.job || this.handled.has(entry.id)) continue;
      this.handled.add(entry.id);
      this.endJob(entry.job);
    }
  }
}
