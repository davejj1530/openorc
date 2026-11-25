import type { PlanLimits } from "@openorc/protocol";
import { useCloudLimits, useUsage } from "../settings/use-usage";
import { useClaudeAccountChoice } from "./claude-account";
import { useCloudAccountChoice } from "./cloud-account";
import type { ModelSettings } from "./settings-bridge";
import { cloudAccount, macAccount } from "./usage-account";

/** The limits of the account an agent's turns spend from, as Settings > Usage reads them. */
export interface ComposerUsage {
  limits: PlanLimits;
  /** A reading of OpenOrc Cloud's, taken on the account's turns. */
  turnRead: boolean;
  /** The time its resets count from. */
  now: number;
}

/**
 * The usage a composer's model pill measures: the account its thread runs on, or, where no thread is open, the one the
 * pill's choice would run on. `agent` asks for another agent's instead, as the model sheet does for the one it shows.
 * Null for an agent with no limits to read, and until the Mac answers.
 */
export function useComposerUsage(settings: ModelSettings | undefined, agent = settings?.choice?.agent): ComposerUsage | null {
  const cloud = Boolean(settings?.cloud);
  const mac = useUsage(Boolean(settings) && !cloud);
  const hosted = useCloudLimits(mac.live && cloud);
  const claude = useClaudeAccountChoice(settings);
  const chosen = useCloudAccountChoice(settings);
  if (!settings || !agent) return null;
  const limits = cloud
    ? cloudAccount(hosted, agent, chosen?.id ?? settings.cloudAccount?.accountId)
    : macAccount(mac.accounts, agent, settings.claudeAccountId ?? claude?.id ?? settings.claudeAccount?.chosen);
  return limits ? { limits, turnRead: cloud, now: mac.now } : null;
}
