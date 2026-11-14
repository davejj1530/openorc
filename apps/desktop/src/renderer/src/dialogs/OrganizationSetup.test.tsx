import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OrganizationRepositories } from "@openorc/protocol";
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
  vi.clearAllMocks();
  queryClient.clear();
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
  await waitFor(() => expect(saved).toHaveBeenCalledWith({ spaceId: "birch", logoError: null, pendingLogo: null }));
});

it("retains chosen repositories after partial failure and never resends successful additions", async () => {
  const data: OrganizationRepositories = {
    configured: true,
    connecting: null,
    installations: [{ id: "installation", accountLogin: "example", accountType: "Organization", suspended: false }],
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
