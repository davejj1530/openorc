/** Synthetic settings state for the Slack POC smoke; never connects to Slack. */
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import type { RpcMethod, RpcParams, RpcResults, SlackStatus } from "@openorc/protocol";
import { SlackSettings } from "../../apps/desktop/src/renderer/src/views/settings-slack";
import { core } from "../../apps/desktop/src/renderer/src/lib/rpc";
import { queryClient } from "../../apps/desktop/src/renderer/src/lib/query";

const state: SlackStatus = {
  mode: "direct",
  direct: { configured: false, enabled: false, connected: false, busy: false, error: null, config: null, workspace: null, ownerName: null, botId: null },
  host: { configured: false, enabled: false, connected: false, channelId: "", port: 47831, workspace: null, error: null },
  devices: [],
  client: { configured: false, enabled: false, connected: false, config: null, userId: null, busy: false, error: null },
};
let fail = false;
const calls: string[] = [];
Object.assign(window, { openorc: { openExternal: (url: string) => calls.push(`open:${url}`), pickDirectory: async () => "/Users/fixture/dev" } });
Object.assign(window, {
  slackSmoke: {
    calls,
    fail: () => {
      fail = true;
    },
    deliveryFailed: () => {
      state.client = { ...state.client, connected: true, busy: true, error: "Slack delivery failed (missing_scope). The reply is still pending." };
      void queryClient.invalidateQueries();
    },
  },
});
core.call = async <M extends RpcMethod>(method: M, input: RpcParams<M>): Promise<RpcResults[M]> => {
  calls.push(method);
  let result: unknown = null;
  if (method === "slack.status") result = structuredClone(state);
  else if (method === "slack.direct.save") {
    const { botToken: _bot, appToken: _app, ...config } = input as RpcParams<"slack.direct.save">;
    state.mode = "direct";
    state.direct = { ...state.direct, configured: true, config };
  } else if (method === "slack.direct.connect") {
    if (fail) {
      fail = false;
      state.direct.error = "Could not check your Slack member ID. Add users:read, reinstall the Slack app, and confirm the ID.";
      throw new Error(state.direct.error);
    }
    state.direct = { ...state.direct, enabled: true, connected: true, error: null, workspace: "Personal workspace", ownerName: "Alice", botId: "UBOT" };
  } else if (method === "slack.direct.disconnect") state.direct = { ...state.direct, enabled: false, connected: false };
  else if (method === "workspace.configure") result = { id: "openorc-workspace", name: "Workspace", rootPath: "/Users/fixture/dev" };
  else if (method === "workspace.get") result = { id: "openorc-workspace", name: "Workspace", rootPath: "/Users/fixture/dev" };
  else if (method === "projects.list") result = [{ id: "project", name: "POC project" }];
  else if (method === "slack.host.save") {
    const p = input as RpcParams<"slack.host.save">;
    state.host = { ...state.host, configured: true, channelId: p.channelId, port: p.port };
  } else if (method === "slack.host.connect") state.host = { ...state.host, enabled: true, connected: true, workspace: "POC workspace" };
  else if (method === "slack.host.disconnect") state.host = { ...state.host, enabled: false, connected: false };
  else if (method === "slack.device.add") {
    const p = input as RpcParams<"slack.device.add">;
    state.devices.push({ id: "alice", label: p.label, userId: p.userId, online: false });
    result = { id: "alice", deviceKey: `oqd_${"a".repeat(64)}` };
  } else if (method === "slack.device.remove") state.devices = [];
  else if (method === "slack.client.save") {
    const { deviceKey: _key, ...config } = input as RpcParams<"slack.client.save">;
    state.client = { ...state.client, configured: true, config };
  } else if (method === "slack.client.connect") {
    if (fail) {
      fail = false;
      throw new Error("Relay unavailable. Check your SSH tunnel and retry.");
    }
    state.client = { ...state.client, enabled: true, connected: true, userId: "UALICE", busy: false, error: null };
  } else if (method === "slack.client.disconnect") state.client = { ...state.client, enabled: false, connected: false };
  else throw new Error(`Unexpected fixture RPC: ${method}`);
  return result as RpcResults[M];
};
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <div className="h-full flex flex-col bg-surface text-ink">
      <header className="h-11 shrink-0 flex items-center px-6 border-b border-line">Settings</header>
      <div className="settings-shell">
        <div className="settings-layout">
          <nav className="settings-nav">
            <div className="settings-tablist">
              <button aria-selected="true">Slack</button>
            </div>
          </nav>
          <div className="settings-content">
            <div role="tabpanel">
              <header className="settings-heading">
                <h1 className="text-xl font-semibold">Slack</h1>
                <p className="text-md text-ink-2 mt-1">Run Slack requests on your own computer.</p>
              </header>
              <SlackSettings active />
            </div>
          </div>
        </div>
      </div>
    </div>
  </QueryClientProvider>,
);
