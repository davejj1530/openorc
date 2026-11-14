import { createContext, useContext } from "react";
import type { OrganizationIdentity, OrganizationSpace, SpacesStatus } from "@openorc/protocol";
import type { ReceivedInvitationActions } from "./received-invitations";

export type OrganizationDialog = { kind: "create" } | { kind: "invite"; organization: OrganizationIdentity } | { kind: "projects"; spaceId: string };
export interface OrganizationActions {
  status: SpacesStatus | undefined;
  signedIn: boolean;
  person: string;
  organization: OrganizationSpace | null;
  error: string | null;
  invitations: ReceivedInvitationActions;
  dialog: OrganizationDialog | null;
  pendingLogo: string | null;
  close(): void;
  create(): void;
  invite(): void;
  addProjects(): void;
  people(section?: "invitations"): void;
  select(id: string): void;
  refresh(): Promise<void>;
  logoSaved(): void;
}
export const OrganizationContext = createContext<OrganizationActions | null>(null);
export const useOrganization = () => useContext(OrganizationContext);
