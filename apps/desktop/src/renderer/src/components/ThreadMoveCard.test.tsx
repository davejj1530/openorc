import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ThreadSummary } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { ThreadMoveCard } from "./ThreadMoveCard";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

const thread = (extra: Partial<ThreadSummary>) => ({ id: "thread", moving: null, lastActivityAt: 1, ...extra }) as ThreadSummary;
const steps = () =>
  within(screen.getByRole("status"))
    .getAllByRole("listitem")
    .map((item) => `${item.textContent}: ${item.dataset["state"]}`);

it("shows a conversation's move to the cloud as steps, the current one running", () => {
  render(<ThreadMoveCard thread={thread({ moving: { to: "cloud", since: 1, step: "sending" } })} />);
  expect(screen.getByRole("status", { name: "Moving to the cloud" })).toBeTruthy();
  expect(steps()).toEqual(["Packing the conversation: done", "Waking the cloud brain: done", "Sending it to the cloud: running"]);
});

it("says the cloud brain is waking on an open cloud conversation, and shows nothing once it is live", () => {
  const { rerender } = render(<ThreadMoveCard thread={thread({ owner: { brain: "cloud", reach: "waking", heardAt: 1 } })} />);
  expect(steps()).toEqual(["Waking the cloud brain: running"]);
  rerender(<ThreadMoveCard thread={thread({ owner: { brain: "cloud", reach: "live", heardAt: 1 } })} />);
  expect(screen.queryByRole("status")).toBeNull();
});

function refused(brain: boolean, to: "cloud" | "mac" = "cloud") {
  vi.mocked(core.call).mockImplementation(async (method: string) => (method === "cloud.offer" ? { offered: true, provider: "vercel", brain: brain ? { projects: [] } : null } : null));
  render(
    <QueryClientProvider client={queryClient}>
      <ThreadMoveCard thread={thread({ moveRefused: { to, reason: "The cloud brain has no copy of this project.", at: 5 }, lastActivityAt: 5 })} />
    </QueryClientProvider>,
  );
}

it("says a move this Mac asked for did not happen, with its reason, and tries it again", async () => {
  refused(true);
  expect(screen.getByRole("status", { name: "Didn't move" })).toBeTruthy();
  expect(screen.getByText("The cloud brain has no copy of this project.")).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.move", { threadId: "thread" }));
});

it("tries Bring to Mac again for a refused move to this Mac, and offers no retry once the brain is gone", async () => {
  refused(true, "mac");
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.bringToMac", { threadId: "thread" }));
  cleanup();
  queryClient.clear();
  refused(false);
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.offer", {}));
  expect(screen.getByText("The cloud brain has no copy of this project.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});
