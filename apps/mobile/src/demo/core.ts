import type { MacMessage, PhoneMessage } from "@openorc/link";
import { isRemoteMethod, isSessionMethod, type AgentEvent, type AssetRef, type PreviewState, type Project, type QueuedMessage, type Run, type ThreadSummary } from "@openorc/protocol";
import type { Clock } from "../connection/route-race";
import { answerDemo, answerSession } from "./answers";
import type { Draft } from "./drafts";
import { demoFrame } from "./frame";
import { heroThread, heroTurn, HERO_PAGE, HERO_THREAD, logosThread, logosWrap } from "./hero";
import { RunPlayer, type Turn } from "./player";
import { storyProjects, storyRun, storyThreads, type StoryThread } from "./story";
import { DemoWorkspace } from "./workspace";

/** Where the demo Mac's messages go: the line's other end. */
export interface DemoOut {
  message(message: MacMessage): void;
  bytes(stream: number, bytes: Uint8Array): void;
}

interface DemoRun {
  run: Run;
  events: AgentEvent[];
  live: boolean;
  frames: number;
  player: RunPlayer;
}

/** What the demo's agent says to anything sent to it: nothing runs here, and it says so. */
export const DEMO_REPLY = "This is a demo thread, so nothing ran.";

const replyTurn = (ask: string, attachments: string[], at: number): Turn => ({
  ask,
  attachments,
  beats: [
    { kind: "events", after: 500, events: [{ type: "thinking.started", messageId: `demo-think-${at}` }] },
    { kind: "events", after: 900, events: [{ type: "thinking.completed", messageId: `demo-think-${at}`, text: "" }] },
    { kind: "say", after: 300, messageId: `demo-reply-${at}`, text: DEMO_REPLY },
  ],
});

const activities = { working: "running", waiting: "waiting", idle: "idle" } as const;

/** Stamps drafts as the run's next events, numbered after the ones it holds. */
function record(run: DemoRun, drafts: Draft[], at: (index: number) => number): AgentEvent[] {
  const events = drafts.map((draft, index) => ({ ...draft, runId: run.run.id, ts: at(index), eventId: `${run.run.id}:${run.events.length + index + 1}` }) as AgentEvent);
  run.events.push(...events);
  return events;
}

/**
 * A Mac inside the app for the demo: OpenOrc's own projects and threads in memory, a live thread whose agent works
 * once something holds its run, and Changes, Preview and every write answered as the core answers them. It speaks the
 * link's messages to the phone and nothing else; stopping it drops everything done to it.
 */
export class DemoCore {
  readonly started: number;
  readonly projects: Project[];
  readonly threads = new Map<string, ThreadSummary>();
  readonly runs = new Map<string, DemoRun>();
  readonly workspaces = new Map<string, DemoWorkspace>();
  readonly previews = new Map<string, PreviewState>();
  readonly attachments = new Map<string, Uint8Array>();
  private interest = new Set<string>();
  private heroStarted = false;
  private ids = 0;
  private stopped = false;

  constructor(
    private readonly out: DemoOut,
    readonly clock: Clock,
  ) {
    this.started = clock.now();
    this.projects = storyProjects(this.started);
    const hero = heroThread(this.started);
    const logos = logosThread(this.started);
    for (const story of [hero, logos, ...storyThreads(this.started)]) this.add(story);
    this.workspaces.set(HERO_THREAD, new DemoWorkspace(hero.thread.branch!, hero.thread.baseSha!));
    const shipped = new DemoWorkspace(logos.thread.branch!, logos.thread.baseSha!);
    shipped.change(logosWrap);
    shipped.commit("Keep each agent's name with its mark", logos.thread.lastActivityAt);
    shipped.push();
    this.workspaces.set(logos.thread.id, shipped);
    const paging = this.threads.get("demo-paging")!;
    this.workspaces.set(paging.id, new DemoWorkspace(paging.branch!, paging.baseSha!));
    this.previews.set(HERO_THREAD, { open: false });
  }

