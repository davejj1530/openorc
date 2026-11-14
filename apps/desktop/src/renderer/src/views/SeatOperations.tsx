import { Button } from "../components/ui";
import { useSeatAdministration } from "../lib/seat-administration";

export function SeatOperations() {
  const admin = useSeatAdministration();
  if (!admin?.permitted) return null;
  return (
    <>
      {admin.state.status?.assignments
        ?.filter((work) => work.operation?.state !== "failed")
        .map((work) => (
          <div className="seats-inline-state" key={work.request.body.id}>
            <Button className="seats-operation-status" variant="ghost" aria-label="View seat change" onClick={() => admin.open({ action: "move", seatId: work.request.seatId, work })}>
              {work.operation?.state === "complete" ? "Seat moved." : "Moving the seat."}
            </Button>
          </div>
        ))}
    </>
  );
}
