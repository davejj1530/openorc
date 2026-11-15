import { noteFromDraft, PERSON_TAG, tagsPerson } from "@openorc/client";
import { useMemo } from "react";
import { useRpc } from "../lib/client";
import { usePickedPeople, type TaggedPerson } from "../lib/draft-people";

/** A note as a draft posts it: its words with each tag written as the person's name, and where each name stands. */
export type DraftNote = NonNullable<ReturnType<typeof noteFromDraft>>;

/** Where a cloud thread's notes go from its composer, while the server lets the reader post them. */
export interface ComposerNotes {
  threadId: string;
  /** The reader, whom `@` never offers. */
  viewerId: string | null;
  /** Posts the note; fails in the server's words, which the composer shows over the draft it keeps. */
  post: (note: DraftNote) => Promise<void>;
}

/** What `@` offers in a thread with notes: the people who read it, and the way a pick tags one in the draft. */
export interface PeoplePicks {
  threadId: string;
  viewerId: string | null;
  /** The people the draft tags, by the names their tags read as. */
  named: readonly TaggedPerson[];
  pick: (person: TaggedPerson) => void;
}

export const NOTE_TIP = "Posts to the thread. The agent reads it on its next turn.";
const FILES_HELD = "Remove the attachments to post a note.";
const UNNAMED = "Choose the people to tag again.";

/**
 * A draft in a thread with notes. It tags people picked from `@` or by Reply, kept with the draft; a tag of someone it
 * did not pick here, as in a draft written elsewhere, takes its name from the thread's people. Once it tags someone it is
 * a note: what it posts, and why it cannot post yet. A draft that tags nobody is a message to the agent.
 */
export function useDraftNote(notes: ComposerNotes | null | undefined, draftKey: string | undefined, text: string, files: number) {
  const picked = usePickedPeople(notes ? draftKey : undefined, text);
  const isNote = Boolean(notes) && tagsPerson(text);
  const unnamed = useMemo(() => (isNote ? [...text.matchAll(PERSON_TAG)].map((tag) => tag[1]!).filter((id) => !picked.people.some((person) => person.id === id)) : []), [isNote, text, picked.people]);
  const read = useRpc("threads.people", { threadId: notes?.threadId ?? "" }, { enabled: unnamed.length > 0 });
  const named = useMemo(() => [...picked.people, ...(read.data?.people ?? []).filter((person) => unnamed.includes(person.id))], [picked.people, read.data, unnamed]);
  const note = isNote ? noteFromDraft(text, named) : null;
  const people: PeoplePicks | undefined = notes ? { threadId: notes.threadId, viewerId: notes.viewerId, named, pick: picked.pick } : undefined;
  const block = noteBlock(isNote, files, note);
  return {
    people,
    pick: picked.pick,
    isNote,
    /** Why the note cannot post now: files ride only with messages, and every tag must name someone. */
    block,
    /** Posts the note, once nothing holds it. */
    post: note && notes && !block ? () => notes.post(note) : null,
  };
}

function noteBlock(isNote: boolean, files: number, note: DraftNote | null): string | null {
  if (!isNote) return null;
  if (files > 0) return FILES_HELD;
  return note ? null : UNNAMED;
}
