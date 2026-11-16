import type { SpaceProject } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { SpaceCloudProjects } from "./settings-cloud-projects";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
vi.mock("../lib/browser-preview", () => ({ CoversPreview: () => null }));

const row = (key: string, repo: string, hostedProjectId: string | null): SpaceProject => ({
  key,
  name: repo.split("/")[1]!,
  repo,
  localProjectId: key,
  hostedProjectId,
  connected: hostedProjectId !== null,
});
let inSpace: SpaceProject[];

beforeEach(() => {
  inSpace = [row("mac-api", "ana/api", "cloud-api"), row("mac-site", "ana/site", null)];
  vi.mocked(core.call).mockImplementation((async (method: string) => {
    if (method === "spaces.projects") return inSpace;
    if (method === "hostedEnvironment.available") return true;
    if (method === "projects.list")
      return [
        { id: "mac-api", name: "api" },
        { id: "mac-site", name: "site" },
        { id: "mac-docs", name: "docs" },
      ];
    if (method === "account.status")
      return {
        state: "signed-in",
        projects: [
          { projectId: "mac-api", repo: "ana/api", cloud: "added" },
          { projectId: "mac-site", repo: "ana/site", cloud: "addable" },
          { projectId: "mac-docs", repo: "ana/docs", cloud: "unreadable" },
        ],
      };
    if (method === "organization.repositories")
      return {
        configured: true,
        installations: [],
        connecting: null,
        repositories: [{ installationId: "i1", repoId: 7, fullName: "ana/site", defaultBranch: "main", private: true, projectId: null }],
      };
    if (method === "organization.projects.add") return [{ installationId: "i1", repoId: 7, state: "added", projectId: "cloud-site" }];
    if (method === "organization.projects.remove") return {};
    return null;
  }) as never);
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

const show = (personal: boolean) =>
  render(<QueryClientProvider client={queryClient}>{<SpaceCloudProjects spaceId="space-1" title={personal ? "Personal projects" : "Acme"} personal={personal} active />}</QueryClientProvider>);

it("lists the person's own cloud projects with their environment and Remove, and adds one of this Mac's from the space's GitHub", async () => {
  show(true);
  expect(await screen.findByText("api")).toBeTruthy();
  expect(screen.getByText("ana/api")).toBeTruthy();
  expect(await screen.findByRole("button", { name: "Environment" })).toBeTruthy();
  const keptOut = (await screen.findByRole("option", { name: "docs · GitHub doesn't let OpenOrc read it yet" })) as HTMLOptionElement;
  expect(keptOut.disabled).toBe(true);
  expect((screen.getByRole("combobox", { name: "Project" }) as HTMLSelectElement).value).toBe("mac-site");
  expect(screen.queryByRole("option", { name: "api" }), "one the space has is not offered").toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("organization.projects.add", { spaceId: "space-1", repositories: [{ installationId: "i1", repoId: 7 }] }));
});

it("asks before removing a cloud project, saying its cloud threads go with it", async () => {
  show(true);
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  const sheet = await screen.findByRole("dialog");
  expect(within(sheet).getByText(/Its cloud threads are deleted with it/)).toBeTruthy();
  fireEvent.click(within(sheet).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("organization.projects.remove", { spaceId: "space-1", projectId: "cloud-api" }));
});

it("shows an organization's projects as added, under its name, with no Remove", async () => {
  show(false);
  expect(await screen.findByText("Acme")).toBeTruthy();
  expect(await screen.findByText("Added")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
});

it("says there are no projects when the space has none and this Mac has none to add", async () => {
  inSpace = [];
  const answers: Record<string, unknown> = {
    "spaces.projects": [],
    "organization.repositories": { configured: true, installations: [], connecting: null, repositories: [] },
    "account.status": { state: "signed-in", projects: [] },
  };
  vi.mocked(core.call).mockImplementation((async (method: string) => answers[method] ?? null) as never);
  show(true);
  expect(await screen.findByText("No projects")).toBeTruthy();
});
