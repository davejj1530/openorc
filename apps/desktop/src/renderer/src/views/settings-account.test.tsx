import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { AccountStatus } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { AccountSettings } from "./settings-account";
import { OpenOrcCloudSection } from "./settings-cloud-openorc";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

const ADA = "ada@example.com";
const signedOut: Extract<AccountStatus, { state: "signed-out" }> = { state: "signed-out", codeSentTo: null, ended: false, error: null };
const pro: AccountStatus = {
  state: "signed-in",
  email: ADA,
  name: "Ada Lovelace",
  image: null,
  reach: "live",
  plan: { pro: true, standing: "live", at: Date.parse("2026-12-03T12:00:00Z") },
  hours: { leftSeconds: 41 * 3600, monthly: { grantedSeconds: 100 * 3600, leftSeconds: 41 * 3600, resetsAt: Date.parse("2026-12-03T12:00:00Z") }, packsLeftSeconds: 0 },
  sandbox: {
    chosen: null,
    fallback: "vercel",
    services: [
      { id: "vercel", name: "Vercel" },
      { id: "agent37", name: "Agent37" },
    ],
  },
  error: null,
};

/** A core that keeps one account status and answers every account call with it, as the real one does. */
function fakeCore(start: AccountStatus, signedIn: AccountStatus = pro) {
  let status = start;
  vi.mocked(core.call).mockImplementation(async (method: string, params: unknown) => {
    const p = params as { email?: string; code?: string; service?: string };
    if (method === "account.sendCode") status = { ...signedOut, codeSentTo: p.email! };
    if (method === "account.signIn") {
      if (p.code !== "123456") throw new Error("Invalid OTP");
      status = signedIn;
    }
    if (method === "account.signOut") status = signedOut;
    if (method === "account.setSandbox" && status.state === "signed-in") status = { ...status, sandbox: { ...status.sandbox!, chosen: p.service! } };
    return status;
  });
}

function show(node: React.ReactNode) {
  render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}

it("sends a code to the address typed, then asks for the code", async () => {
  fakeCore(signedOut);
  show(<AccountSettings active />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Email" }), { target: { value: ADA } });
  fireEvent.click(screen.getByRole("button", { name: "Send code" }));
  expect(await screen.findByText(`Sent to ${ADA}`)).toBeTruthy();
  expect(core.call).toHaveBeenCalledWith("account.sendCode", { email: ADA });
  fireEvent.click(screen.getByRole("button", { name: "Use another address" }));
  expect(screen.getByRole("textbox", { name: "Email" })).toBeTruthy();
});

it("signs in with the code and shows the person, Pro, its renewal and the hours left", async () => {
  fakeCore({ ...signedOut, codeSentTo: ADA });
  show(<AccountSettings active />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Code" }), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByRole("heading", { name: "Ada Lovelace" })).toBeTruthy();
  expect(screen.getByText(ADA)).toBeTruthy();
  expect(screen.getByText("Pro")).toBeTruthy();
  expect(screen.getByText(/^Renews /)).toBeTruthy();
  expect(screen.getByText("41 h left")).toBeTruthy();
  expect(screen.getByText("Connected")).toBeTruthy();
});

it("shows a refused code in an alert and keeps asking for one", async () => {
  fakeCore({ ...signedOut, codeSentTo: ADA });
  show(<AccountSettings active />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Code" }), { target: { value: "000000" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Invalid OTP");
  expect(screen.getByRole("textbox", { name: "Code" })).toBeTruthy();
});

it("shows Free with no cloud hours, and says when OpenOrc Cloud can't be reached", async () => {
  fakeCore({ ...pro, plan: { pro: false }, hours: null, reach: "offline" });
  show(<AccountSettings active />);
  expect(await screen.findByText("Free")).toBeTruthy();
  expect(screen.queryByText("Cloud hours")).toBeNull();
  expect(screen.getByText("Can't be reached")).toBeTruthy();
});

it("signs out back to the address", async () => {
  fakeCore(pro);
  show(<AccountSettings active />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
  expect(await screen.findByRole("button", { name: "Send code" })).toBeTruthy();
});

it("says a session the server ended ended", async () => {
  fakeCore({ ...signedOut, ended: true });
  show(<AccountSettings active />);
  expect(await screen.findByText("Your session ended. Sign in again.")).toBeTruthy();
});

it("lets a Pro person choose where their threads run, by the server's names", async () => {
  fakeCore(pro);
  show(<OpenOrcCloudSection active />);
  const choice = await screen.findByRole<HTMLSelectElement>("combobox", { name: "Threads run on" });
  expect(choice.value).toBe("vercel");
  expect([...choice.options].map((option) => option.text)).toEqual(["Vercel", "Agent37"]);
  fireEvent.change(choice, { target: { value: "agent37" } });
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("account.setSandbox", { service: "agent37" }));
  await waitFor(() => expect(choice.value).toBe("agent37"));
});

it("offers no choice to a Free person or where the server runs threads in one place", async () => {
  fakeCore({ ...pro, plan: { pro: false }, hours: null });
  show(<OpenOrcCloudSection active />);
  await waitFor(() => expect(core.call).toHaveBeenCalled());
  expect(screen.queryByRole("combobox")).toBeNull();
  cleanup();
  queryClient.clear();
  fakeCore({ ...pro, sandbox: { chosen: null, fallback: "vercel", services: [{ id: "vercel", name: "Vercel" }] } });
  show(<OpenOrcCloudSection active />);
  await waitFor(() => expect(core.call).toHaveBeenCalled());
  expect(screen.queryByRole("combobox")).toBeNull();
});
