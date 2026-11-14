import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useTaskRoster } from "./task-roster";
import { core } from "./rpc";

vi.mock("./rpc", () => ({ core: { call: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("hides previously read people when the roster read is refused", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const person = { memberId: "member-a", userId: "account-a", name: "Alex", image: null, available: true };
  vi.mocked(core.call)
    .mockResolvedValueOnce({ accessRevision: 1, people: [person], cursor: null })
    .mockRejectedValueOnce(new Error("Project access changed"));
  const view = renderHook(() => useTaskRoster({ accountId: "account-a", spaceId: "space-a" }, "project-a", true, ""), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  await waitFor(() => expect(view.result.current.people).toEqual([person]));
  await act(async () => {
    await view.result.current.refetch();
  });
  await waitFor(() => expect(view.result.current.error).not.toBeNull());
  expect(view.result.current.people).toEqual([]);
  client.clear();
});
