import { randomUUID } from "node:crypto";
import type {
  OnlineBoard,
  OnlineBoardSave,
  OnlineTaskAvailability,
  OnlineTaskEnvelope,
  OnlineTaskExecutionParams,
  OnlineTaskMutation,
  OnlineTaskParams,
  OnlineTaskRpcResults,
} from "@openorc/protocol";
import type { HostedDeps, HostedSpaces } from "./index.js";
import { Refused, type Session } from "./session.js";
import { TaskChanged, taskCreation, taskRefusal, taskRequest, type TaskRefusal } from "./task-requests.js";
import { taskThreadRoute } from "./task-thread-wire.js";
import { prepareTaskThread } from "./task-threads.js";
import { TASK_ROUTES } from "./wire-tasks.js";
import { PARITY_ROUTES } from "./wire-parity.js";
import { SOCKET, wireTopics, type Route } from "./wire.js";

export interface TaskDelivery {
  organization: boolean;
  personal: boolean;
}
/** Each delivery opens only after its paired server and compatibility checks pass. Opening task threads is the server's to say. */
export const taskDelivery: Readonly<TaskDelivery> = { organization: true, personal: true };
/** How long a space's answer on what its server does with tasks holds before it is asked again. */
const SERVES_HOLD_MS = 5 * 60_000;
interface Dependencies extends Pick<HostedDeps, "push"> {
  session: Session;
  spaces: Pick<HostedSpaces, "status">;
  delivery?: Readonly<TaskDelivery>;
  prepared?(threadId: string): Promise<void>;
}
interface Identity {
  userId: string;
  generation: number;
  epoch: number;
}
const changed = () => new Refused("Your OpenOrc session or project access changed. Try again.");
const unavailable = () => new Refused("This task isn't available.", 404);
/** What a space's server does with its tasks beyond keeping them. */
type Serves = { execution: boolean; board: boolean; runs: boolean; computer: boolean };
const SERVES_NOTHING: Serves = { execution: false, board: false, runs: false, computer: false };

