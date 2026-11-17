import { personFirst } from "@openorc/client";
import type { TeamMessage } from "@openorc/protocol";
import { OrclingFace } from "../orclings/OrclingFace";
import { PersonFace } from "../ui/PersonFace";

/** Who wrote a message: the person, a former member, or an Orcling as "<name> · <owner>'s Orcling". */
export function authorOf(message: TeamMessage, self: string): string {
  const { actor } = message;
  if (actor.kind === "orcling") return `${actor.name} · ${actor.owner.id === self ? "Your" : `${personFirst(actor.owner)}'s`} Orcling`;
  return actor.person?.name ?? "Former member";
}

/** Who wrote a message, by face: a person's picture or initials, an Orcling's own look, 28 pt either way. */
export function ActorFace({ message }: { message: TeamMessage }) {
  const { actor } = message;
  if (actor.kind === "orcling") return <OrclingFace look={actor.look} size={28} />;
  return <PersonFace name={actor.person?.name ?? "?"} image={actor.person?.image ?? null} size="lg" />;
}
