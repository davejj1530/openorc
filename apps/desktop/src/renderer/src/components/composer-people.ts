import { personTag } from "@openorc/client";
import type { ThreadTaggable } from "@openorc/protocol";
import { keepPreviousData } from "@tanstack/react-query";
import { useMemo } from "react";
import { useRpc } from "../lib/client";
import type { SuggestionRow } from "./composer-commands";
import type { PeoplePicks } from "./composer-notes";
import { matchingPeople } from "./TeamChatTagPicker";

/**
 * The people whose names match the `@` word, as the thread's server finds them for the words typed: never the reader.
 * The list stands while the next word's read is on its way.
 */
export function usePeopleMatches(people: PeoplePicks | undefined, query: string | null): ThreadTaggable[] {
  const read = useRpc(
    "threads.people",
    { threadId: people?.threadId ?? "", ...(query && { q: query }) },
    { enabled: Boolean(people) && query !== null, staleTime: 10_000, placeholderData: keepPreviousData },
  );
  const viewer = people?.viewerId;
  return useMemo(
    () =>
      query === null
        ? []
        : matchingPeople(
            (read.data?.people ?? []).filter((person) => person.id !== viewer),
            query,
          ),
    [read.data, viewer, query],
  );
}

/** Those people under People, by face and full name: picking one puts their tag in place of the `@` word. */
export function peopleRows(
  matches: readonly ThreadTaggable[],
  people: PeoplePicks | undefined,
  { token, caret, value, write }: { token: { start: number } | null; caret: number; value: string; write: (text: string, caret: number) => void },
): SuggestionRow[] {
  if (!people || !token) return [];
  return matches.map((person) => ({
    key: `person:${person.id}`,
    label: person.name,
    // Only people who share a name carry an address, which tells them apart.
    ...(person.address && { hint: person.address }),
    face: { name: person.name, image: person.image },
    group: "People",
    pick: () => {
      people.pick(person);
      const tag = `${personTag(person.id)} `;
      write(`${value.slice(0, token.start)}${tag}${value.slice(caret)}`, token.start + tag.length);
    },
  }));
}
