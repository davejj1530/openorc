import { expect, it } from "vitest";
import { mergeThreadPages, type ThreadSummary } from "@openorc/protocol";
import { subthreadStatuses, threadBranchPath, threadPageBranchPath, threadTreeRows } from "./thread-tree.js";
import { sidebarThreadPage, visibleSidebarThreadIds } from "./sidebar-thread-groups.js";

const parent = { id: "parent", projectId: "project", title: "Parent", createdAt: 0, lastActivityAt: 0, activity: "idle", parentThreadId: null, archivedAt: null } as ThreadSummary;
const children = (owner: ThreadSummary, count: number) =>
  Array.from({ length: count }, (_, i): ThreadSummary => ({ ...owner, id: `${owner.id}-${i}`, parentThreadId: owner.id, parentRelation: "subagent", createdAt: i, lastActivityAt: 100 - i }));
const ids = (rows: ReturnType<typeof threadTreeRows>) => rows.map((row) => row.thread.id);

it("orders children by start time at every depth, breaks ties by id and ignores activity changes", () => {
  const siblings = children(parent, 3);
  const nested = children(siblings[2]!, 3);
  const tied = { ...siblings[2]!, id: "z" };
  const all = [parent, ...siblings, ...nested, tied];
  const open = all.map((thread) => `thread-open:${thread.id}`);
  const expected = ["parent", "parent-2", "parent-2-2", "parent-2-1", "parent-2-0", "z", "parent-1", "parent-0"];
  expect(ids(threadTreeRows([parent], all, open))).toEqual(expected);
  expect(
    ids(
      threadTreeRows(
        [parent],
        all.map((thread) => ({ ...thread, lastActivityAt: -thread.lastActivityAt })),
        open,
      ),
    ),
  ).toEqual(expected);
});

it("lists the threads you can talk to before the agent's subagents, and marks where the subagents begin", () => {
  const [older, newer] = children(parent, 2);
  const mine = (id: string, createdAt: number): ThreadSummary => ({ ...parent, id, parentThreadId: parent.id, parentRelation: "started", createdAt });
  const all = [parent, newer!, mine("mine-old", -5), older!, mine("mine-new", 50)];
  const rows = threadTreeRows([parent], all, ["thread-open:parent"]);
  expect(ids(rows)).toEqual(["parent", "mine-new", "mine-old", "parent-1", "parent-0"]);
  expect(rows.filter((row) => row.subagentsStart).map((row) => row.thread.id)).toEqual(["parent-1"]);
  expect(threadTreeRows([parent], [parent, older!, newer!], ["thread-open:parent"]).some((row) => row.subagentsStart)).toBe(false);
});

it("pages five children per parent, adds twelve at a time, and ends the branch at the last visible child", () => {
  const all = [parent, ...children(parent, 20)];
  const first = threadTreeRows([parent], all, ["thread-open:parent"]);
  expect(ids(first)).toEqual(["parent", "parent-19", "parent-18", "parent-17", "parent-16", "parent-15"]);
  expect(first[0]?.hiddenChildren).toBe(15);
  expect(first.at(-1)?.last).toBe(true);
  expect(threadBranchPath(first.at(-1)!, { markX: 34, mid: 17, height: 34 })).toBe("M34 0V11q0 6 6 6h6");
  expect(threadPageBranchPath(first[0]!, { markX: 34, height: 34 })).toBe("");
  const second = threadTreeRows([parent], all, ["thread-open:parent"], [], { parent: 17 });
  expect(second).toHaveLength(18);
  expect(second[0]?.hiddenChildren).toBe(3);
  expect(threadTreeRows([parent], all, ["thread-open:parent"], [], { parent: 29 })[0]?.hiddenChildren).toBe(0);
  expect(ids(threadTreeRows([parent], all, ["thread-closed:parent"]))).toEqual(["parent"]);
});

it.each(["selected", "search", "running", "waiting"] as const)("keeps an older %s grandchild and its ancestors beyond both pages", (exception) => {
  const siblings = children(parent, 8);
  const nested = children(siblings[0]!, 8);
  const target = nested[0]!;
  if (exception === "running" || exception === "waiting") target.activity = exception;
  const reveal = exception === "selected" || exception === "search" ? [target.id] : [];
  const rows = threadTreeRows([parent], [parent, ...siblings, ...nested], [], reveal);
  expect(ids(rows)).toEqual(["parent", "parent-7", "parent-6", "parent-5", "parent-4", "parent-3", "parent-0", "parent-0-7", "parent-0-6", "parent-0-5", "parent-0-4", "parent-0-3", "parent-0-0"]);
  expect(rows[0]?.hiddenChildren).toBe(2);
  expect(rows.find((row) => row.thread.id === "parent-0")?.hiddenChildren).toBe(2);
});

