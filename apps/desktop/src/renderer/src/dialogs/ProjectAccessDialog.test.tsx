import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OrganizationPeople, OrganizationProjectAccess } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { ProjectAccessDialog } from "./ProjectAccessDialog";

const mock = vi.hoisted(() => ({ call: vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>() }));
vi.mock("../lib/rpc", () => ({ core: { call: mock.call, onPush: () => () => {}, onReady: () => () => {} } }));
const close = vi.fn();
const organization = { id: "birch", name: "Birch Studio", logo: null };
const project = { key: "canvas", name: "Canvas", repo: "example/canvas", localProjectId: "canvas", hostedProjectId: "server-canvas", connected: true };
let policy: OrganizationProjectAccess;
let people: OrganizationPeople;
let refusal: string | null;
beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  refusal = null;
  policy = { projectId: "server-canvas", everyone: false, memberIds: ["mira"] };
  people = {
    organization,
    viewer: { memberId: "alex", role: "admin" },
    adminCount: 1,
    total: 3,
    members: [
      { memberId: "alex", userId: "u-alex", name: "Alex Rivera", email: "alex@example.com", image: null, role: "admin", plan: "pro", joinedAt: 1 },
      { memberId: "mira", userId: "u-mira", name: "Mira Chen", email: "mira@example.com", image: null, role: "member", plan: "free", joinedAt: 1 },
      { memberId: "jules", userId: "u-jules", name: "Jules Park", email: "jules@example.com", image: null, role: "member", plan: "free", joinedAt: 1 },
    ],
  };
  mock.call.mockImplementation(async (method) => {
    if (method === "organization.people") return people;
    if (method === "organization.project.access") return policy;
    if (refusal) throw new Error(refusal);
    return policy;
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
function show() {
  render(
    <QueryClientProvider client={queryClient}>
      <ProjectAccessDialog organization={organization} project={project} onClose={close} />
    </QueryClientProvider>,
  );
}
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
const writes = () => mock.call.mock.calls.filter(([method]) => method === "organization.project.setAccess");

it("keeps admins checked and saves an empty chosen list without adding inherent grants", async () => {
  show();
  const admin = await screen.findByRole("checkbox", { name: "Alex Rivera" });
  expect(admin).toHaveProperty("checked", true);
  expect(admin).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Mira Chen" }));
  save();
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(writes()).toEqual([["organization.project.setAccess", { spaceId: "birch", projectId: "server-canvas", everyone: false, memberIds: [] }]]);
});

it("hides the chooser for Everyone while preserving choices and a previously explicit admin grant", async () => {
  policy.memberIds = ["alex", "mira"];
  show();
  await screen.findByRole("checkbox", { name: "Mira Chen" });
  fireEvent.click(screen.getByRole("radio", { name: "Everyone in Birch Studio" }));
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "Only people you choose" }));
  expect(screen.getByRole("checkbox", { name: "Mira Chen" })).toHaveProperty("checked", true);
  fireEvent.click(screen.getByRole("radio", { name: "Everyone in Birch Studio" }));
  save();
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]?.[1]).toEqual({ spaceId: "birch", projectId: "server-canvas", everyone: true, memberIds: ["alex", "mira"] });
});

it("takes Everyone from the server and Cancel makes no write", async () => {
  policy.everyone = true;
  show();
  await screen.findByRole("radio", { name: "Everyone in Birch Studio" });
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledOnce();
  expect(writes()).toEqual([]);
});

it("retains choices on a foreign-member refusal and stops writes after live self-demotion", async () => {
  refusal = "That person isn't in this organization.";
  show();
  await screen.findByRole("checkbox", { name: "Mira Chen" });
  fireEvent.click(screen.getByRole("checkbox", { name: "Jules Park" }));
  save();
  await screen.findByRole("alert");
  expect(screen.getByRole("checkbox", { name: "Jules Park" })).toHaveProperty("checked", true);
  expect(close).not.toHaveBeenCalled();
  people = { ...people, viewer: { memberId: "alex", role: "member" } };
  await queryClient.invalidateQueries({ queryKey: ["organization.people"] });
  await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true));
  expect(writes()).toHaveLength(1);
});
