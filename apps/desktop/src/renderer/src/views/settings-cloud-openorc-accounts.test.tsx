import type { AccountSignIn, AccountStatus, HostedAgent, SignInWork } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { AgentAccounts } from "./settings-cloud-openorc-accounts";
import { OpenOrcCloudSection } from "./settings-cloud-openorc";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
const mac = vi.hoisted(() => ({ accounts: [{ id: "claude-cli", name: "Personal", enabled: true }] }));
const now = Date.now();
beforeEach(() => {
  vi.mocked(core.call).mockImplementation((async (method: string, input: { cloudAccountId?: string }) => {
    if (method === "claude.accounts.list") return { accounts: mac.accounts, defaultId: "claude-cli" };
    if (method === "agents.models") return [];
    if (method === "providers.usage")
      return {
        provider: "claude",
        status: "available",
        windows:
          input.cloudAccountId === "work"
            ? [{ id: "five_hour", label: "5-hour window", usedPercent: 100, remainingPercent: null, resetsAt: now + 2 * 3_600_000 + 60_000, observedAt: now, exhausted: true }]
            : [{ id: "seven_day", label: "7-day window", usedPercent: 12, remainingPercent: null, resetsAt: now + 86_400_000, observedAt: now, exhausted: false }],
        credits: [],
      };
    return {};
  }) as never);
  window.openorc = { ...window.openorc, openExternal: vi.fn() } as never;
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
  mac.accounts = [{ id: "claude-cli", name: "Personal", enabled: true }];
});

const claude = (id: string, name: string, extra: Partial<AccountSignIn> = {}): AccountSignIn => ({
  agent: "claude",
  provider: "anthropic",
  label: "Claude Max",
  ended: false,
  id,
  name,
  isDefault: false,
  way: "token",
  ...extra,
});

function show(agent: HostedAgent, rows: AccountSignIn[], work?: SignInWork) {
  render(
    <QueryClientProvider client={queryClient}>
      <AgentAccounts agent={agent} rows={rows} work={work} />
    </QueryClientProvider>,
  );
}

const row = (name: string) => screen.getByRole("group", { name });
const called = (method: string, input: unknown) => waitFor(() => expect(core.call).toHaveBeenCalledWith(method, input));

it("lists each account with its plan, the default marked, and the limits its agent last read", async () => {
  show("claude", [claude("personal", "Personal", { isDefault: true }), claude("work", "Work"), claude("key", "API key", { label: "API key", way: "key" })]);
  expect(within(row("Personal")).getByText("Default")).toBeTruthy();
  expect(within(row("Work")).queryByText("Default")).toBeNull();
  expect(within(row("Work")).getByText("Claude Max")).toBeTruthy();
  // The plan is not said twice when it is the account's name.
  expect(within(row("API key")).getAllByText("API key")).toHaveLength(1);
  expect(await within(row("Personal")).findByText("Week 88% left")).toBeTruthy();
  expect(await within(row("Work")).findByText("5 hours used up · Resets in 2h 1m")).toBeTruthy();
  expect(core.call).toHaveBeenCalledWith("providers.usage", { provider: "claude", cloud: true, cloudAccountId: "work" });
});

it("adds an account signed in from the Mac account chosen, under its name unless another is typed", async () => {
  mac.accounts = [
    { id: "claude-cli", name: "Personal", enabled: true },
    { id: "q6", name: "q6 main", enabled: true },
  ];
  show("claude", [claude("personal", "Personal", { isDefault: true })]);
  fireEvent.click(screen.getByLabelText("Add Claude Code account"));
  fireEvent.change(await screen.findByRole("combobox", { name: "Sign in from" }), { target: { value: "q6" } });
  expect(screen.getByLabelText("Name")).toHaveProperty("placeholder", "q6 main");
  fireEvent.click(screen.getByRole("button", { name: "Sign in with Claude" }));
  await called("account.signIns.connect", { way: "token", agent: "claude", name: "q6 main", claudeAccountId: "q6" });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Client" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in with Claude" }));
  await called("account.signIns.connect", { way: "token", agent: "claude", name: "Client", claudeAccountId: "q6" });
});

it("offers the ways to add the first account at once, and a key for OpenCode with its provider", async () => {
  show("opencode", []);
  fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), { target: { value: "openrouter" } });
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-or-0123456789" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await called("account.signIns.connect", { way: "key", agent: "opencode", key: "sk-or-0123456789", provider: "openrouter" });
});

it("renames an account, makes it the default, and removes it", async () => {
  show("claude", [claude("personal", "Personal", { isDefault: true }), claude("work", "Work")]);
  const menu = async (item: string) => {
    fireEvent.click(screen.getByRole("button", { name: "More for Work" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: item }));
  };
  await menu("Make default");
  await called("account.signIns.update", { accountId: "work", isDefault: true });
  await menu("Rename");
  fireEvent.change(screen.getByLabelText("Name for Work"), { target: { value: "Client" } });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  await called("account.signIns.update", { accountId: "work", name: "Client" });
  await menu("Remove");
  await called("account.signIns.remove", { agent: "claude", accountId: "work" });
});

