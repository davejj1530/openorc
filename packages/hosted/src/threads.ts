/**
 * Hosted threads behind the app's own calls: the `HostedThreads` of index.ts.
 *
 * State, written only here and only from what the server answered:
 *   heard   the account's thread rows and its projects, with the address they were read for and when. Kept through
 *           `deps.kept("threads")`, so rows show offline and after a restart, and forgotten on sign-out.
 *
 * Each question is one step through it: who owns an id is a lookup in the rows (a run id carries its thread); the
 * sidebar's rows are the rows filtered in memory; one thread is one row. The `threads` topic reads the list again.
 */
import { hostedThreadOf, type AccountReach, type Project, type RoutedMethod, type RpcParams, type RpcResults, type ThreadSummary } from "@openorc/protocol";
import { z } from "zod";
import type { HostedDeps, HostedThreads, MergedMethod, PlacePage } from "./index.js";
import { READ_LIMIT, type Follower } from "./follow.js";
import type { Session, SessionChange } from "./session.js";
import { CLOUD_PROJECT, listRows, projectPairs, resolvedCount, toAppEvent, toRuns, toSummary } from "./translate.js";
import { ROUTES, SOCKET, wireProject, wireThread, wireTopics, type WireEvent, type WireProject, type WireThread } from "./wire.js";

const NOT_YET = "This isn't on OpenOrc Cloud yet.";
const GONE = "That conversation isn't on OpenOrc Cloud.";

const keptThreads = z.object({ email: z.string(), heardAt: z.number(), rows: z.array(wireThread), projects: z.array(wireProject) });
type Heard = z.infer<typeof keptThreads>;

type ThreadsDeps = { session: Session; follower: Follower } & Pick<HostedDeps, "kept" | "projects" | "push" | "now" | "log">;

/** What a hosted thread answers for one of the app's calls, from its row; methods not here are refused in words. */
type Answers = { [M in RoutedMethod]?: (threads: Threads, params: RpcParams<M>) => Promise<RpcResults[M]> | RpcResults[M] };

const ANSWERS: Answers = {
  "threads.get": (threads, { id }) => threads.summary(id),
  "runs.listForThread": (threads, { threadId }) => toRuns(threads.row(threadId), threads.reach),
  "events.page": (threads, params) => threads.page(params),
  "events.listForRun": (threads, { runId, afterSeq }) => threads.eventsAfter(runId, afterSeq ?? 0),
  "threads.stopCommand": (threads, { id, commandId }) => threads.stopCommand(id, commandId),
  // Reads the thread view makes as it opens, for parts the server does not serve yet: their empty answers.
  "threads.messages": () => [],
  "threads.lastMessage": () => null,
  "threads.plans": () => [],
  "threads.checkpoints": () => [],
  "orclings.reactions": () => [],
  "review.comments.list": () => [],
  "tasks.list": () => [],
  // The server keeps a thread's changes (GET /hosted/threads/:id/changes); they are drawn here once translated.
  "review.threadDiff": () => ({ baseSha: null, patch: "", files: [], since: null }),
};

export class Threads implements HostedThreads {
  readonly brain = "hosted";
  #heard: Heard | null = null;
  #reading: Promise<void> | null = null;
  #again = false;
  #closed = false;

