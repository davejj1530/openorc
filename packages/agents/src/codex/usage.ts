import { withCodexConnection } from "./connection.js";
import type { StdioJsonRpc } from "../jsonrpc.js";

export interface CodexUsageOptions {
  binary?: string;
  env?: Readonly<NodeJS.ProcessEnv>;
}

export interface CodexAccountReport {
  account: unknown;
  limits: unknown;
}

async function accountReport(rpc: StdioJsonRpc): Promise<CodexAccountReport> {
  const { account } = await rpc.request<{ account: { type?: string } | null }>("account/read", { refreshToken: false }, 5000);
  const limits = account?.type === "chatgpt" ? await rpc.request("account/rateLimits/read", {}, 8000) : null;
  return { account, limits };
}

/** Read-only account calls: no thread, inference, or access to credential files. */
export function readCodexUsage(options: CodexUsageOptions = {}): Promise<CodexAccountReport> {
  return withCodexConnection(options, accountReport);
}

export type CodexResetOutcome = "reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit" | "unsupported";

/** Recheck and authorize on the same connection that redeems the reset. */
export function consumeCodexReset(input: { idempotencyKey: string; creditId?: string }, options: CodexUsageOptions, authorize: (report: CodexAccountReport) => void): Promise<CodexResetOutcome> {
  return withCodexConnection(options, async (rpc) => {
    authorize(await accountReport(rpc));
    try {
      const result = await rpc.request<{ outcome: string }>("account/rateLimitResetCredit/consume", input, 8000);
      if (["reset", "alreadyRedeemed", "nothingToReset", "noCredit"].includes(result.outcome)) return result.outcome as CodexResetOutcome;
      throw new Error("Unknown reset outcome");
    } catch (error) {
      if (error instanceof Error && /^rpc error -32601:/.test(error.message)) return "unsupported";
      throw error;
    }
  });
}
