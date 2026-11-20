import { useEffect, useState } from "react";
import type { Block } from "@openorc/client";
import { core } from "./rpc";

type ToolBlock = Extract<Block, { kind: "tool" }>;

/** A loaded page leaves large outputs out; a row about to open reads its output from the log of the thread, here or in the cloud. */
export function useToolOutput(block: ToolBlock, open: boolean): unknown {
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
