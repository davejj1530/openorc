import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { incomingMove, projects, refusedMove, runs, settings, tasks, threads, type Db } from "@openorc/db";
import {
  mergeInbox,
  mergeTaskPages,
  mergeThreadPages,
  NOT_ON_BRAIN,
  ownerRoute,
  REMOTE_ATTACHMENT_BYTES,
  ROUTED_READS,
  rpcParams,
  type CloudService,
  type InboxList,
  type OwnerReach,
  type RpcMethod,
  type RpcParams,
  type RpcRequest,
  type Task,
  type ThreadSummary,
} from "@openorc/protocol";
import type { Logger, RpcReply, Transport } from "../transport.js";
import { BrainOutOfReach, type BrainLink, type BrainPush, type ProjectMapping } from "./brain-link.js";
import type { BrainMirrors } from "./brain-mirrors.js";
import { BrainStarts } from "./brain-starts.js";

const PAGES = "brain.pages";
const MAX_PAGES = 40;
/** The lists a push about changed threads refreshes: the newest asked, which the windows most likely show. */
const RECENT_PAGES = 8;
/** A run a window looked at stays in the brain's interest this long after its last frame or read. */
const WATCH_MS = 5 * 60_000;
const READS_RUN = new Set<RpcMethod>(["events.page", "events.listForRun", "events.toolOutput", "runs.send", "approvals.resolve", "runs.interrupt"]);
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
/** The UUID attachments.saveFile puts before a file's name here; the brain puts its own. */
const STORED_PREFIX = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-/;

type Merged = "threads.list" | "threads.resolvedCount" | "inbox.list" | "tasks.list";
/** What windows hear when a merged list changed. */
const LIST_KEYS: Record<Merged, string> = { "threads.list": "threads", "threads.resolvedCount": "threads", "inbox.list": "inbox", "tasks.list": "tasks" };
interface Page {
  method: Merged;
  params: unknown;
  result: unknown;
  heardAt: number;
}

/**
 * The brain's last answers to the lists windows ask, so the sidebar lists cloud threads while the brain sleeps or the
 * Mac is offline, across restarts too. Written only from the brain's answers; never authoritative.
 */
export class BrainPages {
  private kept: Map<string, Page> | null = null;
  private saving: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly db: Db) {}

  /** Read once, at the first list a window asks with a brain set up. */
  private get pages(): Map<string, Page> {
    if (this.kept) return this.kept;
    this.kept = new Map();
    try {
      for (const page of JSON.parse(settings.get(this.db, PAGES) ?? "[]") as Page[]) this.kept.set(pageKey(page.method, page.params), page);
    } catch {
      // A cache that does not read starts empty.
    }
    return this.kept;
  }

  peek(method: Merged, params: unknown): Page | null {
    return this.pages.get(pageKey(method, params)) ?? null;
  }

  /** True when the answer differs from the one kept. */
  heard(method: Merged, params: unknown, result: unknown, at: number): boolean {
    const key = pageKey(method, params);
    const changed = JSON.stringify(this.pages.get(key)?.result) !== JSON.stringify(result);
    this.pages.delete(key);
    this.pages.set(key, { method, params, result, heardAt: at });
    for (const old of this.pages.keys()) if (this.pages.size > MAX_PAGES) this.pages.delete(old);
    this.saving ??= setTimeout(() => this.save(), 1000);
    return changed;
  }

  /** The lists windows asked lately, newest last. */
  recent(): Page[] {
    return [...this.pages.values()];
  }

  clear(): void {
    if (this.saving) clearTimeout(this.saving);
    this.saving = null;
    this.kept = new Map();
    settings.remove(this.db, PAGES);
  }

  save(): void {
    if (this.saving) clearTimeout(this.saving);
    this.saving = null;
    if (this.kept) settings.set(this.db, PAGES, JSON.stringify([...this.kept.values()]));
  }
}

const pageKey = (method: string, params: unknown) => `${method} ${JSON.stringify(params)}`;

