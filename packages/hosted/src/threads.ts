/**
 * Hosted threads behind the app's own calls: the `HostedThreads` of index.ts.
 *
 * State kept here:
 *   heard   the thread rows and projects of every space the person is in, each row and project with its space, who
 *           the person is, the address they were read for and when. Kept through `deps.kept("threads")`, so rows show
 *           offline and after a restart, and forgotten on sign-out.
 *   names   the account's completed title checks and retry positions, advanced by ThreadNames.
 *
 * Each question is one step through it: who owns an id is a lookup in the rows (a run id carries its thread); the
 * sidebar's rows are the rows filtered in memory; one thread is one row, and every request about it is made in its
 * space (`on`). The `threads`, `projects` and `members` topics read every space again.
 */
import {
  HOSTED_REASONS,
  harnessShortName,
  hostedRunId,
  hostedThreadOf,
  isHostedAgent,
  type AccountReach,
  type Project,
  type RoutedMethod,
  type RpcParams,
  type RpcResults,
  type ThreadSearchHit,
  type ThreadSummary,
} from "@openorc/protocol";
import { z } from "zod";
import { ANSWERS, NOT_YET } from "./thread-answers.js";
import type { HostedDeps, HostedThreads, MergedMethod, PlacePage } from "./index.js";
import { READ_LIMIT, type Follower } from "./follow.js";
import { firstPage } from "./thread-history.js";
import type { Account } from "./account.js";
import type { SpaceCatalog, Spaces } from "./spaces.js";
import { scopedProject, spaceProjects } from "./space-projects.js";
import { AccountCache } from "./account-cache.js";
import { keptThreadNames, ThreadNames } from "./thread-names.js";
import { askNotice, endNotice, noticed } from "./notices.js";
import * as sends from "./sends.js";
import { forkThread } from "./fork.js";
import { startSettings } from "./start-settings.js";
import type { Skills } from "./skills.js";
import { TerminalWatch } from "./thread-terminals.js";
import { Refused, type Requests, type Session, type SessionChange } from "./session.js";
import { CLOUD_PROJECT, githubRepoOf, listRows, projectPairs, resolvedCount, runsNow, starterOf, toAppEvent, toRuns, toSummary } from "./translate.js";
import { ROUTES, SOCKET, wireThread, wireTopics, type WireEvent, type WireFileWrite, type WireFileWriteOutcome, type WireThread } from "./wire.js";
import { writeThreadFile } from "./thread-file-writes.js";
import type { QueuedStart } from "./shared-sends.js";

import { firstMessage } from "./first-message.js";
import { macStartServed, packedFor, startWith } from "./mac-start.js";
import { nativeRowFields } from "./wire-subthreads.js";
import { readNativeRows } from "./subthreads.js";
import { nativeRowsFromEvents, withNativeSummary, withSubthreads } from "./translate-subthreads.js";
import { assertNativeCall } from "./subthread-calls.js";
import { ThreadVoices } from "./thread-voices.js";
import { toCollaboration } from "./wire-collaboration.js";

const GONE = "That conversation isn't on OpenOrc Cloud.";

/** What this device keeps of a thread for itself: the half-written message, which never leaves it. */
const kept = z.object({ draft: z.string().nullable().optional(), nativeStop: z.object({ id: z.uuid(), expectedRunId: z.string() }).optional() });
export type KeptHere = z.infer<typeof kept>;

/** A row and a project as heard, each with the space it was read in. */
const heardRow = wireThread.extend({ space: z.string(), ...nativeRowFields });
const heardProject = scopedProject;
export type HeardRow = z.infer<typeof heardRow>;
type HeardProject = z.infer<typeof heardProject>;

/** `me`: the person's own user id, which tells a thread they started from a teammate's; null until a space names it. */
const keptThreads = z.object({
  email: z.string(),
  me: z.string().nullable(),
  /** The person's personal space, where a new thread on a repository they have in several spaces starts. */
  personal: z.string().nullable().default(null),
  heardAt: z.number(),
  rows: z.array(heardRow),
  projects: z.array(heardProject),
  here: z.record(z.string(), kept).default({}),
  names: keptThreadNames.default({}),
});
type Heard = z.infer<typeof keptThreads>;

