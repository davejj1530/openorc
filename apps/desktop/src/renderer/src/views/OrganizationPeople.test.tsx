import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OrganizationPeople as People, OrganizationRole } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { organizationContentGate } from "../lib/organization-content-gate";
import { OrganizationPeople } from "./OrganizationPeople";

const mock = vi.hoisted(() => ({ call: vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>() }));
vi.mock("../lib/rpc", () => ({ core: { call: mock.call, onPush: () => () => {}, onReady: () => () => {} } }));
vi.mock("../lib/window", () => ({ useTrafficLights: () => false, useWindowsControls: () => false }));
vi.mock("../components/Sidebar", () => ({ WindowNav: () => null }));
vi.mock("../components/HeaderOrcling", () => ({ HeaderOrcling: () => null }));
const leave = vi.fn();
let people: People;
let failure: string | null;
let gate: unknown;
const frozenWords = "Your seat was taken back, and your day of grace has ended.";
const gateStatus = (state: "active" | "frozen") => ({
  state: "ready",
  userId: "user-alex",
  apiOrigin: "https://cloud.example.com",
  personalSpaceId: "personal",
  spaces: [
    { kind: "personal", id: "personal" },
    { kind: "organization", id: "birch", name: "Birch Studio", logo: null, memberId: "alex", role: "admin", memberCount: 3 },
  ],
  create: { allowed: true, reason: null },
  invitations: [],
  reach: "live",
  heardAt: Date.now(),
  error: null,
  organizationAccess: state === "frozen" ? { state, reason: "seat_removed", until: null, message: frozenWords } : { state, reason: null, until: null, message: null },
});
beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  organizationContentGate.reset();
  failure = null;
  gate = {};
  people = {
    organization: { id: "birch", name: "Birch Studio", logo: null },
    viewer: { memberId: "alex", role: "admin" },
    adminCount: 1,
    total: 3,
    members: [
      { memberId: "alex", userId: "user-alex", name: "Alex Rivera", email: "alex@example.com", image: null, role: "admin", plan: "pro", joinedAt: 1 },
      { memberId: "mira", userId: "user-mira", name: "Mira Chen", email: "mira@example.com", image: null, role: "member", plan: "pro", joinedAt: 2 },
      { memberId: "jules", userId: "user-jules", name: "Jules Park", email: "jules@example.com", image: null, role: "member", plan: "free", joinedAt: 3 },
    ],
  };
  mock.call.mockImplementation(answer);
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

async function answer(method: string, params: Record<string, unknown>) {
  if (method === "spaces.refresh") return typeof gate === "string" ? gateStatus(gate as "active" | "frozen") : gate;
  if (method === "organization.invitations") return [];
  if (method === "organization.people") return { ...people, members: people.members.slice(Number(params["offset"] ?? 0), Number(params["offset"] ?? 0) + 100) };
  if (method === "spaces.projects")
    return [
      { key: "canvas", hostedProjectId: "cloud-canvas" },
      { key: "canvas-copy", hostedProjectId: "cloud-canvas" },
    ];
  if (failure) throw new Error(failure);
  if (method === "organization.member.setRole") {
    const role = params["role"];
    if (role !== "admin" && role !== "member") throw new Error("Invalid test role");
    changeRole(String(params["memberId"]), role);
    return { memberId: params["memberId"], spaceId: "birch", userId: `user-${params["memberId"]}`, role, joinedAt: 1 };
  }
  if (method === "organization.member.remove") {
    people.members = people.members.filter((member) => member.memberId !== params["memberId"]);
    people.total = people.members.length;
  }
  return {};
}
function changeRole(memberId: string, role: OrganizationRole) {
  people.members = people.members.map((member) => (member.memberId === memberId ? { ...member, role } : member));
  people.adminCount = people.members.filter((member) => member.role === "admin").length;
  if (memberId === people.viewer.memberId) people.viewer = { memberId, role };
}
function show() {
  return render(
    <QueryClientProvider client={queryClient}>
      <main>
        <OrganizationPeople spaceId="birch" onInvite={() => {}} onLeft={leave} />
      </main>
    </QueryClientProvider>,
  );
}

