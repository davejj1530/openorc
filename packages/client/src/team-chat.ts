import type { TeamChatPerson, TeamChatState, TeamConversation, TeamMessage } from "@openorc/protocol";

export interface TeamChatScope {
  accountId: string;
  spaceId: string;
}
export const teamChatScopeKey = ({ accountId, spaceId }: TeamChatScope): string => JSON.stringify([accountId, spaceId]);

/** A captured result is usable only in the account, space and access generation that requested it. */
export class TeamChatGeneration {
  #scope: string | null = null;
  #generation = 0;
  enter(scope: TeamChatScope | null): void {
    const next = scope ? teamChatScopeKey(scope) : null;
    if (next !== this.#scope) {
      this.#scope = next;
      this.#generation++;
    }
  }
  invalidate(): void {
    this.#generation++;
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

export type TeamChatRow =
  { kind: "person"; id: string; title: string; person: TeamChatPerson; conversation: TeamConversation | null } | { kind: "conversation"; id: string; title: string; conversation: TeamConversation };

export function teamConversationTitle(conversation: TeamConversation, self: string): string {
  if (conversation.kind === "channel") return conversation.name ?? "Channel";
  const others = (conversation.participants ?? []).map(({ person }) => person).filter((person) => person.id !== self);
  if (others.length === 1) return others[0]?.name ?? "Chat";
  return (
    others
      .map((person) => {
        const first = person.name.split(/\s/)[0] ?? person.name;
        return others.filter((other) => other.name.split(/\s/)[0] === first).length > 1 ? person.name : first;
      })
      .join(", ") || "Chat"
  );
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
