import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useTaskRoster } from "./task-roster";
import { core } from "./rpc";
import { organizationContentGate } from "./organization-content-gate";
import { taskAccess } from "./test-fixtures/task-access";

vi.mock("./rpc", () => ({ core: { call: vi.fn() } }));
afterEach(() => {
  cleanup();
  organizationContentGate.reset();
  vi.resetAllMocks();
});
it("hides previously read people when the roster read is refused", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const person = { memberId: "member-a", userId: "account-a", name: "Alex", image: null, available: true };
  // Each read answers by what it asks, so a slow machine's extra access read never takes the roster's answer.
  let refused = false;
  vi.mocked(core.call).mockImplementation((async (method: string) => {
    if (method === "spaces.refresh") return taskAccess("account-a", "space-a");
    if (method !== "tasks.online.assignees") throw new Error(`Unexpected RPC: ${method}`);
    if (refused) throw new Error("Project access changed");
    return { accessRevision: 1, people: [person], cursor: null };
  }) as never);
  await organizationContentGate.refresh();
  const view = renderHook(() => useTaskRoster({ accountId: "account-a", spaceId: "space-a" }, "project-a", true, ""), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  await waitFor(() => expect(view.result.current.people).toEqual([person]));
  refused = true;
  await act(async () => {
    await view.result.current.refetch();
  });
  await waitFor(() => expect(view.result.current.error).not.toBeNull());
  expect(view.result.current.people).toEqual([]);
  client.clear();
});
