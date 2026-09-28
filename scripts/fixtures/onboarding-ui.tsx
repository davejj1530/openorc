import "./team-window-stub";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";

// The App graph reads window.openorc at module evaluation time. Load it only
// after the fixture's window stub has run, even when Vite splits shared chunks.
Object.assign(globalThis, { __OPENORC_QA__: false });
const [{ App }, { useWindow }, { useRouter }, { Onboarding }, { AppearanceSettings }, { core }, { queryClient }, { useTheme }] = await Promise.all([
  import("../../apps/desktop/src/renderer/src/App"),
  import("../../apps/desktop/src/renderer/src/lib/window"),
  import("../../apps/desktop/src/renderer/src/lib/router"),
  import("../../apps/desktop/src/renderer/src/views/Onboarding"),
  import("../../apps/desktop/src/renderer/src/views/settings-appearance"),
  import("../../apps/desktop/src/renderer/src/lib/rpc"),
  import("../../apps/desktop/src/renderer/src/lib/query"),
  import("../../apps/desktop/src/renderer/src/lib/theme"),
]);

const startup = new URLSearchParams(location.search).has("startup");
const appearance = new URLSearchParams(location.search).has("appearance");
if (startup) {
  useRouter.setState({ route: { view: "newthread" } });
  window.onboardingStartupSmoke = { fullscreen: (fullscreen) => useWindow.setState({ fullscreen }) };
}

// Only synthetic data reaches the production renderer. No core or provider is connected.
const harnesses = ["claude", "codex", "opencode"].map((id) => ({
  id,
  state: id === "opencode" ? "not_found" : "ready",
  path: id === "opencode" ? null : `/usr/local/bin/${id}`,
  version: "1.0.0",
  revision: 1,
}));
const project = {
  id: "demo",
  name: "My first project",
  rootPath: "/Users/developer/Projects/my-first-project",
  defaultBranch: "main",
  gitRemote: null,
  settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc/", detectedConfigs: [] },
  createdAt: 0,
  updatedAt: 0,
};
let projects = [];
let importFails = false;
core.call = async (method) => {
  if (startup) return new Promise(() => {}); // Hold the real initial-load screen before any core replies.
  if (method === "system.info") return { harnesses };
  if (method === "projects.list") return projects;
  if (method === "projects.import") {
    if (importFails) throw new Error("This folder is not a Git repository.");
    projects = [project];
    return project;
  }
  throw new Error(`Unexpected fixture RPC: ${method}`);
};
window.openorc.pickDirectory = async () => project.rootPath;
window.openorc.openExternal = async () => {};
queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
function Fixture() {
  const [state, setState] = useState({ key: 0, step: "scan", mode: "first_run" });
  window.onboardingSmoke = {
    theme: (mode) => useTheme.getState().set(mode),
    color: (token, color) => useTheme.getState().setColor(token, color),
    show: (step, mode = "first_run") => setState((old) => ({ key: old.key + 1, step, mode })),
    agents: (states) => {
      harnesses.forEach((row, i) => (row.state = states[i]));
      queryClient.setQueryData(["system.info", { refresh: false }], { harnesses: [...harnesses] });
    },
    importFails: (value) => {
      importFails = value;
    },
    manyProjects: () => {
      projects = Array.from({ length: 14 }, (_, i) => ({ ...project, id: `project-${i}`, name: `Project ${i + 1}`, rootPath: `/Users/developer/Projects/${"a-long-folder-name/".repeat(10)}${i}` }));
      queryClient.setQueryData(["projects.list", {}], projects);
    },
  };
  return appearance ? (
    <main className="settings-shell" style={{ height: "100%", background: "var(--surface)" }}>
      <div className="settings-content">
        <div>
          <AppearanceSettings />
        </div>
      </div>
    </main>
  ) : (
    <Onboarding key={state.key} initialStep={state.step} mode={state.mode} />
  );
}
createRoot(document.getElementById("root")).render(<QueryClientProvider client={queryClient}>{startup ? <App /> : <Fixture />}</QueryClientProvider>);
