import { randomUUID } from "node:crypto";
import { actorPerson, TeamChatReaction, teamChatRpcParams, type TeamChatPerson, type TeamConversation, type TeamMessage } from "@openorc/protocol";
import { chatWatch } from "../wire-chat.js";
import { userOf, type StandInSpaces } from "./stand-in-spaces.js";
import type { StandInPeer } from "./stand-in-peer.js";
import type { StandInThreads } from "./stand-in-threads.js";
import { StandInChatChannels } from "./stand-in-chat-channels.js";
import { StandInChatReads } from "./stand-in-chat-reads.js";
import { standInPins } from "./stand-in-chat-pins.js";
import { standInSearch } from "./stand-in-chat-search.js";
import { StandInChatCalls } from "./stand-in-chat-calls.js";

type Reply = { status: number; body: unknown };
type Request = { method: string; path: string; query: URLSearchParams; space: string | null };
export type StandInChatRecord = { spaceId: string; conversation: TeamConversation; messages: TeamMessage[]; creatorId: string | null };
const absent = (): Reply => ({ status: 404, body: { message: "That conversation isn't here." } });

/** A real-transport fixture for the flat desktop contract, with explicit access and retry identity. */
export class StandInChat {
  enabled = false;
  channelsEnabled = false;
  groupsEnabled = false;
  unreadEnabled = false;
  filesEnabled = false;
  repliesEnabled = false;
  pinsEnabled = false;
  searchEnabled = false;
  orclingEnabled = false;
  readonly reads = new StandInChatReads();
  /** Takes a message's uploaded files (StandInUploads.attachChat); null refuses them. */
  attachFiles: ((input: { who: string; space: string; ids: string[]; messageId: string; conversationId: string }) => TeamMessage["files"] | null) | null = null;
  readonly frozen = new Set<string>();
  readonly records = new Map<string, StandInChatRecord>();
  readonly #watches = new WeakMap<StandInPeer, Map<string, { spaceId: string; conversationId: string }>>();
  readonly #channels: StandInChatChannels;
  readonly calls = new StandInChatCalls({ deliver: (record, message) => this.#deliver(record, message), readable: (record, who) => this.#readable(record, who) });

  constructor(private readonly deps: { spaces: StandInSpaces; peers(): StandInPeer[]; person(email: string): { name: string; image: string | null } }) {
    this.#channels = new StandInChatChannels(this, deps.spaces);
  }

  people(spaceId: string): TeamChatPerson[] {
    return this.deps.spaces.readers(spaceId).map((email) => ({ id: userOf(email), ...this.deps.person(email) }));
  }

  seed(spaceId: string, input: { name?: string; topic?: string; userIds?: string[]; private?: boolean; creatorId?: string } = {}): TeamConversation {
    const members = this.people(spaceId).filter((person) => !input.userIds || input.userIds.includes(person.id));
    const conversation: TeamConversation = {
      id: randomUUID(),
      kind: input.userIds && !input.name ? "dm" : "channel",
      name: input.name ?? null,
      topic: input.topic || null,
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
    this.records.set(conversation.id, { spaceId, conversation, messages: [], creatorId: input.creatorId ?? members[0]?.id ?? null });
    return conversation;
  }

  changeAccess(spaceId: string, topics = ["members", "chat"]): void {
    for (const peer of this.deps.peers()) if (peer.who() && this.deps.spaces.readers(spaceId).includes(peer.who() ?? "")) peer.send("changed", { organizationId: spaceId, topics });
  }

  #features(): string[] {
    const flags: [string, boolean][] = [
      ["channels", this.channelsEnabled],
      ["groups", this.groupsEnabled],
      ["unread", this.unreadEnabled],
      ["files", this.filesEnabled],
      ["replies", this.repliesEnabled],
      ["pins", this.pinsEnabled],
      ["search", this.searchEnabled],
      ["orcling", this.orclingEnabled],
    ];
    return ["base", ...flags.flatMap(([name, on]) => (on ? [name] : []))];
  }

  /** Refusals before any conversation route: unknown or unreadable space, frozen access. */
  #admission(spaceId: string | null, who: string): Reply | null {
    if (!spaceId) return { status: 400, body: { message: "Name the organization in x-openorc-space." } };
    if (!this.deps.spaces.teams.has(spaceId) || !this.deps.spaces.readers(spaceId).includes(who)) return absent();
    if (this.frozen.has(who)) return { status: 403, body: { code: "organization_frozen", message: "Organization access is frozen." } };
    return null;
  }

  route(request: Request, who: string, body: unknown): Reply | null {
    if (!request.path.startsWith("/chat/")) return null;
    if (!this.enabled) return absent();
    if (request.method === "GET" && request.path === "/chat/unread-spaces") return this.#unreadSpaces(who);
    const refused = this.#admission(request.space, who);
    if (refused) return refused;
    const spaceId = request.space!;
    if (!this.#in(spaceId).some(({ conversation }) => conversation.name === "general")) this.seed(spaceId, { name: "general" });
    if (request.method === "GET" && request.path === "/chat/state")
      return {
        status: 200,
        body: {
          features: this.#features(),
          people: this.people(spaceId),
          conversations: this.#in(spaceId)
            .filter((record) => this.#readable(record, who))
            .map(({ conversation }) => this.#view(spaceId, conversation, who)),
        },
      };
    return this.#conversationRoute(request, spaceId, who, body);
  }

  #conversationRoute(request: Request, spaceId: string, who: string, body: unknown): Reply {
    if (request.method === "POST" && request.path === "/chat/dms") return this.#open(spaceId, who, body);
    if (this.orclingEnabled) {
      const called = this.calls.route(request.path, request.method, who, body);
      if (called) return called;
    }
    if (request.method === "GET" && request.path === "/chat/search" && this.searchEnabled)
      return {
        status: 200,
        body: standInSearch(
          this.#in(spaceId).filter((record) => this.#readable(record, who)),
          request.query.get("q") ?? "",
          (id) => this.people(spaceId).find((person) => person.id === id)?.name,
        ),
      };
    return this.#channels.route(request, spaceId, who, body) ?? this.#recordRoute(request, spaceId, who, body) ?? this.#reactionRoute(request, spaceId, who, body);
  }

  #recordRoute(request: Request, spaceId: string, who: string, body: unknown): Reply | null {
    const route = /^\/chat\/conversations\/([^/]+)(?:\/(timeline|messages|seen|pins))?$/.exec(request.path);
    if (!route) return null;
    const record = this.records.get(decodeURIComponent(route[1] ?? ""));
    if (!record || record.spaceId !== spaceId || !this.#readable(record, who)) return absent();
    const action = `${request.method} ${route[2] ?? ""}`;
    if (action === "GET ") return { status: 200, body: this.#view(spaceId, record.conversation, who) };
    if (action === "GET timeline") return this.#timeline(record, request.query, who);
    if (action === "POST messages") return this.#send(record, who, body);
    if (action === "PUT seen" && this.unreadEnabled) return this.reads.seen(record, who, body);
    if (action === "GET pins" && this.pinsEnabled) return standInPins.list(record);
    return absent();
  }

  #reactionRoute(request: Request, spaceId: string, who: string, body: unknown): Reply {
    const reaction = /^\/chat\/messages\/([^/]+)\/reactions$/.exec(request.path);
    if (reaction && request.method === "POST") return this.#react(spaceId, who, decodeURIComponent(reaction[1] ?? ""), body);
    const pin = /^\/chat\/messages\/([^/]+)\/pin$/.exec(request.path);
    if (pin && this.pinsEnabled && ["POST", "DELETE"].includes(request.method)) return this.#pin(spaceId, who, decodeURIComponent(pin[1] ?? ""), request.method === "POST");
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

  #in(spaceId: string): StandInChatRecord[] {
    return [...this.records.values()].filter((record) => record.spaceId === spaceId);
  }
  #readable(record: StandInChatRecord, who: string): boolean {
    return (
      !this.frozen.has(who) &&
      this.deps.spaces.readers(record.spaceId).includes(who) &&
      ((record.conversation.kind === "channel" && !record.conversation.private) || record.conversation.members.some((person) => person.id === userOf(who)))
    );
  }
  #view(spaceId: string, conversation: TeamConversation, who: string): TeamConversation {
    const viewed = this.#fixed(spaceId, conversation, who);
    const record = this.records.get(conversation.id);
    return this.unreadEnabled && record ? { ...viewed, read: viewed.joined ? this.reads.read(record, who) : null } : viewed;
  }
  #fixed(spaceId: string, conversation: TeamConversation, who: string): TeamConversation {
    if (conversation.kind === "channel") return this.#channels.view(conversation, who);
    const people = this.people(spaceId);
    const participants = (conversation.participants ?? []).map(({ person }) => {
      const current = people.find((candidate) => candidate.id === person.id);
      return { person: current ?? person, inOrganization: Boolean(current) };
    });
    return { ...conversation, participants, members: participants.filter((participant) => participant.inOrganization).map((participant) => participant.person) };
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
    return { status: 200, body: this.#view(spaceId, prior?.conversation ?? this.seed(spaceId, { userIds }), who) };
  }

  #unreadSpaces(who: string): Reply {
    if (!this.unreadEnabled) return { status: 200, body: { spaces: [] } };
    return this.reads.unreadSpaces([...this.records.values()], who, (spaceId) => this.deps.spaces.readers(spaceId).includes(who) && !this.frozen.has(who));
  }

