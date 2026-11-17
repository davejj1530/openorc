import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { accountDay } from "@openorc/client";
import { queryClient } from "../lib/client";
import { organizationContentGate } from "../lib/organization-content-gate";
import { OrganizationMembershipDialog, type MembershipAction } from "./OrganizationMembershipDialog";

const mock = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../lib/rpc", () => ({ core: { call: mock.call, onPush: () => () => {}, onReady: () => () => {} } }));
const organization = { id: "birch", name: "Birch Studio", logo: null };
const cases: { action: MembershipAction; label: string; completed: string; method: string }[] = [
  {
    action: {
      kind: "remove",
      organization,
      person: { memberId: "member", userId: "person", name: "Alex Rivera", email: "alex@example.com", image: null, role: "member", plan: "free", joinedAt: 1 },
    },
    label: "Remove Alex",
    completed: "Alex was removed.",
    method: "organization.member.remove",
  },
  { action: { kind: "leave", organization }, label: "Leave organization", completed: "You left Birch Studio.", method: "organization.leave" },
  { action: { kind: "delete", organization }, label: "Delete organization", completed: "Birch Studio was deleted.", method: "organization.delete" },
];

beforeEach(() => {
  vi.resetAllMocks();
  queryClient.clear();
  mock.call.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

it.each(cases)("keeps $label completed while its following read is retried", async ({ action, label, completed, method }) => {
  const retry = Promise.withResolvers<void>();
  const done = vi.fn().mockRejectedValueOnce(new Error("OpenOrc Cloud can't be reached.")).mockReturnValue(retry.promise);
  const close = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <OrganizationMembershipDialog action={action} onClose={close} onDone={done} />
    </QueryClientProvider>,
  );
  if (action.kind === "delete") fireEvent.change(screen.getByLabelText("Type Birch Studio to confirm"), { target: { value: "Birch Studio" } });
  fireEvent.click(screen.getByRole("button", { name: label }));
  await screen.findByText(completed);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect((await screen.findByRole("button", { name: "Trying…" })).hasAttribute("disabled")).toBe(true);
  expect(screen.queryByRole("button", { name: label })).toBeNull();
  expect(screen.getByText(completed)).toBeTruthy();
  expect(document.querySelector(".organization-membership-detail")).toBeNull();
  expect(done).toHaveBeenCalledTimes(2);
  expect(close).not.toHaveBeenCalled();
  retry.resolve();
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(mock.call.mock.calls.filter(([name]) => name === method)).toHaveLength(1);
});

it("closes the organization's content as the person leaves, before the leave's reads, and reads the gate again when refused", async () => {
  const closed = vi.spyOn(organizationContentGate, "close");
  const refreshed = vi.spyOn(organizationContentGate, "refresh").mockResolvedValue();
  const leave = Promise.withResolvers<unknown>();
  mock.call.mockImplementation((method: string) => (method === "organization.leave" ? leave.promise : Promise.resolve({})));
  render(
    <QueryClientProvider client={queryClient}>
      <OrganizationMembershipDialog action={{ kind: "leave", organization }} onClose={vi.fn()} onDone={vi.fn()} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Leave organization" }));
  await waitFor(() => expect(closed).toHaveBeenCalledWith("birch"));
  expect(refreshed).not.toHaveBeenCalled();
  leave.reject(new Error("You're the only admin of Birch Studio."));
  await waitFor(() => expect(refreshed).toHaveBeenCalledTimes(1));
  closed.mockRestore();
  refreshed.mockRestore();
});

const ENDS = Date.parse("2026-12-01T06:05:00.000Z");
const DAY = accountDay(ENDS);
it.each([
  [
    "This organization still pays for seats. Cancel the seats in billing; they will end on 2026-12-01.",
    ENDS,
    `This organization still pays for seats. Cancel the seats in billing; they will end on ${DAY}.`,
  ],
  ["This organization's seats end on 2026-12-01. You can delete the organization after they end.", ENDS, `This organization's seats end on ${DAY}. You can delete the organization after they end.`],
  [
    "This organization's billing is still being updated. Wait for it to finish before deleting the organization.",
    null,
    "This organization's billing is still being updated. Wait for it to finish before deleting the organization.",
  ],
])("leads a deletion its billing refuses to the organization's seats, with the day as every other day is written: %s", async (message, endsAt, words) => {
  mock.call.mockResolvedValue({ refusal: { message, endsAt } });
  const seats = vi.fn();
  const done = vi.fn();
  const close = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <OrganizationMembershipDialog action={{ kind: "delete", organization }} onClose={close} onDone={done} onManageSeats={seats} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText("Type Birch Studio to confirm"), { target: { value: "Birch Studio" } });
  fireEvent.click(screen.getByRole("button", { name: "Delete organization" }));
  expect((await screen.findByRole("alert")).textContent).toBe(words);
  expect(screen.queryByRole("button", { name: "Delete organization" })).toBeNull();
  // Nothing is left to confirm once its billing refuses it, and nothing was deleted.
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByText("Birch Studio was deleted.")).toBeNull();
  expect(done).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Manage seats" }));
  expect(seats).toHaveBeenCalledOnce();
  expect(mock.call.mock.calls.filter(([name]) => name === "organization.delete")).toHaveLength(1);
});

it("keeps Delete organization for any other refusal", async () => {
  mock.call.mockRejectedValue(new Error("Only an admin can do that."));
  render(
    <QueryClientProvider client={queryClient}>
      <OrganizationMembershipDialog action={{ kind: "delete", organization }} onClose={() => {}} onDone={() => {}} onManageSeats={() => {}} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText("Type Birch Studio to confirm"), { target: { value: "Birch Studio" } });
  fireEvent.click(screen.getByRole("button", { name: "Delete organization" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Delete organization" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Manage seats" })).toBeNull();
});
