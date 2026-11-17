import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { AccountDeletion } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { AccountDeletionDialog } from "./AccountDeletionDialog";
import { queryClient } from "../lib/client";
import { useRouter } from "../lib/router";
import { core } from "../lib/rpc";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

const ADA = "ada@example.com";
const plan: AccountDeletion = {
  email: ADA,
  deleted: [{ id: "solo", name: "Ada Studio", image: null, seats: true }],
  left: [{ id: "birch", name: "Birch Studio", image: null }],
  held: [],
  pro: "paid",
};

function show(answer: AccountDeletion, onClose = vi.fn()) {
  const calls: { method: string; params: unknown }[] = [];
  vi.mocked(core.call).mockImplementation(async (method: string, params: unknown) => {
    calls.push({ method, params });
    if (method === "account.deletion") return answer;
    if (method === "account.delete" && (params as { otp: string }).otp === "000000") throw new Error("That code isn't right. Check your email and try again.");
    return { state: "signed-out", signingIn: null, ended: false, error: null };
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AccountDeletionDialog onClose={onClose} />
    </QueryClientProvider>,
  );
  return { calls, onClose };
}

it("lists what goes one to a line, asks for the address typed out, then the emailed code, and deletes", async () => {
  const { calls, onClose } = show(plan);
  for (const line of [
    "Your Personal space, its cloud threads, projects and saved work",
    "Ada Studio and everything in it, its seats ending without a refund",
    "Your place in Birch Studio",
    "Your Pro, ending now without a refund",
    "Your cloud sign-ins, connectors, skills and machines",
  ])
    expect(await screen.findByText(line)).toBeTruthy();
  const send = screen.getByRole("button", { name: "Send code" });
  expect(send).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText(`Type ${ADA} to confirm`), { target: { value: " ADA@example.com " } });
  fireEvent.click(send);
  const code = await screen.findByLabelText("Code from your email");
  expect(calls.map((call) => call.method)).toContain("account.deletion.code");
  const destroy = screen.getByRole("button", { name: "Delete account" });
  fireEvent.change(code, { target: { value: "00-00 00x" } });
  expect((code as HTMLInputElement).value).toBe("000000");
  fireEvent.click(destroy);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "That code isn't right. Check your email and try again.");
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.change(code, { target: { value: "123456" } });
  fireEvent.click(destroy);
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(calls.filter((call) => call.method === "account.delete").at(-1)?.params).toEqual({ email: " ADA@example.com ", otp: "123456" });
});

it("offers nothing to send while an organization holds it, only why and the way to its people", async () => {
  const { calls, onClose } = show({
    ...plan,
    held: [{ id: "birch", name: "Birch Studio", image: null, reason: "You're the only admin of Birch Studio. Make someone else an admin first, or remove its other members." }],
  });
  expect(await screen.findByText("You're the only admin of Birch Studio. Make someone else an admin first, or remove its other members.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send code" })).toBeNull();
  expect(screen.queryByLabelText(`Type ${ADA} to confirm`)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open Birch Studio" }));
  expect(onClose).toHaveBeenCalled();
  expect(useRouter.getState().route).toMatchObject({ view: "people", spaceId: "birch" });
  expect(calls.map((call) => call.method)).toEqual(["account.deletion"]);
});
