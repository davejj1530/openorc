import type { AppSettings, ModelOption, Project, RpcMethod, RpcParams, RpcResults } from "@openorc/protocol";

/** One idle example conversation, last active `at`. */
function exampleThread(title: string, at: number, id: string, projectId: string, model: string) {
  return {
    id,
    title,
    projectId,
    agent: "codex",
    model,
    effort: "high",
    fastMode: false,
    mode: "act",
    permissionMode: "autonomous",
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
    createdAt: at,
    updatedAt: at,
    lastActivityAt: at,
    lastAgentEventAt: at,
    archivedAt: null,
    activity: "idle",
    unread: false,
    session: { status: "idle", message: null },
    hasStarted: true,
    context: null,
    queued: [],
    taskCount: 0,
    openTaskCount: 0,
  };
}

/** An example account a quarter into its week. */
function exampleUsage(now: number): RpcResults["providers.usage"] {
  return {
    provider: "codex",
    status: "available",
    source: "example",
    context: "Example account",
    plan: null,
    checkedAt: now,
    refreshedAt: now,
    message: null,
    windows: [{ id: "weekly", label: "7-day window", usedPercent: 25, remainingPercent: 75, resetsAt: null, observedAt: now, exhausted: false }],
    credits: [],
    accountUrl: "https://example.com",
    localRuns: null,
  };
}

/** Closed, in-memory answers for the appearance renderer. There is no core connection. */
export function createAppearancePreviewRpc() {
  const now = Date.now();
  const project: Project = {
    id: "example",
    name: "Example project",
    rootPath: "/tmp/example-project",
    defaultBranch: "main",
    gitRemote: null,
    settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc/", detectedConfigs: [] },
    createdAt: now,
    updatedAt: now,
  };
  const models: ModelOption[] = [{ agent: "codex", id: "gpt-6-astra", label: "GPT-6-Astra", efforts: ["high"], defaultEffort: "high", isDefault: true }];
  const settings: AppSettings = {
    notifications: false,
    sound: false,
    autoDoneDays: null,
    autoDoneOnPrMerge: false,
    autoArchiveDoneDays: null,
    defaultWorkspaceMode: "current",
    defaultPermissionMode: "autonomous",
    defaultHarness: "codex",
    enabledHarnesses: ["codex"],
    look: null,
    idleProcessMinutes: null,
    claudeUserMcpServers: false,
    claudeConnectorsOff: [],
    claudeAccountAutoSwitch: false,
  };
  const threads = ["Plan the first release", "Add project search", "Review the folder structure"].map((title, index) =>
    exampleThread(title, now - (index + 1) * 60000, `example-${index}`, project.id, models[0]!.id),
  );
  const replies: Partial<Record<RpcMethod, unknown>> = {
    "app.settings.get": settings,
    "projects.list": [project],
    "projects.get": project,
    "workspace.get": { ...project, id: "openorc-workspace", name: "Workspace" },
    "projects.git": "ready",
    "projects.checkoutBranch": "main",
    "threads.list": threads,
    "threads.resolvedCount": 0,
    "tasks.list": [],
    "schedules.list": [],
    "orclings.list": [],
    "orclings.groups.list": [],
    "agents.models": models,
    "agents.modelCatalog": { models, providers: [] },
    "agents.updates.get": { agents: [], automatic: false, checking: false, updating: false },
    "system.info": {
      dataDir: "/tmp/example-profile",
      harnesses: [{ id: "codex", state: "ready", path: "/usr/local/bin/codex", version: "1.0.0", revision: 1 }],
      codex: { installed: true, loggedIn: true },
      gh: { installed: true, loggedIn: false },
    },
    "claude.accounts.list": { accounts: [], defaultId: null },
    "cloud.offer": { brain: null, provider: null, projects: [] },
    "providers.limits": [],
    "providers.usage": exampleUsage(now),
    "review.projectDiff": { baseSha: null, since: null, patch: "", files: [], branch: "main", base: "main", dirty: false },
    "skills.list": [],
    "connectors.list": [],
  };
  return async <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> => {
    if (method === "projects.activity" && "boundaries" in params && Array.isArray(params.boundaries)) {
      return { days: Array.from({ length: params.boundaries.length - 1 }, () => ({ turns: 0, steps: 0, threads: 0, agents: [] })) } as RpcResults[M];
    }
    // The shell hands its appearance to settings on mount; that write stays in this renderer.
    if (method === "app.settings.set") return settings as RpcResults[M];
    if (method in replies) return replies[method] as RpcResults[M];
    throw new Error(`Unavailable in the appearance preview: ${method}`);
  };
}
