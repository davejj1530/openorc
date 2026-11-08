import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClaudeAccounts } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { ClaudeAccountSettings } from "./settings-claude-accounts";

const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../lib/rpc", () => ({ core: { call: mocks.call, onReady: () => {}, onPush: () => () => {} } }));
let data: ClaudeAccounts;
let autoSwitch: boolean;
beforeEach(() => {
  autoSwitch = false;
  queryClient.clear();
  data = {
    defaultId: "personal",
    accounts: ["Personal", "Work", "Client"].map((name, createdAt) => ({
      id: name.toLowerCase(),
      name,
      kind: "managed",
      createdAt,
      enabled: true,
      status: "ready",
      email: `${name.toLowerCase()}@example.test`,
      organization: null,
      message: null,
    })),
  };
  mocks.call.mockReset().mockImplementation(async (method, params) => {
    if (method === "claude.accounts.list") return structuredClone(data);
    if (method === "claude.accounts.add") {
      const account = { ...data.accounts[0]!, id: "fourth", name: params.name, status: "signed_out" as const, email: null };
      data.accounts.push(account);
      return account;
    }
    if (method === "claude.accounts.login" || method === "claude.accounts.cancelLogin") return { started: true };
    if (method === "app.settings.get") return { claudeAccountAutoSwitch: autoSwitch };
    if (method === "app.settings.set") {
      autoSwitch = params.claudeAccountAutoSwitch ?? autoSwitch;
      return { claudeAccountAutoSwitch: autoSwitch };
    }
    if (method === "claude.accounts.update") {
      if (params.makeDefault) data.defaultId = params.id;
      const account = data.accounts.find((entry) => entry.id === params.id)!;
      if (params.name) account.name = params.name;
      if (typeof params.enabled === "boolean") {
        account.enabled = params.enabled;
        account.status = params.enabled ? "ready" : "disabled";
      }
      return structuredClone(account);
    }
    throw new Error(`Unexpected fixture method: ${method}`);
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
function mount() {
  render(
    <QueryClientProvider client={queryClient}>
      <ClaudeAccountSettings active />
    </QueryClientProvider>,
  );
}

it("adds a fourth account, starts its login and refreshes the list", async () => {
  mount();
  await screen.findByRole("heading", { name: "Client" });
  fireEvent.click(screen.getByLabelText("Add account"));
  fireEvent.change(screen.getByLabelText("Account name"), { target: { value: "Second client" } });
  fireEvent.click(screen.getByRole("button", { name: "Add account and sign in" }));
  await waitFor(() => expect(mocks.call).toHaveBeenCalledWith("claude.accounts.login", { id: "fourth" }));
  await screen.findByRole("heading", { name: "Second client" });
  expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(4);
  expect(screen.getByLabelText<HTMLInputElement>("Account name").value).toBe("");
});

it("changes the default and renames an account without changing its identity", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "More for Work" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Make default" }));
  await waitFor(() => expect(data.defaultId).toBe("work"));
  await waitFor(() => expect(within(screen.getByRole("group", { name: "Work" })).getByText("Default")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "More for Work" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
  fireEvent.change(screen.getByLabelText("Name for Work"), { target: { value: "Company" } });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  await screen.findByRole("heading", { name: "Company" });
  expect(mocks.call).toHaveBeenCalledWith("claude.accounts.update", { id: "work", name: "Company" });
});

it("turns on switching accounts at usage limits once a second account is enabled", async () => {
  mount();
  const toggle = await screen.findByRole<HTMLInputElement>("switch", { name: /Switch accounts at usage limits/ });
  await waitFor(() => expect(toggle.disabled).toBe(false));
  expect(toggle.checked).toBe(false);
  fireEvent.click(toggle);
  await waitFor(() => expect(mocks.call).toHaveBeenCalledWith("app.settings.set", { claudeAccountAutoSwitch: true }));
  await waitFor(() => expect(toggle.checked).toBe(true));

  cleanup();
  queryClient.clear();
  data.accounts = data.accounts.map((account, index) => ({ ...account, enabled: index === 0 }));
  mount();
  await screen.findByRole("heading", { name: "Client" });
  expect(screen.queryByRole("switch", { name: /Switch accounts at usage limits/ })).toBeNull();
});

it("keeps sign-in recovery visible and manages enabled accounts from their menu", async () => {
  data.accounts[1]!.status = "signed_out";
  data.accounts[2]!.status = "signing_in";
  mount();
  const work = await screen.findByRole("group", { name: "Work" });
  fireEvent.click(within(work).getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(mocks.call).toHaveBeenCalledWith("claude.accounts.login", { id: "work" }));
  fireEvent.click(within(screen.getByRole("group", { name: "Client" })).getByRole("button", { name: "Cancel sign-in" }));
  await waitFor(() => expect(mocks.call).toHaveBeenCalledWith("claude.accounts.cancelLogin", { id: "client" }));
  fireEvent.click(screen.getByRole("button", { name: "More for Work" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Disable" }));
  await waitFor(() => expect(within(work).getByText("Disabled")).toBeTruthy());
  expect(within(work).queryByRole("button", { name: "Sign in" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "More for Work" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Enable" }));
  await waitFor(() => expect(within(work).getByText("Connected")).toBeTruthy());
});

it("shows a failed action beside its account after the menu closes", async () => {
  const original = mocks.call.getMockImplementation()!;
  mocks.call.mockImplementation((method, params) => (method === "claude.accounts.login" ? Promise.reject(new Error("Could not start sign-in. Try again.")) : original(method, params)));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "More for Personal" }));
  expect(screen.queryByRole("menuitem", { name: "Disable" })).toBeNull();
  fireEvent.click(await screen.findByRole("menuitem", { name: "Sign in again" }));
  const row = screen.getByRole("group", { name: "Personal" });
  expect((await within(row).findByRole("alert")).textContent).toContain("Could not start sign-in");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});
