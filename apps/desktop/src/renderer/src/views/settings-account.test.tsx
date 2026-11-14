import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { AccountStatus } from "@openorc/protocol";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { AccountSettings } from "./settings-account";
import { OpenOrcCloudSection } from "./settings-cloud-openorc";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
vi.mock("../components/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../components/ui")>()),
  Tooltip: ({ label, children }: { label: string; children: ReactNode }) => <span data-tooltip={label}>{children}</span>,
}));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

const ADA = "ada@example.com";
const signedOut: Extract<AccountStatus, { state: "signed-out" }> = { state: "signed-out", codeSentTo: null, ended: false, error: null };
const pro: Extract<AccountStatus, { state: "signed-in" }> = {
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
  signIns: [{ agent: "claude", provider: "anthropic", label: "Claude Max", ended: false }],
  signingIn: {},
  github: null,
  connectingGithub: null,
  paying: null,
  projects: [],
  error: null,
};

/** A core that keeps one account status and answers every account call with it, as the real one does. */
function fakeCore(start: AccountStatus, signedIn: AccountStatus = pro) {
  let status = start;
  vi.mocked(core.call).mockImplementation(async (method: string, params: unknown) => {
    const p = params as { email?: string; code?: string; service?: string };
    if (method === "projects.list") return [];
    if (method === "account.sendCode") status = { ...signedOut, codeSentTo: p.email! };
    if (method === "account.signIn") {
      if (p.code !== "123456") throw new Error("Invalid OTP");
      status = signedIn;
    }
    if (method === "account.signOut") status = signedOut;
    if (method === "account.setSandbox" && status.state === "signed-in") status = { ...status, sandbox: { ...status.sandbox!, chosen: p.service! } };
    if (method === "account.billing.open" && status.state === "signed-in") status = { ...status, paying: { page: (params as { page: "pro" }).page, since: 0 } };
    if (method === "account.billing.leave" && status.state === "signed-in") status = { ...status, paying: null };
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

const free: AccountStatus = { ...pro, plan: { pro: false }, hours: null };
const ink = (name: string) => screen.getByRole("button", { name }).className.includes("ink-pill");

it("lets a free person upgrade, monthly or yearly, as the one ink move, and opens the checkout through the core", async () => {
  fakeCore(free);
  show(<AccountSettings active />);
  fireEvent.click(await screen.findByRole("radio", { name: "Yearly" }));
  expect(ink("Upgrade")).toBe(true);
  expect(screen.queryByRole("button", { name: "Buy more hours" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("account.billing.open", { page: "pro", period: "yearly" }));
  expect(await screen.findByText("Waiting for your payment")).toBeTruthy();
});

it.each([
  { name: "out of hours", account: { ...pro, hours: { ...pro.hours!, leftSeconds: 0 } }, move: "Buy more hours", page: { page: "hours" } },
  {
    name: "with a payment that failed",
    account: { ...pro, plan: { pro: true as const, standing: "grace" as const, at: Date.parse("2026-11-15T12:00:00Z") }, hours: { leftSeconds: 0, monthly: null, packsLeftSeconds: 0 } },
    move: "Update payment",
    page: { page: "billing" },
  },
])("puts the one move a Pro person $name needs in ink", async ({ account, move, page }) => {
  fakeCore(account);
  show(<AccountSettings active />);
  fireEvent.click(await screen.findByRole("button", { name: move }));
  expect(
    screen
      .getAllByRole("button")
      .filter((button) => button.className.includes("ink-pill"))
      .map((button) => button.textContent),
  ).toEqual([move]);
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("account.billing.open", page));
});

it("disables every move while OpenOrc Cloud can't be reached, saying why only on demand", async () => {
  fakeCore({ ...pro, reach: "offline" });
  show(<AccountSettings active />);
  for (const name of ["Manage billing", "Buy more hours"]) {
    const button = await screen.findByRole<HTMLButtonElement>("button", { name });
    expect([button.disabled, button.closest("[data-tooltip]")?.getAttribute("data-tooltip")]).toEqual([true, "OpenOrc Cloud can't be reached."]);
  }
  expect(screen.queryByText("OpenOrc Cloud can't be reached.")).toBeNull();
});

it("stops watching for the purchase once the person leaves the screen, and not before", async () => {
  fakeCore({ ...free, paying: { page: "pro", since: 0 } });
  const { rerender } = render(
    <QueryClientProvider client={queryClient}>
      <AccountSettings active />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Waiting for your payment")).toBeTruthy();
  expect(core.call).not.toHaveBeenCalledWith("account.billing.leave", {});
  rerender(
    <QueryClientProvider client={queryClient}>
      <AccountSettings active={false} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("account.billing.leave", {}));
});
