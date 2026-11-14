import type { OrganizationSeat, OrganizationSeatPreview } from "@openorc/protocol";
import { accountDay, cloudTime, formatUsageTime, seatDeadline } from "@openorc/client";
import { AccountFace } from "../components/AccountFace";

export function SeatAssignmentFacts({ preview, completed }: { preview: OrganizationSeatPreview; completed: boolean }) {
  const assignment = preview.seat.assignment;
  const from = assignment.kind === "member" || assignment.kind === "person" ? assignment.person : null;
  return (
    <>
      <dl className="seats-facts">
        {from ? (
          <div>
            <dt>From</dt>
            <dd>
              <PreviewPerson person={from} />
            </dd>
          </div>
        ) : null}
        {preview.to ? (
          <div>
            <dt>To</dt>
            <dd>
              <PreviewPerson person={preview.to.person} />
            </dd>
          </div>
        ) : null}
        {!completed ? <AllowanceFacts preview={preview} /> : null}
      </dl>
      {!completed ? <PreviousHolder preview={preview} /> : null}
      {!completed && preview.runningTurnsToStop > 0 ? (
        <p className="seat-assignment-note">
          {preview.runningTurnsToStop} running {preview.runningTurnsToStop === 1 ? "turn will" : "turns will"} stop. Their work is saved.
        </p>
      ) : null}
    </>
  );
}

function AllowanceFacts({ preview }: { preview: OrganizationSeatPreview }) {
  const { included, period } = preview.seat;
  return (
    <>
      <div>
        <dt>Hours left</dt>
        <dd data-tip={`As of ${formatUsageTime(preview.asOf)}`}>{included ? cloudTime(included.leftSeconds) : "Not available"}</dd>
      </div>
      <div>
        <dt>Hours renew</dt>
        <dd data-tip={period ? formatUsageTime(period.endsAt) : undefined}>{period ? accountDay(period.endsAt) : "Not available"}</dd>
      </div>
    </>
  );
}

function PreviousHolder({ preview }: { preview: OrganizationSeatPreview }) {
  const name = seatHolderName(preview.seat.assignment);
  if (!name) return null;
  if (preview.previousHolderAfter === "frozen") return <p>They are already frozen.</p>;
  if (preview.previousHolderAfter === "pro") return <p>{name} keeps Pro.</p>;
  if (preview.previousHolderAfter === "grace" && preview.graceUntil !== null) {
    return (
      <p>
        {name} has until <span data-tip={formatUsageTime(preview.graceUntil)}>{seatDeadline(preview.graceUntil)}</span> to get Pro.
      </p>
    );
  }
  return null;
}

function PreviewPerson({ person }: { person: NonNullable<OrganizationSeatPreview["to"]>["person"] }) {
  return (
    <span className="seat-preview-person">
      <AccountFace name={person.name} image={person.image} />
      <span>{person.name || person.email}</span>
    </span>
  );
}

export function seatHolderName(assignment: OrganizationSeat["assignment"]): string | null {
  if (assignment.kind !== "member" && assignment.kind !== "person") return null;
  return assignment.person.name.trim().split(/\s+/)[0] || assignment.person.email;
}