it("adds server-hidden counts to cached children outside the local page and keeps root activity stable", () => {
  const root = { ...parent, hiddenChildren: 90, treeActivityAt: 999 };
  const all = [root, ...children(root, 10), { ...parent, id: "other", lastActivityAt: 500 }];
  const page = sidebarThreadPage({ projectId: "project", fetched: all, selected: null, filter: "active", limit: 12, now: 1_000 });
  expect(page.rest.map((row) => row.id)).toEqual(["parent", "other"]);
  expect(page.list).toHaveLength(12);
  expect(threadTreeRows(page.rest, page.list, ["thread-open:parent"])[0]?.hiddenChildren).toBe(95);
  const sections = [{ id: "project", ...page }];
  expect(visibleSidebarThreadIds(sections, ["thread-open:parent"])).toEqual(["parent", "parent-9", "parent-8", "parent-7", "parent-6", "parent-5", "other"]);
  expect(visibleSidebarThreadIds(sections, ["thread-open:parent"], null, ["parent-0"])).toContain("parent-0");
  expect(visibleSidebarThreadIds(sections, ["thread-open:parent"], null, [], { parent: 17 })).toHaveLength(12);
});

it("continues ancestor trunks across a nested paging row without drawing the finished child trunk", () => {
  const root = threadTreeRows([parent], [parent], [])[0]!;
  expect(threadPageBranchPath({ ...root, depth: 2, last: false, continuing: [1] }, { markX: 34, height: 34 })).toBe("M34 0V34 M54 0V34");
  expect(threadPageBranchPath({ ...root, depth: 2, last: true, continuing: [1] }, { markX: 34, height: 34 })).toBe("M34 0V34");
  const empty = { ...parent, hiddenChildren: 5 };
  const row = threadTreeRows([empty], [empty], ["thread-open:parent"])[0]!;
  expect(row.hasChildren).toBe(true);
  expect(threadBranchPath(row, { markX: 34, mid: 17, height: 34 })).toBe("");
});

it("preserves hidden-child activity when merging Mac and cloud root pages", () => {
  const merged = mergeThreadPages(
    [
      { brain: "mac", reach: "live", heardAt: 1, rows: [{ ...parent, treeActivityAt: 999, pinnedAt: null }] },
      { brain: "cloud", reach: "live", heardAt: 1, rows: [{ ...parent, id: "cloud", lastActivityAt: 500, pinnedAt: null }] },
    ],
    { includeChildren: true, limit: 1 },
    "mac",
  );
  expect(merged.map((row) => row.id)).toEqual(["parent"]);
});

it("tells every ancestor how many sub threads below it work or need you, and leaves resting trees and the threads themselves out", () => {
  const [mine, helper] = children(parent, 2);
  const nested = children(mine!, 2);
  const running = (thread: ThreadSummary): ThreadSummary => ({ ...thread, activity: "running" });
  const quiet = [parent, mine!, helper!, ...nested, { ...parent, id: "other", activity: "running" } as ThreadSummary];
  expect(subthreadStatuses(quiet).size).toBe(0);

  const busy = subthreadStatuses([parent, running(mine!), running(helper!), running(nested[0]!), nested[1]!]);
  expect(busy.get("parent")).toEqual({ kind: "running", label: "3 subthreads are working" });
  expect(busy.get("parent-0")).toEqual({ kind: "running", label: "A subthread is working" });
  expect(busy.has("parent-1")).toBe(false);
  expect(busy.has("parent-0-0")).toBe(false);

  const asking = subthreadStatuses([parent, running(mine!), { ...nested[0]!, activity: "waiting" }]);
  expect(asking.get("parent")).toEqual({ kind: "waiting", label: "A subthread needs you" });
  expect(asking.get("parent-0")).toEqual({ kind: "waiting", label: "A subthread needs you" });
});

it("stops climbing at a parent cycle or a parent the list never read", () => {
  const a = { ...parent, id: "a", parentThreadId: "b", activity: "running" } as ThreadSummary;
  const b = { ...parent, id: "b", parentThreadId: "a" } as ThreadSummary;
  const orphan = { ...parent, id: "orphan", parentThreadId: "gone", activity: "running" } as ThreadSummary;
  const statuses = subthreadStatuses([a, b, orphan]);
  expect([...statuses.keys()]).toEqual(["b"]);
});
