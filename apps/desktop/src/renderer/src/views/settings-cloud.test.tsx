import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { CloudStatus } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { CloudSettings } from "./settings-cloud";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

const status: CloudStatus = {
  vercel: { team: { id: "team_a", name: "Acme" }, project: "openorc-sandboxes", vcpus: null, region: "sin1" },
  claude: {},
  codex: { mode: null, email: null, plan: null, refreshedAt: null, signingIn: false, error: null },
  check: null,
  takeover: false,
  error: null,
};

const answers: Record<string, unknown> = {
  "cloud.status": status,
  "cloud.vercel.teams": [{ id: "team_a", name: "Acme" }],
  "claude.accounts.list": { accounts: [] },
  "cloud.brain.status": { state: "unavailable" },
  "cloud.sandboxes": [],
  "cloud.vercel.region": status,
};

it("shows the region new sandboxes run in, and sends a change", async () => {
  vi.mocked(core.call).mockImplementation(async (method: string) => answers[method] as never);
  render(
    <QueryClientProvider client={queryClient}>
      <CloudSettings active />
    </QueryClientProvider>,
  );
  const region = (await screen.findByRole("combobox", { name: /^Sandbox region/ })) as HTMLSelectElement;
  expect(region.value).toBe("sin1");
  expect(region.selectedOptions[0]?.textContent).toBe("Singapore · sin1");
  fireEvent.change(region, { target: { value: "hnd1" } });
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.vercel.region", { region: "hnd1" }));
});
