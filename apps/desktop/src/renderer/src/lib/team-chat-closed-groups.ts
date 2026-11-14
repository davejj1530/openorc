import type { TeamChatScope } from "@openorc/client";
import type { TeamConversation } from "@openorc/protocol";

type Conversation = Pick<TeamConversation, "id" | "kind" | "participants" | "lastMessageSeq">;
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
const PREFIX = "openorc.teamChat.closed:";
const keyOf = (scope: TeamChatScope, id: string) => PREFIX + JSON.stringify([scope.accountId, scope.spaceId, id]);
const isGroup = (conversation: Conversation) => conversation.kind === "dm" && (conversation.participants?.length ?? 0) > 2;

export class TeamChatClosedGroups {
  readonly #memory = new Map<string, number | null>();
  readonly #listeners = new Set<() => void>();
  #revision = 0;
  constructor(private readonly storage: StoragePort) {}

  getSnapshot = (): number => this.#revision;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  close(scope: TeamChatScope, conversation: Conversation): boolean {
    if (!isGroup(conversation)) return false;
    this.#save(keyOf(scope, conversation.id), conversation.lastMessageSeq);
    return true;
  }
  isClosed(scope: TeamChatScope, conversation: Conversation): boolean {
    if (!isGroup(conversation)) return false;
    const through = this.#read(keyOf(scope, conversation.id));
    return through !== null && conversation.lastMessageSeq <= through;
  }
  reopen(scope: TeamChatScope, id: string): void {
    const key = keyOf(scope, id);
    if (this.#read(key) !== null) this.#save(key, null);
  }
  reconcile(scope: TeamChatScope, conversations: readonly Conversation[]): void {
    for (const conversation of conversations) {
      const through = this.#read(keyOf(scope, conversation.id));
      if (through !== null && conversation.lastMessageSeq > through) this.reopen(scope, conversation.id);
    }
  }
  forgetSpace(accountId: string, spaceId: string): void {
    const prefix = PREFIX + JSON.stringify([accountId, spaceId]).slice(0, -1) + ",";
    const keys = new Set(this.#memory.keys());
    try {
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        if (key) keys.add(key);
      }
    } catch {
      /* The current window can still forget its markers when storage is unavailable. */
    }
    for (const key of keys) if (key.startsWith(prefix)) this.#save(key, null);
  }
  #read(key: string): number | null {
    if (this.#memory.has(key)) return this.#memory.get(key) ?? null;
    let through: number | null = null;
    try {
      const value: unknown = JSON.parse(this.storage.getItem(key) ?? "null");
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) through = value;
    } catch {
      /* A damaged preference must not hide a conversation. */
    }
    this.#memory.set(key, through);
    return through;
  }
  #save(key: string, through: number | null): void {
    this.#memory.set(key, through);
    try {
      if (through === null) this.storage.removeItem(key);
      else this.storage.setItem(key, JSON.stringify(through));
    } catch {
      /* Closing remains usable in this window if device storage is full. */
    }
    ++this.#revision;
    for (const listener of this.#listeners) listener();
  }
}
