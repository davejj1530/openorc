/** Production sidebar with deterministic projects and threads; never starts a provider. */
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { WORKSPACE_ID } from "../../packages/protocol/src/index";
import type { ProjectIconsApi, ProjectIconState } from "../../apps/desktop/src/shared/project-icons";
import mark from "../../apps/desktop/src/renderer/src/assets/openorc-mark.png";
import { PROJECT_STACK_LABELS, type ProjectStackIconId } from "../../apps/desktop/src/shared/project-stack-icons";
import { ProjectStackIcon } from "../../apps/desktop/src/renderer/src/components/ProjectStackIcon";

const icon = { path: "apps/desktop/resources/icon.png", dataUrl: mark };
const iconStates = new Map<string, ProjectIconState>();
const fallbacks: Record<string, ProjectStackIconId> = { "/fixture/website": "nextjs", "/fixture/api": "nestjs", "/fixture/scripts": "typescript" };
function initialIcons(root: string): ProjectIconState {
  return { mode: "auto", selected: root === "/fixture/studio" ? icon : null, candidates: root === "/fixture/studio" ? [icon] : [], fallback: fallbacks[root] ?? null };
}
const projectIcons: ProjectIconsApi = {
  async get(root) {
    const state = iconStates.get(root) ?? initialIcons(root);
    iconStates.set(root, state);
    return state;
  },
  async refresh(root) {
    return this.get(root);
  },
  async choose(root, choice) {
    const previous = await this.get(root);
    const selected = choice.mode === "manual" ? icon : null;
    const state = choice.mode === "auto" ? initialIcons(root) : { ...previous, mode: choice.mode, selected };
    iconStates.set(root, state);
    return state;
  },
  async pick() {
    return null;
  },
  onChanged() {
    return () => {};
  },
};
Object.assign(window, { openorc: { platform: "darwin", projectIcons } });

async function main() {
  const params = new URLSearchParams(location.search);
  const iconPreview = params.has("icons");
  const { core } = await import("../../apps/desktop/src/renderer/src/lib/rpc");
  const { queryClient } = await import("../../apps/desktop/src/renderer/src/lib/query");
  const { useLayout } = await import("../../apps/desktop/src/renderer/src/lib/layout");
  const { useRouter } = await import("../../apps/desktop/src/renderer/src/lib/router");
  const { useUi } = await import("../../apps/desktop/src/renderer/src/lib/ui");
  const projects = [
    { id: "openorc", name: "studio", rootPath: "/fixture/studio" },
    { id: "site", name: "Website", rootPath: "/fixture/website" },
    ...(iconPreview
      ? [
          { id: "api", name: "sma-2-api", rootPath: "/fixture/api" },
          { id: "scripts", name: "Scripts", rootPath: "/fixture/scripts" },
        ]
      : []),
    { id: "long", name: "A project with a very long name that needs to truncate", rootPath: "/fixture/long" },
  ];
  const titles = [
    "Redesign the sidebar",
    "Review the latest changes",
    "Improve the thread header",
    "Keep the input compact",
    "Check the new onboarding flow",
    "Update the navigation",
    "A thread for later",
    "Fix thread status indicators",
    "An older conversation",
    "One more conversation",
  ];
  const threads = [
    ...titles.map((title, index) => ({
      id: `openorc-${index}`,
      projectId: "openorc",
      title,
      agent: index % 2 ? "claude" : "codex",
      branch: index === 2 ? "feature/a-very-long-branch-name-that-must-truncate" : "main",
      agents: index === 2 ? ["codex", "codex", "claude"] : undefined,
      pinnedAt: index === 0 ? 1 : null,
      snoozedUntil: index === 6 ? Date.now() + 86400000 : null,
      activity: index === 1 ? "running" : "idle",
    })),
    { id: "workspace", projectId: WORKSPACE_ID, title: "Plan this week's work" },
    { id: "site-1", projectId: "site", title: "Refresh the landing page", activity: "waiting" },
    { id: "site-2", projectId: "site", title: "Review homepage copy", unread: true },
    { id: "archived", projectId: "site", title: "An archived conversation", archivedAt: 1 },
  ].map((thread) => ({ agent: "codex", branch: null, activity: "idle", session: { status: "idle" }, archivedAt: null, unread: false, ...thread }));
  let failProject: string | null = null;
  const removed = new Set<string>();
  core.call = (async (method: string, params: Record<string, unknown>) => {
    if (method === "projects.list") return projects.filter((project) => !removed.has(project.id));
    if (method === "projects.remove") {
      removed.add(String(params.id));
      return { ok: true };
    }
    if (method === "tasks.list") return [{ id: "review", projectId: "site", status: "review" }];
    if (method === "threads.list") {
      if (params.projectId === failProject) throw Error("Offline");
      return threads.filter((t) => t.projectId === params.projectId && (params.filter === "archived") === !!t.archivedAt).slice(0, Number(params.limit));
    }
    if (method === "threads.get") return threads.find((t) => t.id === params.id) ?? null;
    return [];
  }) as typeof core.call;
  queryClient.setDefaultOptions({ queries: { retry: false } });
  useLayout.setState({ sidebarOpen: true, projectId: "openorc", collapsed: iconPreview ? ["project:openorc", "project:site"] : [], sidebarFilter: "active" });
  useLayout.getState().setSidebarWidth(Number(params.get("width")) || 288);
  useRouter.getState().navigate(iconPreview ? { view: "tasks" } : { view: "thread", threadId: "openorc-0" });
  Object.assign(window, {
    sidebarSmoke: {
      route: () => useRouter.getState().route,
      scope: () => useLayout.getState().projectId,
      order: () => useUi.getState().threadOrder,
      ui: () => ({ importProject: useUi.getState().importProject }),
      filter: (filter: "active" | "archived") => useLayout.getState().setSidebarFilter(filter),
      width: (width: number) => useLayout.getState().setSidebarWidth(width),
      navigate: (id: string) => useRouter.getState().navigate({ view: "thread", threadId: id }),
      fail: async (id: string | null) => {
        failProject = id;
        await queryClient.invalidateQueries({ queryKey: ["threads.list"] });
      },
    },
  });
  const { Sidebar } = await import("../../apps/desktop/src/renderer/src/components/Sidebar");
  document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
      <div className="app-shell flex h-full">
        <Sidebar />
        <main className="flex-1 min-w-0 m-2 rounded-lg bg-surface overflow-auto">
          {iconPreview ? (
            <div className="p-6 text-ink-2">
              <h1 className="text-lg font-medium mb-2">Project icons</h1>
              <p className="text-sm text-ink-3 mb-6">Preview data · 24 bundled Devicon logos at 16px and 24px</p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "24px 32px" }}>
                {Object.entries(PROJECT_STACK_LABELS).map(([id, label]) => (
                  <div key={id} className="flex items-center gap-3 text-base">
                    <ProjectStackIcon id={id as ProjectStackIconId} />
                    <ProjectStackIcon id={id as ProjectStackIconId} size={24} />
                    <span>{label}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </main>
      </div>
    </QueryClientProvider>,
  );
}
void main();
