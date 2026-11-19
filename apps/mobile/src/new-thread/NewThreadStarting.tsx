import type { Block } from "@openorc/client";
import { ScrollView } from "react-native";
import { Prompt } from "../thread/messages";
import { emptyRowMemo, transcriptRows } from "../thread/rows";
import { WorkRow } from "../thread/WorkRow";

/** A first message on its way to OpenOrc Cloud: what New thread shows from Start until the thread is there to open. */
export interface CloudStart {
  text: string;
  attachments: string[];
  at: number;
}

/**
 * A cloud start as the thread it is becoming, as the desktop shows it: the message as sent, and the start's step under
 * it drawn as the thread draws its work, until the server holds the thread and it opens with its own steps. A start
 * that fails gives the composer back with its words and the draft.
 */
export function NewThreadStarting({ start }: { start: CloudStart }) {
  const blocks: Block[] = [
    { id: "start-message", kind: "message", role: "user", text: start.text, streaming: false, pending: true, at: start.at, ...(start.attachments.length ? { attachments: start.attachments } : {}) },
    { id: "start-thread", kind: "activity", label: "Starting the thread", status: "running", text: "", at: start.at },
  ];
  const rows = transcriptRows(blocks, { live: true, working: true }, "new-thread", emptyRowMemo());
  return (
    <ScrollView accessibilityState={{ busy: true }} className="flex-1 bg-bg" contentContainerClassName="gap-4 px-3 pt-4">
      {rows.map((row) => {
        if (row.kind === "prompt") return <Prompt key={row.key} block={row.block} />;
        if (row.kind === "work") return <WorkRow key={row.key} row={row} />;
        return null;
      })}
    </ScrollView>
  );
}
