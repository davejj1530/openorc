import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SpacesStatus } from "@openorc/protocol";
import { queryClient } from "./client";
import { useSpacesStatus } from "./spaces-status";
const mock = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("./rpc", () => ({ core: { call: mock.call, onPush: () => () => {}, onReady: () => () => {} } }));
const ready: SpacesStatus = {
  state: "ready",
  userId: "user",
  apiOrigin: "https://api.example.com",
  personalSpaceId: "personal",
  spaces: [{ id: "personal", kind: "personal" }],
  create: { allowed: true, reason: null },
  invitations: [],
  reach: "live",
  heardAt: 1,
  error: null,
};
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.useRealTimers();
  vi.clearAllMocks();
});
function Status() {
  useSpacesStatus();
  return null;
}
it("rereads server facts on focus, online and the periodic deadline without a mutation", async () => {
  vi.useFakeTimers();
  queryClient.setQueryData(["spaces.status", {}], ready);
  mock.call.mockResolvedValue(ready);
  render(
    <QueryClientProvider client={queryClient}>
      <Status />
    </QueryClientProvider>,
  );
  for (const event of ["focus", "online"])
    await act(async () => {
      window.dispatchEvent(new Event(event));
    });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(mock.call.mock.calls.filter(([method]) => method === "spaces.refresh")).toHaveLength(3);
  expect(mock.call.mock.calls.every(([method]) => ["spaces.refresh", "spaces.status"].includes(method))).toBe(true);
});
it.each(["signed-out", "unavailable"] as const)("does not add account polling while %s", async (state) => {
  vi.useFakeTimers();
  queryClient.setQueryData(["spaces.status", {}], { state });
  mock.call.mockResolvedValue({ state });
  render(
    <QueryClientProvider client={queryClient}>
      <Status />
    </QueryClientProvider>,
  );
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(mock.call.mock.calls.some(([method]) => method === "spaces.refresh")).toBe(false);
});