  receive(message: PhoneMessage): void {
    if (this.stopped) return;
    switch (message.t) {
      case "rpc":
        return this.call(message.id, message.method, message.params);
      case "interest":
        return this.interestIn(message.runIds);
      case "asset":
        return this.asset(message.id, message.ref);
      case "ping":
        return this.send({ t: "pong", id: message.id });
    }
  }

  stop(): void {
    this.stopped = true;
    for (const run of this.runs.values()) run.player.stop();
  }

  /** A new id, unique in this demo Mac. */
  id(prefix: string): string {
    return `${prefix}-${this.started.toString(36)}-${++this.ids}`;
  }

  thread(id: string): ThreadSummary {
    const thread = this.threads.get(id);
    if (!thread) throw new Error("This thread no longer exists.");
    return thread;
  }

  demoRun(runId: string): DemoRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error("This run no longer exists.");
    return run;
  }

  /** The run a message to the thread goes to: its live one, or a new one that resumes its session. */
  liveRun(threadId: string): DemoRun | null {
    const runId = this.thread(threadId).liveRunId;
    return runId ? (this.runs.get(runId) ?? null) : null;
  }

  /** A new run on the thread that answers `prompt` as the demo's agent does. */
  startRun(threadId: string, prompt: string, attachments: string[] = []): Run {
    const thread = this.thread(threadId);
    const run: Run = { ...storyRun(thread, this.id("demo-run"), true), startedAt: this.clock.now() };
    const added = this.track(run, 0, true);
    this.threads.set(threadId, { ...thread, liveRunId: run.id, session: { status: "live", message: null } });
    this.emit(run.id, [{ type: "session.started", agent: run.agent, externalSessionId: null, model: run.model, tools: [] }]);
    this.reply(added.player, prompt, attachments);
    this.invalidate(["threads", `thread:${threadId}`, `runs:thread:${threadId}`]);
    return run;
  }

  /** Plays the demo's reply to a message, after whatever turn is playing. */
  reply(player: RunPlayer, text: string, attachments: string[] = []): void {
    player.play(replyTurn(text, attachments, this.clock.now()));
  }

  /** Queued messages go once the turn playing ends, as the core sends them. */
  queue(threadId: string, text: string, attachments: string[] = []): QueuedMessage[] {
    const thread = this.thread(threadId);
    const live = this.liveRun(threadId);
    if (!live?.player.busy) {
      if (live) this.reply(live.player, text, attachments);
      else this.startRun(threadId, text, attachments);
      return thread.queued;
    }
    const queued: QueuedMessage = { id: this.id("queued"), text, attachments, queuedAt: this.clock.now() };
    return this.update(threadId, { queued: [...thread.queued, queued] }).queued;
  }

  update(threadId: string, change: Partial<ThreadSummary>): ThreadSummary {
    const thread = { ...this.thread(threadId), ...change, updatedAt: this.clock.now() };
    this.threads.set(threadId, thread);
    this.invalidate(["threads", "inbox", `thread:${threadId}`]);
    return thread;
  }

  invalidate(keys: string[]): void {
    this.push({ type: "invalidate", keys });
  }

  /** Records the run's next events and streams them to a phone that asked for its frames. */
  emit(runId: string, drafts: Draft[]): void {
    const run = this.runs.get(runId);
    if (!run || this.stopped) return;
    const ts = this.clock.now();
    const events = record(run, drafts, () => ts);
    const thread = run.run.threadId ? this.threads.get(run.run.threadId) : undefined;
    if (thread) this.threads.set(thread.id, { ...thread, lastAgentEventAt: ts });
    if (this.interest.has(runId)) this.push({ type: "frame", frame: { runId, seq: ++run.frames, events } });
  }

  /** A story thread and its run, its history spread over the time it took. */
  private add(story: StoryThread): void {
    this.threads.set(story.thread.id, story.thread);
    const finished = story.history.filter((draft) => draft.type === "turn.completed").length;
    const run = this.track(story.run, finished, story.live);
    const { createdAt, lastActivityAt } = story.thread;
    const step = (lastActivityAt - createdAt) / Math.max(1, story.history.length - 1);
    record(run, story.history, (index) => Math.round(createdAt + index * step));
  }

  private track(run: Run, finished: number, live: boolean): DemoRun {
    const player = new RunPlayer({ clock: this.clock, emit: (runId, drafts) => this.emit(runId, drafts), moved: (runId, state) => this.moved(runId, state) }, run.id, finished);
    const tracked: DemoRun = { run, events: [], live, frames: 0, player };
    this.runs.set(run.id, tracked);
    return tracked;
  }

  /** The thread follows its run: working, waiting on the person, or done and unread. */
  private moved(runId: string, state: "working" | "waiting" | "idle"): void {
    const run = this.runs.get(runId);
    const threadId = run?.run.threadId;
    if (!run || !threadId || this.stopped) return;
    const now = this.clock.now();
    const thread = this.thread(threadId);
    const done = state === "idle";
    this.update(threadId, { activity: activities[state], ...(done ? { lastActivityAt: now, unread: true, lastAgentEventAt: null } : {}) });
    if (done && thread.queued.length) {
      const [next, ...rest] = thread.queued;
      this.update(threadId, { queued: rest });
      this.reply(run.player, next!.text, next!.attachments);
    }
  }

  private interestIn(runIds: string[]): void {
    this.interest = new Set(runIds);
    const hero = this.thread(HERO_THREAD).liveRunId;
    if (!this.heroStarted && hero && this.interest.has(hero)) {
      this.heroStarted = true;
      this.demoRun(hero).player.play(heroTurn({ change: (file) => this.changed(HERO_THREAD, file), openPage: () => this.openPage() }));
    }
  }

  private changed(threadId: string, file: Parameters<DemoWorkspace["change"]>[0]): void {
    this.workspaces.get(threadId)?.change(file);
    this.invalidate(["workspace-diff", `threaddiff:${threadId}`]);
  }

  private openPage(): void {
    const frame = demoFrame();
    this.previews.set(HERO_THREAD, { open: true, pane: "4e1f0c9a2b7d", ...HERO_PAGE, phase: "live", error: null, frame: { seq: 1, width: frame.width, height: frame.height } });
    this.invalidate(["preview", `preview:${HERO_THREAD}`]);
  }

  private call(id: number, method: string, params: unknown): void {
    void Promise.resolve()
      .then(() => {
        if (isSessionMethod(method)) return answerSession(this, method, params as never);
        if (isRemoteMethod(method)) return answerDemo(this, method, params as never);
        throw new Error("This is not available from a phone.");
      })
      .then(
        (result) => this.send({ t: "rpc.result", id, result: result ?? null }),
        (error: unknown) => this.send({ t: "rpc.error", id, message: error instanceof Error ? error.message : String(error) }),
      );
  }

  private asset(id: number, ref: AssetRef): void {
    const bytes = this.assetBytes(ref);
    if (!bytes) return this.send({ t: "asset.error", id, message: "This image is not on this Mac." });
    this.send({ t: "asset.bytes", id, mime: "image/jpeg", size: bytes.length });
    void Promise.resolve().then(() => !this.stopped && this.out.bytes(id, bytes));
  }

  private assetBytes(ref: AssetRef): Uint8Array | null {
    if (ref.kind === "attachment") return this.attachments.get(ref.name) ?? null;
    if (ref.kind !== "preview") return null;
    const state = this.previews.get(ref.threadId);
    return state?.open && state.frame?.seq === ref.seq ? demoFrame().bytes : null;
  }

  private push(push: Extract<MacMessage, { t: "push" }>["push"]): void {
    this.send({ t: "push", push });
  }

  private send(message: MacMessage): void {
    if (!this.stopped) this.out.message(message);
  }
}
