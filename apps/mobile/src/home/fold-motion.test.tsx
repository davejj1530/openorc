// @vitest-environment jsdom
import { threadTreeRows } from "@openorc/client";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HomeItem } from "./home-items";
import { foldMotions, useFoldMotion } from "./fold-motion";
import { fixtureThreads } from "./test-fixtures/threads";

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("../ui/reduced-motion", () => ({ useReducedMotion: () => motion.reduced }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  motion.reduced = false;
});

const base = fixtureThreads.find((thread) => thread.id === "t-pairing")!;
const parent = { ...base, id: "parent" };
const child = (id: string, of = "parent") => ({
  ...base,
  id,
  parentThreadId: of,
  parentRelation: "subagent" as const,
  subagent: { status: "completed" as const, agentType: "Explore", toolCallId: null, startedAt: 1, endedAt: 2, stoppable: false },
});
const family = [parent, child("a"), child("b"), child("a1", "a"), { ...base, id: "sibling" }];
const rows = threadTreeRows([parent, family[4]!], family, ["thread-open:parent", "thread-open:a"]);
const thread = (tree: (typeof rows)[number]): HomeItem => ({ kind: "thread", key: tree.thread.id, thread: tree.thread, tree, project: null, arriving: false });
// As Home lists them: the parent's children with the grandchild under its own parent, the parent's next page, the sibling root.
const items: HomeItem[] = [
  { kind: "heading", key: "project:openorc", group: "project", projectId: "openorc", title: "openorc", meta: null, open: true },
  ...rows.slice(0, 4).map(thread),
  { kind: "children-more", key: "children-more:parent", tree: rows[0]!, count: 2 },
  thread(rows[4]!),
  { kind: "heading", key: "project:website", group: "project", projectId: "website", title: "website", meta: null, open: true },
];
const order = items.map((item) => item.key);

it("fades a closing parent's whole tree, its next page included, and marks the parent so its chevron turns at once", () => {
  const motions = foldMotions(items, { key: "parent", open: false });
  expect(order).toEqual(["project:openorc", "parent", "a", "a1", "b", "children-more:parent", "sibling", "project:website"]);
  expect(motions.get("parent")).toEqual({ folding: true });
  expect(["a", "a1", "b", "children-more:parent"].map((key) => motions.get(key))).toEqual([{ leave: true }, { leave: true }, { leave: true }, { leave: true }]);
  expect(motions.has("sibling")).toBe(false);
  expect(motions.has("project:website")).toBe(false);
});

it("rises an opening fold's rows in one after another, and a heading holds its project up to the next heading", () => {
  const motions = foldMotions(items, { key: "project:openorc", open: true });
  expect(order.slice(1, 7).map((key) => motions.get(key)?.arrive)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(motions.has("project:openorc")).toBe(false);
  expect(motions.has("project:website")).toBe(false);
  expect(foldMotions(items, null).size).toBe(0);
});

it("opens at once, closes after its rows fade, and a second press before the fold keeps it open", () => {
  const commit = vi.fn();
  const { result } = renderHook(() => useFoldMotion(items, commit));
  act(() => result.current.toggle("parent", true));
  expect(commit).toHaveBeenCalledExactlyOnceWith("parent", true);
  commit.mockClear();
  act(() => result.current.toggle("a", false));
  expect(commit).not.toHaveBeenCalled();
  expect(result.current.motions.get("a")).toEqual({ folding: true });
  act(() => void vi.advanceTimersByTime(119));
  expect(commit).not.toHaveBeenCalled();
  act(() => void vi.advanceTimersByTime(1));
  expect(commit).toHaveBeenCalledExactlyOnceWith("a", false);
  commit.mockClear();
  act(() => result.current.toggle("parent", false));
  act(() => result.current.toggle("parent", true));
  act(() => void vi.advanceTimersByTime(1000));
  expect(commit).not.toHaveBeenCalled();
  expect(result.current.motions.size).toBe(0);
});

it("commits a pending close when another fold moves, and every fold at once under reduced motion", () => {
  const commit = vi.fn();
  const { result } = renderHook(() => useFoldMotion(items, commit));
  act(() => result.current.toggle("parent", false));
  act(() => result.current.toggle("project:website", false));
  expect(commit).toHaveBeenCalledExactlyOnceWith("parent", false);
  motion.reduced = true;
  const still = renderHook(() => useFoldMotion(items, commit));
  commit.mockClear();
  act(() => still.result.current.toggle("parent", false));
  expect(commit).toHaveBeenCalledExactlyOnceWith("parent", false);
});