type ThreadsDeps = { session: Session; spaces: Spaces; follower: Follower; account: Pick<Account, "status" | "refused">; skills: Pick<Skills, "bring"> } & Pick<
  HostedDeps,
  "server" | "kept" | "projects" | "macWork" | "moving" | "push" | "notify" | "nameThread" | "now" | "log"
>;

export class Threads implements HostedThreads {
  readonly #cache: AccountCache<Heard>;
  readonly #names: ThreadNames;
  #generation = -1;
  readonly brain = "hosted";
  #heard: Heard | null = null;
  #reading: Promise<void> | null = null;
  #again: Promise<void> | null = null;
  #closed = false;
  #revision = 0;
  readonly #tickets = new Map<string, symbol>();
  /** The run states last announced to windows. A row can change these before any agent event arrives. */
  #toldRuns = new Map<string, ReturnType<typeof toRuns>>();
  /** When the person last asked each thread to be ready, so a thread is asked at most once a minute. */
  readonly readied = new Map<string, number>();
  /** What the writes in sends.ts work with. */
  readonly calls: sends.Calls;
  /** Who sent each turn and wrote each message of the threads read: collaboration.ts. */
  readonly voices = new ThreadVoices();
  /** The terminals the windows watch, whose output comes over the socket (thread-terminals.ts). */
  readonly terminals: TerminalWatch;
  /** Each explicit Start of a paused message not answered yet, with what it carries: shared-sends.ts. */
  readonly starts = new Map<string, QueuedStart>();