export interface BrainRouterDeps {
  db: Db;
  link: BrainLink;
  /** The read-only folder a cloud thread opened on this Mac has here, and a pull of it when its files changed. */
  mirrors: Pick<BrainMirrors, "folder" | "isOpen" | "pull">;
  /** This core's own dispatch, as `handle` has it without the router. */
  local(request: RpcRequest): Promise<RpcReply>;
  /** The windows alone: what the brain pushes never reaches this Mac's phones, which hear the brain themselves. */
  windows: Transport;
  mapping(): Promise<ProjectMapping>;
  /** Wakes the brain as Wake does, for a thread a window starts there. */
  wake(): Promise<void>;
  /** CloudBrain installs a newer brain before it starts it. */
  updating(): boolean;
  /** The service the brain's new threads run on, as Settings says. */
  service(): Promise<CloudService | null>;
  /** Why a new cloud thread waits now, as while the brain moves to another service; null when it need not. */
  holding?(): Promise<string | null>;
  notificationsOn(): boolean;
  log: Logger;
}

const error = (id: number, message: string): RpcReply => ({ type: "rpc.error", id, message });

/**
 * A window's calls while a cloud brain is set up. Windows stay single-host: a call about a thread or run this ledger
 * lacks goes to the brain, its rows rehomed onto this Mac's projects and marked as the cloud's; lists answer at once
 * from this Mac plus the brain's last answer, then refresh in the background. Phones never come here.
 */
export class BrainRouter {
  readonly pages: BrainPages;
  readonly starts: BrainStarts;
  private readonly watched = new Map<string, number>();
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;

  constructor(private readonly deps: BrainRouterDeps) {
    this.pages = new BrainPages(deps.db);
    this.starts = new BrainStarts({
      wake: () => deps.wake(),
      start: async (params) => {
        const mapping = await deps.mapping();
        await deps.link.call("threads.start", (await this.filesUp(toCloud(params, mapping))) as never, { wake: true });
      },
      queue: async (params) => {
        const reply = await this.forward({ type: "rpc", id: 0, method: "threads.queue", params }, "threads.queue", params, true, true);
        if (reply.type === "rpc.error") throw new Error(reply.message);
      },
      listed: () => this.refreshRecent(),
      changed: (id) => deps.windows.push({ type: "invalidate", keys: ["threads", `thread:${id}`] }),
      updating: () => deps.updating(),
      reach: () => deps.link.reach,
      warn: (text) => deps.log.warn(text),
    });
    deps.link.onPush((push) => this.relay(push));
    // Cloud rows dim while the brain is out of reach, so the lists are read again whenever that changes.
    deps.link.onReach(() => deps.windows.push({ type: "invalidate", keys: ["threads"] }));
  }

  async handle(request: RpcRequest): Promise<RpcReply> {
    const method = request.method as RpcMethod;
    const route = Object.hasOwn(rpcParams, method) ? ownerRoute(method) : undefined;
    const parsed = route && route.by !== "here" ? rpcParams[method].safeParse(request.params ?? {}) : null;
    if (!route || !parsed?.success) return this.deps.local(request);
    const params = parsed.data as never;
    switch (route.by) {
      case "merge":
        return this.listed(request, method, params, route.thread?.(params));
      case "task":
        return this.task(request, method, params, route.task(params));
      case "run":
        // A run's reads follow its thread's, which wake the brain when a person opens it; they wait for that wake.
        return runs.get(this.deps.db, route.run(params)) ? this.deps.local(request) : this.forward(request, method, params, this.wakes(request, method, false), true);
      case "owner":
      case "owner-only":
        return this.owned(request, method, params, route.thread(params), route.by === "owner-only" ? route.words : null);
      case "start":
        return this.start(request, params, route.cloud(params));
      default:
        return this.deps.local(request);
    }
  }

