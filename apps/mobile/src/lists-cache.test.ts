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

it("keeps the last usage a host reported, so Settings has it on a cold start while that host is away", () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const saved = new Map<string, string>();
  const storage = { getString: (key: string) => saved.get(key), set: (key: string, value: string) => void saved.set(key, value), remove: (key: string) => void saved.delete(key) };
  const before = new QueryClient();
  const stop = keepLists(before, storage, () => "studio");
  const limits = [{ id: "claude:rainy", provider: "claude", name: "Claude · Rainy", plan: "Max", status: "available", windows: [], refreshedAt: 999_000 }];
  before.setQueryData(["providers.limits", {}], limits);
  vi.advanceTimersByTime(1_000);
  stop();

  const after = new QueryClient();
  expect(restoreLists(after, storage, "studio")).toBe(true);
  expect(after.getQueryData(["providers.limits", {}])).toEqual(limits);
});

it("keeps the Mac's agents' models, so a cloud thread's composer has a model to send with while the Mac is asleep", () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const saved = new Map<string, string>();
  const storage = { getString: (key: string) => saved.get(key), set: (key: string, value: string) => void saved.set(key, value), remove: (key: string) => void saved.delete(key) };
  const before = new QueryClient();
  const stop = keepLists(before, storage, () => "studio");
  const models = [{ agent: "claude", id: "claude-opus-5-5", label: "Opus 5.5" }];
  before.setQueryData(["agents.models", {}], models);
  vi.advanceTimersByTime(1_000);
  stop();
  const after = new QueryClient();
  expect(restoreLists(after, storage, "studio")).toBe(true);
  expect(after.getQueryData(["agents.models", {}])).toEqual(models);
});

it("keeps a list's last answer through a read that failed, as every read does while the Mac is asleep", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const saved = new Map<string, string>();
  const storage = { getString: (key: string) => saved.get(key), set: (key: string, value: string) => void saved.set(key, value), remove: (key: string) => void saved.delete(key) };
  const before = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const stop = keepLists(before, storage, () => "studio");
  const harnesses = [{ id: "claude", state: "ready" }];
  before.setQueryData(["agents.availability", {}], harnesses);
  vi.advanceTimersByTime(1_000);
  // The Mac falls asleep: this read fails, and another list's read succeeds, which saves the lists again.
  await before.fetchQuery({ queryKey: ["agents.availability", {}], queryFn: () => Promise.reject(new Error("The Mac is asleep.")), staleTime: 0 }).catch(() => undefined);
  before.setQueryData(["threads.list", {}], []);
  vi.advanceTimersByTime(1_000);
  stop();
  const after = new QueryClient();
  expect(restoreLists(after, storage, "studio")).toBe(true);
  expect(after.getQueryData(["agents.availability", {}])).toEqual(harnesses);
});
