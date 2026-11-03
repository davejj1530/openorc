// @vitest-environment jsdom
import { THREAD_PAGE } from "@openorc/client";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { FakeMac } from "../test-fixtures/fake-mac";
import type { HomeItem } from "./home-items";
import { fixtureThreads } from "./test-fixtures/threads";
import { useHomeItems } from "./use-home-items";

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

afterEach(() => {
  cleanup();
  mac.failing = false;
  mac.waiting = [];
  mac.phone!.module.queryClient.clear();
});

const threads: ThreadSummary[] = Array.from({ length: THREAD_PAGE + 4 }, (_, index) => ({ ...fixtureThreads[0]!, id: `w-${index}`, lastActivityAt: fixtureThreads[0]!.lastActivityAt - index }));
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

it("keeps a project's rows while Show more's next page loads, then adds the page", async () => {
  const home = renderHook(() => useHomeItems(true), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(mac.pages.has(THREAD_PAGE + 1)).toBe(true));
  await answer(THREAD_PAGE);
  const first = ["heading", ...threads.slice(0, THREAD_PAGE).map((thread) => thread.id), "more"];
  await waitFor(() => expect(outline(home.result.current.items)).toEqual(first));

  act(() => home.result.current.showMore(WORKSPACE_ID));
  expect(outline(home.result.current.items)).toEqual(first);

  await waitFor(() => expect(mac.pages.has(THREAD_PAGE * 2 + 1)).toBe(true));
  await answer(THREAD_PAGE * 2);
  await waitFor(() => expect(outline(home.result.current.items)).toEqual(["heading", ...threads.map((thread) => thread.id)]));
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
  expect(outline(offline.result.current.items)).toEqual(["heading"]);
  offline.unmount();
  const online = renderHook(() => useHomeItems(true), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(outline(online.result.current.items)).toEqual(["heading", "retry"]), { timeout: 3_000 });
});

it("prunes only deleted thread folds after checking the Mac, leaving off-page and project folds", async () => {
  const { toggleFold, savedFolds } = await import("./folds");
  mac.waiting = [{ ...threads[0]!, id: "kept" }];
  toggleFold("thread-open:deleted");
  toggleFold("thread-closed:kept");
  toggleFold("project:other");
  renderHook(() => useHomeItems(true), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(savedFolds()).not.toContain("thread-open:deleted"));
  expect(savedFolds()).toContain("thread-closed:kept");
  expect(savedFolds()).toContain("project:other");
});
