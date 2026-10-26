interface KeyValue {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** The pull request fields the reader changed; the rest follow their defaults. */
export interface PullRequestDraft {
  title?: string;
  body?: string;
  base?: string;
}

/**
 * What the phone keeps per Mac and thread for the Changes screen: the commit message being written and the pull request
 * fields edited. Kept as they change, so a lost link or a relaunch keeps them.
 */
export function createChangeDrafts(storage: KeyValue, macId: () => string | null) {
  const key = (kind: string, threadId: string) => `${kind}.${macId() ?? "none"}.${threadId}`;
  const keep = (name: string, value: string) => (value ? storage.set(name, value) : storage.remove(name));
  return {
    message: (threadId: string): string => storage.getString(key("commit", threadId)) ?? "",
    setMessage: (threadId: string, message: string) => keep(key("commit", threadId), message),
    pullRequest(threadId: string): PullRequestDraft {
      try {
        return JSON.parse(storage.getString(key("pr", threadId)) ?? "{}") as PullRequestDraft;
      } catch {
        return {};
      }
    },
    editPullRequest(threadId: string, edit: PullRequestDraft): void {
      storage.set(key("pr", threadId), JSON.stringify({ ...this.pullRequest(threadId), ...edit }));
    },
    clearPullRequest: (threadId: string) => storage.remove(key("pr", threadId)),
  };
}

export type ChangeDrafts = ReturnType<typeof createChangeDrafts>;
