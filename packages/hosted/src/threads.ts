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
  type ThreadSummary,
} from "@openorc/protocol";
import { z } from "zod";
import { ANSWERS, NOT_YET } from "./thread-answers.js";
import type { HostedDeps, HostedThreads, MergedMethod, PlacePage } from "./index.js";
import { READ_LIMIT, type Follower } from "./follow.js";
import type { Account } from "./account.js";
import type { SpaceCatalog, Spaces } from "./spaces.js";
import { spaceProjects } from "./space-projects.js";
import { AccountCache } from "./account-cache.js";
import { keptThreadNames, ThreadNames } from "./thread-names.js";
import { askNotice, endNotice, noticed } from "./notices.js";
import * as sends from "./sends.js";
import { Refused, type Requests, type Session, type SessionChange } from "./session.js";
import { CLOUD_PROJECT, githubRepoOf, listRows, projectPairs, resolvedCount, runsNow, starterOf, toAppEvent, toRuns, toSummary } from "./translate.js";
import { ROUTES, SOCKET, wireProject, wireThread, wireTopics, type WireEvent, type WireThread } from "./wire.js";

import { nativeRowFields } from "./wire-subthreads.js";
import { readNativeRows } from "./subthreads.js";
import { nativeRowsFromEvents, withNativeSummary } from "./translate-subthreads.js";
import { assertNativeCall } from "./subthread-calls.js";

const GONE = "That conversation isn't on OpenOrc Cloud.";

/** What this device keeps of a thread for itself: the half-written message, which never leaves it. */
const kept = z.object({ draft: z.string().nullable().optional(), nativeStop: z.object({ id: z.uuid(), expectedRunId: z.string() }).optional() });
export type KeptHere = z.infer<typeof kept>;

/** A row and a project as heard, each with the space it was read in. */
const heardRow = wireThread.extend({ space: z.string(), ...nativeRowFields });
const heardProject = wireProject.extend({ space: z.string() });
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

