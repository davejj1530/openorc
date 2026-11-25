import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OrganizationSpace } from "@openorc/protocol";
import { OrganizationContext, type OrganizationActions } from "../lib/organization-context";
import { spaceNavigation } from "../lib/space-navigation";
import { SidebarNav } from "./SidebarNav";

vi.mock("../lib/client", () => ({ useRpc: () => ({ data: [] }) }));
vi.mock("../lib/orclings", () => ({ useOrclingChatIds: () => new Set() }));
vi.mock("../lib/task-list-source", () => ({ useTaskAttentionCount: () => 0 }));
const gate = vi.hoisted(() => ({ frozen: false }));
vi.mock("../lib/organization-content-gate", () => ({
  useOrganizationContentGate: () =>
    gate.frozen
      ? {
          allowed: false,
          blocked: "frozen",
          space: { id: "north", kind: "organization", name: "Northwind", logo: null, memberId: "m1", role: "member", memberCount: 2 },
          access: { state: "frozen", reason: "seat_removed", until: null, message: "Your seat was taken back." },
        }
      : { allowed: true, blocked: null, space: null, access: null },
}));

const organization = { id: "north", kind: "organization", name: "Northwind", logo: null, memberId: "m1", role: "admin", memberCount: 1 } as OrganizationSpace;
const actions = { organization } as OrganizationActions;

beforeEach(() => {
  spaceNavigation.getState().initialize("account-a", "personal", [
    { id: "personal", personal: true, projects: [], threads: [], taskIds: [] },
    { id: "north", personal: false, projects: [], threads: [], taskIds: [] },
  ]);
  spaceNavigation.getState().select("north");
});
afterEach(() => {
  cleanup();
  gate.frozen = false;
  if (spaceNavigation.getState().key) spaceNavigation.getState().end();
});

const newThreadRow = () => {
  render(
    <OrganizationContext.Provider value={actions}>
      <SidebarNav route={{ view: "newthread" }} projectId={null} />
    </OrganizationContext.Provider>,
  );
  return screen.getByRole("button", { name: "New thread" });
};

it("lights no row on the organization's own page, which stands in for New thread until it has a project", () => {
  expect(newThreadRow().getAttribute("aria-current")).toBeNull();
});

it("lights New thread once the organization has a project to start one in", () => {
  spaceNavigation.getState().initialize("account-a", "personal", [
    { id: "personal", personal: true, projects: [], threads: [], taskIds: [] },
    { id: "north", personal: false, projects: [{ key: "api", name: "api", repo: "example/api", localProjectId: null, hostedProjectId: "p1", connected: true }], threads: [], taskIds: [] },
  ]);
  spaceNavigation.getState().select("north");
  expect(newThreadRow().getAttribute("aria-current")).toBe("page");
});

it("lights no row while the frozen screen stands in for the organization's work", () => {
  spaceNavigation.getState().initialize("account-a", "personal", [
    { id: "personal", personal: true, projects: [], threads: [], taskIds: [] },
    { id: "north", personal: false, projects: [{ key: "api", name: "api", repo: "example/api", localProjectId: null, hostedProjectId: "p1", connected: true }], threads: [], taskIds: [] },
  ]);
  spaceNavigation.getState().select("north");
  gate.frozen = true;
  render(
    <OrganizationContext.Provider value={actions}>
      <SidebarNav route={{ view: "tasks" }} projectId={null} />
    </OrganizationContext.Provider>,
  );
  expect(screen.getAllByRole("button").filter((row) => row.getAttribute("aria-current") === "page")).toEqual([]);
});
