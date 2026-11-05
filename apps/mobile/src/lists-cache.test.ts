import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { keepLists, restoreLists } from "./lists-cache";

afterEach(() => vi.useRealTimers());

it("keeps a host's task list for the next launch, as old as the phone heard it", () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const saved = new Map<string, string>();
  const storage = { getString: (key: string) => saved.get(key), set: (key: string, value: string) => void saved.set(key, value), remove: (key: string) => void saved.delete(key) };
  const before = new QueryClient();
  const stop = keepLists(before, storage, () => "studio");
  const board = { tasks: [{ id: "task-1", title: "Write the docs" }], mac: null };
  before.setQueryData(["tasks.board"], board);
  vi.advanceTimersByTime(1_000);
  stop();

  vi.setSystemTime(9_000_000);
  const after = new QueryClient();
  expect(restoreLists(after, storage, "studio")).toBe(true);
  expect(after.getQueryData(["tasks.board"])).toEqual(board);
  expect(after.getQueryState(["tasks.board"])?.dataUpdatedAt).toBe(1_000_000);
});
