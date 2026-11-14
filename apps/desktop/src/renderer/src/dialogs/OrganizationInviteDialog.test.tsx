import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OrganizationInviteResult } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { invitationAddresses } from "../lib/organization-invitations";
import { OrganizationInviteDialog } from "./OrganizationInviteDialog";

const mock = vi.hoisted(() => ({ call: vi.fn(), send: vi.fn(), role: "admin" }));
vi.mock("../lib/rpc", () => ({ core: { call: mock.call, onPush: () => () => {}, onReady: () => () => {} } }));
const organization = { id: "birch", name: "Birch Studio", logo: null };
const close = vi.fn();
const view = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  mock.role = "admin";
  mock.send.mockImplementation(async (email: string) => sent(email));
  mock.call.mockImplementation(async (method, params) => {
    if (method === "organization.people") return { viewer: { role: mock.role } };
    if (method === "organization.invite") return [await mock.send(params.emails[0])];
    throw new Error(`Unexpected ${method}`);
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
function sent(email: string): Extract<OrganizationInviteResult, { state: "sent" }> {
  return {
    email,
    state: "sent",
    invitationId: email,
    error: null,
    invitation: { id: email, email, role: "member", expiresAt: 1000, state: "pending", url: "https://app.example.com/invite/one", delivery: { status: "sent", reason: null, at: 1 }, resendAt: 600001 },
  };
}
function show() {
  return render(
    <QueryClientProvider client={queryClient}>
      <OrganizationInviteDialog organization={organization} onClose={close} onViewInvitations={view} />
    </QueryClientProvider>,
  );
}
const type = (value: string) => fireEvent.change(screen.getByRole("textbox", { name: "Email addresses" }), { target: { value } });
async function submit() {
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send invitations" }).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Send invitations" }));
}

it("splits all supported separators, normalizes duplicates and refuses incomplete addresses before sending", async () => {
  expect(invitationAddresses("MIRA@example.com, jules@example.com; mira@example.com\n tess@\tlee@example.com")).toEqual({
    emails: ["mira@example.com", "jules@example.com", "tess@", "lee@example.com"],
    duplicates: ["mira@example.com"],
    invalid: ["tess@"],
  });
  show();
  type("mira@example.com\ninvalid@\nmira@example.com");
  expect(screen.getByText("Already added.")).toBeTruthy();
  expect(screen.getByText("Enter a full email address.")).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send invitations" }).disabled).toBe(true);
  type("MIRA@example.com; mira@example.com");
  await submit();
  await screen.findByRole("dialog", { name: "Invitations sent" });
  expect(mock.send).toHaveBeenCalledExactlyOnceWith("mira@example.com");
});

it("keeps successful addresses visible and retries only refusals, including rolling-limit refusals", async () => {
  let refused = true;
  mock.send.mockImplementation(async (email: string) =>
    email.startsWith("jules") && refused ? { email, state: "refused", error: "You've sent 20 invitations in the past 24 hours. Try again later." } : sent(email),
  );
  show();
  type("mira@example.com\njules@example.com");
  await submit();
  await screen.findByRole("button", { name: "Try again" });
  expect(screen.getByText("Sent")).toBeTruthy();
  expect(screen.getByText("You've sent 20 invitations in the past 24 hours. Try again later.")).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Try again" }).disabled).toBe(false);
  refused = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("dialog", { name: "Invitations sent" });
  expect(mock.send.mock.calls.map(([email]) => email)).toEqual(["mira@example.com", "jules@example.com", "jules@example.com"]);
  fireEvent.click(screen.getByRole("button", { name: "View invitations" }));
  expect(close).toHaveBeenCalledOnce();
  expect(view).toHaveBeenCalledOnce();
});

it("starts a new send after editing and keeps the typed addresses when permission changes", async () => {
  mock.send.mockImplementation(async (email: string) => ({ email, state: "refused", error: "OpenOrc Cloud can't be reached." }));
  show();
  type("mira@example.com");
  await submit();
  await screen.findByRole("button", { name: "Try again" });
  type("jules@example.com");
  expect(screen.getByRole("button", { name: "Send invitations" })).toBeTruthy();
  mock.role = "member";
  await queryClient.invalidateQueries({ queryKey: ["organization.people"] });
  await screen.findByText("Only an admin can do that.");
  expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("jules@example.com");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send invitations" }).disabled).toBe(true);
});

it("never calls failed or logged delivery Sent and keeps admitted invitations out of retry", async () => {
  mock.send.mockImplementation(async (email: string) => ({ ...sent(email), invitation: { ...sent(email).invitation, delivery: { status: "logged", reason: null, at: 1 } } }));
  show();
  type("mira@example.com");
  await submit();
  await screen.findByRole("dialog", { name: "Invitations" });
  expect(screen.getByText("Not emailed")).toBeTruthy();
  expect(screen.queryByText("Sent")).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

it("stops the remaining addresses on close while the admitted request is still pending", async () => {
  let resolve: ((value: OrganizationInviteResult) => void) | undefined;
  mock.send.mockImplementation(
    () =>
      new Promise<OrganizationInviteResult>((done) => {
        resolve = done;
      }),
  );
  const rendered = show();
  type("mira@example.com\njules@example.com");
  await submit();
  await waitFor(() => expect(resolve).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  rendered.unmount();
  resolve!(sent("mira@example.com"));
  await Promise.resolve();
  expect(close).toHaveBeenCalledOnce();
  expect(mock.send).toHaveBeenCalledExactlyOnceWith("mira@example.com");
});
