import { describe, expect, it } from "vitest";
import type { PushState } from "@openorc/protocol";
import {
  comparisons,
  compareUrl,
  fileCount,
  fileMarks,
  hasUnpushed,
  heldNotice,
  publishView,
  pullRequestHead,
  pullRequestTarget,
  pushLabel,
  teamGitActions,
  type PublishInput,
} from "./git-actions.js";

const state = (over: Partial<PushState> = {}): PushState => ({ branch: "feat/x", blocked: null, published: true, unpushedCount: 0, unpushed: [], busy: false, ...over });
const allowed = { allowed: true, reason: null };
const everyone = { commit: allowed, push: allowed, createPr: allowed };

describe("push", () => {
  it.each<[string, PushState | undefined, boolean, string]>([
    ["a new branch", state({ published: false, unpushedCount: 2 }), false, "Publish branch"],
    ["a new branch while it publishes", state({ published: false, unpushedCount: 2 }), true, "Publishing…"],
    ["two commits", state({ unpushedCount: 2 }), false, "Push 2 commits"],
    ["one commit", state({ unpushedCount: 1 }), false, "Push 1 commit"],
    ["commits while they push", state({ unpushedCount: 1 }), true, "Pushing…"],
    ["nothing known yet", undefined, false, "Push"],
    ["a blocked branch", state({ published: false, blocked: "This repository has no origin remote to push to." }), false, "Push"],
  ])("labels %s", (_case, push, pushing, label) => {
    expect(pushLabel(push, pushing)).toBe(label);
  });

  it("counts a branch origin lacks, or commits it lacks, as unpushed", () => {
    expect(hasUnpushed(undefined)).toBe(false);
    expect(hasUnpushed(state())).toBe(false);
    expect(hasUnpushed(state({ unpushedCount: 1 }))).toBe(true);
    expect(hasUnpushed(state({ published: false }))).toBe(true);
  });

  it("holds a success until new commits arrive, and a failure until nothing is left to push", () => {
    const pushed = { message: "Pushed feat/x to origin" };
    const refused = { message: "origin has newer commits on feat/x. Pull them in first, then push again.", error: true };
    expect(heldNotice(pushed, false)).toBe(pushed);
    expect(heldNotice(pushed, true)).toBeNull();
    expect(heldNotice(refused, true)).toBe(refused);
    expect(heldNotice(refused, false)).toBeNull();
    expect(heldNotice(null, true)).toBeNull();
  });
});

describe("pull requests", () => {
  const project = { gitRemote: "git@github.com:openorc/site.git", defaultBranch: "main" };

  it("opens from the branch once origin has it with every commit, never from the default branch", () => {
    expect(pullRequestHead(state(), project)).toBe("feat/x");
    expect(pullRequestHead(state({ unpushedCount: 1 }), project)).toBeNull();
    expect(pullRequestHead(state({ published: false }), project)).toBeNull();
    expect(pullRequestHead(state({ blocked: "No origin." }), project)).toBeNull();
    expect(pullRequestHead(state({ branch: "main" }), project)).toBeNull();
    expect(pullRequestHead(state({ branch: "main" }), { ...project, defaultBranch: null })).toBeNull();
    expect(pullRequestHead(undefined, project)).toBeNull();
  });

  it("falls back to GitHub's compare page for a worktree branch on a GitHub remote", () => {
    const thread = { branch: "feat/x", baseBranch: "dev", workspaceMode: "worktree" as const };
    expect(compareUrl(project, thread)).toBe("https://github.com/openorc/site/compare/dev...feat%2Fx?expand=1");
    expect(compareUrl({ gitRemote: "https://github.com/openorc/site.git", defaultBranch: "trunk" }, { ...thread, baseBranch: null })).toBe(
      "https://github.com/openorc/site/compare/trunk...feat%2Fx?expand=1",
    );
    expect(compareUrl({ gitRemote: "https://gitlab.com/openorc/site.git", defaultBranch: "main" }, thread)).toBeNull();
    expect(compareUrl(project, { ...thread, workspaceMode: "current" })).toBeNull();
    expect(compareUrl(project, { ...thread, branch: null })).toBeNull();
    expect(compareUrl({ ...project, gitRemote: null }, thread)).toBeNull();
  });

  describe("a new pull request's target", () => {
    const known = { branches: ["main", "dev", "feat/login"], defaultBranch: "main" };

    it("targets the branch the work started from while GitHub has it", () => {
      expect(pullRequestTarget({ started: "dev", projectDefault: "main", head: "feat/login", branches: undefined })).toBe("dev");
      expect(pullRequestTarget({ started: "dev", projectDefault: "main", head: "feat/login", branches: known })).toBe("dev");
      expect(pullRequestTarget({ started: "release/1", projectDefault: "main", head: "feat/login", branches: known })).toBe("main");
    });

    it("falls back to GitHub's default branch, and never targets the branch it opens from", () => {
      expect(pullRequestTarget({ started: null, projectDefault: "trunk", head: "feat/login", branches: known })).toBe("main");
      expect(pullRequestTarget({ started: "dev", projectDefault: "main", head: "dev", branches: known })).toBe("main");
      expect(pullRequestTarget({ started: null, projectDefault: null, head: "main", branches: known })).toBeNull();
    });
  });
});

