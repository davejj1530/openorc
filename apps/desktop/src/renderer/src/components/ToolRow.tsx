import { lazy, Suspense, useEffect, useState } from "react";
import { cn } from "../lib/cn";
import { core } from "../lib/rpc";
import { toolResult } from "../lib/tool-result";
import type { Block } from "../lib/transcript";
import { visualizationFromTool } from "../lib/visualization";
import { ChevronRight, CircleCheck, Loader2, Terminal, X } from "./icons";
import { liveVerb, stateLabel, toolCallPresentation } from "./tool-presentation";
import { ToolDetail } from "./ToolDetail";
import { toolIntent } from "./work-chips";
import { isCheckCommand } from "./work-receipt";

const McpAppResult = lazy(() => import("./McpAppResult"));
const VisualizationResult = lazy(() => import("./VisualizationResult"));

type ToolBlock = Extract<Block, { kind: "tool" }>;

/** A loaded page leaves large outputs out; a row about to open reads its output from the ledger. */
function useToolOutput(block: ToolBlock, open: boolean): unknown {
  const [loaded, setLoaded] = useState<{ id: string; output: unknown } | null>(null);
  const { outputOmitted, runId, id } = block;
  const have = loaded?.id === id;
  useEffect(() => {
    if (!open || !outputOmitted || !runId || have) return;
    let current = true;
    core.call("events.toolOutput", { runId, toolCallId: id }).then(
      (result) => current && setLoaded({ id, output: result.output ?? undefined }),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [open, outputOmitted, runId, id, have]);
  if (!outputOmitted) return block.output;
  return have ? loaded.output : undefined;
}

/** Open on request, and fetching an omitted output as soon as the pointer or focus reaches the row. */
function useToolDisclosure(block: ToolBlock, defaultOpen: boolean) {
  const [open, setOpen] = useState(defaultOpen);
  const [near, setNear] = useState(false);
  const output = useToolOutput(block, open || near);
  const approach = block.outputOmitted ? () => setNear(true) : undefined;
  return { open, toggle: () => setOpen((value) => !value), output, approach };
}

function toolState(block: ToolBlock): string {
  if (!block.done) return "running";
  return block.status ?? (block.isError ? "error" : "success");
}

/** A tool call: a command as its own card, anything else as one quiet row. Click either for the call itself. */
export function ToolRow({ block, defaultOpen = false }: { block: ToolBlock; defaultOpen?: boolean }) {
  const visualization = visualizationFromTool(block);
  const presentation = toolCallPresentation(block.name, block.input);
  if (presentation.verb === "Ran" && !visualization) return <CommandCard block={block} command={presentation.object} defaultOpen={defaultOpen} />;
  return (
    <div className="tool-row-block">
      {visualization ? (
        <Suspense fallback={<p className="text-sm text-ink-2">{visualization.description}</p>}>
          <VisualizationResult visualization={visualization} />
        </Suspense>
      ) : null}
      <PlainToolRow block={block} label={rowLabel(block, presentation.verb, Boolean(visualization))} object={visualization ? "" : presentation.object} defaultOpen={defaultOpen} />
      {!visualization && block.mcp && block.done && block.runId ? (
        <Suspense fallback={null}>
          <McpAppResult runId={block.runId} toolCallId={block.id} />
        </Suspense>
      ) : null}
    </div>
  );
}

function rowLabel(block: ToolBlock, verb: string, visualization: boolean): string {
  if (visualization) return "View source";
  return block.done ? verb : liveVerb(verb);
}

function PlainToolRow({ block, label, object, defaultOpen }: { block: ToolBlock; label: string; object: string; defaultOpen: boolean }) {
  const { open, toggle, output, approach } = useToolDisclosure(block, defaultOpen);
  const { icon: Icon, tone } = toolCallPresentation(block.name, block.input);
  return (
    <>
      <button type="button" aria-expanded={open} data-state={toolState(block)} onClick={toggle} onPointerEnter={approach} onFocus={approach} className="tool-row">
        <Icon size={16} className="tool-icon shrink-0" data-tone={block.isError ? "error" : tone} />
        <span className="shrink-0">{label}</span>
        {object ? <span className="tool-row-object">{object}</span> : null}
        <ToolStatus block={block} />
        <ChevronRight size={12} className={cn("tool-row-chevron", open && "rotate-90")} />
      </button>
      {block.progress ? <div className="tool-row-progress">{block.progress}</div> : null}
      {open ? (
        <div className="tool-row-detail">
          <ToolDetail block={block} output={output} />
        </div>
      ) : null}
    </>
  );
}

function ToolStatus({ block }: { block: ToolBlock }) {
  if (!block.done) return <Loader2 size={14} className="tool-row-live" />;
  if (block.isError || (block.status && block.status !== "success")) return <span className="text-xs">{stateLabel(block.status ?? "error")}</span>;
  return null;
}

/** The last line a finished command printed, or what a running one is for. */
function commandLine(block: ToolBlock): string {
  if (!block.done) return toolIntent(block) ?? "";
  if (block.output === undefined || block.output === null) return "";
  const text = toolResult(block.output).text.trim();
  return (
    text
      .split("\n")
      .findLast((line) => line.trim())
      ?.trim() ?? ""
  );
}

/** A command the agent ran, as a card: the command, a status that trades places with its result, and its last line. */
function CommandCard({ block, command, defaultOpen }: { block: ToolBlock; command: string; defaultOpen: boolean }) {
  const { open, toggle, output, approach } = useToolDisclosure(block, defaultOpen);
  const state = toolState(block);
  const line = commandLine(block);
  return (
    <div className="command-card" data-plane data-state={state}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${block.done ? "Ran" : liveVerb("Ran")} ${command}${state === "running" || state === "success" ? "" : ` · ${stateLabel(state)}`}`}
        data-state={state}
        onClick={toggle}
        onPointerEnter={approach}
        onFocus={approach}
        className="command-card-row"
      >
        <Terminal size={16} className="command-card-icon" />
        <span className="command-card-command">{command || "Command"}</span>
        <CommandStatus state={state} check={isCheckCommand(command)} />
      </button>
      {line && !open ? <div className="command-card-output">{line}</div> : null}
      {block.progress ? <div className="command-card-output whitespace-pre-wrap">{block.progress}</div> : null}
      {open ? <ToolDetail block={block} output={output} /> : null}
    </div>
  );
}

/** Running, then the result in its place with one overshoot. Only a live command animates the swap. */
function CommandStatus({ state, check }: { state: string; check: boolean }) {
  const [first] = useState(state);
  const settled = state !== first;
  if (state === "running")
    return (
      <span className="command-card-status">
        <Loader2 size={14} className="tool-row-live" />
        Running
      </span>
    );
  const passed = state === "success";
  const word = check ? "Passed" : "Done";
  return (
    <span className={cn("command-card-status", settled && "command-card-settled")} data-tone={passed ? "ok" : "bad"}>
      {passed ? <CircleCheck size={14} /> : <X size={14} />}
      {passed ? word : stateLabel(state)}
    </span>
  );
}
