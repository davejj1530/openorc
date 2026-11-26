import type { OnlineTask } from "@openorc/protocol";
import { useTaskOnlineScope } from "../../lib/task-online-query";
import { Button, Dialog, StatusDot } from "../ui";

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

type Run = NonNullable<OnlineTask["run"]>;

/** Where a team task's column agent stands on OpenOrc Cloud: starting, running, or why it didn't start. */
function cloudWords(run: Run): string {
  if (run.state === "failed") return run.reason ?? "Its agent didn't start on OpenOrc Cloud";
  return run.state === "running" ? "Running on OpenOrc Cloud" : "Starting on OpenOrc Cloud";
}

/**
 * Where a team task's column agent stands, in a few words: waiting for whose computer, running on it, that computer
 * without the project, held, or failed; on OpenOrc Cloud, starting or running there.
 */
function runWords(run: Run, me: string | null): string {
  const who = run.runner && run.runner.userId !== me ? firstName(run.runner.name) : null;
  if (run.state === "held") return "Sent here too often. Move it to start it again";
  if (run.where === "cloud") return cloudWords(run);
  if (run.state === "failed") return run.reason ?? "Its agent didn't start";
  if (run.state === "no_folder") return who ? `${who} needs to add the project` : "Add this project to run its agent";
  if (run.state === "running") return who ? `Running on ${who}'s computer` : "Running on your computer";
  return who ? `Waiting for ${who}'s computer` : "Waiting for your computer";
}

/** A run its card speaks of: of the column the card is in, and not finished. */
const shownRun = (task: OnlineTask): Run | null => (task.run && task.run.columnId === task.columnId && task.run.state !== "finished" ? task.run : null);

/** The computer a team task's work runs on, in a thread there: the person's own, or a teammate's by first name. */
export function computerName(computer: NonNullable<OnlineTask["computer"]>, me: string | null): string {
  return computer.userId === me ? "your computer" : `${firstName(computer.name)}'s computer`;
}

/**
 * Where a team task's work stands on its card: its column's agent, while one is asked of someone for the column the
 * card is in, else the computer its thread works on.
 */
export function RunFact({ task }: { task: OnlineTask }) {
  const { availability } = useTaskOnlineScope();
  const me = availability?.accountId ?? null;
  const run = shownRun(task);
  if (!run && !task.computer) return null;
  const stuck = run?.state === "held" || run?.state === "no_folder" || run?.state === "failed";
  return (
    <span className="task-board-card-fact">
      <StatusDot tone={stuck ? "attention" : "muted"} />
      <span className="truncate">{run ? runWords(run, me) : `On ${computerName(task.computer!, me)}`}</span>
    </span>
  );
}

/**
 * Asked as a team task with nobody assigned lands in a column with an agent: nobody can run it, so the person who moved
 * it can run it on their computer, or on OpenOrc Cloud as them for a column whose agent runs there, which makes the task
 * theirs; or only move it.
 */
export function RunHereAsk({ cloud, onRun, onMove, onCancel }: { cloud: boolean; onRun: () => void; onMove: () => void; onCancel: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={cloud ? "Run its agent on OpenOrc Cloud as you?" : "Run its agent on your computer?"}
      width={420}
    >
      <p className="mb-4 text-base text-ink-2">
        {cloud
          ? "This task has no assignee, so nobody’s sign-in can run its column’s agent. Running it as you uses your OpenOrc Cloud sign-in and hours, and assigns the task to you."
          : "This task has no assignee, so no computer can run its column’s agent. Running it on yours assigns the task to you."}
      </p>
      <div className="flex justify-end gap-2">
        <Button onClick={onMove}>Just move it</Button>
        <Button variant="primary" onClick={onRun}>
          {cloud ? "Run it as me" : "Run it on my computer"}
        </Button>
      </div>
    </Dialog>
  );
}
