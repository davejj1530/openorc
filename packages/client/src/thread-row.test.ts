import { WORKSPACE_ID } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { pullRequestNumber, threadMark, threadPlace } from "./thread-row.js";

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
  it("ranks live activity over session health, health over unread, and unread over a pull request", () => {
    const failed = { status: "error", message: "exit 1" } as const;
    expect(threadMark({ ...resting, activity: "waiting", session: failed, unread: true })).toEqual({ kind: "waiting", label: "Needs you" });
    expect(threadMark({ ...resting, activity: "running", session: failed })).toEqual({ kind: "running", label: "Working" });
    expect(threadMark({ ...resting, session: failed, unread: true })).toEqual({ kind: "failed", label: "Failed: exit 1" });
    expect(threadMark({ ...resting, session: { status: "lost", message: null } })).toEqual({ kind: "failed", label: "Session lost" });
    expect(threadMark({ ...resting, unread: true, prUrl: pr })).toEqual({ kind: "unread", label: "Unread" });
    expect(threadMark({ ...resting, prUrl: pr, prState: "merged" })).toEqual({ kind: "pull", label: "Pull request #482, merged", state: "merged" });
    expect(threadMark({ ...resting, prUrl: pr })).toEqual({ kind: "pull", label: "Pull request #482, open", state: "open" });
    expect(threadMark(resting)).toBeNull();
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
