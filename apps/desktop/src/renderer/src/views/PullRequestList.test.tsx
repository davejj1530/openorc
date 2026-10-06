import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PullRequestSummary } from "@openorc/protocol";
import { core } from "../lib/rpc";
import { useLayout } from "../lib/layout";
import { queryClient } from "../lib/query";
import { PullRequestList } from "./PullRequestList";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onInvalidate: vi.fn(), onReady: vi.fn() } }));
vi.mock("../components/TopBar", () => ({ TopBar: () => null }));

const pull = (number: number, title: string) =>
  ({
    number,
    title,
    state: "open",
    isDraft: false,
    reviewDecision: null,
    author: "mara",
    headRefName: `branch-${number}`,
    baseRefName: "main",
    additions: 3,
    deletions: 1,
    updatedAt: 1,
  }) as unknown as PullRequestSummary;

beforeEach(() => {
  queryClient.setDefaultOptions({ queries: { retry: false } });
  useLayout.setState({ projectId: null });
  vi.mocked(core.call).mockImplementation(async (method, params) => {
    if (method === "system.info") return { gh: { installed: true, loggedIn: true } } as never;
    if (method === "projects.list")
      return [
        { id: "studio", name: "studio", gitRemote: "git@github.com:acme/studio.git" },
        { id: "atlas", name: "atlas", gitRemote: "https://github.com/acme/atlas" },
      ] as never;
    if (method === "pulls.list")
      return ((params as { projectId: string }).projectId === "studio" ? [pull(1, "Create the welcome flow"), pull(2, "Polish the picker")] : [pull(3, "Speed up search")]) as never;
    throw new Error(`Unexpected RPC: ${method}`);
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

it("groups every project's pull requests and folds a group away like a task group", async () => {
  render(
    <QueryClientProvider client={queryClient}>
      <PullRequestList />
    </QueryClientProvider>,
  );
  const studio = await screen.findByRole("region", { name: "studio pull requests" });
  await within(studio).findByRole("button", { name: /Create the welcome flow/ });
  const heading = within(studio).getByRole("button", { name: /studio/ });
  expect(within(heading).getByLabelText("2 pull requests")).toBeTruthy();
  fireEvent.click(heading);
  expect(heading.getAttribute("aria-expanded")).toBe("false");
  expect(within(studio).queryByRole("button", { name: /Create the welcome flow/ })).toBeNull();
  expect(screen.getByRole("button", { name: /Speed up search/ })).toBeTruthy();
});
