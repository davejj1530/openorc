import { describe, expect, it } from "vitest";
import type { ThreadSummary } from "@openorc/protocol";
import { arrivalGroups } from "./arrival-groups";

const thread = (id: string, activity: ThreadSummary["activity"], lastActivityAt: number) => ({ id, title: id, activity, lastActivityAt }) as unknown as ThreadSummary;

describe("arrivalGroups", () => {
  it("orders recent by last activity, newest first", () => {
    const groups = arrivalGroups([thread("old", "idle", 1), thread("new", "idle", 9), thread("mid", "idle", 5)], [], null);
    expect(groups.recent.map((t) => t.id)).toEqual(["new", "mid", "old"]);
  });

  it("caps waiting and running at three", () => {
    const many = ["1", "2", "3", "4"].map((id) => thread(id, "waiting", 1));
    expect(arrivalGroups(many, [], null).waiting).toHaveLength(3);
  });

  it("counts only open task statuses and scopes them to the project", () => {
    const tasks = [
      { projectId: "p", status: "backlog" as const },
      { projectId: "p", status: "backlog" as const },
      { projectId: "p", status: "review" as const },
      { projectId: "p", status: "done" as const },
      { projectId: "other", status: "backlog" as const },
    ];
    expect(arrivalGroups([], tasks, "p").tasks).toEqual([
      { status: "backlog", count: 2 },
      { status: "review", count: 1 },
    ]);
  });
});
