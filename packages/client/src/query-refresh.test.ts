// @vitest-environment jsdom
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { expect, it } from "vitest";
import type { CoreConnection } from "./connection.js";
import { createQueries } from "./query.js";

it("asks a read as a refresh once it holds data, whether a change or a timer asks again, and never its first time", async () => {
  const asked: { method: string; refresh: boolean }[] = [];
  const connection: CoreConnection = {
    delivery: "all",
    call: (async (method: string, _params: unknown, options?: { refresh: true }) => {
      asked.push({ method, refresh: options?.refresh === true });
      return [];
    }) as CoreConnection["call"],
    onPush: () => () => undefined,
    setFrameInterest: () => undefined,
  };
  const queries = createQueries(connection, 0);
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queries.queryClient }, children);
  renderHook(() => [queries.useRpc("threads.messages", { id: "t1" }), queries.useRpc("git.threadLog", { threadId: "t1" }, { refetchInterval: 50 })], { wrapper });
  await waitFor(() => expect(asked.filter((each) => each.method === "git.threadLog").length).toBeGreaterThanOrEqual(2));
  queries.invalidateTags(["thread:t1"], { immediate: true });
  await waitFor(() => expect(asked.filter((each) => each.method === "threads.messages")).toHaveLength(2));
  expect(asked.filter((each) => each.method === "threads.messages")).toEqual([
    { method: "threads.messages", refresh: false },
    { method: "threads.messages", refresh: true },
  ]);
  const polls = asked.filter((each) => each.method === "git.threadLog");
  expect(polls[0]).toEqual({ method: "git.threadLog", refresh: false });
  expect(polls.slice(1).every((each) => each.refresh)).toBe(true);
  cleanup();
  queries.queryClient.clear();
});
