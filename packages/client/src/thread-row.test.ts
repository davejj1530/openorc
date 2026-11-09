import { WORKSPACE_ID } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { pullRequestNumber, renamedTitle, threadMark, threadPlace, threadStatus, threadTreeStatus, workspaceLabel } from "./thread-row.js";

const resting = { activity: "idle", session: { status: "idle", message: null }, unread: false, prUrl: null, prState: null } as const;
const pr = "https://github.com/me/openorc/pull/482";

describe("pullRequestNumber", () => {
  it("reads the number from a pull request's address only", () => {
    expect(pullRequestNumber("https://github.com/acme/app/pull/3")).toBe(3);
    expect(pullRequestNumber("https://github.com/acme/app/pull/42#pullrequestreview-9")).toBe(42);
    expect(pullRequestNumber("https://github.com/acme/app/pull/42/files")).toBe(42);
    expect(pullRequestNumber("https://github.com/acme/app/issues/3")).toBeNull();
    expect(pullRequestNumber("https://github.com/acme/app/pull/3x")).toBeNull();
    expect(pullRequestNumber(null)).toBeNull();
  });
});

describe("threadMark", () => {
  it("ranks live activity over session health, health over unread, unread over commands left running, and those over a pull request", () => {
    const failed = { status: "error", message: "exit 1" } as const;
    expect(threadMark({ ...resting, activity: "waiting", session: failed, unread: true })).toEqual({ kind: "waiting", label: "Needs you" });
    expect(threadMark({ ...resting, activity: "running", session: failed })).toEqual({ kind: "running", label: "Working" });
    expect(threadMark({ ...resting, session: failed, unread: true })).toEqual({ kind: "failed", label: "Failed: exit 1" });
    expect(threadMark({ ...resting, session: { status: "lost", message: null } })).toEqual({ kind: "failed", label: "Session lost" });
    expect(threadMark({ ...resting, unread: true, prUrl: pr })).toEqual({ kind: "unread", label: "Unread" });
    const server = { id: "b1", description: "pnpm dev" };
    expect(threadMark({ ...resting, unread: true, backgroundCommands: [server] })).toEqual({ kind: "unread", label: "Unread" });
    expect(threadMark({ ...resting, activity: "running", backgroundCommands: [server] })).toEqual({ kind: "running", label: "Working" });
    expect(threadMark({ ...resting, prUrl: pr, backgroundCommands: [server] })).toEqual({ kind: "background", label: "A background command is running" });
    expect(threadMark({ ...resting, backgroundCommands: [server, { id: "b2", description: "Metro" }] })).toEqual({ kind: "background", label: "2 background commands are running" });
    expect(threadMark({ ...resting, backgroundCommands: [] })).toBeNull();
    expect(threadMark({ ...resting, prUrl: pr, prState: "merged" })).toEqual({ kind: "pull", label: "Pull request #482, merged", state: "merged" });
    expect(threadMark({ ...resting, prUrl: pr })).toEqual({ kind: "pull", label: "Pull request #482, open", state: "open" });
    expect(threadMark(resting)).toBeNull();
  });
});

describe("threadTreeStatus", () => {
  it("shows what sub threads do over a resting or merely unread parent, and keeps the parent's own live state and failure", () => {
    const working = { kind: "running", label: "2 subthreads are working" } as const;
    const asking = { kind: "waiting", label: "A subthread needs you" } as const;
    const server = { id: "b1", description: "pnpm dev" };
    expect(threadTreeStatus(threadStatus(resting), working)).toBe(working);
    expect(threadTreeStatus(threadStatus({ ...resting, unread: true }), working)).toBe(working);
    expect(threadTreeStatus(threadStatus({ ...resting, backgroundCommands: [server] }), working)).toBe(working);
    expect(threadTreeStatus(threadStatus({ ...resting, activity: "running" }), working)).toEqual({ kind: "running", label: "Working" });
    expect(threadTreeStatus(threadStatus({ ...resting, activity: "running" }), asking)).toBe(asking);
    expect(threadTreeStatus(threadStatus({ ...resting, session: { status: "error", message: null } }), working)).toEqual({ kind: "failed", label: "Failed" });
    expect(threadTreeStatus(threadStatus({ ...resting, unread: true }), null)).toEqual({ kind: "unread", label: "Unread" });
    expect(threadTreeStatus(null, null)).toBeNull();
  });
});

describe("threadPlace", () => {
  it("names the branch, else the pull request, else the folder", () => {
    expect(threadPlace({ branch: "feat/x", prUrl: pr, projectId: "p" })).toEqual({ kind: "branch", label: "feat/x" });
    expect(threadPlace({ branch: null, prUrl: pr, projectId: "p" })).toEqual({ kind: "pull", label: "PR #482" });
    expect(threadPlace({ branch: null, prUrl: null, projectId: WORKSPACE_ID })).toEqual({ kind: "folder", label: "Local" });
    expect(threadPlace({ branch: null, prUrl: null, projectId: "p" })).toEqual({ kind: "folder", label: "No branch" });
  });
});

describe("workspaceLabel", () => {
  const checkout = { workspaceMode: "current", branch: "main", prUrl: null } as const;
  const cloud = { provider: "vercel", state: "ready", step: null, setup: false, error: null } as const;

  it("names the cloud, else a worktree of its own, else the checkout's branch", () => {
    expect(workspaceLabel(checkout)).toBe("main");
    expect(workspaceLabel({ ...checkout, branch: null })).toBeNull();
    expect(workspaceLabel({ ...checkout, workspaceMode: "worktree", branch: "openorc/sidebar-a1b2c3" })).toBe("worktree");
    expect(workspaceLabel({ ...checkout, workspaceMode: "worktree", cloud })).toBe("cloud");
    expect(workspaceLabel({ ...checkout, owner: { brain: "cloud", reach: "asleep", heardAt: 1 } })).toBe("cloud");
    expect(workspaceLabel({ ...checkout, owner: { brain: "mac", reach: "live", heardAt: 1 } })).toBe("main");
  });

  it("leaves a pull request to say where the work is, except that the next turn runs in the cloud", () => {
    expect(workspaceLabel({ ...checkout, prUrl: pr })).toBeNull();
    expect(workspaceLabel({ ...checkout, workspaceMode: "worktree", prUrl: pr })).toBeNull();
    expect(workspaceLabel({ ...checkout, workspaceMode: "worktree", prUrl: pr, cloud })).toBe("cloud");
  });
});

describe("renamedTitle", () => {
  it("saves the trimmed title, and nothing when it is empty or unchanged", () => {
    expect(renamedTitle("Pairing", "  Pairing review ")).toBe("Pairing review");
    expect(renamedTitle("Pairing", "   ")).toBeNull();
    expect(renamedTitle("Pairing", " Pairing ")).toBeNull();
  });
});
