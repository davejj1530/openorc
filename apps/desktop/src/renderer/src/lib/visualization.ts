import { isVisualizationTool, Visualization } from "@openorc/protocol";
import type { Block } from "./transcript";

export function visualizationFromTool(block: Block): Visualization | null {
  if (block.kind !== "tool" || !block.done || block.isError || (block.status && block.status !== "success") || !isVisualizationTool(block.name)) return null;
  const result = Visualization.safeParse(block.input);
  return result.success ? result.data : null;
}
