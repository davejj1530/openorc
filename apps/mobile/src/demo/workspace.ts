import type { ChangeComparison, Commit, FileChangeStat, FileDiff, PushState, WorkspaceChanges } from "@openorc/protocol";

/** A file the demo's agent changed: its patch as git prints it, without the header lines. */
export interface DemoFile {
  path: string;
  patch: string;
}

const counted = (patch: string, mark: "+" | "-") => patch.split("\n").filter((line) => line.startsWith(mark)).length;

function stat(file: DemoFile): FileChangeStat {
  return { path: file.path, status: "modified", oldPath: null, body: { kind: "text", insertions: counted(file.patch, "+"), deletions: counted(file.patch, "-") } };
}

/** A hex sha from text, stable across runs, so the log reads like git's. */
function shaOf(text: string, at: number): string {
  let hash = 2166136261;
  for (const char of `${text}${at}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const part = (seed: number) => ((hash ^ seed) >>> 0).toString(16).padStart(8, "0");
  return [part(0), part(0x9e3779b9), part(0x7f4a7c15), part(0x2545f491), part(0x6c8e9cf5)].join("");
}

/**
 * A thread's worktree on the demo Mac: what is uncommitted, what its branch committed, and what origin has. Commit
 * and Push change it as git would, in memory only.
 */
export class DemoWorkspace {
  private uncommitted: DemoFile[] = [];
  private committed: DemoFile[] = [];
  private log: Commit[] = [];
  private unpushed: string[] = [];
  private published = false;

  constructor(
    readonly branch: string,
    readonly baseSha: string,
  ) {}

  /** The agent changed a file; a second change to the same file replaces the first, as its diff would. */
  change(file: DemoFile): void {
    this.uncommitted = [...this.uncommitted.filter((kept) => kept.path !== file.path), file];
  }

  changes(comparison: ChangeComparison): WorkspaceChanges {
    const files = this.files(comparison).map(stat);
    const totals = files.reduce(
      (sum, file) => (file.body.kind === "text" ? { files: sum.files + 1, insertions: sum.insertions + file.body.insertions, deletions: sum.deletions + file.body.deletions } : sum),
      { files: 0, insertions: 0, deletions: 0 },
    );
    return { comparison, baseSha: comparison === "base" ? this.baseSha : null, totals, files, unlisted: 0 };
  }

  fileDiff(comparison: ChangeComparison, path: string): FileDiff {
    const file = this.files(comparison).find((candidate) => candidate.path === path);
    if (!file) throw new Error("This file has no changes.");
    return { path, oldPath: null, status: "modified", body: stat(file).body, patch: file.patch, cut: null };
  }

  commit(message: string, at: number): Commit {
    if (this.uncommitted.length === 0) throw new Error("Nothing to commit.");
    const subject = message.split("\n")[0]!.trim();
    const commit: Commit = { sha: shaOf(message, at), author: "You", at, subject };
    const paths = new Set(this.uncommitted.map((file) => file.path));
    this.committed = [...this.committed.filter((file) => !paths.has(file.path)), ...this.uncommitted];
    this.uncommitted = [];
    this.log = [commit, ...this.log];
    this.unpushed = [commit.sha, ...this.unpushed];
    return commit;
  }

  push(): { remote: string; branch: string } {
    this.unpushed = [];
    this.published = true;
    return { remote: "origin", branch: this.branch };
  }

  commits(limit: number): Commit[] {
    return this.log.slice(0, limit);
  }

  pushState(): PushState {
    return { branch: this.branch, blocked: null, published: this.published, unpushedCount: this.unpushed.length, unpushed: this.unpushed, busy: false };
  }

  /** Uncommitted work against HEAD, or everything since the branch started, uncommitted over committed. */
  private files(comparison: ChangeComparison): DemoFile[] {
    if (comparison === "head") return this.uncommitted;
    const paths = new Set(this.uncommitted.map((file) => file.path));
    return [...this.committed.filter((file) => !paths.has(file.path)), ...this.uncommitted];
  }
}
