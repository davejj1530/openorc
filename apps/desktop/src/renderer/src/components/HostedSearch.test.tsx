import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HOSTED_REASONS } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { useRouter } from "../lib/router";
import { useUi } from "../lib/ui";
import { CommandPalette } from "./CommandPalette";
import { cloudReviewThread, localReviewThread } from "./test-fixtures/hosted-review";

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
it.each([true, false])("scopes message search to its execution place (cloud=%s)", async (cloud) => {
  const thread = cloud ? cloudReviewThread : localReviewThread;
  useRouter.setState({ route: { view: "thread", threadId: thread.id } });
  queryClient.setQueryData(["threads.get", { id: thread.id }], thread);
  vi.spyOn(core, "call").mockImplementation((async (method: string) => (method === "threads.get" ? thread : [])) as typeof core.call);
  render(
    <QueryClientProvider client={queryClient}>
      <CommandPalette open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "example" } });
  await act(async () => {});
  if (cloud) {
    const disabled = await screen.findByRole("button", { name: "Search messages" });
    expect(disabled.hasAttribute("disabled")).toBe(true);
    await act(async () => disabled.parentElement?.focus());
    expect(await screen.findByText(HOSTED_REASONS.search)).toBeTruthy();
    expect(vi.mocked(core.call).mock.calls.some(([method]) => method === "threads.search")).toBe(false);
    expect(screen.queryByText("Nothing matches.")).toBeNull();
  } else await vi.waitFor(() => expect(core.call).toHaveBeenCalledWith("threads.search", expect.objectContaining({ query: "example" })));
});

it("does not show a cached local message result after opening search from a cloud thread", async () => {
  useRouter.setState({ route: { view: "thread", threadId: cloudReviewThread.id } });
  queryClient.setQueryData(["threads.get", { id: cloudReviewThread.id }], cloudReviewThread);
  queryClient.setQueryData(
    ["threads.search", { query: "example", limit: 20 }],
    [{ threadId: "local", threadTitle: "Local", messageId: "local-message", runId: "local-run", role: "assistant", snippet: "A local-only match", ts: 1, turn: 0 }],
  );
  vi.spyOn(core, "call").mockImplementation((async (method: string) => (method === "threads.get" ? cloudReviewThread : [])) as typeof core.call);
  render(
    <QueryClientProvider client={queryClient}>
      <CommandPalette open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "example" } });
  await screen.findByRole("button", { name: "Search messages" });
  expect(screen.queryByText("A local-only match")).toBeNull();
});
