import type { OnlineTaskAvailability, OnlineTaskEnvelope, OnlineTaskMutation, OnlineTaskParams, OnlineTaskRpcResults } from "@openorc/protocol";
import type { HostedDeps, HostedSpaces } from "./index.js";
import { Refused, type Session } from "./session.js";
import { TaskChanged, taskRequest } from "./task-requests.js";
import { TASK_ROUTES } from "./wire-tasks.js";
import { SOCKET, wireTopics, type Route } from "./wire.js";

export interface TaskDelivery {
  organization: boolean;
  execution: boolean;
  personal: boolean;
}
/** Each delivery opens only after its paired server and compatibility checks pass. */
export const taskDelivery: Readonly<TaskDelivery> = { organization: false, execution: false, personal: false };
interface Dependencies extends Pick<HostedDeps, "push"> {
  session: Session;
  spaces: Pick<HostedSpaces, "status">;
  delivery?: Readonly<TaskDelivery>;
}
interface Identity {
  userId: string;
  generation: number;
  epoch: number;
}
const changed = () => new Refused("Your OpenOrc session or project access changed. Try again.");
const unavailable = () => new Refused("This task isn't available.", 404);

/** Server tasks have an explicit target and never enter the Mac task dispatcher. */
export class OnlineTasks {
  readonly #epochs = new Map<string, number>();
  readonly #revisions = new Map<string, number>();
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
      }
      this.#invalidate();
    });
    deps.session.onSocket(SOCKET.changed, (body) => {
      const parsed = wireTopics.safeParse(body);
      if (!parsed.success || this.#closed) return;
      const { topics, organizationId } = parsed.data;
      if (!topics.some((topic) => ["projects", "spaces", "members", "organization_access", "billing"].includes(topic))) return;
      if (organizationId) this.#epochs.set(organizationId, (this.#epochs.get(organizationId) ?? 0) + 1);
      else for (const [spaceId, epoch] of this.#epochs) this.#epochs.set(spaceId, epoch + 1);
      this.#invalidate(organizationId);
    });
  }

  state({ spaceId }: OnlineTaskParams<"tasks.online.state">): OnlineTaskAvailability {
    const spaces = this.deps.spaces.status();
    if (this.#closed || spaces.state !== "ready" || !this.deps.session.state.signedIn) return { state: "unavailable" };
    const space = spaces.spaces.find((space) => space.id === spaceId);
    if (!space || !(space.kind === "organization" ? this.#delivery.organization : this.#delivery.personal)) return { state: "unavailable" };
    return { state: "ready", accountId: spaces.userId, spaceId, execution: this.#delivery.execution, personal: space.kind === "personal" };
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
  }

  #identity(spaceId: string): Identity {
    const available = this.state({ spaceId });
    if (available.state !== "ready") throw unavailable();
    const epoch = this.#epochs.get(spaceId) ?? 0;
    this.#epochs.set(spaceId, epoch);
    return { userId: available.accountId, generation: this.deps.session.generation, epoch };
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
  async #request<T>(spaceId: string, route: Route<T>, body?: unknown): Promise<T> {
    const identity = this.#identity(spaceId);
    try {
      const result = await this.deps.session.in(spaceId).request(route, body);
      this.#assert(spaceId, identity);
      this.#accept(spaceId, result);
      return result;
    } catch (error) {
      this.#assert(spaceId, identity);
      if (error instanceof TaskChanged) this.#accept(spaceId, error.current);
      throw error;
    }
  }
  #invalidate(spaceId?: string): void {
    if (!this.#closed) this.deps.push({ type: "invalidate", keys: spaceId ? [`online-tasks:${spaceId}`] : ["online-tasks"] });
  }
}
