import { DEFAULT_CLAUDE_ACCOUNT, harnessCatalog, type AllowanceWindow, type ClaudeAccounts, type HarnessAvailability, type HarnessId, type ProviderUsage } from "@openorc/protocol";
import { useRpc, useRpcs } from "./client";

export type UsageAccount = { provider: HarnessId; claudeAccountId?: string; fxModel?: string; name: string };
export type UsageAccountReport = UsageAccount & {
  id: string;
  plan: string | null;
  windows: AllowanceWindow[];
  credits: ProviderUsage["credits"];
  context: string;
  status: ProviderUsage["status"] | "loading";
};
export const USAGE_MAX_AGE_MS = 60_000;
const quotaProviders = new Set<HarnessId>(["codex", "claude", "antigravity", "fx"]);

export function usageAccountId(account: UsageAccount): string {
  if (account.provider === "fx" && account.fxModel) return `fx:${account.fxModel.split("/")[0]}`;
  return account.provider === "claude" ? `claude:${account.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT}` : account.provider;
}

export function usageParams(account: Pick<UsageAccount, "provider" | "claudeAccountId" | "fxModel">) {
  return {
    provider: account.provider,
    ...(account.provider === "claude" ? { claudeAccountId: account.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT } : {}),
    ...(account.provider === "fx" && account.fxModel ? { fxModel: account.fxModel } : {}),
    maxAgeMs: USAGE_MAX_AGE_MS,
  };
}

function listedAccounts(installed: HarnessAvailability[], claude: ClaudeAccounts | undefined): UsageAccount[] {
  const enabled = claude?.accounts.filter((account) => account.enabled) ?? [];
  return installed.flatMap<UsageAccount>(({ id, state }) => {
    if (state === "not_found" || !quotaProviders.has(id)) return [];
    if (id !== "claude") return [{ provider: id, name: harnessCatalog[id].name }];
    return enabled.map((account) => ({ provider: id, claudeAccountId: account.id, name: enabled.length > 1 ? `Claude · ${account.name}` : "Claude" }));
  });
}

/** Independent queries let cached and fast accounts appear while another CLI is still answering. */
export function useUsageAccounts(current: UsageAccount) {
  const availability = useRpc("agents.availability", {}, { staleTime: USAGE_MAX_AGE_MS });
  const hasClaude = availability.data?.some(({ id, state }) => id === "claude" && state !== "not_found") ?? current.provider === "claude";
  const claude = useRpc("claude.accounts.list", {}, { enabled: hasClaude, staleTime: USAGE_MAX_AGE_MS });
  const accounts = listedAccounts(availability.data ?? [], claude.data).map((account) => (account.provider === "fx" && current.provider === "fx" ? current : account));
  const discovering = !availability.data || (current.provider === "claude" && hasClaude && !claude.data);
  if (discovering && quotaProviders.has(current.provider) && !accounts.some((account) => usageAccountId(account) === usageAccountId(current))) accounts.unshift(current);
  accounts.sort((a, b) => Number(usageAccountId(b) === usageAccountId(current)) - Number(usageAccountId(a) === usageAccountId(current)));
  const reports = useRpcs("providers.usage", accounts.map(usageParams), { staleTime: USAGE_MAX_AGE_MS });
  return {
    accounts: accounts.map((account, index): UsageAccountReport => {
      const report = reports[index]!;
      return {
        ...account,
        id: usageAccountId(account),
        plan: report.data?.plan ?? null,
        windows: report.data?.windows ?? [],
        credits: report.data?.credits ?? [],
        context: report.data?.context ?? "",
        status: report.data?.status ?? (report.isError ? "error" : "loading"),
      };
    }),
    pending: availability.isPending || (hasClaude && claude.isPending),
    failed: availability.isError || (hasClaude && claude.isError),
  };
}
