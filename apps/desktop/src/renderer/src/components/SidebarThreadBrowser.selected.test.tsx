import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientPush } from "@openorc/client";
import { WORKSPACE_ID, type RpcParams, type ThreadSummary } from "@openorc/protocol";

vi.hoisted(() => Object.assign(window, { openorc: { platform: "darwin" } }));

const host = vi.hoisted(() => ({
  threads: [] as ThreadSummary[],
  listing: Promise.resolve(),
  push: (_push: ClientPush) => {},
}));

vi.mock("../lib/rpc", () => ({
  core: {
    delivery: "all",
    setFrameInterest: () => {},
    onPush: (listener: (push: ClientPush) => void) => {
      host.push = listener;
      return () => {};
    },
    call: vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "threads.get") return host.threads.find((thread) => thread.id === params["id"]) ?? null;
      if (method === "threads.resolvedCount") return 0;
      if (method !== "threads.list") return [];
      const list = params as RpcParams<"threads.list">;
      if (list.filter === "archived" || list.pinnedOnly || list.needsYou) return [];
      const rows = [...host.threads].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      if (list.selectedId) return rows.filter((thread) => thread.id === list.selectedId);
      // A large ledger answers the list after the open thread's own read.
      await host.listing;
      return [...host.threads].sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, list.limit);
    }),
  },
}));
vi.mock("../lib/browser-preview", () => ({ CoversPreview: () => null }));

import { queryClient } from "../lib/client";
import { ALL_WORKSPACES, useLayout } from "../lib/layout";
import { useRouter } from "../lib/router";
import { SidebarThreadBrowser } from "./SidebarThreadBrowser";

function thread(id: string, lastActivityAt: number, activity: ThreadSummary["activity"] = "idle"): ThreadSummary {
  return {
    id,
    title: id,
    projectId: WORKSPACE_ID,
    agent: "claude",
    activity,
    unread: false,
    session: { status: "idle", message: null },
    pinnedAt: null,
    snoozedUntil: null,
    archivedAt: null,
    lastActivityAt,
    createdAt: 1,
    parentThreadId: null,
  } as unknown as ThreadSummary;
}

const set = (id: string, change: Partial<ThreadSummary>) => {
  host.threads = host.threads.map((each) => (each.id === id ? { ...each, ...change } : each));
};
const row = (title: string) => screen.getAllByRole("button").find((button) => button.getAttribute("title")?.startsWith(`${title}\n`));
const working = (title: string) => Boolean(row(title) && within(row(title)!).queryByRole("img", { name: "Working" }));

const mount = (threadId: string) => {
  useRouter.setState({ route: { view: "thread", threadId }, history: [], future: [], threadIds: [] });
  render(
    <QueryClientProvider client={queryClient}>
      <SidebarThreadBrowser />
    </QueryClientProvider>,
  );
};
/** The turn on the open thread ends, and another thread starts working so the list's refresh can be seen to land. */
async function endTurn(open: string, other: string) {
  set(open, { activity: "idle" });
  set(other, { activity: "running" });
  host.push({ type: "invalidate", keys: ["threads"] });
  await waitFor(() => expect(working(other)).toBe(true));
}

afterEach(() => {
  cleanup();
  queryClient.clear();
  host.listing = Promise.resolve();
});
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  localStorage.clear();
  useLayout.setState({ collapsed: [], workspace: ALL_WORKSPACES, sidebarOpen: true, pinnedOnly: false });
});

it("shows the open thread's turn ending after a reload read it before the list", async () => {
  const now = Date.now();
  host.threads = [thread("other", now - 60_000), thread("open", now - 30_000, "running")];
  let answer = () => {};
  host.listing = new Promise((resolve) => (answer = resolve));
  mount("open");
  await waitFor(() => expect(working("open")).toBe(true));
  answer();
  await waitFor(() => expect(row("other")).toBeTruthy());
  await endTurn("open", "other");
  expect(working("open")).toBe(false);
});

it("shows the open thread's turn ending after it came up from a later page", async () => {
  // Newer threads fill the first page, so the list reads the open thread apart.
  const now = Date.now();
  host.threads = [...Array.from({ length: 14 }, (_, index) => thread(`other-${index}`, now - (14 - index) * 60_000)), thread("open", now - 30 * 60_000, "running")];
  mount("open");
  await waitFor(() => expect(working("open")).toBe(true));
  // A new turn brings it to the top of the list.
  set("open", { lastActivityAt: now });
  host.push({ type: "invalidate", keys: ["threads"] });
  await waitFor(() => expect(row("other-0")).toBeUndefined());
  await endTurn("open", "other-13");
  expect(working("open")).toBe(false);
});
