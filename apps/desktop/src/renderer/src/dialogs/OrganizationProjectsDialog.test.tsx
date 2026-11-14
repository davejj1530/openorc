import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OrganizationRepositories } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { OrganizationProjectsDialog } from "./OrganizationProjectsDialog";

const mock = vi.hoisted(() => ({ call: vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>() }));
vi.mock("../lib/rpc", () => ({ core: { call: mock.call, onPush: () => () => {}, onReady: () => () => {} } }));
const close = vi.fn();
const added = vi.fn();
let repositories: OrganizationRepositories;
beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  repositories = {
    configured: true,
    installations: [{ id: "installation", accountLogin: "birch", accountType: "Organization", suspended: false }],
    connecting: null,
    repositories: ["canvas", "website"].map((name, index) => ({ installationId: "installation", repoId: index + 1, fullName: `birch/${name}`, defaultBranch: "main", private: true, projectId: null })),
  };
  mock.call.mockImplementation(async (method) => (method === "organization.repositories" ? repositories : []));
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

it("names the add action before selection and counts only the projects to add", async () => {
  render(
    <QueryClientProvider client={queryClient}>
      <OrganizationProjectsDialog open spaceId="birch" onOpenChange={close} onAdded={added} />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole("button", { name: "Add projects" })).toHaveProperty("disabled", true);
  const choices = screen.getAllByRole("checkbox");
  fireEvent.click(choices[0]!);
  expect(screen.getByRole("button", { name: "Add 1 project" })).toHaveProperty("disabled", false);
  fireEvent.click(choices[1]!);
  fireEvent.click(screen.getByRole("button", { name: "Add 2 projects" }));
  await waitFor(() => expect(added).toHaveBeenCalledOnce());
  expect(mock.call).toHaveBeenCalledWith("organization.projects.add", {
    spaceId: "birch",
    repositories: [
      { installationId: "installation", repoId: 1 },
      { installationId: "installation", repoId: 2 },
    ],
  });
});