  /** A call about one thread: this Mac's own answers it; a cloud thread's goes to the brain, unless only its owner may. */
  private owned(request: RpcRequest, method: RpcMethod, params: Record<string, unknown>, id: string | undefined, ownerOnly: string | null): Promise<RpcReply> {
    if (!id || threads.get(this.deps.db, id)) return this.deps.local(request);
    if (ownerOnly !== null) return Promise.resolve(error(request.id, ownerOnly));
    const starting = this.starts.answer(request, method, params, id);
    if (starting) return starting;
    const kept = method === "threads.get" ? this.kept(request, id) : null;
    const known = this.holdsThread(id);
    return kept ? Promise.resolve(kept) : this.forward(request, method, params, this.wakes(request, method, known), known);
  }

  /** A list from every host, merged; asked about one thread, its owner's alone. */
  private listed(request: RpcRequest, method: RpcMethod, params: Record<string, unknown>, thread: string | undefined): Promise<RpcReply> {
    return thread ? this.owned(request, method, params, thread, null) : this.merge(request, method as Merged, params);
  }

  /** A call about one task: this Mac's own answers it; one the brain holds goes there. */
  private task(request: RpcRequest, method: RpcMethod, params: Record<string, unknown>, id: string | undefined): Promise<RpcReply> {
    if (!id || tasks.get(this.deps.db, id)) return this.deps.local(request);
    const known = this.holdsTask(id);
    return this.forward(request, method, params, this.wakes(request, method, known), known);
  }

  /**
   * Whether a call wakes the brain: only a person's own. A window reading again what it shows never does, and a read
   * does only for a thread or task the brain is known to hold, so a pane of a thread just deleted here never wakes it.
   */
  private wakes(request: RpcRequest, method: RpcMethod, known: boolean): boolean {
    return !request.refresh && (known || !ROUTED_READS.has(method));
  }

  /** The brain holds this thread as far as this Mac knows: in its last lists, open here as a copy, or coming here. */
  private holdsThread(id: string): boolean {
    if (incomingMove(this.deps.db, id) || this.deps.mirrors.folder(id)) return true;
    return this.pages
      .recent()
      .some(({ method, result }) =>
        method === "threads.list"
          ? (result as ThreadSummary[]).some((row) => row.id === id)
          : method === "inbox.list" && (result as InboxList).items.some((item) => item.kind === "thread" && item.thread.id === id),
      );
  }

  /** The brain holds this task as far as its last lists say. */
  private holdsTask(id: string): boolean {
    return this.pages
      .recent()
      .some(({ method, result }) =>
        method === "tasks.list" ? (result as Task[]).some((row) => row.id === id) : method === "inbox.list" && (result as InboxList).items.some((item) => item.kind === "task" && item.task.id === id),
      );
  }

  /**
   * A new thread asked for the cloud starts on the brain, on its copy of the project, woken for it. The window has it at
   * once, under the id the brain makes it with, and sees the wake as its first step; the brain's row replaces it.
   */
  private async start(request: RpcRequest, params: Record<string, unknown>, project: string | undefined): Promise<RpcReply> {
    if (!project) return this.deps.local(request);
    const held = await this.deps.holding?.();
    if (held) return error(request.id, held);
    if (!(await this.deps.mapping()).toCloud(project)) return error(request.id, NOT_ON_BRAIN);
    const place = { provider: (await this.deps.service()) ?? "vercel", setup: Boolean(projects.get(this.deps.db, project)?.settings.setupScript) };
    return { type: "rpc.result", id: request.id, result: { thread: this.starts.begin(params as RpcParams<"threads.start">, place), run: null } };
  }

  /**
   * A window's call for a thread the brain may hold, woken for it when `wake`. One about a thread or task this Mac does
   * not know the brain holds (`known` false) is this Mac's to answer when the brain is out of reach, as without a brain.
   */
  private async forward(request: RpcRequest, method: RpcMethod, params: Record<string, unknown>, wake: boolean, known: boolean): Promise<RpcReply> {
    if (READS_RUN.has(method) && typeof params["runId"] === "string") this.watch(params["runId"]);
    try {
      const mapping = await this.deps.mapping();
      const result = await this.deps.link.call(method, (await this.filesUp(toCloud(params, mapping))) as never, { wake });
      const rehomed = rehome(result, mapping, { brain: "cloud", reach: "live", heardAt: Date.now() }, this.deps.mirrors);
      if (method === "threads.get" && isThread(rehomed) && rehomed.liveRunId) this.watch(rehomed.liveRunId);
      return { type: "rpc.result", id: request.id, result: isThread(rehomed) ? this.asNow(rehomed) : rehomed };
    } catch (caught) {
      if (caught instanceof BrainOutOfReach && !known) return this.deps.local(request);
      return error(request.id, caught instanceof Error ? caught.message : String(caught));
    }
  }