  constructor(private readonly deps: ThreadsDeps) {
    this.terminals = new TerminalWatch({ session: deps.session, push: deps.push });
    this.#cache = new AccountCache({ kept: deps.kept, part: "threads", server: deps.server, schema: keptThreads });
    this.#names = new ThreadNames({ nameThread: deps.nameThread, now: deps.now, log: deps.log, on: (id) => this.on(id), saved: (row) => this.#hearRow(row), keep: () => this.#save() });
    this.calls = {
      on: (threadId) => this.on(threadId),
      row: (threadId) => this.row(threadId),
      readOnly: (threadId) => starterOf(this.row(threadId), this.#heard?.me ?? null) !== null && !this.row(threadId).collaboration?.canWrite,
      refresh: () => this.refresh(),
      account: () => deps.account.status(),
      refused: (refusal, settings) => deps.account.refused(refusal, settings),
      bring: (threadId, agent) => deps.skills.bring(this.row(threadId).space, agent),
      now: deps.now,
    };
    deps.session.onChange((change) => this.#changed(change));
    deps.session.onSocket(SOCKET.changed, (body) => {
      const topics = wireTopics.safeParse(body);
      if (topics.success && topics.data.topics.some((topic) => topic === "threads" || topic === "projects" || topic === "members" || topic === "spaces")) {
        if (topics.data.topics.some((topic) => topic === "projects" || topic === "members" || topic === "spaces")) this.#revision++;
        if (topics.data.topics.includes("members")) this.voices.renamed();
        void this.refresh();
      }
    });
  }

  /** Reads what was kept for the signed-in address. */
  start(): void {
    const state = this.deps.session.state;
    const kept = state.signedIn ? this.#cache.load(state.email) : null;
    if (!kept || !state.signedIn || kept.email !== state.email) return;
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
    assertNativeCall(this, method, params);
    const entry = ANSWERS[method];
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
      gitRemote: project.fullName ? `https://github.com/${project.fullName}` : null,
      defaultBranch: null,
      settings: { setupScript: null, worktreeInclude: [], branchPrefix: "", detectedConfigs: [], claudeAccounts: null },
      createdAt: at,
      updatedAt: at,
    };
  }

  listed<M extends MergedMethod>(method: M, params: RpcParams<M>): PlacePage<M> | null {
    if (!this.active || method === "inbox.list") return null;
    const scope = params as RpcParams<"threads.list">;
    const summaries = this.#summaries(scope.spaceId, scope.ownership);
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
    if (fastMode) throw new Refused(HOSTED_REASONS.speed);
    if (Object.values(rest).some((value) => value !== undefined)) throw new Refused(NOT_YET.refused);
    if (agent && !isHostedAgent(agent)) throw new Refused(`${harnessShortName(agent)} doesn't run on OpenOrc Cloud.`);
    const settings = defined({ agent, model, effort, mode, permissionMode });
    if (title !== undefined || Object.keys(settings).length)
      this.#hearRow(await this.on(threadId).request(ROUTES.update(threadId), { ...(title !== undefined && { title }), ...(Object.keys(settings).length && { settings }) }));
    const mine = defined({ pinned, archived, snoozedUntil: snoozedUntil === undefined ? undefined : isoOf(snoozedUntil), seenSeq: seen === undefined ? undefined : seenUpTo(row, seen) });
    if (Object.keys(mine).length) this.#hearRow(await this.on(threadId).request(ROUTES.mine(threadId), mine));
    if (draft !== undefined) {
      const heard = this.#heard!;
      heard.here[threadId] = { ...heard.here[threadId], draft };
      this.#save();
      this.#tell();
    }
    return this.summary(threadId);
  }

  /** threads.delete: the thread leaves OpenOrc Cloud, as its maker or a space's admin may ask; the server says who may not. */
  /** Deletes a thread. Its removal may be heard before the server's reply; either way, it is gone once the reply comes. */
  async remove(threadId: string): Promise<null> {
    await this.deps.session.in(this.row(threadId).space).request(ROUTES.remove(threadId));
    this.letGo(threadId);
    return null;
  }

  /**
   * The thread is gone from the server, deleted or moved to this Mac: it and its subthreads leave the list now, so no
   * read of them goes to the server before its word of it comes.
   */
  letGo(threadId: string): void {
    const heard = this.#heard;
    if (!heard) return;
    const gone = withSubthreads(heard.rows, threadId);
    heard.rows = heard.rows.filter((row) => !gone.has(row.id));
    for (const id of gone) {
      this.#tickets.delete(id);
      delete heard.here[id];
    }
    this.deps.follower.forget([...gone]);
    this.voices.forget([...gone]);
    this.#save();
    this.#tell();
  }

  nativeStopRequest(threadId: string, expectedRunId: string): string {
    this.row(threadId);
    const heard = this.#heard!;
    const here = heard.here[threadId] ?? {};
    if (here.nativeStop?.expectedRunId === expectedRunId) return here.nativeStop.id;
    const id = crypto.randomUUID();
    heard.here[threadId] = { ...here, nativeStop: { id, expectedRunId } };
    this.#save();
    return id;
  }

  /**
   * threads.readyStart: the person began writing a new cloud thread's first message in the project. The machine it will
   * run on is made ready, with the person's skills on the server first, at most once a minute for the project, and
   * never for an agent that doesn't run on OpenOrc Cloud or a start the account would refuse. Nothing comes back of
   * it: the start says what went wrong.
   */
  async readyStart(params: RpcParams<"threads.readyStart">): Promise<void> {
    const settings = startSettings(params);
    const project = isHostedAgent(settings.agent) ? this.#projectFor(params.projectId, params.spaceId) : null;
    if (project) await sends.readyStart(this.calls, this.readied, { ...project, settings }, { skills: this.deps.skills, session: this.deps.session });
  }

  /**
   * threads.start on OpenOrc Cloud: a new thread on the server project with the Mac project's repository, in the
   * person's personal space when they have it in several, with the prompt as its first message. A first message the
   * server refuses makes no thread; the start then fails with the words the card above a composer shows.
   */
  async startThread(params: RpcParams<"threads.start">): Promise<RpcResults["threads.start"]> {
    const settings = startSettings(params);
    if (!isHostedAgent(settings.agent)) throw new Refused(`${harnessShortName(settings.agent)} doesn't run on OpenOrc Cloud.`);
    const project = this.#projectFor(params.projectId, params.spaceId);
    if (!project) throw new Refused(params.spaceId ? "This project isn't available in this space." : "Add this project to OpenOrc Cloud in Settings first.");
    const under = this.#parentIn(params.parentThreadId, project);
    // The person's own skills are the server's before the thread's first turn: a failure starts no thread.
    await this.deps.skills.bring(project.space, settings.agent);
    const generation = this.deps.session.generation;
    const on = this.deps.session.in(project.space);
    // From this Mac's folder: its work is packed before anything leaves, and goes up before the first message.
    const mac = await packedFor(this.deps.macWork, params);
    const body = { projectId: project.id, ...under, ...(params.title && { title: params.title }), settings, ready: true };
    const { reply, refusal } = await startWith(on, body, await firstMessage(on, params), settings, mac);
    if (refusal !== null) return sends.refuse(this.calls, refusal, settings);
    if (generation !== this.deps.session.generation) throw new Refused("Your OpenOrc session changed. Try again.");
    if (!this.#heard?.projects.some((row) => row.id === project.id && row.space === project.space)) throw new Refused("You no longer have access to this project.");
    if (!reply.thread) return sends.refuse(this.calls, reply.first?.sent === false ? reply.first.refusal : "", settings);
    const row = { ...reply.thread, space: project.space };
    return { thread: this.#listNew(row, params.spaceId), run: toRuns(row, this.reach)[0] ?? null };
  }

  /** threads.fork (fork.ts): listed at once, as a thread started here is. */
  forkThread = (params: RpcParams<"threads.fork">) =>
    forkThread({ session: this.deps.session, heard: (id) => this.#heard?.rows.find((row) => row.id === id) ?? null, listNew: (row) => this.#listNew(row) }, params);

  /** A thread new on the server, listed at once rather than at the list's next read. */
  #listNew(row: HeardRow, spaceId?: string): ThreadSummary {
    const heard = this.#heard;
    if (heard && !heard.rows.some((each) => each.id === row.id)) {
      heard.rows = [row, ...heard.rows];
      this.#save();
      this.#tell();
    }
    void this.refresh();
    return this.summary(row.id, spaceId);
  }

  /** The cloud thread a new one starts under, when it names one: a thread of the same project in the same space. */
  #parentIn(parentThreadId: string | undefined, project: HeardProject): { parentThreadId?: string } {
    if (!parentThreadId) return {};
    const parent = this.#heard?.rows.find((row) => row.id === parentThreadId);
    if (parent?.projectId !== project.id || parent.space !== project.space) throw new Refused("The parent conversation isn't in this space.");
    return { parentThreadId };
  }

  /** Whether a cloud thread of this Mac project may start from its folder: the project is on OpenOrc Cloud and its server takes one. */
  /** The cloud project a Mac project is, where a new cloud thread of it starts; null when none is in reach. */
  cloudProjectFor(macProjectId: string, spaceId?: string): { id: string; space: string } | null {
    const project = this.#projectFor(macProjectId, spaceId);
    return project && { id: project.id, space: project.space };
  }

  async macStartOffered(macProjectId: string, spaceId?: string): Promise<boolean> {
    const project = this.#projectFor(macProjectId, spaceId);
    return project ? macStartServed(this.deps.session.in(project.space)) : false;
  }

  /** Explicit scopes select that space's project. Legacy starts prefer Personal, then another matching space. */
  #projectFor(macId: string, spaceId?: string): HeardProject | null {
    const heard = this.#heard;
    if (macId.startsWith(CLOUD_PROJECT)) return heard?.projects.find((project) => CLOUD_PROJECT + project.id === macId && (!spaceId || project.space === spaceId)) ?? null;
    const local = this.deps.projects().find((project) => project.id === macId);
    // A folder with no remote: the Personal project it was added as.
    if (local?.cloudProjectId) return heard?.projects.find((project) => project.id === local.cloudProjectId && (!spaceId || project.space === spaceId)) ?? null;
    const repo = githubRepoOf(local?.remote ?? null);
    if (!heard || !repo) return null;
    const matching = heard.projects.filter((project) => project.fullName?.toLowerCase() === repo && (!spaceId || project.space === spaceId));
    return matching.find((project) => project.space === heard.personal) ?? matching[0] ?? null;
  }

  /** Every project of the person's spaces, by id. */
  cloudIds(): ReadonlySet<string> {
    return new Set((this.#heard?.projects ?? []).map((project) => project.id));
  }

  /** The repositories every space of the person's has as projects, owner/name in lower case. */
  cloudRepos(): ReadonlySet<string> {
    return new Set((this.#heard?.projects ?? []).flatMap((project) => (project.fullName ? [project.fullName.toLowerCase()] : [])));
  }

  /** A row the server just answered for a write, in place of the one heard, in the same space. */
  #hearRow(row: WireThread): void {
    const heard = this.#heard;
    if (!heard) return;
    heard.rows = heard.rows.map((each) => (each.id === row.id ? { ...each, ...row, space: each.space } : each));
    this.#save();
    this.#tell();
  }

  /** One row, or a rejection in words when the account no longer has it. */
  /** The threads the account has of one cloud project, as last heard. */
  rowsOfProject(projectId: string): HeardRow[] {
    return [...this.#rows().values()].filter((row) => row.projectId === projectId);
  }

  row(threadId: string): HeardRow {
    const row = this.#rows().get(threadId);
    if (!row) throw new Error(GONE);
    return row;
  }

  /** `HostedThreads.writeFile` (thread-file-writes.ts). */
  writeFile(threadId: string, write: WireFileWrite): Promise<WireFileWriteOutcome> {
    return writeThreadFile(this, threadId, write);
  }

  /**
   * The palette's search of a space's cloud threads (`threads.search`), or with no space named of every space the
   * account lists threads in: the server's hits in the app's shape, each in a thread the account lists, under the
   * project the sidebar shows it in. A server without the search says so in the app's words rather than finding nothing.
   */
  async search(spaceId: string | undefined, { query, projectId, limit = 30 }: Omit<RpcParams<"threads.search">, "spaceId">): Promise<ThreadSearchHit[]> {
    const listed = new Map(this.#summaries(spaceId).map((summary) => [summary.id, summary]));
    const spaces = spaceId ? [spaceId] : [...new Set(this.#heard?.rows.map((row) => row.space) ?? [])];
    const asked = projectId ? 100 : limit;
    const pages = await Promise.all(
      spaces.map((space) =>
        this.deps.session
          .in(space)
          .request(ROUTES.search(query, asked))
          .catch((error: unknown) => {
            if (error instanceof Refused && error.status === 404) throw new Refused(HOSTED_REASONS.search);
            throw error;
          }),
      ),
    );
    return pages
      .flatMap((page) => page.hits)
      .flatMap((hit): ThreadSearchHit[] => {
        const thread = listed.get(hit.threadId);
        if (!thread || (projectId && thread.projectId !== projectId)) return [];
        return [
          {
            threadId: hit.threadId,
            threadTitle: thread.title,
            projectId: thread.projectId,
            runId: hostedRunId(hit.threadId),
            messageId: hit.messageId,
            turn: hit.turn,
            role: hit.role,
            snippet: hit.snippet,
            ts: hit.at,
            taskId: null,
            taskTitle: null,
            member: hit.author ? { key: hit.author.id, name: hit.author.name } : null,
          },
        ];
      })
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  }

  /** Requests about a thread, made in its space; a rejection in words when the account no longer has it. */
  on(threadId: string): Requests {
    const request = this.deps.session.in(this.row(threadId).space);
    const generation = this.deps.session.generation;
    const ticket = this.#tickets.get(threadId) ?? Symbol();
    this.#tickets.set(threadId, ticket);
    const assert = () => {
      if (generation !== this.deps.session.generation || this.#tickets.get(threadId) !== ticket || !this.#rows().has(threadId)) throw new Refused("You no longer have access to this project.");
    };
    return {
      request: async (route, body) => {
        assert();
        const result = await request.request(route, body);
        assert();
        return result;
      },
    };
  }

  summary(threadId: string, spaceId?: string): ThreadSummary {
    const summary = this.#summaries(spaceId).find((each) => each.id === threadId);
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
    const space = this.on(threadId);
    await this.deps.follower.follow(threadId);
    const first = await firstPage(space, threadId, params);
    const fromTurn = first.fromTurn ?? 0;
    const events = await this.#readOn(space, threadId, first.events, first.head);
    this.observed(threadId, events);
    if (!row.parentId) this.#names.observed(threadId, events, fromTurn);
    return { events: events.map((event) => toAppEvent(threadId, event)), fromTurn, live: runsNow(row, this.reach) };
  }

  /** Every event of the run after a seq of its log. */
  async eventsAfter(runId: string, after: number): Promise<RpcResults["events.listForRun"]> {
    const threadId = this.#threadOf(runId);
    const space = this.on(threadId);
    await this.deps.follower.follow(threadId);
    const first = await space.request(ROUTES.events(threadId, { after }, READ_LIMIT));
    const events = await this.#readOn(space, threadId, first.events, first.head);
    this.observed(threadId, events);
    if (after === 0 && !this.row(threadId).parentId) this.#names.observed(threadId, events, 0);
    return events.map((event) => toAppEvent(threadId, event));
  }

  /** Register cloud ownership before a child card can be opened from a stored or live page. */
  observed(threadId: string, events: readonly WireEvent[]): void {
    if (this.voices.observe(threadId, events)) this.deps.push({ type: "invalidate", keys: [`authors:${threadId}`] });
    const heard = this.#heard;
    const parent = heard?.rows.find((row) => row.id === threadId);
    if (!heard || !parent) return;
    const children = nativeRowsFromEvents(parent, events, new Set(heard.rows.map((row) => row.id)));
    if (!children.length) return;
    heard.rows.push(...children.map((row) => ({ ...row, space: parent.space })));
    this.#save();
    this.#tell();
    void this.refresh();
  }

  /** A completion delivered to an open conversation can name its first turn even beyond discovery's age limit. */
  completed(threadId: string, seq: number): void {
    if (!this.#rows().get(threadId)?.parentId) this.#names.completed(threadId, seq);
  }

  /** Stops one command the agent left running in the background, as the Stop beside it on this Mac does. */
  async stopCommand(threadId: string, commandId: string): Promise<null> {
    await this.on(threadId).request(ROUTES.stopCommand(threadId, commandId));
    void this.refresh();
    return null;
  }

  /** A page that came back full is read on until the head. */
  async #readOn(space: Requests, threadId: string, events: WireEvent[], head: number): Promise<WireEvent[]> {
    let read = events;
    let all = events;
    while (read.length === READ_LIMIT && (all.at(-1)?.seq ?? head) < head) {
      read = (await space.request(ROUTES.events(threadId, { after: all.at(-1)!.seq }, READ_LIMIT))).events;
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
   * Reads the person's spaces, then each space's threads and projects, again. One read at a time; asks while one runs
   * fold into one more after it. The windows hear `threads` when anything differs. A failed read keeps what was heard.
   */
  refresh(): Promise<void> {
    if (!this.#reading) {
      const revision = this.#revision;
      const reading = this.#read().finally(() => {
        if (this.#reading === reading) this.#reading = null;
      });
      this.#reading = reading;
      // A notice of changed projects, members or spaces sets this read aside: whoever asked waits for the one after it.
      return reading.then(() => (this.#revision === revision || this.#closed ? undefined : (this.#again ?? this.refresh())));
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
    const generation = this.deps.session.generation;
    const revision = this.#revision;
    if (!state.signedIn || this.#closed) return;
    this.#closeFrozen();
    let read: Pick<Heard, "me" | "personal" | "rows" | "projects">;
    try {
      read = await this.#readSpaces();
    } catch (error) {
      if (!this.#currentRead(generation, revision)) return;
      this.deps.log.warn(`OpenOrc Cloud threads: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!this.#currentRead(generation, revision)) return;
    const before = JSON.stringify([this.#heard?.rows, this.#heard?.projects]);
    const projectsBefore = JSON.stringify(this.#heard?.projects);
    if (this.#heard?.email === state.email) this.#tellPerson(this.#heard.rows, read.rows);
    this.#forgetRemoved(read.rows);
    const previous = this.#heard?.email === state.email ? this.#heard : null;
    this.#heard = { email: state.email, heardAt: this.deps.now(), ...read, here: this.#keptHere(previous?.here ?? {}, read.rows), names: previous?.names ?? {} };
    this.#names.refresh(
      read.rows.filter((row) => !row.parentId),
      read.me,
      this.#heard.names,
    );
    this.#save();
    if (JSON.stringify([this.#heard.rows, this.#heard.projects]) !== before) this.#tell();
    // Settings shows which of this Mac's projects are on OpenOrc Cloud, read off these, and a space's cloud-only projects
    // are read through them: a window that asked about a new one before it was heard reads it again.
    if (JSON.stringify(this.#heard.projects) !== projectsBefore) this.deps.push({ type: "invalidate", keys: ["account", "projects"] });
  }

  #currentRead(generation: number, revision: number): boolean {
    return !this.#closed && this.deps.session.state.signedIn && this.deps.session.generation === generation && this.#revision === revision;
  }

  /**
   * Forgets the rows that left. A frozen person's threads come back with their access, so their unsent words stay; all
   * else about those threads goes.
   */
  #forgetRemoved(rows: HeardRow[]): void {
    const removed = this.#heard?.rows.filter((row) => !rows.some((next) => next.id === row.id)).map((row) => row.id) ?? [];
    const keepDrafts = this.deps.spaces.frozen();
    for (const id of removed) {
      this.#tickets.delete(id);
      const here = this.#heard?.here;
      const draft = here?.[id]?.draft;
      if (here && keepDrafts && draft) here[id] = { draft };
      else if (here) delete here[id];
    }
    this.deps.follower.forget(removed);
    this.voices.forget(removed);
  }

  /** What is kept of each thread here: only the listed ones', and while frozen the words of those that left. */
  #keptHere(here: Heard["here"], rows: HeardRow[]): Heard["here"] {
    if (this.deps.spaces.frozen()) return here;
    return Object.fromEntries(Object.entries(here).filter(([id]) => rows.some((row) => row.id === id)));
  }

  /** The spaces whose threads the person may read now: while frozen, their Personal space alone. */
  #readable(catalog: Pick<SpaceCatalog, "ids" | "personal">): string[] {
    return this.deps.spaces.frozen() ? catalog.ids.filter((id) => id === catalog.personal) : catalog.ids;
  }

  /** While frozen, an organization's threads close here as well, even with no answer from the server. */
  #closeFrozen(): void {
    const heard = this.#heard;
    if (!heard || !this.deps.spaces.frozen()) return;
    const rows = heard.rows.filter((row) => row.space === heard.personal);
    if (rows.length === heard.rows.length) return;
    this.#forgetRemoved(rows);
    heard.rows = rows;
    heard.projects = heard.projects.filter((project) => project.space === heard.personal);
    this.#save();
    this.#tell();
  }

  /** Every space's threads and projects, each tagged with its space, and the person's own id from their personal space. */
  async #readSpaces(): Promise<Pick<Heard, "me" | "personal" | "rows" | "projects">> {
    const generation = this.deps.session.generation;
    await this.deps.spaces.refresh();
    if (generation !== this.deps.session.generation) throw new Refused("Your OpenOrc session changed. Try again.");
    const catalog = await this.deps.spaces.catalog();
    if (generation !== this.deps.session.generation) throw new Refused("Your OpenOrc session changed. Try again.");
    this.#restrict(catalog);
    const ids = this.#readable(catalog);
    const read = await Promise.allSettled(
      ids.map(async (id) => {
        const on = this.deps.session.in(id);
        const listed = await on.request(ROUTES.threads);
        const rows = await readNativeRows(on, listed.threads, this.#heard?.rows.filter((row) => row.space === id) ?? []);
        return rows.map((row) => ({ ...row, space: id }));
      }),
    );
    const rows = read.flatMap((answer, i) => {
      if (answer.status === "fulfilled") return answer.value;
      if (answer.reason instanceof Refused && [403, 404].includes(answer.reason.status ?? 0)) return [];
      return this.#heard?.rows.filter((row) => row.space === ids[i]) ?? [];
    });
    const visible = rows.filter((row) => !row.projectId || catalog.projects.some((project) => project.id === row.projectId && project.space === row.space));
    return { me: catalog.me, personal: catalog.personal, rows: visible, projects: catalog.projects };
  }

  /** A confirmed project loss fences pending reads before the slower thread listings can return. */
  #restrict(catalog: SpaceCatalog): void {
    const heard = this.#heard;
    if (!heard) return;
    const ids = this.#readable(catalog);
    const rows = heard.rows.filter((row) => ids.includes(row.space) && (!row.projectId || catalog.projects.some((project) => project.id === row.projectId && project.space === row.space)));
    if (rows.length === heard.rows.length) return;
    this.#forgetRemoved(rows);
    heard.rows = rows;
    heard.projects = catalog.projects;
    this.#save();
    this.#tell();
  }

  /**
   * What the person hears of the rows that moved since the last listing: a new ask, or a turn that ended. A turn that
   * ends also wakes a snoozed thread, as on this Mac.
   */
  #tellPerson(before: readonly HeardRow[], after: readonly HeardRow[]): void {
    for (const { row, was } of noticed(before, after)) {
      if (was === "ask") {
        this.deps.notify(askNotice(row));
        continue;
      }
      const space = this.deps.session.in(row.space);
      if (row.snoozedUntil)
        void space.request(ROUTES.mine(row.id), { snoozedUntil: null }).then(
          (woke) => this.#hearRow(woke),
          () => undefined,
        );
      void endNotice(space, row).then(
        (notice) => notice && this.deps.notify(notice),
        (error: unknown) => this.deps.log.warn(`OpenOrc Cloud notice: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
  }

  /** The host is closing: an answer still on its way is dropped. */
  close(): void {
    this.#closed = true;
    this.#names.clear();
    this.deps.follower.forget();
  }

  /** Signed out: the rows and their kept copy go, and the windows read their lists again. */
  #changed(change: SessionChange): void {
    if (this.#generation !== this.deps.session.generation) {
      this.#names.clear();
      this.voices.forget();
      this.#generation = this.deps.session.generation;
      this.#reading = null;
      this.#again = null;
      this.#tickets.clear();
      const state = this.deps.session.state;
      if (state.signedIn) this.#heard = this.#cache.load(state.email);
    }
    if (!this.deps.session.state.signedIn) {
      const had = this.#heard !== null;
      this.#cache.forget(this.#heard?.me ?? null);
      this.#heard = null;
      return had ? this.#tell() : undefined;
    }
    // Reach shows on every row, so the lists are read again when it moves.
    if (this.#heard) this.#tell();
    if (change === "connected") void this.refresh();
  }

  #tell(): void {
    const next = new Map((this.#heard?.rows ?? []).map((row) => [row.id, toRuns(row, this.reach)]));
    const ids = new Set([...this.#toldRuns.keys(), ...next.keys()]);
    const changed = [...ids].filter((id) => JSON.stringify(this.#toldRuns.get(id)) !== JSON.stringify(next.get(id)));
    const resync = changed.filter((id) => {
      const before = this.#toldRuns.get(id);
      const after = next.get(id);
      return before !== undefined && after !== undefined && before.some((run) => run.endedAt === null) !== after.some((run) => run.endedAt === null);
    });
    this.#toldRuns = next;
    this.deps.push({ type: "invalidate", keys: ["threads", ...changed.map((id) => `runs:thread:${id}`)] });
    // A turn can start or park without a session event. Reload its snapshot to read the row's live state.
    if (resync.length) this.deps.push({ type: "gap", runIds: resync.map(hostedRunId) });
  }

  #rows(): Map<string, HeardRow> {
    return new Map((this.#heard?.rows ?? []).map((row) => [row.id, row]));
  }

  #save(): void {
    if (this.#heard) this.#cache.save(this.#heard.me, this.#heard.email, this.#heard);
  }

  #cloudProject(id: string): HeardProject | null {
    if (!id.startsWith(CLOUD_PROJECT)) return null;
    return this.#heard?.projects.find((project) => CLOUD_PROJECT + project.id === id) ?? null;
  }

  /** Every row in the app's shape, each under its Mac project, or under its own when this Mac has none. */
  #summaries(spaceId?: string, ownership?: "mine" | "everyone"): ThreadSummary[] {
    const heard = this.#heard;
    const state = this.deps.session.state;
    if (!heard || !state.signedIn) return [];
    const local = this.deps.projects();
    const visible = spaceId ? spaceProjects(spaceId, heard.personal ?? "", heard.projects, local) : null;
    const pairs = visible
      ? new Map(
          heard.projects
            .filter((project) => project.space === spaceId)
            .map((project) => [project.id, { macId: visible.find((row) => row.hostedProjectId === project.id)?.localProjectId ?? null, name: project.name }]),
        )
      : projectPairs(heard.projects, local);
    return heard.rows
      .filter((row) => (!spaceId || row.space === spaceId) && (!spaceId || ownership !== "mine" || row.startedBy?.id === heard.me))
      .map((row) => {
        const pair = row.projectId ? pairs.get(row.projectId) : undefined;
        const projectId = pair?.macId ?? CLOUD_PROJECT + (row.projectId ?? "none");
        const here = heard.here[row.id];
        const summary = toSummary(row, {
          projectId,
          orphanOf: pair?.macId ? null : (pair?.name ?? "OpenOrc Cloud"),
          reach: state.reach,
          heardAt: heard.heardAt,
          startedBy: starterOf(row, heard.me),
          collaboration: row.collaboration ? toCollaboration(row.collaboration) : null,
          now: this.deps.now(),
        });
        const native = withNativeSummary(summary, row);
        const moving = this.deps.moving?.(row.id) ?? null;
        const moved = moving ? { ...native, moving } : native;
        return here?.draft ? { ...moved, draft: here.draft } : moved;
      });
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
