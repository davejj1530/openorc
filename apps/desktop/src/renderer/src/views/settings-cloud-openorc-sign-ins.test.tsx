import type { AccountSignIn, HostedAgent, SignInWork } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { AgentSignInRow } from "./settings-cloud-openorc-sign-ins";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
const accounts = vi.hoisted(() => ({ list: [{ id: "claude-cli", name: "Personal", enabled: true }] }));
beforeEach(() => {
  vi.mocked(core.call).mockImplementation((async (method: string) => {
    if (method === "claude.accounts.list") return { accounts: accounts.list, defaultId: "claude-cli" };
    if (method === "agents.models") return [];
    return { state: "signed-out", signingIn: null, ended: false, error: null };
  }) as never);
  window.openorc = { ...window.openorc, openExternal: vi.fn() } as never;
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
  accounts.list = [{ id: "claude-cli", name: "Personal", enabled: true }];
});

function show(agent: HostedAgent, rows: Partial<AccountSignIn>[] = [], work?: SignInWork) {
  const full = rows.map((row) => ({ agent, provider: "anthropic", label: "Claude Max", ended: false, ...row }));
  render(
    <QueryClientProvider client={queryClient}>
      <AgentSignInRow agent={agent} rows={full} work={work} />
    </QueryClientProvider>,
  );
}

it.each([
  { agent: "claude" as const, name: "Claude Code", first: "Sign in with Claude", way: "token", other: "Use an API key" },
  { agent: "codex" as const, name: "Codex", first: "Sign in with ChatGPT", way: "code", other: "Use an API key" },
])("offers $name its ways to sign in on OpenOrc Cloud, the first starting it", async ({ agent, name, first, way, other }) => {
  show(agent);
  expect(screen.getByText(name)).toBeTruthy();
  expect(screen.getByRole("button", { name: other })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: first }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("account.signIns.connect", expect.objectContaining({ way, agent })));
});

it("makes the Claude token as the Claude account chosen, when this Mac has more than one", async () => {
  accounts.list = [
    { id: "claude-cli", name: "Personal", enabled: true },
    { id: "work", name: "Work", enabled: true },
  ];
  show("claude");
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Claude account" })).toBeTruthy());
  fireEvent.change(screen.getByRole("combobox", { name: "Claude account" }), { target: { value: "work" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in with Claude" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("account.signIns.connect", { way: "token", agent: "claude", claudeAccountId: "work" }));
});

it("hands a typed key to the core once, for OpenCode with its provider", async () => {
  show("opencode");
  fireEvent.click(screen.getByRole("button", { name: "Add a key" }));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "openrouter" } });
  fireEvent.change(screen.getByPlaceholderText("Paste key"), { target: { value: "sk-or-0123456789" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("account.signIns.connect", { way: "key", agent: "opencode", key: "sk-or-0123456789", provider: "openrouter" }));
});

it("waits on the browser for a token, and calls it off", async () => {
  show("claude", [], { state: "waiting", way: "token" });
  expect(screen.getByText("Waiting for sign-in")).toBeTruthy();
  expect(screen.getByText("Sign in to Claude in the browser that opened.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("account.signIns.cancel", { agent: "claude" }));
});

it("shows Codex's device code with the page to enter it on", () => {
  show("codex", [], { state: "waiting", way: "code", userCode: "AB12-CD34", verificationUrl: "https://auth.openai.com/codex/device", expiresAt: Date.now() + 60_000 });
  expect(screen.getByText("AB12-CD34")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open page" }));
  expect(window.openorc.openExternal).toHaveBeenCalledWith("https://auth.openai.com/codex/device");
});

it("says a connected sign-in is ready with what the server holds, and removes it", async () => {
  show("codex", [{ provider: "openai", label: "ChatGPT Plus" }]);
  expect(screen.getByText("Ready")).toBeTruthy();
  expect(screen.getByText("ChatGPT Plus")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("account.signIns.remove", { agent: "codex" }));
});

it("says a sign-in that ended, and one that failed, and offers to sign in again", () => {
  show("claude", [{ ended: true }]);
  expect(screen.getByText("Signed out")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sign in with Claude" })).toBeTruthy();
  cleanup();
  show("codex", [], { state: "failed", error: "The code ran out. Sign in again." });
  expect(screen.getByText("The code ran out. Sign in again.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sign in with ChatGPT" })).toBeTruthy();
});
