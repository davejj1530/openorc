import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcMethod, RpcParams, RpcResults, ThreadSummary } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { CloudFilesRefresh } from "./CloudFilesRefresh";

/** The core's Refresh, held open until the test settles it, as a wait for the machine's save is. */
let settle: { resolve: (value: RpcResults["threads.cloudCopyRefresh"]) => void; reject: (error: Error) => void };
const asked: RpcParams<"threads.cloudCopyRefresh">[] = [];

beforeEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  queryClient.setQueryData(["threads.get", { id: "cloud" }], { id: "cloud", activity: "running" } as ThreadSummary);
  vi.spyOn(core, "call").mockImplementation(<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> => {
    if (method === "threads.cloudCopyRefresh") {
      asked.push(params as RpcParams<"threads.cloudCopyRefresh">);
      return new Promise((resolve, reject) => (settle = { resolve: resolve as never, reject }));
    }
    if (method === "threads.get") return Promise.resolve({ id: "cloud", activity: "running" } as RpcResults[M]);
    return new Promise(() => {});
  });
});
afterEach(() => {
  cleanup();
  asked.length = 0;
  vi.restoreAllMocks();
});

it("shows at once that a Refresh waits for the turn, takes no second press, and gives a refusal back in its words", async () => {
  const failed = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <CloudFilesRefresh threadId="cloud" listed={false} onFailed={failed} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh files" }));
  const waiting = await screen.findByRole("button", { name: "Waits for the turn to end" });
  expect(waiting.getAttribute("aria-busy")).toBe("true");
  expect(waiting.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");
  fireEvent.click(waiting);
  expect(asked).toEqual([{ threadId: "cloud", endsOk: false }]);
  await act(async () => settle.reject(new Error("The thread's turn is still running. Try again once it ends.")));
  expect(failed).toHaveBeenLastCalledWith("The thread's turn is still running. Try again once it ends.");
  expect((await screen.findByRole("button", { name: "Refresh files" })).getAttribute("aria-busy")).toBe("false");
});
