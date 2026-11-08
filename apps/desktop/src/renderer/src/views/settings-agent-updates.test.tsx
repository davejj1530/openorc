import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { harnessIds, type AgentUpdates, type HarnessId, type SystemInfo } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentConnections, AgentUpdateNotice } from "./settings-agent-updates";
import { isPreviewCovered } from "../lib/browser-preview";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { useRouter } from "../lib/router";
vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
let state: AgentUpdates;
let enabled: HarnessId[] | null;
const info: SystemInfo = {
  dataDir: "/fixture",
  gh: { installed: false, path: null },
  harnesses: harnessIds.map((id) => ({ id, path: `/fixture/${id}`, state: "ready", version: "1.0.0", revision: 1 })),
};
beforeEach(() => {
  enabled = null;
  localStorage.clear();
  state = {
    checking: false,
    updating: false,
    automatic: true,
    dismissed: null,
    agents: harnessIds.map((id) => ({
      id,
      status: "available",
      installedVersion: "1.0.0",
      latestVersion: "1.1.0",
      checkedAt: 1000,
      method: id === "opencode" ? "Manual" : "npm",
      canUpdate: id !== "opencode",
      message: id === "opencode" ? "Update using the tool that installed this agent, then check again." : null,
    })),
  };
  useRouter.setState({ route: { view: "newthread" }, history: [], future: [] });
  vi.mocked(core.call).mockImplementation(async (method, params) => {
    if (method === "app.settings.get") return { enabledHarnesses: enabled };
    if (method === "app.settings.set" && "enabledHarnesses" in params) {
      enabled = params.enabledHarnesses ?? null;
      return { enabledHarnesses: enabled };
    }
    if (method === "agents.updates.get" || method === "agents.updates.check") return state;
    if (method === "agents.updates.configure" && "dismissed" in params) state = { ...state, dismissed: params.dismissed ?? null };
    if (method === "agents.updates.configure" && "automatic" in params) state = { ...state, automatic: params.automatic ?? true };
    if (method === "agents.updates.install") throw new Error("Finish agent work before updating.");
    return state;
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});
const show = (notice = false) => render(<QueryClientProvider client={queryClient}>{notice ? <AgentUpdateNotice /> : <AgentConnections info={info} />}</QueryClientProvider>);
it("updates only supported available installations and surfaces active-work errors", async () => {
  show();
  fireEvent.click(await screen.findByRole("button", { name: `Update all (${harnessIds.length - 1})` }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("agents.updates.install", { ids: harnessIds.filter((id) => id !== "opencode") }));
  expect((await screen.findByRole("alert")).textContent).toContain("Finish agent work");
  expect(screen.queryByRole("button", { name: "Update OpenCode" })).toBeNull();
  expect(screen.getByRole("button", { name: "Update instructions" })).toBeTruthy();
});
it("checks manually and exposes installed and available versions", async () => {
  show();
  await screen.findByRole("button", { name: "Update Codex" });
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("agents.updates.check", {}));
  expect(screen.getAllByText("Version 1.1.0 available")).toHaveLength(harnessIds.length);
});
it("updates Homebrew Oh My Pi in the app instead of linking to instructions", async () => {
  enabled = ["omp"];
  state.agents = state.agents.map((row) => (row.id === "omp" ? { ...row, method: "Homebrew", installedVersion: "18.18.1", latestVersion: "18.18.2" } : row));
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Update Oh My Pi" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("agents.updates.install", { ids: ["omp"] }));
  expect(screen.queryByRole("button", { name: "Update instructions" })).toBeNull();
});
it("routes Review updates to Connections without installing anything", async () => {
  show(true);
  fireEvent.click(await screen.findByRole("button", { name: "Review updates" }));
  expect(useRouter.getState().route).toEqual({ view: "settings", section: "connections" });
  expect(screen.queryByRole("status")).toBeNull();
  expect(vi.mocked(core.call).mock.calls.some(([method]) => method === "agents.updates.install")).toBe(false);
});
it("dismisses only the current release set", async () => {
  show(true);
  const dismiss = await screen.findByRole("button", { name: "Dismiss agent updates" });
  expect(isPreviewCovered()).toBe(true);
  fireEvent.click(dismiss);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Review updates" })).toBeNull());
  expect(isPreviewCovered()).toBe(false);
  state = { ...state, agents: state.agents.map((row) => (row.id === "codex" ? { ...row, latestVersion: "1.2.0" } : row)) };
  await queryClient.invalidateQueries();
  expect(await screen.findByRole("button", { name: "Review updates" })).toBeTruthy();
});
it("disables actions and suppresses the notice while an update is running", async () => {
  state = { ...state, updating: true, agents: state.agents.map((row) => (row.id === "codex" ? { ...row, status: "updating" } : row)) };
  show();
  await screen.findByText("Updating agents…");
  expect((screen.getByRole("button", { name: "Check for updates" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Update Claude" }) as HTMLButtonElement).disabled).toBe(true);
});
it("offers a reinstall for an agent that fails to start instead of a login hint", async () => {
  const broken = { status: "broken" as const, installedVersion: null, latestVersion: null };
  state = {
    ...state,
    agents: state.agents.map((row) => {
      if (row.id === "codex") return { ...row, ...broken, message: null };
      if (row.id === "opencode") return { ...row, ...broken, message: "Reinstall using the tool that installed this agent, then check again." };
      if (row.id === "omp") return { ...row, status: "current" as const, latestVersion: "1.0.0" };
      return row;
    }),
  };
  const failing: SystemInfo = { ...info, harnesses: info.harnesses.map((row) => (row.id === "codex" || row.id === "opencode" ? { ...row, state: "check_failed", version: null } : row)) };
  render(
    <QueryClientProvider client={queryClient}>
      <AgentConnections info={failing} />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Reinstall Codex" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("agents.updates.install", { ids: ["codex"] }));
  expect(screen.getAllByText("Fails to start")).toHaveLength(2);
  expect(screen.queryByText(/Connect in a terminal/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Reinstall OpenCode" })).toBeNull();
  expect(screen.getByRole("button", { name: "Reinstall instructions" })).toBeTruthy();
  expect(screen.getByRole("button", { name: `Update all (${harnessIds.length - 3})` })).toBeTruthy();
});

it("hides disabled agents until Add agents is opened and saves enabling and disabling", async () => {
  enabled = ["codex"];
  show();
  await screen.findByRole("switch", { name: "Enable Codex" });
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Claude Code" })).toBeNull());
  expect(screen.queryByRole("button", { name: "Update Cursor" })).toBeNull();
  fireEvent.click(screen.getByLabelText(`Add agents (${harnessIds.length - 1})`));
  fireEvent.click(screen.getByRole("button", { name: "Enable Cursor" }));
  await screen.findByRole("switch", { name: "Enable Cursor" });
  expect(enabled).toEqual(["codex", "cursor"]);
  fireEvent.click(screen.getByRole("switch", { name: "Enable Codex" }));
  await waitFor(() => expect(enabled).toEqual(["cursor"]));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Codex" })).toBeNull());
});

it("explains when an older running core ignores an agent selection", async () => {
  enabled = ["codex"];
  show();
  const addAgents = await screen.findByLabelText(`Add agents (${harnessIds.length - 1})`);
  vi.mocked(core.call).mockResolvedValueOnce({});
  fireEvent.click(addAgents);
  fireEvent.click(screen.getByRole("button", { name: "Enable Cursor" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Quit and reopen OpenOrc");
  expect(screen.queryByRole("switch", { name: "Enable Cursor" })).toBeNull();
});
