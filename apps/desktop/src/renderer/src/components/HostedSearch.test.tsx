import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HOSTED_REASONS } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { useRouter } from "../lib/router";
import { spaceNavigation } from "../lib/space-navigation";
import { useUi } from "../lib/ui";
import { CommandPalette } from "./CommandPalette";
import { cloudReviewThread, localReviewThread } from "./test-fixtures/hosted-review";

/** A cloud server that answers its capabilities and serves none of these. */
const SERVED_NOTHING = { version: 1, features: {} };

beforeEach(() => {
  queryClient.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  useUi.setState({ palette: true, paletteMode: "messages" });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each([true, false])("searches messages from a thread in either place, the cloud's too (cloud=%s)", async (cloud) => {
  spaceNavigation.setState({ current: "space-1" });
  const thread = cloud ? cloudReviewThread : localReviewThread;
  useRouter.setState({ route: { view: "thread", threadId: thread.id } });
  queryClient.setQueryData(["threads.get", { id: thread.id }], thread);
  const hit = {
    threadId: thread.id,
    threadTitle: "Example",
    projectId: thread.projectId,
    messageId: "m-1",
    runId: cloud ? `hosted:${thread.id}` : "run-1",
    role: "assistant",
    snippet: "The example match",
    ts: 1,
    turn: 0,
    taskId: null,
    taskTitle: null,
    member: null,
  };
  const answers: Record<string, unknown> = { "threads.get": thread, "threads.search": [hit], "hosted.capabilities": SERVED_NOTHING };
  vi.spyOn(core, "call").mockImplementation((async (method: string) => answers[method] ?? []) as typeof core.call);
  render(
    <QueryClientProvider client={queryClient}>
      <CommandPalette open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "example" } });
  // Asked in the window's space, which is what reaches its cloud threads.
  await vi.waitFor(() => expect(core.call).toHaveBeenCalledWith("threads.search", expect.objectContaining({ query: "example", spaceId: "space-1" })));
  expect(await screen.findByText("The example match")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Search messages" })).toBeNull();
});

it("says a cloud server's own refusal where the hits would be, and shows none", async () => {
  // The refusal is final: asked again it says the same.
  queryClient.setQueryDefaults(["threads.search"], { retry: false });
  useRouter.setState({ route: { view: "thread", threadId: cloudReviewThread.id } });
  queryClient.setQueryData(["threads.get", { id: cloudReviewThread.id }], cloudReviewThread);
  vi.spyOn(core, "call").mockImplementation((async (method: string) => {
    if (method === "threads.get") return cloudReviewThread;
    if (method === "threads.search") throw new Error(HOSTED_REASONS.search);
    if (method === "hosted.capabilities") return SERVED_NOTHING;
    return [];
  }) as typeof core.call);
  render(
    <QueryClientProvider client={queryClient}>
      <CommandPalette open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "example" } });
  const held = await screen.findByRole("button", { name: "Search messages" });
  expect(held.hasAttribute("disabled")).toBe(true);
  await act(async () => held.parentElement?.focus());
  expect(await screen.findByText(HOSTED_REASONS.search)).toBeTruthy();
});

it("keeps cached message results private while the thread's place is still loading", async () => {
  useRouter.setState({ route: { view: "thread", threadId: cloudReviewThread.id } });
  queryClient.setQueryData(
    ["threads.search", { query: "example", limit: 20 }],
    [{ threadId: "local", threadTitle: "Local", messageId: "local-message", runId: "local-run", role: "assistant", snippet: "A local-only match", ts: 1, turn: 0 }],
  );
  vi.spyOn(core, "call").mockImplementation((async (method: string) => (method === "threads.get" ? new Promise(() => {}) : [])) as typeof core.call);
  render(
    <QueryClientProvider client={queryClient}>
      <CommandPalette open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "example" } });
  await act(async () => {});
  expect(screen.queryByText("A local-only match")).toBeNull();
  expect(vi.mocked(core.call).mock.calls.some(([method]) => method === "threads.search")).toBe(false);
});
