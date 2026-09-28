import type { AgentLaunchEnvironment } from "../launch-environment.js";
import { withClaudeControlSession } from "./control-session.js";

export type ClaudeUsageResult =
  /** Plan windows for the login Claude Code holds, in the usage endpoint's shape. */
  | { status: "ok"; usage: Record<string, unknown>; subscriptionType: string | null }
  /** The login is an API key or a cloud provider, so plan windows do not apply. */
  | { status: "unsupported" }
  /** Claude Code gave no answer. The detail is OpenOrc's own wording or the CLI's error text, never output from the process. */
  | { status: "unavailable"; detail: string };

export interface ClaudeUsageOptions extends Partial<Pick<AgentLaunchEnvironment, "binary" | "env">> {
  timeoutMs?: number;
}

/**
 * The structured /usage data, answered by the unmodified CLI with its own login.
 * OpenOrc sends a control request and never reads, holds, or forwards the credential.
 */
export async function readClaudeUsage(options: ClaudeUsageOptions = {}): Promise<ClaudeUsageResult> {
  const launch = { binary: options.binary ?? "claude", env: options.env ?? process.env };
  try {
    return await withClaudeControlSession(launch, { task: "reporting usage", timeoutMs: options.timeoutMs ?? 20_000 }, async (ask) => {
      await ask({ subtype: "initialize", hooks: {} });
      // skip_behaviors leaves out the scan of every transcript from the last seven days.
      const answer = await ask({ subtype: "get_usage", skip_behaviors: true });
      if (answer["rate_limits_available"] === false) return { status: "unsupported" } as const;
      const usage = answer["rate_limits"];
      if (usage === null || typeof usage !== "object") return { status: "unavailable", detail: "Claude Code returned no rate limits" } as const;
      const subscriptionType = answer["subscription_type"];
      return { status: "ok", usage: usage as Record<string, unknown>, subscriptionType: typeof subscriptionType === "string" ? subscriptionType : null } as const;
    });
  } catch (error) {
    return { status: "unavailable", detail: error instanceof Error ? error.message : String(error) };
  }
}
