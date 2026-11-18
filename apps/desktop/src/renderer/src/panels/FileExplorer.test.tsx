import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { FileExplorer } from "./FileExplorer";

beforeEach(() => {
  queryClient.clear();
  // Every read still on its way, as a cloud thread's first listing is while its start is fetched.
  vi.spyOn(core, "call").mockImplementation(() => new Promise(() => {}));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("names the root as its project while the listing comes, for a project with no folder here", async () => {
  render(
    <QueryClientProvider client={queryClient}>
      <FileExplorer scope={{ kind: "thread", id: "cloud" }} directory="" name="web" />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole("treeitem", { name: "web" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Loading…");
});
