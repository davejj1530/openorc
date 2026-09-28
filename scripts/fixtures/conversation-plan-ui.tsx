import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ConversationPlan as Plan, RpcMethod, RpcParams, RpcResults, ThreadSummary, PermissionPreset, RunMode, Project } from "@openorc/protocol";
import { Composer } from "../../apps/desktop/src/renderer/src/components/Composer";
import { Panel } from "../../apps/desktop/src/renderer/src/components/Panel";
import { useLayout } from "../../apps/desktop/src/renderer/src/lib/layout";
import { core } from "../../apps/desktop/src/renderer/src/lib/rpc";
import { queryClient } from "../../apps/desktop/src/renderer/src/lib/query";

import { useTheme } from "../../apps/desktop/src/renderer/src/lib/theme";

const docs: Plan[] = [
  {
    id: "plan-2",
    threadId: "thread",
    runId: "run",
    revision: 2,
    state: "ready",
    source: "native",
    updatedAt: Date.now(),
    text: "# Slack permission enforcement\n\nApply the stricter mode on every Slack turn, including conversations created before the setting changed.\n\n## Changes\n\n1. Resolve the effective mode before starting or resuming a provider.\n2. Keep restrictions when switching models.\n3. Show pending settings until the current turn ends.\n\n## Verification\n\n- Start an Autonomous conversation, then set Slack to Review.\n- Confirm the next command waits for approval.\n- Confirm a model switch preserves the restriction.\n\nNo migration should grant additional permissions.",
  },
  { id: "plan-1", threadId: "thread", runId: "old", revision: 1, state: "ready", source: "native", updatedAt: 1, text: "# Earlier proposal\nEnforce Slack permissions." },
];
const calls: unknown[] = [];
core.call = async <M extends RpcMethod>(method: M, input: RpcParams<M>): Promise<RpcResults[M]> => {
  calls.push({ method, input });
  if (method === "threads.plans" && (input as { id: string }).id === "team")
    return [
      { ...docs[0]!, id: "chat-34", source: "response", revision: 34, runId: "vice-run", text: "A chat reply the team plan panel must not show as the plan." },
      { ...docs[0]!, id: "member-33", revision: 33, runId: "vice-run", text: "# Member proposal, not the shared plan" },
      docs[0]!,
    ] as RpcResults[M];
  if (method === "threads.plans")
    return ((input as { id: string }).id === "other" ? [{ ...docs[0]!, id: "other-plan", threadId: "other", revision: 1, text: "# Other conversation plan" }] : docs) as RpcResults[M];
  if (method === "threads.exportPlan") return { path: `/repo/${(input as RpcParams<"threads.exportPlan">).filename}` } as RpcResults[M];
  if (method === "orchestration.runtime" || method === "orchestration.implementPlan")
    return {
      executions: [
        {
          state: "completed",
          actors: [
            { id: "lead", state: "completed", runIds: ["run"] },
            { id: "member:vice", state: "completed", runIds: ["vice-run"] },
          ],
        },
      ],
    } as unknown as RpcResults[M];
  if (method === "threads.implementPlan") return { id: "implementation" } as RpcResults[M];
  if (method === "skills.list" || method === "threads.list" || method === "tasks.list" || method === "agents.models") return [] as RpcResults[M];
  return null as RpcResults[M];
};
useLayout.setState({ panelOpen: true, panelTab: "plan", panelThreadId: "thread" });
const project = { id: "project", name: "studio", rootPath: "/repo" } as Project;
function App() {
  const [id, setId] = useState("thread");
  const panelOpen = useLayout((s) => s.panelOpen);
  const [mode, setMode] = useState<RunMode>("plan");
  const [permission, setPermission] = useState<PermissionPreset>("review");
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
  const [draft, setDraft] = useState("Keep existing threads compatible");
  const thread = { id, projectId: "project", teamInstanceId: id === "team" ? "saved-team" : null, mode, permissionMode: permission, activity: "idle", agent } as ThreadSummary;
  Object.assign(window, {
    planSmoke: {
      calls,
      select(id: string) {
        setId(id);
        useLayout.getState().openThreadPanel(id, "plan");
      },
      layout: () => useLayout.getState(),
      theme: useTheme.getState().set,
      provider: setAgent,
      update(text: string) {
        docs[0] = { ...docs[0]!, text };
        queryClient.setQueryData(["threads.plans", { id: "thread" }], [...docs]);
      },
    },
  });
  return (
    <div className="h-full flex bg-surface text-ink overflow-hidden">
      <main className="min-w-0 flex-1 flex flex-col">
        <header style={{ height: 48, padding: "0 20px", display: "flex", alignItems: "center", gap: 12 }} className="border-b border-line text-sm">
          Enforce Slack permission modes<span className="ml-3 text-ink-3">studio</span>
          <button aria-label={panelOpen ? "Hide sidebar" : "Show sidebar"} className="ml-auto" onClick={() => useLayout.getState().toggleThreadPanel(id)}>
            Sidebar
          </button>
        </header>
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 min-h-0 flex-1 flex flex-col">
            <div style={{ padding: "24px 32px" }} className="flex-1 overflow-auto text-sm">
              <div className="ml-auto max-w-lg rounded-2xl bg-surface-2 p-4">Plan the permission enforcement change.</div>
              <p style={{ marginTop: 48 }} className="text-ink-2">
                The proposed plan is ready for review. It is saved with this conversation.
              </p>
            </div>
            <div className="p-4">
              <Composer
                value={draft}
                onChange={setDraft}
                onSubmit={async () => {}}
                placeholder="Refine the plan…"
                model={{ agent, model: null, effort: null, fastMode: false }}
                onModel={() => {}}
                mode={mode}
                onMode={setMode}
                permission={permission}
                onPermission={setPermission}
                location={{ label: null, branch: "master" }}
              />
            </div>
          </div>
        </div>
      </main>
      <Panel context={{ kind: "thread", thread, project }} />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
