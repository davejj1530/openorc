import { StrictMode, type ReactNode } from "react";
import type { OrganizationBillingOffers, OrganizationBillingStatus, SpacesStatus } from "@openorc/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OrganizationAccessStore } from "./organization-access-store";
import { useOrganizationBilling, type OrganizationBillingTransport } from "./organization-billing";

const empty: OrganizationBillingStatus = { billing: null, payment: null, error: null };
const quote: OrganizationBillingOffers = { offers: [], monthlySeconds: 360000, maxSeats: 100 };
const stores: OrganizationAccessStore[] = [];
afterEach(() => {
  cleanup();
  stores.splice(0).forEach((store) => store.dispose());
});

async function fixture() {
  let status: Extract<SpacesStatus, { state: "ready" }> = {
    state: "ready",
    apiOrigin: "https://example.com",
    userId: "person-a",
    personalSpaceId: "personal",
    spaces: [{ id: "team-a", kind: "organization", name: "Example team", logo: null, role: "admin", memberId: "member-a", memberCount: 1 }],
    create: { allowed: false, reason: null },
    invitations: [],
    reach: "live",
    heardAt: 1000,
    error: null,
    organizationAccess: { state: "frozen", reason: "no_pro", until: null, message: "You need Pro to work in organizations." },
  };
  const gate = new OrganizationAccessStore({ now: () => 1000, read: async () => status });
  stores.push(gate);
  await gate.refresh();
  const transport = {
    get: vi.fn(async () => empty),
    open: vi.fn(async () => empty),
    leave: vi.fn(async () => empty),
    offers: vi.fn(async () => quote),
    subscribe: vi.fn(() => () => {}),
  } satisfies OrganizationBillingTransport;
  const setRole = async (role: "admin" | "member") => {
    status = { ...status, spaces: status.spaces.map((space) => (space.kind === "organization" ? { ...space, role } : space)) };
    await act(() => gate.refresh());
  };
  return { gate, transport, setRole };
}

it("allows a frozen admin to read billing through a strict mount without starting checkout", async () => {
  const f = await fixture();
  const hook = renderHook(() => useOrganizationBilling("team-a", f.transport, f.gate), { wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> });
  await waitFor(() => expect(hook.result.current?.view.getSnapshot().status).toEqual(empty));
  expect(f.transport.open).not.toHaveBeenCalled();
});
it("removes billing on demotion and fences a quote even after admin rights return", async () => {
  const f = await fixture();
  let resolve = (_value: OrganizationBillingOffers) => {};
  f.transport.offers.mockReturnValueOnce(
    new Promise<OrganizationBillingOffers>((done) => {
      resolve = done;
    }),
  );
  const hook = renderHook(() => useOrganizationBilling("team-a", f.transport, f.gate));
  const old = hook.result.current;
  expect(old).not.toBeNull();
  const reading = old!.offers("team-a", 1);
  const refusal = expect(reading).rejects.toThrow("access changed");
  await f.setRole("member");
  expect(hook.result.current).toBeNull();
  expect(old!.view.getSnapshot().status).toBeNull();
  await f.setRole("admin");
  resolve(quote);
  await refusal;
  expect(hook.result.current).not.toBe(old);
});
it("blocks an old offers callback after its screen unmounts", async () => {
  const f = await fixture();
  const hook = renderHook(() => useOrganizationBilling("team-a", f.transport, f.gate));
  const old = hook.result.current!;
  hook.unmount();
  await expect(old.offers("team-a", 1)).rejects.toThrow("access changed");
  expect(f.transport.offers).not.toHaveBeenCalled();
});
