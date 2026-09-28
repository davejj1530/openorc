/** Production shell and conversations with deterministic RPC snapshots; no provider calls. */
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import type { AgentEvent, ThreadSummary } from "@openorc/protocol";

Object.assign(window, {
  openorc: {
    platform: new URLSearchParams(location.search).get("platform") ?? "linux",
    openExternal: () => {},
    openWindow: () => {},
    onTheme: () => () => {},
    setTheme: () => {},
    assetUrl: (p: string) => p,
  },
});

async function main() {
  const { core } = await import("../../apps/desktop/src/renderer/src/lib/rpc");
  const { queryClient } = await import("../../apps/desktop/src/renderer/src/lib/query");
  const { useRouter } = await import("../../apps/desktop/src/renderer/src/lib/router");
  const { useLayout } = await import("../../apps/desktop/src/renderer/src/lib/layout");
  const { useTheme } = await import("../../apps/desktop/src/renderer/src/lib/theme");
  const { applyFrame } = await import("../../apps/desktop/src/renderer/src/lib/transcript");
  const project = {
    id: "project",
    name: new URLSearchParams(location.search).get("project") ?? "Split workspace",
    rootPath: "/tmp/split-fixture",
    defaultBranch: "main",
    settings: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const threads = new Map(
    ["a", "b", "c", "d"].map((id) => [
      id,
      {
        id,
        projectId: project.id,
        title: (id === "a" && new URLSearchParams(location.search).get("title")) || `Thread ${id.toUpperCase()}`,
        agent: "codex",
        model: "fixture",
        effort: null,
        fastMode: false,
        mode: "act",
        permissionMode: "review",
        workspaceMode: new URLSearchParams(location.search).has("headerDetails") ? "worktree" : "current",
        branch: new URLSearchParams(location.search).has("headerDetails") ? "fix/thread-header-drag" : null,
        worktreePath: null,
        baseSha: null,
        pinnedAt: null,
        seenAt: null,
        doneAt: null,
        snoozedUntil: null,
        prUrl: new URLSearchParams(location.search).has("headerDetails") ? "https://example.com/pull/123" : null,
        prState: null,
        forkedFromId: new URLSearchParams(location.search).has("headerDetails") ? "d" : null,
        forkedAtRunId: null,
        draft: null,
        importedFrom: null,
        createdAt: 1,
        updatedAt: 1,
        lastActivityAt: 1,
        archivedAt: null,
        activity: new URLSearchParams(location.search).has("headerDetails") ? "waiting" : "idle",
        unread: false,
        session: { status: "idle", message: null },
        context: null,
        queued: [],
        lastAgentEventAt: null,
        taskCount: 0,
        openTaskCount: 0,
      } as ThreadSummary,
    ]),
  );
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const task = {
    id: "task",
    labels: [],
    projectId: project.id,
    threadId: null,
    title: "Task header scroll regression",
    spec: "Scrollable task document.\n\n".repeat(100),
    status: "in_progress",
    priority: "medium",
    agent: "codex",
    model: "fixture",
    effort: null,
    fastMode: false,
    mode: "act",
    permissionMode: "review",
    workspaceMode: "current",
    worktreePath: null,
    branch: null,
    baseSha: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const runs = new Map<string, unknown[]>();
  // What each run has emitted, so a pane loading the run reads the same events the ledger would hold.
  const ledger = new Map<string, AgentEvent[]>();
  core.call = (async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    let result: unknown = [];
    if (method === "tasks.get") result = task;
    else if (method === "runs.listForTask") result = runs.get("a") ?? [];
    else if (method === "tasks.forwarding") result = null;
    else if (method === "projects.list") result = [project];
    else if (method === "projects.get") result = project;
    else if (method === "threads.list") result = params.filter === "done" ? [] : [...threads.values()];
    else if (method === "threads.get") result = threads.get(String(params.id)) ?? null;
    else if (method === "threads.update") {
      Object.assign(threads.get(String(params.id))!, params.patch);
      result = threads.get(String(params.id));
    } else if (method === "threads.delete") {
      threads.delete(String(params.id));
      result = { ok: true };
    } else if (method === "runs.listForThread") result = runs.get(String(params.threadId)) ?? [];
    else if (method === "review.threadDiff") result = { patch: "", branch: "main", base: "main", dirty: false, files: [] };
    else if (method === "agents.models") result = [{ id: "fixture", agent: "codex", label: "Fixture", efforts: [], defaultEffort: null, isDefault: true }];
    else if (method === "app.settings.get") result = { defaultWorkspaceMode: "current", defaultPermissionMode: "review" };
    else if (method === "system.info") result = { harnesses: [{ id: "codex", state: "ready" }], codex: { installed: true, loggedIn: true }, gh: { installed: false, loggedIn: false } };
    else if (method === "runs.start") result = { id: `sent-${params.threadId}` };
    else if (method === "events.page") result = { events: ledger.get(String(params.runId)) ?? [], fromTurn: 0, live: true };
    return structuredClone(result);
  }) as typeof core.call;
  queryClient.setDefaultOptions({ queries: { retry: false } });
  useLayout.setState({ sidebarOpen: true, projectId: project.id, panelOpen: false });
  useRouter.getState().navigate({ view: "thread", threadId: "a" });
  useTheme.getState().set("light");
  let seq = 0;
  Object.assign(window, {
    splitSmoke: {
      calls: () => calls,
      ids: () => useRouter.getState().threadIds,
      add: (id: string) => useRouter.getState().addThreadPane(id),
      sidebar: (open: boolean, width?: number) => {
        useLayout.setState({ sidebarOpen: open });
        if (width !== undefined) useLayout.getState().setSidebarWidth(width);
      },
      navigate: (id: string) => useRouter.getState().navigate({ view: "thread", threadId: id }),
      task: (tab: "spec" | "chat") => useRouter.getState().navigate({ view: "task", taskId: "task", tab }),
      remove: async (id: string) => {
        threads.delete(id);
        await queryClient.invalidateQueries({ queryKey: ["threads.get", { id }] });
      },
      theme: (theme: "light" | "dark") => useTheme.getState().set(theme),
      emit: async (id: string, text: string) => {
        const runId = `run-${id}`;
        runs.set(id, [{ id: runId, threadId: id, taskId: null, agent: "codex", model: "fixture", status: "running", state: "running", startedAt: Date.now(), mode: "act", permissionMode: "review" }]);
        const event: AgentEvent = { type: "message.delta", eventId: `${++seq}`, runId, ts: Date.now(), messageId: `message-${id}`, role: "assistant", text };
        const events: AgentEvent[] = [{ type: "session.started", eventId: `session-${id}`, runId, ts: Date.now(), agent: "codex", externalSessionId: id, model: "fixture" }, event];
        ledger.set(runId, [...(ledger.get(runId) ?? []), ...events]);
        applyFrame({ runId, seq, events });
        await queryClient.invalidateQueries({ queryKey: ["runs.listForThread", { threadId: id }] });
      },
    },
  });
  const { App } = await import("../../apps/desktop/src/renderer/src/App");
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}
void main();
