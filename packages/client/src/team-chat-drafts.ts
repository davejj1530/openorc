import { TeamChatDraft, type PendingTeamMessage, type TeamChatAnswered, type TeamChatOrclingPick } from "@openorc/protocol";
/** One conversation of one account's organization, where a draft is written. */
export interface TeamChatTarget {
  accountId: string;
  spaceId: string;
  conversationId: string;
}
const PREFIX = "openorc.teamChat.draft:";
const keyOf = (at: TeamChatTarget) => PREFIX + JSON.stringify([at.accountId, at.spaceId, at.conversationId]);

/** Where drafts outlive a launch: the window's local storage, or the phone's own. */
export interface TeamChatDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

/** Only local words and unsent identities persist; authorized server history never enters draft storage. */
export class TeamChatDrafts {
  readonly #memory = new Map<string, TeamChatDraft>();
  readonly #listeners = new Set<() => void>();
  constructor(
    private readonly storage: TeamChatDraftStorage,
    /** A fresh unique id for each message, kept across its retries. */
    private readonly randomId: () => string,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  read(at: TeamChatTarget): TeamChatDraft {
    const key = keyOf(at);
    const cached = this.#memory.get(key);
    if (cached) return cached;
    let saved: TeamChatDraft = { text: "", replyTo: null, orcling: null, pending: [] };
    try {
      const parsed = TeamChatDraft.safeParse(JSON.parse(this.storage.getItem(key) ?? "null"));
      if (parsed.success) saved = { ...parsed.data, pending: parsed.data.pending.map((message) => ({ ...message, state: "failed", error: "Delivery couldn't be confirmed." })) };
    } catch {
      /* A damaged local draft cannot supply a send. */
    }
    this.#memory.set(key, saved);
    return saved;
  }
  write(at: TeamChatTarget, text: string): void {
    this.#save(at, { ...this.read(at), text });
  }
  /** The message the next send answers, or null to answer none. */
  reply(at: TeamChatTarget, replyTo: TeamChatAnswered | null): void {
    this.#save(at, { ...this.read(at), replyTo });
  }
  /** The person's own Orcling the next send calls, picked from the `@` list. */
  callOrcling(at: TeamChatTarget, orcling: TeamChatOrclingPick): void {
    this.#save(at, { ...this.read(at), orcling });
  }
  begin(at: TeamChatTarget, files: PendingTeamMessage["files"] = []): PendingTeamMessage | null {
    const current = this.read(at);
    if (!current.text.trim() && !files.length) return null;
    // An Orcling is called only while its name is still in the words; deleting "@Rini" takes the call back.
    const called = current.orcling && current.text.includes(`@${current.orcling.name}`) ? { ...current.orcling, callId: this.randomId() } : null;
    const message: PendingTeamMessage = {
      id: this.randomId(),
      body: current.text,
      files,
      replyTo: current.replyTo,
      orcling: called,
      createdAt: new Date().toISOString(),
      state: "sending",
      error: null,
    };
    this.#save(at, { text: "", replyTo: null, orcling: null, pending: [...current.pending, message] });
    return message;
  }
  attempt(at: TeamChatTarget, id: string): void {
    this.#change(at, id, { state: "sending", error: null });
  }
  failed(at: TeamChatTarget, id: string, error: string): void {
    this.#change(at, id, { state: "failed", error });
  }
  reconcile(at: TeamChatTarget, committed: readonly string[]): void {
    const current = this.read(at);
    const pending = current.pending.filter((message) => !committed.includes(message.id));
    if (pending.length !== current.pending.length) this.#save(at, { ...current, pending });
  }
  forget(at: TeamChatTarget): void {
    this.#forgetKey(keyOf(at));
    this.#emit();
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
      /* Remove the in-memory copies even without storage. */
    }
    for (const key of keys) if (key.startsWith(prefix)) this.#forgetKey(key);
    this.#emit();
  }
  #forgetKey(key: string): void {
    const empty = { text: "", replyTo: null, orcling: null, pending: [] };
    this.#memory.set(key, empty);
    try {
      this.storage.removeItem(key);
    } catch {
      try {
        this.storage.setItem(key, JSON.stringify(empty));
      } catch {
        /* An empty memory entry prevents rereading inaccessible words in this window. */
      }
    }
  }
  #change(at: TeamChatTarget, id: string, change: Pick<PendingTeamMessage, "state" | "error">): void {
    const current = this.read(at);
    this.#save(at, { ...current, pending: current.pending.map((message) => (message.id === id ? { ...message, ...change } : message)) });
  }
  #save(at: TeamChatTarget, value: TeamChatDraft): void {
    const key = keyOf(at);
    this.#memory.set(key, value);
    try {
      this.storage.setItem(key, JSON.stringify(value));
    } catch {
      /* The current window keeps the draft when storage is full. */
    }
    this.#emit();
  }
  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
