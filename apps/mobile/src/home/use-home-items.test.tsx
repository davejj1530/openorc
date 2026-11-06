// @vitest-environment jsdom
import { NEEDS_YOU_PAGE, THREAD_PAGE } from "@openorc/client";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { FakeMac } from "../test-fixtures/fake-mac";
import type { HomeItem } from "./home-items";
import { fixtureThreads } from "./test-fixtures/threads";
import { useHomeItems } from "./use-home-items";
import { useChildThreadPages } from "@openorc/client";

/** A Mac with only Workspace, whose pages of threads arrive when the test sends them, by how many each asked for. */
const mac = vi.hoisted(() => ({ phone: null as FakeMac | null, pages: new Map<number, (threads: ThreadSummary[]) => void>(), failing: false, waiting: [] as ThreadSummary[] }));

vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method, params) => {
    if (method === "projects.list") return Promise.resolve([]);
    if (method === "inbox.list") return Promise.resolve({ items: mac.waiting.map((thread) => ({ kind: "thread", thread })) });
    if (method === "threads.get") return Promise.resolve(mac.waiting.find((thread) => thread.id === (params as { id: string }).id) ?? null);
    if (mac.failing) return Promise.reject(new Error("The phone is not connected to its Mac."));
    return new Promise((resolve) => mac.pages.set((params as { limit: number }).limit, resolve as (threads: ThreadSummary[]) => void));
  });
  return mac.phone.module;
});

it("keeps the shown children during a parent page fetch, then shows the new page and count", async () => {
  const parent = { ...threads[0]!, id: "parent", hiddenChildren: 15 };
  const children = Array.from({ length: 20 }, (_, i): ThreadSummary => ({
    ...parent,
    id: `child-${i}`,
    parentThreadId: parent.id,
    parentRelation: "subagent",
    hiddenChildren: 0,
    createdAt: i,
    activity: i === 19 ? "running" : "idle",
  }));
  const home = renderHook(() => useHomeItems(true), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(mac.pages.has(THREAD_PAGE + 1)).toBe(true));
  await act(async () => mac.pages.get(THREAD_PAGE + 1)!([parent, ...children.slice(15)]));
  await waitFor(() => expect(outline(home.result.current.items)).toContain("children-more"));
  const first = outline(home.result.current.items);
  act(() => home.result.current.showMoreChildren(WORKSPACE_ID, "parent"));
  expect(outline(home.result.current.items)).toEqual(first);
  await waitFor(() =>
    expect(
      mac
        .phone!.module.queryClient.getQueryCache()
        .findAll({ queryKey: ["threads.list"] })
        .some((query) => (query.queryKey[1] as { childLimits?: Record<string, number> }).childLimits?.["parent"] === 17),
    ).toBe(true),
  );
  await act(async () => mac.pages.get(THREAD_PAGE + 1)!([{ ...parent, hiddenChildren: 3 }, ...children.slice(3)]));
  await waitFor(() => expect(home.result.current.items.filter((item) => item.kind === "thread")).toHaveLength(18));
  expect(home.result.current.items.find((item) => item.kind === "children-more")).toMatchObject({ count: 3 });
});

it("keeps parent page sizes in session memory only and isolates projects", () => {
  const state = renderHook(useChildThreadPages);
  act(() => state.result.current.showMore("p", "parent"));
  expect(state.result.current.params("p")).toEqual({ childLimits: { parent: 17 } });
  expect(state.result.current.params("other")).toEqual({});
  act(() => state.result.current.showMore("p", "parent"));
  expect(state.result.current.limits).toEqual({ parent: 29 });
  state.unmount();
  expect(renderHook(useChildThreadPages).result.current.limits).toEqual({});
});

afterEach(() => {
  cleanup();
  mac.failing = false;
  mac.waiting = [];
  mac.pages.clear();
  mac.phone!.module.queryClient.clear();
});

/** Today's threads, so they list under Today, which starts open. */
const threads: ThreadSummary[] = Array.from({ length: THREAD_PAGE + 4 }, (_, index) => ({ ...fixtureThreads[0]!, id: `w-${index}`, lastActivityAt: Date.now() - (index + 1) * 1000 }));
const outline = (items: HomeItem[]) => items.map((item) => (item.kind === "thread" ? item.thread.id : item.kind));
/** The Mac answers the read behind a page of `limit` threads, which asks for one more. */
const answer = (limit: number) => act(async () => mac.pages.get(limit + 1)!(threads.slice(0, limit + 1)));

