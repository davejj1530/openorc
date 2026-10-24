import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClaudeAccounts } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { ClaudeAccountSettings } from "./settings-claude-accounts";

const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../lib/rpc", () => ({ core: { call: mocks.call, onReady: () => {}, onPush: () => () => {} } }));
let data: ClaudeAccounts;
beforeEach(() => {
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
    if (method === "claude.accounts.login") return { started: true };
    if (method === "claude.accounts.update") {
      if (params.makeDefault) data.defaultId = params.id;
      const account = data.accounts.find((entry) => entry.id === params.id)!;
      if (params.name) account.name = params.name;
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
  await screen.findByLabelText("Name for Client");
  fireEvent.change(screen.getByLabelText("Account name"), { target: { value: "Second client" } });
  fireEvent.click(screen.getByRole("button", { name: "Add account and sign in" }));
  await waitFor(() => expect(mocks.call).toHaveBeenCalledWith("claude.accounts.login", { id: "fourth" }));
  await screen.findByLabelText("Name for Second client");
  expect(screen.getAllByLabelText(/^Name for /)).toHaveLength(4);
  expect(screen.getByLabelText<HTMLInputElement>("Account name").value).toBe("");
});

it("changes the default and renames an account without changing its identity", async () => {
  mount();
  await screen.findByLabelText("Name for Work");
  fireEvent.click(screen.getAllByRole("button", { name: "Make default" })[0]!);
  await waitFor(() => expect(data.defaultId).toBe("work"));
  fireEvent.change(screen.getByLabelText("Name for Work"), { target: { value: "Company" } });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  await screen.findByLabelText("Name for Company");
  expect(mocks.call).toHaveBeenCalledWith("claude.accounts.update", { id: "work", name: "Company" });
});
