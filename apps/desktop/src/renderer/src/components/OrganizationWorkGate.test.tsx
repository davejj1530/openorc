import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OrganizationAccess } from "@openorc/protocol";
import { spaceNavigation } from "../lib/space-navigation";
import type { Route } from "../lib/router";
import { OrganizationWorkGate } from "./OrganizationWorkGate";
import { OrganizationContext, type OrganizationActions } from "../lib/organization-context";
import { core } from "../lib/rpc";

const gate = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("../lib/organization-content-gate", () => ({ useOrganizationContentGate: () => gate.state }));
vi.mock("./TopBar", () => ({ TopBar: ({ children }: { children: React.ReactNode }) => <header>{children}</header> }));
vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(async () => ({})), onReady: () => () => {}, onPush: () => () => {} } }));

afterEach(() => {
  cleanup();
  if (spaceNavigation.getState().key) spaceNavigation.getState().end();
});

const message = "You need Pro to use an organization. Open Account or ask an admin for a seat.";
const frozen: OrganizationAccess = { state: "frozen", reason: "no_pro", until: null, message };
const space = (role: "admin" | "member") => ({ id: "north", kind: "organization", name: "Northwind", logo: null, memberId: "m1", role, memberCount: 2 });
const state = (blocked: string | null, role: "admin" | "member" = "member") => ({
  allowed: blocked === null,
  blocked,
  space: space(role),
  access: blocked === "frozen" ? frozen : { state: "active", reason: null, until: null, message: null },
  identity: "x",
  generation: 1,
  error: null,
});

beforeEach(() => {
  spaceNavigation.getState().initialize("walk", "personal", [
    { id: "personal", personal: true, projects: [], threads: [], taskIds: [] },
    { id: "north", personal: false, projects: [], threads: [], taskIds: [] },
  ]);
  spaceNavigation.getState().select("north");
});

const shows = (route: Route) => {
  render(
    <OrganizationWorkGate route={route}>
      <p>Team work</p>
    </OrganizationWorkGate>,
  );
  return { work: screen.queryByText("Team work") !== null, frozen: screen.queryByText(message) !== null };
};

it.each<Route>([{ view: "newthread" }, { view: "thread", threadId: "t1" }, { view: "tasks" }, { view: "people", spaceId: "north" }])(
  "shows a frozen member the frozen screen instead of the organization's work: %j",
  (route) => {
    gate.state = state("frozen");
    expect(shows(route)).toEqual({ work: false, frozen: true });
    expect(screen.getByRole("button", { name: "Upgrade to Pro" })).toBeTruthy();
  },
);

it("keeps a frozen person's own settings open, and People and Seats open to a frozen admin", () => {
  gate.state = state("frozen", "admin");
  expect(shows({ view: "settings", section: "account" })).toEqual({ work: true, frozen: false });
  cleanup();
  expect(shows({ view: "people", spaceId: "north" })).toEqual({ work: true, frozen: false });
  cleanup();
  expect(shows({ view: "tasks" })).toEqual({ work: false, frozen: true });
});

it("changes nothing for an organization that is open or still being read, or for Personal", () => {
  gate.state = state(null);
  expect(shows({ view: "newthread" })).toEqual({ work: true, frozen: false });
  cleanup();
  gate.state = state("loading");
  expect(shows({ view: "newthread" })).toEqual({ work: true, frozen: false });
  cleanup();
  spaceNavigation.getState().select("personal");
  gate.state = state("frozen");
  expect(shows({ view: "newthread" })).toEqual({ work: true, frozen: false });
});

it("lets a frozen member leave from the organization page's own menu, which holds nothing else", async () => {
  gate.state = state("frozen");
  const refresh = vi.fn(async () => {});
  render(
    <QueryClientProvider client={new QueryClient()}>
      <OrganizationContext.Provider value={{ refresh } as unknown as OrganizationActions}>
        <OrganizationWorkGate route={{ view: "tasks" }}>
          <p>Team work</p>
        </OrganizationWorkGate>
      </OrganizationContext.Provider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "More for Northwind" }));
  expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["Leave organization…"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Leave organization…" }));
  const dialog = await screen.findByRole("dialog", { name: "Leave Northwind?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Leave organization" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expect(vi.mocked(core.call)).toHaveBeenCalledWith("organization.leave", { spaceId: "north" });
});

it("gives a frozen admin's frozen screen no menu: their own People page keeps the organization's", () => {
  gate.state = state("frozen", "admin");
  render(
    <OrganizationWorkGate route={{ view: "tasks" }}>
      <p>Team work</p>
    </OrganizationWorkGate>,
  );
  expect(screen.queryByRole("button", { name: "More for Northwind" })).toBeNull();
});