  #timeline(record: StandInChatRecord, query: URLSearchParams, who: string): Reply {
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
        read: this.unreadEnabled ? this.reads.read(record, who) : null,
      },
    };
  }

  #send(record: StandInChatRecord, who: string, body: unknown): Reply {
    const fields = body && typeof body === "object" ? body : {};
    const { replyToId: answering, fileIds: chosen, orclingCall, ...words } = { replyToId: null as unknown, fileIds: [] as unknown, orclingCall: null as unknown, ...fields };
    const fileIds = Array.isArray(chosen) ? chosen.filter((id): id is string => typeof id === "string") : [];
    const text = { ...words, ...(fileIds.length && { fileIds }), ...(typeof answering === "string" && { replyToId: answering }) };
    const input = teamChatRpcParams["teamChat.send"].safeParse({ ...text, spaceId: record.spaceId, conversationId: record.conversation.id });
    if (!input.success) return { status: 400, body: { message: "Write a message first." } };
    const refusal = this.unreadEnabled ? this.reads.refusal(record, input.data.body, this.people(record.spaceId)) : null;
    if (refusal) return refusal;
    const replyTo = this.#answered(record, input.data.replyToId);
    if (replyTo === undefined) return { status: 400, body: { message: "That message isn't in this conversation." } };
    const previous = this.#replay(record, who, input.data.id, input.data.body);
    if (previous) return previous;
    const files = fileIds.length ? this.attachFiles?.({ who, space: record.spaceId, ids: fileIds, messageId: input.data.id, conversationId: record.conversation.id }) : [];
    if (!files) return { status: 400, body: { message: "Attach files you uploaded to this conversation, once each." } };
    const message: TeamMessage = {
      id: input.data.id,
      channelId: record.conversation.id,
      seq: ++record.conversation.lastMessageSeq,
      actor: { kind: "person", person: { id: userOf(who), ...this.deps.person(who) } },
      body: input.data.body,
      files,
      reactions: [],
      replyTo,
      pinned: null,
      call: null,
      createdAt: new Date().toISOString(),
    };
    record.messages.push(message);
    if (orclingCall && this.orclingEnabled) this.calls.record(record, message, who, orclingCall);
    record.conversation.lastMessageAt = message.createdAt;
    this.#deliver(record, message);
    return { status: 201, body: message };
  }

  /** The message a reply names, as the reply shows it: null for none, undefined when it isn't this conversation's. */
  #answered(record: StandInChatRecord, id: string | undefined): TeamMessage["replyTo"] | undefined {
    if (id === undefined) return null;
    const answered = this.repliesEnabled ? record.messages.find((message) => message.id === id) : undefined;
    return (
      answered && {
        id: answered.id,
        seq: answered.seq,
        person: actorPerson(answered.actor),
        orcling: answered.actor.kind === "orcling" ? { name: answered.actor.name } : null,
        excerpt: excerpt(answered.body),
        files: answered.files.length,
      }
    );
  }

  /** The same id again answers the stored message to its sender in this conversation, and refuses anything else. */
  #replay(record: StandInChatRecord, who: string, id: string, body: string): Reply | null {
    const previous = this.#in(record.spaceId)
      .flatMap((each) => each.messages)
      .find((message) => message.id === id);
    if (!previous) return null;
    return actorPerson(previous.actor)?.id === userOf(who) && previous.channelId === record.conversation.id && previous.body === body
      ? { status: 201, body: previous }
      : { status: 409, body: { code: "message_id_conflict", message: "That message ID is already in use." } };
  }

  #deliver(record: StandInChatRecord, message: TeamMessage): void {
    for (const peer of this.deps.peers()) {
      const viewer = peer.who();
      if (!viewer || !this.#readable(record, viewer)) continue;
      if ([...(this.#watches.get(peer)?.values() ?? [])].some((watch) => watch.spaceId === record.spaceId && watch.conversationId === record.conversation.id))
        peer.send("chat:message", { spaceId: record.spaceId, conversationId: record.conversation.id, message });
      peer.send("changed", { organizationId: record.spaceId, topics: ["chat"] });
    }
  }

  #pin(spaceId: string, who: string, id: string, pin: boolean): Reply {
    const record = this.#in(spaceId).find((record) => record.messages.some((message) => message.id === id));
    if (!record || !this.#readable(record, who)) return absent();
    const changed = standInPins.change(record, who, { id: userOf(who), ...this.deps.person(who) }, id, pin);
    if (changed.status === 200) this.changeAccess(spaceId, ["chat"]);
    return changed;
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

/** A message's first words on one line, as the server's reply shows them. */
const excerpt = (body: string) => {
  const line = body.replace(/\s+/g, " ").trim();
  if (line.length <= 140) return line;
  const space = line.lastIndexOf(" ", 140);
  return `${line.slice(0, space > 0 ? space : 140).trimEnd()}…`;
};
