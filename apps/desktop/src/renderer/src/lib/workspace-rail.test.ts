import { describe, expect, it } from "vitest";
import type { ThreadSummary } from "@openorc/protocol";
import { threadStatus } from "@openorc/client";
import { markThread, workspaceMarks, workspaceSummary } from "./workspace-rail";

const now = Date.now();
const thread = (id: string, projectId: string, patch: Partial<ThreadSummary> = {}) =>
  ({
    id,
    projectId,
    title: id,
    agent: "codex",
    activity: "idle",
    unread: false,
    session: { status: "idle", message: null },
    pinnedAt: null,
    snoozedUntil: null,
    archivedAt: null,
    parentThreadId: null,
    parentRelation: null,
    lastActivityAt: now,
    ...patch,
  }) as ThreadSummary;

describe("workspaceMarks", () => {
  it("shows a project's most pressing state: needs you, then a failure, then work, then a result waiting", () => {
    const marks = workspaceMarks(
      [
        thread("a1", "a", { unread: true }),
        thread("a2", "a", { activity: "running" }),
        thread("a3", "a", { session: { status: "lost", message: null } }),
        thread("a4", "a", { activity: "waiting" }),
        thread("b1", "b", { unread: true }),
        thread("b2", "b", { activity: "running" }),
        thread("c1", "c", { unread: true }),
        thread("c2", "c", { backgroundCommands: [{ id: "dev", description: "pnpm dev" }] }),
        thread("d1", "d"),
        thread("e1", "e", { backgroundCommands: [{ id: "dev", description: "pnpm dev" }] }),
      ],
      now,
    );
    expect(marks.get("a")).toEqual({ kind: "waiting", counts: { unread: 1, running: 1, failed: 1, waiting: 1 } });
    expect(marks.get("b")?.kind).toBe("running");
    expect(marks.get("c")).toEqual({ kind: "unread", counts: { unread: 1, background: 1 } });
    expect(marks.has("d")).toBe(false);
    expect(marks.get("e")?.kind).toBe("background");
  });

  it("counts sub threads in their tree, and leaves out resolved trees, hidden threads and a subagent's unread result", () => {
    const old = now - 5 * 86_400_000;
    const marks = workspaceMarks(
      [
        thread("parent", "a"),
        thread("child", "a", { parentThreadId: "parent", parentRelation: "started", activity: "waiting" }),
        thread("helper", "a", { parentThreadId: "parent", parentRelation: "subagent", unread: true }),
        thread("old", "b", { unread: true, lastActivityAt: old }),
        thread("put-away", "b", { unread: true, archivedAt: now }),
        thread("home", "c", { unread: true }),
      ],
      now,
      new Set(["home"]),
    );
    expect(marks.get("a")).toEqual({ kind: "waiting", counts: { waiting: 1 } });
    expect(marks.has("b")).toBe(false);
    expect(marks.has("c")).toBe(false);
  });

  it("reads nothing into a list that has not arrived", () => {
    expect(workspaceMarks(undefined, now).size).toBe(0);
  });
});

describe("workspaceSummary", () => {
  it("says how many of each, most pressing first, leaving out what has none", () => {
    expect(workspaceSummary({ kind: "waiting", counts: { unread: 2, waiting: 1 } })).toBe("1 needs you · 2 unread");
    expect(workspaceSummary({ kind: "failed", counts: { running: 3, failed: 1 } })).toBe("1 failed · 3 working");
    expect(workspaceSummary({ kind: "unread", counts: { background: 2, unread: 1 } })).toBe("1 unread · 2 with commands running");
    expect(workspaceSummary(undefined)).toBe("");
  });
});

it("stands in a thread whose status is the mark's own", () => {
  expect(markThread("waiting")).toMatchObject({ activity: "waiting", unread: false });
  expect(markThread("failed")).toMatchObject({ activity: "idle", session: { status: "error" } });
  expect(markThread("unread")).toMatchObject({ activity: "idle", unread: true });
  for (const kind of ["waiting", "failed", "running", "unread", "background"] as const) expect(threadStatus(markThread(kind))?.kind).toBe(kind);
});
