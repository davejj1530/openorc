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

/*
 * What the desktop's Changes and Commits tabs and the composer's Commit show in each publish state: the visible
 * labels, which controls are disabled, the notices and the empty states. Written before their logic moved to
 * @openorc/client, and kept passing unchanged after the move.
 */

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

/** What a person sees: each control's label with "(disabled)" when it is, then the notices, then the panel's text. */
function seen(root: HTMLElement) {
  const controls = [...root.querySelectorAll<HTMLButtonElement>("button, [role=radio]")].map((el) => {
    const label = (el.textContent ?? "").replace(/\s+/g, " ").trim() || el.getAttribute("aria-label") || "";
    return `${label}${el.disabled || el.getAttribute("aria-disabled") === "true" ? " (disabled)" : ""}`;
  });
  const notices = [...root.querySelectorAll("[role=status], [role=alert]")].map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim());
  return { controls, notices, text: (root.textContent ?? "").replace(/\s+/g, " ").trim() };
}

function ComposerHost({ thread }: { thread: ThreadSummary }) {
  const changes = useComposerChanges({ kind: "thread", id: thread.id, projectName: project.name, team: Boolean(thread.teamInstanceId), thread });
  return <ComposerCommitChip changes={changes} />;
}

async function mount(world: World, panel: "changes" | "commits" | "composer") {
  mockCore(world);
  const thread = { ...base, ...world.thread };
  const owner = { ...project, ...world.project };
  const view = render(
    <QueryClientProvider client={queryClient}>
      {panel === "changes" ? <ChangesPanel thread={thread} project={owner} /> : null}
      {panel === "commits" ? <CommitsPanel source={{ kind: "thread", thread, project: owner }} /> : null}
      {panel === "composer" ? <ComposerHost thread={thread} /> : null}
    </QueryClientProvider>,
  );
  // Every read the panel makes has settled.
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  return seen(view.container);
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

describe("Changes", () => {
  it.each<[string, World, { controls: string[]; notices?: string[]; text?: string }]>([
    ["Clean workspace in the checkout", {}, { controls: ["Refresh", "Commit (disabled)"], text: "Clean workspaceEdits the agent makes in Site show up here, ready to commit." }],
    [
      "Clean workspace in a worktree",
      { thread: worktree },
      { controls: ["Uncommitted", "Branch", "Refresh", "Commit (disabled)"], text: "Edits the agent makes in this thread's worktree show up here, ready to commit." },
    ],
    ["Changes", { head: edited }, { controls: ["Refresh", "Commit"], text: "1 file+2-1" }],
    ["Changes in a worktree", { thread: worktree, head: edited }, { controls: ["Uncommitted", "Branch", "Refresh", "Commit"] }],
    ["Uncommitted read failed", { thread: worktree, head: "error" }, { controls: ["Uncommitted", "Branch", "Refresh", "Commit (disabled)"] }],
    [
      "A team's workspace that is busy",
      { thread: { teamInstanceId: "team" }, head: edited, team: "Team is working" },
      { controls: ["Refresh", "Commit (disabled)", "Refresh team status"], notices: ["Team is working Refresh team status"] },
    ],
    ["A detached copy, read only", { thread: { workspaceMode: "worktree", worktreePath: "/data/worktrees/pr-7", branch: null }, head: edited }, { controls: ["Uncommitted", "Branch", "Refresh"] }],
    [
      "A pull request that exists",
      { thread: { ...worktree, prUrl: "https://github.com/openorc/site/pull/7", prState: "open" } },
      { controls: ["Uncommitted", "Branch", "open", "Refresh", "Commit (disabled)"] },
    ],
  ])("%s", async (_state, world, expected) => {
    const view = await mount(world, "changes");
    expect(view.controls.filter((label) => !/^src\/|file/.test(label))).toEqual(expected.controls);
    if (expected.notices) expect(view.notices).toEqual(expected.notices);
    if (expected.text) expect(view.text).toContain(expected.text);
  });
});

describe("Commits", () => {
  it.each<[string, World, { controls: string[]; notices?: string[]; text?: string }]>([
    ["No commits yet", { log: [] }, { controls: [], notices: [], text: "No commits from this thread yet" }],
    ["Publish branch", { thread: worktree, log: commits, push: published(2, { published: false }) }, { controls: ["Publish branch"], notices: [] }],
    ["Push 2 commits", { thread: worktree, log: commits, push: published(2) }, { controls: ["Push 2 commits"], notices: [] }],
    ["Push 1 commit", { thread: worktree, log: commits, push: published(1) }, { controls: ["Push 1 commit"], notices: [] }],
    [
      "Blocked: no origin",
      { log: commits, push: { branch: "main", blocked: "This repository has no origin remote to push to.", published: false, unpushedCount: 0, unpushed: [], busy: false } },
      { controls: [], text: "This repository has no origin remote to push to." },
    ],
    ["PR through gh", { thread: worktree, log: commits, push: published(0) }, { controls: ["PR"], notices: [] }],
    ["PR without gh, on GitHub: the compare page", { thread: worktree, log: commits, push: published(0), gh: false }, { controls: ["PR"], notices: [] }],
    ["No PR without gh off GitHub", { thread: worktree, project: { gitRemote: "https://gitlab.com/o/site.git" }, log: commits, push: published(0), gh: false }, { controls: [], notices: [] }],
    ["PR open", { thread: { ...worktree, prUrl: "https://github.com/openorc/site/pull/7", prState: "open" }, log: commits, push: published(0) }, { controls: ["open"], notices: [] }],
    ["PR merged", { thread: { ...worktree, prUrl: "https://github.com/openorc/site/pull/7", prState: "merged" }, log: commits, push: published(0) }, { controls: ["merged"], notices: [] }],
    ["No PR from the default branch", { log: commits, push: published(0, { branch: "main" }) }, { controls: [], notices: [] }],
    [
      "A team's workspace that is busy",
      { thread: { ...worktree, teamInstanceId: "team" }, log: commits, push: published(1), team: "Team is working" },
      { controls: ["Push 1 commit (disabled)"], text: "Team is working" },
    ],
    ["Push state could not be read", { thread: worktree, log: commits, push: "error" }, { controls: [], text: "Could not read push state" }],
  ])("%s", async (_state, world, expected) => {
    const view = await mount(world, "commits");
    expect(view.controls).toEqual(expected.controls);
    if (expected.notices) expect(view.notices).toEqual(expected.notices);
    if (expected.text) expect(view.text).toContain(expected.text);
  });

  it("names the push while it runs: Publishing… for a new branch", async () => {
    mockCore({ thread: worktree, log: commits, push: published(2, { published: false }) });
    const pending = vi.mocked(core.call).getMockImplementation()!;
    vi.mocked(core.call).mockImplementation(async (method, params) => (method === "review.pushThread" ? new Promise(() => {}) : pending(method, params)) as never);
    render(
      <QueryClientProvider client={queryClient}>
        <CommitsPanel source={{ kind: "thread", thread: { ...base, ...worktree }, project }} />
      </QueryClientProvider>,
    );
    (await screen.findByRole("button", { name: "Publish branch" })).click();
    expect(((await screen.findByRole("button", { name: "Publishing…" })) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the composer's Commit", () => {
  it.each<[string, World, { controls: string[] }]>([
    ["Changes", { head: edited }, { controls: ["Commit", "+2−1"] }],
    ["No changes", {}, { controls: [] }],
    // The chip counts what the failed read returned: nothing, so it hides.
    ["Uncommitted read failed", { head: "error" }, { controls: [] }],
    ["A team's workspace that is busy", { thread: { teamInstanceId: "team" }, head: edited, team: "Team is working" }, { controls: ["Commit (disabled)", "+2−1"] }],
  ])("%s", async (_state, world, expected) => {
    expect((await mount(world, "composer")).controls).toEqual(expected.controls);
  });
});
