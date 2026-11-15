// @vitest-environment jsdom
import type { TaskBoard } from "@openorc/protocol";
import { QueryClient } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useTaskBoard } from "./use-task-board";

/** A Mac whose list the phone kept from a launch before: out of reach, then answering. */
const phone = vi.hoisted(() => ({ cache: null as unknown as QueryClient, kind: "waiting", asked: 0, board: null as TaskBoard | null }));
vi.mock("../client", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  phone.cache = new QueryClient();
  return {
    link: { connection: { device: async () => (phone.asked++, phone.board) } },
    queryClient: phone.cache,
    useLinkState: () => ({ kind: phone.kind, mac: { id: "mac-1", name: "Studio" } }),
  };
});

const kept = { tasks: [{ id: "task-1", projectId: "p", title: "Write the docs", status: "backlog" }], mac: null };

it("shows the Mac's kept list, dated by when the phone heard it, and asks nothing while the Mac is out of reach", async () => {
  phone.cache.setQueryData(["tasks.board"], kept, { updatedAt: 9_000 });
  const board = renderHook(() => useTaskBoard());
  expect(board.result.current.section).toMatchObject({ key: "mac-copy", title: "Studio", copiedAt: 9_000 });
  expect(board.result.current.available).toBe(true);
  await Promise.resolve();
  expect(phone.asked).toBe(0);
});

it("shows the Mac's own answer once it is connected", async () => {
  phone.kind = "connected";
  phone.board = { tasks: [], mac: null };
  phone.cache.clear();
  const board = renderHook(() => useTaskBoard());
  expect(board.result.current).toEqual({ section: null, available: false });
  await vi.waitFor(() => expect(board.result.current.section).toMatchObject({ key: "mac", tasks: [], copiedAt: null }));
  expect(phone.asked).toBe(1);
});
