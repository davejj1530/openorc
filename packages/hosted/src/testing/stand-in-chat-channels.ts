import { teamChatRpcParams, type TeamConversation } from "@openorc/protocol";
import type { StandInChat, StandInChatRecord } from "./stand-in-chat.js";
import { userOf, type StandInSpaces } from "./stand-in-spaces.js";

type Reply = { status: number; body: unknown };
type Request = { method: string; path: string };
const refused = (message: string, status = 400): Reply => ({ status, body: { message } });
const absent = () => refused("That conversation isn't here.", 404);
const fields = (body: unknown) => (body && typeof body === "object" ? body : {});

export class StandInChatChannels {
  constructor(
    private readonly chat: StandInChat,
    private readonly spaces: StandInSpaces,
  ) {}

  view(conversation: TeamConversation, who: string): TeamConversation {
    const record = this.chat.records.get(conversation.id);
    const joined = conversation.members.some((person) => person.id === userOf(who));
    const channel = conversation.kind === "channel" && joined;
    const admin = record && this.spaces.member(record.spaceId, who)?.role === "admin";
    return { ...conversation, joined, canAddMembers: channel, canRemoveMembers: channel && Boolean(admin || record?.creatorId === userOf(who)) };
  }

  route(request: Request, spaceId: string, who: string, body: unknown): Reply | null {
    if (request.method === "POST" && request.path === "/chat/channels") return this.#create(spaceId, who, body);
    const path = /^\/chat\/conversations\/([^/]+)\/(join|leave|members)(?:\/([^/]+))?$/.exec(request.path);
    if (!path) return null;
    const record = this.chat.records.get(decodeURIComponent(path[1] ?? ""));
    if (!record || record.spaceId !== spaceId) return absent();
    const view = this.view(record.conversation, who);
    if ((view.private || view.kind === "dm") && !view.joined) return absent();
    if (view.kind !== "channel") return refused("A direct message keeps its people.");
    return this.#operation(`${request.method}:${path[2]}`, record, who, body, path[3]);
  }

  #operation(action: string, record: StandInChatRecord, who: string, body: unknown, person?: string): Reply | null {
    switch (action) {
      case "POST:join":
        return this.#join(record, who);
      case "POST:leave":
        this.#drop(record, userOf(who));
        return { status: 204, body: null };
      case "POST:members":
        return this.#add(record, who, body);
      case "DELETE:members":
        return person ? this.#remove(record, who, decodeURIComponent(person)) : null;
      default:
        return null;
    }
  }

  #create(spaceId: string, who: string, body: unknown): Reply {
    const parsed = teamChatRpcParams["teamChat.createChannel"].safeParse({ ...fields(body), spaceId });
    if (!parsed.success) return refused("Use a name of up to 40 letters, numbers and dashes.");
    const input = parsed.data;
    if ([...this.chat.records.values()].some((record) => record.spaceId === spaceId && record.conversation.name === input.name)) return refused(`#${input.name} already exists.`, 409);
    const userIds = [...new Set([userOf(who), ...(input.userIds ?? [])])];
    if (!this.#known(spaceId, userIds)) return refused("Only people in this organization can be in its conversations.");
    const conversation = this.chat.seed(spaceId, { name: input.name, topic: input.topic, private: input.private, userIds, creatorId: userOf(who) });
    this.chat.changeAccess(spaceId, ["chat"]);
    return { status: 201, body: this.view(conversation, who) };
  }

  #join(record: StandInChatRecord, who: string): Reply {
    if (record.conversation.private) return refused("Only public channels can be joined. Ask someone in it to add you.");
    return this.#include(record, who, [userOf(who)]);
  }

  #add(record: StandInChatRecord, who: string, body: unknown): Reply {
    if (!this.view(record.conversation, who).canAddMembers) return refused("Join the channel to add people.", 403);
    const parsed = teamChatRpcParams["teamChat.addMembers"].safeParse({ ...fields(body), spaceId: record.spaceId, conversationId: record.conversation.id });
    if (!parsed.success || !this.#known(record.spaceId, parsed.data.userIds)) return refused("Only people in this organization can be in its conversations.");
    return this.#include(record, who, parsed.data.userIds);
  }

  #include(record: StandInChatRecord, who: string, userIds: string[]): Reply {
    const members = record.conversation.members;
    members.push(...this.chat.people(record.spaceId).filter((person) => userIds.includes(person.id) && !members.some((member) => member.id === person.id)));
    this.chat.changeAccess(record.spaceId, ["chat"]);
    return { status: 200, body: this.view(record.conversation, who) };
  }

  #remove(record: StandInChatRecord, who: string, userId: string): Reply {
    if (!this.view(record.conversation, who).canRemoveMembers) return refused("Only an admin or the channel's creator, in it, removes people.", 403);
    if (!this.#known(record.spaceId, [userId])) return refused("Only people in this organization can be in its conversations.");
    this.#drop(record, userId);
    return { status: 200, body: this.view(record.conversation, who) };
  }

  #drop(record: StandInChatRecord, userId: string): void {
    record.conversation.members = record.conversation.members.filter((person) => person.id !== userId);
    this.chat.changeAccess(record.spaceId, ["chat"]);
  }

  #known(spaceId: string, userIds: string[]): boolean {
    const people = this.chat.people(spaceId);
    return userIds.every((id) => people.some((person) => person.id === id));
  }
}
