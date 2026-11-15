import { PERSON_TAG, personTag, skillNames, skillSegments, type SkillPrefix } from "@openorc/client";
import type { UsableConnector } from "@openorc/protocol";
import { connectorSpans } from "./connector-mentions";

/** What a word in a message can stand for. Each kind is drawn by its own mark and held by its own editor node. */
export type Mark =
  { kind: "skill"; name: string } | { kind: "connector"; connector: UsableConnector } | { kind: "member"; key: string } | { kind: "file"; path: string } | { kind: "person"; id: string; name: string };

export type MarkKind = Mark["kind"];

/** A run of a message: plain words, or the words of one mark. The message is the runs' text joined, nothing else. */
export interface Piece {
  text: string;
  mark?: Mark;
}

/** Everything a message's words may name. Only a name that is listed here is marked. */
export interface MarkSources {
  commands?: readonly { name: string; insert?: boolean; prefix?: SkillPrefix; aliases?: readonly string[] | undefined }[] | undefined;
  connectors?: readonly UsableConnector[] | undefined;
  /** Who `@` can address, by the name inserted for them. */
  members?: readonly { key: string; name: string }[] | undefined;
  /** Paths picked from the `@` list for this draft; a path the person typed is only words. */
  files?: readonly string[] | undefined;
  /** People a structured `@[user:ID]` tag may name, with the name it reads as. A typed `@Name` is only words. */
  people?: readonly { id: string; name: string }[] | undefined;
}

export { PERSON_TAG, personTag };

function splitPeople(pieces: Piece[], people: readonly { id: string; name: string }[]): Piece[] {
  if (!people.length) return pieces;
  const byId = new Map(people.map((person) => [person.id, person.name]));
  return pieces.flatMap((piece) => {
    if (piece.mark) return [piece];
    const out: Piece[] = [];
    let at = 0;
    for (const match of piece.text.matchAll(PERSON_TAG)) {
      const name = byId.get(match[1]!);
      if (name === undefined) continue;
      if (match.index > at) out.push({ text: piece.text.slice(at, match.index) });
      out.push({ text: match[0], mark: { kind: "person", id: match[1]!, name } });
      at = match.index + match[0].length;
    }
    if (at < piece.text.length) out.push({ text: piece.text.slice(at) });
    return out;
  });
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

/** Splits plain runs at every whole word `words` names, longest name first, leaving marked runs alone. */
function splitWords(pieces: Piece[], words: ReadonlyMap<string, Mark>, { prefix, caseless }: { prefix: string; caseless: boolean }): Piece[] {
  if (words.size === 0) return pieces;
  const names = [...words.keys()].sort((a, b) => b.length - a.length).map(escape);
  const pattern = new RegExp(`(^|\\s)(${escape(prefix)}(${names.join("|")}))(?![\\w/-])`, caseless ? "gi" : "g");
  return pieces.flatMap((piece) => {
    if (piece.mark) return [piece];
    const out: Piece[] = [];
    let at = 0;
    for (const match of piece.text.matchAll(pattern)) {
      const start = match.index + (match[1] ?? "").length;
      const mark = words.get(caseless ? match[3]!.toLowerCase() : match[3]!);
      if (!mark) continue;
      if (start > at) out.push({ text: piece.text.slice(at, start) });
      out.push({ text: match[2]!, mark });
      at = start + match[2]!.length;
    }
    if (at < piece.text.length) out.push({ text: piece.text.slice(at) });
    return out;
  });
}

/**
 * The runs of a message as they read: each skill, connector, member and picked file it names, and the words around
 * them. Joining the runs' text gives the message back unchanged, so the marks are a reading of the words, never part of
 * what is sent.
 */
export function markPieces(text: string, sources: MarkSources): Piece[] {
  if (text === "") return [];
  const prefix = sources.commands?.find((command) => command.insert)?.prefix ?? "/";
  let pieces: Piece[] = splitPeople([{ text }], sources.people ?? []).flatMap((piece) =>
    piece.mark
      ? [piece]
      : skillSegments(piece.text, skillNames(sources.commands ?? []), prefix).map((segment): Piece =>
          segment.skill ? { text: segment.text, mark: { kind: "skill", name: segment.text.slice(1) } } : { text: segment.text },
        ),
  );
  pieces = splitWords(pieces, new Map((sources.members ?? []).map((member) => [member.name.toLowerCase(), { kind: "member", key: member.key } as Mark])), { prefix: "@", caseless: true });
  pieces = pieces.flatMap((piece) =>
    piece.mark
      ? [piece]
      : connectorSpans(piece.text, sources.connectors ?? []).map((span) => (span.connector ? { text: span.text, mark: { kind: "connector", connector: span.connector } } : { text: span.text })),
  );
  return splitWords(pieces, new Map((sources.files ?? []).map((path) => [path, { kind: "file", path } as Mark])), { prefix: "", caseless: false });
}

/** The message a run of pieces makes. */
export const piecesText = (pieces: readonly Piece[]): string => pieces.map((piece) => piece.text).join("");

/** Whether two runs read the same, mark and all, so an editor can keep the one it already has. */
export function samePiece(a: Piece, b: Piece): boolean {
  return a.text === b.text && JSON.stringify(a.mark ?? null) === JSON.stringify(b.mark ?? null);
}

/** What a set of sources marks, as one string: equal for lists rebuilt with the same names. */
export function sourcesKey({ commands, connectors, members, files, people }: MarkSources): string {
  return JSON.stringify([
    (commands ?? []).filter((command) => command.insert).map((command) => [command.name, command.prefix, command.aliases]),
    (connectors ?? []).map((connector) => [connector.name, connector.title, connector.logo]),
    (members ?? []).map((member) => [member.key, member.name]),
    files ?? [],
    (people ?? []).map((person) => [person.id, person.name]),
  ]);
}
