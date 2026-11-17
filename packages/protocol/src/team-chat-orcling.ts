import { z } from "zod";
import { OrclingLook } from "./orclings.js";
import { SpaceId } from "./spaces.js";

const id = z.string().min(1).max(200);
const person = z.object({ id, name: z.string(), image: z.string().nullable() });

/** A person's call of their own Orcling from a chat message, and how its one answer is going. */
export const TeamOrclingCall = z.object({
  id,
  owner: person,
  localOrclingId: id,
  name: z.string(),
  look: OrclingLook,
  state: z.enum(["pending", "running", "answered", "failed", "uncertain"]),
});
export type TeamOrclingCall = z.infer<typeof TeamOrclingCall>;

/** The call as its owner reads it: why it failed, and whether it can be tried again. */
export const TeamOwnerOrclingCall = z.object({ call: TeamOrclingCall, reason: z.string().nullable(), canRetry: z.boolean() });
export type TeamOwnerOrclingCall = z.infer<typeof TeamOwnerOrclingCall>;

/** Who said a message: a person, or an Orcling its owner called, on their behalf. */
export const TeamChatActor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), person: person.nullable() }),
  z.object({ kind: z.literal("orcling"), owner: person, localOrclingId: id, name: z.string(), look: OrclingLook, callId: id }),
]);
export type TeamChatActor = z.infer<typeof TeamChatActor>;

/** The sender's own Orcling a draft calls, as picked: its local id, name and look. */
export const TeamChatOrclingPick = z.object({ localOrclingId: id, name: z.string(), look: OrclingLook });
export type TeamChatOrclingPick = z.infer<typeof TeamChatOrclingPick>;

const scope = { spaceId: SpaceId };
export const teamChatOrclingRpcParams = {
  "teamChat.orclingCall": z.object({ ...scope, callId: id }).strict(),
  "teamChat.retryOrclingCall": z.object({ ...scope, conversationId: id, callId: id }).strict(),
};
export interface TeamChatOrclingRpcResults {
  "teamChat.orclingCall": TeamOwnerOrclingCall;
  "teamChat.retryOrclingCall": TeamOwnerOrclingCall;
}

/** The person who said a message, or null for an Orcling's answer, which no person said. */
export const actorPerson = (actor: TeamChatActor): z.infer<typeof person> | null => (actor.kind === "person" ? actor.person : null);
