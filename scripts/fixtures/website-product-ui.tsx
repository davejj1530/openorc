/** Marketing captures use the production app and deterministic sample data.
 * No live RPC, account, project files, or provider calls are available here. */
import { defaultOrclingLook } from "../../packages/protocol/src/index";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createDesignSettingsRpc } from "./design-settings";
import { useRouter } from "../../apps/desktop/src/renderer/src/lib/router";

let automaticChecks = false;
Object.assign(window, {
  openorc: {
    platform: "darwin",
    openExternal() {},
    openWindow() {},
    onTheme: () => () => {},
    setTheme() {},
    updates: { settings: async () => ({ automaticChecks }), setAutomaticChecks: async (value: boolean) => ({ automaticChecks: (automaticChecks = value) }) },
    assetUrl: (p: string) => p,
  },
});

async function main() {
  const query = new URLSearchParams(location.search);
  const designPreview = query.has("design");
  // Capture at 2x pixel density without enlarging the component's layout.
  // This is fixture-only; the production renderer's styles are unchanged.
  const captureScale = query.get("scale") === "2" ? 2 : 1;
  const sizeCapture = () => {
    const root = document.getElementById("root")!;
    root.style.width = `${window.innerWidth / captureScale}px`;
    root.style.height = `${(window.innerHeight - (designPreview ? 40 : 0)) / captureScale}px`;
    root.style.zoom = String(captureScale);
  };
  sizeCapture();
  window.addEventListener("resize", sizeCapture);
  const { core } = await import("../../apps/desktop/src/renderer/src/lib/rpc");
  const { queryClient } = await import("../../apps/desktop/src/renderer/src/lib/query");
  const { useLayout } = await import("../../apps/desktop/src/renderer/src/lib/layout");
  const { useTheme } = await import("../../apps/desktop/src/renderer/src/lib/theme");
  const { emptyRun, seedRun } = await import("../../apps/desktop/src/renderer/src/lib/transcript");
  const mode = query.get("view") ?? "workspace";
  const now = Date.now();
  const project = { id: "studio", name: "studio", rootPath: "/Projects/studio", defaultBranch: "main", gitRemote: null, settings: {}, createdAt: now, updatedAt: now };
  const projects = [project, { ...project, id: "website", name: "website", rootPath: "/Projects/website" }, { ...project, id: "atlas", name: "atlas-api", rootPath: "/Projects/atlas-api" }];
  const base = {
    projectId: "studio",
    agent: "codex",
    model: "gpt-6-astra",
    effort: "high",
    fastMode: false,
    mode: "act",
    permissionMode: "review",
    workspaceMode: "current",
    branch: "main",
    worktreePath: null,
    workingDirectory: null,
    baseSha: null,
    pinnedAt: null,
    snoozedUntil: null,
    prUrl: null,
    prState: null,
    forkedFromId: null,
    forkedAtRunId: null,
    draft: null,
    importedFrom: null,
    createdAt: now - 180000,
    updatedAt: now,
    lastActivityAt: now,
    lastAgentEventAt: now - 20000,
    archivedAt: null,
    activity: "idle",
    unread: false,
    session: { status: "idle", message: null },
    hasStarted: true,
    context: { used: 36000, window: 200000 },
    queued: [],
    taskCount: 0,
    openTaskCount: 0,
  };
  const threads = [
    { ...base, id: "onboarding", title: "Make the first five minutes count" },
    { ...base, id: "team", title: "Build a thoughtful onboarding", teamInstanceId: "instance", agents: ["codex", "claude", "codex"] },
    { ...base, id: "search", title: "A faster command menu", agent: "claude", model: "claude-opus-5-5[1m]", activity: "running" },
    { ...base, id: "tokens", title: "Simplify the design tokens" },
    { ...base, id: "welcome", projectId: "website", title: "Tell the product story" },
    { ...base, id: "perf", projectId: "atlas", title: "Review the search endpoint" },
  ];
  const orclings = ["Rini", "Atlas", "Pip"].map((name, index) => ({
    id: name.toLowerCase(),
    name,
    threadId: `orcling-${name.toLowerCase()}`,
    look: { ...defaultOrclingLook, shape: index },
    settings: { agent: "codex", model: "gpt-6-astra", effort: "high", fastMode: false },
    permission: "approve",
    createdAt: now,
    updatedAt: now,
  }));
  threads.push(...orclings.map((orcling) => ({ ...base, id: orcling.threadId, title: orcling.name, projectId: "openorc-workspace", orclingId: orcling.id, branch: null })));
  const tasks = [
    ["welcome", "Create the welcome flow", "review", "high"],
    ["picker", "Polish the project picker", "review", "medium"],
    ["keys", "Add keyboard navigation", "in_progress", "medium"],
    ["empty", "Write useful empty states", "backlog", "medium"],
    ["docs", "Update the getting started guide", "backlog", "low"],
    ["tests", "Cover the first-run experience", "backlog", "medium"],
    ["tokens", "Use shared design tokens", "done", "medium"],
  ].map(([id, title, status, priority], i) => ({
    ...base,
    id,
    title,
    status,
    priority,
    threadId: "onboarding",
    labels: i < 2 ? ["Onboarding"] : [],
    spec: "## Goal\nMake the first run clear and welcoming.\n\n## Acceptance criteria\n- [x] Use existing components\n- [x] Support keyboard navigation\n- [ ] Review the final experience",
    createdAt: now - 3600000,
    updatedAt: now,
  }));
  const patch = `diff --git a/src/Welcome.tsx b/src/Welcome.tsx\n--- a/src/Welcome.tsx\n+++ b/src/Welcome.tsx\n@@ -1,10 +1,16 @@\n import { ProjectPicker } from './ProjectPicker';\n+import { Button } from './ui';\n \n export function Welcome() {\n   return (\n-    <main className="empty">\n-      <p>No projects yet.</p>\n+    <main className="welcome">\n+      <h1>Make yourself at home.</h1>\n+      <p>Connect a project to start building.</p>\n       <ProjectPicker />\n+      <Button onClick={startConversation}>\n+        Start a conversation\n+      </Button>\n+      <KeyboardHint />\n     </main>\n   );\n }\n`;
  const diff = { baseSha: null, since: null, patch, files: [{ path: "src/Welcome.tsx", status: "modified", oldPath: null }], branch: "main", base: "main", dirty: true };
  const messages = [
    { id: "request", role: "user", text: "Let’s make onboarding feel more thoughtful. Help people connect their first project, then give them a clear next step.", createdAt: now - 90000 },
    {
      id: "response",
      role: "assistant",
      text: "The welcome flow is ready to review. It uses the existing components and keeps the first run focused on one decision at a time.\n\n### A calmer first five minutes\n\n- **A real welcome.** A short introduction gives people a place to start.\n- **One clear next step.** Connect a project, then open a conversation.\n- **Keyboard support throughout.** Move between choices without leaving the keyboard.\n\nThe changes are in `src/Welcome.tsx`. You can review them alongside this conversation.",
      createdAt: now - 45000,
    },
  ];
  const members = [
    {
      key: "lead",
      name: "Lead",
      managerKey: null,
      responsibility: "Coordinate the work and keep the direction clear",
      settings: { agent: "codex", model: "gpt-6-astra", effort: "high", fastMode: false },
    },
    { key: "builder", name: "Builder", managerKey: "lead", responsibility: "Implement the interface", settings: { agent: "claude", model: "claude-opus-5-5[1m]", effort: "high", fastMode: false } },
    { key: "reviewer", name: "Reviewer", managerKey: "lead", responsibility: "Review behavior and accessibility", settings: { agent: "codex", model: "gpt-6-astra", effort: "high", fastMode: false } },
  ];
  const replies = [
    "I’ll keep the first run focused. @Builder, take the welcome flow. @Reviewer, check the keyboard path and empty states.",
    "The welcome flow is ready. I reused the project picker and shared controls, and kept the primary action in the same place on every step.",
    "Keyboard navigation and focus order look good. The empty state now explains what to do next. Ready for your review.",
  ];
  const actors = members.map((m, i) => ({
    id: i === 0 ? "lead" : `member:${m.key}`,
    memberKey: m.key,
    taskId: null,
    parentId: i === 0 ? null : "lead",
    title: m.name,
    createdAt: now - 90000,
    state: "completed",
    settings: m.settings,
    runIds: [m.key],
    runs: [{ id: m.key, turnId: `${m.key}-turn`, turn: 0, startedAt: now - 85000 + i * 10000, completedAt: now - 80000 + i * 10000, reason: "addressed", silent: false, changedFiles: [] }],
    activeRunId: null,
    error: null,
    result: null,
    retry: { allowed: false, reason: null },
    workspace: null,
  }));
  for (let i = 0; i < members.length; i++) {
    const id = members[i].key;
    const blocks = [{ kind: "message", role: "assistant", id: `reply-${id}`, text: replies[i], streaming: false, at: now - 80000 + i * 10000 }];
    seedRun({
      ...emptyRun(id),
      blocks,
      blockIndex: new Map(blocks.map((b) => [b.id, 0])),
      turnOf: new Map(blocks.map((b) => [b.id, 0])),
      hydrated: true,
      eventCount: 1,
      turnsCompleted: 1,
    } as never);
  }
  const team = {
    instance: { id: "instance", threadId: "team", teamRevisionId: "revision", leadOverrides: {} },
    revision: { id: "revision", teamId: "team-config", name: "Product team", number: 1, members },
    executions: [
      {
        id: "execution",
        state: "completed",
        activity: "idle",
        generation: 1,
        createdAt: now - 90000,
        updatedAt: now,
        error: null,
        initialPrompt: {
          text: "Let’s build a thoughtful onboarding experience. Work together on the implementation and review.",
          attachments: [],
          createdAt: now - 90000,
          seenBy: actors.map((a, i) => ({ actorId: a.id, name: members[i].name })),
        },
        actors,
        userDirections: [],
        publications: [],
        chat: [],
      },
    ],
    actions: { fork: { allowed: true, reason: null } },
    context: { compact: { allowed: true, reason: null }, checkpoints: [] },
    policy: { requested: "review", effective: "review", pendingRestart: false, runs: [], mode: { requested: "act", effective: "act", pending: false } },
  };
  const models = [
    { agent: "codex", id: "gpt-6-astra", label: "GPT-6-Astra", efforts: ["high"], defaultEffort: "high", isDefault: true },
    { agent: "claude", id: "claude-opus-5-5[1m]", label: "Opus 5.5 (1M context)", efforts: ["high"], defaultEffort: "high" },
  ];
  const settingsRpc = createDesignSettingsRpc();
  core.call = (async (method: string, params: Record<string, unknown> = {}) => {
    const setting = settingsRpc(method, params);
    if (setting !== undefined) return setting;
    if (method === "tasks.comments.list")
      return {
        comments: [
          { id: "discussion", taskId: "welcome", body: "How should we handle the first run? Check the approach before we build it.", source: "comment", createdAt: now - 180000 },
          { id: "implementation", taskId: "welcome", body: "Implement the welcome flow using both recommendations.", source: "comment", createdAt: now - 40000 },
        ],
        attempts: [
          {
            id: "codex-perspective",
            commentId: "discussion",
            recipient: { agent: "codex", model: "gpt-6-astra", effort: "high" },
            body: "Start with the project picker. Reuse the existing connection flow and keep the first screen focused on one action.",
            state: "success",
            createdAt: now - 120000,
          },
          {
            id: "claude-perspective",
            commentId: "discussion",
            recipient: { agent: "claude", model: "claude-opus-5-5[1m]", effort: "high" },
            body: "Keep keyboard navigation available from the start. Give an empty project list a clear next step, and return focus after connecting a repository.",
            state: "success",
            createdAt: now - 60000,
          },
          {
            id: "implementation-result",
            commentId: "implementation",
            recipient: { agent: "codex", model: "gpt-6-astra", effort: "high" },
            body: "Implemented the welcome flow with keyboard navigation and an empty state. The changes are ready for review.",
            state: "completed",
            threadId: "onboarding",
            executionRunId: "implementation-run",
            createdAt: now - 10000,
          },
        ],
        questions: [],
      };
    if (method === "threads.plans")
      return [2, 1].map((revision) => ({
        id: `plan-${revision}`,
        threadId: "onboarding",
        runId: "plan-run",
        source: "native",
        revision,
        state: "ready",
        text: "## First-run experience\n\nConnect a project, then start a conversation. Keep the existing picker and shared controls.\n\n### Implementation\n\n1. Add a welcome view with a single project action.\n2. Reuse the repository connection flow.\n3. Restore focus when the picker closes.\n4. Cover keyboard navigation and the empty state.\n\n### Verification\n\nCheck a fresh workspace, an existing project, and a cancelled connection.",
      }));
    if (method === "schedules.list")
      return [
        { id: "daily-review", title: "Review recent changes", everyMinutes: 1440, agent: "codex", model: "gpt-6-astra", enabled: true },
        { id: "dependency-review", title: "Check dependency updates", everyMinutes: 10080, agent: "claude", model: "claude-opus-5-5[1m]", enabled: true },
        { id: "docs-review", title: "Check docs against the code", everyMinutes: 10080, agent: "codex", model: "gpt-6-astra", enabled: false },
      ].map((schedule) => ({ ...schedule, projectId: "studio", version: 1, lastRunAt: now - 3600000, nextRunAt: now + 3600000, lastThreadId: "onboarding" }));
    if (method === "orclings.list") return orclings;
    if (method === "threads.lastMessage") return messages[1];
    if (method === "orclings.instructions") return [{ version: 1, body: "Help me make clear decisions. Keep project work and personal memory separate.", author: "user", note: null, createdAt: now }];
    if (method === "projects.list") return projects;
    if (method === "projects.git") return "ready";
    if (method === "projects.get")
      return params.id === "openorc-workspace" ? { ...project, id: "openorc-workspace", name: "Workspace", rootPath: "/Projects" } : (projects.find((p) => p.id === params.id) ?? project);
    if (method === "projects.checkoutBranch") return "main";
    if (method === "workspace.get") return { ...project, id: "openorc-workspace", name: "Workspace" };
    if (method === "threads.list") return threads.filter((t) => (!params.projectId || t.projectId === params.projectId) && (params.filter === "archived" ? Boolean(t.archivedAt) : !t.archivedAt));
    if (method === "threads.get") return threads.find((t) => t.id === params.id) ?? threads[0];
    if (method === "threads.messages") return params.id === "team" ? [] : messages;
    if (method === "threads.update") {
      const index = threads.findIndex((thread) => thread.id === params.id);
      if (index >= 0) threads[index] = { ...threads[index], ...params.patch };
      return threads[index] ?? threads[0];
    }
    if (method === "threads.permissions") return team.policy;
    if (method === "tasks.list" || method === "tasks.listForThread") return tasks.filter((task) => !params.projectId || task.projectId === params.projectId);
    if (method === "tasks.get") return tasks.find((t) => t.id === params.id) ?? tasks[0];
    if (method === "tasks.update") return Object.assign(tasks.find((t) => t.id === params.id) ?? tasks[0], params.patch, { updatedAt: Date.now() });
    if (method === "tasks.executionThread") return null;
    if (method === "orchestration.taskState") return null;
    if (method === "review.threadDiff" || method === "review.projectDiff" || method === "review.diff") return String(params.threadId).startsWith("orcling-") ? { ...diff, files: [], patch: "" } : diff;
    if (method === "git.threadPushState") return { branch: "main", blocked: null, published: true, unpushedCount: 0, unpushed: [] };
    if (method === "orchestration.runtime") return team;
    if (method === "orchestration.availability") return { enabled: true, maxHierarchyDepth: 3 };
    if (method === "agents.models") return models;
    if (method === "agents.modelCatalog") return { models, providers: [] };
    if (method === "agents.updates.get") return { agents: [], automatic: false, checking: false, updating: false };
    if (method === "system.info")
      return {
        dataDir: "/Users/you/Library/Application Support/OpenOrc",
        harnesses: [
          { id: "codex", state: "ready" },
          { id: "claude", state: "ready" },
          { id: "opencode", state: "not_found" },
        ],
        codex: { installed: true, loggedIn: true },
        gh: { installed: true, loggedIn: true },
      };
    return [];
  }) as typeof core.call;
  queryClient.setDefaultOptions({ queries: { retry: false } });
  useTheme.getState().setPreset(query.get("palette") === "cursor" ? "cursor" : "openorc");
  useTheme.getState().set(query.get("theme") === "light" ? "light" : "dark");
  const { accentCombinations } = await import("../../apps/desktop/src/renderer/src/lib/theme-accents");
  const accent = accentCombinations.find((entry) => entry.id === query.get("accent"));
  if (accent) useTheme.getState().setAccentCombination(accent.id);
  else if (query.get("accent") === "default") useTheme.getState().resetAccents();
  useLayout.setState({
    sidebarOpen: window.innerWidth > 900,
    panelOpen: false,
    projectId: null,
    collapsed: ["project:openorc-workspace", "project:atlas"],
    hiddenScreens: ["pulls", "orchestration", "memory"],
  });
  useLayout.getState().setSidebarWidth(267);
  useLayout.getState().setPanelWidth(640);
  // Detail captures render the same production components at readable widths.
  // They are panel crops, so no window chrome is invented around them.
  if (mode === "discussion" || mode === "plan" || mode === "delivery") {
    const { TaskComments } = await import("../../apps/desktop/src/renderer/src/components/TaskComments");
    const { ConversationPlan } = await import("../../apps/desktop/src/renderer/src/components/ConversationPlan");
    const { ReviewPanel } = await import("../../apps/desktop/src/renderer/src/panels/ReviewPanel");
    const { TaskDraftProvider } = await import("../../apps/desktop/src/renderer/src/lib/task-draft-context");
    createRoot(document.getElementById("root")!).render(
      <QueryClientProvider client={queryClient}>
        <div style={{ height: "100%", background: "var(--bg)", padding: mode === "discussion" ? "0 24px" : 0, overflow: "auto" }}>
          {mode === "discussion" && <TaskComments taskId="welcome" description="" beforeSend={async () => true} />}
          {mode === "plan" && <ConversationPlan thread={threads[0] as never} />}
          {mode === "delivery" && (
            <TaskDraftProvider taskId="welcome">
              <ReviewPanel task={{ ...tasks[0], threadId: null, branch: "welcome-flow" } as never} project={project as never} />
            </TaskDraftProvider>
          )}
        </div>
      </QueryClientProvider>,
    );
    return;
  }
  if (mode === "schedules") {
    useLayout.setState({ sidebarOpen: false });
    useRouter.getState().navigate({ view: "scheduled" });
  } else if (mode === "tasks") useRouter.getState().navigate({ view: "tasks" });
  else if (["usage", "connections", "slack", "skills", "appearance", "general", "memory", "data"].includes(mode)) {
    useRouter.getState().navigate({ view: "settings", section: mode as "usage" });
  } else if (mode === "new") useRouter.getState().navigate({ view: "newthread", projectId: "studio" });
  else if (mode === "orclings") useRouter.getState().navigate({ view: "thread", threadId: "orcling-rini" });
  else if (mode === "document") useRouter.getState().navigate({ view: "task", taskId: "welcome", tab: "spec" });
  else useRouter.getState().navigate({ view: "thread", threadId: mode === "teams" ? "team" : "onboarding" });
  if (mode === "review") useLayout.getState().openWorkspaceChanges({ kind: "thread", id: "onboarding" });
  const { App } = await import("../../apps/desktop/src/renderer/src/App");
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
      <App />
      {designPreview ? <DesignPreviewBar /> : null}
      {/* Browser captures omit Electron's native chrome. Reproduce only the
          buttons in the space already reserved by the production header:
          main/index.ts trafficLightPosition (14, 13), 14px buttons, 9px gaps. */}
      <div aria-hidden="true" style={{ position: "fixed", left: 14, top: 13, display: "flex", gap: 9, pointerEvents: "none", zIndex: 100 }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((background) => (
          <span key={background} style={{ width: 14, height: 14, borderRadius: "50%", background }} />
        ))}
      </div>
    </QueryClientProvider>,
  );
}

