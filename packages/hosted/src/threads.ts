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
import { harnessShortName, hostedThreadOf, isHostedAgent, type AccountReach, type Project, type RoutedMethod, type RpcParams, type RpcResults, type ThreadSummary } from "@openorc/protocol";
import { z } from "zod";
import type { HostedDeps, HostedThreads, MergedMethod, PlacePage } from "./index.js";
import { READ_LIMIT, type Follower } from "./follow.js";
import type { Account } from "./account.js";
import { askNotice, endNotice, noticed } from "./notices.js";
import * as sends from "./sends.js";
import { Refused, type Session, type SessionChange } from "./session.js";
import { CLOUD_PROJECT, listRows, projectPairs, resolvedCount, runsNow, toAppEvent, toRuns, toSummary } from "./translate.js";
import { ROUTES, SOCKET, wireProject, wireThread, wireTopics, type WireEvent, type WireProject, type WireThread } from "./wire.js";

const GONE = "That conversation isn't on OpenOrc Cloud.";

/** What this device keeps of a thread for itself: the half-written message, which never leaves it. */
const kept = z.object({ draft: z.string().nullable().optional() });
export type KeptHere = z.infer<typeof kept>;

const keptThreads = z.object({ email: z.string(), heardAt: z.number(), rows: z.array(wireThread), projects: z.array(wireProject), here: z.record(z.string(), kept).default({}) });
type Heard = z.infer<typeof keptThreads>;

type ThreadsDeps = { session: Session; follower: Follower; account: Pick<Account, "status" | "refused"> } & Pick<HostedDeps, "kept" | "projects" | "push" | "notify" | "now" | "log">;

type Answer<M extends RoutedMethod> = (threads: Threads, params: RpcParams<M>) => Promise<RpcResults[M]> | RpcResults[M];

/** A call a hosted thread does not take, with the words the person reads. */
const refused = (words: string) => ({ refused: words }) as const;
/** A call the core's router never asks a place: it names a task, which no place holds, or is this Mac's own to answer. */
const NOT_ASKED = { notAsked: true } as const;

const NOT_YET = refused("This isn't on OpenOrc Cloud yet.");
const NO_FILES = refused("An OpenOrc Cloud thread's files aren't on this Mac.");
const STAYS = refused("An OpenOrc Cloud thread stays on OpenOrc Cloud.");

/**
 * What a hosted thread does with each of the app's calls that name a thread, a run or a task: answers it, refuses it in
 * words, or is never asked it. Total over `RoutedMethod`, so a new such call does not compile until someone decides.
 */
