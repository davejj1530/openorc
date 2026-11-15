import type { OrganizationRole } from "@openorc/protocol";
import { organizationContentGate } from "./organization-content-gate";

export interface InvitationDraft {
  text: string;
  role: OrganizationRole;
  /** Each address's Seat switch as the admin left it. */
  switched: Record<string, boolean>;
}

/** Held in this window only, for the account that wrote it, while the admin goes to buy seats. */
const drafts = new Map<string, InvitationDraft>();
const key = (spaceId: string) => `${organizationContentGate.getSnapshot().identity}:${spaceId}`;

export function keepInvitationDraft(spaceId: string, draft: InvitationDraft): void {
  drafts.set(key(spaceId), draft);
}

/** The draft is handed back once: an invitation form that is cancelled leaves nothing behind. */
export function takeInvitationDraft(spaceId: string): InvitationDraft | null {
  const draft = drafts.get(key(spaceId)) ?? null;
  drafts.delete(key(spaceId));
  return draft;
}
