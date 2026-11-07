import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { OpenCodeCloudSection } from "./settings-cloud-opencode";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

const model = (provider: string, label: string) => ({ id: `${provider}/m`, label: "M", agent: "opencode", isDefault: false, efforts: [], defaultEffort: null, provider: { id: provider, label } });

function show(providers: string[]) {
  vi.mocked(core.call).mockImplementation(async (method: string) =>
    method === "agents.models" ? [model("openrouter", "OpenRouter"), model("anthropic", "Anthropic"), model("opencode", "OpenCode Zen")] : null,
  );
  render(
    <QueryClientProvider client={queryClient}>
      <OpenCodeCloudSection opencode={{ providers }} />
    </QueryClientProvider>,
  );
}

it("says an agent in a sandbox can read the key its model uses, and adds one for a provider OpenCode serves here", async () => {
  show([]);
  expect(screen.getByText(/An agent in a sandbox can read the key its model uses\./)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add a key" }));
  await waitFor(() => expect(screen.getByRole("option", { name: "Anthropic" })).toBeTruthy());
  expect(screen.queryByRole("option", { name: "OpenCode Zen" })).toBeNull();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "anthropic" } });
  fireEvent.change(screen.getByPlaceholderText("Paste key"), { target: { value: "sk-ant-0123456789" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.opencode.saveKey", { provider: "anthropic", key: "sk-ant-0123456789" }));
});

it("lists each provider with a key by its name, never the key, and removes one", async () => {
  show(["openrouter"]);
  await waitFor(() => expect(screen.getByText("OpenRouter")).toBeTruthy());
  expect(screen.getByText("Key saved")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.opencode.removeKey", { provider: "openrouter" }));
});
