import { WORKSPACE_ID } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { threadMark, threadPlace } from "./thread-row-model";

const resting = { activity: "idle", session: { status: "idle", message: null }, unread: false, prUrl: null, prState: null } as const;
const pr = "https://github.com/me/openorc/pull/482";

describe("threadMark", () => {
  it("ranks live activity over session health, health over unread, and unread over a pull request", () => {
    const failed = { status: "error", message: "exit 1" } as const;
    expect(threadMark({ ...resting, activity: "waiting", session: failed, unread: true })?.kind).toBe("waiting");
    expect(threadMark({ ...resting, activity: "running", session: failed })?.kind).toBe("running");
    expect(threadMark({ ...resting, session: failed, unread: true })).toEqual({ kind: "failed", label: "Failed: exit 1" });
    expect(threadMark({ ...resting, session: { status: "lost", message: null } })).toEqual({ kind: "failed", label: "Session lost" });
    expect(threadMark({ ...resting, unread: true, prUrl: pr })?.kind).toBe("unread");
    expect(threadMark({ ...resting, prUrl: pr, prState: "merged" })).toEqual({ kind: "pull", label: "Pull request #482, merged", state: "merged" });
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
