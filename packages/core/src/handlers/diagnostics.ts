/** Settings validation deliberately omits provider secrets and invalid token contents. */
export function invalidParamsMessage(method: string, detail: string): string {
  if (method.startsWith("slack.")) return "Invalid Slack settings. Check token prefixes, IDs, and port.";
  if (method === "memory.settings.set") return "Invalid memory settings. Check the provider, model, and API key.";
  return `invalid params for ${method}: ${detail}`;
}

export function resultSummary(result: unknown): string {
  if (result === null || result === undefined) return "null";
  if (Array.isArray(result)) return `${result.length} items`;
  return "ok";
}