it("shows the same Plan column to members without admin controls or an empty invitations section", async () => {
  changeRole("mira", "admin");
  changeRole("alex", "member");
  show();
  await screen.findByText("mira@example.com");
  expect(screen.getAllByText("Pro")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Invite people" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Role for Mira Chen" })).toBeNull();
  expect(screen.queryByText("Invitations")).toBeNull();
  expect(await screen.findByText("3 people · 1 project")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "More for Birch Studio" }));
  await screen.findByRole("menuitem", { name: "Leave organization…" });
  expect(screen.queryByRole("menuitem", { name: "Edit organization…" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Delete organization…" })).toBeNull();
});

it("keeps the sole admin role plain and gives the disabled Leave action its reason", async () => {
  show();
  await screen.findByText("alex@example.com");
  expect(screen.queryByRole("button", { name: "Role for Alex Rivera" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "More for Birch Studio" }));
  const item = await screen.findByRole("menuitem", { name: "Leave organization…" });
  expect(item.getAttribute("aria-disabled")).toBe("true");
  fireEvent.focus(item);
  expect(await screen.findByText("Make someone else an admin first.")).toBeTruthy();
});

it("immediately becomes the member view after a successful self-demotion", async () => {
  changeRole("mira", "admin");
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Role for Alex Rivera" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Member" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Invite people" })).toBeNull());
  expect(screen.queryByRole("button", { name: "Role for Mira Chen" })).toBeNull();
  expect(mock.call).toHaveBeenCalledWith("organization.member.setRole", { spaceId: "birch", memberId: "alex", role: "member" });
});

it("keeps a last-admin race refusal visible without pretending the role changed", async () => {
  changeRole("mira", "admin");
  failure = "Keep at least one admin in the organization.";
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Role for Alex Rivera" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Member" }));
  expect((await screen.findByRole("alert")).textContent).toBe(failure);
  expect(screen.getByRole("button", { name: "Role for Alex Rivera" }).textContent).toContain("Admin");
});

it("cancels removal with focus restored, then removes only the chosen member and keeps People open", async () => {
  show();
  const more = await screen.findByRole("button", { name: "More for Mira Chen" });
  fireEvent.click(more);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Remove member…" }));
  const dialog = await screen.findByRole("dialog", { name: "Remove Mira from Birch Studio?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(more));
  expect(mock.call.mock.calls.some(([method]) => method === "organization.member.remove")).toBe(false);
  fireEvent.click(more);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Remove member…" }));
  fireEvent.click(await screen.findByRole("button", { name: "Remove Mira" }));
  await waitFor(() => expect(screen.queryByText("mira@example.com")).toBeNull());
  expect(leave).not.toHaveBeenCalled();
  expect(screen.getByRole("table", { name: "People" })).toBeTruthy();
});

it("requires the organization's name before deletion and returns to Personal only after success", async () => {
  show();
  fireEvent.click(await screen.findByRole("button", { name: "More for Birch Studio" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete organization…" }));
  const submit = await screen.findByRole("button", { name: "Delete organization" });
  expect(submit.hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByLabelText("Type Birch Studio to confirm"), { target: { value: "Birch Studio" } });
  fireEvent.click(submit);
  await waitFor(() => expect(leave).toHaveBeenCalledTimes(1));
  expect(mock.call).toHaveBeenCalledWith("organization.delete", { spaceId: "birch", name: "Birch Studio" });
});

it("loads further pages instead of treating the first 100 people as the whole roster", async () => {
  const template = people.members[2]!;
  people.members = Array.from({ length: 101 }, (_, index) => ({ ...template, memberId: `person-${index}`, name: `Person ${index}`, email: `person-${index}@example.com` }));
  people.total = 101;
  show();
  await screen.findByText("person-100@example.com");
  expect(mock.call).toHaveBeenCalledWith("organization.people", { spaceId: "birch", offset: 100, limit: 100 });
});

it("shows a read failure and retry instead of an empty roster", async () => {
  mock.call.mockRejectedValue(new Error("OpenOrc Cloud can't be reached."));
  show();
  expect((await screen.findByRole("alert", {}, { timeout: 4000 })).textContent).toBe("OpenOrc Cloud can't be reached.");
  expect(screen.queryByRole("table", { name: "People" })).toBeNull();
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});

it("shows a frozen admin the people and their plans, with no project count, role change, removal, edit or delete", async () => {
  changeRole("mira", "admin");
  gate = "frozen";
  show();
  await screen.findByText("mira@example.com");
  const invite = await screen.findByRole("button", { name: "Invite people" });
  await waitFor(() => expect(invite.getAttribute("data-tip")).toBe(frozenWords));
  expect(invite).toHaveProperty("disabled", true);
  expect(screen.getByText("3 people")).toBeTruthy();
  expect(mock.call.mock.calls.some(([method]) => method === "spaces.projects")).toBe(false);
  expect(screen.queryByRole("button", { name: "Role for Mira Chen" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Role for Alex Rivera" })).toBeNull();
  expect(screen.queryByRole("button", { name: "More for Jules Park" })).toBeNull();
  expect(screen.getAllByText("Pro")).toHaveLength(2);
  expect(mock.call).toHaveBeenCalledWith("organization.invitations", { spaceId: "birch" });
  fireEvent.click(screen.getByRole("button", { name: "More for Birch Studio" }));
  expect((await screen.findByRole("menuitem", { name: "Leave organization…" })).getAttribute("aria-disabled")).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Edit organization…" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Delete organization…" })).toBeNull();
});

it("gives an admin whose access is open every control back", async () => {
  changeRole("mira", "admin");
  gate = "active";
  show();
  await screen.findByRole("button", { name: "Role for Mira Chen" });
  expect(screen.getByRole("button", { name: "Invite people" })).toHaveProperty("disabled", false);
  expect(await screen.findByText("3 people · 1 project")).toBeTruthy();
});
