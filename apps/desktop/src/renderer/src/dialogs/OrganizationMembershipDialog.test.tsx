import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "../lib/client";
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
