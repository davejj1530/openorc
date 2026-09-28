/** The sample workspace every hero scene shares. Nothing here is a real project. */

export const project = { name: "studio", branch: "main" };

/** `permission` is how each harness labels the app's default mode, where workspace edits run without asking. */
export const models = {
  codex: { harness: "codex", agent: "Codex", label: "GPT-6-Astra", effort: "High", permission: "Ask for approval" },
  claude: { harness: "claude", agent: "Claude", label: "Opus 5.5", effort: "High", permission: "Accept edits" },
};

export interface SidebarRow {
  /** Rows the scene addresses: the current view, or a thread whose state changes. */
  id?: string;
  title: string;
  /** The checkout's branch, or the thread's own branch when it runs in a worktree. */
  branch?: string;
  providers: { harness: string; label: string }[];
  /** Windows during which the thread's agent is working. */
  busy?: string;
  /** Windows during which the row exists, for threads the journey creates. */
  show?: string;
}

/** Worktree branches follow the app's naming: `openorc/<title slug>-<id prefix>`, and `openorc/team-<thread id>` for a team. */
export const branches = {
  team: "openorc/team-5f1c8e2a-7d34-4b9e-a0c6-3e8d27f19b54",
  tokens: "openorc/design-tokens-2c91f0",
  plansThread: "openorc/plans-migration-4b7e2c",
  rateLimitThread: "openorc/rate-limit-the-public-api-3c8e1f",
  cacheThread: "openorc/cache-dashboard-queries-8d3f1a",
};

export const teamThread: SidebarRow = {
  id: "team",
  title: "Live dashboard updates",
  branch: branches.team,
  providers: [
    { harness: "codex", label: "1" },
    { harness: "claude", label: "2" },
    { harness: "opencode", label: "1" },
  ],
};

/** Conversations that make the workspace read as lived in. */
export const otherThreads: SidebarRow[] = [
  { title: "Make the first five minutes count", providers: [{ harness: "codex", label: "Codex" }] },
  { title: "Simplify the design tokens", branch: branches.tokens, providers: [{ harness: "codex", label: "Codex" }] },
];
