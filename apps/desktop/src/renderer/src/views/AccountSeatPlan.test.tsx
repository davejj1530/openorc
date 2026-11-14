import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { AccountStatus, OrganizationAccess, SpacesStatus } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { AccountSettings } from "./settings-account";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});
const account: Extract<AccountStatus, { state: "signed-in" }> = {
  state: "signed-in",
  email: "person@example.com",
  name: "Alex",
  image: null,
  reach: "live",
  plan: { pro: true, standing: "live", at: 1800000000000 },
  hours: { leftSeconds: 147600, monthly: { grantedSeconds: 360000, leftSeconds: 147600, resetsAt: 1800000000000 }, packsLeftSeconds: 0 },
  sandbox: null,
  signIns: null,
  signingIn: {},
  github: null,
  connectingGithub: null,
  projects: [],
  paying: null,
  error: null,
  organizationAccess: { state: "active", reason: null, until: null, message: null },
  allowanceSource: { kind: "organization", organizationId: "team", organizationName: "Studio" },
  paidBy: "organization",
};
function show(value = account, member = false) {
  const spaces: SpacesStatus = {
    state: "ready",
    userId: "person",
    apiOrigin: "https://account.example.com",
    personalSpaceId: "personal",
    spaces: [
      { id: "personal", kind: "personal" },
      ...(member ? [{ id: "team", kind: "organization" as const, name: "Studio", logo: null, memberId: "member", role: "member" as const, memberCount: 1 }] : []),
    ],
    create: { allowed: false, reason: null },
    invitations: [],
    reach: "live",
    heardAt: 0,
    error: null,
  };
  vi.mocked(core.call).mockImplementation(async (method) => {
    if (method === "account.offers") return { monthlySeconds: 360000, pro: [], hours: { seconds: 180000, months: 12, price: null } };
    return method === "spaces.status" ? spaces : value;
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AccountSettings active />
    </QueryClientProvider>,
  );
}

it("names only the selected funding source and expands the existing personal checkout", async () => {
  show();
  expect(await screen.findByText("Paid by Studio")).toBeTruthy();
  expect(screen.getByText("41 h left")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Manage billing" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Pay for Pro yourself" }));
  fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("account.billing.open", { page: "pro", period: "monthly" }));
});

it("shows own funding without pooling an unused organization's seat", async () => {
  show({ ...account, paidBy: "self", allowanceSource: { kind: "self" } });
  expect(await screen.findByText(/Paid by you/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Manage billing" })).toBeTruthy();
  expect(screen.queryByText(/Studio/)).toBeNull();
  expect(screen.getByText("41 h left")).toBeTruthy();
});

it.each([
  ["seat_removed", "Your seat was taken back; you have one day to get Pro to keep using organizations."],
  ["payment_failed", "Payment for your Pro needs attention; you have one day to fix it."],
  ["subscription_ended", "Your Pro subscription ended; you have one day to get Pro to keep using organizations."],
] as const)("keeps the private %s sentence, deadline and packs together", async (reason, message) => {
  const access: OrganizationAccess = { state: "grace", reason, until: Date.now() + 86400000, message };
  show({
    ...account,
    plan: { pro: true, standing: "grace", at: access.until },
    organizationAccess: access,
    allowanceSource: null,
    hours: { monthly: null, leftSeconds: 21600, packsLeftSeconds: 21600 },
  });
  expect(await screen.findByText(message)).toBeTruthy();
  expect(screen.getByText(/^Until /)).toBeTruthy();
  expect(screen.getByText("6 h bought")).toBeTruthy();
  expect(screen.getByText("6 h left")).toBeTruthy();
  expect(screen.queryByText(/this month/)).toBeNull();
  expect(screen.getByRole("button", { name: "Upgrade to Pro" })).toBeTruthy();
});

it("keeps a person's own payment recovery on the existing Update payment action", async () => {
  const until = Date.now() + 86400000;
  show({
    ...account,
    plan: { pro: true, standing: "grace", at: until },
    allowanceSource: null,
    paidBy: "self",
    organizationAccess: { state: "grace", reason: "payment_failed", until, message: "Payment for your Pro needs attention; you have one day to fix it." },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Update payment" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("account.billing.open", { page: "billing" }));
});

it("keeps frozen recovery private and never offers organization billing in Account", async () => {
  show({
    ...account,
    plan: { pro: false },
    hours: null,
    allowanceSource: null,
    paidBy: null,
    organizationAccess: { state: "frozen", reason: "seat_removed", until: null, message: "Your seat was taken back, and your day of grace has ended." },
  });
  expect(await screen.findByText("Your seat was taken back, and your day of grace has ended.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Upgrade to Pro" })).toBeTruthy();
  expect(screen.getByText("Cloud hours")).toBeTruthy();
  expect(screen.getByText("Not available")).toBeTruthy();
  expect(screen.queryByText(/\d+ h left/)).toBeNull();
  expect(screen.queryByRole("button", { name: /Buy/ })).toBeNull();
});

it.each([0, 21600])("shows only the confirmed frozen hours total %i without offering another pack", async (leftSeconds) => {
  show({
    ...account,
    plan: { pro: false },
    hours: { leftSeconds, monthly: null, packsLeftSeconds: leftSeconds },
    allowanceSource: null,
    paidBy: null,
    organizationAccess: { state: "frozen", reason: "seat_removed", until: null, message: "Your seat was taken back, and your day of grace has ended." },
  });
  expect(await screen.findByText(`${leftSeconds / 3600} h left`)).toBeTruthy();
  if (leftSeconds === 0) expect(screen.getByText("No hours available")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Buy/ })).toBeNull();
});

it("keeps a never-paid account with no bought hours on its existing Free rows", async () => {
  show({
    ...account,
    plan: { pro: false },
    hours: null,
    allowanceSource: null,
    paidBy: null,
    organizationAccess: { state: "frozen", reason: "no_pro", until: null, message: "You need Pro to use an organization. Open Account or ask an admin for a seat." },
  });
  expect(await screen.findByRole("button", { name: "Upgrade to Pro" })).toBeTruthy();
  expect(screen.queryByText("Cloud hours")).toBeNull();
  expect(screen.queryByText("0 h left")).toBeNull();
  expect(await screen.findByText("Pro includes 100 cloud hours a month.")).toBeTruthy();
  expect(screen.queryByText(/You need Pro to use an organization/)).toBeNull();
});

it("gives a never-paid organization member the exact private reason without adding a zero hours row", async () => {
  const message = "You need Pro to use an organization. Open Account or ask an admin for a seat.";
  show({ ...account, plan: { pro: false }, hours: null, allowanceSource: null, paidBy: null, organizationAccess: { state: "frozen", reason: "no_pro", until: null, message } }, true);
  expect(await screen.findByText(message)).toBeTruthy();
  expect(screen.queryByText("Cloud hours")).toBeNull();
  expect(screen.queryByText(/Pro includes/)).toBeNull();
});