  /**
   * This Mac's answer now, merged with the brain's last; the brain's part refreshes behind it. A later page asks each
   * host for everything up to its end, since either host's rows can fill it.
   */
  private async merge(request: RpcRequest, method: Merged, asked: Record<string, unknown>): Promise<RpcReply> {
    const offset = method === "threads.list" && typeof asked["offset"] === "number" ? asked["offset"] : 0;
    const params = offset ? { ...asked, offset: 0, ...(typeof asked["limit"] === "number" ? { limit: offset + asked["limit"] } : {}) } : asked;
    const local = await this.deps.local(offset ? { ...request, params } : request);
    if (local.type === "rpc.error") return local;
    const mapping = await this.deps.mapping();
    const cloud = method === "inbox.list" ? params : listParams(params, mapping);
    if (cloud) void this.refresh(method, cloud, mapping);
    const page = cloud ? this.pages.peek(method, cloud) : null;
    if (method === "threads.list") return this.mergeThreads(local, params, page, offset);
    if (!page) return local;
    if (method === "threads.resolvedCount") return { ...local, result: (local.result as number) + (page.result as number) };
    if (method === "inbox.list") return { ...local, result: mergeInbox([{ inbox: local.result as InboxList }, { inbox: page.result as InboxList }]) };
    const reach: OwnerReach = this.deps.link.reach;
    return {
      ...local,
      result: mergeTaskPages(
        [
          { brain: "mac", reach: "live", heardAt: Date.now(), rows: local.result as Task[] },
          { brain: "cloud", reach, heardAt: page.heardAt, rows: page.result as Task[] },
        ],
        "mac",
      ),
    };
  }

  /** This Mac's threads, the brain's as it last listed them, and those still starting there that the list asks for. */
  private mergeThreads(local: RpcReply & { type: "rpc.result" }, params: Record<string, unknown>, page: Page | null, offset: number): RpcReply {
    const brainRows = (page?.result ?? []) as ThreadSummary[];
    const starting = new Map(this.starts.rows(startingIn(params)).flatMap((row) => (brainRows.some((each) => each.id === row.id) ? [] : [[row.id, row] as const])));
    if (!page && !starting.size) return offset ? { ...local, result: (local.result as ThreadSummary[]).slice(offset) } : local;
    const merged = mergeThreadPages(
      [
        { brain: "mac", reach: "live", heardAt: Date.now(), rows: local.result as ThreadSummary[] },
        { brain: "cloud", reach: this.deps.link.reach, heardAt: page?.heardAt ?? Date.now(), rows: [...brainRows, ...starting.values()] },
      ],
      params,
      "mac",
    );
    return { ...local, result: merged.slice(offset).map((row) => starting.get(row.id) ?? this.asNow(row)) };
  }

  /**
   * A cloud thread a window opens while the brain is not live: its row as the brain last listed it, at once and without
   * waking it, so the conversation shows while the brain sleeps or wakes. The reach change after has windows read it again.
   */
  private kept(request: RpcRequest, id: string): RpcReply | null {
    const reach = this.deps.link.reach;
    if (reach === "live") return null;
    for (const page of this.pages.recent().reverse()) {
      const row = page.method === "threads.list" ? (page.result as ThreadSummary[]).find((each) => each.id === id) : undefined;
      if (row) return { type: "rpc.result", id: request.id, result: this.asNow({ ...row, owner: { brain: "cloud", reach, heardAt: page.heardAt } }) };
    }
    return null;
  }