type ThreadsDeps = { session: Session; spaces: Spaces; follower: Follower; account: Pick<Account, "status" | "refused"> } & Pick<
  HostedDeps,
  "server" | "kept" | "projects" | "push" | "notify" | "nameThread" | "now" | "log"
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

  constructor(private readonly deps: ThreadsDeps) {
    this.#cache = new AccountCache({ kept: deps.kept, part: "threads", server: deps.server, schema: keptThreads });
    this.#names = new ThreadNames({ nameThread: deps.nameThread, now: deps.now, log: deps.log, on: (id) => this.on(id), saved: (row) => this.#hearRow(row), keep: () => this.#save() });
    this.calls = {
      on: (threadId) => this.on(threadId),
      row: (threadId) => this.row(threadId),
      readOnly: (threadId) => starterOf(this.row(threadId), this.#heard?.me ?? null) !== null,
      refresh: () => this.refresh(),
      account: () => deps.account.status(),
      refused: (refusal, settings) => deps.account.refused(refusal, settings),
      now: deps.now,
    };
    deps.session.onChange((change) => this.#changed(change));
    deps.session.onSocket(SOCKET.changed, (body) => {
      const topics = wireTopics.safeParse(body);
      if (topics.success && topics.data.topics.some((topic) => topic === "threads" || topic === "projects" || topic === "members" || topic === "spaces")) {
        if (topics.data.topics.some((topic) => topic === "projects" || topic === "members" || topic === "spaces")) this.#revision++;
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
      gitRemote: `https://github.com/${project.fullName}`,
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
  async remove(threadId: string): Promise<null> {
    await this.on(threadId).request(ROUTES.remove(threadId));
    const heard = this.#heard;
    if (heard) {
      heard.rows = heard.rows.filter((row) => row.id !== threadId);
      this.#tickets.delete(threadId);
      this.deps.follower.forget([threadId]);
      delete heard.here[threadId];
      this.#save();
      this.#tell();
    }
    return null;
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
   * threads.start on OpenOrc Cloud: a new thread on the server project with the Mac project's repository, in the
   * person's personal space when they have it in several, with the prompt as its first message. A first message the
   * server refuses makes no thread; the start then fails with the words the card above a composer shows.
   */
  async startThread(params: RpcParams<"threads.start">): Promise<RpcResults["threads.start"]> {
    const settings = startSettings(params);
    if (!isHostedAgent(settings.agent)) throw new Refused(`${harnessShortName(settings.agent)} doesn't run on OpenOrc Cloud.`);
    if (params.attachments?.length) throw new Refused("Files can't be sent to OpenOrc Cloud yet.");
    const project = this.#projectFor(params.projectId, params.spaceId);
    if (!project) throw new Refused(params.spaceId ? "This project isn't available in this space." : "Add this project to OpenOrc Cloud in Settings first.");
    const generation = this.deps.session.generation;
    const body = { projectId: project.id, ...(params.title && { title: params.title }), settings, first: { id: crypto.randomUUID(), text: params.prompt }, ready: true };
    const reply = await this.deps.session.in(project.space).request(ROUTES.start, body);
    if (generation !== this.deps.session.generation) throw new Refused("Your OpenOrc session changed. Try again.");
    if (!this.#heard?.projects.some((row) => row.id === project.id && row.space === project.space)) throw new Refused("You no longer have access to this project.");
    if (!reply.thread) return sends.refuse(this.calls, reply.first?.sent === false ? reply.first.refusal : "", settings);
    const row = { ...reply.thread, space: project.space };
    const heard = this.#heard;
    if (heard && !heard.rows.some((each) => each.id === row.id)) {
      heard.rows = [row, ...heard.rows];
      this.#save();
      this.#tell();
    }
    void this.refresh();
    return { thread: this.summary(row.id, params.spaceId), run: toRuns(row, this.reach)[0] ?? null };
  }

  /** Explicit scopes select that space's project. Legacy starts prefer Personal, then another matching space. */
  #projectFor(macId: string, spaceId?: string): HeardProject | null {
    const heard = this.#heard;
    if (macId.startsWith(CLOUD_PROJECT)) return heard?.projects.find((project) => CLOUD_PROJECT + project.id === macId && (!spaceId || project.space === spaceId)) ?? null;
    const remote = this.deps.projects().find((project) => project.id === macId)?.remote ?? null;
    const repo = githubRepoOf(remote);
    if (!heard || !repo) return null;
    const matching = heard.projects.filter((project) => project.fullName.toLowerCase() === repo && (!spaceId || project.space === spaceId));
    return matching.find((project) => project.space === heard.personal) ?? matching[0] ?? null;
  }

  /** The repositories every space of the person's has as projects, owner/name in lower case. */
  cloudRepos(): ReadonlySet<string> {
    return new Set((this.#heard?.projects ?? []).map((project) => project.fullName.toLowerCase()));
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
  row(threadId: string): HeardRow {
    const row = this.#rows().get(threadId);
    if (!row) throw new Error(GONE);
    return row;
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
    let fromTurn = params.fromTurn ?? 0;
    if (params.fromTurn === undefined && params.turns !== undefined) {
      const detail = await space.request(ROUTES.thread(threadId));
      fromTurn = Math.max(0, detail.turnEnds.length - params.turns);
    }
    const first = await space.request(ROUTES.events(threadId, { fromTurn }, READ_LIMIT));
    const events = await this.#readOn(space, threadId, first.events, first.head);
    this.observed(threadId, events);
    if (!row.parentId) this.#names.observed(threadId, events, first.fromTurn ?? fromTurn);
    return { events: events.map((event) => toAppEvent(threadId, event)), fromTurn: first.fromTurn ?? fromTurn, live: runsNow(row, this.reach) };
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
      const reading = this.#read().finally(() => {
        if (this.#reading === reading) this.#reading = null;
      });
      this.#reading = reading;
      return reading;
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
    this.#heard = { email: state.email, heardAt: this.deps.now(), ...read, here: previous?.here ?? {}, names: previous?.names ?? {} };
    this.#names.refresh(
      read.rows.filter((row) => !row.parentId),
      read.me,
      this.#heard.names,
    );
    this.#save();
    if (JSON.stringify([this.#heard.rows, this.#heard.projects]) !== before) this.#tell();
    // Settings shows which of this Mac's projects are on OpenOrc Cloud, read off these.
    if (JSON.stringify(this.#heard.projects) !== projectsBefore) this.deps.push({ type: "invalidate", keys: ["account"] });
  }

  #currentRead(generation: number, revision: number): boolean {
    return !this.#closed && this.deps.session.state.signedIn && this.deps.session.generation === generation && this.#revision === revision;
  }

  #forgetRemoved(rows: HeardRow[]): void {
    const removed = this.#heard?.rows.filter((row) => !rows.some((next) => next.id === row.id)).map((row) => row.id) ?? [];
    for (const id of removed) {
      this.#tickets.delete(id);
      if (this.#heard) delete this.#heard.here[id];
    }
    this.deps.follower.forget(removed);
  }

  /** Every space's threads and projects, each tagged with its space, and the person's own id from their personal space. */
  async #readSpaces(): Promise<Pick<Heard, "me" | "personal" | "rows" | "projects">> {
    const generation = this.deps.session.generation;
    await this.deps.spaces.refresh();
    if (generation !== this.deps.session.generation) throw new Refused("Your OpenOrc session changed. Try again.");
    const catalog = await this.deps.spaces.catalog();
    if (generation !== this.deps.session.generation) throw new Refused("Your OpenOrc session changed. Try again.");
    this.#restrict(catalog);
    const read = await Promise.allSettled(
      catalog.ids.map(async (id) => {
        const on = this.deps.session.in(id);
        const listed = await on.request(ROUTES.threads);
        const rows = await readNativeRows(on, listed.threads, this.#heard?.rows.filter((row) => row.space === id) ?? []);
        return rows.map((row) => ({ ...row, space: id }));
      }),
    );
    const rows = read.flatMap((answer, i) => {
      if (answer.status === "fulfilled") return answer.value;
      if (answer.reason instanceof Refused && [403, 404].includes(answer.reason.status ?? 0)) return [];
      return this.#heard?.rows.filter((row) => row.space === catalog.ids[i]) ?? [];
    });
    const visible = rows.filter((row) => !row.projectId || catalog.projects.some((project) => project.id === row.projectId && project.space === row.space));
    return { me: catalog.me, personal: catalog.personal, rows: visible, projects: catalog.projects };
  }

  /** A confirmed project loss fences pending reads before the slower thread listings can return. */
  #restrict(catalog: SpaceCatalog): void {
    const heard = this.#heard;
    if (!heard) return;
    const rows = heard.rows.filter((row) => catalog.ids.includes(row.space) && (!row.projectId || catalog.projects.some((project) => project.id === row.projectId && project.space === row.space)));
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
          now: this.deps.now(),
        });
        const native = withNativeSummary(summary, row);
        return here?.draft ? { ...native, draft: here.draft } : native;
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

/** The settings a start runs with, as the server names them: its execution target's model, or the fields older callers send. */
function startSettings(params: RpcParams<"threads.start">): {
  agent: HostedAgentOrOther;
  model: string | null;
  effort: string | null;
  mode: RpcParams<"threads.start">["mode"];
  permissionMode: RpcParams<"threads.start">["permissionMode"];
} {
  const chosen = params.executionTarget?.kind === "model" ? params.executionTarget.settings : null;
  const agent = chosen?.agent ?? params.agent ?? "claude";
  return { agent, model: (chosen ? chosen.model : params.model) ?? null, effort: (chosen ? chosen.effort : params.effort) ?? null, mode: params.mode, permissionMode: params.permissionMode };
}

type HostedAgentOrOther = NonNullable<RpcParams<"threads.start">["agent"]>;
