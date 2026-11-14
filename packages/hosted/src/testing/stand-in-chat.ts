import { randomUUID } from "node:crypto";
import { TeamChatReaction, teamChatRpcParams, type TeamChatPerson, type TeamConversation, type TeamMessage } from "@openorc/protocol";
import { chatWatch } from "../wire-chat.js";
import { userOf, type StandInSpaces } from "./stand-in-spaces.js";
import type { StandInPeer, StandInThreads } from "./stand-in-threads.js";

type Reply = { status: number; body: unknown };
type Request = { method: string; path: string; query: URLSearchParams; space: string | null };
type Record = { spaceId: string; conversation: TeamConversation; messages: TeamMessage[] };
const absent = (): Reply => ({ status: 404, body: { message: "That conversation isn't here." } });

/** A real-transport fixture for the flat desktop contract, with explicit access and retry identity. */
export class StandInChat {
  enabled = false;
  readonly frozen = new Set<string>();
  readonly records = new Map<string, Record>();
  readonly #watches = new WeakMap<StandInPeer, Map<string, { spaceId: string; conversationId: string }>>();

  constructor(private readonly deps: { spaces: StandInSpaces; peers(): StandInPeer[]; person(email: string): { name: string; image: string | null } }) {}

  people(spaceId: string): TeamChatPerson[] {
    return this.deps.spaces.readers(spaceId).map((email) => ({ id: userOf(email), ...this.deps.person(email) }));
  }

  seed(spaceId: string, input: { name?: string; userIds?: string[]; private?: boolean } = {}): TeamConversation {
    const members = this.people(spaceId).filter((person) => !input.userIds || input.userIds.includes(person.id));
    const conversation: TeamConversation = {
      id: randomUUID(),
      kind: input.userIds && !input.name ? "dm" : "channel",
      name: input.name ?? null,
      topic: null,
      private: input.private ?? false,
      members,
      joined: true,
      lastMessageAt: null,
      canAddMembers: false,
      canRemoveMembers: false,
      createdAt: new Date().toISOString(),
      participants: input.userIds && !input.name ? members.map((person) => ({ person, inOrganization: true })) : null,
      lastMessageSeq: 0,
      read: null,
    };
    this.records.set(conversation.id, { spaceId, conversation, messages: [] });
    return conversation;
  }

  changeAccess(spaceId: string): void {
    for (const peer of this.deps.peers())
      if (peer.who() && this.deps.spaces.readers(spaceId).includes(peer.who() ?? "")) peer.send("changed", { organizationId: spaceId, topics: ["members", "chat"] });
  }