/** Server tasks have an explicit target and never enter the Mac task dispatcher. */
export class OnlineTasks {
  readonly #epochs = new Map<string, number>();
  readonly #revisions = new Map<string, number>();
  readonly #serves = new Map<string, { generation: number; until: number; serves: Promise<Serves> }>();
  readonly #delivery: Readonly<TaskDelivery>;
  #generation: number;
  #closed = false;
  constructor(private readonly deps: Dependencies) {
    this.#delivery = deps.delivery ?? taskDelivery;
    this.#generation = deps.session.generation;
    deps.session.onChange(() => {
      if (this.#generation !== deps.session.generation) {
        this.#generation = deps.session.generation;
        this.#epochs.clear();
        this.#revisions.clear();
        this.#serves.clear();
      }
      this.#invalidate();
    });
    deps.session.onSocket(SOCKET.changed, (body) => {
      const parsed = wireTopics.safeParse(body);
      if (!parsed.success || this.#closed) return;
      const { topics, organizationId } = parsed.data;
      if (!topics.some((topic) => ["projects", "threads", "spaces", "members", "organization_access", "billing"].includes(topic))) return;
      if (topics.some((topic) => ["spaces", "members", "organization_access", "billing"].includes(topic))) {
        if (organizationId) this.#epochs.set(organizationId, (this.#epochs.get(organizationId) ?? 0) + 1);
        else for (const [spaceId, epoch] of this.#epochs) this.#epochs.set(spaceId, epoch + 1);
      }
      this.#invalidate(organizationId);
    });
  }

  async state({ spaceId }: OnlineTaskParams<"tasks.online.state">): Promise<OnlineTaskAvailability> {
    const delivered = this.#delivered(spaceId);
    return delivered ? { state: "ready", spaceId, ...delivered, ...(await this.#served(spaceId)) } : { state: "unavailable" };
  }
  /** Core captures this before resolving a local run's project association. It exposes no session secret. */
  capture(spaceId: string): { accountId: string; assert(): void } {
    const identity = this.#identity(spaceId);
    return { accountId: identity.userId, assert: () => this.#assert(spaceId, identity) };
  }
  list({ spaceId, ...input }: OnlineTaskParams<"tasks.online.list">) {
    return this.#request(spaceId, TASK_ROUTES.list(input));
  }
  get({ spaceId, id }: OnlineTaskParams<"tasks.online.get">) {
    return this.#request(spaceId, TASK_ROUTES.get(id));
  }
  attention({ spaceId }: OnlineTaskParams<"tasks.online.attention">) {
    return this.#request(spaceId, TASK_ROUTES.attention);
  }
  assignees({ spaceId, ...input }: OnlineTaskParams<"tasks.online.assignees">) {
    return this.#request(spaceId, TASK_ROUTES.assignees(input));
  }
  activity({ spaceId, id, ...input }: OnlineTaskParams<"tasks.online.activity">) {
    return this.#request(spaceId, TASK_ROUTES.activity(id, input));
  }
  context({ spaceId, id }: OnlineTaskParams<"tasks.online.context">) {
    return this.#request(spaceId, TASK_ROUTES.context(id));
  }
  async openThread({ spaceId, id, ...input }: OnlineTaskExecutionParams) {
    if (!(await this.#served(spaceId)).execution) throw new Refused("Opening this task's thread isn't available yet.");
    const identity = this.#identity(spaceId);
    const result = await prepareTaskThread(this.#request(spaceId, taskThreadRoute(id), input));
    if (result.state === "ready") await this.deps.prepared?.(result.threadId);
    this.#assert(spaceId, identity);
    this.#invalidate(spaceId);
    return result;
  }

  /** A project's shared board. A server that keeps no boards keeps no columns, so the project's board is its statuses. */
  async board({ spaceId, projectId }: OnlineTaskParams<"tasks.online.board">): Promise<OnlineBoard> {
    if (!(await this.#served(spaceId)).board) return { revision: 0, columns: [], mayEdit: false };
    return this.#request(spaceId, TASK_ROUTES.board(projectId));
  }
  /** Saves the whole board from the revision it was read at; one saved since answers as a conflict, with the board as it now is. */
  async saveBoard({ spaceId, projectId, ...input }: OnlineTaskParams<"tasks.online.saveBoard">): Promise<OnlineBoardSave> {
    if (!(await this.#served(spaceId)).board) throw new Refused("This organization's boards keep no columns yet.");
    const result = await this.#request(spaceId, TASK_ROUTES.saveBoard(projectId), input);
    if (result.state === "saved") this.#invalidate(spaceId);
    return result;
  }

  /** Names this person's computer as where the task's work runs; refused while it runs in a cloud thread or on someone else's computer. */
  async onComputer(spaceId: string, id: string): Promise<OnlineTaskEnvelope> {
    if (!(await this.#served(spaceId)).computer) throw new Refused("Opening a team task's thread on this computer isn't available yet.");
    const result = await this.#request(spaceId, TASK_ROUTES.computer(id, "POST"), { requestId: randomUUID() });
    this.#invalidate(spaceId);
    return result;
  }
  /** Says the task's work no longer runs on this person's computer. */
  async offComputer(spaceId: string, id: string): Promise<void> {
    if (!(await this.#served(spaceId)).computer) return;
    await this.#request(spaceId, TASK_ROUTES.computer(id, "DELETE"), { requestId: randomUUID() });
    this.#invalidate(spaceId);
  }

  creation(input: OnlineTaskParams<"tasks.online.create">) {
    return taskCreation(this.create(input));
  }
  /** A change as an agent's tool makes it: saved, a conflict to read again, or refused in words. An unknown reply throws and keeps its request. */
  async editing(input: OnlineTaskParams<"tasks.online.update">): Promise<OnlineTaskMutation | TaskRefusal> {
    try {
      return await this.update(input);
    } catch (error) {
      const refusal = taskRefusal(error);
      if (refusal) return refusal;
      throw error;
    }
  }
  async create({ spaceId, ...input }: OnlineTaskParams<"tasks.online.create">): Promise<OnlineTaskEnvelope> {
    const result = await this.#request(spaceId, TASK_ROUTES.create, input);
    this.#invalidate(spaceId);
    return result;
  }
  async update({ spaceId, id, ...input }: OnlineTaskParams<"tasks.online.update">): Promise<OnlineTaskMutation> {
    try {
      const result = await this.#request(spaceId, taskRequest(TASK_ROUTES.update(id)), input);
      this.#invalidate(spaceId);
      return { state: "saved", ...result };
    } catch (error) {
      if (error instanceof TaskChanged) return { state: "conflict", ...error.current };
      throw error;
    }
  }
  async delete({ spaceId, id, ...input }: OnlineTaskParams<"tasks.online.delete">): Promise<OnlineTaskRpcResults["tasks.online.delete"]> {
    try {
      await this.#request(spaceId, taskRequest(TASK_ROUTES.delete(id)), input);
      this.#invalidate(spaceId);
      return { state: "deleted" };
    } catch (error) {
      if (error instanceof TaskChanged) return { state: "conflict", ...error.current };
      throw error;
    }
  }
  async seen({ spaceId, id, ...input }: OnlineTaskParams<"tasks.online.seen">): Promise<OnlineTaskEnvelope> {
    const result = await this.#request(spaceId, TASK_ROUTES.seen(id), input);
    this.#invalidate(spaceId);
    return result;
  }
  close(): void {
    this.#closed = true;
    this.#epochs.clear();
    this.#revisions.clear();
    this.#serves.clear();
  }

  /** The signed-in account and the space's kind, while this space's tasks are delivered to this app. */
  #delivered(spaceId: string): { accountId: string; personal: boolean } | null {
    const spaces = this.deps.spaces.status();
    if (this.#closed || spaces.state !== "ready" || !this.deps.session.state.signedIn) return null;
    const space = spaces.spaces.find((space) => space.id === spaceId);
    if (!space || !(space.kind === "organization" ? this.#delivery.organization : this.#delivery.personal)) return null;
    return { accountId: spaces.userId, personal: space.kind === "personal" };
  }
  /**
   * What the space's server does with tasks, from its capabilities (`tasks` opens task threads, `board` keeps columns),
   * held a few minutes, so a server that turns one on is heard without a restart. A server without capabilities does
   * neither, and is not asked again this session; a read that fails says neither for now and is asked again next time.
   */
  #served(spaceId: string): Promise<Serves> {
    const generation = this.deps.session.generation;
    const held = this.#serves.get(spaceId);
    if (held && held.generation === generation && Date.now() < held.until) return held.serves;
    const entry = { generation, until: Date.now() + SERVES_HOLD_MS, serves: Promise.resolve(SERVES_NOTHING) };
    entry.serves = this.deps.session
      .in(spaceId)
      .request(PARITY_ROUTES.capabilities)
      .then(
        ({ features }) => ({
          execution: features.tasks?.available === true,
          board: features.board?.available === true,
          runs: features.taskRuns?.available === true,
          computer: features.taskComputer?.available === true,
        }),
        (error: unknown) => {
          if (error instanceof Refused && error.status === 404) entry.until = Number.POSITIVE_INFINITY;
          else if (this.#serves.get(spaceId) === entry) this.#serves.delete(spaceId);
          return SERVES_NOTHING;
        },
      );
    this.#serves.set(spaceId, entry);
    return entry.serves;
  }
  #identity(spaceId: string): Identity {
    const delivered = this.#delivered(spaceId);
    if (!delivered) throw unavailable();
    const epoch = this.#epochs.get(spaceId) ?? 0;
    this.#epochs.set(spaceId, epoch);
    return { userId: delivered.accountId, generation: this.deps.session.generation, epoch };
  }
  #assert(spaceId: string, before: Identity): void {
    const current = this.#identity(spaceId);
    if (current.userId !== before.userId || current.generation !== before.generation || current.epoch !== before.epoch) throw changed();
  }
  #accept(spaceId: string, response: unknown): void {
    if (!response || typeof response !== "object" || !("accessRevision" in response) || typeof response.accessRevision !== "number") return;
    const revision = response.accessRevision;
    if (revision < (this.#revisions.get(spaceId) ?? 0)) throw changed();
    this.#revisions.set(spaceId, revision);
  }
  /**
   * One request, held to the account, session and access it began under. A read that an access notice overtook (a seat
   * count, billing or members change says so too, though nobody's access moved) is read again under the access as it
   * now stands; the third answer stands even if more notices came, since the server gave it for the access as it then
   * stood and refuses one that is gone. A write, or a changed account or session, fails as changed.
   */
  async #request<T>(spaceId: string, route: Route<T>, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const identity = this.#identity(spaceId);
      const overtaken = () => route.method === "GET" && this.#overtaken(spaceId, identity);
      const settle = (): "again" | "kept" | "held" => {
        if (overtaken()) return attempt < 2 ? "again" : "kept";
        this.#assert(spaceId, identity);
        return "held";
      };
      try {
        const result = await this.deps.session.in(spaceId).request(route, body);
        if (settle() === "again") continue;
        this.#accept(spaceId, result);
        return result;
      } catch (error) {
        if (settle() === "again") continue;
        if (error instanceof TaskChanged) this.#accept(spaceId, error.current);
        throw error;
      }
    }
  }
  /** Only the access moved since `before`: the same account in the same session. */
  #overtaken(spaceId: string, before: Identity): boolean {
    const now = this.#identity(spaceId);
    return now.userId === before.userId && now.generation === before.generation && now.epoch !== before.epoch;
  }
  #invalidate(spaceId?: string): void {
    if (this.#closed) return;
    const status = this.deps.spaces.status();
    const space = status.state === "ready" ? status.spaces.find((row) => row.id === spaceId) : undefined;
    if (space && !(space.kind === "organization" ? this.#delivery.organization : this.#delivery.personal)) return;
    this.deps.push({ type: "invalidate", keys: spaceId ? [`online-tasks:${spaceId}`] : ["online-tasks"] });
  }
}
