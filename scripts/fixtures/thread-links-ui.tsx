import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import type { Project, ThreadSummary } from "../../packages/protocol/src";
import { ThreadRichText } from "../../apps/desktop/src/renderer/src/components/ThreadImages";
import { RichText } from "../../apps/desktop/src/renderer/src/components/RichText";
import { Panel } from "../../apps/desktop/src/renderer/src/components/Panel";
import { useLayout } from "../../apps/desktop/src/renderer/src/lib/layout";
import { queryClient } from "../../apps/desktop/src/renderer/src/lib/query";
import { core } from "../../apps/desktop/src/renderer/src/lib/rpc";

const project: Project = {
  id: "project",
  name: "Links",
  rootPath: "/tmp/links-fixture",
  gitRemote: null,
  defaultBranch: "main",
  settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc", detectedConfigs: [] },
  createdAt: 0,
  updatedAt: 0,
};
const thread = { id: "links", projectId: project.id, workspaceMode: "current", createdAt: 0 } as ThreadSummary;
core.call = (async (method) => (method === "projects.git" ? "none" : [])) as typeof core.call;
useLayout.setState({ panelOpen: false, panelTab: "browser", panelThreadId: thread.id, panelTools: {}, panelExpanded: false });
useLayout.getState().setPanelWidth(420);

function Fixture() {
  return (
    <div style={{ display: "flex", height: "100vh", containerType: "inline-size" }} className="app-shell bg-surface text-ink">
      <main style={{ flex: 1, minWidth: 0, padding: 32 }} className="prose-chat">
        <h1 className="text-lg font-semibold mb-6">Thread links</h1>
        <ThreadRichText mode="static">{`Here is the [first page](${location.origin}/page-a).\n\nRead the [second page](${location.origin}/page-b).`}</ThreadRichText>
        <RichText mode="static">{`A [document link](${location.origin}/page-c) uses the shared renderer.`}</RichText>
        <button data-show-tasks onClick={() => useLayout.getState().setPanel(true, "tasks")}>
          Show tasks
        </button>
      </main>
      <Panel context={{ kind: "thread", thread, project }} />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <Fixture />
  </QueryClientProvider>,
);
