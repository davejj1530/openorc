import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { CloudStatus } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { CloudSettings } from "./settings-cloud";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
vi.mock("../components/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../components/ui")>()),
  Tooltip: ({ label, children }: { label: string; children: ReactNode }) => <span data-tooltip={label}>{children}</span>,
}));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

const status: CloudStatus = {
  vercel: { team: { id: "team_a", name: "Acme" }, project: "openorc-sandboxes", vcpus: null, region: "sin1" },
  claude: {},
  codex: { mode: null, email: null, plan: null, refreshedAt: null, signingIn: false, error: null },
  opencode: { providers: [] },
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

function showCloud(cloud: CloudStatus) {
  vi.mocked(core.call).mockImplementation(async (method: string) => (method === "cloud.status" ? cloud : answers[method]) as never);
  render(
    <QueryClientProvider client={queryClient}>
      <CloudSettings active />
    </QueryClientProvider>,
  );
}

it("asks for a token scoped to one team where Vercel is connected, with the reason on hover", async () => {
  window.openorc = { ...window.openorc, openExternal: vi.fn() };
  showCloud({ ...status, vercel: null });
  const scoped = await screen.findByText("scoped to one team");
  expect(scoped.getAttribute("data-tooltip")).toBe("Under Scope, choose the team, then All Projects. Whoever holds the token can change everything it reaches.");
  fireEvent.click(screen.getByRole("button", { name: "your Vercel account" }));
  expect(window.openorc.openExternal).toHaveBeenCalledWith("https://vercel.com/account/tokens");
});

it("says when the saved token reaches more than the chosen team, and nothing when it does not", async () => {
  showCloud({ ...status, vercel: { ...status.vercel!, reachesMore: true } });
  const line = await screen.findByText("This token reaches more than Acme.");
  expect(line.getAttribute("data-tooltip")).toBe("Whoever holds the token can change everything it reaches. Disconnect, then connect one scoped to Acme alone.");
  cleanup();
  queryClient.clear();
  showCloud(status);
  await screen.findByText("Connected");
  expect(screen.queryByText(/This token reaches more/)).toBeNull();
});

it("says once a Claude token is removed that it still works at Anthropic, and where to revoke it", async () => {
  window.openorc = { ...window.openorc, openExternal: vi.fn() };
  const account = { id: "claude-cli", name: "Personal", kind: "cli", enabled: true, status: "ready", email: "me@example.com", organization: null, message: null };
  const work = { ...account, id: "work", name: "Work", kind: "managed", email: "work@example.com" };
  let cloud: CloudStatus = { ...status, claude: { "claude-cli": { createdAt: 1, creating: false, error: null } } };
  vi.mocked(core.call).mockImplementation(async (method: string) => {
    if (method === "cloud.claude.remove") cloud = { ...cloud, claude: {} };
    if (method === "cloud.status") return cloud as never;
    if (method === "claude.accounts.list") return { accounts: [account, work], defaultId: "claude-cli" } as never;
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
  expect(screen.getAllByText(/until you revoke it/)).toHaveLength(1);
  expect(settings.closest("p")?.textContent).toBe("Removed from OpenOrc. It still works until you revoke it in your Claude settings, under Claude Code.");
  fireEvent.click(settings);
  expect(window.openorc.openExternal).toHaveBeenCalledWith("https://claude.ai/settings/claude-code");
});

it("shows the cloud brain once either service is connected, on Agent37 alone too, and not before", async () => {
  showCloud({ ...status, vercel: null, agent37: { size: { cpu: 2, memory: 4 } }, service: "agent37" });
  expect(await screen.findByText("Cloud brain")).toBeTruthy();
  cleanup();
  queryClient.clear();
  showCloud({ ...status, vercel: null, agent37: null, service: null });
  expect(await screen.findByText("Vercel")).toBeTruthy();
  expect(screen.queryByText("Cloud brain")).toBeNull();
});
