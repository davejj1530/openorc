import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import type { Project, ReviewDiff, RpcMethod, RpcParams, RpcResults, ThreadSummary } from "@openorc/protocol";
import { Composer, ComposerChoice } from "../../apps/desktop/src/renderer/src/components/Composer";
import { Laptop, GitBranch } from "../../apps/desktop/src/renderer/src/components/icons";
import { Panel } from "../../apps/desktop/src/renderer/src/components/Panel";
import { useComposerChanges } from "../../apps/desktop/src/renderer/src/lib/composer-changes";
import { useLayout } from "../../apps/desktop/src/renderer/src/lib/layout";
import { core } from "../../apps/desktop/src/renderer/src/lib/rpc";
import { invalidateTags, queryClient } from "../../apps/desktop/src/renderer/src/lib/query";
import { useTheme, type ThemeChoice } from "../../apps/desktop/src/renderer/src/lib/theme";

const project: Project = {
  id: "project",
  name: "studio",
  rootPath: "/repo",
  gitRemote: null,
  defaultBranch: "master",
  settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc", detectedConfigs: [] },
  createdAt: 0,
  updatedAt: 0,
};
let dirty = true;
let binary = false;
let failCommit = false;
let blocked = false;
const calls: { method: string; input: unknown }[] = [];
const diff = (): ReviewDiff => ({
  baseSha: null,
  since: null,
  files: dirty ? [{ path: binary ? "mascot.png" : "composer.tsx", status: "modified", oldPath: null }] : [],
  patch: fixturePatch(),
});
queryClient.setDefaultOptions({ queries: { retry: false } });
core.call = async <M extends RpcMethod>(method: M, input: RpcParams<M>): Promise<RpcResults[M]> => {
  calls.push({ method, input });
  let result: unknown = [];
  if (method === "review.threadDiff" || method === "review.projectDiff") result = diff();
  if (method === "review.commitThread" || method === "review.commitProject") {
    if (failCommit) throw Error("Commit could not be completed. Retry.");
    dirty = false;
    result = { sha: "abcdef1234567" };
  }
  if (method === "orchestration.runtime") {
    const action = { allowed: !blocked, reason: blocked ? "The team is still working." : null };
    result = { actions: { commit: action, push: action, createPr: action } };
  }
  if (method === "system.info") result = { gh: { installed: false } };
  if (method === "agents.models") result = [{ agent: "codex", id: "gpt-6-astra", label: "GPT-6-Astra", isDefault: true, efforts: ["high", "xhigh", "ultra"] }];
  if (method === "attachments.save") result = { path: "/tmp/composer-fixture.png", url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" };
  return result as RpcResults[M];
};
useTheme.getState().setPreset("openorc");
useLayout.setState({ panelOpen: false, selectedChanges: null, workspaceChanges: null });

function App() {
  const [value, setValue] = useState("");
  const [source, setSource] = useState<"thread" | "project">("project");
  const [branch, setBranch] = useState("master");
  const [working, setWorking] = useState(false);
  const [destination, setDestination] = useState<"current" | "worktree">("current");
  const [team, setTeam] = useState(false);
  const thread = {
    id: "thread",
    projectId: project.id,
    title: "Composer changes",
    workspaceMode: "worktree",
    worktreePath: "/worktree",
    branch,
    teamInstanceId: team ? "team" : null,
  } as ThreadSummary;
  const changes = useComposerChanges({ kind: source, id: source, projectName: project.name, team });
  Object.assign(window, {
    changesSmoke: {
      calls,
      theme: (theme: ThemeChoice) => useTheme.getState().set(theme),
      palette: useTheme.getState().setPreset,
      branch: setBranch,
      working: setWorking,
      value: setValue,
      source: (next: "thread" | "project") => {
        useLayout.getState().setPanel(false);
        setSource(next);
      },
      dirty: (next: boolean, onlyBinary = false) => {
        dirty = next;
        binary = onlyBinary;
        invalidateTags(["workspace-diff"], { immediate: true });
      },
      failCommit: (next: boolean) => {
        failCommit = next;
      },
      team: (next: boolean, isBlocked = false) => {
        blocked = isBlocked;
        setTeam(next);
        invalidateTags(["orchestration"], { immediate: true });
      },
      close: () => useLayout.getState().setPanel(false),
      layout: () => useLayout.getState(),
    },
  });
  return (
    <div className="h-full flex bg-surface text-ink overflow-hidden">
      <main className="flex-1 min-w-0 flex flex-col justify-end p-6">
        <div className="w-full max-w-chat mx-auto">
          <Composer
            value={value}
            onChange={setValue}
            onSubmit={async () => {}}
            placeholder="What would you like to do?"
            model={{ agent: "codex", model: "gpt-6-astra", effort: "xhigh", fastMode: false }}
            onModel={() => {}}
            mode="plan"
            onMode={() => {}}
            permission="review"
            onPermission={() => {}}
            location={{ label: null, branch }}
            changes={changes}
            size="lg"
            queueing={working}
            liveByDefault={working}
            steerable={working}
            stopAction={working ? { working: true, pending: false, onStop: () => {} } : undefined}
            context={working ? { used: 200000, window: 1000000 } : null}
          >
            <ComposerChoice
              ariaLabel="Where the thread works"
              value={destination}
              onChange={setDestination}
              options={[
                { value: "current", label: "Local checkout", icon: Laptop },
                { value: "worktree", label: "Worktree", icon: GitBranch },
              ]}
            />
          </Composer>
        </div>
      </main>
      <Panel context={source === "thread" ? { kind: "thread", thread, project } : { kind: "project", project }} />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);

function fixturePatch(): string {
  if (!dirty) return "";
  if (binary) return "diff --git a/mascot.png b/mascot.png\nnew file mode 100644\nindex 0000000..f731f65\nBinary files /dev/null and b/mascot.png differ\n";
  return "diff --git a/composer.tsx b/composer.tsx\n--- a/composer.tsx\n+++ b/composer.tsx\n@@ -1 +1,2 @@\n-old\n+new\n+line\n";
}
