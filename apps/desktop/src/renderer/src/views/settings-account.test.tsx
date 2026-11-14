import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { AccountStatus, BillingOffers } from "@openorc/protocol";
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
const signedOut: Extract<AccountStatus, { state: "signed-out" }> = { state: "signed-out", signingIn: null, ended: false, error: null };
const PAGE = "http://localhost:3600/sign-in?request=r1";
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
function fakeCore(start: AccountStatus, offers: BillingOffers | null = null) {
  let status = start;
  /** The browser hands back to the app, signed in, and the core announces it. */
  const handBack = (to: AccountStatus = pro) => {
    status = to;
    void queryClient.invalidateQueries();
  };
  vi.mocked(core.call).mockImplementation(async (method: string, params: unknown) => {
    const p = params as { service?: string };
    if (method === "projects.list") return [];
    if (method === "account.offers") return offers;
    if (method === "account.signIn") status = { ...signedOut, signingIn: { state: "waiting", page: PAGE } };
    if (method === "account.signIn.cancel") status = signedOut;
    if (method === "account.signOut") status = signedOut;
    if (method === "account.setSandbox" && status.state === "signed-in") status = { ...status, sandbox: { ...status.sandbox!, chosen: p.service! } };
    if (method === "account.billing.open" && status.state === "signed-in") status = { ...status, paying: { page: (params as { page: "pro" }).page, since: 0 } };
    if (method === "account.billing.leave" && status.state === "signed-in") status = { ...status, paying: null };
    return status;
  });
  return handBack;
}

function show(node: React.ReactNode) {
  render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}

it("opens the sign-in page, says it waits for the browser, and shows the person, Pro, its renewal and the hours left once it hands back", async () => {
  const handBack = fakeCore(signedOut);
  show(<AccountSettings active />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
  expect(await screen.findByText("Continue in your browser")).toBeTruthy();
  expect(core.call).toHaveBeenCalledWith("account.signIn", {});
  fireEvent.click(screen.getByRole("button", { name: "Open again" }));
  await waitFor(() => expect(vi.mocked(core.call).mock.calls.filter(([method]) => method === "account.signIn")).toHaveLength(2));
  handBack();
  expect(await screen.findByRole("heading", { name: "Ada Lovelace" })).toBeTruthy();
  expect(screen.getByText(ADA)).toBeTruthy();
  expect(screen.getByText("Pro")).toBeTruthy();
  expect(screen.getByText(/^Renews /)).toBeTruthy();
  expect(screen.getByText("41 h left")).toBeTruthy();
  expect(screen.getByText("Connected")).toBeTruthy();
});

it("calls a waiting sign-in off, and says in an alert why one did not finish", async () => {
  fakeCore({ ...signedOut, signingIn: { state: "waiting", page: PAGE } });
  show(<AccountSettings active />);
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  expect(await screen.findByText("Not signed in")).toBeTruthy();
  expect(core.call).toHaveBeenCalledWith("account.signIn.cancel", {});
  cleanup();
  queryClient.clear();
  fakeCore({ ...signedOut, signingIn: { state: "failed", error: "That sign-in ran out. Sign in from OpenOrc again." } });
  show(<AccountSettings active />);
  expect((await screen.findByRole("alert")).textContent).toBe("That sign-in ran out. Sign in from OpenOrc again.");
  expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
});

it("shows nothing in a build with no account server", async () => {
  fakeCore({ state: "unavailable" });
  show(<AccountSettings active />);
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("account.status", {}));
  expect(screen.queryByRole("button")).toBeNull();
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
  expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
});

it("says a session the server ended ended", async () => {
  fakeCore({ ...signedOut, ended: true });
  show(<AccountSettings active />);
  expect(await screen.findByText("Your session ended")).toBeTruthy();
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

const OFFERS: BillingOffers = {
  pro: [
    { period: "monthly", price: { amount: 2000, currency: "usd" } },
    { period: "yearly", price: { amount: 20000, currency: "usd" } },
  ],
  hours: { seconds: 50 * 3600, months: 12, price: { amount: 1000, currency: "usd" } },
};

it("prices each way of paying for Pro, and the pack on its Buy, as the server says them", async () => {
  fakeCore(free, OFFERS);
  show(<AccountSettings active />);
  fireEvent.click(await screen.findByRole("radio", { name: /200.* a year$/ }));
  expect(screen.getByRole("radio", { name: /20.* a month$/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("account.billing.open", { page: "pro", period: "yearly" }));
  cleanup();
  queryClient.clear();
  fakeCore({ ...pro, hours: { ...pro.hours!, leftSeconds: 0 } }, OFFERS);
  show(<AccountSettings active />);
  expect(ink((await screen.findByRole("button", { name: /^Buy 50 h for .*10$/ })).textContent!)).toBe(true);
});

it("shows no price and blocks nothing when the server can't say them", async () => {
  fakeCore(free, { ...OFFERS, pro: OFFERS.pro.map((offer) => ({ ...offer, price: null })) });
  show(<AccountSettings active />);
  expect(await screen.findByRole("radio", { name: "Yearly" })).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Upgrade" }).disabled).toBe(false);
});
