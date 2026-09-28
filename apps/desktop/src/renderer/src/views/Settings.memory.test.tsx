import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { MemorySettings as MemorySettingsValue } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemorySettings } from "./Settings";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/query";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onInvalidate: vi.fn(), onReady: vi.fn() } }));
vi.mock("../components/TopBar", () => ({ TopBar: () => null }));
let saved: MemorySettingsValue;
let failSave: boolean;
const storageError = "Cannot access protected memory storage. Unlock your OS keychain or secret service and retry.";
beforeEach(() => {
  saved = { enabled: true, provider: "apikey", model: null, hasApiKey: true, resolved: null, automatic: [], reason: null };
  failSave = false;
  vi.mocked(core.call).mockImplementation(async (method, params) => {
    if (method === "memory.settings.get") return { ...saved };
    if (method === "agents.models") return [];
    if (method === "memory.settings.set" && "apiKey" in params) {
      if (failSave) throw new Error(storageError);
      saved = { ...saved, hasApiKey: Boolean(params.apiKey) };
      return { ...saved };
    }
    throw new Error(`Unexpected RPC: ${method}`);
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});
function show() {
  render(
    <QueryClientProvider client={queryClient}>
      <MemorySettings />
    </QueryClientProvider>,
  );
}
it("removes a saved key without populating the password input", async () => {
  show();
  const remove = await screen.findByRole("button", { name: "Remove API key" });
  expect((screen.getByPlaceholderText("Enter API key") as HTMLInputElement).value).toBe("");
  fireEvent.click(remove);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Remove API key" })).toBeNull());
  expect(core.call).toHaveBeenCalledWith("memory.settings.set", { apiKey: "" });
});
it("shows an actionable protected-save error and allows retrying the replacement", async () => {
  failSave = true;
  show();
  await screen.findByRole("button", { name: "Remove API key" });
  fireEvent.change(screen.getByPlaceholderText("Enter API key"), { target: { value: "replacement-fixture" } });
  fireEvent.click(screen.getByRole("button", { name: "Save API key" }));
  expect((await screen.findByRole("alert")).textContent).toContain(storageError);
  expect(screen.getByRole("status").textContent).toContain("Could not save");
  expect((screen.getByPlaceholderText("Enter API key") as HTMLInputElement).value).toBe("");
  failSave = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(vi.mocked(core.call).mock.calls.filter(([method]) => method === "memory.settings.set")).toEqual([
    ["memory.settings.set", { apiKey: "replacement-fixture" }],
    ["memory.settings.set", { apiKey: "replacement-fixture" }],
  ]);
});
it("reports unavailable storage while off and refreshes after it is unlocked", async () => {
  saved = { ...saved, provider: "off", hasApiKey: false, apiKeyError: storageError };
  show();
  expect((await screen.findByRole("alert")).textContent).toContain(storageError);
  expect(screen.getByText(/No extra model runs/)).toBeTruthy();
  saved = { enabled: true, provider: "off", model: null, hasApiKey: true, resolved: null, automatic: [], reason: null };
  fireEvent.click(screen.getByRole("button", { name: "Retry storage" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.queryByPlaceholderText("Enter API key")).toBeNull();
});