const ANSWERS: { [M in RoutedMethod]: Answer<M> | ReturnType<typeof refused> | typeof NOT_ASKED } = {
  "threads.get": (threads, { id }) => threads.summary(id),
  "runs.listForThread": (threads, { threadId }) => toRuns(threads.row(threadId), threads.reach),
  "events.page": (threads, params) => threads.page(params),
  "events.listForRun": (threads, { runId, afterSeq }) => threads.eventsAfter(runId, afterSeq ?? 0),
  "threads.stopCommand": (threads, { id, commandId }) => threads.stopCommand(id, commandId),
  "threads.update": (threads, { id, patch }) => threads.update(id, patch),
  // The composer's sends, the queue, Stop and the answers to asks: sends.ts.
  "runs.start": async (threads, params) => {
    await sends.start(threads.calls, params);
    return toRuns(threads.row(params.threadId!), threads.reach)[0]!;
  },
  "runs.send": (threads, params) => sends.send(threads.calls, params).then(() => null),
  "threads.queue": (threads, params) => sends.queue(threads.calls, params),
  "threads.unqueue": (threads, params) => sends.unqueue(threads.calls, params),
  "threads.sendQueued": (threads, params) => sends.sendQueued(threads.calls, params),
  "runs.interrupt": (threads, params) => sends.stop(threads.calls, params).then(() => null),
  "approvals.resolve": (threads, params) => sends.answer(threads.calls, params).then(() => null),
  "threads.ready": (threads, params) => sends.ready(threads.calls, threads.readied, params).then(() => null),
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

  "threads.delete": (threads, { id }) => threads.remove(id),
  "threads.implementPlan": NOT_YET,
  "threads.exportPlan": NOT_YET,
  "threads.switchClaudeAccount": refused("An OpenOrc Cloud thread runs on your Claude sign-in there."),
  "threads.compact": NOT_YET,
  "threads.send": NOT_YET,
  "threads.turnChanges": NOT_YET,
  "threads.fork": NOT_YET,
  "subagents.stop": NOT_YET,
  "runs.close": NOT_YET,
  "events.toolOutput": NOT_YET,
  "tasks.create": NOT_YET,
  "orclings.ask": NOT_YET,
  "orclings.assign": NOT_YET,
  "orclings.react": NOT_YET,
  "orclings.origins": NOT_YET,
  "orclings.groups.send": NOT_YET,
  "orclings.groups.delete": NOT_YET,
  "review.comments.add": NOT_YET,
  "review.comments.remove": NOT_YET,
  "review.comments.send": NOT_YET,
  "review.threadChanges": NOT_YET,
  "review.threadFileDiff": NOT_YET,
  "review.commitThread": NOT_YET,
  "review.pushThread": NOT_YET,
  "review.createThreadPr": NOT_YET,
  "review.threadPrTemplate": NOT_YET,
  "git.threadLog": NO_FILES,
  "git.commitRange": NO_FILES,
  "git.threadPushState": NO_FILES,
  "threads.moveWorkspace": NO_FILES,
  "threads.movePreview": NO_FILES,
  "threads.restore": NO_FILES,
  "threads.restorePreview": NO_FILES,
  "cloud.move": STAYS,

  "threads.start": NOT_ASKED,
  "cloud.bringToMac": NOT_ASKED,
  "cloud.keep": NOT_ASKED,
  "cloud.openOnMac": NOT_ASKED,
  "cloud.closeOnMac": NOT_ASKED,
  "threads.snapshot": NOT_ASKED,
  "instructions.list": NOT_ASKED,
  "instructions.save": NOT_ASKED,
  "preview.state": NOT_ASKED,
  "mcpApps.open": NOT_ASKED,
  "tasks.get": NOT_ASKED,
  "tasks.update": NOT_ASKED,
  "tasks.delete": NOT_ASKED,
  "tasks.start": NOT_ASKED,
  "tasks.openThread": NOT_ASKED,
  "tasks.executionThread": NOT_ASKED,
  "tasks.prepareWorkspace": NOT_ASKED,
  "tasks.comments.list": NOT_ASKED,
  "tasks.comments.post": NOT_ASKED,
  "tasks.comments.retry": NOT_ASKED,
  "tasks.comments.cancel": NOT_ASKED,
  "tasks.comments.execute": NOT_ASKED,
  "runs.listForTask": NOT_ASKED,
  "memory.forTask": NOT_ASKED,
  "workspace.cleanup": NOT_ASKED,
  "workspace.removalImpact": NOT_ASKED,
  "workspace.usage": NOT_ASKED,
  "review.diff": NOT_ASKED,
  "review.snapshots": NOT_ASKED,
  "review.markReviewed": NOT_ASKED,
  "review.commit": NOT_ASKED,
  "review.checkoutState": NOT_ASKED,
  "review.exportPatch": NOT_ASKED,
  "review.push": NOT_ASKED,
  "review.createPr": NOT_ASKED,
  "git.log": NOT_ASKED,
};

export class Threads implements HostedThreads {
  readonly brain = "hosted";
  #heard: Heard | null = null;
  #reading: Promise<void> | null = null;
  #again: Promise<void> | null = null;
  #closed = false;
  /** When the person last asked each thread to be ready, so a thread is asked at most once a minute. */
  readonly readied = new Map<string, number>();
  /** What the writes in sends.ts work with. */
  readonly calls: sends.Calls;

