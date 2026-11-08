import type { AgentLaunchEnvironment } from "../launch-environment.js";
import { withClaudeControlSession } from "./control-session.js";

export type ClaudeUsageResult =
  /** Plan windows for the login Claude Code holds, in the usage endpoint's shape. */
  | { status: "ok"; usage: Record<string, unknown>; plan: string | null }
  /** The login is an API key or a cloud provider, so plan windows do not apply. */
  | { status: "unsupported" }
  /** Claude Code gave no answer. The detail is OpenOrc's own wording or the CLI's error text, never output from the process. */
  | { status: "unavailable"; detail: string };

export interface ClaudeUsageOptions extends Partial<Pick<AgentLaunchEnvironment, "binary" | "env">> {
  timeoutMs?: number;
}

/** Plan ids from the usage answer, for a CLI that does not name the plan itself. */
const planNames: Record<string, string> = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise" };

/**
 * The plan as Claude Code names it ("Ultra", "Team"). Its initialize answer carries Anthropic's current name; the
 * usage answer only has the plan id, which can lag a rename (Max became Ultra and still reads `max`).
 */
function planName(initialized: Record<string, unknown>, usage: Record<string, unknown>): string | null {
  const account = initialized["account"];
  const named = account && typeof account === "object" ? (account as Record<string, unknown>)["subscriptionType"] : undefined;
  if (typeof named === "string" && named.trim()) return named.replace(/^Claude\s+/, "");
  const id = usage["subscription_type"];
  return typeof id === "string" ? (planNames[id] ?? id) : null;
}

/**
 * The structured /usage data, answered by the unmodified CLI with its own login.
 * OpenOrc sends a control request and never reads, holds, or forwards the credential.
 */
export async function readClaudeUsage(options: ClaudeUsageOptions = {}): Promise<ClaudeUsageResult> {
  const launch = { binary: options.binary ?? "claude", env: options.env ?? process.env };
  try {
    return await withClaudeControlSession(launch, { task: "reporting usage", timeoutMs: options.timeoutMs ?? 20_000 }, async (ask) => {
      const initialized = await ask({ subtype: "initialize", hooks: {} });
      // skip_behaviors leaves out the scan of every transcript from the last seven days.
      const answer = await ask({ subtype: "get_usage", skip_behaviors: true });
      if (answer["rate_limits_available"] === false) return { status: "unsupported" } as const;
      const usage = answer["rate_limits"];
      if (usage === null || typeof usage !== "object") return { status: "unavailable", detail: "Claude Code returned no rate limits" } as const;
      return { status: "ok", usage: usage as Record<string, unknown>, plan: planName(initialized, answer) } as const;
    });
  } catch (error) {
    return { status: "unavailable", detail: error instanceof Error ? error.message : String(error) };
  }
}
