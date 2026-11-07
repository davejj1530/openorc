// @vitest-environment jsdom
import type { ThreadSummary } from "@openorc/protocol";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MoveRefused } from "./MoveRefused";

/** The group's Mac as the card asks it: what `moves.refused` answers, or an error for a Mac from before it. */
const mac = vi.hoisted(() => ({ answer: [] as unknown, calls: [] as [string, unknown][], client: null as unknown as QueryClient }));
vi.mock("../client", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  mac.client = new QueryClient();
  const connection = {
    device: async () => (mac.answer instanceof Error ? Promise.reject(mac.answer) : mac.answer),
    call: async (method: string, params: unknown) => void mac.calls.push([method, params]),
  };
  return { hostLink: () => ({ connection }), hostClient: () => ({ queryClient: mac.client }) };
});
vi.mock("./use-mover", () => ({ useMover: () => ({ mac: "mac-1", onBrain: true }) }));

afterEach(() => {
  cleanup();
  mac.client.clear();
  mac.calls = [];
});

const thread = { id: "t1", lastActivityAt: 5, moving: null } as unknown as ThreadSummary;
const refusal = { to: "mac" as const, reason: "Its last changes are still in its sandbox, which did not answer. Try again in a moment.", at: 5 };

it("shows why Bring to Mac did not happen, as the Mac says, and asks the Mac to try again", async () => {
  mac.answer = [{ threadId: "t1", refusal }];
  render(<MoveRefused thread={thread} />);
  await waitFor(() => expect(screen.getByText("Didn't move")).toBeTruthy());
  expect(screen.getByText(refusal.reason)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(mac.calls).toEqual([["cloud.bringToMac", { threadId: "t1" }]]));
});

it("shows nothing once the conversation did something since, or from a Mac that does not know the question", async () => {
  mac.answer = [{ threadId: "t1", refusal }];
  const { unmount } = render(<MoveRefused thread={{ ...thread, lastActivityAt: 6 }} />);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByText("Didn't move")).toBeNull();
  unmount();
  mac.client.clear();
  mac.answer = new Error("Unknown method moves.refused");
  render(<MoveRefused thread={thread} />);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByText("Didn't move")).toBeNull();
});
