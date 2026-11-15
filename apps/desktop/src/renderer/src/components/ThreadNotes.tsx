import { personName, placeNotes, type Block } from "@openorc/client";
import type { ThreadNote, ThreadSummary } from "@openorc/protocol";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useRpc, useRpcMutation } from "../lib/client";
import type { Reveal } from "../lib/message-reveal";
import { noteReader, type NoteReader } from "../lib/note-reading";
import "../styles/together.css";
import { AccountFace } from "./AccountFace";
import type { ComposerHandle, ComposerNotes } from "./Composer";

/**
 * A cloud thread's notes where the conversation draws them: those before every loaded block, those after each block,
 * the way to answer one, and what marks read a note that tags the reader once they see it. Empty for any other thread.
 */
export interface ThreadNotesValue {
  top: readonly ThreadNote[];
  after: ReadonlyMap<string, readonly ThreadNote[]>;
  onReply: ((note: ThreadNote) => void) | null;
  reader: NoteReader | null;
}

const NONE: ThreadNotesValue = { top: [], after: new Map(), onReply: null, reader: null };

export const ThreadNotesContext = createContext<ThreadNotesValue>(NONE);

/** The most notes one read brings, the newest. */
const NOTES_PER_READ = 200;

/**
 * A cloud thread's notes placed among its blocks, read once the thread has any: the newest, and those around the
 * reader's first unread mention, however far back it is. The value stays the same object while the notes stand where
 * they stood, which streaming never changes (a new block comes after every note's place), so the transcript's turns do
 * not draw again for it. Reply puts the author's tag before the composer's draft.
 */
export function useThreadNotes(thread: ThreadSummary | null, blocks: readonly Block[] | undefined, composer: RefObject<ComposerHandle | null>): ThreadNotesValue {
  const collaboration = thread?.owner?.brain === "hosted" ? thread.owner.collaboration : undefined;
  const threadId = thread?.id ?? "";
  const noted = Boolean(thread) && (collaboration?.noteHead ?? 0) > 0;
  const mention = collaboration?.mentions.firstUnreadNoteId ?? null;
  const newest = useRpc("threads.notes", { threadId, limit: NOTES_PER_READ }, { enabled: noted });
  const around = useRpc("threads.notes", { threadId, around: mention ?? "", limit: NOTES_PER_READ }, { enabled: noted && mention !== null });
  const notes = useMemo(() => joinPages(newest.data?.notes, mention ? around.data?.notes : undefined), [newest.data, around.data, mention]);
  const onReply = useCallback((note: ThreadNote) => note.author && composer.current?.tag(note.author, note.id), [composer]);
  const reader = useNoteReader(noted ? threadId : null);
  const last = useRef<{ key: string; value: ThreadNotesValue } | null>(null);
  return useMemo(() => {
    if (!notes.length) return NONE;
    const placed = placeNotes(blocks ?? [], notes);
    const key = JSON.stringify([placed.top.map((note) => note.id), [...placed.after].map(([id, each]) => [id, each.map((note) => `${note.id}:${note.seq}:${note.read}`)])]);
    if (last.current?.key === key && last.current.value.onReply === onReply && last.current.value.reader === reader) return last.current.value;
    const value = { ...placed, onReply, reader };
    last.current = { key, value };
    return value;
  }, [notes, blocks, onReply, reader]);
}

