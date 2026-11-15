import { freeSeatsWords, type InvitationSeatChoice } from "../lib/invitation-seats";
import { Button, Switch } from "./ui";

const NO_SEATS = "There are no available seats. Buy another seat or take one back first.";

/** One Seat switch per address, then how many of the free seats the draft takes. No seat is picked by hand here. */
export function InvitationSeatChoices({
  addresses,
  choice,
  disabled,
  onSwitch,
  onBuySeats,
}: {
  addresses: readonly string[];
  choice: InvitationSeatChoice;
  disabled: boolean;
  onSwitch(email: string, on: boolean): void;
  onBuySeats(): void;
}) {
  const used = Object.keys(choice.seats).length;
  const full = used >= choice.free;
  return (
    <div className="organization-invite-seats">
      {addresses.map((email) => {
        const on = choice.seats[email] !== undefined;
        const held = !on && full;
        return (
          <label key={email}>
            <span>{email}</span>
            <span className="organization-invite-seat" data-tip={held ? NO_SEATS : undefined}>
              Seat
              <Switch size="sm" aria-label={`Seat for ${email}`} checked={on} disabled={disabled || held} onChange={(event) => onSwitch(email, event.target.checked)} />
            </span>
          </label>
        );
      })}
      <div className="organization-invite-capacity">
        <span>{freeSeatsWords(used, choice.free)}</span>
        {full ? (
          <Button size="sm" disabled={disabled} onClick={onBuySeats}>
            Buy seats
          </Button>
        ) : null}
      </div>
    </div>
  );
}