  constructor(private readonly deps: ThreadsDeps) {
    deps.session.onChange((change) => this.#changed(change));
    deps.session.onSocket(SOCKET.changed, (body) => {
      const topics = wireTopics.safeParse(body);
      if (topics.success && topics.data.topics.some((topic) => topic === "threads" || topic === "projects")) void this.refresh();
    });
  }

  /** Reads what was kept for the signed-in address. */
  start(): void {
    const state = this.deps.session.state;
    const kept = parseKept(this.deps.kept.load("threads"));
    if (!kept || !state.signedIn || kept.email !== state.email) return this.deps.kept.save("threads", null);
    this.#heard = kept;
    // Windows that read their lists while the kept rows were loading read them again.
    this.#tell();
  }

  get active(): boolean {
    return this.deps.session.state.signedIn && this.#heard !== null;
  }

  /** How far the server can be reached now; rows read while it cannot claim nothing live. */
  get reach(): AccountReach {
    const state = this.deps.session.state;
    return state.signedIn ? state.reach : "offline";
  }

  holds(ref: { thread: string } | { run: string } | { project: string }): boolean {
    if (!this.active) return false;
    if ("project" in ref) return this.#cloudProject(ref.project) !== null;
    const id = "run" in ref ? hostedThreadOf(ref.run) : ref.thread;
    return id !== null && this.#rows().has(id);
  }

  async call<M extends RoutedMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
    const answer = ANSWERS[method] as ((threads: Threads, params: RpcParams<M>) => Promise<RpcResults[M]> | RpcResults[M]) | undefined;
    if (!answer) throw new Error(NOT_YET);
    return answer(this, params);
  }

  /** A project only the server has, as this Mac's windows read a project; null for any other id. */
  project(id: string): Project | null {
    const project = this.#cloudProject(id);
    if (!project) return null;
    const at = this.#heard?.heardAt ?? 0;
    return {
      id,
      name: project.name,
      rootPath: "",
      gitRemote: `https://github.com/${project.fullName}`,
      defaultBranch: null,
      settings: { setupScript: null, worktreeInclude: [], branchPrefix: "", detectedConfigs: [], claudeAccounts: null },
      createdAt: at,
      updatedAt: at,
    };
  }

  listed<M extends MergedMethod>(method: M, params: RpcParams<M>): PlacePage<M> | null {
    if (!this.active || method === "inbox.list") return null;
    const summaries = this.#summaries();
    const rows = method === "threads.list" ? listRows(summaries, params as RpcParams<"threads.list">) : resolvedCount(summaries, params as RpcParams<"threads.resolvedCount">);
    return { reach: this.reach, heardAt: this.#heard!.heardAt, rows } as PlacePage<M>;
  }

  /** One row, or a rejection in words when the account no longer has it. */
  row(threadId: string): WireThread {
    const row = this.#rows().get(threadId);
    if (!row) throw new Error(GONE);
    return row;
  }

  summary(threadId: string): ThreadSummary {
    const summary = this.#summaries().find((each) => each.id === threadId);
    if (!summary) throw new Error(GONE);
    return summary;
  }

  /**
   * The run's events from a turn on, or its newest `turns`, counted as the app counts them. Follows the thread first, so
   * frames are coming before the page is read and nothing falls between them.
   */
  async page(params: RpcParams<"events.page">): Promise<RpcResults["events.page"]> {
    const threadId = this.#threadOf(params.runId);
    const row = this.row(threadId);
    await this.deps.follower.follow(threadId);
    let fromTurn = params.fromTurn ?? 0;
    if (params.fromTurn === undefined && params.turns !== undefined) {
      const detail = await this.deps.session.request(ROUTES.thread(threadId));
      fromTurn = Math.max(0, detail.turnEnds.length - params.turns);
    }
    const first = await this.deps.session.request(ROUTES.events(threadId, { fromTurn }, READ_LIMIT));
    const events = await this.#readOn(threadId, first.events, first.head);
    return { events: events.map((event) => toAppEvent(threadId, event)), fromTurn: first.fromTurn ?? fromTurn, live: row.status !== "idle" };
  }

  /** Every event of the run after a seq of its log. */
  async eventsAfter(runId: string, after: number): Promise<RpcResults["events.listForRun"]> {
    const threadId = this.#threadOf(runId);
    this.row(threadId);
    await this.deps.follower.follow(threadId);
    const first = await this.deps.session.request(ROUTES.events(threadId, { after }, READ_LIMIT));
    const events = await this.#readOn(threadId, first.events, first.head);
    return events.map((event) => toAppEvent(threadId, event));
  }

  /** Stops one command the agent left running in the background, as the Stop beside it on this Mac does. */
  async stopCommand(threadId: string, commandId: string): Promise<null> {
    this.row(threadId);
    await this.deps.session.request(ROUTES.stopCommand(threadId, commandId));
    void this.refresh();
    return null;
  }

  /** A page that came back full is read on until the head. */
  async #readOn(threadId: string, events: WireEvent[], head: number): Promise<WireEvent[]> {
    let read = events;
    let all = events;
    while (read.length === READ_LIMIT && (all.at(-1)?.seq ?? head) < head) {
      read = (await this.deps.session.request(ROUTES.events(threadId, { after: all.at(-1)!.seq }, READ_LIMIT))).events;
      all = [...all, ...read];
    }
    return all;
  }

