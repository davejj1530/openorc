/** Marketing captures use the production app and deterministic sample data.
 * No live RPC, account, project files, or provider calls are available here. */
import { defaultOrclingLook } from "../../packages/protocol/src/index";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createDesignSettingsRpc } from "./design-settings";
import { useRouter } from "../../apps/desktop/src/renderer/src/lib/router";
import type { Block, RunTranscript } from "../../packages/client/src/index";
// main.tsx stamps the saved typefaces on <html>; the panel crops render without App, which would otherwise skip them.
import "../../apps/desktop/src/renderer/src/lib/app-font";
import "../../apps/desktop/src/renderer/src/lib/code-font";

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
    revealFile() {},
    ...panelBridges(),
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
  const { queryClient } = await import("../../apps/desktop/src/renderer/src/lib/client");
  const { useLayout, limits } = await import("../../apps/desktop/src/renderer/src/lib/layout");
  const { useWindow } = await import("../../apps/desktop/src/renderer/src/lib/window");
  const fullscreen = query.get("fullscreen") === "1";
  useWindow.setState({ fullscreen });
  const { useTheme, parsePreset } = await import("../../apps/desktop/src/renderer/src/lib/theme");
  const { emptyRun } = await import("../../packages/client/src/index");
  const { runs } = await import("../../apps/desktop/src/renderer/src/lib/client");
  const mode = query.get("view") ?? "workspace";
  const now = Date.now();
  const project = {
    id: "studio",
    name: "studio",
    rootPath: "/Projects/studio",
    defaultBranch: "main",
    gitRemote: pageViews.has(mode) ? "git@github.com:acme/studio.git" : null,
    settings: pageViews.has(mode)
      ? { setupScript: "pnpm install --frozen-lockfile", worktreeInclude: [".env", ".env.local"], branchPrefix: "openorc", detectedConfigs: ["AGENTS.md", ".cursor/rules"] }
      : {},
    createdAt: now,
    updatedAt: now,
  };
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
  /** Holds a run's transcript as the app does once it has loaded, for the rows and views that read it. */
  const seedTranscript: Seed = (runId, blocks, state) =>
    runs.seed({
      ...emptyRun(runId),
      blocks,
      blockIndex: new Map(blocks.map((block, index) => [block.id, index])),
      turnOf: new Map(blocks.map((block) => [block.id, 0])),
      hydrated: true,
      eventCount: blocks.length,
      ...state,
    });
  for (const [i, { key }] of members.entries()) {
    seedTranscript(key, [{ kind: "message", role: "assistant", id: `reply-${key}`, text: replies[i]!, streaming: false, at: now - 80000 + i * 10000 }], { turnsCompleted: 1 });
  }
  const shell = mode === "shell" || mode === "inbox" ? addShellStates({ base, projects, threads, tasks, seed: seedTranscript }) : null;
  const working = mode === "working" ? addWorkingStates({ base, threads, now, response: messages[1]!.text, seed: seedTranscript }) : null;
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
  const settingsRpc = createDesignSettingsRpc({ phone: query.get("phone") });
  const pageRpc = pageViews.has(mode) ? pageStates({ mode, now, project, orclings, patch }) : null;
  core.call = (async (method: string, params: Record<string, unknown> = {}) => {
    const setting = settingsRpc(method, params);
    if (setting !== undefined) return setting;
    const page = pageRpc?.(method, params);
    if (page !== undefined) return page;
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
    if (method === "inbox.list") return { items: shell?.inbox ?? [] };
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
    if (method === "threads.messages") return params.id === "team" || working ? [] : messages;
    if (working && method === "runs.listForThread") return params.threadId === "onboarding" ? working.runs : [];
    if (working && method === "threads.checkpoints") return params.id === "onboarding" ? working.checkpoints : [];
    if (working && method === "threads.turnChanges") return working.turnChanges;
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
    const panelStub = panelRpc(method, params, now);
    if (panelStub !== undefined) return panelStub;
    return [];
  }) as typeof core.call;
  queryClient.setDefaultOptions({ queries: { retry: false } });
  useTheme.getState().setPreset(parsePreset(query.get("palette")));
  useTheme.getState().set(query.get("theme") === "light" ? "light" : "dark");
  const { accentCombinations } = await import("../../packages/client/src/theme/index");
  const accent = accentCombinations.find((entry) => entry.id === query.get("accent"));
  if (accent) useTheme.getState().setAccentCombination(accent.id);
  else if (query.get("accent") === "default") useTheme.getState().resetAccents();
  useLayout.setState({
    sidebarOpen: window.innerWidth > 900,
    panelOpen: false,
    projectId: null,
    collapsed: ["project:openorc-workspace", "project:atlas", ...(shell?.collapsed ?? [])],
    hiddenScreens: ["pulls", "orchestration", "memory"],
  });
  useLayout.getState().setSidebarWidth(query.get("sidebar") === "narrow" ? limits.sidebar.min : limits.sidebar.default);
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
  } else if (pageViews.has(mode)) useRouter.getState().navigate(pageRoute(mode));
  else if (mode === "tasks") useRouter.getState().navigate({ view: "tasks" });
  else if (mode === "inbox") useRouter.getState().navigate({ view: "inbox" });
  else if (["usage", "connections", "slack", "phone", "skills", "appearance", "general", "memory", "data"].includes(mode)) {
    useRouter.getState().navigate({ view: "settings", section: mode as "usage" });
  } else if (mode === "new") useRouter.getState().navigate({ view: "newthread", projectId: "studio" });
  else if (mode === "orclings") useRouter.getState().navigate({ view: "thread", threadId: "orcling-rini" });
  else if (mode === "document") useRouter.getState().navigate({ view: "task", taskId: "welcome", tab: "spec" });
  else useRouter.getState().navigate({ view: "thread", threadId: mode === "teams" ? "team" : "onboarding" });
  if (mode === "review") useLayout.getState().openWorkspaceChanges({ kind: "thread", id: "onboarding" });
  if (query.get("panel")) await openPanelTabs(query.get("panel")!, mode === "orclings" ? "thread:orcling-rini" : "thread:onboarding");
  const { App } = await import("../../apps/desktop/src/renderer/src/App");
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
      <App />
      {designPreview ? <DesignPreviewBar /> : null}
      {/* Browser captures omit Electron's native chrome. Reproduce only the
          buttons in the space already reserved by the production header:
          main/index.ts trafficLightPosition (14, 13), 14px buttons, 9px gaps. */}
      {!fullscreen ? (
        <div aria-hidden="true" style={{ position: "fixed", left: 14, top: 13, display: "flex", gap: 9, pointerEvents: "none", zIndex: 100 }}>
          {["#ff5f57", "#febc2e", "#28c840"].map((background) => (
            <span key={background} style={{ width: 14, height: 14, borderRadius: "50%", background }} />
          ))}
        </div>
      ) : null}
    </QueryClientProvider>,
  );
}

