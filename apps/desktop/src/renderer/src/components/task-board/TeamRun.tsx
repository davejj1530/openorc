import type { OnlineTask } from "@openorc/protocol";
import { useTaskOnlineScope } from "../../lib/task-online-query";
import { Button, Dialog, StatusDot } from "../ui";

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** Where a team task's column agent stands, in a few words: waiting for whose computer, running on it, that computer without the project, or held. */
function runWords(run: NonNullable<OnlineTask["run"]>, me: string | null): string {
  const who = run.runner && run.runner.userId !== me ? firstName(run.runner.name) : null;
  if (run.state === "held") return "Sent here too often. Move it to start it again";
  if (run.state === "no_folder") return who ? `${who} needs to add the project` : "Add this project to run its agent";
  if (run.state === "running") return who ? `Running on ${who}'s computer` : "Running on your computer";
  return who ? `Waiting for ${who}'s computer` : "Waiting for your computer";
}

/** A team task's column agent on its card, while one is asked of someone for the column the card is in. */
export function RunFact({ task }: { task: OnlineTask }) {
  const { availability } = useTaskOnlineScope();
  const run = task.run;
  if (!run || run.columnId !== task.columnId) return null;
  const stuck = run.state === "held" || run.state === "no_folder";
  return (
    <span className="task-board-card-fact">
      <StatusDot tone={stuck ? "attention" : "muted"} />
      <span className="truncate">{runWords(run, availability?.accountId ?? null)}</span>
    </span>
  );
}

/**
 * Asked as a team task with nobody assigned lands in a column with an agent: nobody's computer can run it, so the person
 * who moved it can run it on theirs, which makes the task theirs, or only move it.
 */
export function RunHereAsk({ onRun, onMove, onCancel }: { onRun: () => void; onMove: () => void; onCancel: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title="Run its agent on your computer?"
      width={420}
    >
      <p className="mb-4 text-base text-ink-2">This task has no assignee, so no computer can run its column’s agent. Running it on yours assigns the task to you.</p>
      <div className="flex justify-end gap-2">
        <Button onClick={onMove}>Just move it</Button>
        <Button variant="primary" onClick={onRun}>
          Run it on my computer
        </Button>
      </div>
    </Dialog>
  );
}
