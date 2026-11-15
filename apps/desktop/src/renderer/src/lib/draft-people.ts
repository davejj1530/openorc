import { personTag } from "@openorc/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { readDraft, writeDraft } from "./drafts";

/** A person a draft tags, with the name their tag reads as. */
export interface TaggedPerson {
  id: string;
  name: string;
}

/**
 * The people tagged in a draft, kept with its saved attachments so a draft that comes back still reads each tag as a
 * name. A person no longer tagged in the message is forgotten.
 */
export function usePickedPeople(draftKey: string | undefined, text: string): { people: TaggedPerson[]; pick: (person: TaggedPerson) => void } {
  const [picked, setPicked] = useState<TaggedPerson[]>(() => (draftKey ? readDraft(draftKey, { people: [] as TaggedPerson[] }).people : []));
  const people = useMemo(() => picked.filter((person) => text.includes(personTag(person.id))), [picked, text]);
  useEffect(() => {
    if (!draftKey) return;
    const saved = readDraft<Record<string, unknown>>(draftKey, {});
    if (JSON.stringify(saved["people"] ?? []) !== JSON.stringify(people)) writeDraft(draftKey, { ...saved, people });
  }, [draftKey, people]);
  const pick = useCallback((person: TaggedPerson) => setPicked((now) => [...now.filter((each) => each.id !== person.id), { id: person.id, name: person.name }]), []);
  return { people, pick };
}
