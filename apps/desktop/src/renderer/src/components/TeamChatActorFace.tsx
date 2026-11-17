import type { TeamChatActor } from "@openorc/protocol";
import { AccountFace } from "./AccountFace";
import { OrclingAvatar } from "./OrclingAvatar";

/** A speaker's face: a person's picture or initials, or the Orcling as it looked when called. */
export function TeamChatActorFace({ actor, size, className }: { actor: TeamChatActor; size: number; className?: string }) {
  if (actor.kind === "orcling") return <OrclingAvatar orcling={actor} size={size} {...(className && { className })} />;
  return <AccountFace name={actor.person?.name ?? "Former member"} image={actor.person?.image ?? null} {...(className && { className })} />;
}