  constructor(private readonly deps: ThreadsDeps) {
    this.calls = {
      session: deps.session,
      row: (threadId) => this.row(threadId),
      refresh: () => this.refresh(),
      account: () => deps.account.status(),
      refused: (refusal, settings) => deps.account.refused(refusal, settings),
      now: deps.now,
    };
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
    const entry = ANSWERS[method] as Answer<M> | ReturnType<typeof refused> | typeof NOT_ASKED;
    if (typeof entry === "function") return entry(this, params);
    throw new Refused("refused" in entry ? entry.refused : GONE);
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
    const rows = method === "threads.list" ? listRows(summaries, params as RpcParams<"threads.list">) : resolvedCount(summaries, params as RpcParams<"threads.resolvedCount">, this.deps.now());
    return { reach: this.reach, heardAt: this.#heard!.heardAt, rows } as PlacePage<M>;
  }

  /**
   * threads.update, as on this Mac: the title and what the next turns run with are the thread's, for everyone in it;
   * read, pinned, resolved and snoozed are the reader's own; the half-written message stays on this device. Each
   * write answers the row, which replaces the one heard, so the lists move at once.
   */
  async update(threadId: string, patch: RpcParams<"threads.update">["patch"]): Promise<ThreadSummary> {
    const row = this.row(threadId);
    const { draft, title, agent, model, effort, mode, permissionMode, fastMode, pinned, archived, snoozedUntil, seen, done: _settled, ...rest } = patch;
    if (Object.values(rest).some((value) => value !== undefined) || fastMode) throw new Refused(NOT_YET.refused);
    if (agent && !isHostedAgent(agent)) throw new Refused(`${harnessShortName(agent)} doesn't run on OpenOrc Cloud.`);
    const settings = defined({ agent, model, effort, mode, permissionMode });
    if (title !== undefined || Object.keys(settings).length)
      this.#hearRow(await this.deps.session.request(ROUTES.update(threadId), { ...(title !== undefined && { title }), ...(Object.keys(settings).length && { settings }) }));
    const mine = defined({ pinned, archived, snoozedUntil: snoozedUntil === undefined ? undefined : isoOf(snoozedUntil), seenSeq: seen === undefined ? undefined : seenUpTo(row, seen) });
    if (Object.keys(mine).length) this.#hearRow(await this.deps.session.request(ROUTES.mine(threadId), mine));
    if (draft !== undefined) {
      const heard = this.#heard!;
      heard.here[threadId] = { draft };
      this.deps.kept.save("threads", JSON.stringify(heard));
      this.#tell();
    }
    return this.summary(threadId);
  }

  /** threads.delete: the thread leaves OpenOrc Cloud, as its maker or a space's admin may ask; the server says who may not. */
  async remove(threadId: string): Promise<null> {
    this.row(threadId);
    await this.deps.session.request(ROUTES.remove(threadId));
    const heard = this.#heard;
    if (heard) {
      heard.rows = heard.rows.filter((row) => row.id !== threadId);
      delete heard.here[threadId];
      this.deps.kept.save("threads", JSON.stringify(heard));
      this.#tell();
    }
    return null;
  }

  /** A row the server just answered for a write, in place of the one heard. */
  #hearRow(row: WireThread): void {
    const heard = this.#heard;
    if (!heard) return;
    heard.rows = heard.rows.map((each) => (each.id === row.id ? row : each));
    this.deps.kept.save("threads", JSON.stringify(heard));
    this.#tell();
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
    return { events: events.map((event) => toAppEvent(threadId, event)), fromTurn: first.fromTurn ?? fromTurn, live: runsNow(row, this.reach) };
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
    if (!this.#reading) {
      this.#reading = this.#read().finally(() => (this.#reading = null));
      return this.#reading;
    }
    // A read already under way may have started before what the asker wants to see: one more follows it, for everyone.
    this.#again ??= this.#reading.then(() => {
      this.#again = null;
      return this.refresh();
    });
    return this.#again;
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
    if (this.#heard?.email === state.email) this.#tellPerson(this.#heard.rows, answers[0].threads);
    this.#heard = { email: state.email, heardAt: this.deps.now(), rows: answers[0].threads, projects: answers[1], here: this.#heard?.email === state.email ? this.#heard.here : {} };
    this.deps.kept.save("threads", JSON.stringify(this.#heard));
    if (JSON.stringify([this.#heard.rows, this.#heard.projects]) !== before) this.#tell();
  }

  /**
   * What the person hears of the rows that moved since the last listing: a new ask, or a turn that ended. A turn that
   * ends also wakes a snoozed thread, as on this Mac.
   */
  #tellPerson(before: readonly WireThread[], after: readonly WireThread[]): void {
    for (const { row, was } of noticed(before, after)) {
      if (was === "ask") {
        this.deps.notify(askNotice(row));
        continue;
      }
      if (row.snoozedUntil)
        void this.deps.session.request(ROUTES.mine(row.id), { snoozedUntil: null }).then(
          (woke) => this.#hearRow(woke),
          () => undefined,
        );
      void endNotice(this.deps.session, row).then(
        (notice) => notice && this.deps.notify(notice),
        (error: unknown) => this.deps.log.warn(`OpenOrc Cloud notice: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
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
      const here = heard.here[row.id];
      const summary = toSummary(row, { projectId, orphanOf: pair?.macId ? null : (pair?.name ?? "OpenOrc Cloud"), reach: state.reach, heardAt: heard.heardAt, now: this.deps.now() });
      return here?.draft ? { ...summary, draft: here.draft } : summary;
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

/** A moment as the server takes it; null stays null. */
const isoOf = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/**
 * The reader's seen position for read or unread, as the server keeps it: read is the head; unread is just before the
 * agent's last event, so the thread reads unread as it does when the agent writes past what the person saw.
 */
const seenUpTo = (row: WireThread, seen: boolean): number => (seen ? row.head : Math.max(0, row.lastAgentSeq - 1));

/** The fields a patch set, without the ones it left out. */
function defined<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
}