/** Two pages of a thread's notes as one, each note once, in `seq` order. */
function joinPages(...pages: (readonly ThreadNote[] | undefined)[]): ThreadNote[] {
  const byId = new Map(pages.flatMap((page) => page ?? []).map((note) => [note.id, note]));
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/** What marks read the notes that tag the reader in this thread as they see them; none while it has no notes. */
function useNoteReader(threadId: string | null): NoteReader | null {
  const { mutateAsync } = useRpcMutation("threads.readNotes");
  const [reader, setReader] = useState<NoteReader | null>(null);
  useEffect(() => {
    if (!threadId) return;
    const made = noteReader((ids) => mutateAsync({ threadId, ids }));
    setReader(made);
    return () => {
      made.close();
      setReader(null);
    };
  }, [threadId, mutateAsync]);
  return reader;
}

/**
 * The reader's first unread mention as the thread opened, to bring into view once, as a search result is. It stays
 * while the thread stays open, so reading it, or a note that comes later, never moves the view.
 */
export function useMentionReveal(thread: ThreadSummary | null): Reveal | undefined {
  const id = thread?.id ?? null;
  const first = thread?.owner?.brain === "hosted" ? (thread.owner.collaboration?.mentions.firstUnreadNoteId ?? null) : null;
  const opened = (): { threadId: string | null; reveal: Reveal | undefined } => ({ threadId: id, reveal: first ? { messageId: first } : undefined });
  const [shown, setShown] = useState(opened);
  if (shown.threadId === id) return shown.reveal;
  const next = opened();
  setShown(next);
  return next.reveal;
}

/**
 * Where the composer posts notes, while the server lets the reader post them in this cloud thread. A note keeps its id
 * while its words and tags stay the same, so posting it again after a lost answer is the same note.
 */
export function useComposerNotes(thread: ThreadSummary | null): ComposerNotes | null {
  const collaboration = thread?.owner?.brain === "hosted" ? thread.owner.collaboration : undefined;
  const threadId = collaboration?.canPostNote ? (thread?.id ?? null) : null;
  const viewerId = collaboration?.viewer?.id ?? null;
  const { mutateAsync } = useRpcMutation("threads.postNote");
  const pending = useRef<{ key: string; id: string } | null>(null);
  return useMemo(() => {
    if (!threadId) return null;
    const post: ComposerNotes["post"] = async (note) => {
      const key = JSON.stringify(note);
      if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() };
      await mutateAsync({ threadId, id: pending.current.id, ...note });
      pending.current = null;
    };
    return { threadId, viewerId, post };
  }, [threadId, viewerId, mutateAsync]);
}

/** The notes that follow any of these blocks, in the order their blocks stand. */
export function useNotesAfter(blocks: readonly Block[]): readonly ThreadNote[] {
  const { after } = useContext(ThreadNotesContext);
  return after.size ? blocks.flatMap((block) => after.get(block.id) ?? []) : [];
}

/** The notes that stand before every loaded block. */
export function useTopNotes(): readonly ThreadNote[] {
  return useContext(ThreadNotesContext).top;
}

export function NoteList({ notes }: { notes: readonly ThreadNote[] }) {
  return notes.map((note) => <NoteView key={note.id} note={note} />);
}

/**
 * A note in the thread: its own filled block with its author's face and name and the word Note, never the agent's mark
 * or a turn's status, and its words with the people it tags in blue. Reply starts a note back to its author. One that
 * tags the reader unread is read once they see it; a search or an opened mention finds it by its id.
 */
function NoteView({ note }: { note: ThreadNote }) {
  const { onReply, reader } = useContext(ThreadNotesContext);
  const name = personName(note.author);
  const place = useRef<HTMLElement>(null);
  const unread = note.mentionedYou && !note.read;
  useEffect(() => (unread && reader && place.current ? reader.watch(place.current, note.id) : undefined), [unread, reader, note.id]);
  return (
    <article ref={place} aria-label={`Note from ${name}`} data-message={note.id} className="transcript-block mt-3 rounded-2xl bg-bubble px-4 py-3.5">
      <header className="note-author">
        {note.author ? <AccountFace name={name} image={note.author.image} /> : null}
        <span className="prompt-author-name">{name}</span>
        <span className="shrink-0 text-ink-4">Note</span>
      </header>
      <p className="mt-2 text-prose text-ink whitespace-pre-wrap wrap-anywhere">{noteWords(note)}</p>
      {onReply && note.author ? (
        <button type="button" className="focus-ring mt-2 rounded-sm text-sm text-ink-3 hover:text-ink" onClick={() => onReply(note)}>
          Reply
        </button>
      ) : null}
    </article>
  );
}

/** The note's words, each tag the plain blue words of the person it names. */
function noteWords(note: ThreadNote): ReactNode[] {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const mention of [...note.mentions].sort((a, b) => a.start - b.start)) {
    if (mention.start < at || mention.end > note.text.length) continue;
    if (mention.start > at) parts.push(note.text.slice(at, mention.start));
    parts.push(
      <span key={mention.start} className="person-token">
        {note.text.slice(mention.start, mention.end)}
      </span>,
    );
    at = mention.end;
  }
  if (at < note.text.length) parts.push(note.text.slice(at));
  return parts;
}
