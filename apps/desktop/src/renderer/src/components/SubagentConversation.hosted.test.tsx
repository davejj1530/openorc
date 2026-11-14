import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcMethod, RpcParams, RpcResults, ThreadSummary } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { SubagentConversation } from "./SubagentConversation";
import { cloudReviewThread, localReviewThread, reviewProject } from "./test-fixtures/hosted-review";

vi.mock("./TopBar", () => ({ TopBar: () => null }));

const native = { status: "running", agentType: "explore", toolCallId: "tool", startedAt: 1, endedAt: null, stoppable: true, hostRunId: "host-one" } as const;
const child: ThreadSummary = { ...cloudReviewThread, parentThreadId: "parent", parentRelation: "subagent", subagent: native };
let calls: { method: string; params: unknown }[];
let readError: Error | null;
let stopError: Error | null;
let readPending: boolean;
beforeEach(() => {
  calls = [];
  readError = null;
  stopError = null;
  readPending = false;
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> => {
    calls.push({ method, params });
    if (method === "runs.listForThread" && readPending) return new Promise(() => {});
    if (method === "runs.listForThread" && readError) throw readError;
    if (method === "subagents.stop" && stopError) throw stopError;
    let reply: unknown = null;
    if (method === "threads.get") reply = cloudReviewThread;
    if (method === "runs.listForThread") reply = [];
    return reply as RpcResults[M];
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});
const mount = (thread = child) =>
  render(
    <QueryClientProvider client={queryClient}>
      <SubagentConversation thread={thread} project={reviewProject} />
    </QueryClientProvider>,
  );

it("keeps the cloud child read-only and stops only the handle shown by its row", async () => {
  mount();
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(calls).toContainEqual({ method: "subagents.stop", params: { threadId: child.id, expectedRunId: "host-one" } }));
  expect(calls.some(({ method }) => method === "runs.interrupt")).toBe(false);
  expect(calls.some(({ method }) => method === "threads.messages")).toBe(false);
});

it("explains an unsupported selected Stop only on focus", async () => {
  mount({ ...child, subagent: { ...native, stoppable: false } });
  const stop = screen.getByRole<HTMLButtonElement>("button", { name: "Stop" });
  expect(stop.disabled).toBe(true);
  expect(screen.queryByText("This subagent can't be stopped separately.")).toBeNull();
  await act(async () => stop.parentElement?.focus());
  expect(await screen.findByText("This subagent can't be stopped separately.")).toBeTruthy();
});

it("shows a failed child read with Retry without fabricating an empty history", async () => {
  readError = new Error("Could not read subthreads.");
  mount();
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Could not read subthreads.");
  readError = null;
  fireEvent.click(screen.getByRole("button", { name: "Retry loading history" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("shows an unfinished cloud history read as loading", () => {
  readPending = true;
  mount();
  expect(screen.getByRole("status").textContent).toBe("Loading history…");
});

it("explains an old server's missing child history on demand", async () => {
  readError = new Error("Subthreads aren't available in this cloud thread yet.");
  mount();
  const unavailable = await screen.findByRole<HTMLButtonElement>("button", { name: "Subthread unavailable" });
  expect(unavailable.disabled).toBe(true);
  expect(screen.queryByText(readError.message)).toBeNull();
  await act(async () => unavailable.parentElement?.focus());
  expect(await screen.findByText(readError.message)).toBeTruthy();
});

it("keeps a finished child read-only without a Stop control", () => {
  mount({ ...child, subagent: { ...native, status: "completed", stoppable: false, hostRunId: null, endedAt: 2 } });
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  expect(screen.getByText(/Done/)).toBeTruthy();
});

it("keeps a refused Stop visible as a failure", async () => {
  stopError = new Error("This subagent can't be stopped separately.");
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", stopError.message);
  expect(screen.getByText(/Working/)).toBeTruthy();
});

it("keeps local Stop's existing request and hides its unavailable action", async () => {
  const local = { ...child, owner: localReviewThread.owner };
  const view = mount(local);
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(calls).toContainEqual({ method: "subagents.stop", params: { threadId: child.id } }));
  expect(calls).toContainEqual({ method: "threads.messages", params: { id: child.id } });
  view.rerender(
    <QueryClientProvider client={queryClient}>
      <SubagentConversation thread={{ ...local, subagent: { ...native, stoppable: false } }} project={reviewProject} />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
});