describe("team Git action availability", () => {
  const ready = { isPending: false, isError: false, data: { actions: everyone } };

  it("fails closed when a previously authorized projection cannot be refreshed", () => {
    expect(Object.values(teamGitActions(true, { ...ready, isError: true })).every((action) => !action.allowed && action.reason?.includes("Retry"))).toBe(true);
    expect(Object.values(teamGitActions(true, { ...ready, isPending: true })).every((action) => !action.allowed)).toBe(true);
    expect(Object.values(teamGitActions(true, { ...ready, data: {} })).every((action) => !action.allowed)).toBe(true);
    expect(Object.values(teamGitActions(true, { ...ready, data: null })).every((action) => !action.allowed)).toBe(true);
  });

  it("does not let an allowed commit authorize publishing before integration is ready", () => {
    const blocked = { allowed: false, reason: "Resolve retained integration details first." };
    const actions = teamGitActions(true, { ...ready, data: { actions: { commit: allowed, push: blocked, createPr: blocked } } });
    expect(actions.commit.allowed).toBe(true);
    expect(actions.push).toEqual(blocked);
    expect(actions.createPr).toEqual(blocked);
    expect(teamGitActions(true, ready)).toEqual(ready.data.actions);
  });

  it("leaves ordinary task Git controls independent of the disabled team query", () => {
    expect(Object.values(teamGitActions(false, { isPending: true, isError: false })).every((action) => action.allowed)).toBe(true);
  });
});

describe("changed files", () => {
  it("marks each status with the desktop's letter and tone", () => {
    expect(fileMarks).toEqual({
      added: { letter: "A", tone: "ok" },
      untracked: { letter: "U", tone: "ok" },
      modified: { letter: "M", tone: "ink-2" },
      deleted: { letter: "D", tone: "bad" },
      renamed: { letter: "R", tone: "warn" },
    });
    expect([fileCount(0), fileCount(1), fileCount(2)]).toEqual(["0 files", "1 file", "2 files"]);
    expect(comparisons).toEqual([
      { value: "head", label: "Uncommitted" },
      { value: "base", label: "Branch" },
    ]);
  });
});