  /**
   * A cloud row as it is on this Mac now rather than when the brain answered: open here as a read-only copy, or on its way
   * here, which the brain does not know until it freezes its copy.
   */
  private asNow(row: ThreadSummary): ThreadSummary {
    if (!row.owner) return row;
    const folder = this.deps.mirrors.folder(row.id);
    const moving = incomingMove(this.deps.db, row.id) ?? row.moving;
    // Bring to Mac is this Mac's own move, so its refusal is in this Mac's journal, never the brain's row.
    const moveRefused = refusedMove(this.deps.db, row.id);
    const mirrored = folder ? { worktreePath: folder, owner: { ...row.owner, mirror: true } } : {};
    return { ...row, ...mirrored, ...(moving ? { moving } : {}), ...(moveRefused ? { moveRefused } : {}) };
  }

  /** The files a call names, stored on the brain first: it cannot read this Mac's files. Images stay images there. */
  private async filesUp(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const files = params["attachments"];
    if (!Array.isArray(files) || !files.length) return params;
    const stored: string[] = [];
    for (const file of files as string[]) {
      if ((await stat(file)).size > REMOTE_ATTACHMENT_BYTES) throw new Error(`Files sent to a conversation in the cloud must be ${REMOTE_ATTACHMENT_BYTES / 1024 / 1024} MB or smaller.`);
      const dataBase64 = (await readFile(file)).toString("base64");
      const mime = IMAGE_TYPES[path.extname(file).slice(1).toLowerCase()];
      const saved = mime
        ? await this.deps.link.call("attachments.save", { name: path.basename(file), mime, dataBase64 }, { wake: true })
        : await this.deps.link.call("attachments.saveFile", { name: path.basename(file).replace(STORED_PREFIX, ""), dataBase64 }, { wake: true });
      stored.push(saved.path);
    }
    return { ...params, attachments: stored };
  }

