import { Button } from "../components/ui";
import { seatChangeWords, useSeatAdministration } from "../lib/seat-administration";

export function SeatOperations() {
  const admin = useSeatAdministration();
  if (!admin?.permitted) return null;
  return (
    <>
      {admin.state.status?.assignments
        ?.filter((work) => work.operation?.state !== "failed")
        .map((work) => {
          const change = admin.change(work);
          const words = seatChangeWords(change);
          return (
            <div className="seats-inline-state" key={work.request.body.id}>
              <Button className="seats-operation-status" variant="ghost" aria-label="View seat change" onClick={() => admin.open({ action: change ?? "move", seatId: work.request.seatId, work })}>
                {work.operation?.state === "complete" ? words.done : words.running}.
              </Button>
            </div>
          );
        })}
    </>
  );
}