describe("publishView", () => {
  type Override = Omit<Partial<PublishInput>, "thread" | "project"> & { thread?: Partial<PublishInput["thread"]>; project?: Partial<PublishInput["project"]> };
  const input = (over: Override = {}): PublishInput => ({
    uncommitted: { files: 0 },
    push: { state: state(), error: null },
    gh: true,
    team: everyone,
    running: null,
    offline: null,
    ...over,
    project: { gitRemote: "git@github.com:openorc/site.git", defaultBranch: "main", ...over.project },
    thread: {
      branch: "feat/x",
      baseBranch: "main",
      workspaceMode: "worktree",
      worktreePath: "/w/x",
      prUrl: null,
      prState: null,
      activity: "idle",
      agent: "codex",
      teamInstanceId: null,
      ...over.thread,
    },
  });
  const idle = (label: string) => ({ label, reason: null, running: false });

  it("puts nothing in the bar for a clean, published branch with nowhere to open a pull request", () => {
    const view = publishView(input({ project: { gitRemote: "https://gitlab.com/o/site.git", defaultBranch: "main" }, gh: false }));
    expect(view).toEqual({ commit: { label: "Commit", reason: "Nothing to commit.", running: false }, push: null, pushBlocked: null, pullRequest: null, next: null });
  });

  it("commits first, then publishes, then pushes, then opens the pull request", () => {
    expect(publishView(input({ uncommitted: { files: 3 }, push: { state: state({ published: false }), error: null } }))).toMatchObject({
      commit: idle("Commit"),
      push: idle("Publish branch"),
      next: "commit",
    });
    expect(publishView(input({ push: { state: state({ published: false, unpushedCount: 1 }), error: null } }))).toMatchObject({ push: idle("Publish branch"), pullRequest: null, next: "push" });
    expect(publishView(input({ push: { state: state({ unpushedCount: 2 }), error: null } }))).toMatchObject({ push: idle("Push 2 commits"), pullRequest: null, next: "push" });
    expect(publishView(input())).toMatchObject({ push: null, pullRequest: { kind: "open", head: "feat/x", step: idle("PR") }, next: "pr" });
  });

  it("offers nothing to publish from a fresh branch until it has a commit of its own", () => {
    const fresh = { state: state({ published: false }), error: null };
    expect(publishView(input({ push: fresh, commits: 0 }))).toMatchObject({ push: null, pullRequest: null, next: null });
    expect(publishView(input({ uncommitted: { files: 2 }, push: fresh, commits: 0 }))).toMatchObject({ push: null, next: "commit" });
    expect(publishView(input({ push: fresh, commits: 1 }))).toMatchObject({ push: idle("Publish branch"), next: "push" });
    // A worktree started from local commits origin lacks still has them to publish.
    expect(publishView(input({ push: { state: state({ published: false, unpushedCount: 2 }), error: null }, commits: 0 }))).toMatchObject({ push: idle("Publish branch") });
  });

  it("names the step that runs", () => {
    expect(publishView(input({ uncommitted: { files: 1 }, running: "commit" })).commit).toEqual({ label: "Committing…", reason: null, running: true });
    expect(publishView(input({ push: { state: state({ published: false, unpushedCount: 1 }), error: null }, running: "push" })).push).toEqual({ label: "Publishing…", reason: null, running: true });
    expect(publishView(input({ push: { state: state({ unpushedCount: 1 }), error: null }, running: "push" })).push).toEqual({ label: "Pushing…", reason: null, running: true });
    expect(publishView(input({ running: "pr" })).pullRequest).toEqual({ kind: "open", head: "feat/x", step: { label: "Opening…", reason: null, running: true } });
  });

  it("opens GitHub's compare page without gh, and shows a pull request that exists", () => {
    expect(publishView(input({ gh: false })).pullRequest).toEqual({ kind: "compare", url: "https://github.com/openorc/site/compare/main...feat%2Fx?expand=1", step: idle("PR") });
    expect(publishView(input({ gh: undefined })).pullRequest).toMatchObject({ kind: "compare" });
    const open = publishView(input({ thread: { prUrl: "https://github.com/openorc/site/pull/12", prState: "merged" } }));
    expect(open).toMatchObject({ pullRequest: { kind: "exists", url: "https://github.com/openorc/site/pull/12", state: "merged" }, next: null });
  });

  it("says why nothing can be pushed", () => {
    const blocked = publishView(input({ push: { state: state({ published: false, blocked: "This repository has no origin remote to push to." }), error: null } }));
    expect(blocked).toMatchObject({ push: null, pushBlocked: "This repository has no origin remote to push to.", pullRequest: null });
    expect(publishView(input({ push: { state: undefined, error: "Could not read push state" } }))).toMatchObject({ push: null, pushBlocked: "Could not read push state" });
  });

  it("waits for the agent to finish before any step, in both apps", () => {
    const working = publishView(input({ uncommitted: { files: 2 }, push: { state: state({ unpushedCount: 1 }), error: null }, thread: { activity: "running" } }));
    expect(working.commit?.reason).toBe("Wait for Codex to finish.");
    expect(working.push?.reason).toBe("Wait for Codex to finish.");
    expect(working.next).toBe("commit");
    expect(publishView(input({ thread: { activity: "running", agent: "claude" } })).pullRequest).toMatchObject({ step: { reason: "Wait for Claude Code to finish." } });
  });

  it("waits the same while the agent's run waits on an approval or a question, which still holds the workspace", () => {
    const waiting = publishView(input({ uncommitted: { files: 2 }, push: { state: state({ unpushedCount: 1 }), error: null }, thread: { activity: "waiting", agent: "claude" } }));
    expect([waiting.commit?.reason, waiting.push?.reason]).toEqual(["Wait for Claude Code to finish.", "Wait for Claude Code to finish."]);
    expect(publishView(input({ thread: { activity: "waiting" } })).pullRequest).toMatchObject({ step: { reason: "Wait for Codex to finish." } });
  });

  it("leaves a detached copy uncommittable, but not a team's detached worktree", () => {
    expect(publishView(input({ uncommitted: { files: 2 }, thread: { branch: null } })).commit).toBeNull();
    expect(publishView(input({ uncommitted: { files: 2 }, thread: { branch: null, teamInstanceId: "team" } })).commit).toEqual(idle("Commit"));
  });

  it("gives a team's reasons, then the link's, priority over everything else", () => {
    const busy = { allowed: false, reason: "Team is working" };
    const team = publishView(
      input({ uncommitted: { files: 1 }, push: { state: state({ unpushedCount: 1 }), error: null }, team: { commit: busy, push: busy, createPr: busy }, thread: { activity: "running" } }),
    );
    expect([team.commit?.reason, team.push?.reason]).toEqual(["Team is working", "Team is working"]);
    const offline = publishView(input({ uncommitted: { files: 1 }, offline: "Not connected to Mac", team: { commit: busy, push: busy, createPr: busy } }));
    expect(offline.commit?.reason).toBe("Not connected to Mac");
    expect(offline.pullRequest).toMatchObject({ step: { reason: "Not connected to Mac" } });
  });

  it("dims Commit until the uncommitted read answers, and says to refresh when it failed", () => {
    expect(publishView(input({ uncommitted: "loading" })).commit?.reason).toBe("Checking for changes…");
    expect(publishView(input({ uncommitted: "failed" })).commit?.reason).toBe("Refresh changes before committing.");
  });
});
