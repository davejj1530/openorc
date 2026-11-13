import { useCallback, useEffect, useMemo, useState } from "react";
import { readDraft, writeDraft } from "./drafts";

/** A member the composer can address with `@`. `name` is what gets inserted; `key` only identifies it. */
export interface MentionEntry {
  key: string;
  name: string;
  hint: string;
}

/** The `@` word at the caret, when the `@` starts a word. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(?:^|\s)@(\S*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[1] ?? "";
  return { start: caret - query.length - 1, query };
}

/** Prefix matches on the name or key, case-insensitive; an empty query lists everyone. */
export function filterMentions<T extends Pick<MentionEntry, "key" | "name">>(entries: T[], query: string): T[] {
  const needle = query.toLowerCase();
  return entries.filter((entry) => entry.name.toLowerCase().startsWith(needle) || entry.key.toLowerCase().startsWith(needle));
}

/** Replace the `@` word with `@Name ` and put the caret after the space. */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const mention = `@${name} `;
  return { text: `${text.slice(0, start)}${mention}${text.slice(caret)}`, caret: start + mention.length };
}

/**
 * The files picked from the `@` list for a draft, kept with its saved attachments so a draft that comes back still
 * reads their paths as mentions. A path no longer in the message is forgotten.
 */
export function usePickedFiles(draftKey: string | undefined, text: string): { files: string[]; pick: (path: string) => void } {
  const [picked, setPicked] = useState<string[]>(() => (draftKey ? readDraft(draftKey, { files: [] as string[] }).files : []));
  const files = useMemo(() => picked.filter((path) => text.includes(path)), [picked, text]);
  useEffect(() => {
    if (!draftKey) return;
    const saved = readDraft<Record<string, unknown>>(draftKey, {});
    if (JSON.stringify(saved["files"] ?? []) !== JSON.stringify(files)) writeDraft(draftKey, { ...saved, files });
  }, [draftKey, files]);
  const pick = useCallback((path: string) => setPicked((now) => (now.includes(path) ? now : [...now, path])), []);
  return { files, pick };
}
