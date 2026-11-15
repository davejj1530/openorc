import type { AgentEvent, ThreadNote } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { placeNotes } from "./note-places.js";
import { applyEvents, emptyRun } from "./transcript.js";

const THREAD = "3f2c9a1e-thread";
/** Events as a cloud thread's log gives them: each id is the thread and its seq. */
const at = (seq: number, event: Record<string, unknown>) => ({ ...event, ts: seq * 1000, eventId: `${THREAD}.${seq}`, runId: "hosted:t" }) as unknown as AgentEvent;
const note = (seq: number, afterEventSeq: number): ThreadNote => ({
  id: `n${seq}`,
  seq,
  author: { id: "u-mara", name: "Mara Okafor", image: null },
  text: "@Theo look",
  mentions: [],
  replyTo: null,
  createdAt: "",
  afterEventSeq,
  mentionedYou: false,
  read: false,
});

function run() {
  const r = emptyRun("hosted:t");
  applyEvents(r, [
    at(1, { type: "message.completed", messageId: "m1", role: "user", text: "Add a CSV export" }),
    at(2, { type: "message.delta", messageId: "r1", role: "assistant", text: "The export " }),
    at(3, { type: "message.delta", messageId: "r1", role: "assistant", text: "uses the filters." }),
    at(4, { type: "message.completed", messageId: "r1", role: "assistant", text: "The export uses the filters." }),
    at(5, { type: "message.completed", messageId: "m2", role: "user", text: "Add the download button" }),
  ]);
  return r;
}

describe("where a thread's notes stand among its work", () => {
  it("follows the block its event head reached, even one still growing after it", () => {
    const blocks = run().blocks;
    expect(blocks.map((block) => [block.id, block.seq])).toEqual([
      ["m1", 1],
      ["r1", 2],
      ["m2", 5],
    ]);
    // Posted while the reply was streaming (head 3): it stays after the reply, never moved to the end.
    const placed = placeNotes(blocks, [note(1, 3), note(2, 5), note(3, 3)]);
    expect([...placed.after.entries()].map(([id, notes]) => [id, notes.map((each) => each.id)])).toEqual([
      ["r1", ["n1", "n3"]],
      ["m2", ["n2"]],
    ]);
    expect(placed.top).toEqual([]);
  });

  it("puts a note before every loaded block at the top", () => {
    const placed = placeNotes(run().blocks, [note(1, 0)]);
    expect(placed.top.map((each) => each.id)).toEqual(["n1"]);
  });
});