it("reads just the waiting thread outside the page and shows a started child whose parent is absent", async () => {
  mac.waiting = [{ ...threads[0]!, id: "waiting-child", activity: "waiting", parentRelation: "started", parentThreadId: "archived-parent" }];
  const home = renderHook(() => useHomeItems(true), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(outline(home.result.current.items)).toContain("waiting-child"));
  expect(mac.phone!.module.queryClient.getQueryData(["threads.get", { id: "waiting-child" }])).toMatchObject({ id: "waiting-child" });
  expect(
    mac
      .phone!.module.queryClient.getQueryCache()
      .findAll({ queryKey: ["threads.list"] })
      .some((query) => (query.queryKey[1] as { selectedId?: string }).selectedId),
  ).toBe(false);
});

it("reads the next page by itself while today is unfinished, keeping its rows meanwhile, then adds the page", async () => {
  const home = renderHook(() => useHomeItems(true), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(mac.pages.has(THREAD_PAGE + 1)).toBe(true));
  await answer(THREAD_PAGE);
  const first = ["section", ...threads.slice(0, THREAD_PAGE).map((thread) => thread.id), "section"];
  await waitFor(() => expect(mac.pages.has(THREAD_PAGE * 2 + 1)).toBe(true));
  expect(outline(home.result.current.items)).toEqual(first);
  await answer(THREAD_PAGE * 2);
  await waitFor(() => expect(outline(home.result.current.items)).toEqual(["section", ...threads.map((thread) => thread.id), "section"]));
});

it("shows a thread that needs you from past the loaded pages in its folded day, and nothing else of that day", async () => {
  const days = (count: number) => Date.now() - count * 86_400_000;
  const yesterday = Array.from({ length: THREAD_PAGE + 1 }, (_, index): ThreadSummary => ({ ...threads[0]!, id: `yesterday-${index}`, lastActivityAt: days(1) - index }));
  const unread = { ...threads[0]!, id: "unread-past-page", unread: true, lastActivityAt: days(1) - 1000 };
  const home = renderHook(() => useHomeItems(true), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(mac.pages.has(THREAD_PAGE + 1) && mac.pages.has(NEEDS_YOU_PAGE)).toBe(true));
  await act(async () => mac.pages.get(THREAD_PAGE + 1)!(yesterday));
  await act(async () => mac.pages.get(NEEDS_YOU_PAGE)!([unread]));
  // Yesterday folded with the unread thread, then Resolved.
  await waitFor(() => expect(outline(home.result.current.items)).toEqual(["section", "unread-past-page", "section"]));
  expect(mac.pages.has(THREAD_PAGE * 2 + 1)).toBe(false);
});

it("asks again for a list that failed while connected, and leaves a failure while not connected to the header", async () => {
  mac.failing = true;
  const offline = renderHook(() => useHomeItems(false), { wrapper: mac.phone!.wrapper });
  await waitFor(
    () =>
      expect(
        mac
          .phone!.module.queryClient.getQueryCache()
          .findAll({ queryKey: ["threads.list"] })
          .some((query) => query.state.status === "error"),
      ).toBe(true),
    { timeout: 3_000 },
  );
  expect(outline(offline.result.current.items)).toEqual([]);
  offline.unmount();
  const online = renderHook(() => useHomeItems(true), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(outline(online.result.current.items)).toEqual(["retry"]), { timeout: 3_000 });
});

it("prunes only deleted thread folds after checking the Mac, leaving off-page and day folds", async () => {
  const { toggleFold, savedFolds } = await import("./folds");
  mac.waiting = [{ ...threads[0]!, id: "kept" }];
  toggleFold("thread-open:deleted");
  toggleFold("thread-closed:kept");
  toggleFold("day-open:yesterday");
  renderHook(() => useHomeItems(true), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(savedFolds()).not.toContain("thread-open:deleted"));
  expect(savedFolds()).toContain("thread-closed:kept");
  expect(savedFolds()).toContain("day-open:yesterday");
});