  #threadOf(runId: string): string {
    const threadId = hostedThreadOf(runId);
    if (threadId === null) throw new Error(GONE);
    return threadId;
  }

  /**
   * Reads the list and the projects again. One read at a time; asks while one runs fold into one more after it. The
   * windows hear `threads` when anything differs. A failed read keeps what was heard.
   */
  refresh(): Promise<void> {
    if (this.#reading) {
      this.#again = true;
      return this.#reading;
    }
    this.#reading = this.#read().finally(() => {
      this.#reading = null;
      if (this.#again) {
        this.#again = false;
        void this.refresh();
      }
    });
    return this.#reading;
  }

  async #read(): Promise<void> {
    const state = this.deps.session.state;
    if (!state.signedIn) return;
    let answers: [{ threads: WireThread[] }, WireProject[]];
    try {
      answers = await Promise.all([this.deps.session.request(ROUTES.threads), this.deps.session.request(ROUTES.projects)]);
    } catch (error) {
      this.deps.log.warn(`OpenOrc Cloud threads: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const now = this.deps.session.state;
    if (this.#closed || !now.signedIn || now.email !== state.email) return;
    const before = JSON.stringify([this.#heard?.rows, this.#heard?.projects]);
    this.#heard = { email: state.email, heardAt: this.deps.now(), rows: answers[0].threads, projects: answers[1] };
    this.deps.kept.save("threads", JSON.stringify(this.#heard));
    if (JSON.stringify([this.#heard.rows, this.#heard.projects]) !== before) this.#tell();
  }

  /** The host is closing: an answer still on its way is dropped. */
  close(): void {
    this.#closed = true;
    this.deps.follower.forget();
  }

  /** Signed out: the rows and their kept copy go, and the windows read their lists again. */
  #changed(change: SessionChange): void {
    if (!this.deps.session.state.signedIn) {
      const had = this.#heard !== null;
      this.#heard = null;
      this.deps.kept.save("threads", null);
      return had ? this.#tell() : undefined;
    }
    // Reach shows on every row, so the lists are read again when it moves.
    if (this.#heard) this.#tell();
    if (change === "connected") void this.refresh();
  }

  #tell(): void {
    this.deps.push({ type: "invalidate", keys: ["threads", "runs"] });
  }

  #rows(): Map<string, WireThread> {
    return new Map((this.#heard?.rows ?? []).map((row) => [row.id, row]));
  }

  #cloudProject(id: string): WireProject | null {
    if (!id.startsWith(CLOUD_PROJECT)) return null;
    return this.#heard?.projects.find((project) => CLOUD_PROJECT + project.id === id) ?? null;
  }

  /** Every row in the app's shape, each under its Mac project, or under its own when this Mac has none. */
  #summaries(): ThreadSummary[] {
    const heard = this.#heard;
    const state = this.deps.session.state;
    if (!heard || !state.signedIn) return [];
    const pairs = projectPairs(heard.projects, this.deps.projects());
    return heard.rows.map((row) => {
      const pair = row.projectId ? pairs.get(row.projectId) : undefined;
      const projectId = pair?.macId ?? CLOUD_PROJECT + (row.projectId ?? "none");
      return toSummary(row, { projectId, orphanOf: pair?.macId ? null : (pair?.name ?? "OpenOrc Cloud"), reach: state.reach, heardAt: heard.heardAt });
    });
  }
}

function parseKept(json: string | null): Heard | null {
  if (!json) return null;
  try {
    const parsed = keptThreads.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
