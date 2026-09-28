import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewComment, TeamReviewComment, TeamTaskAdmissionView, TeamTaskView } from "@openorc/protocol";
import { beginTeamTaskRequest, finishTeamTaskRequest, readTeamTaskRequest, retainedTeamComments, teamReviewCommentState, teamTaskAdmissionLabel } from "./team-task-actions";

const member = { key: "worker", name: "Worker", managerKey: "manager", responsibility: "Implement", settings: { agent: "codex" as const, model: "fixture", effort: "high", fastMode: false } };
const manager = { ...member, key: "manager", name: "Manager", managerKey: null };
const retained: TeamReviewComment = { id: "comment", taskId: "task", snapshotId: "snapshot", path: "src/app.ts", line: 7, side: "new", body: "Original review", sentInRunId: null, createdAt: 1 };
const comment: ReviewComment = { ...retained, threadId: null, startLine: null, startSide: null, lineText: null, sentMessageId: null };
const admission = (patch: Partial<TeamTaskAdmissionView> = {}): TeamTaskAdmissionView => ({
  id: "admission",
  requestKey: "key",
  kind: "review",
  createdAt: 2,
  state: "received",
  executionId: "execution",
  actorId: "actor",
  memberKey: "worker",
  role: "assignee",
  result: null,
  error: null,
  reviewBatch: { id: "batch", comments: [retained] },
  retry: { allowed: false, reason: null },
  ...patch,
});
const task = (admissions: TeamTaskAdmissionView[] = [admission()]): TeamTaskView => ({
  taskId: "task",
  threadId: "thread",
  teamName: "Team",
  members: [manager, member],
  policy: { requested: "trusted", effective: "trusted", pendingRestart: false, runs: [] },
  managerKey: "manager",
  memberKey: "worker",
  dependencyTaskIds: [],
  start: { allowed: false, reason: "Already accepted" },
  review: { allowed: true, reason: null },
  admissions,
  claimedCommentIds: ["comment"],
  assignments: [],
  working: false,
});

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("durable team task actions", () => {
  it("replays the exact saved selection after an uncertain response and reload, ignoring new comments", () => {
    const scope = { taskId: "task", kind: "review" as const };
    const input = ["one", "two"];
    const first = beginTeamTaskRequest(scope, input);
    input.push("added-later");
    expect(readTeamTaskRequest(scope)).toEqual(first);
    expect(beginTeamTaskRequest(scope, ["new-comment"])).toEqual(first);
    expect(first.kind === "review" && first.commentIds).toEqual(["one", "two"]);
    finishTeamTaskRequest(first);
    expect(readTeamTaskRequest(scope)).toBeNull();
    expect(beginTeamTaskRequest(scope, ["new-comment"]).requestKey).not.toBe(first.requestKey);
  });

  it("isolates start, review, task and admission retry identities and does not erase a newer request", () => {
    const first = beginTeamTaskRequest({ taskId: "task", kind: "start" });
    const review = beginTeamTaskRequest({ taskId: "task", kind: "review" }, ["one"]);
    const other = beginTeamTaskRequest({ taskId: "other", kind: "start" });
    const retry = beginTeamTaskRequest({ taskId: "task", kind: "retry", admissionId: "failed" });
    expect(new Set([first.requestKey, review.requestKey, other.requestKey, retry.requestKey]).size).toBe(4);
    finishTeamTaskRequest(first);
    const newer = beginTeamTaskRequest({ taskId: "task", kind: "start" });
    finishTeamTaskRequest(first);
    expect(readTeamTaskRequest({ taskId: "task", kind: "start" })).toEqual(newer);
    expect(readTeamTaskRequest({ taskId: "task", kind: "retry", admissionId: "failed" })).toEqual(retry);
  });

  it("refuses missing storage and corrupt envelopes instead of silently creating a second task request", () => {
    localStorage.setItem("openorc.draft.task.task.team.review", JSON.stringify({ kind: "start", taskId: "task", requestKey: "uncertain" }));
    expect(() => beginTeamTaskRequest({ taskId: "task", kind: "review" }, ["one"])).toThrow(/could not be restored/);
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    expect(() => beginTeamTaskRequest({ taskId: "different", kind: "start" })).toThrow(/Could not save/);
    expect(readTeamTaskRequest({ taskId: "different", kind: "start" })).toBeNull();
  });

  it("retains accepted comment text after edits/deletion and disables removal throughout pending and accepted states", () => {
    const view = task();
    expect(retainedTeamComments([{ ...comment, body: "Edited later" }], view)).toEqual([comment]);
    expect(retainedTeamComments([], view)).toEqual([comment]);
    expect(teamReviewCommentState("comment", view, null)).toMatchObject({ label: "Received by Worker", removeDisabled: true });
    const pending = beginTeamTaskRequest({ taskId: "task", kind: "review" }, ["pending"]);
    expect(teamReviewCommentState("pending", view, pending)).toMatchObject({ label: "Awaiting confirmation", removeDisabled: true });
    expect(teamReviewCommentState("new", view, pending)).toMatchObject({ label: "Not sent yet", removeDisabled: false });
  });

  it("distinguishes manager receipt and coordination from assignee receipt and actual work", () => {
    const members = task().members;
    expect(teamTaskAdmissionLabel(admission({ memberKey: "manager", role: "manager", state: "received" }), members)).toBe("Received by Manager · awaiting assignment");
    expect(teamTaskAdmissionLabel(admission({ memberKey: "manager", role: "manager", state: "running" }), members)).toBe("Manager is coordinating · awaiting assignment");
    expect(teamTaskAdmissionLabel(admission({ state: "queued" }), members)).toBe("Queued for Worker");
    expect(teamTaskAdmissionLabel(admission({ state: "received" }), members)).toBe("Received by Worker");
    expect(teamTaskAdmissionLabel(admission({ state: "running" }), members)).toBe("Worker is working");
    expect(teamTaskAdmissionLabel(admission({ state: "stopped" }), members)).toBe("Stopped");
  });
});
