import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OrganizationRepositories } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { OrganizationProjectsDialog } from "./OrganizationProjectsDialog";
import { TooltipProvider } from "../components/ui";

const mock = vi.hoisted(() => ({ call: vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>() }));
vi.mock("../lib/rpc", () => ({ core: { call: mock.call, onPush: () => () => {}, onReady: () => () => {} } }));
vi.mock("../lib/browser-preview", () => ({ CoversPreview: () => null }));
const close = vi.fn();
const added = vi.fn();
let repositories: OrganizationRepositories;
beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  window.openorc = { ...window.openorc, openExternal: vi.fn() };
  repositories = {
    configured: true,
    installations: [{ id: "installation", accountLogin: "birch", accountType: "Organization", suspended: false, settingsUrl: "https://github.com/organizations/birch/settings/installations/17" }],
    connecting: null,
    repositories: ["canvas", "website"].map((name, index) => ({ installationId: "installation", repoId: index + 1, fullName: `birch/${name}`, defaultBranch: "main", private: true, projectId: null })),
  };
  mock.call.mockImplementation(async (method) => (method === "organization.repositories" ? repositories : []));
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

function view() {
  return render(
    <TooltipProvider>
      <QueryClientProvider client={queryClient}>
        <OrganizationProjectsDialog open spaceId="birch" onOpenChange={close} onAdded={added} />
      </QueryClientProvider>
    </TooltipProvider>,
  );
}

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

it("offers the connected account and another account from the same chooser, without starting an install for settings", async () => {
  view();
  fireEvent.click(await screen.findByRole("button", { name: "Choose repositories on GitHub" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "birch" }));
  expect(window.openorc.openExternal).toHaveBeenCalledWith(repositories.installations[0]!.settingsUrl);
  expect(mock.call.mock.calls.filter(([method]) => method === "organization.github.connect")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Choose repositories on GitHub" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Another account or organization" }));
  await waitFor(() => expect(mock.call).toHaveBeenCalledWith("organization.github.connect", { spaceId: "birch", another: true }));
});

it("keeps every connected account listed when one settings page is unavailable", async () => {
  repositories.installations.push({ id: "second", accountLogin: "cedar", accountType: "User", suspended: false, settingsUrl: null });
  view();
  fireEvent.click(await screen.findByRole("button", { name: "Choose repositories on GitHub" }));
  const unavailable = await screen.findByRole("menuitem", { name: "cedar" });
  expect(unavailable.getAttribute("aria-disabled")).toBe("true");
  expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["birch", "cedar", "Another account or organization"]);
  fireEvent.click(unavailable);
  expect(window.openorc.openExternal).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("menuitem", { name: "Another account or organization" }));
  await waitFor(() => expect(mock.call).toHaveBeenCalledWith("organization.github.connect", { spaceId: "birch", another: true }));
});

it("keeps an empty space's chooser explicit even when there are no available accounts", async () => {
  repositories = { ...repositories, installations: [], repositories: [] };
  view();
  fireEvent.click(await screen.findByRole("button", { name: "Choose repositories on GitHub" }));
  expect(mock.call.mock.calls.filter(([method]) => method === "organization.github.connect")).toHaveLength(0);
  expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Another account or organization"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Another account or organization" }));
  await waitFor(() => expect(mock.call).toHaveBeenCalledWith("organization.github.connect", { spaceId: "birch", another: true }));
});

it("keeps a refused default connection and offers another account as a separate explicit action", async () => {
  repositories = { ...repositories, installations: [], repositories: [], connecting: { state: "failed", error: "Another OpenOrc space already uses that GitHub installation." } };
  view();
  await screen.findByText("Another OpenOrc space already uses that GitHub installation.");
  expect(mock.call.mock.calls.filter(([method]) => method === "organization.github.connect")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Another account or organization" }));
  await waitFor(() => expect(mock.call).toHaveBeenCalledWith("organization.github.connect", { spaceId: "birch", another: true }));
  fireEvent.click(screen.getByRole("button", { name: "Choose repositories on GitHub" }));
  await screen.findByRole("menuitem", { name: "Another account or organization" });
  expect(mock.call.mock.calls.filter(([method]) => method === "organization.github.connect")).toHaveLength(1);
});

it("lists connected accounts before available accounts and connects only the selected account", async () => {
  repositories.available = [
    { installationId: 18, accountLogin: "cedar", accountType: "Organization" },
    { installationId: 19, accountLogin: "spruce", accountType: "User" },
  ];
  view();
  fireEvent.click(await screen.findByRole("button", { name: "Choose repositories on GitHub" }));
  expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["birch", "Connect cedar", "Connect spruce", "Another account or organization"]);
  expect(mock.call.mock.calls.filter(([method]) => method === "organization.github.connect")).toHaveLength(0);
  fireEvent.click(screen.getByRole("menuitem", { name: "Connect spruce" }));
  await waitFor(() => expect(mock.call).toHaveBeenCalledWith("organization.github.connect", { spaceId: "birch", installationId: 19 }));
  expect(window.openorc.openExternal).not.toHaveBeenCalled();
});

it("rereads on focus and reopening while retaining selected and already added repositories", async () => {
  const mounted = view();
  fireEvent.click(await screen.findByRole("checkbox", { name: "canvas birch/canvas" }));
  const first = repositories.repositories[0]!;
  repositories = { ...repositories, repositories: [first, { ...repositories.repositories[1]!, projectId: "website" }, { ...first, repoId: 3, fullName: "birch/docs" }] };
  fireEvent.focus(window);
  await screen.findByText("docs");
  expect(screen.getByRole("checkbox", { name: "canvas birch/canvas" })).toHaveProperty("checked", true);
  expect(screen.getByRole("checkbox", { name: "website birch/website Added" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Add 1 project" })).toHaveProperty("disabled", false);
  mounted.unmount();
  repositories = { ...repositories, repositories: [...repositories.repositories, { ...first, repoId: 4, fullName: "birch/tools" }] };
  view();
  await screen.findByText("tools");
  expect(screen.getByRole("checkbox", { name: "website birch/website Added" })).toHaveProperty("disabled", true);
});
