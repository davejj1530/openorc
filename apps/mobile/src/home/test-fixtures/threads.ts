import { WORKSPACE_ID, type Project, type ThreadSummary } from "@openorc/protocol";

// A Mac's projects and threads for Home's tests. Fixed times keep the order stable.
const now = Date.UTC(2026, 9, 23, 12);
const minutes = (count: number) => now - count * 60_000;

function project(id: string, name: string, minutesAgo: number): Project {
  return {
    id,
    name,
    rootPath: `/Users/me/dev/${id}`,
    gitRemote: `git@github.com:me/${id}.git`,
    defaultBranch: "main",
    settings: { setupScript: null, worktreeInclude: [], branchPrefix: "", detectedConfigs: [] },
    createdAt: minutes(minutesAgo),
    updatedAt: minutes(minutesAgo),
  };
}

function thread(id: string, projectId: string, title: string, minutesAgo: number, facts: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id,
    projectId,
    title,
    agent: "codex",
    model: null,
    effort: null,
    fastMode: false,
    mode: "act",
    permissionMode: "trusted",
    workspaceMode: "worktree",
    branch: null,
    worktreePath: null,
    baseSha: null,
    baseBranch: "main",
    pinnedAt: null,
    seenAt: minutes(minutesAgo),
    doneAt: null,
    snoozedUntil: null,
    prUrl: null,
    prState: null,
    forkedFromId: null,
    forkedAtRunId: null,
    draft: null,
    importedFrom: null,
    createdAt: minutes(minutesAgo + 30),
    updatedAt: minutes(minutesAgo),
    lastActivityAt: minutes(minutesAgo),
    archivedAt: null,
    activity: "idle",
    unread: false,
    session: { status: "idle", message: null },
    context: null,
    queued: [],
    lastAgentEventAt: null,
    taskCount: 0,
    openTaskCount: 0,
    ...facts,
  };
}

const pull = (repo: string, number: number) => `https://github.com/me/${repo}/pull/${number}`;
const live = { status: "live", message: null } as const;

export const fixtureProjects: Project[] = [project("openorc", "openorc", 9000), project("website", "website", 7000), project("immaculate", "immaculate", 5000)];

export const fixtureThreads: ThreadSummary[] = [
  thread("t-plan", WORKSPACE_ID, "Plan the week", 95, { workspaceMode: "current" }),
  thread("t-slack", WORKSPACE_ID, "Summarize the release channel", 40, { workspaceMode: "current", unread: true, seenAt: minutes(120) }),
  thread("t-pairing", "openorc", "Review the pairing handshake", 3, { branch: "feat/noise-pairing", activity: "waiting", session: live, agent: "claude" }),
  thread("t-paging", "openorc", "Speed up transcript paging", 1, { branch: "perf/transcript-paging", activity: "running", session: live, lastAgentEventAt: minutes(0) }),
  thread("t-headline", "openorc", "Sidebar headline flicker", 300, { branch: "fix/headline-flicker", pinnedAt: minutes(2000), prUrl: pull("openorc", 482), prState: "open" }),
  thread("t-notes", "openorc", "Release notes for beta 9", 25, { pinnedAt: minutes(1000), unread: true, seenAt: minutes(200), workspaceMode: "current" }),
  thread("t-ledger", "openorc", "Move the ledger journal to rows", 60, { branch: "refactor/ledger-rows", session: { status: "error", message: "Codex exited with code 1" } }),
  thread("t-settings", "openorc", "Tidy the settings copy", 1500, { prUrl: pull("openorc", 471), prState: "merged" }),
  thread("t-hero", "website", "Hero copy pass", 2, { branch: "site/hero-copy", activity: "running", session: live, agent: "claude" }),
  thread("t-docs", "website", "Which docs page covers pairing?", 8, { branch: "docs/pairing", activity: "waiting", session: live }),
  thread("t-phone", "website", "Fix the phone layout", 180, { branch: "fix/phone-layout", session: { status: "lost", message: null } }),
  thread("t-tokens", "immaculate", "Export tokens to Figma", 720, { branch: "feat/figma-tokens" }),
  thread("t-canvas", "immaculate", "Canvas zoom snaps", 2880, { prUrl: pull("immaculate", 93), prState: "closed" }),
];
