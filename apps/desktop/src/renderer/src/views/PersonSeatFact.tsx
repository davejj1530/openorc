import type { OrganizationPerson, OrganizationPersonSeat, OrganizationRole } from "@openorc/protocol";
import type { ReactNode } from "react";
import { Tooltip } from "../components/ui";
import "./person-seat-fact.css";

export interface PersonSeatFactProps {
  person: Pick<OrganizationPerson, "userId" | "plan"> & { seat?: OrganizationPersonSeat | null };
  viewer: { userId: string; role: OrganizationRole };
}

export function PersonSeatFact({ person, viewer }: PersonSeatFactProps) {
  const seat = viewer.role === "admin" || viewer.userId === person.userId ? person.seat : null;
  const plan = person.plan === "pro" ? "Pro" : "Free";
  const payer = payerWords(seat);
  if (!seat?.id) return <PlanDetail detail={payer}>{plan}</PlanDetail>;
  return (
    <>
      <span className="person-seat-wide">
        <PlanDetail detail={payer}>
          {plan}
          <span className="person-seat-label">Seat</span>
        </PlanDetail>
      </span>
      <span className="person-seat-compact">
        <PlanDetail detail={payer ? `Seat. ${payer}` : "Seat"}>{plan}</PlanDetail>
      </span>
    </>
  );
}

function payerWords(seat: OrganizationPersonSeat | null | undefined): string | null {
  if (!seat?.paysForPro) return null;
  return seat.id ? "Also pays for Pro themselves." : "Pays for Pro themselves.";
}

function PlanDetail({ detail, children }: { detail: string | null; children: ReactNode }) {
  return detail ? (
    <Tooltip label={detail} render={<span tabIndex={0} className="person-seat-detail" />}>
      {children}
    </Tooltip>
  ) : (
    <span className="person-seat-detail">{children}</span>
  );
}
