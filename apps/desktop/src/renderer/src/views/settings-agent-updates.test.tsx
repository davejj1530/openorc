import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { harnessIds, type AgentUpdates, type SystemInfo } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentConnections, AgentUpdateNotice } from "./settings-agent-updates";
import { queryClient } from "../lib/query";
import { core } from "../lib/rpc";
import { useRouter } from "../lib/router";
vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onInvalidate: vi.fn(), onReady: vi.fn() } }));
let state: AgentUpdates;
const info: SystemInfo = {
  dataDir: "/fixture",
  gh: { installed: false, path: null },
  harnesses: harnessIds.map((id) => ({ id, path: `/fixture/${id}`, state: "ready", version: "1.0.0", revision: 1 })),
};
beforeEach(() => {
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
  fireEvent.click(await screen.findByRole("button", { name: "Update all (2)" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("agents.updates.install", { ids: ["codex", "claude"] }));
  expect((await screen.findByRole("alert")).textContent).toContain("Finish agent work");
  expect(screen.queryByRole("button", { name: "Update OpenCode" })).toBeNull();
  expect(screen.getByRole("button", { name: "Update instructions" })).toBeTruthy();
});
it("checks manually and exposes installed and available versions", async () => {
  show();
  await screen.findByRole("button", { name: "Update Codex" });
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("agents.updates.check", {}));
  expect(screen.getAllByText("Version 1.1.0 available")).toHaveLength(3);
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
  fireEvent.click(await screen.findByRole("button", { name: "Dismiss agent updates" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Review updates" })).toBeNull());
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
