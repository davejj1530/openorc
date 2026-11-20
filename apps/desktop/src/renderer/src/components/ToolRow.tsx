import { lazy, Suspense, useMemo } from "react";
import { useToolOutput } from "../lib/tool-output";
import { type Block, visualizationFromTool, workObjects, actLines } from "@openorc/client";
import { ToolDetail } from "./ToolDetail";
import { SubagentCards } from "./SubagentCards";
import { ActGroup } from "./WorkActs";
import type { RenderBlocks } from "./WorkMarks";

const McpAppResult = lazy(() => import("./McpAppResult"));
const VisualizationResult = lazy(() => import("./VisualizationResult"));

type ToolBlock = Extract<Block, { kind: "tool" }>;

/**
 * A tool call outside a step: the same lines a step draws for it, each opening the thing drawn as what it is.
 * `details` draws only what the call holds, for a line that opens the call itself.
 */
export function ToolRow({ block, details = false }: { block: ToolBlock; details?: boolean }) {
  if (block.subagent) return <SubagentCards blocks={[block]} />;
  const visualization = visualizationFromTool(block);
  if (details) return <ToolCallDetails block={block} visualization={visualization} />;
  return (
    <div className="tool-row-block">
      {visualization ? <Visualization visualization={visualization} /> : null}
      <ToolLines block={block} />
      {!visualization ? <McpApp block={block} /> : null}
    </div>
  );
}

/** How a line opens the call behind it. */
const callDetails: RenderBlocks = (blocks) => blocks.map((block) => (block.kind === "tool" ? <ToolCallDetails key={block.id} block={block} visualization={null} /> : null));

/** The call as the lines of a step: one for most, more for a command that also searched and read. */
function ToolLines({ block }: { block: ToolBlock }) {
  const lines = useMemo(() => actLines(workObjects([block], [block], !block.done)), [block]);
  return <ActGroup group={lines} current={false} renderBlocks={callDetails} />;
}

/** What a call drew, shown as itself: in a tool row, or in an Orcling's chat. */
export function Visualization({ visualization }: { visualization: NonNullable<ReturnType<typeof visualizationFromTool>> }) {
  return (
    <Suspense fallback={<p className="text-sm text-ink-2">{visualization.description}</p>}>
      <VisualizationResult visualization={visualization} />
    </Suspense>
  );
}

function McpApp({ block }: { block: ToolBlock }) {
  if (!block.mcp || !block.done || !block.runId) return null;
  return (
    <Suspense fallback={null}>
      <McpAppResult runId={block.runId} toolCallId={block.id} />
    </Suspense>
  );
}

/** A call without a head of its own: what it shows, any progress while it runs, then what it was asked and gave. */
function ToolCallDetails({ block, visualization }: { block: ToolBlock; visualization: ReturnType<typeof visualizationFromTool> }) {
  const output = useToolOutput(block, true);
  return (
    <div className="tool-call-details">
      {visualization ? <Visualization visualization={visualization} /> : null}
      {block.progress ? <div className="tool-call-progress">{block.progress}</div> : null}
      <ToolDetail block={block} output={output} />
      {!visualization ? <McpApp block={block} /> : null}
    </div>
  );
}
