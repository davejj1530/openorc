import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { queryClient } from "./client";
import { spaceNavigation } from "./space-navigation";
import { useSpaceRpc } from "./space-queries";

const pending = vi.hoisted(() => new Map<string, (count: number) => void>());
vi.mock("./rpc", () => ({
  core: {
    onPush: () => () => {},
    call: vi.fn((_method: string, params: { spaceId: string; ownership: string }) => new Promise<number>((resolve) => pending.set(`${params.spaceId}:${params.ownership}`, resolve))),
  },
}));

afterEach(() => {
  cleanup();
  spaceNavigation.getState().end();
  queryClient.clear();
  localStorage.clear();
  sessionStorage.clear();
  pending.clear();
});

function Count() {
  const count = useSpaceRpc("threads.resolvedCount", { projectIds: [], quietBefore: 1 });
  return <p>{count.data ?? "Loading"}</p>;
}

it("keeps delayed counts in their requested space and ownership filter", async () => {
  spaceNavigation.getState().initialize("account", "personal", [
    { id: "personal", personal: true, projects: [], threads: [], taskIds: [] },
    { id: "birch", personal: false, projects: [], threads: [], taskIds: [] },
  ]);
  render(
    <QueryClientProvider client={queryClient}>
      <Count />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(pending.has("personal:everyone")).toBe(true));
  act(() => spaceNavigation.getState().select("birch"));
  await waitFor(() => expect(pending.has("birch:everyone")).toBe(true));
  await act(async () => pending.get("birch:everyone")!(2));
  await screen.findByText("2");
  await act(async () => pending.get("personal:everyone")!(9));
  expect(screen.queryByText("9")).toBeNull();
  act(() => spaceNavigation.getState().setOwnership("mine"));
  await screen.findByText("Loading");
  await waitFor(() => expect(pending.has("birch:mine")).toBe(true));
  await act(async () => pending.get("birch:mine")!(1));
  await screen.findByText("1");
  act(() => spaceNavigation.getState().select("personal"));
  await screen.findByText("9");
});
