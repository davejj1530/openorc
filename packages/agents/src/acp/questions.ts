import { parse, type ParseError } from "jsonc-parser";

/** OpenCode 2 ACP starts a private server; this override lives only in its environment. */
export function questionConfig(content: string | undefined): string {
  const errors: ParseError[] = [];
  const config = content ? parse(content, errors, { allowTrailingComma: true }) : {};
  if (errors.length || !config || typeof config !== "object" || Array.isArray(config)) throw new Error("OPENCODE_CONFIG_CONTENT must be a JSON/JSONC object to configure OpenOrc questions.");
  if (config.permissions !== undefined && !Array.isArray(config.permissions)) throw new Error("OpenCode 2 permissions must be an array.");
  const deny = { action: "question", resource: "*", effect: "deny" };
  // Agent rules follow global rules. Cover built-ins and inline custom agents.
  // Custom agents from project files and saved session rules can still override this.
  const agents = { ...config.agents };
  for (const id of new Set(["build", "plan", ...Object.keys(agents)])) {
    const agent = agents[id] ?? {};
    if (agent.permissions !== undefined && !Array.isArray(agent.permissions)) throw new Error(`OpenCode 2 agent ${id} permissions must be an array.`);
    agents[id] = { ...agent, permissions: [...(agent.permissions ?? []), deny] };
  }
  return JSON.stringify({ ...config, permissions: [...(config.permissions ?? []), deny], agents });
}

export function questionInstructions(serverName: string): string {
  return `When you need an answer from the user, call ${serverName}_ask_user (the ask_user tool on MCP server ${serverName}; in Code Mode, discover ask_user with search first, then return await tools.${serverName}.ask_user). It displays an interactive question card in OpenOrc and waits for the user, including in Autonomous mode. Use unique question ids and read answers by id. The native question tool is unsupported by this ACP client. If ask_user returns cancelled, the user has not answered or granted consent; do not repeat the question automatically.`;
}