/** Preview controls live outside the production app; all views use its real components. */
function DesignPreviewBar() {
  const query = new URLSearchParams(location.search);
  const threadId = useRouter((state) => (state.route.view === "thread" ? state.route.threadId : null));
  let previewView = ["connections", "slack", "phone", "skills", "general", "memory", "data"].includes(query.get("view") ?? "") ? "usage" : (query.get("view") ?? "workspace");
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
          <option value="shell">Sidebar states</option>
          <option value="working">Agent working</option>
          <option value="inbox">Inbox</option>
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

type Row = Record<string, unknown>;
type Seed = (runId: string, blocks: Block[], state?: Partial<RunTranscript>) => void;

/**
 * ?view=shell and ?view=inbox: the workspace data plus the sidebar and inbox states the redesign restyles. In the open
 * project, threads run, wait on an approval, failed, finished unread, or carry a merged pull request, and a title runs
 * long. Folded, website waits on a question and atlas-api runs. The last project, with a long name, has no threads.
 * A thread with a second line gets a seeded live run, as the app holds one while the thread is live. The inbox lists
 * approvals first, as the core does. Every state fits the sidebar of a 1440x900 window.
 */
function addShellStates({ base, projects, threads, tasks, seed }: { base: Record<string, unknown>; projects: Row[]; threads: Row[]; tasks: Row[]; seed: Seed }) {
  projects.push({ ...projects[0]!, id: "billing", name: "customer-billing-and-payments-reconciliation", rootPath: "/Projects/customer-billing-and-payments-reconciliation" });
  const thread = (id: string) => threads.find((row) => row.id === id)!;
  Object.assign(thread("team"), { prUrl: "https://github.com/acme/studio/pull/482", prState: "merged" });
  Object.assign(thread("search"), { liveRunId: "search-run" });
  Object.assign(thread("tokens"), { unread: true, liveRunId: "tokens-run" });
  Object.assign(thread("welcome"), { activity: "waiting", liveRunId: "welcome-run" });
  Object.assign(thread("perf"), { activity: "running" });
  threads.push(
    {
      ...base,
      id: "changelog",
      title: "Find out why the release build drops the changelog when a version tag carries a prerelease suffix",
      session: { status: "error", message: "Codex exited before the turn finished" },
    },
    { ...base, id: "release", title: "Publish the release notes", activity: "waiting", liveRunId: "release-run" },
  );
  const proposed = {
    ...tasks[0]!,
    id: "analytics",
    title: "Split the onboarding analytics so the first project and the first conversation are counted separately",
    status: "proposed",
    labels: [],
  };
  tasks.push(proposed);
  const request = (text: string): Block => ({ id: "request", kind: "message", role: "user", text, streaming: false });
  const tests = { kind: "tool", name: "Bash", input: { command: "pnpm --filter desktop test", description: "Run the desktop tests" } } as const;
  seed("search-run", [request("Make the command menu open instantly."), { ...tests, id: "tests", done: false }], { live: true });
  seed(
    "tokens-run",
    [
      request("Fold the duplicate color tokens into one scale."),
      { id: "edit", kind: "tool", name: "Edit", input: { file_path: "/Projects/studio/src/tokens.css", old_string: "--gray-2", new_string: "--ink-2" }, done: true },
      { ...tests, id: "tests", done: true },
    ],
    { live: true },
  );
  const push = "git push origin main";
  seed("release-run", [request("Publish the release notes."), { id: "push", kind: "approval", approvalId: "push", approvalKind: "command", input: { command: push } }], {
    live: true,
    pendingApprovals: 1,
  });
  const question = "Keep the old pricing page live until the new one ships?";
  seed("welcome-run", [request("Tell the product story."), { id: "question", kind: "approval", approvalId: "question", approvalKind: "user_input", input: { questions: [{ question }] } }], {
    live: true,
    pendingApprovals: 1,
  });
  const review = (id: string) => ({ kind: "task", task: tasks.find((task) => task.id === id)!, runId: null, reason: "review", detail: "Finished run waiting for your review" });
  const inbox = [
    { kind: "thread", thread: thread("release"), runId: "release-run", reason: "approval", detail: push },
    { kind: "thread", thread: thread("welcome"), runId: "welcome-run", reason: "approval", detail: question },
    { kind: "task", task: proposed, runId: null, reason: "proposed", detail: "Proposed by the agent, waiting for your go-ahead" },
    review("welcome"),
    review("picker"),
  ];
  return { inbox, collapsed: ["project:website"] };
}

/**
 * ?view=working: the conversation the transcript restyle needs. A finished turn with thinking, reads, an edit, a
 * passing test run, its reply and a change card, then a live turn with a plan on step 3 of 3, a running command, a
 * pending approval and a pending question, two queued messages and a background command.
 */
function addWorkingStates({ base, threads, now, response, seed }: { base: Row; threads: Row[]; now: number; response: string; seed: Seed }) {
  const at = (secondsAgo: number) => now - secondsAgo * 1000;
  Object.assign(
    threads.find((row) => row.id === "onboarding")!,
    {
      activity: "running",
      liveRunId: "working-live",
      queued: [
        { id: "queued-1", text: "Then add a short tour for returning people.", attachments: [], queuedAt: at(20) },
        { id: "queued-2", text: "Keep the copy under two lines.", attachments: [], queuedAt: at(10) },
      ],
      backgroundCommands: [{ id: "dev", description: "pnpm dev --port 5173" }],
    },
  );
  const run = (id: string, startedAt: number, state: string) => ({
    ...base,
    id,
    threadId: "onboarding",
    taskId: null,
    commentTurnId: null,
    externalSessionId: null,
    state,
    startedAt,
    endedAt: state === "running" ? null : startedAt + 72000,
    usage: null,
    resultText: null,
    error: null,
  });
  const read = (id: string, file: string): Block => ({ id, kind: "tool", name: "Read", input: { file_path: `/Projects/studio/src/${file}` }, done: true, at: at(590) });
  const finished: Block[] = [
    {
      id: "w-request",
      kind: "message",
      role: "user",
      text: "Let’s make onboarding feel more thoughtful. Help people connect their first project, then give them a clear next step.",
      streaming: false,
      at: at(600),
    },
    {
      id: "w-thinking",
      kind: "thinking",
      text: "**Planning the welcome**\n\nThe empty state competes with the picker. Lead with one action and keep the keyboard path obvious.",
      startedAt: at(599),
      endedAt: at(587),
      at: at(599),
    },
    read("w-read-1", "Welcome.tsx"),
    read("w-read-2", "ProjectPicker.tsx"),
    {
      id: "w-edit",
      kind: "tool",
      name: "Edit",
      input: { file_path: "/Projects/studio/src/Welcome.tsx", old_string: "<p>No projects yet.</p>", new_string: "<h1>Make yourself at home.</h1>" },
      done: true,
      at: at(570),
    },
    { id: "w-tests", kind: "tool", name: "Bash", input: { command: "pnpm test", description: "Run the tests" }, output: "42 passed in 8.2s", done: true, at: at(560) },
    { id: "w-reply", kind: "message", role: "assistant", text: response, streaming: false, at: at(530) },
    { id: "w-end", kind: "status", text: "turn finished in 72.0s", tone: "ok", boundary: "turn", durationMs: 72000, outcome: "success", at: at(528) },
  ];
  seed("working-done", finished, { turnsCompleted: 1 });
  const question = { id: "welcome", question: "Which welcome should I build?", options: ["One clear action", "A short tour", "Start from a template"].map((label) => ({ label, description: "" })) };
  const plan = ["Read 4 files", "Edit Welcome.tsx", "Run the tests"].map((content, i) => ({ content, status: i < 2 ? "completed" : "in_progress" }));
  const live: Block[] = [
    { id: "l-request", kind: "message", role: "user", text: "Cover the keyboard path with tests, and ask me before adding anything.", streaming: false, at: at(48) },
    { id: "l-thinking", kind: "thinking", text: "The keyboard tests need user-event. Ask before installing it.", startedAt: at(47), endedAt: at(35), at: at(47) },
    {
      id: "l-note",
      kind: "message",
      role: "assistant",
      text: "I’ll add a welcome view with one project action, reuse the picker, and cover the keyboard path with tests.",
      streaming: false,
      at: at(34),
    },
    { id: "l-plan", kind: "tool", name: "TodoWrite", input: { todos: plan }, done: true, at: at(33) },
    { id: "l-tests", kind: "tool", name: "Bash", input: { command: "pnpm test welcome.test.tsx", description: "Run the welcome tests" }, done: false, at: at(20) },
    {
      id: "l-approval",
      kind: "approval",
      approvalId: "l-approval",
      approvalKind: "command",
      toolName: "Bash",
      input: { command: "pnpm add -D @testing-library/user-event" },
      reason: "Add user-event for the keyboard tests?",
      at: at(12),
    },
    { id: "l-question", kind: "approval", approvalId: "l-question", approvalKind: "user_input", input: { questions: [question] }, at: at(8) },
  ];
  seed("working-live", live, { live: true, pendingApprovals: 2 });
  const checkpoint = (id: string, turn: number, runId: string | null) => ({
    id,
    threadId: "onboarding",
    runId,
    turn,
    treeSha: id,
    diffStat: { files: 2, insertions: 8, deletions: 2, untracked: 0 },
    note: null,
    root: "/Projects/studio",
    outside: null,
    createdAt: at(528),
  });
  return {
    runs: [run("working-done", at(600), "success"), run("working-live", at(48), "running")],
    checkpoints: [checkpoint("cp-0", 0, null), checkpoint("cp-1", 1, "working-done")],
    turnChanges: {
      files: [
        { path: "src/Welcome.tsx", added: 6, removed: 2 },
        { path: "src/ui/KeyboardHint.tsx", added: 2, removed: 0 },
      ],
      patch: null,
    },
  };
}

/**
 * Unit 9.0: the pages the redesign restyles that no other view reaches. project is the Project view (its Settings tab
 * reads the real settings shape), orcling and orcling-edit are the Orcling designer new and editing Rini, onboarding is
 * first-run setup with one agent in each scan state, pulls and pull are the pull request list and one pull request,
 * memory-page is the Memory page and team-config the Teams page. notices is the conversation with both update toasts:
 * an app update downloading and an agent update available.
 */
const pageViews = new Set(["project", "orcling", "orcling-edit", "onboarding", "pulls", "pull", "memory-page", "team-config", "notices"]);

function pageRoute(mode: string): Parameters<ReturnType<typeof useRouter.getState>["navigate"]>[0] {
  if (mode === "project") return { view: "project", projectId: "studio" };
  if (mode === "orcling") return { view: "orcling" };
  if (mode === "orcling-edit") return { view: "orcling", orclingId: "rini" };
  if (mode === "onboarding") return { view: "onboarding", mode: "first_run" };
  if (mode === "pulls") return { view: "pulls" };
  if (mode === "pull") return { view: "pull", projectId: "studio", number: 482 };
  if (mode === "memory-page") return { view: "memory" };
  if (mode === "notices") return { view: "thread", threadId: "onboarding" };
  return { view: "orchestration" };
}

function pageStates({ mode, now, project, orclings, patch }: { mode: string; now: number; project: Row; orclings: Row[]; patch: string }) {
  const pull = (number: number, title: string, extra: Row = {}) => ({
    number,
    title,
    url: `https://github.com/acme/studio/pull/${number}`,
    author: "rini",
    state: "open",
    isDraft: false,
    headRefName: "welcome-flow",
    baseRefName: "main",
    createdAt: now - 7200000,
    updatedAt: now - 1800000,
    additions: 128,
    deletions: 14,
    changedFiles: 4,
    reviewDecision: null,
    labels: [],
    ...extra,
  });
  const pulls = [
    pull(482, "Build a thoughtful onboarding", { reviewDecision: "review_required" }),
    pull(479, "Make the command menu open instantly", { author: "atlas", headRefName: "fast-command-menu", additions: 42, deletions: 31, reviewDecision: "approved" }),
    pull(475, "Fold the duplicate color tokens into one scale", { isDraft: true, headRefName: "design-tokens", additions: 12, deletions: 96 }),
    pull(471, "Check docs against the code", { author: "pip", headRefName: "docs-check", additions: 8, deletions: 2, reviewDecision: "changes_requested" }),
  ];
  const memory = (id: string, type: string, title: string, body: string, source = "agent") => ({
    id,
    scope: "project",
    projectId: "studio",
    type,
    topicKey: null,
    title,
    body,
    confidence: 0.9,
    status: "active",
    source,
    sourceRunId: null,
    sourceTaskId: null,
    evidenceCount: 2,
    files: [],
    createdAt: now - 86400000,
    updatedAt: now - 3600000,
    lastConfirmedAt: now - 3600000,
  });
  const memories = [
    memory("tests", "command", "Run the desktop tests with pnpm", "Use pnpm --filter desktop test; the root test script skips the renderer."),
    memory("tokens", "convention", "Components read semantic color roles", "Never use palette literals in components. Read --ink, --surface and the fill steps.", "user"),
    memory("worktrees", "decision", "Tasks run in fresh worktrees", "Each task branches from main into its own worktree so parallel agents never share files."),
    memory("bun", "env_quirk", "Corepack needs updating under Node 26", "pnpm 11 crashes on Corepack 0.25; update Corepack before installing."),
  ];
  const harnesses = [
    { id: "claude", state: "ready", path: "/usr/local/bin/claude", version: "2.1.296", revision: 1 },
    { id: "codex", state: "sign_in", path: "/usr/local/bin/codex", version: "0.81.0", revision: 1 },
    // ?scan=failed swaps OpenCode's missing row for a failed check: three agents carry four states.
    new URLSearchParams(location.search).get("scan") === "failed"
      ? { id: "opencode", state: "check_failed", path: "/usr/local/bin/opencode", version: null, revision: 1 }
      : { id: "opencode", state: "not_found", path: null, version: null, revision: 1 },
  ];
  if (mode === "notices") {
    const snapshot = { state: { phase: "downloading", version: "0.42.0", percent: 64 }, dismissed: false };
    Object.assign(window.openorc.updates, { getState: async () => snapshot, onState: () => () => {} });
  }
  return (method: string, params: Record<string, unknown>): unknown => {
    if (method === "agents.updates.get" && mode === "notices")
      return {
        agents: [{ id: "claude", installedVersion: "2.1.290", latestVersion: "2.1.296", status: "available", method: "npm", canUpdate: true, message: null, checkedAt: now }],
        automatic: false,
        checking: false,
        updating: false,
        dismissed: null,
      };
    if (method === "projects.updateSettings") return { ...project, settings: { ...(project.settings as Row), ...(params.settings as Row) } };
    if (method === "orclings.create" || method === "orclings.update") return orclings[0];
    if (method === "system.info" && mode === "onboarding")
      return { dataDir: "/Users/you/Library/Application Support/OpenOrc", harnesses, codex: { installed: true, loggedIn: false }, gh: { installed: true, loggedIn: true } };
    if (method === "pulls.list") return params.projectId === "studio" ? pulls : [];
    if (method === "pulls.get")
      return { ...pulls[0], body: "Connect a project, then start a conversation.\n\n- A short welcome\n- One clear next step", headSha: "a".repeat(40), baseSha: "b".repeat(40), viewer: "you" };
    if (method === "pulls.diff") return { patch, headSha: "a".repeat(40) };
    if (method === "pulls.review.get") return null;
    if (method === "memory.list") return memories;
    if (method === "memory.search") return memories.filter((entry) => entry.title.toLowerCase().includes(String(params.query).toLowerCase()));
    return undefined;
  };
}

/** No-op browser and terminal bridges, so the panel's browser and terminal render without Electron. */
function panelBridges() {
  const page = { url: "http://localhost:5173/", title: "localhost:5173", canGoBack: true, canGoForward: false, loading: false, error: null };
  const off = () => () => {};
  const noop = () => {};
  return {
    browser: {
      onReveal: off,
      onState: off,
      setContext: noop,
      show: async () => page,
      hide: noop,
      capture: async () => null,
      setBounds: noop,
      navigate: noop,
      goBack: noop,
      goForward: noop,
      reload: noop,
      close: noop,
    },
    terminal: {
      attach: noop,
      detach: noop,
      open: async () => ({ backlog: "studio % pnpm dev\r\n\r\n  VITE ready in 412 ms\r\n\r\n  Local:   http://localhost:5173/\r\n", running: true, exitCode: null }),
      onData: off,
      onExit: off,
      write: noop,
      resize: noop,
      kill: noop,
    },
  };
}

/**
 * ?panel=<tool>[,<tool>...]: opens the work panel on the thread with those tabs, the last one selected. Tools are
 * panel tab names (changes, browser, terminal, file, plan, tasks, checkpoints, commits, memory, instructions, newtab;
 * orcling with view=orclings). The stubs in panelRpc give each tool something to show.
 */
async function openPanelTabs(spec: string, scope: string) {
  const { usePanelSessions } = await import("../../apps/desktop/src/renderer/src/lib/panel-tabs");
  const { toolPage } = await import("../../apps/desktop/src/renderer/src/lib/panel-workspace");
  const { useLayout } = await import("../../apps/desktop/src/renderer/src/lib/layout");
  const sessions = usePanelSessions.getState();
  for (const tool of spec.split(",")) {
    if (tool === "newtab") sessions.add(scope);
    else if (tool === "browser") sessions.open(scope, { kind: "browser", url: "http://localhost:5173/", title: "" });
    else sessions.open(scope, toolPage(tool as never));
  }
  useLayout.setState({ panelOpen: true, panelRequest: null });
}

/** Sample answers for the panel tools that the views above never ask for. */
function panelRpc(method: string, params: Record<string, unknown>, now: number): unknown {
  const memory = (id: string, type: string, title: string, body: string) => ({
    id,
    scope: "project",
    projectId: "studio",
    type,
    topicKey: null,
    title,
    body,
    confidence: 0.9,
    status: "active",
    source: "agent",
    sourceRunId: null,
    sourceTaskId: null,
    evidenceCount: 2,
    files: [],
    createdAt: now - 86400000,
    updatedAt: now - 3600000,
    lastConfirmedAt: now - 3600000,
  });
  if (method === "memory.list")
    return [
      memory("tests", "command", "Run the desktop tests with pnpm", "Use `pnpm --filter desktop test`; the root test script skips the renderer."),
      memory("tokens", "convention", "Components read semantic tokens", "Never use raw palette values in components. Read the roles in app.css."),
      memory("picker", "decision", "Keep the existing project picker", "The welcome flow reuses ProjectPicker rather than drawing a new one."),
    ];
  if (method === "instructions.list")
    return [
      { scope: "project", path: "/Projects/studio/AGENTS.md", content: "# Studio\n\nUse the shared components in src/ui. Keep copy short.\n", version: "v1" },
      { scope: "personal", path: "~/.codex/AGENTS.md", content: "", version: null },
    ];
  if (method === "threads.checkpoints")
    return [3, 2, 1].map((turn) => ({
      id: `checkpoint-${turn}`,
      threadId: "onboarding",
      runId: null,
      turn,
      treeSha: `tree${turn}`,
      diffStat: { files: turn, insertions: turn * 4, deletions: turn, untracked: 0 },
      note: null,
      root: "/Projects/studio",
      outside: null,
      createdAt: now - turn * 600000,
    }));
  if (method === "git.threadLog" || method === "git.projectLog" || method === "git.log")
    return [
      { sha: "a1b2c3d4e5f6", author: "Codex", at: now - 600000, subject: "Add the welcome flow" },
      { sha: "f6e5d4c3b2a1", author: "Codex", at: now - 3600000, subject: "Reuse the project picker on first run" },
    ];
  if (method === "files.list")
    return {
      root: "/Projects/studio",
      entries:
        params.path === ""
          ? [
              { name: "src", path: "src", kind: "directory", ignored: false },
              { name: "package.json", path: "package.json", kind: "file", ignored: false },
              { name: "README.md", path: "README.md", kind: "file", ignored: false },
            ]
          : [
              { name: "Welcome.tsx", path: "src/Welcome.tsx", kind: "file", ignored: false },
              { name: "ui.tsx", path: "src/ui.tsx", kind: "file", ignored: false },
            ],
    };
  if (method === "files.search") return ["src/Welcome.tsx", "src/ui.tsx", "package.json", "README.md"];
  return undefined;
}
void main();
