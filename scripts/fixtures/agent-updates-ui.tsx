/** Synthetic state for the production agent-update controls. No installed tools are changed. */
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { harnessIds, type AgentUpdates, type RpcMethod, type RpcParams, type RpcResults, type SystemInfo } from "../../packages/protocol/src/index";
import { AgentConnections, AgentUpdateNotice } from "../../apps/desktop/src/renderer/src/views/settings-agent-updates";
import { core } from "../../apps/desktop/src/renderer/src/lib/rpc";
import { queryClient } from "../../apps/desktop/src/renderer/src/lib/query";
import { useRouter } from "../../apps/desktop/src/renderer/src/lib/router";
import { useTheme } from "../../apps/desktop/src/renderer/src/lib/theme";
const params = new URLSearchParams(location.search);
useTheme.getState().set(params.get("theme") === "dark" ? "dark" : "light");
const notice = params.has("notice");
useRouter.setState({ route: notice ? { view: "newthread" } : { view: "settings", section: "connections" } });
let state: AgentUpdates = {
  automatic: true,
  checking: false,
  updating: false,
  dismissed: null,
  agents: harnessIds.map((id) => ({
    id,
    installedVersion: id === "claude" ? "2.1.0" : "1.0.0",
    latestVersion: id === "claude" ? "2.2.0" : "1.1.0",
    status: "available",
    method: updateMethod(id),
    canUpdate: id !== "opencode",
    message: id === "opencode" ? "Update using the tool that installed this agent, then check again." : null,
    checkedAt: Date.now(),
  })),
};
const info: SystemInfo = {
  dataDir: "/fixture",
  gh: { installed: true, path: "/opt/homebrew/bin/gh" },
  harnesses: harnessIds.map((id) => ({ id, state: "ready", version: "1.0.0", revision: 1, path: id === "claude" ? "/Users/demo/.local/bin/claude" : `/opt/homebrew/bin/${id}` })),
};
core.call = async <M extends RpcMethod>(method: M, input: RpcParams<M>): Promise<RpcResults[M]> => {
  if (method === "agents.updates.configure") state = { ...state, ...input };
  if (method === "agents.updates.install") {
    const { ids } = input as RpcParams<"agents.updates.install">;
    if (params.has("error")) throw new Error("Finish agent work and pending approvals before updating. Your conversations will be kept.");
    state = { ...state, updating: true, agents: state.agents.map((row) => (ids.includes(row.id) ? { ...row, status: "updating" } : row)) };
    await queryClient.invalidateQueries({ queryKey: ["agents.updates.get"] });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    state = {
      ...state,
      updating: false,
      agents: state.agents.map((row) => (ids.includes(row.id) ? { ...row, status: "current", installedVersion: row.latestVersion, message: "Updated. Your next message uses the new version." } : row)),
    };
  }
  return state as RpcResults[M];
};
function Preview() {
  const route = useRouter((s) => s.route);
  return (
    <div className="h-full bg-surface text-ink overflow-auto" style={params.has("narrow") ? { maxWidth: 420, margin: "0 auto" } : undefined}>
      <header className="px-6 py-3 border-b border-line text-sm text-ink-2">OpenOrc · Synthetic update preview</header>
      {route.view === "settings" ? (
        <div style={{ maxWidth: 760, margin: "0 auto", padding: params.has("narrow") ? 20 : 32 }}>
          <header className="settings-heading">
            <h1 className="text-xl font-semibold">Connections</h1>
            <p className="text-md text-ink-2 mt-1">Manage the tools OpenOrc uses on your behalf.</p>
          </header>
          <AgentConnections info={info} />
        </div>
      ) : (
        <div className="grid place-items-center" style={{ height: "70vh" }}>
          <h1 className="text-2xl font-semibold">What would you like to work on?</h1>
        </div>
      )}
      <div className="workspace-update-notices">
        <AgentUpdateNotice />
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <Preview />
  </QueryClientProvider>,
);

function updateMethod(id: string): string {
  if (id === "codex") return "npm";
  if (id === "claude") return "Native · latest";
  return "Manual";
}
