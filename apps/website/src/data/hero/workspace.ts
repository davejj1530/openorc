/** The sample workspace every hero scene shares. Nothing here is a real project. */

export const project = { name: "studio", branch: "main" };

/** `permission` is how each harness labels the app's default mode, where workspace edits run without asking. */
export const models = {
  codex: { harness: "codex", agent: "Codex", label: "GPT-6-Astra", effort: "High", permission: "Ask for approval" },
  claude: { harness: "claude", agent: "Claude", label: "Opus 5.5", effort: "High", permission: "Accept edits" },
};

/** The sidebar's projects in the order it lists them (SidebarThreadBrowser.tsx), each with its threads under it. atlas-api rests folded. */
export const projects: { name: string; folded?: boolean }[] = [{ name: "studio" }, { name: "website" }, { name: "atlas-api", folded: true }];

/**
 * A thread row (ThreadLibraryRow.tsx). In a scene, `busy` and `waiting` hold during windows; in a still they are
 * `true`. Waiting outranks working, as the app's status does.
 */
export interface SidebarRow {
  /** Rows the scene addresses: the current view, or a thread whose state changes. */
  id?: string;
  title: string;
  /** The project's name; studio unless given. */
  project?: string;
  /** The thread's own branch when it runs in a worktree. */
  branch?: string;
  /** Windows during which the thread's agent is working, or `true` in a still. */
  busy?: string | true;
  /** Windows during which the thread waits on the user's answer, or `true` in a still. */
  waiting?: string | true;
  /** A finished turn the user has not read. */
  done?: boolean;
  /** The row is the open thread, in a still that has no scene state. */
  current?: boolean;
  /** Windows during which the row exists, for threads the journey creates. */
  show?: string;
}

/** Worktree branches follow the app's naming: `openorc/<title slug>-<id prefix>`. */
export const branches = {
  tokens: "openorc/design-tokens-2c91f0",
  plansThread: "openorc/plans-migration-4b7e2c",
  rateLimitThread: "openorc/rate-limit-the-public-api-3c8e1f",
  cacheThread: "openorc/cache-dashboard-queries-8d3f1a",
};

/** Conversations that make the workspace read as lived in, listed after a scene's own rows. */
export const otherThreads: SidebarRow[] = [
  { title: "Make the first five minutes count" },
  { title: "Simplify the design tokens", branch: branches.tokens },
  { title: "Build a thoughtful onboarding" },
  { title: "Tell the product story", project: "website" },
];
