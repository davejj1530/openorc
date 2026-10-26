import type { AppSettings, ClaudeAccounts, HarnessAvailability, ModelOption, PlanLimits } from "@openorc/protocol";

/** The demo Mac's agents and their models, as `agents.models` lists them. */
export const demoModels: ModelOption[] = [
  { id: "claude-opus-5-5", label: "Opus 5.5", agent: "claude", isDefault: true, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", agent: "claude", isDefault: false, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
  { id: "gpt-5.5", label: "GPT-5.5", agent: "codex", isDefault: true, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" },
];

export const demoAvailability: HarnessAvailability[] = [
  { id: "codex", state: "ready" },
  { id: "claude", state: "ready" },
  { id: "opencode", state: "not_found" },
];

export const demoAccounts = (createdAt: number): ClaudeAccounts => ({
  defaultId: "claude-cli",
  accounts: [{ id: "claude-cli", name: "Claude", kind: "cli", enabled: true, createdAt, status: "ready", email: null, organization: null, message: null }],
});

export const demoSettings: AppSettings = {
  experimentalTeamExecution: true,
  notifications: true,
  sound: false,
  autoDoneDays: 3,
  autoDoneOnPrMerge: true,
  autoArchiveDoneDays: 14,
  defaultWorkspaceMode: "current",
  defaultPermissionMode: "trusted",
  defaultHarness: "claude",
  look: null,
  idleProcessMinutes: 10,
  claudeUserMcpServers: true,
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The demo Mac's plan limits, read a minute ago, resetting at fixed distances from now. */
export function demoLimits(now: number): PlanLimits[] {
  const window = (id: string, label: string, used: number, resetsIn: number) => ({
    id,
    label,
    usedPercent: used,
    remainingPercent: 100 - used,
    resetsAt: now + resetsIn,
    observedAt: now - MINUTE,
    exhausted: used >= 100,
  });
  return [
    {
      id: "claude:claude-cli",
      provider: "claude",
      name: "Claude",
      plan: "Max",
      status: "available",
      windows: [window("session", "5-hour window", 34, 2 * HOUR + 10 * MINUTE), window("weekly_all", "7-day window", 58, 3 * 24 * HOUR + 4 * HOUR)],
      refreshedAt: now - MINUTE,
    },
    {
      id: "codex",
      provider: "codex",
      name: "Codex",
      plan: "Pro",
      status: "available",
      windows: [window("codex:primary", "5-hour window", 12, 3 * HOUR + 20 * MINUTE), window("codex:secondary", "7-day window", 41, 4 * 24 * HOUR + 6 * HOUR)],
      refreshedAt: now - MINUTE,
    },
  ];
}
