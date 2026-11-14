import { z } from "zod";

/** Frozen tool-result parsers from 85bf1c5e and 89a9ed15; changing today's protocol must not change this proof. */
const base = { eventId: z.string().optional(), runId: z.string(), ts: z.number() };
const source = z.object({ server: z.string(), tool: z.string(), resourceUri: z.string().optional(), connectorId: z.string().optional() });
const result = {
  type: z.literal("tool.completed"),
  toolCallId: z.string(),
  name: z.string(),
  output: z.unknown(),
  mcp: source.optional(),
  isError: z.boolean(),
  status: z.enum(["running", "success", "error", "cancelled", "disconnected"]).optional(),
  input: z.unknown().optional(),
  outputOmitted: z.boolean().optional(),
};
export const installedTaskEvents = {
  appStore: z.object({ ...base, ...result }),
  testFlight: z.object({ ...base, subagentId: z.string().optional(), ...result }),
};

type ToolBlock = { name: string; output: unknown; done: boolean; isError?: boolean };

/** The tool output and id extraction below are unchanged between those installed builds. */
function toolText(block: ToolBlock): string {
  const out = block.output;
  const content = Array.isArray(out) ? out : (out as { content?: unknown[] })?.content;
  if (typeof out === "string") return out;
  if (content) return content.map((c) => (c as { text?: string }).text ?? "").join("");
  return JSON.stringify(out ?? "");
}

export function installedTaskIdFromTool(block: ToolBlock): string | null {
  if (/thread_start$/.test(block.name)) return startedWorkFromTool(block)?.taskId ?? null;
  if (!/task_(create|start)$/.test(block.name) || !block.done || block.isError) return null;
  return /"id":\s*"([0-9a-f-]{36})"/.exec(toolText(block))?.[1] ?? null;
}

function startedWorkFromTool(block: ToolBlock): { threadId: string; taskId: string | null } | null {
  if (!/thread_start$/.test(block.name) || !block.done || block.isError) return null;
  try {
    const started = JSON.parse(toolText(block)) as { thread?: { id?: unknown }; task?: { id?: unknown } };
    if (typeof started.thread?.id !== "string") return null;
    return { threadId: started.thread.id, taskId: typeof started.task?.id === "string" ? started.task.id : null };
  } catch {
    return null;
  }
}
