import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor, type RenderResult, type screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, vi } from "vitest";
import type { ClaudeAccountConnection, ClaudeAccounts, ModelOption } from "@openorc/protocol";
import { core } from "../../lib/rpc";

/** The task page's calls to the core, which each test answers. */
export const api = vi.spyOn(core, "call");
export const calls = (method: string) => api.mock.calls.filter(([name]) => name === method).map(([, params]) => params);

export const models: ModelOption[] = [
  { id: "gpt-test", label: "GPT Test", agent: "codex", efforts: ["high"], defaultEffort: "high", isDefault: true },
  { id: "opus-test", label: "Opus Test", agent: "claude", efforts: ["high"], defaultEffort: "high", isDefault: true },
];
export const opus = JSON.stringify(["claude", "opus-test", "high"]);

export const account = (id: string, name: string): ClaudeAccountConnection => ({
  id,
  name,
  kind: "managed",
  enabled: true,
  createdAt: 1,
  status: "ready",
  email: null,
  organization: null,
  message: null,
});
export const accounts: ClaudeAccounts = { accounts: [account("work", "Work"), account("personal", "Personal")], defaultId: "work" };

/** A fresh query cache around what a test renders, as `renderHook`'s wrapper. */
export const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{children}</QueryClientProvider>
);
export const wrap = (node: ReactNode): RenderResult => render(wrapper({ children: node }));

/** The Account field once a Claude model makes it a choice; before that it shows disabled. */
export async function enabledAccount(scope: Pick<typeof screen, "getByRole">): Promise<HTMLSelectElement> {
  await waitFor(() => expect(scope.getByRole<HTMLSelectElement>("combobox", { name: "Account" }).disabled).toBe(false));
  return scope.getByRole<HTMLSelectElement>("combobox", { name: "Account" });
}
