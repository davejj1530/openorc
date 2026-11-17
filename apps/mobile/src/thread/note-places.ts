import { placeNotes, type Block } from "@openorc/client";
import type { ThreadNote } from "@openorc/protocol";

/** A cloud thread's notes among its loaded blocks: those before every block, and those that follow each block. */
export interface NotePlaces {
  top: readonly ThreadNote[];
  after: ReadonlyMap<string, readonly ThreadNote[]>;
}

export const NO_NOTES: NotePlaces = { top: [], after: new Map() };

/** Where each note stands among the blocks, as the desktop places them; none for a thread without notes. */
export const notePlaces = (blocks: readonly Block[], notes: readonly ThreadNote[]): NotePlaces => (notes.length ? placeNotes(blocks, notes) : NO_NOTES);

/** The notes that follow any of these blocks, in the order the blocks stand. */
export const notesAfter = (places: NotePlaces, blocks: readonly Block[]): ThreadNote[] => (places.after.size ? blocks.flatMap((block) => places.after.get(block.id) ?? []) : []);

/** Notes as a key: a note keeps its place and its words, so only which notes they are and whether each is read can change. */
export const notesKey = (notes: readonly ThreadNote[]): string => notes.map((note) => `${note.id}:${note.read}`).join(",");
