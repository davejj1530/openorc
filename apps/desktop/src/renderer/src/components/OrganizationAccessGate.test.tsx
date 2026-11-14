import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { OrganizationAccess, SpacesStatus } from "@openorc/protocol";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { OrganizationAccessGate, FrozenOrganization } from "./OrganizationAccessGate";
import { organizationContentGate } from "../lib/organization-content-gate";
import { core } from "../lib/rpc";
import { useRouter } from "../lib/router";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
vi.mock("../lib/window", () => ({ useTrafficLights: () => true, useWindowsControls: () => false, useWindowMaximized: () => false }));
vi.mock("./HeaderOrcling", () => ({ HeaderOrcling: () => null }));
const organization = { id: "team-a", name: "Example team", logo: null };
const frozen: Extract<OrganizationAccess, { state: "frozen" }> = {
  state: "frozen",
  reason: "no_pro",
  until: null,
  message: "You need Pro to use an organization. Open Account or ask an admin for a seat.",
};
const active: OrganizationAccess = { state: "active", reason: null, until: null, message: null };
function spaces(access: OrganizationAccess): SpacesStatus {
  return {
    state: "ready",
    userId: "person-a",
    apiOrigin: "https://example.com",
    personalSpaceId: "personal",
    spaces: [{ ...organization, kind: "organization", role: "member", memberId: "member-a", memberCount: 1 }],
    create: { allowed: false, reason: null },
    invitations: [],
    reach: "live",
    heardAt: Date.now(),
    organizationAccess: access,
    error: null,
  };
}
afterEach(() => {
  cleanup();
  organizationContentGate.reset();
  vi.resetAllMocks();
  vi.useRealTimers();
});

it("shows only the organization identity, exact private sentence and existing Account recovery", async () => {
  vi.mocked(core.call).mockImplementation(async () => spaces(frozen));
  render(
    <OrganizationAccessGate spaceId="team-a">
      <div>Private thread body and composer</div>
    </OrganizationAccessGate>,
  );
  expect(await screen.findByText(frozen.message)).toBeTruthy();
  expect(screen.queryByText("Private thread body and composer")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
  expect(useRouter.getState().route).toEqual({ view: "settings", section: "account" });
  expect(core.call).not.toHaveBeenCalledWith("account.billing.open", expect.anything());
});

it("unmounts protected content at grace expiry without deleting its consumer's private draft", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const grace: OrganizationAccess = { state: "grace", reason: "seat_removed", until: 2000, message: "Your seat was taken back; you have one day to get Pro to keep using organizations." };
  vi.mocked(core.call).mockResolvedValue(spaces(grace));
  function Draft() {
    const [draft, setDraft] = useState("");
    return (
      <OrganizationAccessGate spaceId="team-a">
        <textarea aria-label="Draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
      </OrganizationAccessGate>
    );
  }
  render(<Draft />);
  await act(async () => {
    await organizationContentGate.refresh();
  });
  expect(screen.getByRole("textbox", { name: "Draft" })).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Draft" }), { target: { value: "Keep my private draft" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(screen.queryByRole("textbox", { name: "Draft" })).toBeNull();
  expect(screen.getByText("Your seat was taken back, and your day of grace has ended.")).toBeTruthy();
  vi.mocked(core.call).mockResolvedValue(spaces(active));
  await act(async () => {
    await organizationContentGate.refresh();
  });
  expect(screen.getByRole("textbox", { name: "Draft" }).getAttribute("value") ?? screen.getByRole("textbox", { name: "Draft" }).textContent).toBe("Keep my private draft");
});

it("withholds cached content before the initial authority read and reopens only after active access", async () => {
  let done: (value: SpacesStatus) => void = () => undefined;
  vi.mocked(core.call).mockImplementation(
    () =>
      new Promise<SpacesStatus>((resolve) => {
        done = resolve;
      }),
  );
  render(
    <OrganizationAccessGate spaceId="team-a">
      <div>Protected body</div>
    </OrganizationAccessGate>,
  );
  expect(screen.queryByText("Protected body")).toBeNull();
  await act(async () => {
    await Promise.resolve();
    done(spaces(active));
  });
  expect(screen.getByText("Protected body")).toBeTruthy();
});

it.each([
  ["payment_failed", "Payment for your Pro wasn't completed within a day."],
  ["subscription_ended", "Your Pro subscription ended, and your day of grace has ended."],
] as const)("renders the server's private %s sentence without adding other payer facts", (_reason, message) => {
  render(<FrozenOrganization organization={organization} access={{ ...frozen, reason: _reason, message }} onAccount={() => {}} />);
  expect(screen.getByText(message)).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Upgrade to Pro" })).toHaveLength(1);
});
