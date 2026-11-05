import { secretParams } from "@openorc/protocol";

/** Settings validation deliberately omits provider secrets and invalid token contents. */
export function invalidParamsMessage(method: string, detail: string): string {
  if (method.startsWith("slack.")) return "Invalid Slack settings. Check token prefixes, IDs, and port.";
  if (method === "memory.settings.set") return "Invalid memory settings. Check the provider, model, and API key.";
  if (method === "remote.push.setKey") return "This is not an Apple push key.";
  return `invalid params for ${method}: ${detail}`;
}

export function resultSummary(result: unknown): string {
  if (result === null || result === undefined) return "null";
  if (Array.isArray(result)) return `${result.length} items`;
  return "ok";
}

/** One line of OPENORC_RPC_LOG: the method, its params unless they carry a secret, and how it went. */
export function rpcLogLine(method: string, params: unknown, result: unknown, ms: number): string {
  return `[rpc] ${method} ${secretParams(method) ? "[private]" : JSON.stringify(params).slice(0, 120)} -> ${resultSummary(result)} in ${ms} ms`;
}
