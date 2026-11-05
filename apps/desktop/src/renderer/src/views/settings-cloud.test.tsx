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
it("says once a Claude token is removed that it still works at Anthropic, and where to revoke it", async () => {
  window.openorc = { ...window.openorc, openExternal: vi.fn() };
  const account = { id: "claude-cli", name: "Personal", kind: "cli", enabled: true, status: "ready", email: "me@example.com", organization: null, message: null };
  let cloud: CloudStatus = { ...status, claude: { "claude-cli": { createdAt: 1, creating: false, error: null } } };
  vi.mocked(core.call).mockImplementation(async (method: string) => {
    if (method === "cloud.claude.remove") cloud = { ...cloud, claude: {} };
    if (method === "cloud.status") return cloud as never;
    if (method === "claude.accounts.list") return { accounts: [account], defaultId: "claude-cli" } as never;
    return answers[method] as never;
  });
  render(
    <QueryClientProvider client={queryClient}>
      <CloudSettings active />
    </QueryClientProvider>,
  );
  await screen.findByText("Ready");
  expect(screen.queryByText(/until you/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.claude.remove", { accountId: "claude-cli" }));
  await queryClient.invalidateQueries();
  const settings = await screen.findByRole("button", { name: "your Claude settings" });
  expect(settings.closest("p")?.textContent).toBe("Removed from OpenOrc. It still works until you revoke it in your Claude settings, under Claude Code.");
  fireEvent.click(settings);
  expect(window.openorc.openExternal).toHaveBeenCalledWith("https://claude.ai/settings/claude-code");
});