/** Preview controls live outside the production app; all views use its real components. */
function DesignPreviewBar() {
  const query = new URLSearchParams(location.search);
  const threadId = useRouter((state) => (state.route.view === "thread" ? state.route.threadId : null));
  let previewView = ["connections", "slack", "skills", "general", "memory", "data"].includes(query.get("view") ?? "") ? "usage" : (query.get("view") ?? "workspace");
  if (threadId?.startsWith("orcling-")) previewView = "orclings";
  else if (threadId && previewView === "orclings") previewView = threadId === "team" ? "teams" : "workspace";
  return (
    <nav
      aria-label="Design preview"
      style={{
        position: "fixed",
        inset: "auto 0 0",
        height: 40,
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "0 18px",
        background: "var(--bg)",
        borderTop: "1px solid var(--line)",
        fontSize: 12,
      }}
    >
      <span style={{ color: "var(--ink-3)", marginRight: "auto", minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>Design study · Sample data</span>
      <label style={{ display: "flex", gap: 6, flexShrink: 0 }}>
        View
        <select
          aria-label="Preview view"
          style={{ maxWidth: 140 }}
          value={previewView}
          onChange={(e) => {
            query.set("view", e.target.value);
            location.search = query.toString();
          }}
        >
          <option value="workspace">Conversation</option>
          <option value="teams">Team conversation</option>
          <option value="orclings">Orclings</option>
          <option value="new">New thread</option>
          <option value="tasks">Tasks</option>
          <option value="document">Document</option>
          <option value="review">Changes</option>
          <option value="usage">Settings</option>
          <option value="appearance">Appearance</option>
        </select>
      </label>
      <label style={{ display: "flex", gap: 6, flexShrink: 0 }}>
        Theme
        <select
          aria-label="Preview theme"
          value={query.get("theme") ?? "dark"}
          onChange={(e) => {
            query.set("theme", e.target.value);
            query.set("view", previewView);
            location.search = query.toString();
          }}
        >
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
    </nav>
  );
}
void main();
