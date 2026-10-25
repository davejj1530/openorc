import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Commit, FileChange, Project, PushState, RpcMethod, RpcParams, RpcResults, ThreadSummary } from "@openorc/protocol";
import { ComposerCommitChip } from "../components/ComposerFooter";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/client";
import { useComposerChanges } from "../lib/composer-changes";
import { ChangesPanel } from "./ChangesPanel";
import { CommitsPanel } from "./CommitsPanel";

/* Commit, Push and the pull request wait while the agent works, and say so, as on the phone. */

vi.mock("../components/DiffView", () => ({ DiffView: () => <div data-testid="diff" /> }));

const project: Project = {
  id: "project",
  name: "Site",
  rootPath: "/repo",
  defaultBranch: "main",
  gitRemote: "git@github.com:openorc/site.git",
  settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc", detectedConfigs: [] },
  createdAt: 0,
  updatedAt: 0,
};
const base: ThreadSummary = {
  id: "thread",
  projectId: project.id,
  title: "Site",
  agent: "codex",
  model: null,
  effort: null,
  fastMode: false,
  mode: "act",
  permissionMode: "review",
  workspaceMode: "current",
  branch: null,
  worktreePath: null,
  baseSha: null,
  baseBranch: null,
  pinnedAt: null,
  seenAt: null,
  doneAt: null,
  snoozedUntil: null,
  prUrl: null,
  prState: null,
  forkedFromId: null,
  forkedAtRunId: null,
  draft: "",
  importedFrom: null,
  createdAt: 0,
  updatedAt: 0,
  lastActivityAt: 0,
  archivedAt: null,
  activity: "idle",
  unread: false,
  session: { status: "idle", message: null },
  context: null,
  queued: [],
  lastAgentEventAt: null,
  taskCount: 0,
  openTaskCount: 0,
};
const worktree: Partial<ThreadSummary> = { workspaceMode: "worktree", worktreePath: "/data/worktrees/site", branch: "feat/site", baseSha: "c".repeat(40), baseBranch: "main" };
const commits: Commit[] = [
  { sha: "b".repeat(40), author: "David C", at: 2, subject: "Add part 2" },
  { sha: "a".repeat(40), author: "David C", at: 1, subject: "Add the feature" },
];
const edited: FileChange[] = [{ path: "src/app.ts", status: "modified", oldPath: null }];
const editPatch = ["diff --git a/src/app.ts b/src/app.ts", "--- a/src/app.ts", "+++ b/src/app.ts", "@@ -1,1 +1,2 @@", "-const a = 0;", "+const a = 1;", "+const b = 2;"].join("\n");

interface World {
  thread?: Partial<ThreadSummary>;
  project?: Partial<Project>;
  /** Uncommitted changes, or a failed read of them. */
  head?: FileChange[] | "error";
  push?: PushState | "error";
  log?: Commit[];
  gh?: boolean;
  /** A team conversation's Git availability reason; null allows every action. */
  team?: string | null;
}

const published = (unpushed: number, more: Partial<PushState> = {}): PushState => ({
  branch: "feat/site",
  blocked: null,
  published: true,
  unpushedCount: unpushed,
  unpushed: commits.slice(0, unpushed).map((c) => c.sha),
  busy: false,
  ...more,
});

function mockCore(world: World) {
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> => {
    const head = world.head ?? [];
    if (method === "review.threadDiff") {
      const comparison = (params as RpcParams<"review.threadDiff">).comparison;
      if (comparison === "head" && head === "error") throw new Error("git failed");
      const files = head === "error" ? edited : head;
      return { baseSha: null, patch: files.length ? editPatch : "", files, since: null } as RpcResults[M];
    }
    if (method === "git.threadLog") return (world.log ?? []) as RpcResults[M];
    if (method === "git.threadPushState") {
      if (world.push === "error") throw new Error("Could not read push state");
      return (world.push ?? published(0)) as RpcResults[M];
    }
    if (method === "system.info") return { gh: { installed: world.gh ?? true, path: world.gh === false ? null : "/usr/bin/gh" } } as unknown as RpcResults[M];
    if (method === "orchestration.runtime") {
      const action = { allowed: !world.team, reason: world.team ?? null };
      return { actions: { commit: action, push: action, createPr: action } } as RpcResults[M];
    }
    if (method === "review.threadPrTemplate") return { body: null } as RpcResults[M];
    if (method === "pulls.branches") return { branches: ["main"], defaultBranch: "main" } as RpcResults[M];
    if (method === "review.comments.list") return [] as unknown as RpcResults[M];
    return [] as unknown as RpcResults[M];
  });
}

function ComposerHost({ thread }: { thread: ThreadSummary }) {
  const changes = useComposerChanges({ kind: "thread", id: thread.id, projectName: project.name, team: Boolean(thread.teamInstanceId), thread });
  return <ComposerCommitChip changes={changes} />;
}

beforeEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

const titled = (root: HTMLElement, label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((el) => (el.textContent ?? "").trim() === label);

describe("while Codex works", () => {
  const running: Partial<ThreadSummary> = { ...worktree, activity: "running" };

  it("dims Commit in Changes and says why", async () => {
    mockCore({ thread: running, head: edited });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ChangesPanel thread={{ ...base, ...running }} project={project} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(titled(view.container, "Commit")?.title).toBe("Wait for Codex to finish."));
    expect(titled(view.container, "Commit")?.disabled).toBe(true);
  });

  it("dims Push and the pull request in Commits and says why", async () => {
    mockCore({ thread: running, log: commits, push: published(1) });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <CommitsPanel source={{ kind: "thread", thread: { ...base, ...running }, project }} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(titled(view.container, "Push 1 commit")?.title).toBe("Wait for Codex to finish."));
    expect(titled(view.container, "Push 1 commit")?.disabled).toBe(true);
    cleanup();
    queryClient.clear();
    mockCore({ thread: running, log: commits, push: published(0) });
    const pr = render(
      <QueryClientProvider client={queryClient}>
        <CommitsPanel source={{ kind: "thread", thread: { ...base, ...running }, project }} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(titled(pr.container, "PR")?.title).toBe("Wait for Codex to finish."));
    expect(titled(pr.container, "PR")?.disabled).toBe(true);
  });

  it("dims Commit the same while the run waits on an approval or a question, with the agent's name", async () => {
    const waiting: Partial<ThreadSummary> = { ...worktree, activity: "waiting", agent: "claude" };
    mockCore({ thread: waiting, head: edited });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ChangesPanel thread={{ ...base, ...waiting }} project={project} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(titled(view.container, "Commit")?.title).toBe("Wait for Claude Code to finish."));
    expect(titled(view.container, "Commit")?.disabled).toBe(true);
  });

  it("dims the composer's Commit and says why", async () => {
    mockCore({ thread: running, head: edited });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ComposerHost thread={{ ...base, ...running }} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Commit changes" })).toHaveProperty("disabled", true));
    expect(view.container.textContent).toContain("Commit");
  });
});
