import type { OrganizationSeat } from "@openorc/protocol";
import { accountDay, cloudTime, formatUsageTime } from "@openorc/client";
import { AccountFace } from "../components/AccountFace";
import { cn } from "../lib/cn";

/** Only an admin view supplies this inventory. Null balances remain unknown. */
export function SeatInventory({ seats }: { seats: readonly OrganizationSeat[] }) {
  return (
    <div className="seats-inventory" role="table" aria-label="Seats">
      <div className="seats-grid seats-head" role="row">
        <span role="columnheader">Assigned to</span>
        <span role="columnheader">Hours left</span>
        <span role="columnheader">Hours renew</span>
        <span role="columnheader" aria-label="Actions" />
      </div>
      <div role="rowgroup">
        {seats.map((seat) => (
          <div key={seat.id} className={cn("seats-grid seats-inventory-row", seat.retiresAt !== null && "seats-retiring")} role="row">
            <div className="seats-holder" role="cell">
              <SeatHolder assignment={seat.assignment} retiresAt={seat.retiresAt} />
            </div>
            <span className="seats-number" role="cell">
              {seat.included ? cloudTime(seat.included.leftSeconds) : "Not available"}
            </span>
            <span role="cell" data-tip={seat.period ? formatUsageTime(seat.period.endsAt) : undefined}>
              {seat.period ? accountDay(seat.period.endsAt) : "Not available"}
            </span>
            <div role="cell" />
          </div>
        ))}
      </div>
    </div>
  );
}

function SeatHolder({ assignment, retiresAt }: Pick<OrganizationSeat, "assignment" | "retiresAt">) {
  if (assignment.kind === "member" || assignment.kind === "person")
    return (
      <>
        <AccountFace name={assignment.person.name} image={assignment.person.image} />
        <div>
          <span>{assignment.person.name}</span>
          {assignment.kind === "person" ? <span className="organization-small">Not in this organization.</span> : null}
          {assignment.paysForPro ? <span className="organization-small">Also pays for Pro themselves</span> : null}
        </div>
      </>
    );
  return (
    <div>
      <span>{assignment.kind === "available" ? "Available" : assignment.email}</span>
      {assignment.kind === "invitation" ? <span className="organization-small">Invitation</span> : null}
      {retiresAt !== null ? (
        <span className="organization-small" data-tip={formatUsageTime(retiresAt)}>
          Ends {accountDay(retiresAt)}
        </span>
      ) : null}
    </div>
  );
}
