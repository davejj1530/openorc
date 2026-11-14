import type { Block } from "./transcript.js";
import { OnlineTaskToolReference } from "@openorc/protocol";

export type TaskToolReference = OnlineTaskToolReference;
export type TaskToolSource = { kind: "none" } | { kind: "unavailable" } | { kind: "online"; reference: TaskToolReference };
export function taskReferenceFromTool(block: Extract<Block, { kind: "tool" }>, id: string): TaskToolSource {
  if (!block.done || block.isError) return { kind: "none" };
  const output = resultText(block.output);
  let value: unknown;
  try {
    value = typeof output === "string" ? JSON.parse(output) : output;
  } catch {
    return { kind: typeof output === "string" && output.includes('"taskRef"') ? "unavailable" : "none" };
  }
  if (!record(value)) return { kind: "none" };
  const task = record(value["task"]) ? value["task"] : value;
  const container = "taskRef" in task ? task : value;
  if (!("taskRef" in container)) return { kind: "none" };
  const parsed = OnlineTaskToolReference.safeParse(container["taskRef"]);
  return parsed.success && parsed.data.id === id ? { kind: "online", reference: parsed.data } : { kind: "unavailable" };
}

export function taskToolKey(block: Extract<Block, { kind: "tool" }>, id: string): string {
  const source = taskReferenceFromTool(block, id);
  return source.kind === "online" ? JSON.stringify([source.reference.spaceId, source.reference.projectId, id]) : `${source.kind}:${id}`;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function resultText(output: unknown): unknown {
  let content: unknown = null;
  if (Array.isArray(output)) content = output;
  else if (record(output)) content = output["content"];
  return Array.isArray(content) ? content.map((item) => (record(item) && typeof item["text"] === "string" ? item["text"] : "")).join("") : output;
}
