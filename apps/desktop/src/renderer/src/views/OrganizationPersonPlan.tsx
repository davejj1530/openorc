import type { OrganizationPerson } from "@openorc/protocol";
import { useSyncExternalStore } from "react";
import { organizationContentGate } from "../lib/organization-content-gate";
import { SEAT_ASSIGNMENT_ENABLED, useSeatAdministration } from "../lib/seat-administration";
import { PersonSeatFact } from "./PersonSeatFact";

export function OrganizationPersonPlan({ person, spaceId }: { person: OrganizationPerson; spaceId: string }) {
  const snapshot = useSyncExternalStore(organizationContentGate.subscribe, organizationContentGate.getSnapshot);
  const admin = useSeatAdministration();
  if (!SEAT_ASSIGNMENT_ENABLED) return person.plan === "pro" ? "Pro" : "Free";
  const space = snapshot.spaces.find((space) => space.id === spaceId);
  const own = snapshot.ready && space?.kind === "organization" && space.memberId === person.memberId;
  return <PersonSeatFact person={person} viewer={{ userId: own ? person.userId : "", role: admin?.permitted ? "admin" : "member" }} />;
}
