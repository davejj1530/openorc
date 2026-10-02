import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HarnessId } from "@openorc/protocol";

export interface ExecutionSwitchInput {
  agent?: HarnessId;
  model?: string;
  /** Exact catalog effort, or null to use the model's default. */
  effort?: string | null;
  folderId?: string;
  /** An Orcling to hand the conversation to, with its own model, instructions and memory. */
  orclingId?: string;
  instructions: string;
}

/** Execution choices scoped to the authenticated, active Slack run. */
export interface ExecutionTools {
  available(runId: string): boolean;
  context(runId: string): Promise<unknown>;
  switch(runId: string, input: ExecutionSwitchInput): Promise<unknown>;
}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

export function registerExecutionTools(mcp: McpServer, execution: ExecutionTools, runId: string): void {
  mcp.registerTool(
    "execution_context",
    {
      description:
        "Inspect this active Slack conversation's model, configured reasoning effort, harness and working folder, plus available models with supported efforts/defaults, the folder catalog and the owner's Orclings. A null current effort means the model's default. Use this to answer settings questions or choose a requested switch.",
      inputSchema: {},
    },
    async () => text(await execution.context(runId)),
  );
  mcp.registerTool(
    "execution_switch",
    {
      description:
        "Queue a model/harness, reasoning effort, folder or Orcling change requested by the Slack owner, using exact IDs and supported efforts from execution_context. Effort can change alone; null resets it to the model's default. Omitted effort is preserved for the same model; a different model uses its default. orclingId hands the conversation to one of the owner's Orclings, which answers with its own model, instructions and memory, never with looser permissions. Supply the owner's remaining task as instructions. After acceptance, end your turn immediately: OpenOrc continues this same conversation automatically with those settings.",
      inputSchema: {
        agent: HarnessId.optional(),
        model: z.string().min(1).optional(),
        effort: z.string().min(1).nullable().optional(),
        folderId: z.string().min(1).optional(),
        orclingId: z.string().min(1).optional(),
        instructions: z.string().min(1).max(20000),
      },
    },
    async (input) => {
      if (!input.agent && !input.model && input.effort === undefined && !input.folderId && !input.orclingId) throw new Error("Choose a model, harness, effort, folder or Orcling to switch.");
      return text(await execution.switch(runId, input));
    },
  );
}
