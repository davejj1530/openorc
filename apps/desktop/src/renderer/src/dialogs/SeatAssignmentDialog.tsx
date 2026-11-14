import { useSyncExternalStore } from "react";
import type { SeatAssignment, SeatAssignmentState } from "../lib/seat-assignment";
import { seatChange, seatChangeWords } from "../lib/seat-administration";
import { Button, Dialog } from "../components/ui";
import { SeatAssignmentFacts, seatHolderName } from "./SeatAssignmentFacts";
import "../views/organization-seats.css";
import "./seat-assignment.css";

export interface SeatAssignmentDialogProps {
  action: "give" | "move" | "takeBack";
  view: SeatAssignment;
  onClose(): void;
  recipientPaysForPro?: boolean;
}

const actionWords = { give: "Give seat", move: "Move seat", takeBack: "Take back seat" };

export function SeatAssignmentDialog({ action, view, onClose, recipientPaysForPro = false }: SeatAssignmentDialogProps) {
  const state = useSyncExternalStore(view.subscribe, view.getSnapshot);
  const pending = state.state === "pending" || state.state === "submitting";
  const words = seatChangeWords(seatChange(state.preview, action));
  return (
    <Dialog
      open
      title={assignmentTitle(action, state, words)}
      width={480}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className="seats-dialog">
        <AssignmentDetails state={state} done={words.done} recipientPaysForPro={recipientPaysForPro} />
        {pending ? <p role="status">{words.running}.</p> : null}
        {state.error ? (
          <p className="seats-error" role="alert">
            {state.error}
          </p>
        ) : null}
        <div className="organization-actions">
          <Button onClick={onClose}>{state.work ? "Close" : "Cancel"}</Button>
          <AssignmentAction action={action} state={state} view={view} />
        </div>
      </div>
    </Dialog>
  );
}

function AssignmentDetails({ state, done, recipientPaysForPro }: { state: SeatAssignmentState; done: string; recipientPaysForPro: boolean }) {
  return (
    <>
      {state.state === "complete" ? <p role="status">{done}.</p> : null}
      {state.reviewing ? <p role="status">Loading…</p> : null}
      {state.preview ? <SeatAssignmentFacts preview={state.preview} completed={state.state === "complete"} /> : null}
      {state.state !== "complete" && state.preview?.to && recipientPaysForPro ? (
        <p className="seat-assignment-note">{firstName(state.preview.to.person.name)} pays for Pro themselves. Their own included hours stay in use.</p>
      ) : null}
    </>
  );
}

function AssignmentAction({ action, state, view }: Pick<SeatAssignmentDialogProps, "action" | "view"> & { state: SeatAssignmentState }) {
  if (state.state === "preview")
    return (
      <Button variant="primary" onClick={() => void view.confirm()}>
        {actionWords[action]}
      </Button>
    );
  if (state.state === "draft" || state.state === "failed") {
    return (
      <Button variant="primary" disabled={state.reviewing || state.target === null} onClick={() => void view.review()}>
        {state.error ? "Review again" : "Review seat"}
      </Button>
    );
  }
  if ((state.state === "pending" || state.state === "complete") && state.error)
    return (
      <Button variant="primary" onClick={() => void view.retry()}>
        Try again
      </Button>
    );
  return null;
}

function assignmentTitle(action: SeatAssignmentDialogProps["action"], state: SeatAssignmentState, words: { running: string; done: string }): string {
  if (state.state === "pending" || state.state === "submitting") return words.running;
  if (state.state === "complete") return words.done;
  if (action === "give" && state.preview?.to) return `Give ${firstName(state.preview.to.person.name)} a seat`;
  const name = state.preview && seatHolderName(state.preview.seat.assignment);
  if (!name || action === "give") return actionWords[action];
  return `${action === "move" ? "Move" : "Take back"} ${name}’s seat`;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || "this person";