  /** The brain's answer to a list, kept; windows hear the list changed only when it did. Never wakes the brain. */
  private async refresh(method: Merged, params: unknown, mapping: ProjectMapping): Promise<void> {
    try {
      const result = rehome(await this.deps.link.call(method, params as never, { wake: false }), mapping, null, this.deps.mirrors);
      if (this.pages.heard(method, params, result, Date.now())) this.deps.windows.push({ type: "invalidate", keys: [LIST_KEYS[method]] });
    } catch (caught) {
      if (!(caught instanceof BrainOutOfReach)) this.deps.log.warn(`the cloud brain's list did not refresh: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }

  private watch(runId: string): void {
    this.watched.set(runId, Date.now() + WATCH_MS);
    this.updateInterest();
  }

  private updateInterest(): void {
    const now = Date.now();
    for (const [runId, until] of this.watched) if (until <= now) this.watched.delete(runId);
    this.deps.link.setInterest([...this.watched.keys()]);
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    if (!this.watched.size) return;
    // A window that stops reading must let the brain sleep without another call to notice it.
    this.expiry = setTimeout(() => this.updateInterest(), Math.min(...this.watched.values()) - now);
    this.expiry.unref?.();
  }

  /** The brain's pushes, to the windows alone. A list that changed is refreshed first, then the windows hear of it once. */
  private relay(push: BrainPush): void {
    const { windows } = this.deps;
    if (push.type === "gap") return windows.push({ type: "gap", runIds: push.runIds });
    const body = push.push;
    switch (body.type) {
      case "frame":
        if (!this.watched.has(body.frame.runId)) return;
        this.watch(body.frame.runId);
        return windows.push({ type: "frame", frame: body.frame });
      case "invalidate": {
        const lists: string[] = body.keys.filter((key) => Object.values(LIST_KEYS).includes(key));
        const rest = body.keys.filter((key) => !lists.includes(key));
        if (rest.length) windows.push({ type: "invalidate", keys: rest });
        // An open copy on this Mac follows the brain's files.
        for (const key of rest) if (key.startsWith("threaddiff:") && this.deps.mirrors.isOpen(key.slice("threaddiff:".length))) void this.deps.mirrors.pull(key.slice("threaddiff:".length));
        if (lists.length) void this.refreshRecent();
        return;
      }
      case "notify":
        if (this.deps.notificationsOn()) windows.push(body);
        return;
      default:
        return;
    }
  }

  /** One refresh of the recent lists at a time; pushes while it runs ask for one more after it, however many arrive. */
  private refreshRecent(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    const round = async () => {
      do {
        this.refreshAgain = false;
        const mapping = await this.deps.mapping();
        for (const page of this.pages.recent().slice(-RECENT_PAGES)) await this.refresh(page.method, page.params, mapping);
      } while (this.refreshAgain);
    };
    const refreshing = round()
      .catch((caught: unknown) => this.deps.log.warn(`the cloud brain's lists did not refresh: ${caught instanceof Error ? caught.message : String(caught)}`))
      .finally(() => (this.refreshing = null));
    this.refreshing = refreshing;
    return refreshing;
  }

  close(): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    this.pages.save();
  }
}

/** Whether a thread still starting on the brain belongs in a list asked with these params: an active one of its project. */
function startingIn(params: Record<string, unknown>): (row: ThreadSummary) => boolean {
  return (row) => {
    if (params["filter"] === "done" || params["filter"] === "archived" || params["pinnedOnly"] === true) return false;
    if (typeof params["projectId"] === "string" && params["projectId"] !== row.projectId) return false;
    return !Array.isArray(params["projectIds"]) || (params["projectIds"] as string[]).includes(row.projectId);
  };
}

/** A thread list for the brain: this Mac's project ids as the brain's copies; null when no project asked has a copy. */
function listParams(params: Record<string, unknown>, mapping: ProjectMapping): Record<string, unknown> | null {
  const next = { ...params };
  if (typeof params["projectId"] === "string") {
    const project = mapping.toCloud(params["projectId"]);
    if (!project) return null;
    next["projectId"] = project;
  }
  if (Array.isArray(params["projectIds"])) {
    const projects = (params["projectIds"] as string[]).flatMap((id) => mapping.toCloud(id) ?? []);
    if (!projects.length) return null;
    next["projectIds"] = projects;
  }
  return next;
}

function toCloud(params: Record<string, unknown>, mapping: ProjectMapping): Record<string, unknown> {
  return typeof params["projectId"] === "string" ? { ...params, projectId: mapping.toCloud(params["projectId"]) ?? params["projectId"] } : params;
}

const isInbox = (value: unknown): value is InboxList => typeof value === "object" && value !== null && Array.isArray((value as Partial<InboxList>).items);
const isThread = (value: unknown): value is ThreadSummary => typeof value === "object" && value !== null && "projectId" in value && "worktreePath" in value;
const isStarted = (value: unknown): value is { thread: ThreadSummary } => typeof value === "object" && value !== null && "thread" in value && isThread(value.thread);

/**
 * Brain rows as this Mac's windows read them: on this Mac's project, with no folder a window could act on, and marked
 * as the cloud's when `owner` is given. Lists are marked where they are merged.
 */
function rehome(value: unknown, mapping: ProjectMapping, owner: ThreadSummary["owner"] | null, mirrors: Pick<BrainMirrors, "folder">): unknown {
  if (Array.isArray(value)) return value.map((item) => rehome(item, mapping, owner, mirrors));
  if (isStarted(value)) return { ...value, thread: rehome(value.thread, mapping, owner, mirrors) };
  if (isInbox(value))
    return {
      ...value,
      items: value.items.map((item) => (item.kind === "thread" ? { ...item, thread: rehome(item.thread, mapping, null, mirrors) } : { ...item, task: rehome(item.task, mapping, null, mirrors) })),
    };
  if (!isThread(value)) return value;
  const mirror = mirrors.folder(value.id);
  const marked = owner ? { owner: mirror ? { ...owner, mirror: true } : owner } : {};
  return { ...value, projectId: mapping.toMac(value.projectId) ?? value.projectId, worktreePath: mirror, ...marked };
}
