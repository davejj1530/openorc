import type { PendingTeamMessage, TeamChatPerson, TeamChatState, TeamConversation, TeamMessage } from "@openorc/protocol";

export interface TeamChatScope {
  accountId: string;
  spaceId: string;
}
export const teamChatScopeKey = ({ accountId, spaceId }: TeamChatScope): string => JSON.stringify([accountId, spaceId]);

/**
 * A captured result is usable only in the account, space and access generation that requested it. Coming back to a
 * scope gives back its generation, so what it read is shown again at once; `invalidate` forgets every scope.
 */
export class TeamChatGeneration {
  #scope: string | null = null;
  #generation = 0;
  #last = 0;
  #held = new Map<string, number>();
  enter(scope: TeamChatScope | null): void {
    const next = scope ? teamChatScopeKey(scope) : null;
    if (next === this.#scope) return;
    this.#scope = next;
    if (next === null) return;
    const held = this.#held.get(next) ?? ++this.#last;
    this.#held.set(next, held);
    this.#generation = held;
  }
  invalidate(): void {
    this.#held.clear();
    this.#generation = ++this.#last;
    if (this.#scope !== null) this.#held.set(this.#scope, this.#generation);
  }
  capture(): number {
    return this.#generation;
  }
  accepts(generation: number): boolean {
    return this.#scope !== null && generation === this.#generation;
  }
}

export function mergeTeamMessages(before: readonly TeamMessage[], incoming: readonly TeamMessage[]): TeamMessage[] {
  const messages = new Map(before.map((message) => [message.id, message]));
  for (const message of incoming) messages.set(message.id, message);
  return [...messages.values()].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
}

/**
 * The conversation's messages with the person's own sends not yet confirmed after them, each drawn as the message it
 * becomes, with the id the server keeps, so its row stays where it was drawn when the server answers.
 */
export function withUnsent(
  messages: readonly TeamMessage[],
  pending: readonly PendingTeamMessage[],
  conversationId: string,
  self: TeamChatPerson,
): { messages: readonly TeamMessage[]; unsent: ReadonlyMap<string, PendingTeamMessage> } {
  const sent = new Set(messages.map((message) => message.id));
  const unsent = new Map(pending.filter((message) => !sent.has(message.id)).map((message) => [message.id, message]));
  if (!unsent.size) return { messages, unsent };
  const drawn = [...unsent.values()].map((message): TeamMessage => ({
    id: message.id,
    channelId: conversationId,
    seq: Number.MAX_SAFE_INTEGER,
    actor: { kind: "person", person: self },
    body: message.body,
    files: message.files,
    reactions: [],
    replyTo: message.replyTo,
    pinned: null,
    call: null,
    createdAt: message.createdAt,
  }));
  return { messages: [...messages, ...drawn], unsent };
}

export type TeamChatRow =
  { kind: "person"; id: string; title: string; person: TeamChatPerson; conversation: TeamConversation | null } | { kind: "conversation"; id: string; title: string; conversation: TeamConversation };

export function teamConversationTitle(conversation: TeamConversation, self: string): string {
  if (conversation.kind === "channel") return conversation.name ?? "Channel";
  const others = (conversation.participants ?? []).map(({ person }) => person).filter((person) => person.id !== self);
  if (others.length === 1) return others[0]?.name ?? "Chat";
  return teamChatShortNames(others).join(", ") || "Chat";
}

/** First names, with the full name wherever two of these people share a first name. */
export function teamChatShortNames(people: readonly TeamChatPerson[]): string[] {
  const first = (person: TeamChatPerson) => person.name.split(/\s/)[0] || person.name;
  return people.map((person) => (people.filter((other) => first(other) === first(person)).length > 1 ? person.name : first(person)));
}

export function teamChatRoster(state: TeamChatState, self: string): TeamChatRow[] {
  const direct = state.conversations.filter((conversation) => conversation.kind === "dm" && conversation.participants?.length === 2);
  const people: Extract<TeamChatRow, { kind: "person" }>[] = state.people
    .filter((person) => person.id !== self)
    .map((person) => ({
      kind: "person",
      id: person.id,
      title: person.name,
      person,
      conversation: direct.find((conversation) => conversation.participants?.some((participant) => participant.person.id === person.id)) ?? null,
    }));
  people.sort((a, b) => {
    const aAt = a.conversation?.lastMessageAt ?? "";
    const bAt = b.conversation?.lastMessageAt ?? "";
    return bAt.localeCompare(aAt) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  });
  const groups = state.features.includes("groups")
    ? state.conversations
        .filter((conversation) => conversation.kind === "dm" && (conversation.participants?.length ?? 0) > 2)
        .sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? "") || a.id.localeCompare(b.id))
    : [];
  const channels = state.conversations
    .filter((conversation) => conversation.kind === "channel" && conversation.joined)
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || a.id.localeCompare(b.id));
  return [...people, ...[...groups, ...channels].map((conversation): TeamChatRow => ({ kind: "conversation", id: conversation.id, title: teamConversationTitle(conversation, self), conversation }))];
}
