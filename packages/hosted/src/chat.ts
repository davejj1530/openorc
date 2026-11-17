import type { RpcParams, TeamChatRead, TeamChatStatus, TeamConversation } from "@openorc/protocol";
import type { HostedDeps, HostedSpaces } from "./index.js";
import { Refused, type Session } from "./session.js";
import { CHAT_ROUTES, chatMessage, chatRead, chatWatched, type ChatWatch, type OrclingClaim, type WireOrclingCall } from "./wire-chat.js";
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
  readonly #reads = new Map<string, number>();
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
        this.#reads.clear();
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
    // Another of this person's apps moved their place: counts here follow without a watch.
    deps.session.onSocket("chat:read", (body) => {
      const event = chatRead.safeParse(body);
      if (!event.success || this.#closed) return;
      this.#invalidate(event.data.spaceId, event.data.conversationId);
    });
    deps.session.onSocket(SOCKET.changed, (body) => {
      const event = wireTopics.safeParse(body);
      if (!event.success || this.#closed) return;
      const { organizationId, topics } = event.data;
      if (topics.includes("chat")) {
        for (const id of organizationId ? [organizationId] : this.#access.keys()) this.#reads.set(id, (this.#reads.get(id) ?? 0) + 1);
      }
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

  conversation({ spaceId, conversationId }: RpcParams<"teamChat.conversation">) {
    return this.#request(spaceId, CHAT_ROUTES.conversation(conversationId));
  }

  createChannel({ spaceId, ...input }: RpcParams<"teamChat.createChannel">) {
    return this.#change(spaceId, CHAT_ROUTES.createChannel, input);
  }

  joinChannel({ spaceId, conversationId }: RpcParams<"teamChat.joinChannel">) {
    return this.#change(spaceId, CHAT_ROUTES.joinChannel(conversationId));
  }

  leaveChannel({ spaceId, conversationId }: RpcParams<"teamChat.leaveChannel">) {
    return this.#change(spaceId, CHAT_ROUTES.leaveChannel(conversationId));
  }

  addMembers({ spaceId, conversationId, userIds }: RpcParams<"teamChat.addMembers">) {
    return this.#change(spaceId, CHAT_ROUTES.addMembers(conversationId), { userIds });
  }

  removeMember({ spaceId, conversationId, userId }: RpcParams<"teamChat.removeMember">) {
    return this.#change(spaceId, CHAT_ROUTES.removeMember(conversationId, userId));
  }

  /** A message; one that calls the sender's own Orcling carries the call its app made, secret and all. */
  async send({ spaceId, conversationId, id, body, fileIds, replyToId }: Omit<RpcParams<"teamChat.send">, "orcling">, orclingCall: WireOrclingCall | null = null) {
    const message = await this.#request(spaceId, CHAT_ROUTES.send(conversationId), { id, body, parentId: null, replyToId: replyToId ?? null, fileIds: fileIds ?? [], orclingCall });
    this.#invalidate(spaceId, conversationId);
    return message;
  }

  orclingCall({ spaceId, callId }: RpcParams<"teamChat.orclingCall">) {
    return this.#request(spaceId, CHAT_ROUTES.orclingCall(callId));
  }

  /** The owner's app takes its call to run, and reads what the Orcling answers from. */
  claimCall(spaceId: string, callId: string, attempt: { attemptId: string; runnerSecret: string }): Promise<OrclingClaim> {
    return this.#request(spaceId, CHAT_ROUTES.claimCall(callId), attempt);
  }

  renewCall(spaceId: string, callId: string, attempt: { attemptId: string; runnerSecret: string }) {
    return this.#request(spaceId, CHAT_ROUTES.renewCall(callId), attempt);
  }

  async answerCall(spaceId: string, conversationId: string, callId: string, answer: { attemptId: string; runnerSecret: string; body: string }) {
    try {
      return await this.#request(spaceId, CHAT_ROUTES.answerCall(callId), answer);
    } finally {
      this.#invalidate(spaceId, conversationId);
    }
  }

  async failCall(spaceId: string, conversationId: string, callId: string, failure: { attemptId: string; runnerSecret: string; reason: string }) {
    try {
      return await this.#request(spaceId, CHAT_ROUTES.failCall(callId), failure);
    } finally {
      this.#invalidate(spaceId, conversationId);
    }
  }

  async retryCall(spaceId: string, conversationId: string, callId: string, runnerSecret: string) {
    try {
      return await this.#request(spaceId, CHAT_ROUTES.retryCall(callId), { runnerSecret });
    } finally {
      this.#invalidate(spaceId, conversationId);
    }
  }

  search({ spaceId, q }: RpcParams<"teamChat.search">) {
    return this.#request(spaceId, CHAT_ROUTES.search(q));
  }

  pins({ spaceId, conversationId }: RpcParams<"teamChat.pins">) {
    return this.#request(spaceId, CHAT_ROUTES.pins(conversationId));
  }

  async pin({ spaceId, conversationId, messageId, pinned }: RpcParams<"teamChat.pin">) {
    try {
      return await this.#request(spaceId, CHAT_ROUTES.pin(messageId, pinned), {});
    } finally {
      this.#invalidate(spaceId, conversationId);
    }
  }

  async react({ spaceId, conversationId, messageId, emoji }: RpcParams<"teamChat.react">) {
    try {
      return await this.#request(spaceId, CHAT_ROUTES.react(messageId), { emoji });
    } finally {
      this.#invalidate(spaceId, conversationId);
    }
  }

  async seen({ spaceId, conversationId, messageId }: RpcParams<"teamChat.seen">): Promise<TeamChatRead> {
    try {
      return await this.#request(spaceId, CHAT_ROUTES.seen(conversationId), { messageId });
    } finally {
      this.#invalidate(spaceId, conversationId);
    }
  }

  /** Account-wide and names no space; an organization this app does not hold is never reported. */
  async unreadSpaces(_input: RpcParams<"teamChat.unreadSpaces">): Promise<{ spaceIds: string[] }> {
    const spaces = this.deps.spaces.status();
    if (this.#closed || !this.deps.session.state.signedIn || spaces.state !== "ready") return { spaceIds: [] };
    const generation = this.deps.session.generation;
    try {
      const reply = await this.deps.session.request(CHAT_ROUTES.unreadSpaces);
      if (this.deps.session.generation !== generation) throw changedSession();
      const now = this.deps.spaces.status();
      const usable = new Set(now.state === "ready" ? now.spaces.filter((space) => space.kind === "organization").map((space) => space.id) : []);
      return { spaceIds: reply.spaces.map((space) => space.spaceId).filter((id) => usable.has(id)) };
    } catch (error) {
      if (error instanceof Refused && error.status === 404) return { spaceIds: [] };
      throw error;
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

  /**
   * One request, held to the account and session it began under. A read that a chat change or an access notice
   * overtook (a seat count, billing or members change says so too, though nobody's access moved) is read again under the
   * access as it now stands; the third answer stands even if more notices came, since the server gave it for the access
   * as it then stood and refuses one that is gone. A write that access moved under, or a changed account or session,
   * fails as changed.
   */
  async #request<T>(spaceId: string, route: Route<T>, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const identity = this.#identity(spaceId);
      const readRevision = this.#reads.get(spaceId) ?? 0;
      const result = await this.deps.session.in(spaceId).request(route, body);
      const now = this.#identity(spaceId);
      if (route.method !== "GET" || now.accountId !== identity.accountId || now.generation !== identity.generation) {
        this.#assert(spaceId, identity);
        return result;
      }
      const overtaken = now.revision !== identity.revision || (this.#reads.get(spaceId) ?? 0) !== readRevision;
      if (!overtaken || attempt === 2) return result;
    }
  }

  async #change<T>(spaceId: string, route: Route<T>, body?: unknown): Promise<T> {
    try {
      return await this.#request(spaceId, route, body);
    } finally {
      this.#invalidate(spaceId);
    }
  }

  #invalidate(spaceId?: string, conversationId?: string): void {
    // The switcher's unread organizations follow every chat change, here or in another space.
    this.deps.push({
      type: "invalidate",
      keys: spaceId ? [`team-chat:${spaceId}`, ...(conversationId ? [`team-chat:${spaceId}:${conversationId}`] : []), "team-chat-unread"] : ["team-chat", "team-chat-unread"],
    });
  }
}
