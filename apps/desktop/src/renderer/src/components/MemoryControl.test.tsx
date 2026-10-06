import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { MemorySettings } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryControl } from "./MemoryControl";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/query";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onInvalidate: vi.fn(), onReady: vi.fn() } }));

let saved: MemorySettings;
let failSave: boolean;
let failSettings: boolean;
beforeEach(() => {
  queryClient.setDefaultOptions({ queries: { retry: false } });
  saved = { enabled: true, provider: "off", model: null, hasApiKey: false, resolved: null, automatic: [], reason: null };
  failSave = failSettings = false;
  vi.mocked(core.call).mockImplementation(async (method, params) => {
    if (method === "memory.settings.get") {
      if (failSettings) throw Error("Offline");
      return { ...saved };
    }
    if (method === "memory.settings.set" && "enabled" in params) {
      if (failSave) throw Error("Could not persist");
      saved = { ...saved, enabled: params.enabled! };
      return { ...saved };
    }
    throw Error(`Unexpected RPC ${method}`);
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
      <MemoryControl />
    </QueryClientProvider>,
  );
}

it("keeps the acknowledged On state after a failed Off save and retries the same choice", async () => {
  failSave = true;
  show();
  await screen.findByText("OpenOrc memory is on");
  fireEvent.click(screen.getByRole("switch", { name: "OpenOrc memory" }));
  await screen.findByRole("alert");
  expect(screen.getByText("OpenOrc memory is on")).toBeTruthy();
  expect((screen.getByRole("switch", { name: "OpenOrc memory" }) as HTMLInputElement).checked).toBe(true);
  failSave = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await screen.findByText("OpenOrc memory is off");
  expect(vi.mocked(core.call).mock.calls.filter(([method]) => method === "memory.settings.set")).toEqual([
    ["memory.settings.set", { enabled: false }],
    ["memory.settings.set", { enabled: false }],
  ]);
});

it("does not pretend an unknown setting is Off", async () => {
  failSettings = true;
  show();
  await screen.findByText(/Could not check memory status/);
  expect(screen.queryByText("OpenOrc memory is off")).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
});
