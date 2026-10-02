import { harnessCatalog, harnessFailsToStart, isHarnessId, type ExtractionProviderChoice, type HarnessInfo, type RpcResults, type SlackStatus } from "@openorc/protocol";
import { extractionSummary } from "../lib/memory-extraction";
import { formatUsageTime } from "../lib/provider-usage";

export function settingsTabIndex(key: string, index: number, count: number): number | null {
  if (key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowLeft") return (index + count - 1) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
export function installationLabel(loaded: boolean, installed: boolean): string {
  if (!loaded) return "Checking…";
  return installed ? "Installed" : "Not installed";
}
export function idleTimeoutLabel(minutes: number | null): string {
  if (minutes === null) return "Keep running";
  if (minutes === 60) return "1 hour";
  return `${minutes} minutes`;
}
export function memoryModelAgent(provider: ExtractionProviderChoice) {
  if (provider === "apikey") return "claude" as const;
  if (isHarnessId(provider)) return provider;
  return undefined;
}
export function learningStatus({
  loading,
  error,
  saved,
  provider,
  storageError,
  reason,
}: {
  loading: boolean;
  error: boolean;
  saved: RpcResults["memory.settings.get"] | null;
  provider: ExtractionProviderChoice;
  storageError: string | null | undefined;
  reason: string | null | undefined;
}): string {
  if (loading) return "Checking available providers…";
  if (error) return "Learning controls are unavailable until your memory settings load.";
  if (!saved?.enabled) return "Learning is paused while OpenOrc memory is off. Your provider preference is retained.";
  if (provider === "off") return "No extra model runs to extract memories. Agents can still save and recall useful knowledge.";
  if (storageError && reason === storageError) return "";
  return extractionSummary(saved) ?? "";
}
export function textGenerationStatus({ loading, status, value }: { loading: boolean; status: string; value: Partial<RpcResults["textGeneration.settings.get"]> }): string {
  const provider = value.provider ?? "auto";
  if (loading) return "Checking available models…";
  if (status === "saving") return "Updating model…";
  if (status === "error") return "Your selection has not been saved yet.";
  if (provider === "off") return "Thread titles use the opening message.";
  if (provider === "auto") return "Each conversation is named by a small model from its own agent. Without one, it keeps its opening message.";
  if (value.reason) return `${value.reason} Thread titles will use the opening message.`;
  if (value.resolved) return `Using ${value.resolved.label} through ${harnessCatalog[value.resolved.provider].name}.`;
  return "";
}
export function agentUpdateStatus({ updating, checking, checked }: { updating: boolean; checking: boolean; checked: number | undefined }): string {
  if (updating) return "Updating agents…";
  if (checking) return "Checking releases…";
  if (checked) return `Last checked ${new Date(checked).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  return "Check for newer agent versions.";
}
export function agentConnectionStatus({ info, installed, loggedIn }: { info: HarnessInfo | undefined; installed: boolean; loggedIn: boolean }): string {
  if (!info) return "Checking…";
  if (harnessFailsToStart(info)) return "Fails to start";
  if (info.state === "check_failed") return "Connection check failed";
  if (!installed) return "Not installed";
  return loggedIn ? "Connected" : "Not logged in";
}
export function directSlackStatus(direct: Pick<SlackStatus["direct"], "error" | "connected" | "busy" | "enabled"> | undefined): string {
  if (direct?.error) return direct.connected ? "Delivery pending" : "Needs attention";
  if (direct?.connected) return direct.busy ? "Working" : "Connected";
  return direct?.enabled ? "Connecting…" : "Not connected";
}
export function relayClientStatus(client: Pick<SlackStatus["client"], "error" | "connected" | "busy" | "enabled"> | undefined): string {
  if (!client?.connected) return client?.enabled ? "Reconnecting…" : "Disconnected";
  if (client.error) return "Delivery pending";
  return client.busy ? "Working" : "Connected";
}
export function relayHostStatus(host: Pick<SlackStatus["host"], "connected" | "enabled"> | undefined): string {
  if (host?.connected) return "Connected";
  return host?.enabled ? "Reconnecting…" : "Disconnected";
}
export function projectSkillsPlaceholder(error: boolean, loaded: boolean): string {
  if (error) return "Projects unavailable";
  return loaded ? "No projects yet" : "Loading projects…";
}
export function skillsStatus({ loading, error, found, success, count }: { loading: boolean; error: boolean; found: number; success: boolean; count: string }): string {
  if (loading) return "Loading skills…";
  if (error && found > 0) return `${count}, last read before the error`;
  return success ? count : "";
}
export function usageReportStatus({
  error,
  fetching,
  report,
  stale,
  exhausted,
}: {
  error: boolean;
  fetching: boolean;
  report: Pick<RpcResults["providers.usage"], "status"> | undefined;
  stale: boolean;
  exhausted: boolean;
}): string {
  if (error || report?.status === "error") return "Refresh failed";
  if (fetching) return "Refreshing…";
  if (!report) return "Loading…";
  if (report.status === "disconnected") return "Disconnected";
  if (stale) return "Stale report";
  if (exhausted) return "Limit reached";
  if (report.status === "unavailable") return "Metrics unavailable";
  return "Usage reported";
}
export function creditBalanceLabel(credit: { unlimited: boolean; balance: string | null }): string {
  if (credit.unlimited) return "Unlimited (provider reported)";
  if (credit.balance !== null) return `${parseInt(credit.balance).toFixed(2)} credits remaining`;
  return "Balance unavailable";
}
export function resetTimeLabel(resetsAt: number | null, expired: boolean): string {
  if (resetsAt === null) return "Reset time unavailable";
  if (expired) return `Reported reset ${formatUsageTime(resetsAt)} has passed. Refresh for a new report.`;
  return `Resets ${formatUsageTime(resetsAt)}`;
}
