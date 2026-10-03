import type { ProviderUsage, SlackStatus } from "@openorc/protocol";

/** Session-only settings for the design preview. Never reads or writes a real account. */
export function createDesignSettingsRpc() {
  const settings: Record<string, Record<string, unknown>> = {
    "app.settings": { defaultWorkspaceMode: "current", defaultPermissionMode: "review", notifications: true, sound: false, experimentalTeamExecution: true },
    "memory.settings": { enabled: true, provider: "auto", model: null, hasApiKey: false, resolved: null, automatic: [], reason: "Finished runs use each agent’s default summary model." },
    "textGeneration.settings": { provider: "auto", model: null, resolved: null, reason: "Each conversation uses its agent’s default small model." },
  };
  return (method: string, params: Record<string, unknown>): unknown => {
    const key = method.replace(/\.(get|set)$/, "");
    if (settings[key]) {
      if (method.endsWith(".set")) settings[key] = { ...settings[key], ...params };
      return settings[key];
    }
    if (method === "providers.usage") return usageReport(params.provider as ProviderUsage["provider"]);
    if (method === "slack.status") return slack;
    if (method === "reviewerApp.get") return { app: null, setupUrl: null, error: null };
    if (method === "skills.list")
      return [
        {
          name: "frontend-design",
          description: "Create thoughtful, production-ready interfaces with clear visual direction.",
          path: "/Projects/studio/.agents/skills/frontend-design/SKILL.md",
          source: "project",
        },
        { name: "code-review", description: "Review changes for correctness, clarity, and alignment with the project’s conventions.", path: "~/.agents/skills/code-review/SKILL.md", source: "user" },
        { name: "writing", description: "Keep product language clear, useful, and consistent.", path: "~/.agents/skills/writing/SKILL.md", source: "user" },
      ];
    return undefined;
  };
}

function usageReport(provider: ProviderUsage["provider"]): ProviderUsage {
  const now = Date.now();
  const connected = provider !== "opencode";
  const localRuns = provider === "codex" ? 128 : 64;
  const report: ProviderUsage = {
    provider,
    status: connected ? "available" : "disconnected",
    source: "Design preview · synthetic account data",
    context: connected ? `${provider === "codex" ? "ChatGPT Pro" : "Claude Max"} · design@example.test` : "No connected account",
    windows: [],
    credits: [],
    localRuns: connected ? localRuns : 0,
    refreshedAt: connected ? now : null,
    checkedAt: now,
    accountUrl: "https://example.test/usage",
    message: null,
  };
  if (connected)
    report.windows = [
      {
        id: "session",
        label: "Current session",
        usedPercent: provider === "codex" ? 18 : 47,
        remainingPercent: provider === "codex" ? 82 : 53,
        resetsAt: now + 144 * 60_000,
        observedAt: now,
        exhausted: false,
      },
      {
        id: "weekly",
        label: "Weekly limit",
        usedPercent: provider === "codex" ? 36 : 72,
        remainingPercent: provider === "codex" ? 64 : 28,
        resetsAt: now + 3 * 86_400_000,
        observedAt: now,
        exhausted: false,
      },
    ];
  if (provider === "codex") report.resets = { availableCount: null, credits: null, redemption: "external" };
  return report;
}

const slack: SlackStatus = {
  mode: "direct",
  direct: { configured: false, enabled: false, connected: false, busy: false, error: null, config: null, workspace: null, ownerName: null, botId: null },
  host: { configured: false, enabled: false, connected: false, channelId: "", port: 9847, workspace: null, error: null },
  devices: [],
  client: { configured: false, enabled: false, connected: false, config: null, userId: null, busy: false, error: null },
};
