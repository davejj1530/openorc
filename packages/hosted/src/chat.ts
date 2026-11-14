import type { RpcParams, TeamChatStatus, TeamConversation } from "@openorc/protocol";
import type { HostedDeps, HostedSpaces } from "./index.js";
import { Refused, type Session } from "./session.js";
import { CHAT_ROUTES, chatMessage, chatWatched, type ChatWatch } from "./wire-chat.js";
import { SOCKET, wireTopics, type Route } from "./wire.js";

interface ChatDeps extends Pick<HostedDeps, "push"> {
  session: Session;
  spaces: Pick<HostedSpaces, "status">;
}
interface ChatIdentity {
  accountId: string;
  generation: number;
  revision: number;
}
const changedSession = () => new Refused("Your OpenOrc session changed. Try again.");
const unavailable = () => new Refused("This chat isn't available.", 404);

/** Desktop chat shares the account's transport, but never creates a work event or run. */
export class TeamChat {
  readonly #watches = new Map<string, ChatWatch>();
  readonly #opening = new Map<string, Promise<TeamConversation>>();
  readonly #access = new Map<string, number>();
  #session: number;
  #closed = false;

  constructor(private readonly deps: ChatDeps) {
    this.#session = deps.session.generation;
    deps.session.onChange((change) => {
      if (this.#session !== deps.session.generation) {
        this.#session = deps.session.generation;
        this.#watches.clear();
        this.#opening.clear();
        this.#access.clear();
      }
      this.#invalidate();
      if (change === "connected") for (const watch of this.#watches.values()) void this.#admit(watch).catch(() => this.#invalidate(watch.spaceId));
    });
    deps.session.onSocket("chat:message", (body) => {
      const event = chatMessage.safeParse(body);
      if (!event.success || this.#closed) return;
      const { spaceId, conversationId } = event.data;
      if ([...this.#watches.values()].some((watch) => watch.spaceId === spaceId && watch.conversationId === conversationId)) this.#invalidate(spaceId, conversationId);
    });
    deps.session.onSocket(SOCKET.changed, (body) => {
      const event = wireTopics.safeParse(body);
      if (!event.success || this.#closed) return;
      const { organizationId, topics } = event.data;
      if (topics.some((topic) => ["spaces", "members", "billing", "organization_access"].includes(topic))) {
        if (organizationId) this.#access.set(organizationId, (this.#access.get(organizationId) ?? 0) + 1);
        else for (const space of this.#access.keys()) this.#access.set(space, (this.#access.get(space) ?? 0) + 1);
      }
      if (topics.some((topic) => ["chat", "spaces", "members", "billing", "organization_access"].includes(topic))) this.#invalidate(organizationId);
    });
  }

  async state({ spaceId }: RpcParams<"teamChat.state">): Promise<TeamChatStatus> {
    const status = this.deps.spaces.status();
    if (status.state === "signed-out" || status.state === "unavailable") return { state: "unavailable" };
    if (status.state !== "ready") throw new Refused(status.error ?? "Your organizations are still loading.");
    if (!status.spaces.some((space) => space.id === spaceId && space.kind === "organization")) return { state: "unavailable" };
    try {
      const chat = await this.#request(spaceId, CHAT_ROUTES.state);
      return chat.features.includes("base")
        ? { state: "ready", accountId: status.userId, spaceId, reach: this.deps.session.state.signedIn ? this.deps.session.state.reach : "offline", chat }
        : { state: "unavailable" };
    } catch (error) {
      if (error instanceof Refused && error.status === 404) return { state: "unavailable" };
      throw error;
    }
  }

  openDm({ spaceId, userIds }: RpcParams<"teamChat.openDm">): Promise<TeamConversation> {
    const key = JSON.stringify([this.deps.session.generation, spaceId, [...new Set(userIds)].sort()]);
    const before = this.#opening.get(key);
    if (before) return before;
    const opening = this.#request(spaceId, CHAT_ROUTES.openDm, { userIds })
      .then((conversation) => {
        this.#invalidate(spaceId);
        return conversation;
      })
      .finally(() => {
        if (this.#opening.get(key) === opening) this.#opening.delete(key);
      });
    this.#opening.set(key, opening);
    return opening;
  }

  timeline({ spaceId, conversationId, ...cursor }: RpcParams<"teamChat.timeline">) {
    return this.#request(spaceId, CHAT_ROUTES.timeline(conversationId, cursor));
  }

  async send({ spaceId, conversationId, id, body }: RpcParams<"teamChat.send">) {
    const message = await this.#request(spaceId, CHAT_ROUTES.send(conversationId), { id, body, parentId: null, fileIds: [] });
    this.#invalidate(spaceId, conversationId);
    return message;
  }

  async react({ spaceId, conversationId, messageId, emoji }: RpcParams<"teamChat.react">) {
    try {
      return await this.#request(spaceId, CHAT_ROUTES.react(messageId), { emoji });
    } finally {
      this.#invalidate(spaceId, conversationId);
    }
  }

  async watch(watch: RpcParams<"teamChat.watch">): Promise<{ ok: boolean }> {
    this.#identity(watch.spaceId);
    this.#watches.set(watch.requestId, watch);
    try {
      return await this.#admit(watch);
    } catch (error) {
      if (this.#watches.get(watch.requestId) === watch) this.#watches.delete(watch.requestId);
      throw error;
    }
  }

  async unwatch(watch: RpcParams<"teamChat.unwatch">): Promise<Record<string, never>> {
    const current = this.#watches.get(watch.requestId);
    if (!current || current.spaceId !== watch.spaceId || current.conversationId !== watch.conversationId) return {};
    this.#watches.delete(watch.requestId);
    await this.deps.session.ask("chat:unwatch", watch, chatWatched).catch(() => undefined);
    return {};
  }

  close(): void {
    this.#closed = true;
    this.#watches.clear();
    this.#opening.clear();
  }

  async #admit(watch: ChatWatch): Promise<{ ok: boolean }> {
    const identity = this.#identity(watch.spaceId);
    const reply = await this.deps.session.ask("chat:watch", watch, chatWatched);
    this.#assert(watch.spaceId, identity);
    if (this.#watches.get(watch.requestId) !== watch || reply.requestId !== watch.requestId || reply.spaceId !== watch.spaceId || reply.conversationId !== watch.conversationId) return { ok: false };
    if (!reply.ok) this.#watches.delete(watch.requestId);
    this.#invalidate(watch.spaceId, watch.conversationId);
    return { ok: reply.ok };
  }

  #identity(spaceId: string) {
    const spaces = this.deps.spaces.status();
    if (this.#closed || !this.deps.session.state.signedIn || spaces.state !== "ready") throw changedSession();
    if (!spaces.spaces.some((space) => space.id === spaceId && space.kind === "organization")) throw unavailable();
    const revision = this.#access.get(spaceId) ?? 0;
    this.#access.set(spaceId, revision);
    return { accountId: spaces.userId, generation: this.deps.session.generation, revision };
  }

  #assert(spaceId: string, before: ChatIdentity): void {
    const now = this.#identity(spaceId);
    if (now.accountId !== before.accountId || now.generation !== before.generation || now.revision !== before.revision) throw changedSession();
  }

  async #request<T>(spaceId: string, route: Route<T>, body?: unknown): Promise<T> {
    const identity = this.#identity(spaceId);
    const result = await this.deps.session.in(spaceId).request(route, body);
    this.#assert(spaceId, identity);
    return result;
  }

  #invalidate(spaceId?: string, conversationId?: string): void {
    this.deps.push({ type: "invalidate", keys: spaceId ? [`team-chat:${spaceId}`, ...(conversationId ? [`team-chat:${spaceId}:${conversationId}`] : [])] : ["team-chat"] });
  }
}