it("says a turn holds an account it cannot remove, in the server's words", async () => {
  vi.mocked(core.call).mockImplementation((async (method: string) => {
    if (method === "account.signIns.remove") throw new Error("A turn is running on this account. Wait for it to finish, or stop it, before removing the account.");
    return method === "claude.accounts.list" ? { accounts: mac.accounts, defaultId: "claude-cli" } : {};
  }) as never);
  show("claude", [claude("personal", "Personal", { isDefault: true }), claude("work", "Work")]);
  fireEvent.click(screen.getByRole("button", { name: "More for Work" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
  expect(await within(row("Work")).findByRole("alert")).toHaveProperty("textContent", "A turn is running on this account. Wait for it to finish, or stop it, before removing the account.");
});

it("signs a signed-out account in again the way it was made: a device code at once, a key once typed", async () => {
  show("codex", [{ agent: "codex", provider: "openai", label: "ChatGPT Pro", ended: true, id: "pro", name: "Pro", isDefault: true, way: "code" }]);
  expect(within(row("Pro")).getByText("Signed out")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
  await called("account.signIns.connect", { way: "code", agent: "codex", accountId: "pro" });
  cleanup();
  show("opencode", [{ agent: "opencode", provider: "openrouter", label: "API key", ended: true, id: "or", name: "Router", isDefault: true, way: "key" }]);
  fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
  expect(within(row("Router")).queryByRole("combobox", { name: "Provider" })).toBeNull();
  fireEvent.change(within(row("Router")).getByLabelText("API key"), { target: { value: "sk-or-new" } });
  fireEvent.click(within(row("Router")).getByRole("button", { name: "Save" }));
  await called("account.signIns.connect", { way: "key", agent: "opencode", key: "sk-or-new", accountId: "or", provider: "openrouter" });
});

it("shows a sign-in under way on the account it is for, or where a new one is added, and calls it off", async () => {
  show("claude", [claude("personal", "Personal", { isDefault: true }), claude("work", "Work", { ended: true })], { state: "waiting", way: "token", accountId: "work" });
  expect(within(row("Work")).getByText("Waiting for sign-in")).toBeTruthy();
  expect(within(row("Personal")).queryByText("Waiting for sign-in")).toBeNull();
  cleanup();
  show("codex", [], { state: "waiting", way: "code", userCode: "K7QF-29MX", verificationUrl: "https://auth.openai.com/codex/device", expiresAt: now + 60_000 });
  expect(screen.getByText("New account")).toBeTruthy();
  expect(screen.getByText("K7QF-29MX")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await called("account.signIns.cancel", { agent: "codex" });
});

it("keeps one sign-in per agent on a server without accounts", async () => {
  const status = {
    state: "signed-in",
    email: "ada@example.com",
    name: "Ada",
    image: null,
    reach: "live",
    plan: { pro: true, standing: "live", at: now + 86_400_000 },
    hours: { leftSeconds: 3600, monthly: null, packsLeftSeconds: 3600 },
    sandbox: null,
    signIns: [{ agent: "claude", provider: "anthropic", label: "Claude Max", ended: false }],
    agentAccounts: false,
    signingIn: {},
    github: null,
    connectingGithub: null,
    paying: null,
    projects: [],
    error: null,
  } satisfies AccountStatus;
  const answers: Record<string, unknown> = { "account.status": status, "claude.accounts.list": { accounts: mac.accounts, defaultId: "claude-cli" } };
  vi.mocked(core.call).mockImplementation((async (method: string) => answers[method] ?? []) as never);
  render(
    <QueryClientProvider client={queryClient}>
      <OpenOrcCloudSection active />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Ready")).toBeTruthy();
  expect(screen.queryByText("Add account")).toBeNull();
});

it("offers to switch accounts at usage limits once an agent has two, and sends the change", async () => {
  const status = {
    state: "signed-in",
    email: "ada@example.com",
    name: "Ada",
    image: null,
    reach: "live",
    plan: { pro: true, standing: "live", at: now + 86_400_000 },
    hours: { leftSeconds: 3600, monthly: null, packsLeftSeconds: 3600 },
    sandbox: null,
    signIns: [claude("personal", "Personal", { isDefault: true }), claude("work", "Work")],
    agentAccounts: true,
    switchAccountsAtLimit: true,
    signingIn: {},
    github: null,
    connectingGithub: null,
    paying: null,
    projects: [],
    error: null,
  } satisfies AccountStatus;
  const answers: Record<string, unknown> = { "account.status": status, "claude.accounts.list": { accounts: mac.accounts, defaultId: "claude-cli" } };
  vi.mocked(core.call).mockImplementation((async (method: string) => answers[method] ?? []) as never);
  render(
    <QueryClientProvider client={queryClient}>
      <OpenOrcCloudSection active />
    </QueryClientProvider>,
  );
  const toggle = await screen.findByLabelText("Switch accounts at usage limits");
  expect(toggle).toHaveProperty("checked", true);
  fireEvent.click(toggle);
  await called("account.setSwitchAtLimit", { switchAccountsAtLimit: false });
});
