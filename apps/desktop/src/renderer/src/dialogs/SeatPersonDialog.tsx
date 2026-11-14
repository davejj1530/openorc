import type { OrganizationPerson, OrganizationPersonSeat, OrganizationSeat } from "@openorc/protocol";
import { accountDay, cloudTime, formatUsageTime } from "@openorc/client";
import { useId, useState } from "react";
import { AccountFace } from "../components/AccountFace";
import { Check } from "../components/icons";
import { Button, Dialog } from "../components/ui";
import { cn } from "../lib/cn";
import { seatHolderName } from "./SeatAssignmentFacts";
import "../views/organization-seats.css";
import "./seat-assignment.css";

export type SeatPerson = Pick<OrganizationPerson, "memberId" | "name" | "email" | "image"> & { seat?: OrganizationPersonSeat | null };
export interface SeatPersonDialogProps {
  seat: OrganizationSeat;
  people: readonly SeatPerson[];
  onReview(memberId: string): void;
  onClose(): void;
}
export function SeatPersonDialog({ seat, people, onReview, onClose }: SeatPersonDialogProps) {
  const [chosen, setChosen] = useState<string | null>(null);
  const group = useId();
  const selected = people.find((person) => person.memberId === chosen && !unavailable(person));
  const holder = seatHolderName(seat.assignment);
  return (
    <Dialog
      open
      title={holder ? `Move ${holder}’s seat` : "Give seat"}
      width={440}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <form
        className="seats-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (selected) onReview(selected.memberId);
        }}
      >
        <dl className="seats-facts">
          <div>
            <dt>Hours left</dt>
            <dd>{seat.included ? cloudTime(seat.included.leftSeconds) : "Not available"}</dd>
          </div>
          <div>
            <dt>Hours renew</dt>
            <dd data-tip={seat.period ? formatUsageTime(seat.period.endsAt) : undefined}>{seat.period ? accountDay(seat.period.endsAt) : "Not available"}</dd>
          </div>
        </dl>
        <div className="seat-person-options" role="radiogroup" aria-label="Person">
          {people.map((person) => (
            <PersonOption key={person.memberId} person={person} group={group} selected={selected?.memberId === person.memberId} onSelect={() => setChosen(person.memberId)} />
          ))}
        </div>
        <div className="organization-actions">
          <Button onClick={onClose}>Cancel</Button>
          <span data-tip={!selected ? "Choose a person." : undefined} tabIndex={!selected ? 0 : undefined}>
            <Button type="submit" variant="primary" disabled={!selected}>
              Review seat
            </Button>
          </span>
        </div>
      </form>
    </Dialog>
  );
}

function PersonOption({ person, group, selected, onSelect }: { person: SeatPerson; group: string; selected: boolean; onSelect(): void }) {
  const reason = unavailable(person);
  const name = person.name || person.email;
  return (
    <label className={cn("seat-person-option", selected && "seat-person-selected", reason && "seat-person-unavailable")} data-tip={reason ?? undefined} tabIndex={reason ? 0 : undefined}>
      <input className="sr-only" type="radio" name={group} value={person.memberId} aria-label={name} checked={selected} disabled={Boolean(reason)} onChange={onSelect} />
      <AccountFace name={name} image={person.image} />
      <span className="seat-person-name">{name}</span>
      {person.seat?.id ? <span className="seat-person-held">Has a seat</span> : null}
      {selected ? <Check size={14} aria-hidden="true" /> : null}
    </label>
  );
}

function unavailable(person: SeatPerson): string | null {
  if (!person.seat) return "The seat details aren’t available. Read People again.";
  return person.seat.id === null ? null : "That person already has a seat in this organization.";
}