  route(request: Request, who: string, body: unknown): Reply | null {
    if (!request.path.startsWith("/chat/")) return null;
    if (!this.enabled) return absent();
    const spaceId = request.space;
    if (!spaceId) return { status: 400, body: { message: "Name the organization in x-openorc-space." } };
    if (!this.deps.spaces.teams.has(spaceId) || !this.deps.spaces.readers(spaceId).includes(who)) return absent();
    if (this.frozen.has(who)) return { status: 403, body: { code: "organization_frozen", message: "Organization access is frozen." } };
    if (!this.#in(spaceId).some(({ conversation }) => conversation.name === "general")) this.seed(spaceId, { name: "general" });
    if (request.method === "GET" && request.path === "/chat/state")
      return {
        status: 200,
        body: {
          features: ["base"],
          people: this.people(spaceId),
          conversations: this.#in(spaceId)
            .filter((record) => this.#readable(record, who))
            .map(({ conversation }) => this.#view(conversation, who)),
        },
      };
    return this.#conversationRoute(request, spaceId, who, body);
  }

  #conversationRoute(request: Request, spaceId: string, who: string, body: unknown): Reply {
    if (request.method === "POST" && request.path === "/chat/dms") return this.#open(spaceId, who, body);
    const route = /^\/chat\/conversations\/([^/]+)(?:\/(timeline|messages))?$/.exec(request.path);
    if (route) {
      const record = this.records.get(decodeURIComponent(route[1] ?? ""));
      if (!record || record.spaceId !== spaceId || !this.#readable(record, who)) return absent();
      if (request.method === "GET" && !route[2]) return { status: 200, body: this.#view(record.conversation, who) };
      if (request.method === "GET" && route[2] === "timeline") return this.#timeline(record, request.query);
      if (request.method === "POST" && route[2] === "messages") return this.#send(record, who, body);
    }
    return this.#reactionRoute(request, spaceId, who, body);
  }

  #reactionRoute(request: Request, spaceId: string, who: string, body: unknown): Reply {
    const reaction = /^\/chat\/messages\/([^/]+)\/reactions$/.exec(request.path);
    if (reaction && request.method === "POST") return this.#react(spaceId, who, decodeURIComponent(reaction[1] ?? ""), body);
    return absent();
  }

  socket(peer: StandInPeer, event: string, body: unknown): unknown {
    const parsed = chatWatch.safeParse(body);
    if (!parsed.success) return { ok: false };
    const { spaceId, conversationId, requestId } = parsed.data;
    const who = peer.who();
    let watches = this.#watches.get(peer);
    if (!watches) {
      watches = new Map();
      this.#watches.set(peer, watches);
    }
    const record = this.records.get(conversationId);
    if (event === "chat:unwatch") {
      watches.delete(requestId);
      return { ...parsed.data, ok: true };
    }
    const ok = this.enabled && Boolean(who && record?.spaceId === spaceId && this.#readable(record, who));
    if (ok) watches.set(requestId, { spaceId, conversationId });
    return { ...parsed.data, ok };
  }

  #in(spaceId: string): Record[] {
    return [...this.records.values()].filter((record) => record.spaceId === spaceId);
  }
  #readable(record: Record, who: string): boolean {
    return (
      !this.frozen.has(who) &&
      this.deps.spaces.readers(record.spaceId).includes(who) &&
      ((record.conversation.kind === "channel" && !record.conversation.private) || record.conversation.members.some((person) => person.id === userOf(who)))
    );
  }
  #view(conversation: TeamConversation, who: string): TeamConversation {
    return { ...conversation, joined: conversation.members.some((person) => person.id === userOf(who)) };
  }

  #open(spaceId: string, who: string, body: unknown): Reply {
    const input = teamChatRpcParams["teamChat.openDm"].safeParse({ ...(body && typeof body === "object" ? body : {}), spaceId });
    if (!input.success) return { status: 400, body: { message: "Choose people for this chat." } };
    const userIds = [...new Set([userOf(who), ...input.data.userIds])].sort();
    if (userIds.length < 2 || userIds.some((id) => !this.people(spaceId).some((person) => person.id === id)))
      return { status: 400, body: { message: "Only people in this organization can be in its conversations." } };
    const prior = this.#in(spaceId).find(
      ({ conversation }) => conversation.kind === "dm" && JSON.stringify(conversation.participants?.map(({ person }) => person.id).sort()) === JSON.stringify(userIds),
    );
    return { status: 200, body: prior?.conversation ?? this.seed(spaceId, { userIds }) };
  }

  #timeline(record: Record, query: URLSearchParams): Reply {
    const before = query.has("beforeSeq") ? Number(query.get("beforeSeq")) : Infinity;
    const after = query.has("afterSeq") ? Number(query.get("afterSeq")) : 0;
    const matching = record.messages.filter((message) => message.seq < before && message.seq > after);
    const messages = query.has("afterSeq") ? matching.slice(0, 60) : matching.slice(-60);
    return {
      status: 200,
      body: {
        messages,
        older: record.messages.some((message) => message.seq < (messages[0]?.seq ?? 0)),
        newer: record.messages.some((message) => message.seq > (messages.at(-1)?.seq ?? 0)),
        headSeq: record.conversation.lastMessageSeq,
        read: null,
      },
    };
  }

  #send(record: Record, who: string, body: unknown): Reply {
    const fields = body && typeof body === "object" ? body : {};
    const { parentId: _parent, fileIds: _files, ...text } = { parentId: null, fileIds: [], ...fields };
    const input = teamChatRpcParams["teamChat.send"].safeParse({ ...text, spaceId: record.spaceId, conversationId: record.conversation.id });
    if (!input.success) return { status: 400, body: { message: "Write a message first." } };
    const previous = this.#in(record.spaceId)
      .flatMap((each) => each.messages)
      .find((message) => message.id === input.data.id);
    if (previous)
      return previous.actor.person?.id === userOf(who) && previous.channelId === record.conversation.id && previous.body === input.data.body
        ? { status: 201, body: previous }
        : { status: 409, body: { code: "message_id_conflict", message: "That message ID is already in use." } };
    const message: TeamMessage = {
      id: input.data.id,
      channelId: record.conversation.id,
      seq: ++record.conversation.lastMessageSeq,
      actor: { kind: "person", person: { id: userOf(who), ...this.deps.person(who) } },
      body: input.data.body,
      files: [],
      reactions: [],
      call: null,
      createdAt: new Date().toISOString(),
    };
    record.messages.push(message);
    record.conversation.lastMessageAt = message.createdAt;
    for (const peer of this.deps.peers()) {
      const viewer = peer.who();
      if (!viewer || !this.#readable(record, viewer)) continue;
      if ([...(this.#watches.get(peer)?.values() ?? [])].some((watch) => watch.spaceId === record.spaceId && watch.conversationId === record.conversation.id))
        peer.send("chat:message", { spaceId: record.spaceId, conversationId: record.conversation.id, message });
      peer.send("changed", { organizationId: record.spaceId, topics: ["chat"] });
    }
    return { status: 201, body: message };
  }

  #react(spaceId: string, who: string, id: string, body: unknown): Reply {
    const record = this.#in(spaceId).find((record) => record.messages.some((message) => message.id === id));
    const message = record?.messages.find((message) => message.id === id);
    if (!record || !message || !this.#readable(record, who)) return absent();
    const emoji = TeamChatReaction.safeParse(body && typeof body === "object" && "emoji" in body ? body.emoji : null);
    if (!emoji.success) return { status: 400, body: { message: "Choose a reaction." } };
    const reaction = message.reactions.find((reaction) => reaction.emoji === emoji.data);
    const user = userOf(who);
    if (!reaction) message.reactions.push({ emoji: emoji.data, userIds: [user] });
    else reaction.userIds = reaction.userIds.includes(user) ? reaction.userIds.filter((id) => id !== user) : [...reaction.userIds, user];
    message.reactions = message.reactions.filter((reaction) => reaction.userIds.length > 0);
    return { status: 200, body: message };
  }
}

export function socketAnswers(hosted: StandInThreads, chat: StandInChat): (peer: StandInPeer, event: string, body: unknown) => unknown {
  return (peer, event, body) => {
    if (event === "hosted:watch") return hosted.watch(peer, body);
    if (event === "hosted:unwatch") return hosted.unwatch(peer, body);
    if (event === "chat:watch" || event === "chat:unwatch") return chat.socket(peer, event, body);
    return { ok: false };
  };
}
