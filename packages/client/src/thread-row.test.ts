import { WORKSPACE_ID } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { latestActivity, pullRequestNumber, renamedTitle, rowAge, rowPlace, rowStarter, threadMark, threadPlace, threadStatus, threadTreeStatus, workspaceLabel } from "./thread-row.js";

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
  const checkout = { workspaceMode: "current", branch: "main", prUrl: null, projectId: "p", workingDirectory: null } as const;
  const cloud = { provider: "vercel", state: "ready", step: null, setup: false, error: null } as const;

  it("names the cloud, else a worktree of its own, else the checkout's branch", () => {
    expect(workspaceLabel(checkout)).toBe("main");
    expect(workspaceLabel({ ...checkout, branch: null })).toBe("checkout");
    expect(workspaceLabel({ ...checkout, workspaceMode: "worktree", branch: "openorc/sidebar-a1b2c3" })).toBe("worktree");
    expect(workspaceLabel({ ...checkout, workspaceMode: "worktree", cloud })).toBe("cloud");
    expect(workspaceLabel({ ...checkout, owner: { brain: "cloud", reach: "asleep", heardAt: 1 } })).toBe("cloud");
    expect(workspaceLabel({ ...checkout, owner: { brain: "mac", reach: "live", heardAt: 1 } })).toBe("main");
  });

  it("names the folder of a thread in no project, and nothing when it has none", () => {
    const loose = { ...checkout, branch: null, projectId: WORKSPACE_ID };
    expect(workspaceLabel({ ...loose, workingDirectory: "/Users/me/notes" })).toBe("notes");
    expect(workspaceLabel({ ...loose, workingDirectory: "C:\\Users\\me\\notes\\" })).toBe("notes");
    expect(workspaceLabel({ ...loose, branch: "main", workingDirectory: "/Users/me/notes" })).toBe("main");
    expect(workspaceLabel(loose)).toBeNull();
  });

  it("leaves a pull request to say where the work is, except that the next turn runs in the cloud", () => {
    expect(workspaceLabel({ ...checkout, prUrl: pr })).toBeNull();
    expect(workspaceLabel({ ...checkout, workspaceMode: "worktree", prUrl: pr })).toBeNull();
    expect(workspaceLabel({ ...checkout, workspaceMode: "worktree", prUrl: pr, cloud })).toBe("cloud");
  });
});

describe("rowPlace", () => {
  const checkout = { workspaceMode: "current", branch: "main", projectId: "p", workingDirectory: null } as const;
  const worktree = { ...checkout, workspaceMode: "worktree", branch: "openorc/sidebar-a1b2c3" } as const;
  const cloud = { provider: "vercel", state: "ready", step: null, setup: false, error: null } as const;

  it("says nothing where the project's new threads start, and names the other local place", () => {
    expect(rowPlace(checkout, "current")).toBeNull();
    expect(rowPlace(worktree, "current")).toEqual({ kind: "worktree", word: "worktree" });
    expect(rowPlace(worktree, "worktree")).toBeNull();
    expect(rowPlace(checkout, "worktree")).toEqual({ kind: "branch", word: "main" });
    expect(rowPlace({ ...checkout, branch: null }, "worktree")).toEqual({ kind: "branch", word: "checkout" });
  });

  it("tells the person's own cloud from OpenOrc Cloud, and leaves a cloud-only project's rows to its label", () => {
    expect(rowPlace({ ...worktree, cloud }, "worktree")).toEqual({ kind: "cloud", label: "Your own cloud", word: null });
    expect(rowPlace({ ...checkout, owner: { brain: "cloud", reach: "asleep", heardAt: 1 } }, "current")).toEqual({ kind: "cloud", label: "Your own cloud", word: null });
    expect(rowPlace({ ...worktree, owner: { brain: "hosted", reach: "live", heardAt: 1 } }, "worktree")).toEqual({ kind: "cloud", label: "OpenOrc Cloud", word: "OpenOrc Cloud" });
    expect(rowPlace({ ...worktree, owner: { brain: "hosted", reach: "live", heardAt: 1, project: { name: "site" } } }, "current")).toBeNull();
  });

  it("names the folder of a thread in no project", () => {
    expect(rowPlace({ ...checkout, projectId: WORKSPACE_ID, workingDirectory: "/Users/me/notes" }, "current")).toEqual({ kind: "folder", word: "notes" });
    expect(rowPlace({ ...checkout, projectId: WORKSPACE_ID }, "worktree")).toBeNull();
  });
});

describe("rowAge", () => {
  it("says how long ago in the fewest letters", () => {
    const now = Date.UTC(2026, 10, 14);
    const ago = (ms: number) => rowAge(now - ms, now);
    expect([ago(0), ago(59_000), ago(12 * 60_000), ago(2 * 3_600_000), ago(3 * 86_400_000), ago(15 * 86_400_000), ago(65 * 86_400_000), ago(400 * 86_400_000)]).toEqual([
      "now",
      "now",
      "12m",
      "2h",
      "3d",
      "2w",
      "2mo",
      "1y",
    ]);
  });

  it("reads a thread's latest activity from its turns, its agent's events and its sub threads", () => {
    expect(latestActivity({ lastActivityAt: 10, treeActivityAt: undefined, lastAgentEventAt: null })).toBe(10);
    expect(latestActivity({ lastActivityAt: 10, treeActivityAt: 30, lastAgentEventAt: 20 })).toBe(30);
    expect(latestActivity({ lastActivityAt: 10, treeActivityAt: 5, lastAgentEventAt: 40 })).toBe(40);
  });
});

describe("rowStarter", () => {
  it("names a teammate by first name, and nobody on the person's own thread", () => {
    expect(rowStarter({ owner: { brain: "hosted", reach: "live", heardAt: 1, startedBy: { name: "Ana Lee", image: null } } })).toEqual({ name: "Ana Lee", first: "Ana", image: null });
    expect(rowStarter({ owner: { brain: "hosted", reach: "live", heardAt: 1 } })).toBeNull();
    expect(rowStarter({})).toBeNull();
  });
});

describe("renamedTitle", () => {
  it("saves the trimmed title, and nothing when it is empty or unchanged", () => {
    expect(renamedTitle("Pairing", "  Pairing review ")).toBe("Pairing review");
    expect(renamedTitle("Pairing", "   ")).toBeNull();
    expect(renamedTitle("Pairing", " Pairing ")).toBeNull();
  });
});
