import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OrganizationSpace, SpacesStatus } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { OrganizationContext, type OrganizationActions } from "../lib/organization-context";
import { core } from "../lib/rpc";
import { SpaceSwitcher } from "./SpaceSwitcher";
import { TooltipProvider } from "./ui";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onPush: () => () => {}, onReady: () => () => {} } }));
vi.mock("../lib/browser-preview", () => ({ CoversPreview: () => null }));
const organization: OrganizationSpace = { id: "birch", kind: "organization", name: "Birch Studio", logo: null, role: "admin", memberId: "admin", memberCount: 3 };
const status: SpacesStatus = {
  state: "ready",
  userId: "person",
  apiOrigin: "https://cloud.example.com",
  personalSpaceId: "personal",
  spaces: [{ id: "personal", kind: "personal" }, organization],
  create: { allowed: true, reason: null },
  invitations: [],
  reach: "live",
  heardAt: 1,
  error: null,
};
function actions(patch: Partial<OrganizationActions> = {}): OrganizationActions {
  return {
    signedIn: true,
    person: "Alex Rivera",
    status,
    organization,
    error: null,
    dialog: null,
    pendingLogo: null,
    invitations: { decision: null, open: vi.fn(), close: vi.fn(), respond: vi.fn() },
    close: vi.fn(),
    create: vi.fn(),
    invite: vi.fn(),
    addProjects: vi.fn(),
    people: vi.fn(),
    select: vi.fn(),
    refresh: vi.fn(),
    logoSaved: vi.fn(),
    ...patch,
  };
}
let queries = new QueryClient();
function view(value: OrganizationActions) {
  return (
    <QueryClientProvider client={queries}>
      <TooltipProvider>
        <OrganizationContext.Provider value={value}>
          <SpaceSwitcher fallback={<span>Wordmark</span>} />
        </OrganizationContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
beforeEach(() => {
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The switcher's account-wide reads live in the app's own client, which outlasts each test's.
  queryClient.clear();
  vi.mocked(core.call).mockReset();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps the old wordmark when signed out and never renders a switcher", () => {
  render(view(actions({ signedIn: false, organization: null })));
  expect(screen.getByText("Wordmark")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});

it("opens complete admin actions, reacts to a role change while open and restores keyboard focus", async () => {
  const value = actions();
  const mounted = render(view(value));
  const trigger = screen.getByRole("button", { name: "Switch space, Birch Studio" });
  fireEvent.click(trigger);
  expect(await screen.findByRole("menuitem", { name: "People" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Invite people…" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Create organization…" })).toBeTruthy();
  mounted.rerender(view({ ...value, organization: { ...organization, role: "member" } }));
  expect(screen.queryByRole("menuitem", { name: "Invite people…" })).toBeNull();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it("keeps Personal checked on a first read failure with an explicit retry and a disabled create reason", async () => {
  const error = "OpenOrc Cloud can't be reached.";
  const value = actions({ status: { state: "loading", error }, organization: null, error });
  render(view(value));
  fireEvent.click(screen.getByRole("button", { name: "Switch space, OpenOrc" }));
  const personal = await screen.findByRole("menuitemradio", { name: "Personal Alex Rivera" });
  expect(personal.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("menuitem", { name: "Create organization…" }).hasAttribute("data-disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(value.refresh).toHaveBeenCalledTimes(1));
  expect(value.create).not.toHaveBeenCalled();
  expect(screen.queryByLabelText(/invitation waiting/)).toBeNull();
});

it("adds an unread mention to the one neutral dot, in the open space too, with its words on demand and on its menu mark", async () => {
  vi.mocked(core.call).mockImplementation((async (method: string) => (method === "spaces.mentions" ? { spaceIds: ["birch"] } : undefined)) as typeof core.call);
  render(view(actions()));
  await waitFor(() => expect(screen.getByLabelText("Unread mention in Birch Studio")).toBeTruthy());
  expect(screen.getByRole("button", { name: "Switch space, Birch Studio, unread mention in Birch Studio" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Switch space/ }));
  const row = await screen.findByRole("menuitemradio", { name: /Birch Studio/ });
  expect(row.querySelector('[aria-label="Unread mention"]')).toBeTruthy();
});

it("adds unread chat in another organization to the one neutral dot, with its words on demand and on its menu row", async () => {
  vi.mocked(core.call).mockImplementation((async (method: string) => (method === "teamChat.unreadSpaces" ? { spaceIds: ["birch"] } : undefined)) as typeof core.call);
  render(view(actions({ organization: null })));
  const trigger = await screen.findByRole("button", { name: "Switch space, OpenOrc, unread chat in Birch Studio" });
  expect(screen.getByLabelText("Unread chat in Birch Studio")).toBeTruthy();
  fireEvent.click(trigger);
  const row = await screen.findByRole("menuitemradio", { name: /Birch Studio/ });
  expect(row.querySelector('[aria-label="Unread chat"]')).toBeTruthy();
});
