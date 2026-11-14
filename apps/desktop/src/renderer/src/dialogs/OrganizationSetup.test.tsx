import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OrganizationRepositories, SpacesStatus } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { OrganizationIdentityDialog } from "./OrganizationIdentityDialog";
import { OrganizationProjectsDialog } from "./OrganizationProjectsDialog";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onPush: () => () => {}, onReady: () => () => {} } }));
const saved = vi.fn();
const close = vi.fn();
function identity(organization?: { id: string; name: string; logo: string | null }) {
  return render(
    <QueryClientProvider client={queryClient}>
      <OrganizationIdentityDialog open onOpenChange={close} onSaved={saved} organization={organization} />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  queryClient.clear();
});

const ready: SpacesStatus = {
  state: "ready",
  userId: "person",
  apiOrigin: "https://cloud.example.com",
  personalSpaceId: "personal",
  spaces: [{ id: "personal", kind: "personal" }],
  create: { allowed: true, reason: null },
  invitations: [],
  reach: "live",
  heardAt: 1,
  error: null,
};
function createdThenUnreadable() {
  queryClient.setQueryData(["spaces.status", {}], ready);
  vi.mocked(core.call).mockImplementation(async (method) => (method === "spaces.create" ? { spaceId: "birch", logoError: null } : ready) as never);
  saved.mockRejectedValueOnce(new Error("OpenOrc Cloud can't be reached.")).mockResolvedValue(undefined);
  const mounted = identity();
  fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "Birch Studio" } });
  fireEvent.click(screen.getByRole("button", { name: "Create organization" }));
  return mounted;
}

it("reports a completed create and retries only its read with the fields locked", async () => {
  createdThenUnreadable();
  await screen.findByText("You created Birch Studio.");
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Organization name").hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Add logo" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Open Birch Studio" }));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(2));
  expect(vi.mocked(core.call).mock.calls.filter(([method]) => method === "spaces.create")).toHaveLength(1);
  expect(close).toHaveBeenCalledWith(false);
});

it("completes an open create when a later read heals and cancels navigation after closing", async () => {
  const mounted = createdThenUnreadable();
  await screen.findByRole("alert");
  const signal: AbortSignal = saved.mock.calls[0]![1];
  mounted.unmount();
  expect(signal.aborted).toBe(true);
  queryClient.setQueryData(["spaces.status", {}], { ...ready, heardAt: 2 });
  expect(saved).toHaveBeenCalledTimes(1);
  createdThenUnreadable();
  await screen.findByRole("alert");
  queryClient.setQueryData(["spaces.status", {}], {
    ...ready,
    heardAt: 3,
    spaces: [...ready.spaces, { id: "birch", kind: "organization", name: "Birch Studio", logo: null, role: "admin", memberId: "admin", memberCount: 1 }],
  });
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(3));
  expect(close).toHaveBeenCalledWith(false);
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

it("starts blank, prevents duplicate submission and retains a reserved-name refusal beside the input", async () => {
  let refuse: (error: Error) => void = () => {};
  vi.mocked(core.call).mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        refuse = reject;
      }),
  );
  identity();
  const submit = screen.getByRole("button", { name: "Create organization" });
  expect(submit.hasAttribute("disabled")).toBe(true);
  expect(screen.getByLabelText("Organization name").getAttribute("value")).toBe("");
  fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "OpenOrc Support" } });
  fireEvent.click(submit);
  fireEvent.click(submit);
  await waitFor(() => expect(core.call).toHaveBeenCalledTimes(1));
  refuse(new Error("That name is reserved. Use your team's own name."));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Organization name").getAttribute("value")).toBe("OpenOrc Support");
  expect(saved).not.toHaveBeenCalled();
});

it("edits the captured organization and sends an explicit removal without retention settings", async () => {
  vi.mocked(core.call).mockResolvedValue({ id: "birch", name: "Birch Works", logo: null } as never);
  identity({ id: "birch", name: "Birch Studio", logo: "data:image/webp;base64,UklGRg==" });
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "Birch Works" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("organization.update", { spaceId: "birch", name: "Birch Works", logo: null }));
  await waitFor(() => expect(saved).toHaveBeenCalledWith({ spaceId: "birch", logoError: null, pendingLogo: null }, expect.any(AbortSignal)));
});

it("retains chosen repositories after partial failure and never resends successful additions", async () => {
  const data: OrganizationRepositories = {
    configured: true,
    connecting: null,
    installations: [{ id: "installation", accountLogin: "example", accountType: "Organization", suspended: false, settingsUrl: null }],
    repositories: ["canvas", "tools"].map((name, i) => ({ installationId: "installation", repoId: i + 1, fullName: `example/${name}`, defaultBranch: "main", private: true, projectId: null })),
  };
  const additions: unknown[] = [];
  vi.mocked(core.call).mockImplementation(async (method, params) => {
    if (method === "organization.repositories") return data as never;
    if (method === "organization.projects.add") {
      additions.push(params);
      return [
        { installationId: "installation", repoId: 1, state: "added", projectId: "canvas" },
        { installationId: "installation", repoId: 2, state: "refused", error: "OpenOrc can't read that repository." },
      ] as never;
    }
    return null as never;
  });
  render(
    <QueryClientProvider client={queryClient}>
      <OrganizationProjectsDialog open spaceId="birch" onOpenChange={close} onAdded={saved} />
    </QueryClientProvider>,
  );
  await screen.findByText("canvas");
  screen.getAllByRole("checkbox").forEach((checkbox) => fireEvent.click(checkbox));
  fireEvent.click(screen.getByRole("button", { name: "Add 2 projects" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Add 1 project" }));
  await waitFor(() =>
    expect(additions).toEqual([
      {
        spaceId: "birch",
        repositories: [
          { installationId: "installation", repoId: 1 },
          { installationId: "installation", repoId: 2 },
        ],
      },
      { spaceId: "birch", repositories: [{ installationId: "installation", repoId: 2 }] },
    ]),
  );
  expect(close).not.toHaveBeenCalled();
});

it.each([true, false])("retries only the read after project results, without claiming refused additions succeeded (%s)", async (added) => {
  const data: OrganizationRepositories = {
    configured: true,
    connecting: null,
    installations: [{ id: "installation", accountLogin: "example", accountType: "Organization", suspended: false, settingsUrl: null }],
    repositories: [{ installationId: "installation", repoId: 1, fullName: "example/canvas", defaultBranch: "main", private: true, projectId: null }],
  };
  vi.mocked(core.call).mockImplementation(async (method) => {
    if (method === "organization.repositories") return data as never;
    if (method === "organization.projects.add")
      return [
        added
          ? { installationId: "installation", repoId: 1, state: "added", projectId: "canvas" }
          : { installationId: "installation", repoId: 1, state: "refused", error: "OpenOrc can't read that repository." },
      ] as never;
    return null as never;
  });
  saved.mockRejectedValueOnce(new Error("OpenOrc Cloud can't be reached.")).mockResolvedValue(undefined);
  render(
    <QueryClientProvider client={queryClient}>
      <OrganizationProjectsDialog open spaceId="birch" onOpenChange={close} onAdded={saved} />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Add 1 project" }));
  await screen.findByText("OpenOrc Cloud can't be reached.");
  expect(Boolean(screen.queryByText("Projects added."))).toBe(added);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(2));
  expect(vi.mocked(core.call).mock.calls.filter(([method]) => method === "organization.projects.add")).toHaveLength(1);
  if (added) expect(close).toHaveBeenCalledWith(false);
  else expect(screen.getByRole("button", { name: "Add 1 project" })).toBeTruthy();
});
