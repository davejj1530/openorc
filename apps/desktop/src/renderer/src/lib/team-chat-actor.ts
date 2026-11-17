import type { TeamChatActor } from "@openorc/protocol";

/** Who said a message, in words: a person's name, or the Orcling's, which belongs to its owner. */
export const actorName = (actor: TeamChatActor): string => (actor.kind === "orcling" ? actor.name : (actor.person?.name ?? "Former member"));

/** Messages run together while the same speaker says them; an Orcling is its own speaker, apart from its owner. */
export const actorKey = (actor: TeamChatActor): string => (actor.kind === "orcling" ? `orcling:${actor.owner.id}:${actor.localOrclingId}` : `person:${actor.person?.id ?? ""}`);
