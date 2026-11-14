import type { OrganizationBillingOffers, OrganizationBillingPage } from "@openorc/protocol";
import { PRO_PERIODS } from "@openorc/protocol";
import { cloudTime, periodLabel } from "@openorc/client";
import { useEffect, useState } from "react";
import { Button, Dialog, Input, Segmented } from "../components/ui";
import "../views/organization-seats.css";

export interface BuySeatsDialogProps {
  spaceId: string;
  opening: boolean;
  submitted?: boolean;
  error?: string | null;
  offers(spaceId: string, seats: number): Promise<OrganizationBillingOffers>;
  onBuy(target: Extract<OrganizationBillingPage, { page: "checkout" }>): void;
  onClose(): void;
}

export function BuySeatsDialog(props: BuySeatsDialogProps) {
  return (
    <Dialog
      open
      title="Buy seats"
      width={440}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <BuySeatsForm key={props.spaceId} {...props} />
    </Dialog>
  );
}

function BuySeatsForm({ spaceId, opening, submitted = false, offers, onBuy, onClose, error }: BuySeatsDialogProps) {
  const [count, setCount] = useState("1");
  const [plan, setPlan] = useState<"monthly" | "yearly">("monthly");
  const seats = Number(count);
  const valid = count.trim() !== "" && Number.isInteger(seats) && seats >= 1 && seats <= 100;
  const quote = useSeatOffers(spaceId, valid ? seats : null, offers);
  const selected = quote.data?.offers.find((offer) => offer.plan === plan && offer.seats === seats);
  const trouble = !valid ? "Choose a number of seats from 1 to 100." : (quote.error ?? error);
  const locked = opening || submitted;
  return (
    <form
      className="seats-dialog"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && selected && !opening) onBuy({ page: "checkout", plan, seats });
      }}
    >
      <label className="organization-label">
        Seats
        <Input variant="sheet" type="number" min={1} max={100} step={1} value={count} disabled={locked} onChange={(event) => setCount(event.target.value)} />
      </label>
      <Segmented
        label="Pay"
        size="sm"
        value={plan}
        onChange={setPlan}
        options={PRO_PERIODS.map((value) => ({ value, label: periodLabel(value, quote.data?.offers.find((offer) => offer.plan === value)?.price ?? null), disabled: locked }))}
      />
      <SeatQuoteFacts data={quote.data} selected={selected} failed={Boolean(quote.error)} />
      {trouble ? (
        <p className="seats-error" role="alert">
          {trouble}
        </p>
      ) : null}
      <div className="organization-actions">
        <Button onClick={onClose}>{locked ? "Close" : "Cancel"}</Button>
        {quote.error ? <Button onClick={quote.retry}>Try again</Button> : null}
        <Button type="submit" variant="primary" disabled={!valid || !selected || opening}>
          Buy seats
        </Button>
      </div>
    </form>
  );
}

function SeatQuoteFacts({ data, selected, failed }: { data: OrganizationBillingOffers | null; selected: OrganizationBillingOffers["offers"][number] | undefined; failed: boolean }) {
  const unavailable = failed ? "Not available" : "Loading…";
  return (
    <dl className="seats-facts">
      <div>
        <dt>Included hours</dt>
        <dd>{data ? `${cloudTime(data.monthlySeconds)} per seat, each month` : unavailable}</dd>
      </div>
      {!selected || selected.price === null ? (
        <div>
          <dt>Price</dt>
          <dd>{data ? "Price unavailable" : unavailable}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function useSeatOffers(spaceId: string, seats: number | null, offers: BuySeatsDialogProps["offers"]) {
  const [attempt, setAttempt] = useState(0);
  const [read, setRead] = useState<{ spaceId: string; seats: number | null; data: OrganizationBillingOffers | null; error: string | null } | null>(null);
  useEffect(() => {
    if (seats === null) return;
    let current = true;
    setRead({ spaceId, seats, data: null, error: null });
    void offers(spaceId, seats).then(
      (data) => {
        if (current) setRead({ spaceId, seats, data, error: null });
      },
      (error: unknown) => {
        if (current) setRead({ spaceId, seats, data: null, error: error instanceof Error ? error.message : "The seat prices could not be read." });
      },
    );
    return () => {
      current = false;
    };
  }, [spaceId, seats, offers, attempt]);
  const current = read?.spaceId === spaceId && read.seats === seats;
  return { data: current ? read.data : null, error: current ? read.error : null, retry: () => setAttempt((value) => value + 1) };
}
