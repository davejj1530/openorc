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
const mac = vi.hoisted(() => ({ phone: null as FakeMac | null, pages: new Map<number, (threads: ThreadSummary[]) => void>(), failing: false }));

vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method, params) => {
    if (method === "projects.list") return Promise.resolve([]);
    if (mac.failing) return Promise.reject(new Error("The phone is not connected to its Mac."));
    return new Promise((resolve) => mac.pages.set((params as { limit: number }).limit, resolve as (threads: ThreadSummary[]) => void));
  });
  return mac.phone.module;
});

afterEach(() => {
  cleanup();
  mac.failing = false;
  mac.phone!.module.queryClient.clear();
});

const threads: ThreadSummary[] = Array.from({ length: THREAD_PAGE + 4 }, (_, index) => ({ ...fixtureThreads[0]!, id: `w-${index}`, lastActivityAt: fixtureThreads[0]!.lastActivityAt - index }));
const outline = (items: HomeItem[]) => items.map((item) => (item.kind === "thread" ? item.thread.id : item.kind));
/** The Mac answers the read behind a page of `limit` threads, which asks for one more. */
const answer = (limit: number) => act(async () => mac.pages.get(limit + 1)!(threads.slice(0, limit + 1)));

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
